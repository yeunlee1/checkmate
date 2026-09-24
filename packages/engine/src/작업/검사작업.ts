// 고정된 Node 검사 명령을 별도 작업 프로세스에서 실행하고 종료 근거를 남긴다.
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOwnedCommand } from './소유실행.js';
import { hideSecretsInNdjson } from './비밀가림.js';
import type { EvidenceInput } from '../저장/증거저장.js';
import type { ProcessOutcome, RegisteredCommand } from '../작업실행.js';

export type FixedCommand = {
  id: string; entry: string; args: string[]; timeoutMs: number; env: Record<string, string>;
  resultFormat: 'exit-code' | 'ndjson'; checkIds: string[];
  resources?: 'postgres-test'[];
};
export type WorkerConfig = {
  runId: string; sourceRoot: string; evidenceRoot: string; ownerToken: string;
  commands: FixedCommand[];
  resourceEnvironment?: Record<string, string>; resourceSecrets?: string[];
};
export type CommandObservation = {
  kind: 'result'; commandId: string; outcome: ProcessOutcome & { cleanupVerified: boolean };
  stdout: string; evidence: EvidenceInput;
};

const controller = new AbortController();
process.once('disconnect', () => controller.abort());

function send(value: CommandObservation): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error('서비스 연결이 끊어졌습니다.')); return; }
    process.send(value, (error) => error ? reject(error) : resolve());
  });
}

async function run(config: WorkerConfig): Promise<void> {
  for (const [index, item] of config.commands.entries()) {
    if (controller.signal.aborted) break;
    const environment: Record<string, string> = { ...item.env,
      CHECKMATE_RUN_ID: config.runId, CHECKMATE_EVIDENCE_DIR: config.evidenceRoot,
      CHECKMATE_OWNER_TOKEN: config.ownerToken };
    if (item.resources?.includes('postgres-test')) Object.assign(environment, config.resourceEnvironment);
    for (const key of ['SystemRoot', 'WINDIR'] as const) {
      if (process.env[key]) environment[key] = process.env[key]!;
    }
    const command: RegisteredCommand = {
      executable: process.execPath, args: [item.entry, ...item.args], cwd: config.sourceRoot, env: environment,
    };
    const observed = await runOwnedCommand(command, {
      timeoutMs: item.timeoutMs, signal: controller.signal, maxOutputBytes: 256 * 1024,
    });
    const { stdout, stderr: _stderr, ...outcome } = observed;
    const record = Buffer.from(JSON.stringify({ commandId: item.id, status: outcome.status,
      exitCode: outcome.exitCode, terminationConfirmed: outcome.terminationConfirmed,
      cleanupVerified: outcome.cleanupVerified, outputBytes: outcome.outputBytes,
      resultFormat: item.resultFormat }), 'utf8');
    const relativePath = `명령-${index + 1}.json`;
    await writeFile(join(config.evidenceRoot, relativePath), record, { flag: 'wx' });
    const evidence: EvidenceInput = { id: randomUUID(), relativePath,
      sha256: createHash('sha256').update(record).digest('hex'), byteLength: record.length,
      mime: 'application/json', sensitivity: 'restricted' };
    await send({ kind: 'result', commandId: item.id, outcome,
      stdout: item.resultFormat === 'ndjson' ? hideSecretsInNdjson(stdout, config.resourceSecrets ?? []) : '', evidence });
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
