// 합성 실행 DB에서 이벤트 순서와 멱등 기록 및 롤백을 확인한다.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import type { AdapterEvent } from '@checkmate/contracts/events';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const registration: PlanRegistration = {
    project: { id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'local-test' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] }, createdAt: new Date().toISOString(),
  };
  const runId = randomUUID();
  const runs = new SQLiteRunStore(db);
  runs.registerPlan(registration);
  runs.admitRun({ projectId: registration.project.id, planId: registration.plan.id,
    requestId: randomUUID(), requestHash: 'e'.repeat(64), runId, createdAt: new Date().toISOString() });
  return { db, runId, store: new EventStore(db) };
}

function event(runId: string, sequence: number, payload: Record<string, unknown> = { note: '합성' }): AdapterEvent {
  return { protocolVersion: 1, runId, sequence, type: 'step-started', time: new Date().toISOString(), payload };
}

test('같은 순번과 내용은 재사용하고 다른 내용 및 순서 누락은 거절한다', async () => {
  const { db, runId, store } = await fixture();
  const first = event(runId, 1);
  expect(store.append(first)).toEqual({ reused: false });
  expect(store.append(first)).toEqual({ reused: true });
  expect(() => store.append({ ...first, payload: { note: '충돌' } }))
    .toThrowError(expect.objectContaining({ code: 'event-conflict' }));
  expect(() => store.append(event(runId, 3))).toThrowError(expect.objectContaining({ code: 'event-sequence' }));
  const second = event(runId, 2);
  expect(store.append(second)).toEqual({ reused: false });
  expect(store.list(runId)).toEqual([first, second]);
  expect(store.list(runId, 1, 1)).toEqual([second]);
  expect((db.prepare('SELECT count(*) AS count FROM events').get() as { count: number }).count).toBe(2);
});

test('없는 실행과 과대 이벤트 및 직렬화 불가 payload를 거절한다', async () => {
  const { db, runId, store } = await fixture();
  expect(() => store.append(event(randomUUID(), 1))).toThrowError(expect.objectContaining({ code: 'run-not-found' }));
  expect(() => store.append(event(runId, 1, { content: 'a'.repeat(64 * 1024) })))
    .toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  expect(() => store.append(event(runId, 1, { secret: undefined })))
    .toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  expect(() => store.list(runId, -1)).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  expect((db.prepare('SELECT count(*) AS count FROM events').get() as { count: number }).count).toBe(0);
});

test('SQLite 삽입 실패 뒤 이벤트 행과 순번이 남지 않는다', async () => {
  const { db, runId, store } = await fixture();
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
  expect(() => store.append(event(runId, 1))).toThrowError(expect.objectContaining({ code: 'storage-error' }));
  expect(store.list(runId)).toEqual([]);
  db.exec('DROP TRIGGER reject_event');
  expect(store.append(event(runId, 1))).toEqual({ reused: false });
});
