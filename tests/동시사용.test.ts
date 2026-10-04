// 격리 합성 자료에서 workspace 경계와 세션 제어 및 중복 요청을 검증한다.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiMethod, ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import { ServiceError } from '@checkmate/contracts/api';
import { databaseSpecs } from '../packages/engine/src/자원/데이터베이스종류.js';
import { runResultSchema, type RunResult } from '@checkmate/contracts';
import { RunStoreError, type PlanRegistration } from '@checkmate/contracts/runs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { SharedLocks, executionLockKeys } from '../packages/engine/src/연결/공유잠금.js';
import type { Lease } from '../packages/engine/src/연결/공유잠금.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import type { CallerContext } from '../packages/engine/src/연결/세션제어.js';
import { createStoreFixture, writeConcurrentProject } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function data<T>(response: ApiResponse): T {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(response.error.code);
  return response.data as T;
}
async function fixture(exclusiveResource?: string, lockRoot?: string) {
  const f = await createStoreFixture();
  let retain = false;
  cleanup.push(async () => { if (!retain) await f.cleanup(); });
  const a = await writeConcurrentProject(f.directory, '작업A');
  const b = await writeConcurrentProject(f.directory, '작업B', a.projectId);
  if (exclusiveResource) for (const project of [a, b]) {
    const source = { ...project.source.project, commands: project.source.project.commands.map(command => ({ ...command, exclusiveResources: [exclusiveResource] })) };
    await writeFile(join(project.projectRoot, 'checkmate', '프로젝트.json'), JSON.stringify(source));
  }
  const db = connectStore(f.dbPath);
  cleanup.push(async () => {
    if (db.prepare('SELECT 1 FROM execution_locks LIMIT 1').get()) retain = true;
    db.close();
  });
  await mkdir(join(f.directory, 'runs'));
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const executor = vi.fn(async (_plan: PlanRegistration, initial: RunResult, signal: AbortSignal): Promise<RunResult> => {
    await Promise.race([barrier, new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); })]);
    return { ...initial, state: signal.aborted ? 'cancelled' as const : 'finished' as const, sourceAfter: initial.sourceBefore,
      workerExitCode: 0, environmentVerified: true, evidenceVerified: true, cleanupVerified: true,
      cases: initial.plannedChecks.map(testId => ({ testId, status: 'passed' as const, requirementId: 'requirement-1', expected: null, observed: null, evidenceIds: [], severity: 'info' as const, location: null })) };
  });
  const product = new ProductService(db, new EvidenceStore(db, join(f.directory, 'runs')), executor, undefined, undefined, lockRoot ? { lockRoot } : {});
  const calls = (method: ApiMethod, input: ApiRequest['input'], context?: CallerContext, requestId: string = randomUUID()) => product.handle({ apiVersion: 1, requestId, method, input }, context ? 'agent' : 'human', context);
  const infoA = data<{ workspaceId: string }>(await calls('register', { path: a.projectRoot }));
  const infoB = data<{ workspaceId: string }>(await calls('register', { path: b.projectRoot }));
  const inspect = async (workspaceId: string) => data<{ planId: string; fingerprint: string }>(await calls('inspect', { projectId: a.projectId, workspaceId, profile: 'quick' }));
  const planA = await inspect(infoA.workspaceId), planB = await inspect(infoB.workspaceId);
  await calls('approve', { planId: planA.planId, fingerprint: planA.fingerprint });
  await calls('approve', { planId: planB.planId, fingerprint: planB.fingerprint });
  cleanup.push(async () => { release(); await new Promise(resolve => setTimeout(resolve, 20)); });
  return { f, a, b, db, product, calls, infoA, infoB, planA, planB, release, executor, preserve: () => { retain = true; } };
}

it('다른 workspace 계획과 ambiguous 생략을 거절하고 같은 요청의 본문 및 owner를 검증한다.', async () => {
  const f = await fixture();
  const a = f.product.sessions.verify(f.product.sessions.open().credential);
  const b = f.product.sessions.verify(f.product.sessions.open().credential);
  const body = { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId };
  expect(await f.calls('start', { projectId: body.projectId, planId: body.planId }, a)).toMatchObject({ ok: false, error: { code: 'workspace-required' } });
  expect(await f.calls('start', { ...body, workspaceId: f.infoB.workspaceId }, a)).toMatchObject({ ok: false, error: { code: 'plan-stale' } });
  const requestId = randomUUID();
  const first = data<{ runId: string; ownerId: string }>(await f.calls('start', body, a, requestId));
  await vi.waitFor(() => expect(f.executor).toHaveBeenCalledTimes(1));
  const before = f.product.runs.getRun(first.runId);
  const signal = f.executor.mock.calls[0]![2];
  expect(before?.state).toBe('running');
  expect(first.ownerId).toBe(a.ownerId);
  expect(data<{ runId: string; reused: boolean }>(await f.calls('start', body, a, requestId))).toMatchObject({ runId: first.runId, reused: true });
  expect(await f.calls('start', { ...body, planId: f.planB.planId, workspaceId: f.infoB.workspaceId }, a, requestId)).toMatchObject({ ok: false, error: { code: 'request-conflict' } });
  expect(await f.calls('start', body, b, requestId)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  expect(await f.calls('cancel', { runId: first.runId }, b)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  expect(f.product.runs.getRun(first.runId)).toEqual(before);
  expect(f.product.runs.metadata(first.runId).ownerId).toBe(a.ownerId);
  expect(signal.aborted).toBe(false);
  expect(await f.calls('cancel', { runId: first.runId, ownerId: a.ownerId }, b)).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  data(await f.calls('handoff-run', { runId: first.runId, expectedOwnerId: a.ownerId, ownerId: b.ownerId, confirm: true, note: '합성 사람이 대상 소유자를 확인했다.' }));
  expect(await f.calls('cancel', { runId: first.runId }, a)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  expect(await f.calls('start', body, a, requestId)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  data(await f.calls('cancel', { runId: first.runId }, b));
  expect(f.executor).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(true);
  expect(f.db.prepare("SELECT count(*) AS count FROM audit_events WHERE action='run-control-handed-off'").get()).toEqual({ count: 1 });
  expect(f.db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 });
});

it('공통 잠금루트를 주입한 서로 다른 dataRoot의 전체 키와 조상 출력 충돌을 차단한다.', async () => {
  const f = await createStoreFixture(); cleanup.push(f.cleanup);
  const lockRoot = join(f.directory, '공통잠금');
  const a = new SharedLocks(lockRoot, join(f.directory, '자료A')), b = new SharedLocks(lockRoot, join(f.directory, '자료B'));
  await a.prepare(); await b.prepare();
  const keys = executionLockKeys(f.directory, ['출력'], ['PORT:43123']);
  const lease = a.acquire(randomUUID(), randomUUID(), 'a'.repeat(64), keys);
  a.admit(lease);
  a.assert(lease, keys);
  expect(() => b.acquire(randomUUID(), null, 'b'.repeat(64), executionLockKeys(f.directory, ['출력/결과'], []))).toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
  expect(() => b.acquire(randomUUID(), null, 'b'.repeat(64), ['named:free', 'named:port:43123'])).toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
  expect((await readdir(lockRoot)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  const free = b.acquire(randomUUID(), null, 'b'.repeat(64), ['named:free']);
  b.release(free);
  expect(() => b.release(lease)).toThrowError(expect.objectContaining({ code: 'lock-ownership-unknown' }));
  a.release(lease);
  expect(await readdir(lockRoot)).toEqual([]);
});

it('intent와 소유 불명 및 만료 추정으로 남은 락을 지우지 않는다.', async () => {
  const f = await createStoreFixture(); cleanup.push(f.cleanup);
  const lockRoot = join(f.directory, '공통잠금');
  const a = new SharedLocks(lockRoot, f.directory); await a.prepare();
  const lease = a.acquire(randomUUID(), null, 'a'.repeat(64), ['named:shared']);
  const file = join(lockRoot, `${lease.runId}-${lease.generation}.json`);
  const original = await readFile(file, 'utf8');
  const restarted = new SharedLocks(lockRoot, f.directory); await restarted.prepare();
  expect(() => restarted.acquire(randomUUID(), null, 'b'.repeat(64), ['named:shared'])).toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
  expect(await readFile(file, 'utf8')).toBe(original);
  await writeFile(join(lockRoot, '조정잠금'), '합성 crash 표식');
  expect(() => a.release(lease)).toThrowError(expect.objectContaining({ code: 'lock-coordination-unknown' }));
  expect(await readFile(file, 'utf8')).toBe(original);
});

it('workspace와 출력 경로의 교차 및 중첩 작업공간을 양쪽 접수 순서에서 막는다.', async () => {
  const f = await createStoreFixture(); cleanup.push(f.cleanup);
  const outer = join(f.directory, '바깥');
  const inner = join(outer, '안쪽');
  await mkdir(inner, { recursive: true });
  const locks = new SharedLocks(join(f.directory, '공통잠금'), f.directory); await locks.prepare();
  const outerKey = executionLockKeys(outer, []), innerKey = executionLockKeys(inner, []);
  const writeInner = executionLockKeys(outer, ['안쪽']);
  for (const [first, second] of [[outerKey, innerKey], [innerKey, outerKey], [writeInner, innerKey], [innerKey, writeInner]] as const) {
    const lease = locks.acquire(randomUUID(), null, 'a'.repeat(64), [...first]); locks.admit(lease);
    expect(() => locks.acquire(randomUUID(), null, 'b'.repeat(64), [...second])).toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
    expect((await readdir(locks.root)).filter(name => name.endsWith('.json'))).toHaveLength(1);
    locks.release(lease);
  }
  const path = executionLockKeys(outer, ['안쪽']).find(key => key.startsWith('path:'))!;
  // path 키만 선점해도 writes가 없는 해당 workspace 접수와 충돌해야 한다.
  for (const [first, second] of [[[path], innerKey], [innerKey, [path]]] as const) {
    const lease = locks.acquire(randomUUID(), null, 'a'.repeat(64), [...first]); locks.admit(lease);
    expect(() => locks.acquire(randomUUID(), null, 'b'.repeat(64), [...second])).toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
    locks.release(lease);
  }
});

it('legacy agent 제어는 닫고 조회와 사람 제어는 보존한다.', async () => {
  const f = await fixture();
  const body = { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId };
  expect(await f.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'start', input: body }, 'agent')).toMatchObject({ ok: false, error: { code: 'agent-control-required' } });
  expect(await f.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'projects', input: {} }, 'agent')).toMatchObject({ ok: true });
  const accepted = data<{ runId: string }>(await f.calls('start', body));
  expect(f.product.runs.metadata(accepted.runId).ownerId).toBeNull();
  f.release();
  await f.product.execution.wait(accepted.runId);
  expect(data<{ workspaceId: string }>(await f.calls('result', { runId: accepted.runId })).workspaceId).toBe(f.infoA.workspaceId);
});


it.each(['approval', 'source', 'catalog', 'owner', 'lock'] as const)('queue 출발 직전에 %s 변경을 재검사하고 실행기를 호출하지 않는다.', async change => {
  const f = await fixture();
  const owner = f.product.sessions.verify(f.product.sessions.open().credential);
  const third = await writeConcurrentProject(f.f.directory, '작업C', f.a.projectId);
  const info = data<{ workspaceId: string }>(await f.calls('register', { path: third.projectRoot }));
  const plan = data<{ planId: string; fingerprint: string }>(await f.calls('inspect', { projectId: f.a.projectId, workspaceId: info.workspaceId, profile: 'quick' }));
  data(await f.calls('approve', { planId: plan.planId, fingerprint: plan.fingerprint }));
  const start = (workspaceId: string, planId: string) => f.calls('start', { projectId: f.a.projectId, workspaceId, planId }, owner);
  const first = data<{ runId: string }>(await start(f.infoA.workspaceId, f.planA.planId));
  const second = data<{ runId: string }>(await start(f.infoB.workspaceId, f.planB.planId));
  await vi.waitFor(() => expect(f.executor).toHaveBeenCalledTimes(2));
  const queued = data<{ runId: string }>(await start(info.workspaceId, plan.planId));
  expect(f.product.runs.getRun(queued.runId)?.state).toBe('queued');
  if (change === 'approval') f.db.prepare('UPDATE approvals SET revoked_at=? WHERE plan_id=?').run(new Date().toISOString(), plan.planId);
  if (change === 'source') await writeFile(join(third.projectRoot, '검사.mjs'), '// 합성 소스 변경을 표시한다.\nprocess.exitCode=1;\n');
  if (change === 'catalog') {
    third.source.project.name = '변경한 작업C';
    await writeFile(join(third.projectRoot, 'checkmate', '프로젝트.json'), JSON.stringify(third.source.project));
    const next = data<{ contentHash: string }>(await f.calls('sync', { projectId: f.a.projectId, workspaceId: info.workspaceId }));
    data(await f.calls('activate', { projectId: f.a.projectId, workspaceId: info.workspaceId, contentHash: next.contentHash }));
  }
  if (change === 'owner') f.db.prepare('UPDATE run_control_owners SET owner_hash=? WHERE run_id=?').run('f'.repeat(64), queued.runId);
  if (change === 'lock') {
    const row = f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(queued.runId) as { lease_json: string };
    const lease = JSON.parse(row.lease_json) as { runId: string; generation: string };
    await rm(join(f.product.locks.root, `${lease.runId}-${lease.generation}.json`));
  }
  f.release();
  await Promise.all([first, second, queued].map(run => f.product.execution.wait(run.runId)));
  expect(f.executor).toHaveBeenCalledTimes(2);
  expect(f.product.runs.getRun(queued.runId)).toMatchObject({ state: 'blocked', finalized: true, verdict: 'incomplete' });
  expect(f.db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 3 });
});

it.each(['other-run', 'malformed', 'absent'] as const)('queue 출발 직전에 %s lease 참조는 실행기 호출 없이 차단하고 원본을 보존한다.', async fault => {
  const f = await fixture();
  f.preserve();
  const third = await writeConcurrentProject(f.f.directory, '작업C', f.a.projectId);
  const info = data<{ workspaceId: string }>(await f.calls('register', { path: third.projectRoot }));
  const plan = data<{ planId: string; fingerprint: string }>(await f.calls('inspect', { projectId: f.a.projectId, workspaceId: info.workspaceId, profile: 'quick' }));
  data(await f.calls('approve', { planId: plan.planId, fingerprint: plan.fingerprint }));
  const start = (workspaceId: string, planId: string) => f.calls('start', { projectId: f.a.projectId, workspaceId, planId });
  const first = data<{ runId: string }>(await start(f.infoA.workspaceId, f.planA.planId));
  const second = data<{ runId: string }>(await start(f.infoB.workspaceId, f.planB.planId));
  await vi.waitFor(() => expect(f.executor).toHaveBeenCalledTimes(2));
  const queued = data<{ runId: string }>(await start(info.workspaceId, plan.planId));
  expect(f.product.runs.getRun(queued.runId)?.state).toBe('queued');
  const row = f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(queued.runId) as { lease_json: string };
  const own = JSON.parse(row.lease_json) as Lease;
  const ownPath = join(f.product.locks.root, `${own.runId}-${own.generation}.json`);
  const originalOwn = await readFile(ownPath, 'utf8');
  const priorResults = [first, second].map(run => f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(run.runId));
  let foreignPath: string | undefined, originalForeign: string | undefined;
  if (fault === 'other-run') {
    const foreign = { ...own, runId: randomUUID(), generation: randomUUID() };
    foreignPath = join(f.product.locks.root, `${foreign.runId}-${foreign.generation}.json`);
    originalForeign = JSON.stringify({ ...foreign, phase: 'admitted' });
    await writeFile(foreignPath, originalForeign, { flag: 'wx' });
    f.product.locks.assert(foreign, own.keys);
    f.db.prepare('UPDATE execution_locks SET lease_json=? WHERE run_id=?').run(JSON.stringify(foreign), queued.runId);
  } else if (fault === 'malformed') {
    // 자기 새 합성 DB에서만 JSON 제약을 잠시 열어 손상 저장 참조를 주입한다.
    f.db.pragma('ignore_check_constraints = ON');
    try { f.db.prepare('UPDATE execution_locks SET lease_json=? WHERE run_id=?').run('{', queued.runId); }
    finally { f.db.pragma('ignore_check_constraints = OFF'); }
  } else f.db.prepare('DELETE FROM execution_locks WHERE run_id=?').run(queued.runId);
  const injectedRow = f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(queued.runId);
  expect([first, second].map(run => f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(run.runId))).toEqual(priorResults);
  f.release();
  await Promise.all([first, second, queued].map(run => f.product.execution.wait(run.runId)));
  await vi.waitFor(() => expect(f.product.active).toBe(false));
  const result = f.product.runs.getRun(queued.runId);
  const ownAfter = await readFile(ownPath, 'utf8');
  const foreignAfter = foreignPath ? await readFile(foreignPath, 'utf8') : undefined;
  if (process.env.CHECKMATE_P2_EVIDENCE_ROOT) await writeFile(join(process.env.CHECKMATE_P2_EVIDENCE_ROOT, `큐-${fault}.json`), JSON.stringify({
    utc: new Date().toISOString(), fixture: f.f.directory, runId: queued.runId, fault, executorCalls: f.executor.mock.calls.filter(call => call[1].runId === queued.runId).length,
    result, ownPath, foreignPath, originalOwn, ownAfter, originalForeign, foreignAfter, injectedRow,
    finalRow: f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(queued.runId),
    priorResults, finalPriorResults: [first, second].map(run => f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(run.runId)), retained: true,
  }, null, 2));
  expect(f.executor.mock.calls.filter(call => call[1].runId === queued.runId)).toHaveLength(0);
  expect(result).toMatchObject({ state: 'blocked', finalized: true, verdict: 'incomplete' });
  expect(ownAfter).toBe(originalOwn);
  expect(foreignAfter).toBe(originalForeign);
  expect(f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(queued.runId)).toEqual(injectedRow);
  expect([first, second].map(run => f.product.runs.getRun(run.runId)?.verdict)).toEqual(['passed', 'passed']);
});

it('같은 workspace 새 실행은 막고 다른 workspace는 동시에 실행하며 queued 인계 뒤 구권한은 거절한다.', async () => {
  const f = await fixture();
  const a = f.product.sessions.verify(f.product.sessions.open().credential), b = f.product.sessions.verify(f.product.sessions.open().credential);
  const body = { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId };
  const first = data<{ runId: string }>(await f.calls('start', body, a));
  expect(await f.calls('start', body, b)).toMatchObject({ ok: false, error: { code: 'shared-resource-busy' } });
  const second = data<{ runId: string }>(await f.calls('start', { ...body, workspaceId: f.infoB.workspaceId, planId: f.planB.planId }, a));
  await vi.waitFor(() => expect(f.executor).toHaveBeenCalledTimes(2));
  const c = await writeConcurrentProject(f.f.directory, '작업C', f.a.projectId);
  const info = data<{ workspaceId: string }>(await f.calls('register', { path: c.projectRoot }));
  const plan = data<{ planId: string; fingerprint: string }>(await f.calls('inspect', { projectId: f.a.projectId, workspaceId: info.workspaceId, profile: 'quick' }));
  data(await f.calls('approve', { planId: plan.planId, fingerprint: plan.fingerprint }));
  const queued = data<{ runId: string }>(await f.calls('start', { ...body, workspaceId: info.workspaceId, planId: plan.planId }, a));
  data(await f.calls('handoff-run', { runId: queued.runId, expectedOwnerId: a.ownerId, ownerId: b.ownerId, confirm: true, note: '합성 사람이 queued 실행 인계를 확인했다.' }));
  expect(await f.calls('cancel', { runId: queued.runId }, a)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  f.release();
  await Promise.all([first, second, queued].map(run => f.product.execution.wait(run.runId)));
  expect(f.executor).toHaveBeenCalledTimes(3);
  expect(f.product.runs.metadata(queued.runId).ownerId).toBe(b.ownerId);
  expect(f.product.runs.getRun(queued.runId)?.state).toBe('finished');
});

it('unknown 실행의 lease와 원본 결과를 보존하고 같은 request는 재실행하지 않으며 사람 ack만 잠금을 반환한다.', async () => {
  const f = await fixture();
  f.executor.mockImplementation(async (_plan, initial) => ({ ...initial, state: 'unverifiable', cleanupVerified: false }));
  const owner = f.product.sessions.verify(f.product.sessions.open().credential);
  const body = { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId }, requestId = randomUUID();
  const first = data<{ runId: string }>(await f.calls('start', body, owner, requestId));
  await f.product.execution.wait(first.runId);
  await vi.waitFor(() => expect(f.executor).toHaveBeenCalledTimes(1));
  const original = (f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(first.runId) as { summary_json: string }).summary_json;
  expect(runResultSchema.safeParse(JSON.parse(original)).success).toBe(true);
  expect(JSON.parse(original)).not.toHaveProperty('ownerId');
  expect(JSON.parse(original)).not.toHaveProperty('workspaceId');
  expect((await readdir(f.product.locks.root)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  const replay = data<{ runId: string; reused: boolean }>(await f.calls('start', body, owner, requestId));
  expect(replay).toMatchObject({ runId: first.runId, reused: true });
  expect(f.executor).toHaveBeenCalledTimes(1);
  expect(await f.calls('start', body, owner)).toMatchObject({ ok: false, error: { code: 'ownership-unknown' } });
  const restarted = new SharedLocks(f.product.locks.root, f.f.directory); await restarted.prepare();
  expect(() => restarted.acquire(randomUUID(), null, 'c'.repeat(64), executionLockKeys(f.a.projectRoot, []))).toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
  const ack = { runId: first.runId, confirm: true, note: '합성 사람이 프로세스 및 자원 부재를 직접 확인했다.' };
  const resourceId = randomUUID();
  f.db.prepare('INSERT INTO resources (id,run_id,kind,owner_token_hash,state,descriptor_json,cleanup_json) VALUES (?,?,?,?,?,?,?)')
    .run(resourceId, first.runId, 'postgres-test', 'e'.repeat(64), 'cleaned', JSON.stringify({ name: `cm-pg-${first.runId}-${resourceId}`, image: databaseSpecs['postgres-test'].image,
      endpoint: 'unix:///synthetic-not-connected.sock', daemonId: 'synthetic-not-connected' }), JSON.stringify({ verified: true, checkedAt: new Date().toISOString(), reason: '합성 사람이 진행 실행 자원 부재를 확인한 기록' }));
  expect(await f.calls('acknowledge-cleanup', ack, owner)).toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  data(await f.calls('acknowledge-cleanup', ack));
  expect((await readdir(f.product.locks.root)).filter(name => name.endsWith('.json'))).toHaveLength(0);
  expect((f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(first.runId) as { summary_json: string }).summary_json).toBe(original);
  expect(f.product.runs.getRun(first.runId)).toMatchObject({ verdict: 'unknown', cleanupVerified: false });
});

it('다른 workspace passed는 기존 gaps를 닫지 않고 history와 cursor를 선택 경계에 묶는다.', async () => {
  const f = await fixture();
  f.executor.mockImplementationOnce(async (_plan, initial) => ({ ...initial, state: 'blocked', cleanupVerified: true }));
  const body = { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId };
  const blocked = data<{ runId: string }>(await f.calls('start', body));
  await f.product.execution.wait(blocked.runId);
  await vi.waitFor(() => expect(f.db.prepare("SELECT count(*) AS count FROM gaps WHERE state='open'").get()).toEqual({ count: 1 }));
  const second = data<{ runId: string }>(await f.calls('start', { ...body, workspaceId: f.infoB.workspaceId, planId: f.planB.planId }));
  f.release(); await f.product.execution.wait(second.runId);
  await vi.waitFor(() => expect(f.db.prepare("SELECT count(*) AS count FROM audit_events WHERE action='run-finalized'").get()).toEqual({ count: 2 }));
  expect(f.db.prepare("SELECT state,resolved_run_id FROM gaps WHERE opened_run_id=?").get(blocked.runId)).toEqual({ state: 'open', resolved_run_id: null });
  expect(data<{ items: { openedRunId: string }[] }>(await f.calls('gaps', { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId })).items).toMatchObject([{ openedRunId: blocked.runId }]);
  expect(data<{ items: unknown[] }>(await f.calls('gaps', { projectId: f.a.projectId, workspaceId: f.infoB.workspaceId })).items).toEqual([]);
  const third = data<{ runId: string }>(await f.calls('start', body)); await f.product.execution.wait(third.runId);
  await vi.waitFor(() => expect(f.db.prepare("SELECT state FROM gaps WHERE opened_run_id=?").get(blocked.runId)).toEqual({ state: 'resolved' }));
  const history = data<{ items: { runId: string; workspaceId: string }[]; nextCursor: string }>(await f.calls('history', { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, limit: 1 }));
  expect(history.items).toHaveLength(1); expect(history.items[0]!.workspaceId).toBe(f.infoA.workspaceId);
  expect(history.nextCursor).toBeTypeOf('string');
  expect(await f.calls('history', { projectId: f.a.projectId, workspaceId: f.infoB.workspaceId, cursor: history.nextCursor })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
});



it('서로 다른 서비스와 dataRoot의 명시 공유 자원은 같은 공통 루트에서 접수를 막는다.', async () => {
  const outer = await createStoreFixture(); cleanup.push(outer.cleanup);
  const root = join(outer.directory, '공통잠금');
  const first = await fixture('PORT:43123', root), second = await fixture('port:43123', root);
  const body = (f: Awaited<ReturnType<typeof fixture>>) => ({ projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId });
  const run = data<{ runId: string }>(await first.calls('start', body(first)));
  await vi.waitFor(() => expect(first.executor).toHaveBeenCalledTimes(1));
  expect(await second.calls('start', body(second))).toMatchObject({ ok: false, error: { code: 'shared-resource-busy' } });
  expect(second.executor).toHaveBeenCalledTimes(0);
  expect(second.db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
  expect((await readdir(root)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  first.release(); await first.product.execution.wait(run.runId);
  await vi.waitFor(async () => expect((await readdir(root)).filter(name => name.endsWith('.json'))).toHaveLength(0));
  const accepted = data<{ runId: string }>(await second.calls('start', body(second)));
  second.release(); await second.product.execution.wait(accepted.runId);
  expect(second.executor).toHaveBeenCalledTimes(1);
});



it.each(['approval', 'credential'] as const)('최초 확인 이후 admission guard의 %s 거절은 rows와 자기 intent를 남기지 않는다.', async change => {
  const f = await fixture();
  const owner = f.product.sessions.verify(f.product.sessions.open().credential);
  if (change === 'approval') vi.spyOn(f.product.projects, 'hasApproval').mockReturnValueOnce(true).mockReturnValue(false);
  else {
    const original = f.product.sessions.assert.bind(f.product.sessions);
    let calls = 0;
    vi.spyOn(f.product.sessions, 'assert').mockImplementation(context => { if (++calls === 3) throw new ServiceError('agent-control-required'); return original(context); });
  }
  const response = await f.calls('start', { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId }, owner);
  expect(response).toMatchObject({ ok: false, error: { code: change === 'approval' ? 'needs-approval' : 'agent-control-required' } });
  expect(f.db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
  expect(f.db.prepare('SELECT count(*) AS count FROM requests').get()).toEqual({ count: 0 });
  expect(f.db.prepare('SELECT count(*) AS count FROM execution_locks').get()).toEqual({ count: 0 });
  expect(f.executor).toHaveBeenCalledTimes(0);
  expect((await readdir(f.product.locks.root)).filter(name => name.endsWith('.json'))).toHaveLength(0);
});



it.each([false, true])('SQL 접수 응답 불명 committed=%s이면 자기 lease와 기존 타실행 lease를 보존하고 재실행하지 않는다.', async committed => {
  const f = await fixture();
  await f.product.locks.prepare();
  const previous = f.product.locks.acquire(randomUUID(), null, 'd'.repeat(64), ['named:prior-protected']); f.product.locks.admit(previous);
  const original = f.product.runs.admitRun.bind(f.product.runs);
  vi.spyOn(f.product.runs, 'admitRun').mockImplementationOnce((input, guard) => {
    if (committed) original(input, guard);
    throw new RunStoreError('storage-error');
  });
  const owner = f.product.sessions.verify(f.product.sessions.open().credential);
  const body = { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId }, requestId = randomUUID();
  expect(await f.calls('start', body, owner, requestId)).toMatchObject({ ok: false, error: { code: 'storage-error' } });
  expect((await readdir(f.product.locks.root)).filter(name => name.endsWith('.json'))).toHaveLength(2);
  f.product.locks.assert(previous, previous.keys);
  expect(f.executor).toHaveBeenCalledTimes(0);
  expect(f.db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: committed ? 1 : 0 });
  if (committed) {
    expect(await f.calls('start', body, owner, requestId)).toMatchObject({ ok: true, data: { reused: true } });
    expect(f.executor).toHaveBeenCalledTimes(0);
  } else expect(await f.calls('start', body, owner, requestId)).toMatchObject({ ok: false, error: { code: 'shared-resource-busy' } });
  expect((await readdir(f.product.locks.root)).filter(name => name.endsWith('.json'))).toHaveLength(2);
});



it('정리 확인은 다른 run의 lease를 가리킨 손상 참조를 거절하고 두 원본 lease를 보존한다.', async () => {
  const f = await fixture();
  f.executor.mockImplementation(async (_plan, initial) => ({ ...initial, state: 'unverifiable', cleanupVerified: false }));
  const accepted = data<{ runId: string }>(await f.calls('start', { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId }));
  await f.product.execution.wait(accepted.runId);
  const ownRow = f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(accepted.runId) as { lease_json: string };
  const ownLease = JSON.parse(ownRow.lease_json) as { runId: string; generation: string };
  const foreign = f.product.locks.acquire(randomUUID(), null, 'd'.repeat(64), ['named:foreign-protected']); f.product.locks.admit(foreign);
  const ownFile = join(f.product.locks.root, `${ownLease.runId}-${ownLease.generation}.json`), foreignFile = join(f.product.locks.root, `${foreign.runId}-${foreign.generation}.json`);
  const originalOwn = await readFile(ownFile, 'utf8'), originalForeign = await readFile(foreignFile, 'utf8');
  const originalResult = f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(accepted.runId);
  f.db.prepare('UPDATE execution_locks SET lease_json=? WHERE run_id=?').run(JSON.stringify(foreign), accepted.runId);
  expect(await f.calls('acknowledge-cleanup', { runId: accepted.runId, confirm: true, note: '합성 사람이 대상 실행의 정리 부재를 직접 확인했다.' })).toMatchObject({ ok: false, error: { code: 'lock-ownership-unknown' } });
  expect(await readFile(ownFile, 'utf8')).toBe(originalOwn);
  expect(await readFile(foreignFile, 'utf8')).toBe(originalForeign);
  expect(f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(accepted.runId)).toEqual(originalResult);
  expect(f.db.prepare("SELECT count(*) AS count FROM audit_events WHERE action='cleanup-acknowledged' AND entity_id=?").get(accepted.runId)).toEqual({ count: 0 });
});



it.each(['absent', 'wrong-state'] as const)('일반 cleanupVerified=true 실행과 %s 복구 근거는 사람 ack로 잠금을 해소하지 않는다.', async audit => {
  const f = await fixture();
  f.executor.mockImplementation(async (_plan, initial) => ({ ...initial, state: 'blocked', cleanupVerified: true }));
  const accepted = data<{ runId: string }>(await f.calls('start', { projectId: f.a.projectId, workspaceId: f.infoA.workspaceId, planId: f.planA.planId }));
  await f.product.execution.wait(accepted.runId);
  await vi.waitFor(() => expect(f.db.prepare('SELECT count(*) AS count FROM execution_locks').get()).toEqual({ count: 0 }));
  const lease = f.product.locks.acquire(accepted.runId, null, 'a'.repeat(64), executionLockKeys(f.a.projectRoot, [])); f.product.locks.admit(lease);
  f.db.prepare('INSERT INTO execution_locks (run_id,lease_json) VALUES (?,?)').run(accepted.runId, JSON.stringify(lease));
  if (audit === 'wrong-state') f.db.prepare("INSERT INTO audit_events (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json) VALUES (?,'run-recovery-blocked','service',?,NULL,NULL,NULL,?,?)").run(randomUUID(), accepted.runId, new Date().toISOString(), JSON.stringify({ previousState: 'running', reason: 'service-restarted' }));
  const file = join(f.product.locks.root, `${lease.runId}-${lease.generation}.json`), before = await readFile(file, 'utf8');
  const result = f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(accepted.runId);
  expect(await f.calls('acknowledge-cleanup', { runId: accepted.runId, confirm: true, note: '합성 사람이 대상 실행을 확인한 시험이다.' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(accepted.runId)).toEqual(result);
  expect(f.db.prepare("SELECT count(*) AS count FROM audit_events WHERE entity_id=? AND action='cleanup-acknowledged'").get(accepted.runId)).toEqual({ count: 0 });
});
