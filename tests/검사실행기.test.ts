// 합성 프로젝트의 실제 작업 프로세스 종료와 결과 및 증거 판정을 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentServer } from '../packages/engine/src/연결/에이아이서버.js';
import { describe, expect, it, vi } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
import { resultSummary } from '../packages/engine/src/서비스/조회결과.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const workerControl = vi.hoisted(() => ({ killNext: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, fork: (...args: Parameters<typeof original.fork>) => {
    const child = original.fork(...args);
    if (workerControl.killNext) {
      workerControl.killNext = false;
      child.once('spawn', () => { child.kill(); });
    }
    return child;
  } };
});

type Scenario = 'exit-pass' | 'exit-fail' | 'ndjson-pass' | 'ndjson-fail' | 'missing'
  | 'duplicate' | 'outside' | 'tampered-evidence' | 'source-change' | 'prechange' | 'cancel'
  | 'worker-crash' | 'secret-output' | 'two-commands' | 'ndjson-timeout' | 'ndjson-output-limit' | 'ndjson-many-fail';

const script = String.raw`
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
if (mode === 'cancel') { setInterval(() => {}, 1000); await new Promise(() => {}); }
const event = (sequence, type, payload) => JSON.stringify({
  protocolVersion: 1, runId: process.env.CHECKMATE_RUN_ID, sequence, type,
  time: new Date().toISOString(), payload,
});
const id = randomUUID();
const content = Buffer.from('합성 증거');
if (mode === 'tampered-evidence') writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR, '증거.txt'), content);
const evidence = { id, relativePath: '증거.txt', sha256: createHash('sha256').update('다른 내용').digest('hex'),
  byteLength: content.length, mime: 'text/plain', sensitivity: 'restricted' };
const result = { testId: process.argv[3] ?? 'check-1', status: 'passed', requirementId: 'req-1', expected: '성공',
  observed: mode === 'secret-output' ? 'Authorization: Bearer sample-secret' : '성공',
  evidenceIds: mode === 'tampered-evidence' ? [id] : [], severity: 'info', location: null };
if (mode.startsWith('ndjson') || mode === 'duplicate' || mode === 'outside'
  || mode === 'tampered-evidence' || mode === 'secret-output' || mode === 'two-commands') {
  process.stdout.write(event(1, 'case-result', mode === 'outside' ? { ...result, testId: 'other' } : result) + '\n');
}
if (mode === 'ndjson-many-fail') for (let index = 2; index <= 13; index += 1) {
  process.stdout.write(event(index, 'case-result', { ...result, testId: 'check-' + index,
    status: index <= 10 ? 'passed' : index === 11 ? 'failed' : 'not-run',
    ...(index === 11 ? { failureOrigin: 'command', observed: '체크박스 선택 상태가 바뀌지 않았습니다.', severity: 'error' } : {}),
  }) + '\n');
}
if (mode === 'duplicate') process.stdout.write(event(2, 'case-result', result) + '\n');
if (mode === 'tampered-evidence') process.stdout.write(event(2, 'evidence-created', evidence) + '\n');
if (mode === 'source-change') writeFileSync(join(process.cwd(), 'source.txt'), '변경');
if (mode === 'ndjson-timeout') { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === 'ndjson-output-limit') { process.stdout.write('X'.repeat(300000)); await new Promise(() => {}); }
process.exit(mode === 'exit-fail' || mode === 'ndjson-fail' || mode === 'ndjson-many-fail' ? 9 : 0);
`;

async function scenario(mode: Scenario, runsRootAlias?: (runsRoot: string, directory: string) => Promise<{
  path: string; cleanup?: () => Promise<void> }>, repairBudget = false) {
  const fixture = await createStoreFixture();
  const sourceRoot = join(fixture.directory, '합성프로젝트');
  const runsRoot = join(fixture.directory, '실행');
  await mkdir(join(sourceRoot, 'checkmate'), { recursive: true });
  await mkdir(join(sourceRoot, 'tests'));
  await mkdir(runsRoot);
  const projectId = randomUUID();
  const ndjson = !mode.startsWith('exit') && mode !== 'source-change' && mode !== 'prechange'
    && mode !== 'cancel' && mode !== 'worker-crash';
  const second = mode === 'two-commands';
  const checkIds = mode === 'ndjson-many-fail' ? Array.from({ length: 13 }, (_, index) => `check-${index + 1}`)
    : second ? ['check-1', 'check-2'] : ['check-1'];
  const source = {
    project: { schemaVersion: 1, id: projectId, name: '합성 프로젝트', repositoryIdentity: 'synthetic:executor',
      commands: [{ id: 'run', title: '합성 명령', runtime: 'node', entry: 'tests/run.mjs',
        args: [mode], timeoutMs: mode === 'ndjson-timeout' ? 1200 : 5000, env: { NODE_ENV: 'test' }, writes: [],
        resultFormat: ndjson ? 'ndjson' : 'exit-code' },
      ...(second ? [{ id: 'other-run', title: '두 번째 명령', runtime: 'node', entry: 'tests/run.mjs',
        args: [mode, 'check-2'], timeoutMs: 5000, env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'ndjson' }] : [])],
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds }] },
    requirements: [{ id: 'req-1', title: '요구사항', description: '합성 검사 결과' }],
    checks: [{ id: 'check-1', title: '검사', requirementId: 'req-1', commandId: 'run',
      required: true, kind: 'logic', expected: '성공', codePaths: [] as string[] },
    ...(second ? [{ id: 'check-2', title: '두 번째 검사', requirementId: 'req-1', commandId: 'other-run',
      required: true, kind: 'logic', expected: '성공', codePaths: [] as string[] }] : [])],
  };
  if (mode === 'ndjson-many-fail') source.checks = checkIds.map(id => ({ ...source.checks[0]!, id,
    codePaths: (repairBudget ? Array.from({ length: 40 }, (_, index) => `src/${'가'.repeat(12)}${index}.ts`) : []) }));
  await writeFile(join(sourceRoot, 'checkmate', '프로젝트.json'), JSON.stringify(source.project));
  await writeFile(join(sourceRoot, 'checkmate', '요구사항.json'), JSON.stringify(source.requirements));
  await writeFile(join(sourceRoot, 'checkmate', '검사항목.json'), JSON.stringify(source.checks));
  await writeFile(join(sourceRoot, 'tests', 'run.mjs'), repairBudget ? script.replace('체크박스 선택 상태가 바뀌지 않았습니다.', '가'.repeat(1000)) : script);
  await writeFile(join(sourceRoot, 'source.txt'), '원본');
  const snapshot = await readProjectSource(sourceRoot);
  if (mode === 'prechange') await writeFile(join(sourceRoot, 'source.txt'), '사전 변경');
  const plan: PlanRegistration = {
    project: { id: projectId, name: '합성 프로젝트', repositoryIdentity: 'synthetic:executor' },
    workspace: { id: randomUUID(), realPath: snapshot.realPath,
      pathFingerprint: createHash('sha256').update(snapshot.realPath).digest('hex') },
    catalog: { id: randomUUID(), contentHash: snapshot.contentHash, source: JSON.parse(JSON.stringify(snapshot.source)) },
    plan: { id: randomUUID(), fingerprint: createHash('sha256').update(mode).digest('hex'),
      sourceHash: snapshot.sourceHash, profile: 'quick',
      plannedChecks: checkIds,
      requiredChecks: checkIds },
    createdAt: new Date().toISOString(),
  };
  const db = connectStore(fixture.dbPath);
  let cleanupAlias: (() => Promise<void>) | undefined;
  try {
    const alias = await runsRootAlias?.(runsRoot, fixture.directory);
    cleanupAlias = alias?.cleanup;
    const store = new SQLiteRunStore(db);
    store.registerPlan(plan);
    const evidence = new EvidenceStore(db, runsRoot);
    const events = new EventStore(db);
    const service = new RunService(store, createProjectExecutor({ runsRoot: alias?.path ?? runsRoot,
      evidenceStore: evidence, eventStore: events }));
    if (mode === 'worker-crash') workerControl.killNext = true;
    const started = service.start({ projectId, planId: plan.plan.id, requestId: randomUUID() });
    const cancellation = mode === 'cancel' ? new Promise<void>((resolve, reject) => {
      setTimeout(() => { void service.cancel(started.runId).then(() => resolve(), reject); }, 300);
    }) : null;
    const result = await service.wait(started.runId);
    if (cancellation) await cancellation;
    const command = result.state === 'finished'
      && ['exit-pass', 'ndjson-pass', 'ndjson-fail', 'ndjson-timeout', 'ndjson-output-limit'].includes(mode)
      ? JSON.parse(await readFile(join(runsRoot, started.runId, '명령-1.json'), 'utf8')) as { status: string; exitCode: number | null }
      : null;
    const repair = mode === 'ndjson-many-fail' ? await new ProductService(db, evidence, async () => result).handle({
      apiVersion: 1, requestId: randomUUID(), method: 'result',
      input: { runId: started.runId, section: 'repair-bundle' },
    }, 'agent') : null;
    const repairPages: Array<{ items: Array<{ testId: string; observed: string; truncated: boolean }>; nextCursor: string | null; total: number }> = [];
    if (repairBudget) {
      const product = new ProductService(db, evidence, async () => result);
      const server = createAgentServer(request => product.handle(request, 'agent'));
      const client = new Client({ name: 'repair-budget-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        for (const limit of [1, 5]) {
          let cursor: string | undefined;
          const ids: string[] = [];
          do {
            const response = await client.callTool({ name: 'get_run_result', arguments: {
              runId: started.runId, section: 'repair-bundle', limit, ...(cursor ? { cursor } : {}),
            } });
            expect(response.isError).toBe(false);
            expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(8192);
            const content = response.content as Array<{ type: string; text: string }>;
            const parsed = JSON.parse(content[0]!.text) as { ok: boolean; data: typeof repairPages[number] };
            expect(parsed.ok).toBe(true);
            repairPages.push(parsed.data);
            ids.push(...parsed.data.items.map(item => item.testId));
            cursor = parsed.data.nextCursor ?? undefined;
            expect(repairPages.length).toBeLessThanOrEqual(26);
          } while (cursor);
          expect(ids[0]).toBe('check-11');
          expect(ids).toHaveLength(13);
          expect(new Set(ids)).toEqual(new Set(checkIds));
        }
      } finally { await client.close(); await server.close(); }
    }
    return { result, repair, repairPages, evidence: evidence.list(started.runId), events: events.list(started.runId), command };
  } finally {
    db.close();
    await cleanupAlias?.();
    await fixture.cleanup();
  }
}

describe('고정 계획 검사실행기', () => {
  it('긴 한글 진단과 코드 경로가 있어도 실제 MCP의 모든 수정 페이지를 빠짐없이 조회한다', async () => {
    const { repairPages } = await scenario('ndjson-many-fail', undefined, true);
    expect(repairPages[0]!.items[0]).toMatchObject({ testId: 'check-11', truncated: true, observed: '가'.repeat(384) });
  });

  it('명령 영향 실패 열 개 뒤의 직접 실패를 요약에서 먼저 보여주고 어댑터의 출처 주장을 덮어쓴다', async () => {
    const { result, repair } = await scenario('ndjson-many-fail');
    expect(result).toMatchObject({ verdict: 'failed', workerExitCode: 0, finalized: true });
    expect(result.cases.slice(0, 10)).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed', failureOrigin: 'command' })]));
    expect(result.cases[10]).toMatchObject({ testId: 'check-11', status: 'failed', failureOrigin: 'check' });
    const summary = resultSummary(result, 'verified');
    expect(summary.counts).toEqual({ failed: 11, 'not-run': 2 });
    expect(summary.failures[0]).toMatchObject({ testId: 'check-11', failureOrigin: 'check', observed: '체크박스 선택 상태가 바뀌지 않았습니다.' });
    expect(summary.reusablePassed).toBe(false);
    expect(repair?.ok).toBe(true);
    if (!repair?.ok) throw new Error('수정 묶음 조회 실패');
    expect((repair.data as { items: unknown[] }).items[0]).toMatchObject({ testId: 'check-11', failureOrigin: 'check' });
  });

  it.runIf(process.platform === 'win32')('실제 8.3 자료 경로에서 명령 실행과 증거 및 정리를 확인한다.', async (context) => {
    const { result, evidence, command } = await scenario('exit-pass', async (runsRoot) => {
      const encoded = Buffer.from(runsRoot, 'utf8').toString('base64');
      const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder result, uint length); }'; $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $result=New-Object Text.StringBuilder 32768; if ([ShortPath]::GetShortPathName($path,$result,[uint32]$result.Capacity) -eq 0) { throw 'short-path-failed' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result.ToString()))`;
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
      const shortRoot = Buffer.from(output.trim(), 'base64').toString('utf8');
      if (!/(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/u.test(shortRoot)) {
        context.skip('이 파일시스템은 시험 자료 경로의 8.3 별칭을 제공하지 않아 8.3 회귀는 미검증입니다.');
      }
      expect((await realpath(shortRoot)).toLowerCase()).toBe((await realpath(runsRoot)).toLowerCase());
      console.info('실제 GetShortPathName 8.3 별칭으로 실행기 회귀를 검증합니다.');
      return { path: shortRoot };
    });
    expect(result).toMatchObject({ state: 'finished', verdict: 'passed', workerExitCode: 0,
      environmentVerified: true, evidenceVerified: true, cleanupVerified: true });
    expect(result.cases).toMatchObject([{ testId: 'check-1', status: 'passed' }]);
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(evidence).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('대소문자 별칭을 실제 경로로 정규화하여 실행한다.', async () => {
    const { result, evidence } = await scenario('exit-pass', async (runsRoot) => {
      const alias = runsRoot.toUpperCase();
      expect(alias).not.toBe(runsRoot);
      return { path: alias };
    });
    expect(result).toMatchObject({ state: 'finished', verdict: 'passed', workerExitCode: 0,
      environmentVerified: true, evidenceVerified: true, cleanupVerified: true });
    expect(evidence).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('실행 폴더의 상위 junction을 거절한다.', async () => {
    const { result, evidence } = await scenario('exit-pass', async (_runsRoot, directory) => {
      const link = join(directory, '상위연결');
      await symlink(directory, link, 'junction');
      return { path: join(link, '실행'), cleanup: () => unlink(link) };
    });
    expect(result).toMatchObject({ state: 'unverifiable', verdict: 'unknown', workerExitCode: null,
      evidenceVerified: false, cleanupVerified: false });
    expect(evidence).toHaveLength(0);
  });

  it('실제 작업 종료와 명령 결과 증거를 확인한 경우에만 통과한다.', async () => {
    const { result, evidence } = await scenario('exit-pass');
    expect(result).toMatchObject({ verdict: 'passed', workerExitCode: 0, environmentVerified: true,
      evidenceVerified: true, cleanupVerified: true });
    expect(result.cases).toMatchObject([{ testId: 'check-1', status: 'passed' }]);
    expect(evidence).toHaveLength(1);
  });

  it('명령의 비영 종료는 worker 정상 종료와 구분하여 실패로 남긴다.', async () => {
    const { result } = await scenario('exit-fail');
    expect(result).toMatchObject({ verdict: 'failed', workerExitCode: 0,
      cases: [{ testId: 'check-1', status: 'failed' }] });
  });

  it('NDJSON 성공 이벤트가 있어도 실제 명령이 실패하면 실패한다.', async () => {
    const { result, events, command } = await scenario('ndjson-fail');
    expect(result).toMatchObject({ verdict: 'failed', workerExitCode: 0,
      cases: [{ testId: 'check-1', status: 'failed' }] });
    expect(events).toHaveLength(1);
    expect(command).toMatchObject({ status: 'exited', exitCode: 9 });
  });

  it.each(['ndjson-timeout', 'ndjson-output-limit'] as const)('%s 뒤에 남은 성공 이벤트를 통과로 확정하지 않는다.', async (mode) => {
    const { result, evidence, command } = await scenario(mode);
    expect(result.verdict).not.toBe('passed');
    expect(result.cases[0]?.status).toBe(mode === 'ndjson-timeout' ? 'timed-out' : 'unknown');
    expect(result.workerExitCode).toBe(0);
    expect(evidence).toHaveLength(1);
    expect(command).toMatchObject({ status: mode === 'ndjson-timeout' ? 'timed-out' : 'output-limit', exitCode: null });
  });

  it('NDJSON 결과 누락을 통과로 만들지 않는다.', async () => {
    const { result } = await scenario('missing');
    expect(result.verdict).not.toBe('passed');
    expect(result.cases).toMatchObject([{ status: 'not-run' }]);
  });

  it.each(['duplicate', 'outside'] as const)('%s 이벤트를 프로토콜 오류로 막는다.', async (mode) => {
    const { result } = await scenario(mode);
    expect(result.verdict).not.toBe('passed');
    expect(result.environmentVerified).toBe(false);
  });

  it('변조된 증거와 실행 중 바뀐 출처를 통과로 만들지 않는다.', async () => {
    const damaged = await scenario('tampered-evidence');
    expect(damaged.result.verdict).not.toBe('passed');
    expect(damaged.result.evidenceVerified).toBe(false);
    const changed = await scenario('source-change');
    expect(changed.result.verdict).not.toBe('passed');
    expect(changed.result.sourceAfter).not.toBe(changed.result.sourceBefore);
  });

  it('시작 전 바뀐 출처를 차단하고 취소 후 실제 종료를 기다린다.', async () => {
    const stale = await scenario('prechange');
    expect(stale.result.state).toBe('blocked');
    expect(stale.result.verdict).not.toBe('passed');
    const cancelled = await scenario('cancel');
    expect(cancelled.result.state).toBe('cancelled');
    expect(cancelled.result.verdict).toBe('incomplete');
  });

  it('정상 NDJSON 검사 결과와 연속 저장 순서를 확인한다.', async () => {
    const { result, events, command } = await scenario('ndjson-pass');
    expect(result.verdict).toBe('passed');
    expect(events.map((event) => event.sequence)).toEqual([1]);
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('실제 worker 프로세스가 비정상 종료되면 통과를 거부한다.', async () => {
    const { result } = await scenario('worker-crash');
    expect(result.state).toBe('unverifiable');
    expect(result.verdict).toBe('unknown');
  });

  it('결과와 이벤트에 민감한 출력 문자열을 그대로 저장하지 않는다.', async () => {
    const { result, events } = await scenario('secret-output');
    expect(JSON.stringify({ result, events })).not.toContain('sample-secret');
    expect(result.cases[0]?.observed).toBe('[가림]');
  });

  it('명령마다 시작하는 NDJSON 순서를 실행 전체의 연속 순서로 다시 저장한다.', async () => {
    const { result, evidence, events } = await scenario('two-commands');
    expect(result.verdict).toBe('passed');
    expect(result.cases.map((item) => item.testId)).toEqual(['check-1', 'check-2']);
    expect(evidence).toHaveLength(2);
    expect(events.map((item) => item.sequence)).toEqual([1, 2]);
  });
});
