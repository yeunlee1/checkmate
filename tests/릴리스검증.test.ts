// 릴리스 태그와 설치 산출물 변조 및 버전 역행의 게시 차단을 검증한다.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { UpdateController } from '../packages/desktop/src/main/업데이트.js';

const validator = await import(pathToFileURL(resolve('scripts/릴리스검증.mjs')).href);
const publisher = await import(pathToFileURL(resolve('scripts/릴리스게시.mjs')).href);
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
it('태그 배포는 명시적으로 무서명을 허용한 경우에만 서명 요구를 해제한다', () => {
  expect(validator.requiresSignature('tag', undefined)).toBe(true);
  expect(validator.requiresSignature('tag', 'false')).toBe(true);
  expect(validator.requiresSignature('tag', 'true')).toBe(false);
  expect(validator.requiresSignature('branch', undefined)).toBe(false);
});
it('무서명 게시 안내는 서명 검증을 주장하지 않고 설치 경고를 알린다', () => {
  const notes = publisher.releaseNotes('true');
  expect(notes).toContain('서명되지 않은');
  expect(notes).toContain('Windows');
  expect(notes).not.toContain('서명과 타임스탬프를 검증한');
  expect(publisher.releaseNotes(undefined)).toContain('서명과 타임스탬프를 검증한');
});
it('공개 설치본은 영문 파일명으로 올리되 바이트와 해시 목록을 보존한다', async () => {
  const folder = await mkdtemp(join(tmpdir(), '체크메이트 게시 ')); folders.push(folder);
  const installer = Buffer.from('합성 설치본');
  const hash = createHash('sha256').update(installer).digest('hex');
  await writeFile(join(folder, 'CheckMate-개발설치.exe'), installer);
  await writeFile(join(folder, 'SHA256SUMS.txt'), `${hash}  CheckMate-개발설치.exe\n`);
  await publisher.preparePublicInstaller(folder);
  expect(await readFile(join(folder, 'CheckMate-Setup.exe'))).toEqual(installer);
  expect(await readFile(join(folder, 'SHA256SUMS.txt'), 'utf8')).toBe(`${hash}  CheckMate-Setup.exe\n`);
  expect(await readdir(folder)).not.toContain('CheckMate-개발설치.exe');
});
it('워크스페이스 버전 불일치와 태그의 사전 배포·잘못된 버전을 거절한다', () => {
  expect(validator.releaseVersion([{ version: '1.2.3' }, { version: '1.2.3' }], 'v1.2.3')).toBe('1.2.3');
  expect(() => validator.releaseVersion([{ version: '1.2.3' }, { version: '1.2.4' }], 'v1.2.3')).toThrow();
  for (const tag of ['v1.2.3-beta.1', 'v1.2.4', 'v01.2.3', 'other']) expect(() => validator.releaseVersion([{ version: '1.2.3' }], tag)).toThrow();
});
it('Squirrel 목록은 선두 BOM만 제거하여 기존 앱의 엄격한 파서와 호환한다', async () => {
  const folder = await mkdtemp(join(tmpdir(), '체크메이트 목록 ')); folders.push(folder);
  const path = join(folder, 'RELEASES');
  // 공개 0.2.1 Squirrel 목록의 실제 내용과 선두 EF BB BF를 재현한다.
  const line = 'B128B210AAD3FF811103285C0FE92040431D9CB4 CheckMate-0.2.1-full.nupkg 214432483';
  const body = Buffer.from(line);
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  await validator.normalizeReleaseFeed(path);
  expect(await readFile(path)).toEqual(body);
  const legacyDecoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
  const updater = { on() {}, setFeedURL() { throw new Error('다운로드 금지'); }, checkForUpdates() { throw new Error('다운로드 금지'); }, quitAndInstall() { throw new Error('설치 금지'); } };
  const controller = new UpdateController(updater, folder, '0.2.0', async () => legacyDecoded);
  expect(await controller.check()).toMatchObject({ state: 'available', availableVersion: '0.2.1', downloaded: false });
  await validator.normalizeReleaseFeed(path);
  expect(await readFile(path)).toEqual(body);
  const unusual = Buffer.from(` ${line}\n\uFEFF`);
  await writeFile(path, unusual);
  await validator.normalizeReleaseFeed(path);
  expect(await readFile(path)).toEqual(unusual);
});
it('내부 패키지 의존성이 이전 버전에 남으면 제작 전에 거절한다', () => {
  expect(() => validator.releaseVersion([{ version: '0.1.0', dependencies: { '@checkmate/contracts': '0.1.0-alpha.1' } }])).toThrow('의존성');
  expect(validator.releaseVersion([{ version: '0.1.0', dependencies: { '@checkmate/contracts': '0.1.0', react: '19.3.0' } }])).toBe('0.1.0');
});
it('정식 배포의 같은 버전과 낮은 버전 및 사전 배포를 최신으로 지정하지 않는다', () => {
  expect(publisher.newerVersion('v1.2.3', null)).toBe(true);
  expect(publisher.newerVersion('v1.10.0', 'v1.9.9')).toBe(true);
  expect(publisher.newerVersion('v1.2.3', 'v1.2.3')).toBe(false);
  expect(publisher.newerVersion('v1.2.3', 'v2.0.0')).toBe(false);
  expect(() => publisher.newerVersion('v1.2.4-alpha.1', 'v1.2.3')).toThrow();
});
it('실제 바이트와 RELEASES 및 제작 지문이 맞아야 배포 목록을 만든다', async () => {
  const folder = await mkdtemp(join(tmpdir(), '체크메이트 릴리스 ')); folders.push(folder);
  const packageName = 'checkmate-1.2.3-full.nupkg'; const content = Buffer.from('합성 패키지');
  await writeFile(join(folder, packageName), content); await writeFile(join(folder, 'CheckMate-개발설치.exe'), '합성 설치본');
  await writeFile(join(folder, 'RELEASES'), `${createHash('sha1').update(content).digest('hex')} ${packageName} ${content.length}\n`);
  const artifacts = await Promise.all([packageName, 'CheckMate-개발설치.exe', 'RELEASES'].map(async file => ({ path: join(folder, file), sha256: createHash('sha256').update(await readFile(join(folder, file))).digest('hex') })));
  const report = { status: 'passed', version: '1.2.3', source: { commit: 'fixed', dirtyAtStart: false, dirtyAtEnd: false }, artifacts };
  expect((await validator.verifyArtifacts(report, { commit: 'fixed', version: '1.2.3' })).folder).toBe(folder);
  const feedPath = join(folder, 'RELEASES');
  const feed = await readFile(feedPath);
  await writeFile(feedPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), feed]));
  const bomArtifacts = await Promise.all(artifacts.map(async item => ({ ...item, sha256: createHash('sha256').update(await readFile(item.path)).digest('hex') })));
  await expect(validator.verifyArtifacts({ ...report, artifacts: bomArtifacts }, { commit: 'fixed', version: '1.2.3' })).rejects.toThrow('BOM');
  await validator.normalizeReleaseFeed(feedPath);
  expect((await validator.verifyArtifacts(report, { commit: 'fixed', version: '1.2.3' })).folder).toBe(folder);
  await expect(validator.verifyArtifacts(report, { commit: 'fixed', version: '1.2.3', requireSigned: true })).rejects.toThrow('서명');
  await expect(validator.verifyArtifacts({ ...report, source: { ...report.source, dirtyAtEnd: true } }, { commit: 'fixed', version: '1.2.3' })).rejects.toThrow();
  await writeFile(join(folder, packageName), '변조');
  await expect(validator.verifyArtifacts(report, { commit: 'fixed', version: '1.2.3' })).rejects.toThrow();
});
