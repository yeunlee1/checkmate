// 합성 SQLite에서 계획 등록과 실행 저장의 무결성을 검증한다.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { assessResult } from '@checkmate/contracts';
import type { RunResult } from '@checkmate/contracts';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { if (db.open) db.close(); await files.cleanup(); });
  const registration: PlanRegistration = {
    project: { id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'local-test' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: { check: { id: 'check-1' } } },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] },
    createdAt: new Date().toISOString(),
  };
  const store = new SQLiteRunStore(db);
  store.registerPlan(registration);
  return { files, db, store, registration };
}

function admission(plan: PlanRegistration, overrides: Partial<{ requestId: string; requestHash: string; runId: string; createdAt: string }> = {}) {
  return { projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID(), requestHash: 'e'.repeat(64),
    runId: randomUUID(), createdAt: new Date().toISOString(), ...overrides };
}

function finished(result: RunResult): RunResult {
  const final: RunResult = { ...result, state: 'finished', finalized: true, sourceAfter: result.sourceBefore,
    workerExitCode: 0, environmentVerified: true, evidenceVerified: true, cleanupVerified: true,
    cases: [{ testId: 'check-1', status: 'passed', requirementId: null, expected: null, observed: null,
      evidenceIds: [], severity: 'info', location: null }], verdict: null, reasons: [] };
  const assessed = assessResult(final);
  return { ...final, verdict: assessed.verdict, reasons: assessed.reasons };
}

test('재등록과 재개방 보존, 같은 요청 재사용, 해시 충돌을 확인한다', async () => {
  const { files, db, store, registration } = await fixture();
  store.registerPlan(registration);
  expect(store.getPlan(registration.plan.id)).toEqual({ ...registration,
    workspace: { ...registration.workspace, realPath: process.platform === 'win32'
      ? realpathSync.native(registration.workspace.realPath).toLowerCase() : realpathSync.native(registration.workspace.realPath) } });
  expect(() => store.registerPlan({ ...registration, project: { ...registration.project, name: '변조' } })).toThrow();
  const first = admission(registration);
  expect(store.admitRun(first)).toEqual({ runId: first.runId, reused: false });
  expect(store.admitRun({ ...first, runId: randomUUID() })).toEqual({ runId: first.runId, reused: true });
  expect(() => store.admitRun({ ...first, requestHash: 'f'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'request-conflict' }));
  db.close();
  const reopened = connectStore(files.dbPath);
  cleanup.unshift(async () => { reopened.close(); });
  expect(new SQLiteRunStore(reopened).getRun(first.runId)?.state).toBe('queued');
});

test('다른 프로젝트 계획 연결과 작업 폴더 잠금을 거절한다', async () => {
  const { store, registration } = await fixture();
  const first = admission(registration);
  expect(() => store.admitRun({ ...first, projectId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'project-not-found' }));
  store.admitRun(first);
  expect(() => store.admitRun(admission(registration))).toThrowError(expect.objectContaining({ code: 'workspace-busy' }));
  expect(store.markRunning(first.runId).state).toBe('running');
  expect(() => store.markRunning(first.runId)).toThrowError(expect.objectContaining({ code: 'invalid-state' }));
});

test('최종 결과 변조와 case 삽입 실패는 전체 트랜잭션을 되돌린다', async () => {
  const { db, store, registration } = await fixture();
  const input = admission(registration);
  store.admitRun(input);
  const running = store.markRunning(input.runId);
  const final = finished(running);
  expect(() => store.finalizeRun({ ...final, profile: 'other' })).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  db.exec(`CREATE TRIGGER reject_case BEFORE INSERT ON case_results BEGIN SELECT RAISE(ABORT, 'rejected'); END;`);
  expect(() => store.finalizeRun(final)).toThrowError(expect.objectContaining({ code: 'storage-error' }));
  expect(store.getRun(input.runId)?.state).toBe('running');
  db.exec('DROP TRIGGER reject_case');
  expect(store.finalizeRun(final).verdict).toBe('passed');
  expect(store.finalizeRun(final).verdict).toBe('passed');
  expect(() => store.finalizeRun({ ...final, workerExitCode: 1, verdict: 'failed', reasons: ['worker-failed'] }))
    .toThrowError(expect.objectContaining({ code: 'invalid-state' }));
  expect((db.prepare('SELECT count(*) AS count FROM case_results WHERE run_id = ?').get(input.runId) as { count: number }).count).toBe(1);
});

test('프로젝트별 시간과 ID cursor를 사용하고 다른 프로젝트 cursor를 거절한다', async () => {
  const { files, store, registration } = await fixture();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const input = admission(registration);
    store.admitRun(input);
    const cancelled: RunResult = { ...store.getRun(input.runId)!, state: 'cancelled', finalized: true };
    const assessment = assessResult(cancelled);
    store.finalizeRun({ ...cancelled, verdict: assessment.verdict, reasons: assessment.reasons });
    ids.push(input.runId);
  }
  const first = store.listRuns(registration.project.id, 2);
  const second = store.listRuns(registration.project.id, 2, first.nextCursor!);
  expect(new Set([...first.runs, ...second.runs].map((run) => run.runId))).toEqual(new Set(ids));
  expect(second.nextCursor).toBeNull();
  expect(() => store.listRuns(randomUUID(), 2, first.nextCursor!)).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  const otherPath = join(files.directory, 'other');
  await mkdir(otherPath);
  const other: PlanRegistration = { ...registration, project: { ...registration.project, id: randomUUID(), name: '다른 프로젝트' },
    workspace: { ...registration.workspace, id: randomUUID(), realPath: otherPath },
    catalog: { ...registration.catalog, id: randomUUID() }, plan: { ...registration.plan, id: randomUUID() } };
  store.registerPlan(other);
  expect(() => store.admitRun({ ...admission(registration), projectId: other.project.id }))
    .toThrowError(expect.objectContaining({ code: 'plan-stale' }));
});

test('초 단위 UTC 접수를 밀리초로 저장하고 실제 시간과 cursor 순서로 조회한다', async () => {
  const { db, store, registration } = await fixture();
  const older = admission(registration, { createdAt: '2026-09-25T03:00:00Z' });
  store.admitRun(older);
  const oldRun: RunResult = { ...store.getRun(older.runId)!, state: 'cancelled', finalized: true };
  store.finalizeRun({ ...oldRun, ...assessResult(oldRun) });
  const newer = admission(registration, { createdAt: '2026-09-25T03:00:00.100Z' });
  store.admitRun(newer);
  const newRun: RunResult = { ...store.getRun(newer.runId)!, state: 'cancelled', finalized: true };
  store.finalizeRun({ ...newRun, ...assessResult(newRun) });
  expect(db.prepare('SELECT started_at FROM runs WHERE id = ?').get(older.runId))
    .toEqual({ started_at: '2026-09-25T03:00:00.000Z' });
  const first = store.listRuns(registration.project.id, 1);
  const second = store.listRuns(registration.project.id, 1, first.nextCursor!);
  expect([...first.runs, ...second.runs].map((run) => run.runId)).toEqual([newer.runId, older.runId]);
  expect(second.nextCursor).toBeNull();

  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(older.createdAt, older.runId);
  const mixedFirst = store.listRuns(registration.project.id, 1);
  const mixedSecond = store.listRuns(registration.project.id, 1, mixedFirst.nextCursor!);
  expect([...mixedFirst.runs, ...mixedSecond.runs].map((run) => run.runId)).toEqual([newer.runId, older.runId]);
});

test('두 연결의 동시 접수에서 한 실행만 잠금을 얻는다', async () => {
  const { files, db, store, registration } = await fixture();
  const otherDb = connectStore(files.dbPath);
  cleanup.unshift(async () => { otherDb.close(); });
  const second = new SQLiteRunStore(otherDb);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => store.admitRun(admission(registration))),
    Promise.resolve().then(() => second.admitRun(admission(registration))),
  ]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect((db.prepare('SELECT count(*) AS count FROM runs').get() as { count: number }).count).toBe(1);
  expect((db.prepare('SELECT count(*) AS count FROM requests').get() as { count: number }).count).toBe(1);
});

test('두 실제 WAL 연결의 중첩 접수에서 BUSY SNAPSHOT을 storage-busy로 반환한다', async () => {
  const { files, db, store, registration } = await fixture();
  const otherDb = connectStore(files.dbPath);
  cleanup.unshift(async () => { otherDb.close(); });
  const otherStore = new SQLiteRunStore(otherDb);
  const input = admission(registration);
  const originalPrepare = db.prepare.bind(db);
  let sqliteCode: string | undefined;
  let overlapped = false;
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = originalPrepare(sql);
    if (sql.startsWith('SELECT request_hash, run_id') && !overlapped) {
      const originalGet = statement.get.bind(statement);
      statement.get = (...params: unknown[]) => {
        const row = originalGet(...params);
        overlapped = true;
        expect(otherStore.admitRun({ ...input, runId: randomUUID() }).reused).toBe(false);
        return row;
      };
    }
    if (sql.startsWith('INSERT INTO runs')) {
      const originalRun = statement.run.bind(statement);
      statement.run = (...params: unknown[]) => {
        try { return originalRun(...params); }
        catch (error) { sqliteCode = (error as { code: string }).code; throw error; }
      };
    }
    return statement;
  });
  try {
    expect(() => store.admitRun(input)).toThrowError(expect.objectContaining({ code: 'storage-busy' }));
    expect(overlapped).toBe(true);
    expect(sqliteCode).toBe('SQLITE_BUSY_SNAPSHOT');
    expect(store.admitRun(input)).toEqual({ runId: (db.prepare('SELECT run_id FROM requests WHERE request_id = ?')
      .get(input.requestId) as { run_id: string }).run_id, reused: true });
    expect(db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM requests').get()).toEqual({ count: 1 });
  } finally { spy.mockRestore(); }
});

test('새 카탈로그 등록은 활성 카탈로그를 바꾸지 않으며 손상된 JSON을 오류로 반환한다', async () => {
  const { db, store, registration } = await fixture();
  const next: PlanRegistration = { ...registration,
    catalog: { ...registration.catalog, id: randomUUID(), contentHash: 'f'.repeat(64) },
    plan: { ...registration.plan, id: randomUUID() } };
  store.registerPlan(next);
  expect(() => store.admitRun(admission(next))).toThrowError(expect.objectContaining({ code: 'plan-stale' }));
  expect((db.prepare('SELECT active_catalog_id FROM projects WHERE id = ?').get(registration.project.id) as
    { active_catalog_id: string }).active_catalog_id).toBe(registration.catalog.id);
  db.prepare('UPDATE plans SET plan_json = ? WHERE id = ?').run('{}', registration.plan.id);
  expect(() => store.getPlan(registration.plan.id)).toThrowError(expect.objectContaining({ code: 'storage-error' }));
});
