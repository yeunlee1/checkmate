// 승인된 검사 계획을 독립 작업 프로세스에 넘기고 실제 종료와 증거를 대조한다.
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { resultInputSchema, type RunResult } from '@checkmate/contracts';
import { projectSourceSchema, type CheckDefinition, type ProjectSource } from '@checkmate/contracts/project';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import type { RunExecutor } from './실행서비스.js';
import { readProjectSource, fingerprintSource } from '../프로젝트/원본읽기.js';
import { assertIncludedEntry, readCheckedFile } from '../프로젝트/소스지문.js';
import { readAdapterEvents } from '../이벤트읽기.js';
import { rejectLinks } from '../연결/개인경로.js';
import type { EvidenceStore } from '../저장/증거저장.js';
import type { EventStore } from '../저장/이벤트저장.js';
import type { AdapterEvent } from '@checkmate/contracts/events';
import type { CommandObservation, FixedCommand, WorkerConfig } from '../작업/검사작업.js';

const evidenceSchema = z.strictObject({ id: z.uuid(), relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), byteLength: z.number().int().nonnegative(),
  mime: z.enum(['text/plain', 'application/json', 'text/html', 'image/png', 'image/jpeg', 'application/zip']),
  sensitivity: z.enum(['public', 'restricted']) });
const outcomeSchema = z.strictObject({
  status: z.enum(['exited', 'spawn-error', 'timed-out', 'cancelled', 'output-limit', 'unverifiable']),
  exitCode: z.number().int().nullable(), terminationConfirmed: z.boolean(),
  outputBytes: z.number().int().nonnegative(), cleanupVerified: z.boolean(),
});
const observationSchema = z.strictObject({ kind: z.literal('result'), commandId: z.string(),
  outcome: outcomeSchema, stdout: z.string().max(256 * 1024), evidence: evidenceSchema });
const secretPattern = /authorization|cookie|bearer|token|password|secret|api[ _-]?key/iu;
const uuid = z.uuid();
type Options = { runsRoot: string; evidenceStore: EvidenceStore; eventStore: EventStore };
type ObservedWorker = { exitCode: number | null; observations: CommandObservation[]; protocolValid: boolean };

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return secretPattern.test(value) ? '[가림]' : value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, secretPattern.test(key) ? '[가림]' : scrub(item)]));
  return value;
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

async function checkedRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('실행 폴더 경로가 올바르지 않습니다.');
  const normalized = resolve(path);
  await rejectLinks(normalized);
  const info = await lstat(normalized);
  const actual = await realpath(normalized);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('실행 폴더의 실제 경로가 다릅니다.');
  return actual;
}

async function makeRunRoot(runsRoot: string, runId: string, ownerToken: string): Promise<string> {
  if (!uuid.safeParse(runId).success) throw new Error('실행 ID가 올바르지 않습니다.');
  const root = await checkedRoot(runsRoot);
  const runRoot = join(root, runId);
  if (!inside(root, runRoot)) throw new Error('실행 경로가 벗어났습니다.');
  await mkdir(runRoot, { mode: 0o700 });
  const info = await lstat(runRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(runRoot) !== runRoot)
    throw new Error('실행 폴더를 확인할 수 없습니다.');
  await writeFile(join(runRoot, '소유.json'), JSON.stringify({ runId,
    ownerTokenHash: createHash('sha256').update(ownerToken).digest('hex') }), { flag: 'wx', mode: 0o600 });
  return runRoot;
}

async function fixedCommands(sourceRoot: string, source: ProjectSource, plan: PlanRegistration): Promise<{
  commands: FixedCommand[]; checks: Map<string, CheckDefinition> }> {
  const profile = source.project.profiles.find((item) => item.id === plan.plan.profile);
  if (!profile || !isDeepStrictEqual(profile.checkIds, plan.plan.plannedChecks)) throw new Error('선택한 프로필이 다릅니다.');
  const checks = new Map(source.checks.map((item) => [item.id, item]));
  const selected = profile.checkIds.map((id) => checks.get(id)!);
  if (!isDeepStrictEqual(selected.filter((item) => item.required).map((item) => item.id), plan.plan.requiredChecks))
    throw new Error('필수 검사 목록이 다릅니다.');
  const commands = new Map(source.project.commands.map((item) => [item.id, item]));
  const chosen: FixedCommand[] = [];
  for (const check of selected) {
    const item = commands.get(check.commandId)!;
    if (chosen.some((value) => value.id === item.id)) continue;
    const parts = item.entry.split('/');
    assertIncludedEntry(parts);
    await readCheckedFile(sourceRoot, parts);
    const entry = join(sourceRoot, ...parts);
    if (!inside(sourceRoot, entry) || await realpath(entry) !== entry) throw new Error('명령 진입점이 프로젝트 밖입니다.');
    chosen.push({ id: item.id, entry, args: item.args, timeoutMs: item.timeoutMs,
      env: item.env, resultFormat: item.resultFormat,
      checkIds: selected.filter((value) => value.commandId === item.id).map((value) => value.id) });
  }
  return { commands: chosen, checks };
}

function runWorker(config: WorkerConfig, signal: AbortSignal): Promise<ObservedWorker> {
  return new Promise((resolve) => {
    const entry = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'dist', '작업', '검사작업.js');
    const observations: CommandObservation[] = [];
    let protocolValid = true;
    let exited: number | null = null;
    let sent = false;
    let child;
    try {
      child = fork(entry, [], { cwd: config.sourceRoot, execPath: process.execPath, execArgv: [],
        env: Object.fromEntries(['SystemRoot', 'WINDIR'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    } catch { resolve({ exitCode: null, observations, protocolValid: false }); return; }
    const childProcess = child;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const abort = () => {
      if (stopped) return;
      stopped = true;
      if (childProcess.connected) childProcess.send({ kind: 'cancel' }, () => {});
      killTimer = setTimeout(() => { protocolValid = false; childProcess.kill(); }, 15_000);
    };
    signal.addEventListener('abort', abort, { once: true });
    const maximum = Math.min(86_400_000, config.commands.reduce((sum, item) => sum + item.timeoutMs + 30_000, 30_000));
    const watchdog = setTimeout(abort, maximum);
    childProcess.on('message', (value: unknown) => {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 512 * 1024) { protocolValid = false; return; }
      const parsed = observationSchema.safeParse(value);
      const expected = config.commands[observations.length];
      if (!parsed.success || !expected || parsed.data.commandId !== expected.id) { protocolValid = false; return; }
      observations.push(parsed.data);
    });
    childProcess.once('error', () => { protocolValid = false; });
    childProcess.once('exit', (code) => { exited = code; });
    childProcess.once('close', () => {
      signal.removeEventListener('abort', abort);
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      resolve({ exitCode: exited, observations, protocolValid });
    });
    if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 1024 * 1024) {
      protocolValid = false;
      childProcess.kill();
    } else {
      try {
        childProcess.send(config, (error) => { if (error) protocolValid = false; });
        sent = true;
        if (signal.aborted) abort();
      } catch { protocolValid = false; childProcess.kill(); }
    }
    if (!sent) protocolValid = false;
  });
}

function caseFor(check: CheckDefinition, status: RunResult['cases'][number]['status'], observed: string,
  evidenceIds: string[]): RunResult['cases'][number] {
  return { testId: check.id, status, requirementId: check.requirementId,
    expected: scrub(check.expected) as string, observed, evidenceIds,
    severity: status === 'passed' ? 'info' : 'error', location: null };
}

export function createProjectExecutor(options: Options): RunExecutor {
  return async (plan, initial, signal) => {
    if (!resultInputSchema.safeParse(initial).success || initial.state !== 'running'
      || plan.project.id !== initial.projectId
      || plan.plan.fingerprint !== initial.planHash || plan.plan.sourceHash !== initial.sourceBefore)
      throw new Error('실행 계획과 초기 결과가 다릅니다.');
    const candidate: RunResult = { ...initial, state: 'unverifiable', verdict: null, cases: [], reasons: [],
      sourceAfter: null, workerExitCode: null, environmentVerified: false,
      evidenceVerified: false, cleanupVerified: false, finalized: false };
    const parsed = projectSourceSchema.safeParse(plan.catalog.source);
    if (!parsed.success || parsed.data.project.id !== plan.project.id) return { ...candidate, state: 'blocked' };
    let snapshot;
    try { snapshot = await readProjectSource(plan.workspace.realPath); }
    catch { return candidate; }
    if (snapshot.contentHash !== plan.catalog.contentHash || snapshot.sourceHash !== plan.plan.sourceHash
      || !isDeepStrictEqual(snapshot.source, parsed.data)) return { ...candidate, state: 'blocked', sourceAfter: snapshot.sourceHash };
    let fixed;
    try { fixed = await fixedCommands(snapshot.realPath, parsed.data, plan); }
    catch { return { ...candidate, state: 'blocked' }; }
    const ownerToken = randomBytes(32).toString('hex');
    let evidenceRoot;
    try { evidenceRoot = await makeRunRoot(options.runsRoot, initial.runId, ownerToken); }
    catch { return candidate; }
    const config: WorkerConfig = { runId: initial.runId, sourceRoot: snapshot.realPath,
      evidenceRoot, ownerToken, commands: fixed.commands };
    const observed = await runWorker(config, signal);
    candidate.workerExitCode = observed.exitCode;
    candidate.state = observed.exitCode === null ? 'unverifiable' : 'finished';
    let protocolValid = observed.protocolValid;
    let evidenceValid = true;
    let sequence = 0;
    let resourceSeen = false;
    const cases = new Map<string, RunResult['cases'][number]>();
    const registered = new Set<string>();
    for (const [index, command] of fixed.commands.entries()) {
      const message = observed.observations[index];
      if (!message || message.commandId !== command.id) break;
      try {
        await options.evidenceStore.register(initial.runId, message.evidence);
        const inspected = await options.evidenceStore.inspect(initial.runId, message.evidence.id);
        if (inspected.integrity !== 'verified') evidenceValid = false;
        registered.add(message.evidence.id);
      } catch { evidenceValid = false; }
      if (command.resultFormat === 'ndjson') {
        try {
          async function* bytes() { yield Buffer.from(message!.stdout, 'utf8'); }
          for await (const event of readAdapterEvents(bytes(), initial.runId)) {
            if (event.type === 'case-result') {
              const parsedCase = resultInputSchema.shape.cases.element.safeParse(scrub(event.payload));
              const check = fixed.checks.get(parsedCase.success ? parsedCase.data.testId : '');
              if (!parsedCase.success || !check || !command.checkIds.includes(check.id)
                || parsedCase.data.requirementId !== check.requirementId || cases.has(check.id))
                throw new Error('계획 밖 검사 결과입니다.');
              cases.set(check.id, { ...parsedCase.data,
                evidenceIds: [...new Set([...parsedCase.data.evidenceIds, message.evidence.id])] });
            } else if (event.type === 'evidence-created') {
              const parsedEvidence = evidenceSchema.safeParse(event.payload);
              if (!parsedEvidence.success || registered.has(parsedEvidence.data.id)) throw new Error('증거 형식 또는 ID가 잘못되었습니다.');
              await options.evidenceStore.register(initial.runId, parsedEvidence.data);
              const inspected = await options.evidenceStore.inspect(initial.runId, parsedEvidence.data.id);
              if (inspected.integrity !== 'verified') evidenceValid = false;
              registered.add(parsedEvidence.data.id);
            } else if (event.type.startsWith('resource-')) resourceSeen = true;
            const safeEvent: AdapterEvent = { ...event, sequence: ++sequence,
              payload: scrub(event.payload) as Record<string, unknown> };
            options.eventStore.append(safeEvent);
          }
        } catch { protocolValid = false; }
      }
      for (const id of command.checkIds) {
        const check = fixed.checks.get(id)!;
        if (command.resultFormat === 'exit-code' || !cases.has(id)) {
          const status = message.outcome.status === 'exited'
            ? message.outcome.exitCode === 0 ? command.resultFormat === 'exit-code' ? 'passed' : 'not-run' : 'failed'
            : message.outcome.status === 'timed-out' ? 'timed-out'
              : message.outcome.status === 'cancelled' ? 'interrupted' : 'unknown';
          cases.set(id, caseFor(check, status, `명령 종료 상태 ${message.outcome.status}, 코드 ${message.outcome.exitCode ?? '없음'}`,
            [message.evidence.id]));
        } else if ((message.outcome.status !== 'exited' || message.outcome.exitCode !== 0)
          && cases.get(id)!.status === 'passed') {
          const status = message.outcome.status === 'exited' ? 'failed'
            : message.outcome.status === 'timed-out' ? 'timed-out'
              : message.outcome.status === 'cancelled' ? 'interrupted' : 'unknown';
          cases.set(id, { ...cases.get(id)!, status,
            observed: `명령 종료 상태 ${message.outcome.status}, 코드 ${message.outcome.exitCode ?? '없음'}` });
        }
      }
    }
    for (const item of cases.values()) {
      for (const id of item.evidenceIds) {
        if (!registered.has(id)) evidenceValid = false;
        else {
          try { if ((await options.evidenceStore.inspect(initial.runId, id)).integrity !== 'verified') evidenceValid = false; }
          catch { evidenceValid = false; }
        }
      }
    }
    candidate.cases = initial.plannedChecks.flatMap((id) => cases.has(id) ? [cases.get(id)!] : []);
    candidate.environmentVerified = process.versions.node.startsWith('24.') && protocolValid && !resourceSeen;
    candidate.evidenceVerified = evidenceValid && protocolValid && observed.observations.length > 0;
    candidate.cleanupVerified = !resourceSeen && observed.observations.length === fixed.commands.length
      && observed.observations.every((item) => item.outcome.terminationConfirmed && item.outcome.cleanupVerified);
    try { candidate.sourceAfter = await fingerprintSource(snapshot.realPath); }
    catch { candidate.sourceAfter = null; }
    if (signal.aborted || observed.exitCode === null || !candidate.cleanupVerified) candidate.state = 'unverifiable';
    return candidate;
  };
}
