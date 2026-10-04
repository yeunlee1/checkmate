// 같은 저장소의 두 workspace에서 카탈로그와 계획 및 승인을 독립 검증한다.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { ProjectStore } from '../packages/engine/src/저장/프로젝트저장.js';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createStoreFixture, writeConcurrentProject } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('명시 등록된 두 경로를 선택하고 한쪽 카탈로그 변경과 승인이 다른 쪽으로 번지지 않는다.', async () => {
  const f = await createStoreFixture(); cleanup.push(f.cleanup);
  const a = await writeConcurrentProject(f.directory, '작업A');
  const b = await writeConcurrentProject(f.directory, '작업B', a.projectId);
  b.source.checks[0]!.expected = '다른 기준';
  await writeFile(join(b.projectRoot, 'checkmate', '검사항목.json'), JSON.stringify(b.source.checks));
  const db = connectStore(f.dbPath); cleanup.push(async () => { db.close(); });
  const store = new ProjectStore(db);
  const snapshotA = await readProjectSource(a.projectRoot), snapshotB = await readProjectSource(b.projectRoot);
  const infoA = store.register(snapshotA), infoB = store.register(snapshotB);
  expect(store.list()).toHaveLength(2);
  expect(infoA.id).toBe(infoB.id);
  expect(infoA.activeCatalogHash).not.toBe(infoB.activeCatalogHash);
  expect(() => store.get(a.projectId)).toThrowError(expect.objectContaining({ code: 'workspace-required' }));
  const planA = store.inspect(snapshotA, 'quick'), planB = store.inspect(snapshotB, 'quick');
  store.approve(planA.planId, planA.fingerprint);
  expect(store.hasApproval(planA.planId)).toBe(true);
  expect(store.hasApproval(planB.planId)).toBe(false);
  b.source.checks[0]!.expected = '세 번째 기준';
  await writeFile(join(b.projectRoot, 'checkmate', '검사항목.json'), JSON.stringify(b.source.checks));
  const changed = await readProjectSource(b.projectRoot);
  store.sync(changed, true);
  expect(store.get(a.projectId, infoA.workspaceId).activeCatalogHash).toBe(snapshotA.contentHash);
  expect(store.hasApproval(planA.planId)).toBe(true);
  expect(store.hasApproval(planB.planId)).toBe(false);
  expect(store.inspect(changed, 'quick').needsApproval).toBe(true);
});
