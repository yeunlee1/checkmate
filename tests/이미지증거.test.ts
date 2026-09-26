// 합성 PNG의 구간 읽기와 디자인 증거 입력 검증을 확인한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentServer } from '../packages/engine/src/연결/에이아이서버.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore, EvidenceStoreError } from '../packages/engine/src/저장/증거저장.js';
import { VisualEvidence, parseDesignEvidence } from '../packages/desktop/src/renderer/증거시각화.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function crc(bytes: Buffer): number {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) randomBytes(width * 4).copy(rows, row * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture() {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runsRoot = join(files.directory, 'runs');
  await mkdir(runsRoot, { recursive: true });
  const registration: PlanRegistration = {
    project: { id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'local-test' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] }, createdAt: new Date().toISOString(),
  };
  const runs = new SQLiteRunStore(db);
  runs.registerPlan(registration);
  const addRun = async () => {
    const runId = randomUUID();
    await mkdir(join(runsRoot, runId), { recursive: true });
    runs.admitRun({ projectId: registration.project.id, planId: registration.plan.id,
      requestId: randomUUID(), requestHash: 'e'.repeat(64), runId, createdAt: new Date().toISOString() });
    return { runId, root: join(runsRoot, runId) };
  };
  return { files, db, store: new EvidenceStore(db, runsRoot), addRun };
}

test('실제 PNG를 검증하며 32KiB 이하 구간으로 완전히 읽고 커서를 실행과 MIME에 묶는다', async () => {
  const { db, store, addRun } = await fixture();
  const first = await addRun();
  const { store: otherStore, addRun: otherAddRun } = await fixture();
  const second = await otherAddRun();
  const image = png(192, 128);
  const input = { id: randomUUID(), relativePath: '화면.png', sha256: hash(image), byteLength: image.length,
    mime: 'image/png' as const, sensitivity: 'public' as const };
  await writeFile(join(first.root, input.relativePath), image);
  await store.register(first.runId, input);
  const secondInput = { ...input, id: randomUUID() };
  await writeFile(join(second.root, input.relativePath), image);
  await otherStore.register(second.runId, secondInput);
  let cursor: string | null = null;
  const parts: Buffer[] = [];
  do {
    const page = await store.readImage(first.runId, input.id, cursor ? { cursor } : {});
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32 * 1024);
    expect(page).toMatchObject({ integrity: 'verified', mime: 'image/png', width: 192, height: 128,
      sha256: input.sha256 });
    parts.push(Buffer.from(page.base64, 'base64'));
    cursor = page.nextCursor;
    if (cursor) {
      await expect(otherStore.readImage(second.runId, secondInput.id, { cursor }))
        .rejects.toMatchObject({ code: 'invalid-input' });
    }
  } while (cursor);
  expect(Buffer.concat(parts)).toEqual(image);
  const imageCursor = (await store.readImage(first.runId, input.id)).nextCursor!;
  const anotherImage = { ...input, id: randomUUID(), relativePath: '다른화면.png' };
  await writeFile(join(first.root, anotherImage.relativePath), image);
  await store.register(first.runId, anotherImage);
  await expect(store.readImage(first.runId, anotherImage.id, { cursor: imageCursor }))
    .rejects.toMatchObject({ code: 'invalid-input' });
  const text = JSON.stringify({ hello: 'world'.repeat(100) });
  const textInput = { ...input, id: randomUUID(), relativePath: '결과.json', sha256: hash(text),
    byteLength: Buffer.byteLength(text), mime: 'application/json' as const };
  await writeFile(join(first.root, textInput.relativePath), text);
  await store.register(first.runId, textInput);
  await expect(store.readImage(first.runId, textInput.id)).rejects.toMatchObject({ code: 'evidence-restricted' });
  await expect(store.readText(first.runId, textInput.id, { cursor: imageCursor }))
    .rejects.toMatchObject({ code: 'invalid-input' });
  const textCursor = (await store.readText(first.runId, textInput.id, { limit: 512 })).nextCursor;
  if (textCursor) await expect(store.readImage(first.runId, input.id, { cursor: textCursor }))
    .rejects.toMatchObject({ code: 'invalid-input' });
  const jpegInput = { ...input, id: randomUUID(), relativePath: '화면.jpg', mime: 'image/jpeg' as const };
  await writeFile(join(first.root, jpegInput.relativePath), image);
  await store.register(first.runId, jpegInput);
  await expect(store.readImage(first.runId, jpegInput.id)).rejects.toMatchObject({ code: 'evidence-restricted' });
  const replacement = png(192, 128);
  await writeFile(join(first.root, input.relativePath), replacement);
  db.prepare('UPDATE evidence SET sha256 = ?, byte_length = ? WHERE id = ?')
    .run(hash(replacement), replacement.length, input.id);
  await expect(store.readImage(first.runId, input.id, { cursor: imageCursor }))
    .rejects.toMatchObject({ code: 'invalid-input' });
});

test('비공개, 변조, 링크, 과대 파일과 허위 PNG 헤더를 거절한다', async () => {
  const { files, store, addRun } = await fixture();
  const { runId, root } = await addRun();
  const original = png(2, 2);
  async function register(name: string, bytes: Buffer, sensitivity: 'public' | 'restricted' = 'public') {
    const input = { id: randomUUID(), relativePath: name, sha256: hash(bytes), byteLength: bytes.length,
      mime: 'image/png' as const, sensitivity };
    await writeFile(join(root, name), bytes);
    await store.register(runId, input);
    return input;
  }
  const restricted = await register('비공개.png', original, 'restricted');
  await expect(store.readImage(runId, restricted.id)).rejects.toMatchObject({ code: 'evidence-restricted' });
  const changed = await register('변조.png', original);
  await writeFile(join(root, changed.relativePath), Buffer.from(original.map((byte, index) => index === 40 ? byte ^ 1 : byte)));
  await expect(store.readImage(runId, changed.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
  const linked = await register('링크원본.png', original);
  await rm(join(root, linked.relativePath));
  let linkChecked = false;
  try {
    await symlink(join(root, '비공개.png'), join(root, linked.relativePath));
    await expect(store.readImage(runId, linked.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
    linkChecked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  if (!linkChecked && process.platform === 'win32') {
    const nested = join(root, '하위');
    await mkdir(nested);
    const nestedInput = { ...linked, id: randomUUID(), relativePath: '하위/화면.png' };
    await writeFile(join(nested, '화면.png'), original);
    await store.register(runId, nestedInput);
    await rm(nested, { recursive: true });
    const outside = join(files.directory, '외부');
    await mkdir(outside);
    await writeFile(join(outside, '화면.png'), original);
    await symlink(outside, nested, 'junction');
    await expect(store.readImage(runId, nestedInput.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
    linkChecked = true;
  }
  expect(linkChecked).toBe(true);
  const badMagic = Buffer.from(original); badMagic[0] = 0;
  const badMagicInput = await register('마법값.png', badMagic);
  await expect(store.readImage(runId, badMagicInput.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
  const fakeSize = Buffer.from(original); fakeSize.writeUInt32BE(9000, 16);
  fakeSize.writeUInt32BE(crc(fakeSize.subarray(12, 29)), 29);
  const fakeSizeInput = await register('허위크기.png', fakeSize);
  await expect(store.readImage(runId, fakeSizeInput.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
  const fakePixels = Buffer.from(original); fakePixels.writeUInt32BE(4097, 16); fakePixels.writeUInt32BE(4097, 20);
  fakePixels.writeUInt32BE(crc(fakePixels.subarray(12, 29)), 29);
  const fakePixelsInput = await register('허위픽셀.png', fakePixels);
  await expect(store.readImage(runId, fakePixelsInput.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
  const badCrc = Buffer.from(original); badCrc[29] = badCrc[29]! ^ 1;
  const badCrcInput = await register('헤더검증.png', badCrc);
  await expect(store.readImage(runId, badCrcInput.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
  const large = Buffer.alloc(8 * 1024 * 1024 + 1);
  original.copy(large);
  const largeInput = await register('과대.png', large);
  await expect(store.readImage(runId, largeInput.id)).rejects.toMatchObject({ code: 'evidence-degraded' });
});

test('디자인 JSON은 상태와 좌표 한도를 지키고 잘못된 입력을 거절한다', () => {
  const id = randomUUID();
  const valid = { kind: 'checkmate-design', schemaVersion: 1, screenshotEvidenceId: id,
    viewport: { width: 400, height: 300 }, status: 'failed', findings: [{ ruleId: 'outside',
      selector: '#decor', status: 'failed', expected: { count: 1, visible: true, fitViewport: true },
      observed: { count: 1, visible: true, styles: {}, overflowsViewport: true },
      boundingBox: { x: 380, y: 12, width: 50, height: 25 },
      viewport: { width: 400, height: 300 }, reason: '뷰포트 경계 초과' }] };
  expect(parseDesignEvidence(JSON.stringify(valid))).toMatchObject(valid);
  expect(parseDesignEvidence({ ...valid, findings: [{ ...valid.findings[0], boundingBox: { x: Infinity,
    y: 0, width: 1, height: 1 } }] })).toBeNull();
  expect(parseDesignEvidence({ ...valid, findings: Array(101).fill(valid.findings[0]) })).toBeNull();
  expect(parseDesignEvidence({ ...valid, viewport: { width: 9000, height: 300 } })).toBeNull();
  expect(parseDesignEvidence({ ...valid, findings: [{ ...valid.findings[0], selector: '<script>'.repeat(100) }] })).toBeNull();
});

test('선택한 실패만 표시하고 텍스트를 escape하며 캡처 크기 불일치를 거절한다', () => {
  const id = randomUUID();
  const image = `data:image/png;base64,${png(2, 2).toString('base64')}`;
  const report = { kind: 'checkmate-design', schemaVersion: 1, screenshotEvidenceId: id,
    viewport: { width: 2, height: 2 }, status: 'failed', findings: [{ ruleId: '위반',
      selector: '<script>alert(1)</script>', status: 'failed', expected: { count: 1 },
      observed: { count: 1, visible: true, styles: {}, overflowsViewport: false },
      boundingBox: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 2, height: 2 }, reason: null }] };
  const html = renderToStaticMarkup(createElement(VisualEvidence, {
    imageDataUrl: image, imageWidth: 2, imageHeight: 2, screenshotEvidenceId: id, designEvidence: report,
  }));
  expect(html).toContain('visual-evidence__box');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('aria-pressed="true"');
  const mismatch = renderToStaticMarkup(createElement(VisualEvidence, {
    imageDataUrl: image, imageWidth: 2, imageHeight: 3, screenshotEvidenceId: id, designEvidence: report,
  }));
  expect(mismatch).toContain('일반 텍스트 증거 조회');
  expect(mismatch).not.toContain('<img');
  const wrongId = renderToStaticMarkup(createElement(VisualEvidence, {
    imageDataUrl: image, imageWidth: 2, imageHeight: 2, screenshotEvidenceId: randomUUID(), designEvidence: report,
  }));
  expect(wrongId).not.toContain('<img');
  const arbitraryUrl = renderToStaticMarkup(createElement(VisualEvidence, {
    imageDataUrl: 'https://example.test/image.png', imageWidth: 2, imageHeight: 2, screenshotEvidenceId: id,
  }));
  expect(arbitraryUrl).not.toContain('<img');
});

test('저장 루트의 링크는 거절하고 Windows 짧은 경로는 실제 경로로 연다', async () => {
  const { files, db } = await fixture();
  const runsRoot = join(files.directory, 'runs');
  await mkdir(join(runsRoot, 'nested'));
  const link = join(files.directory, '링크');
  await symlink(runsRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => new EvidenceStore(db, join(link, 'nested'))).toThrowError(EvidenceStoreError);
  if (process.platform === 'win32') {
    const short = execFileSync('cmd.exe', ['/d', '/u', '/c',
      'for %I in (%CHECKMATE_TEST_ROOT%) do @echo %~sI'],
    { env: { ...process.env, CHECKMATE_TEST_ROOT: runsRoot }, encoding: 'utf16le', windowsHide: true }).trim();
    expect(new EvidenceStore(db, short).list(randomUUID())).toEqual([]);
  }
});

test('AI 공개 도구는 검증된 PNG를 구간으로 제공하며 제한 증거와 변조를 계속 차단한다', async () => {
  const { db, store, addRun } = await fixture();
  const run = await addRun();
  const bytes = png(192, 128);
  const publicEvidence = { id: randomUUID(), relativePath: '공개.png', sha256: hash(bytes), byteLength: bytes.length,
    mime: 'image/png' as const, sensitivity: 'public' as const };
  await writeFile(join(run.root, publicEvidence.relativePath), bytes);
  await store.register(run.runId, publicEvidence);
  const restricted = { ...publicEvidence, id: randomUUID(), relativePath: '제한.png', sensitivity: 'restricted' as const };
  await writeFile(join(run.root, restricted.relativePath), bytes);
  await store.register(run.runId, restricted);
  const product = new ProductService(db, store, async () => { throw new Error('이미지 조회는 실행기를 사용하지 않습니다.'); });
  const server = createAgentServer(request => product.handle(request, 'agent'));
  const client = new Client({ name: 'public-image-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const parts: Buffer[] = [];
    let cursor: string | null = null;
    do {
      const response = await client.callTool({ name: 'get_evidence_image', arguments: {
        runId: run.runId, evidenceId: publicEvidence.id, ...(cursor ? { cursor } : {}),
      } });
      expect(response.isError).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(32768);
      const parsed = JSON.parse((response.content as { text: string }[])[0]!.text);
      expect(parsed).toMatchObject({ ok: true, data: { integrity: 'verified', mime: 'image/png', sha256: hash(bytes), width: 192, height: 128 } });
      parts.push(Buffer.from(parsed.data.base64, 'base64'));
      cursor = parsed.data.nextCursor;
    } while (cursor);
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.concat(parts)).toEqual(bytes);
    const denied = await client.callTool({ name: 'get_evidence_image', arguments: { runId: run.runId, evidenceId: restricted.id } });
    expect(denied.isError).toBe(true);
    expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false, error: { code: 'evidence-restricted' } });
    await writeFile(join(run.root, publicEvidence.relativePath), Buffer.alloc(bytes.length));
    const tampered = await client.callTool({ name: 'get_evidence_image', arguments: { runId: run.runId, evidenceId: publicEvidence.id } });
    expect(tampered.isError).toBe(true);
    expect(JSON.parse((tampered.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false, error: { code: 'evidence-degraded' } });
    expect(await product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'approve', input: {} }, 'agent'))
      .toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  } finally {
    await client.close();
    await server.close();
  }
});
