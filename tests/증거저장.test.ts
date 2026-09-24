// 합성 실행 DB와 실제 파일에서 증거 등록과 제한된 본문 조회를 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runsRoot = join(files.directory, 'runs');
  const runId = randomUUID();
  await mkdir(join(runsRoot, runId), { recursive: true });
  const registration: PlanRegistration = {
    project: { id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'local-test' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] }, createdAt: new Date().toISOString(),
  };
  const runs = new SQLiteRunStore(db);
  runs.registerPlan(registration);
  runs.admitRun({ projectId: registration.project.id, planId: registration.plan.id,
    requestId: randomUUID(), requestHash: 'e'.repeat(64), runId, createdAt: new Date().toISOString() });
  return { files, db, runId, root: join(runsRoot, runId), store: new EvidenceStore(db, runsRoot) };
}

test('ready 등록은 실제 파일과 실행을 확인하고 같은 내용만 멱등 처리한다', async () => {
  const { db, runId, root, store } = await fixture();
  const content = '한국어 증거';
  await writeFile(join(root, '결과.txt'), content);
  const input = { id: randomUUID(), relativePath: '결과.txt', sha256: hash(content),
    byteLength: Buffer.byteLength(content), mime: 'text/plain' as const, sensitivity: 'public' as const };
  expect(await store.register(runId, input)).toEqual({ ...input, runId, state: 'ready' });
  expect(await store.register(runId, input)).toEqual({ ...input, runId, state: 'ready' });
  expect(store.list(runId)).toHaveLength(1);
  expect(await store.inspect(runId, input.id)).toMatchObject({ integrity: 'verified', reason: null });
  expect(await store.readText(runId, input.id)).toEqual({ text: content, nextCursor: null, integrity: 'verified' });
  await expect(store.register(runId, { ...input, id: randomUUID() }))
    .rejects.toMatchObject({ code: 'evidence-conflict' });
  await expect(store.register(randomUUID(), input)).rejects.toMatchObject({ code: 'run-not-found' });
  expect((db.prepare('SELECT count(*) AS count FROM evidence').get() as { count: number }).count).toBe(1);
});

test('경로와 링크를 거절하고 등록 후 변조와 삭제를 손상으로 조회한다', async () => {
  const { files, runId, root, store } = await fixture();
  const content = '원본';
  await writeFile(join(root, '원본.txt'), content);
  const input = { id: randomUUID(), relativePath: '원본.txt', sha256: hash(content),
    byteLength: Buffer.byteLength(content), mime: 'text/plain' as const, sensitivity: 'public' as const };
  await expect(store.register(runId, { ...input, relativePath: '../원본.txt' }))
    .rejects.toMatchObject({ code: 'invalid-input' });
  let linkChecked = false;
  try {
    await symlink(join(root, '원본.txt'), join(root, '링크.txt'));
    await expect(store.register(runId, { ...input, relativePath: '링크.txt' }))
      .rejects.toMatchObject({ code: 'invalid-input' });
    linkChecked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  if (!linkChecked && process.platform === 'win32') {
    const outside = join(files.directory, '외부');
    await mkdir(outside);
    await writeFile(join(outside, '원본.txt'), content);
    await symlink(outside, join(root, '외부'), 'junction');
    await expect(store.register(runId, { ...input, relativePath: '외부/원본.txt' }))
      .rejects.toMatchObject({ code: 'invalid-input' });
  }
  await store.register(runId, input);
  await writeFile(join(root, '원본.txt'), '변조');
  expect(await store.inspect(runId, input.id)).toMatchObject({ integrity: 'degraded', reason: 'hash-mismatch' });
  await expect(store.readText(runId, input.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
  await rm(join(root, '원본.txt'));
  expect(await store.inspect(runId, input.id)).toMatchObject({ integrity: 'degraded', reason: 'missing' });
  await expect(store.readText(runId, input.id)).rejects.toMatchObject({ code: 'evidence-missing' });
});

test('restricted 본문과 다른 증거 cursor를 막고 UTF8 및 JSON escape 응답 상한을 지킨다', async () => {
  const { runId, root, store } = await fixture();
  const content = ('한글"\\\n'.repeat(500)) + '끝';
  const entries = [];
  for (const name of ['첫째.json', '둘째.json']) {
    await writeFile(join(root, name), content);
    const input = { id: randomUUID(), relativePath: name, sha256: hash(content), byteLength: Buffer.byteLength(content),
      mime: 'application/json' as const, sensitivity: 'public' as const };
    await store.register(runId, input);
    entries.push(input);
  }
  let cursor: string | null = null;
  let joined = '';
  do {
    const page = await store.readText(runId, entries[0]!.id, cursor ? { cursor, limit: 512 } : { limit: 512 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512);
    joined += page.text;
    cursor = page.nextCursor;
  } while (cursor);
  expect(joined).toBe(content);
  const page = await store.readText(runId, entries[0]!.id, { limit: 512 });
  await expect(store.readText(runId, entries[1]!.id, { cursor: page.nextCursor! }))
    .rejects.toMatchObject({ code: 'invalid-input' });
  await expect(store.readText(runId, entries[0]!.id, { limit: 32769 }))
    .rejects.toMatchObject({ code: 'invalid-input' });
  const restricted = { ...entries[0]!, id: randomUUID(), relativePath: '비공개.txt',
    mime: 'text/plain' as const, sensitivity: 'restricted' as const };
  await writeFile(join(root, restricted.relativePath), content);
  await store.register(runId, restricted);
  await expect(store.readText(runId, restricted.id)).rejects.toMatchObject({ code: 'evidence-restricted' });
  const bom = '\uFEFF' + '한글';
  await writeFile(join(root, 'BOM.txt'), bom);
  const bomInput = { id: randomUUID(), relativePath: 'BOM.txt', sha256: hash(bom),
    byteLength: Buffer.byteLength(bom), mime: 'text/plain' as const, sensitivity: 'public' as const };
  await store.register(runId, bomInput);
  expect((await store.readText(runId, bomInput.id)).text).toBe(bom);
});
