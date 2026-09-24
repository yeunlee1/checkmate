// 자원 생성 의도의 내구 저장과 소유 정보 변경 거절을 합성 DB에서 검증한다.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { ResourceStore, type ResourceRecord } from '../packages/engine/src/저장/자원저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test('생성 전 의도는 재개방 뒤 유지되고 소유권 변경과 근거 없는 완료를 거절한다', async () => {
  const files = await createStoreFixture();
  let db = connectStore(files.dbPath);
  cleanup.push(async () => { if (db.open) db.close(); await files.cleanup(); });
  const runs = new SQLiteRunStore(db);
  const plan = { project: { id: randomUUID(), name: '자원 시험', repositoryIdentity: 'synthetic:resource' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'pg', plannedChecks: ['check'], requiredChecks: ['check'] },
    createdAt: new Date().toISOString() };
  runs.registerPlan(plan);
  const runId = randomUUID();
  runs.admitRun({ projectId: plan.project.id, planId: plan.plan.id, runId, requestId: randomUUID(), requestHash: 'e'.repeat(64), createdAt: new Date().toISOString() });
  const id = randomUUID();
  const intent: ResourceRecord = { id, runId, kind: 'postgres-test', ownerTokenHash: 'f'.repeat(64), state: 'intent', cleanup: null,
    descriptor: { name: `cm-pg-${runId}-${id}`, image: `postgres:17-alpine@sha256:${'a'.repeat(64)}`, endpoint: 'unix:///var/run/docker.sock', daemonId: 'test-daemon' } };
  new ResourceStore(db).intent(intent);
  db.close(); db = connectStore(files.dbPath);
  const store = new ResourceStore(db);
  expect(store.list(runId)).toEqual([intent]);
  expect(() => store.intent(intent)).toThrow();
  expect(() => store.intent({ ...intent, id: randomUUID(), runId: randomUUID() })).toThrow();
  expect(() => store.update(id, ['intent'], { state: 'created', descriptor: { ...intent.descriptor, daemonId: 'another-daemon' }, cleanup: null })).toThrow();
  store.update(id, ['intent'], { ...intent, state: 'creating' });
  expect(() => store.update(id, ['creating'], { ...intent, state: 'intent' })).toThrow();
  expect(() => store.update(id, ['creating'], { ...intent, state: 'cleaned', cleanup: { verified: true, checkedAt: new Date().toISOString(), reason: '일시 부재' } })).toThrow();
  const created = store.update(id, ['creating'], { state: 'created', descriptor: { ...intent.descriptor, containerId: 'b'.repeat(64), hostPort: 40001 }, cleanup: null });
  expect(() => store.update(id, ['intent'], { ...created, state: 'ready' })).toThrow();
  expect(() => store.update(id, ['created'], { ...created, descriptor: { ...created.descriptor, containerId: 'c'.repeat(64) } })).toThrow();
  expect(() => store.update(id, ['created'], { ...created, state: 'cleaned' })).toThrow();
  store.update(id, ['created'], { ...created, state: 'cleaned', cleanup: { verified: true, checkedAt: new Date().toISOString(), reason: '합성 부재 확인' } });
  expect(() => store.update(id, ['cleaned'], { ...created, state: 'ready' })).toThrow();
  expect(JSON.stringify(store.get(id))).not.toContain('password');
});
