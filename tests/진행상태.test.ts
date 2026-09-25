// 실제 작업 프로세스의 명령 전환과 취소 및 잘못된 IPC가 진행 조회에 반영되는지 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const ipc = vi.hoisted(() => ({ wrongStart: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, fork: (...args: Parameters<typeof original.fork>) => {
    const child = original.fork(...args);
    if (ipc.wrongStart) {
      ipc.wrongStart = false;
      child.once('spawn', () => child.emit('message', { kind: 'command-start', commandId: '계획밖' }));
    }
    return child;
  } };
});

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); ipc.wrongStart = false; });

const commandScript = String.raw`
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const gate = process.env.CHECKMATE_GATE_DIR;
const number = process.argv[2];
writeFileSync(join(gate, number + '-started'), 'started');
while (!existsSync(join(gate, number + '-release'))) await delay(20);
process.stdout.write('Authorization: Bearer sample-secret\n');
`;

async function setup(secondTitle = '2번째 명령') {
  const files = await createStoreFixture();
  const root = join(files.directory, 'project');
  const runsRoot = join(files.directory, 'runs');
  const gate = join(files.directory, 'gate');
  await mkdir(join(root, 'checkmate'), { recursive: true });
  await mkdir(join(root, 'tests'));
  await mkdir(runsRoot);
  await mkdir(gate);
  const projectId = randomUUID();
  const source = {
    project: { schemaVersion: 1, id: projectId, name: '진행 시험', repositoryIdentity: 'synthetic:progress',
      commands: [1, 2].map((number) => ({ id: `command-${number}`,
        title: number === 2 ? secondTitle : '1번째 명령',
        runtime: 'node', entry: 'tests/run.mjs', args: [String(number)], timeoutMs: 10_000,
        env: { CHECKMATE_GATE_DIR: gate }, writes: [], resultFormat: 'exit-code' })),
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1', 'check-2'] }] },
    requirements: [{ id: 'requirement', title: '요구사항', description: '합성 시험' }],
    checks: [1, 2].map((number) => ({ id: `check-${number}`, title: `${number}번째 검사`,
      requirementId: 'requirement', commandId: `command-${number}`, required: true,
      kind: 'logic', expected: '종료 코드 0', codePaths: [] })),
  };
  await writeFile(join(root, 'checkmate', '프로젝트.json'), JSON.stringify(source.project));
  await writeFile(join(root, 'checkmate', '요구사항.json'), JSON.stringify(source.requirements));
  await writeFile(join(root, 'checkmate', '검사항목.json'), JSON.stringify(source.checks));
  await writeFile(join(root, 'tests', 'run.mjs'), commandScript);
  const snapshot = await readProjectSource(root);
  const plan: PlanRegistration = {
    project: { id: projectId, name: '진행 시험', repositoryIdentity: 'synthetic:progress' },
    workspace: { id: randomUUID(), realPath: snapshot.realPath,
      pathFingerprint: createHash('sha256').update(snapshot.realPath).digest('hex') },
    catalog: { id: randomUUID(), contentHash: snapshot.contentHash, source: JSON.parse(JSON.stringify(snapshot.source)) },
    plan: { id: randomUUID(), fingerprint: createHash('sha256').update('progress').digest('hex'),
      sourceHash: snapshot.sourceHash, profile: 'quick', plannedChecks: ['check-1', 'check-2'],
      requiredChecks: ['check-1', 'check-2'] },
    createdAt: new Date().toISOString(),
  };
  const db = connectStore(files.dbPath);
  closes.push(async () => { db.close(); await files.cleanup(); });
  const store = new SQLiteRunStore(db);
  store.registerPlan(plan);
  const evidenceStore = new EvidenceStore(db, runsRoot);
  const product = new ProductService(db, evidenceStore,
    createProjectExecutor({ runsRoot, evidenceStore, eventStore: new EventStore(db) }));
  const service = product.execution;
  const started = service.start({ projectId, planId: plan.plan.id, requestId: randomUUID() });
  return { service, product, store, plan, runId: started.runId, gate };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('진행 단계 대기 시간이 지났습니다.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('두 순차 명령의 실제 시작과 종료가 현재 명령 및 완료 수를 바꾼다', async () => {
  const { service, product, store, runId, gate } = await setup();
  await until(() => existsSync(join(gate, '1-started')));
  expect(service.progress(runId)).toMatchObject({ state: 'running', finalized: false, available: true,
    phase: 'running', currentCommand: { id: 'command-1', title: '1번째 명령' },
    completedCommands: 0, totalCommands: 2 });
  expect(store.getRun(runId)?.verdict).toBeNull();
  await writeFile(join(gate, '1-release'), 'go');
  await until(() => existsSync(join(gate, '2-started')));
  expect(service.progress(runId)).toMatchObject({ state: 'running', finalized: false, available: true,
    phase: 'running', currentCommand: { id: 'command-2', title: '2번째 명령' },
    completedCommands: 1, totalCommands: 2 });
  expect(store.getRun(runId)?.verdict).toBeNull();
  const response = await product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'progress',
    input: { runId } }, 'agent');
  expect(response).toMatchObject({ ok: true, data: { runId, finalized: false,
    currentCommand: { id: 'command-2', title: '2번째 명령' }, completedCommands: 1 } });
  const restarted = new RunService(store, async () => { throw new Error('외부 실행기는 호출하지 않습니다.'); });
  expect(restarted.progress(runId)).toMatchObject({ state: 'running', available: false,
    phase: 'unavailable', currentCommand: null });
  expect(JSON.stringify(service.progress(runId))).not.toMatch(/sample-secret|Bearer|Authorization/u);
  expect(JSON.stringify(service.progress(runId))).not.toContain(gate);
  expect(Buffer.byteLength(JSON.stringify(service.progress(runId)), 'utf8')).toBeLessThanOrEqual(8192);
  await writeFile(join(gate, '2-release'), 'go');
  const result = await service.wait(runId);
  expect(result).toMatchObject({ state: 'finished', finalized: true, verdict: 'passed' });
  expect(service.progress(runId)).toMatchObject({ finalized: true, available: false,
    phase: 'finished', currentCommand: null });
});

test('진행 중 취소는 즉시 진행 정보를 닫고 최종 결과를 취소로 남긴다', async () => {
  const { service, runId, gate } = await setup();
  await until(() => existsSync(join(gate, '1-started')));
  const cancellation = service.cancel(runId);
  expect(service.progress(runId)).toMatchObject({ available: false, phase: 'unavailable', currentCommand: null });
  expect(await cancellation).toMatchObject({ state: 'cancelled', finalized: true });
  expect(service.progress(runId).available).toBe(false);
});

test('선택 계획 제목에 경로와 민감 값이 있어도 진행 응답에는 넣지 않는다', async () => {
  const { service, runId, gate } = await setup('C:\\private\\Authorization: Bearer sample-secret');
  await writeFile(join(gate, '1-release'), 'go');
  await until(() => existsSync(join(gate, '2-started')));
  expect(service.progress(runId).currentCommand).toEqual({ id: 'command-2', title: '[가림]' });
  expect(JSON.stringify(service.progress(runId))).not.toMatch(/private|sample-secret|Authorization|Bearer/u);
  await writeFile(join(gate, '2-release'), 'go');
  await service.wait(runId);
});

test('마지막 명령을 취소해도 확인된 종료와 정리 근거는 결과에 남긴다', async () => {
  const { service, runId, gate } = await setup();
  await writeFile(join(gate, '1-release'), 'go');
  await until(() => existsSync(join(gate, '2-started')));
  const cancellation = service.cancel(runId);
  expect(service.progress(runId)).toMatchObject({ available: false, currentCommand: null });
  const result = await cancellation;
  expect(result).toMatchObject({ state: 'cancelled', finalized: true, cleanupVerified: true });
  expect(result.cases).toContainEqual(expect.objectContaining({ testId: 'check-2', status: 'interrupted' }));
  expect(service.progress(runId).available).toBe(false);
});

test('진행 callback이 없는 외부 실행기는 실행 중에도 가용 상태를 주장하지 않는다', async () => {
  const { service, store, plan, runId, gate } = await setup();
  await writeFile(join(gate, '1-release'), 'go');
  await writeFile(join(gate, '2-release'), 'go');
  await service.wait(runId);
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  const external = new RunService(store, async (_plan, initial) => {
    await pause;
    return { ...initial, state: 'unverifiable' };
  });
  const other = external.start({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() });
  await until(() => store.getRun(other.runId)?.state === 'running');
  expect(external.progress(other.runId)).toMatchObject({ state: 'running', available: false,
    phase: 'unavailable', currentCommand: null, completedCommands: 0 });
  release();
  await external.wait(other.runId);
});

test('계획 밖 IPC 시작 메시지는 진행을 신뢰 불가로 표시한다', async () => {
  ipc.wrongStart = true;
  const { service, runId, gate } = await setup();
  await until(() => existsSync(join(gate, '1-started')));
  expect(service.progress(runId)).toMatchObject({ available: false, phase: 'unavailable', currentCommand: null,
    completedCommands: 0 });
  await writeFile(join(gate, '1-release'), 'go');
  await until(() => existsSync(join(gate, '2-started')));
  await writeFile(join(gate, '2-release'), 'go');
  expect((await service.wait(runId)).verdict).not.toBe('passed');
});
