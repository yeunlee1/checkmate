// 고정된 Node 검사 명령을 별도 작업 프로세스에서 실행하고 종료 근거를 남긴다.
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { runOwnedCommand } from './소유실행.js';
import { hideCommandOutput, hideSecretsInNdjson } from './비밀가림.js';
import { scanRunFiles } from '../저장/프로젝트자료.js';
import type { EvidenceInput } from '../저장/증거저장.js';
import type { ProcessOutcome, RegisteredCommand } from '../작업실행.js';
import { selectDatabaseEnvironment, type DatabaseResourceKind, type ResourceProvider } from '@checkmate/contracts/resources';

export type FixedCommand = {
  id: string; entry: string; args: string[]; timeoutMs: number; env: Record<string, string>;
  resultFormat: 'exit-code' | 'ndjson'; checkIds: string[];
  resources?: DatabaseResourceKind[];
  resourceProvider?: ResourceProvider;
};
export type WorkerConfig = {
  runId: string; sourceRoot: string; evidenceRoot: string; ownerToken: string;
  commands: FixedCommand[];
  resourceEnvironment?: Record<string, string>; resourceSecrets?: string[];
};
export type CommandObservation = {
  kind: 'result'; commandId: string; outcome: ProcessOutcome & { cleanupVerified: boolean };
  stdout: string; evidence: EvidenceInput;
  artifacts: EvidenceInput[];
};
export type CommandStart = { kind: 'command-start'; commandId: string };

const controller = new AbortController();
process.once('disconnect', () => controller.abort());

function send(value: CommandObservation | CommandStart): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error('서비스 연결이 끊어졌습니다.')); return; }
    process.send(value, (error) => error ? reject(error) : resolve());
  });
}

async function run(config: WorkerConfig): Promise<void> {
  const artifactRoot = join(config.evidenceRoot, 'artifacts');
  const filesSeen = new Set<string>();
  const secrets = [...(config.resourceSecrets ?? []), config.ownerToken];
  for (const [index, item] of config.commands.entries()) {
    if (controller.signal.aborted) break;
    await send({ kind: 'command-start', commandId: item.id });
    if (controller.signal.aborted) break;
    const environment: Record<string, string> = { ...item.env,
      CHECKMATE_RUN_ID: config.runId, CHECKMATE_EVIDENCE_DIR: artifactRoot,
      CHECKMATE_OWNER_TOKEN: config.ownerToken };
    Object.assign(environment, selectDatabaseEnvironment(item.resources ?? [], config.resourceEnvironment ?? {}));
    for (const key of ['SystemRoot', 'WINDIR'] as const) {
      if (process.env[key]) environment[key] = process.env[key]!;
    }
    const command: RegisteredCommand = {
      executable: process.execPath, args: [item.entry, ...item.args], cwd: config.sourceRoot, env: environment,
    };
    const observed = await runOwnedCommand(command, {
      timeoutMs: item.timeoutMs, signal: controller.signal, maxOutputBytes: 256 * 1024,
    });
    const { stdout, stderr, ...outcome } = observed;
    const artifacts: EvidenceInput[] = [];
    let remainingLogBytes = 256 * 1024;
    for (const [kind, output] of [['stdout', stdout], ['stderr', stderr]] as const) {
      const hidden = hideCommandOutput(stripVTControlCharacters(output), secrets, outcome.status === 'output-limit');
      let bytes = Buffer.from(hidden, 'utf8');
      if (bytes.length > remainingLogBytes) {
        bytes = bytes.subarray(0, remainingLogBytes);
        for (let trim = 0; trim < 4; trim += 1) {
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); break; }
          catch { bytes = bytes.subarray(0, Math.max(0, bytes.length - 1)); }
        }
      }
      remainingLogBytes -= bytes.length;
      const relativePath = `logs/명령-${index + 1}-${kind}.log`;
      await writeFile(join(config.evidenceRoot, relativePath), bytes, { flag: 'wx', mode: 0o600 });
      artifacts.push({ id: randomUUID(), relativePath, sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length, mime: 'text/plain', sensitivity: 'restricted' });
    }
    const record = Buffer.from(JSON.stringify({ commandId: item.id, status: outcome.status,
      exitCode: outcome.exitCode, terminationConfirmed: outcome.terminationConfirmed,
      cleanupVerified: outcome.cleanupVerified, outputBytes: outcome.outputBytes,
      resultFormat: item.resultFormat }), 'utf8');
    const relativePath = `results/명령-${index + 1}.json`;
    await writeFile(join(config.evidenceRoot, relativePath), record, { flag: 'wx', mode: 0o600 });
    const evidence: EvidenceInput = { id: randomUUID(), relativePath,
      sha256: createHash('sha256').update(record).digest('hex'), byteLength: record.length,
      mime: 'application/json', sensitivity: 'restricted' };
    for (const file of scanRunFiles(artifactRoot, { maxFileBytes: 8 * 1024 * 1024, maxFiles: 128,
      maxDepth: 16, maxTotalBytes: 32 * 1024 * 1024 })) {
      if (filesSeen.has(file.path)) continue;
      filesSeen.add(file.path);
      const extension = file.path.split('.').at(-1)?.toLowerCase();
      const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension === 'json' ? 'application/json' : extension === 'html' ? 'text/html' : extension === 'zip' ? 'application/zip'
          : ['txt', 'log', 'md', 'csv'].includes(extension ?? '') ? 'text/plain' : 'application/octet-stream';
      artifacts.push({ id: randomUUID(), relativePath: `artifacts/${file.path}`, sha256: file.sha256, byteLength: file.byteLength, mime, sensitivity: 'restricted' });
    }
    await send({ kind: 'result', commandId: item.id, outcome,
      stdout: item.resultFormat === 'ndjson' ? hideSecretsInNdjson(stdout, secrets) : '', evidence, artifacts });
    if (outcome.status !== 'exited' || !outcome.cleanupVerified) break;
  }
}

process.once('message', (input: unknown) => {
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'kind' in message && message.kind === 'cancel') controller.abort();
  });
  void run(input as WorkerConfig).then(() => {
    process.exitCode = controller.signal.aborted ? 2 : 0;
    if (process.connected) process.disconnect();
  }).catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
});
