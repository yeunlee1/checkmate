// 실제 SQLite 저장소와 메모리 실행기로 서비스의 큐와 취소를 검증한다.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { assessResult } from '@checkmate/contracts';
import type { RunResult } from '@checkmate/contracts';
import { RunStoreError } from '@checkmate/contracts/runs';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
import type { RunExecutor } from '../packages/engine/src/서비스/실행서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function setup(executor: RunExecutor) {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const plan: PlanRegistration = {
    project: { id: randomUUID(), name: '서비스 시험', repositoryIdentity: 'local-test' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] },
    createdAt: new Date().toISOString(),
  };
  const store = new SQLiteRunStore(db);
  store.registerPlan(plan);
  return { files, store, plan, service: new RunService(store, executor) };
}

function passed(initial: RunResult): RunResult {
  return { ...initial, state: 'finished', sourceAfter: initial.sourceBefore, workerExitCode: 0,
    environmentVerified: true, evidenceVerified: true, cleanupVerified: true,
    cases: [{ testId: 'check-1', status: 'passed', requirementId: null, expected: null, observed: null,
      evidenceIds: [], severity: 'info', location: null }] };
}

test('접수 뒤 한 번만 실행하고 같은 요청에 같은 실행 ID를 돌려준다', async () => {
  let calls = 0;
  const { store, plan, service } = await setup(async (_plan, initial) => { calls++; return passed(initial); });
  const input = { projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() };
  const first = service.start(input);
  expect(store.getRun(first.runId)?.state).toBe('queued');
  expect(service.start(input)).toEqual({ runId: first.runId, reused: true });
  const result = await service.wait(first.runId);
  expect(result.verdict).toBe('passed');
  expect(result.reasons).toEqual(assessResult(result).reasons);
  expect(calls).toBe(1);
  expect(await service.wait(first.runId)).toEqual(result);
});

test('확정 후 메모리 소유 정보를 비우고 wait가 저장 결과를 다시 읽는다', async () => {
  const { store, plan, service } = await setup(async (_plan, initial) => passed(initial));
  const run = service.start({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() });
  const result = await service.wait(run.runId);
  expect((service as unknown as { local: Map<string, unknown> }).local.size).toBe(0);
  const read = vi.spyOn(store, 'getRun');
  expect(await service.wait(run.runId)).toEqual(result);
  expect(read).toHaveBeenCalledWith(run.runId);
});

test('최종 저장 실패는 wait에 전달되고 성공으로 재사용되지 않는다', async () => {
  const { store, plan, service } = await setup(async (_plan, initial) => passed(initial));
  vi.spyOn(store, 'finalizeRun').mockImplementationOnce(() => { throw new RunStoreError('storage-error'); });
  const run = service.start({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() });
  await expect(service.wait(run.runId)).rejects.toMatchObject({ code: 'storage-error' });
  expect((service as unknown as { local: Map<string, unknown> }).local.size).toBe(0);
  await expect(service.wait(run.runId)).rejects.toMatchObject({ code: 'invalid-state' });
  expect(store.getRun(run.runId)?.finalized).toBe(false);
});

test('취소 신호를 받은 실행은 통과 결과를 반환해도 cancelled로 확정한다', async () => {
  let signalSeen = false;
  const { plan, service } = await setup(async (_plan, initial, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { signalSeen = true; resolve(); }, { once: true }));
    return passed(initial);
  });
  const run = service.start({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() });
  await Promise.resolve();
  const result = await service.cancel(run.runId);
  expect(result.state).toBe('cancelled');
  expect(result.verdict).not.toBe('passed');
  expect(signalSeen).toBe(true);
});

test('실행기 예외와 고정 계획 변조를 unverifiable로 보존한다', async () => {
  const first = await setup(async () => { throw new Error('비밀 실행기 오류'); });
  const run = first.service.start({ projectId: first.plan.project.id, planId: first.plan.plan.id, requestId: randomUUID() });
  expect((await first.service.wait(run.runId)).state).toBe('unverifiable');
  const second = await setup(async (_plan, initial) => ({ ...passed(initial), runId: randomUUID() }));
  const mutated = second.service.start({ projectId: second.plan.project.id, planId: second.plan.plan.id, requestId: randomUUID() });
  const result = await second.service.wait(mutated.runId);
  expect(result.state).toBe('unverifiable');
  expect(result.runId).toBe(mutated.runId);
});

test('다른 서비스가 소유한 진행 중 실행은 재실행하거나 취소하지 않는다', async () => {
  let calls = 0;
  const { store, plan, service } = await setup(async (_plan, initial) => { calls++; return passed(initial); });
  const input = { projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() };
  const run = service.start(input);
  const other = new RunService(store, async () => { calls++; throw new Error('실행되면 안 됨'); });
  expect(other.start(input)).toEqual({ runId: run.runId, reused: true });
  await expect(other.cancel(run.runId)).rejects.toMatchObject({ code: 'invalid-state' });
  await service.wait(run.runId);
  expect(calls).toBe(1);
});

test('두 작업 폴더의 실행을 직렬화하고 대기 중 취소한 실행기는 호출하지 않는다', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const { files, store, plan, service } = await setup(async (_plan, initial) => {
    started.push(initial.runId);
    await gate;
    return passed(initial);
  });
  const secondPath = join(files.directory, '두번째');
  await mkdir(secondPath);
  const secondPlan: PlanRegistration = { ...plan,
    workspace: { ...plan.workspace, id: randomUUID(), realPath: secondPath },
    plan: { ...plan.plan, id: randomUUID() } };
  store.registerPlan(secondPlan);
  const first = service.start({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() });
  const second = service.start({ projectId: plan.project.id, planId: secondPlan.plan.id, requestId: randomUUID() });
  await Promise.resolve();
  expect(started).toEqual([first.runId]);
  const cancel = service.cancel(second.runId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let immediate: [RunResult, RunResult] | null;
  try {
    immediate = await Promise.race([
      Promise.all([cancel, service.wait(second.runId)]),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 200); }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
  }
  expect(immediate?.[0].state).toBe('cancelled');
  expect(immediate?.[1].state).toBe('cancelled');
  expect(started).toEqual([first.runId]);
  expect((await service.wait(first.runId)).verdict).toBe('passed');
  expect(started).toEqual([first.runId]);
});

test('시작 직후 입력 객체를 바꿔도 접수된 계획만 실행한다', async () => {
  let executedPlanId: string | undefined;
  const { store, plan, service } = await setup(async (selected, initial) => {
    executedPlanId = selected.plan.id;
    return passed(initial);
  });
  const otherPlan: PlanRegistration = { ...plan,
    plan: { ...plan.plan, id: randomUUID(), fingerprint: 'e'.repeat(64), sourceHash: 'f'.repeat(64) } };
  store.registerPlan(otherPlan);
  const input = { projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() };
  const accepted = service.start(input);
  input.planId = otherPlan.plan.id;
  const result = await service.wait(accepted.runId);
  expect(executedPlanId).toBe(plan.plan.id);
  expect(result.planHash).toBe(plan.plan.fingerprint);
  expect(result.verdict).toBe('passed');
});
