// 합성 프로젝트의 실제 작업 프로세스 종료와 결과 및 증거 판정을 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
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
  | 'worker-crash' | 'secret-output' | 'two-commands';

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
if (mode === 'duplicate') process.stdout.write(event(2, 'case-result', result) + '\n');
if (mode === 'tampered-evidence') process.stdout.write(event(2, 'evidence-created', evidence) + '\n');
if (mode === 'source-change') writeFileSync(join(process.cwd(), 'source.txt'), '변경');
process.exit(mode === 'exit-fail' || mode === 'ndjson-fail' ? 9 : 0);
`;

async function scenario(mode: Scenario) {
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
  const source = {
    project: { schemaVersion: 1, id: projectId, name: '합성 프로젝트', repositoryIdentity: 'synthetic:executor',
      commands: [{ id: 'run', title: '합성 명령', runtime: 'node', entry: 'tests/run.mjs',
        args: [mode], timeoutMs: 5000, env: { NODE_ENV: 'test' }, writes: [],
        resultFormat: ndjson ? 'ndjson' : 'exit-code' },
      ...(second ? [{ id: 'other-run', title: '두 번째 명령', runtime: 'node', entry: 'tests/run.mjs',
        args: [mode, 'check-2'], timeoutMs: 5000, env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'ndjson' }] : [])],
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds: second ? ['check-1', 'check-2'] : ['check-1'] }] },
    requirements: [{ id: 'req-1', title: '요구사항', description: '합성 검사 결과' }],
    checks: [{ id: 'check-1', title: '검사', requirementId: 'req-1', commandId: 'run',
      required: true, kind: 'logic', expected: '성공', codePaths: [] },
    ...(second ? [{ id: 'check-2', title: '두 번째 검사', requirementId: 'req-1', commandId: 'other-run',
      required: true, kind: 'logic', expected: '성공', codePaths: [] }] : [])],
  };
  await writeFile(join(sourceRoot, 'checkmate', '프로젝트.json'), JSON.stringify(source.project));
  await writeFile(join(sourceRoot, 'checkmate', '요구사항.json'), JSON.stringify(source.requirements));
  await writeFile(join(sourceRoot, 'checkmate', '검사항목.json'), JSON.stringify(source.checks));
  await writeFile(join(sourceRoot, 'tests', 'run.mjs'), script);
  await writeFile(join(sourceRoot, 'source.txt'), '원본');
  const snapshot = await readProjectSource(sourceRoot);
  if (mode === 'prechange') await writeFile(join(sourceRoot, 'source.txt'), '사전 변경');
  const plan: PlanRegistration = {
    project: { id: projectId, name: '합성 프로젝트', repositoryIdentity: 'synthetic:executor' },
    workspace: { id: randomUUID(), realPath: snapshot.realPath,
      pathFingerprint: createHash('sha256').update(snapshot.realPath).digest('hex') },
    catalog: { id: randomUUID(), contentHash: snapshot.contentHash, source: snapshot.source },
    plan: { id: randomUUID(), fingerprint: createHash('sha256').update(mode).digest('hex'),
      sourceHash: snapshot.sourceHash, profile: 'quick',
      plannedChecks: second ? ['check-1', 'check-2'] : ['check-1'],
      requiredChecks: second ? ['check-1', 'check-2'] : ['check-1'] },
    createdAt: new Date().toISOString(),
  };
  const db = connectStore(fixture.dbPath);
  try {
    const store = new SQLiteRunStore(db);
    store.registerPlan(plan);
    const evidence = new EvidenceStore(db, runsRoot);
    const events = new EventStore(db);
    const service = new RunService(store, createProjectExecutor({ runsRoot, evidenceStore: evidence, eventStore: events }));
    if (mode === 'worker-crash') workerControl.killNext = true;
    const started = service.start({ projectId, planId: plan.plan.id, requestId: randomUUID() });
    const cancellation = mode === 'cancel' ? new Promise<void>((resolve, reject) => {
      setTimeout(() => { void service.cancel(started.runId).then(() => resolve(), reject); }, 300);
    }) : null;
    const result = await service.wait(started.runId);
    if (cancellation) await cancellation;
    return { result, evidence: evidence.list(started.runId), events: events.list(started.runId) };
  } finally {
    db.close();
    await fixture.cleanup();
  }
}

describe('고정 계획 검사실행기', () => {
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
    const { result, events } = await scenario('ndjson-fail');
    expect(result).toMatchObject({ verdict: 'failed', workerExitCode: 0,
      cases: [{ testId: 'check-1', status: 'failed' }] });
    expect(events).toHaveLength(1);
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
    const { result, events } = await scenario('ndjson-pass');
    expect(result.verdict).toBe('passed');
    expect(events.map((event) => event.sequence)).toEqual([1]);
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
