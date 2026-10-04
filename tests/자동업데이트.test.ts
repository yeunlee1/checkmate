// 설치본 업데이트의 실행 보호와 중복 확인 및 실패 복구 경계를 검증한다.
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { UpdateController, updateFeed, installationIdle } from '../packages/desktop/src/main/업데이트.js';
import { readUpdateMetadata } from '../packages/desktop/src/main/업데이트메타.js';
import { acquireUpdateLock, assertInstallationAvailable, installationRoot, recoverExitedUpdateLock } from '../packages/engine/src/연결/업데이트잠금.js';

class FakeUpdater extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}
const observation = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: observation }) };
});
const folders: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); observation.mockReset(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const metadata = (version = '1.0.1') => `${'a'.repeat(40)} CheckMate-${version}-full.nupkg 1234\n`;
const readMetadata = async () => metadata();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '체크메이트 업데이트 ')); folders.push(root);
  await writeFile(join(root, 'Update.exe'), '합성');
  const node = join(root, 'app-1.0.0/resources/node/node.exe');
  await mkdir(join(root, 'app-1.0.0/resources/node'), { recursive: true });
  await writeFile(node, '합성');
  return { root, node };
}
const settle = (controller: UpdateController, state: string) => vi.waitFor(() => expect(controller.status().state).toBe(state));

it('개발 실행은 외부 업데이트를 시작하지 않는다', async () => {
  const native = new FakeUpdater(); const read = vi.fn(readMetadata); const controller = new UpdateController(native, null, '1.0.0', read);
  expect((await controller.check()).state).toBe('disabled'); await controller.download(); await controller.apply(); expect(read).not.toHaveBeenCalled();
  expect(native.setFeedURL).not.toHaveBeenCalled(); expect(native.checkForUpdates).not.toHaveBeenCalled(); expect(native.quitAndInstall).not.toHaveBeenCalled();
});
it('살아 있는 엔진이 있으면 다운로드도 시작하지 않고 잠금을 반환한다', async () => {
  const native = new FakeUpdater(); const release = vi.fn(async () => {});
  const { root } = await fixture(); const active = new UpdateController(native, root, '1.0.0', readMetadata, async () => false, async () => release);
  expect((await active.download()).state).toBe('blocked'); expect(native.checkForUpdates).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});
it('다운로드는 한 번만 시작하고 준비 후에도 엔진이 생기면 적용을 미룬다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater(); let idle = true;
  const controller = new UpdateController(native, root, '1.0.0', readMetadata, async () => idle);
  await Promise.all([controller.download(), controller.download()]);
  expect(native.setFeedURL).toHaveBeenCalledWith({ url: updateFeed }); expect(native.checkForUpdates).toHaveBeenCalledOnce();
  native.emit('update-available'); expect(controller.status().state).toBe('downloading');
  native.emit('update-downloaded', {}, '', '1.0.1'); await settle(controller, 'ready');
  expect(controller.status()).toMatchObject({ state: 'ready', downloaded: true, release: '1.0.1' });
  idle = false; expect((await controller.apply()).state).toBe('blocked'); expect(native.quitAndInstall).not.toHaveBeenCalled();
  idle = true; await controller.apply(); expect(native.quitAndInstall).toHaveBeenCalledOnce();
  await controller.apply(); expect(native.quitAndInstall).toHaveBeenCalledOnce();
});
it('현재 버전 및 네트워크 실패에서 잠금을 풀고 다시 확인할 수 있다', async () => {
  const { root, node } = await fixture(); const native = new FakeUpdater(); const controller = new UpdateController(native, root, '1.0.0', readMetadata, async () => true);
  await controller.download(); await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
  native.emit('update-not-available'); await settle(controller, 'idle'); await expect(assertInstallationAvailable(node)).resolves.toBeUndefined();
  await controller.download(); native.emit('error', new Error('외부 URL과 비밀 오류')); await settle(controller, 'error');
  expect(controller.status()).toMatchObject({ state: 'error', reason: 'update-failed' });
  expect(JSON.stringify(controller.status())).not.toContain('비밀'); await expect(assertInstallationAvailable(node)).resolves.toBeUndefined();
  await controller.download(); expect(native.checkForUpdates).toHaveBeenCalledTimes(3); native.emit('update-not-available'); await settle(controller, 'idle');
});
it('프로세스를 관측하지 못하거나 잠금이 경합하면 설치를 시작하지 않는다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater();
  const controller = new UpdateController(native, root, '1.0.0', readMetadata, async () => { throw new Error('권한 부족'); });
  expect((await controller.download()).state).toBe('error'); expect(native.checkForUpdates).not.toHaveBeenCalled();
  const release = await acquireUpdateLock(root); expect((await controller.download()).state).toBe('error'); await release();
});
it('앱을 닫아도 다운로드 중 잠금을 먼저 해제하지 않는다', async () => {
  const { root, node } = await fixture(); const native = new FakeUpdater(); const controller = new UpdateController(native, root, '1.0.0', readMetadata, async () => true);
  await controller.download(); await controller.close(); await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
  native.emit('error', new Error('중단')); await settle(controller, 'error');
});
it('설치 루트와 번들 Node를 식별하고 살아 있는 소유 잠금은 회수하지 않는다', async () => {
  const { root, node } = await fixture(); expect(await installationRoot(node)).toBe(root);
  expect(await installationRoot(join(root, 'app-1.0.0/CheckMate.exe'))).toBe(root);
  expect(await installationRoot(process.execPath)).toBeNull();
  const release = await acquireUpdateLock(root); await recoverExitedUpdateLock(root, async () => true);
  await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' }); await release();
});
it('종료한 앱의 잠금도 설치 프로세스 부재 확인 뒤에만 회수한다', async () => {
  const { root, node } = await fixture(); await acquireUpdateLock(root);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }); });
  await recoverExitedUpdateLock(root, async () => false); await expect(assertInstallationAvailable(node)).rejects.toThrow();
  await recoverExitedUpdateLock(root, async () => true); await expect(assertInstallationAvailable(node)).resolves.toBeUndefined();
});
it('다른 소유자로 바뀌거나 손상된 잠금은 지우지 않는다', async () => {
  const { root, node } = await fixture(); const release = await acquireUpdateLock(root);
  await writeFile(join(root, '업데이트잠금.json'), '{broken');
  await expect(release()).rejects.toMatchObject({ code: 'update-lock-unknown' });
  await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-lock-unknown' });
  expect(await readFile(join(root, '업데이트잠금.json'), 'utf8')).toBe('{broken');
});

it('AI 연결과 기존 잠금 중에도 확인은 메타만 읽고 다운로드 표시와 보호 표식을 바꾸지 않는다', async () => {
  const { root, node } = await fixture(); const release = await acquireUpdateLock(root);
  const marker = await readFile(join(root, '업데이트잠금.json'), 'utf8');
  const native = new FakeUpdater(); const idle = vi.fn(async () => false); const lock = vi.fn(async () => release);
  const read = vi.fn(readMetadata); const controller = new UpdateController(native, root, '1.0.0', read, idle, lock);
  const recover = vi.spyOn(controller, 'recover');
  expect(await controller.check()).toMatchObject({ state: 'available', reason: 'update-available', availableVersion: '1.0.1', release: null, downloaded: false });
  expect(read).toHaveBeenCalledOnce(); expect(idle).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  expect(native.setFeedURL).not.toHaveBeenCalled(); expect(native.checkForUpdates).not.toHaveBeenCalled(); expect(native.quitAndInstall).not.toHaveBeenCalled();
  await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
  expect(await readFile(join(root, '업데이트잠금.json'), 'utf8')).toBe(marker); await release();
});
it('손상 표식도 확인에서 회수하지 않고 다운로드에서는 거부한다', async () => {
  const { root } = await fixture(); await writeFile(join(root, '업데이트잠금.json'), '{broken');
  const native = new FakeUpdater(); const idle = vi.fn(async () => true);
  const controller = new UpdateController(native, root, '1.0.0', readMetadata, idle);
  expect((await controller.check()).state).toBe('available'); expect(idle).not.toHaveBeenCalled();
  expect((await controller.download()).state).toBe('error'); expect(native.checkForUpdates).not.toHaveBeenCalled();
  expect(await readFile(join(root, '업데이트잠금.json'), 'utf8')).toBe('{broken');
});
it('동시 확인은 한 조회만 시작하고 조회 중 다운로드와 적용도 시작하지 않는다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater(); let resolve!: (source: string) => void;
  const read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const controller = new UpdateController(native, root, '1.0.0', read);
  const first = controller.check(); expect((await controller.check()).state).toBe('checking');
  await controller.download(); await controller.apply();
  expect(read).toHaveBeenCalledOnce(); expect(native.checkForUpdates).not.toHaveBeenCalled();
  native.emit('update-downloaded', {}, '', '9.0.0'); native.emit('update-not-available'); native.emit('error', new Error('무관한 이벤트'));
  expect(controller.status()).toMatchObject({ state: 'checking', downloaded: false, release: null });
  resolve(metadata()); expect((await first).state).toBe('available');
});
it.each([
  ['0.2.9', '0.2.10', 'available'], ['0.2.10', '0.2.9', 'idle'], ['1.0.0', '1.0.0', 'idle'],
  ['1.9.9', '2.0.0', 'available'], ['2.0.0', '1.99.99', 'idle'],
])('버전 %s와 공개 버전 %s를 숫자로 비교하여 %s로 끝낸다', async (current, available, state) => {
  const { root } = await fixture(); const native = new FakeUpdater();
  const controller = new UpdateController(native, root, current, async () => metadata(available));
  expect(await controller.check()).toMatchObject({ state, availableVersion: available, release: null, downloaded: false });
  expect(native.checkForUpdates).not.toHaveBeenCalled();
});
it.each([
  '', ' ', metadata() + metadata(), metadata() + '\n', metadata().replace('a'.repeat(40), 'z'.repeat(40)),
  metadata().replace('a'.repeat(40), 'a'.repeat(39)), metadata().replace('1234', '0'), metadata().replace('1234', '-1'),
  metadata().replace('1234', '9007199254740992'), metadata().replace('1234', '1e3'), metadata().replace('1234', '01234'),
  metadata().replace('CheckMate-', '../CheckMate-'), metadata().replace('CheckMate-', 'Other-'), metadata().replace('-full', '-delta'),
  metadata('1.0.1-beta'), metadata('1.0.1+build'), metadata('01.0.1'), metadata('1.0'), metadata('9007199254740992.0.1'),
  '\ufeff' + metadata(), metadata().replace(' ', '\n'),
])('잘못된 RELEASES 원문을 최신 버전이나 다운로드 완료로 표시하지 않는다 %j', async source => {
  const { root } = await fixture(); const native = new FakeUpdater();
  const controller = new UpdateController(native, root, '1.0.0', async () => source);
  expect(await controller.check()).toMatchObject({ state: 'error', reason: 'check-unavailable', availableVersion: null, downloaded: false });
  expect(native.checkForUpdates).not.toHaveBeenCalled();
});
it('조회 실패는 이전 버전을 지우고 오류를 숨김 없이 표시하며 다시 조회할 수 있다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater();
  const read = vi.fn().mockResolvedValueOnce(metadata()).mockRejectedValueOnce(new Error('비밀 URL')).mockResolvedValueOnce(metadata());
  const controller = new UpdateController(native, root, '1.0.0', read);
  await controller.check(); expect(await controller.check()).toMatchObject({ state: 'error', availableVersion: null, downloaded: false });
  expect(JSON.stringify(controller.status())).not.toContain('비밀'); expect((await controller.check()).state).toBe('available');
});
it('다운로드는 메타를 갱신하고 실제 내려받은 버전과의 차이를 보존한다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater();
  const read = vi.fn().mockResolvedValueOnce(metadata('1.0.1')).mockResolvedValueOnce(metadata('1.0.2'));
  const controller = new UpdateController(native, root, '1.0.0', read, async () => true);
  await controller.check(); expect(controller.status().downloaded).toBe(false); await controller.download();
  expect(read).toHaveBeenCalledTimes(2); expect(controller.status().availableVersion).toBe('1.0.2');
  native.emit('update-downloaded', {}, '', '1.0.3'); await settle(controller, 'ready');
  expect(controller.status()).toMatchObject({ reason: 'downloaded-version-changed', availableVersion: '1.0.2', release: '1.0.3', downloaded: true });
});
it('다운로드 시 메타 실패나 최신 버전이면 보호 및 네이티브 다운로드를 시작하지 않는다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater(); const idle = vi.fn(async () => true); const lock = vi.fn(async () => async () => {});
  const read = vi.fn().mockResolvedValueOnce(metadata()).mockRejectedValueOnce(new Error('중단')).mockResolvedValueOnce(metadata('1.0.0'));
  const controller = new UpdateController(native, root, '1.0.0', read, idle, lock); const recover = vi.spyOn(controller, 'recover');
  await controller.check(); expect((await controller.download()).state).toBe('error'); expect((await controller.download()).state).toBe('idle');
  expect(idle).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(native.checkForUpdates).not.toHaveBeenCalled();
});
it('다운로드와 적용의 유휴 대기 중 중복 동작은 보호 잠금을 해제하지 않는다', async () => {
  const { root, node } = await fixture(); const native = new FakeUpdater(); let resolve!: (idle: boolean) => void;
  const idle = vi.fn(() => new Promise<boolean>(done => { resolve = done; })); const read = vi.fn(readMetadata);
  const controller = new UpdateController(native, root, '1.0.0', read, idle);
  const download = controller.download(); await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
  await controller.check(); await controller.download(); await controller.apply();
  expect(read).toHaveBeenCalledOnce(); expect(native.checkForUpdates).not.toHaveBeenCalled();
  await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
  resolve(true); await download; native.emit('update-downloaded', {}, '', '1.0.1'); await settle(controller, 'ready');
  const apply = controller.apply(); await vi.waitFor(() => expect(idle).toHaveBeenCalledTimes(2));
  await controller.check(); await controller.download(); await controller.apply();
  expect(native.quitAndInstall).not.toHaveBeenCalled(); await expect(assertInstallationAvailable(node)).rejects.toThrow();
  resolve(true); await apply; await controller.close(); expect(native.quitAndInstall).toHaveBeenCalledOnce();
  await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
});
it('다운로드 중 손상되거나 다른 소유자로 바뀐 잠금을 보존한다', async () => {
  const { root, node } = await fixture(); const native = new FakeUpdater();
  const controller = new UpdateController(native, root, '1.0.0', readMetadata, async () => true);
  await controller.download(); const file = join(root, '업데이트잠금.json'); const owner = JSON.parse(await readFile(file, 'utf8'));
  const changed = JSON.stringify({ ...owner, pid: process.pid + 1 }); await writeFile(file, changed);
  native.emit('error', new Error('중단')); await settle(controller, 'error'); expect(controller.status().reason).toBe('lock-unconfirmed');
  expect(await readFile(file, 'utf8')).toBe(changed); await expect(assertInstallationAvailable(node)).rejects.toThrow();
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(done => setImmediate(done));
function memoryFixture() {
  const native = new FakeUpdater(); const read = vi.fn(readMetadata); const idle = vi.fn(async () => true);
  const release = vi.fn(async () => {}); const lock = vi.fn(async (): Promise<() => Promise<void>> => release);
  const controller = new UpdateController(native, 'C:/합성설치', '1.0.0', read, idle, lock);
  const recover = vi.spyOn(controller, 'recover').mockResolvedValue(undefined);
  return { native, controller, read, idle, release, lock, recover };
}
it('close 완료 뒤 새 다운로드를 시작하지 않는다', async () => {
  const f = memoryFixture(); await f.controller.close(); await f.controller.download();
  expect(f.native.checkForUpdates).not.toHaveBeenCalled(); expect(f.native.setFeedURL).not.toHaveBeenCalled();
});
it('terminal 해제 대기 중 두 번째 완료는 ready와 적용을 먼저 열지 않는다', async () => {
  const f = memoryFixture(); const unlock = deferred<void>(); f.release.mockImplementation(() => unlock.promise);
  await f.controller.download(); f.native.emit('update-not-available'); f.native.emit('update-downloaded', {}, '', '1.0.1'); await tick();
  try {
    expect(f.controller.status()).toMatchObject({ state: 'downloading', downloaded: false, release: null });
    await f.controller.apply(); expect(f.lock).toHaveBeenCalledOnce(); expect(f.native.quitAndInstall).not.toHaveBeenCalled();
  } finally { unlock.reject(new Error('owner-unknown')); await tick(); }
});
it.each(['check', 'download', 'apply'] as const)('close 의도는 동기 기록되어 바로 뒤 %s 진입도 차단한다', async action => {
  const f = memoryFixture();
  if (action === 'apply') { await f.controller.download(); f.native.emit('update-downloaded', {}, '', '1.0.1'); await tick(); }
  const reads = f.read.mock.calls.length; const locks = f.lock.mock.calls.length; const nativeCalls = f.native.checkForUpdates.mock.calls.length;
  const closing = f.controller.close(); await f.controller[action](); await closing; await f.controller.close();
  expect(f.read).toHaveBeenCalledTimes(reads); expect(f.lock).toHaveBeenCalledTimes(locks);
  expect(f.native.checkForUpdates).toHaveBeenCalledTimes(nativeCalls); expect(f.native.quitAndInstall).not.toHaveBeenCalled();
});
it.each(['metadata', 'recover', 'lock', 'idle'] as const)('download의 %s 대기 중 close는 이후 native를 차단하고 자기 잠금만 한 번 반환한다', async phase => {
  const f = memoryFixture(); const gate = deferred<void>();
  if (phase === 'metadata') f.read.mockImplementation(async () => { await gate.promise; return metadata(); });
  if (phase === 'recover') f.recover.mockImplementation(() => gate.promise);
  if (phase === 'lock') f.lock.mockImplementation(async () => { await gate.promise; return f.release; });
  if (phase === 'idle') f.idle.mockImplementation(async () => { await gate.promise; return true; });
  const pending = f.controller.download(); await tick(); await f.controller.close(); await f.controller.close();
  expect(f.release).not.toHaveBeenCalled(); gate.resolve(); await pending;
  expect(f.native.setFeedURL).not.toHaveBeenCalled(); expect(f.native.checkForUpdates).not.toHaveBeenCalled();
  expect(f.native.quitAndInstall).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(['lock', 'idle'].includes(phase) ? 1 : 0);
  expect(f.controller.status()).toMatchObject({ state: 'blocked', reason: 'app-closing', downloaded: false });
  await f.controller.download(); await f.controller.apply(); expect(f.native.checkForUpdates).not.toHaveBeenCalled();
});
it('check 메타 대기 중 close는 늦은 조회를 준비 상태로 만들거나 잠금에 접근하지 않는다', async () => {
  const f = memoryFixture(); const gate = deferred<string>(); f.read.mockImplementation(() => gate.promise);
  const pending = f.controller.check(); await f.controller.close(); gate.resolve(metadata()); await pending;
  expect(f.controller.status()).toMatchObject({ state: 'blocked', reason: 'app-closing', availableVersion: null, downloaded: false });
  expect(f.lock).not.toHaveBeenCalled(); expect(f.recover).not.toHaveBeenCalled(); expect(f.idle).not.toHaveBeenCalled(); expect(f.native.checkForUpdates).not.toHaveBeenCalled();
});
it.each(['lock', 'idle'] as const)('apply의 %s 대기 중 close는 quitAndInstall을 막고 새 소유 잠금만 정리한다', async phase => {
  const f = memoryFixture(); await f.controller.download(); f.native.emit('update-downloaded', {}, '', '1.0.1'); await tick();
  f.release.mockClear(); const gate = deferred<void>();
  if (phase === 'lock') f.lock.mockImplementation(async () => { await gate.promise; return f.release; });
  else f.idle.mockImplementation(async () => { await gate.promise; return true; });
  const pending = f.controller.apply(); await tick(); await f.controller.close(); expect(f.release).not.toHaveBeenCalled();
  gate.resolve(); await pending; expect(f.release).toHaveBeenCalledOnce(); expect(f.native.quitAndInstall).not.toHaveBeenCalled();
  expect(f.controller.status()).toMatchObject({ state: 'blocked', reason: 'app-closing', downloaded: true });
});
it('native 전 close 정리도 해제 완료까지 다른 동작을 열지 않고 해제 실패를 보존한다', async () => {
  const f = memoryFixture(); const idle = deferred<boolean>(); const unlock = deferred<void>();
  f.idle.mockImplementation(() => idle.promise); f.release.mockImplementation(() => unlock.promise);
  const pending = f.controller.download(); await tick(); await f.controller.close(); idle.resolve(true); await tick();
  expect(f.release).toHaveBeenCalledOnce(); expect(f.controller.status().state).toBe('checking');
  await f.controller.check(); await f.controller.download(); await f.controller.apply(); await f.controller.close();
  expect(f.release).toHaveBeenCalledOnce(); expect(f.native.checkForUpdates).not.toHaveBeenCalled();
  unlock.reject(new Error('소유 불명확')); await pending;
  expect(f.controller.status()).toMatchObject({ state: 'error', reason: 'lock-unconfirmed' });
  f.native.emit('update-downloaded', {}, '', '1.0.1'); f.native.emit('error', new Error('늦은 오류')); await tick();
  expect(f.controller.status()).toMatchObject({ state: 'error', reason: 'lock-unconfirmed', downloaded: false });
});
it('실제 시작한 다운로드와 적용은 close만으로 보유 잠금을 반환하지 않는다', async () => {
  const download = memoryFixture(); await download.controller.download(); await download.controller.close();
  expect(download.release).not.toHaveBeenCalled(); expect(download.native.checkForUpdates).toHaveBeenCalledOnce();
  const apply = memoryFixture(); await apply.controller.download(); apply.native.emit('update-downloaded', {}, '', '1.0.1'); await tick(); apply.release.mockClear();
  await apply.controller.apply(); await apply.controller.close(); expect(apply.native.quitAndInstall).toHaveBeenCalledOnce(); expect(apply.release).not.toHaveBeenCalled();
});
it('feed 설정에서 동기 close가 들어와도 실제 다운로드 호출은 차단한다', async () => {
  const f = memoryFixture(); f.native.setFeedURL.mockImplementation(() => { void f.controller.close(); });
  await f.controller.download(); expect(f.native.setFeedURL).toHaveBeenCalledOnce(); expect(f.native.checkForUpdates).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
});
it.each([
  ['update-not-available', 'update-downloaded', 'idle', 'latest-version', false],
  ['error', 'update-downloaded', 'error', 'update-failed', false],
  ['update-downloaded', 'error', 'ready', 'restart-to-apply', true],
  ['update-downloaded', 'update-not-available', 'ready', 'restart-to-apply', true],
  ['update-downloaded', 'update-downloaded', 'ready', 'restart-to-apply', true],
  ['update-not-available', 'update-not-available', 'idle', 'latest-version', false],
  ['error', 'error', 'error', 'update-failed', false],
] as const)('terminal %s 뒤 %s가 와도 첫 결과와 단일 unlock만 유지한다', async (first, second, state, reason, downloaded) => {
  const f = memoryFixture(); const unlock = deferred<void>(); f.release.mockImplementation(() => unlock.promise);
  await f.controller.download(); f.native.emit(first, {}, '', '1.0.1'); f.native.emit(second, {}, '', '9.0.0'); await tick();
  expect(f.controller.status()).toMatchObject({ state: 'downloading', downloaded, release: downloaded ? '1.0.1' : null });
  expect(f.release).toHaveBeenCalledOnce(); await f.controller.apply(); await f.controller.download(); await f.controller.check();
  expect(f.lock).toHaveBeenCalledOnce(); expect(f.native.quitAndInstall).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce();
  unlock.resolve(); await tick(); expect(f.controller.status()).toMatchObject({ state, reason, downloaded, release: downloaded ? '1.0.1' : null });
  f.native.emit('update-downloaded', {}, '', '9.0.0'); f.native.emit('update-not-available'); f.native.emit('error', new Error('늦은 오류')); await tick();
  expect(f.controller.status()).toMatchObject({ state, reason, downloaded, release: downloaded ? '1.0.1' : null }); expect(f.release).toHaveBeenCalledOnce();
  if (downloaded) { await f.controller.apply(); expect(f.native.quitAndInstall).toHaveBeenCalledOnce(); }
});
it.each(['update-not-available', 'error', 'update-downloaded'])('첫 terminal %s의 unlock 실패는 늦은 이벤트와 재진입에도 바뀌지 않는다', async first => {
  const f = memoryFixture(); const unlock = deferred<void>(); f.release.mockImplementation(() => unlock.promise);
  await f.controller.download(); f.native.emit(first, {}, '', '1.0.1'); f.native.emit('update-downloaded', {}, '', '9.0.0'); await tick();
  unlock.reject(new Error('owner-unknown')); await tick(); const status = f.controller.status(); expect(status.reason).toBe('lock-unconfirmed');
  f.native.emit('update-downloaded', {}, '', '9.0.0'); f.native.emit('error', new Error('늦은 오류')); f.native.emit('update-not-available');
  await f.controller.check(); await f.controller.download(); await f.controller.apply(); await tick();
  expect(f.controller.status()).toEqual(status); expect(f.release).toHaveBeenCalledOnce(); expect(f.lock).toHaveBeenCalledOnce(); expect(f.native.quitAndInstall).not.toHaveBeenCalled();
});
it('동기 terminal 직후 native가 예외를 던져도 첫 종료를 두 번 처리하지 않는다', async () => {
  const f = memoryFixture(); f.native.checkForUpdates.mockImplementation(() => { f.native.emit('update-downloaded', {}, '', '1.0.1'); throw new Error('뒤늦은 예외'); });
  await f.controller.download(); expect(f.release).toHaveBeenCalledOnce(); expect(f.controller.status()).toMatchObject({ state: 'ready', downloaded: true, release: '1.0.1' });
});
it('동기 unlock 예외도 단일 종료와 소유 미확인 상태로 보존한다', async () => {
  const f = memoryFixture(); f.release.mockImplementation(() => { throw new Error('동기 소유 오류'); });
  await f.controller.download(); f.native.emit('update-downloaded', {}, '', '1.0.1'); f.native.emit('error', new Error('중복 오류')); await tick();
  expect(f.controller.status()).toMatchObject({ state: 'error', reason: 'lock-unconfirmed', downloaded: true, release: '1.0.1' });
  await f.controller.apply(); expect(f.lock).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(f.native.quitAndInstall).not.toHaveBeenCalled();
});
it.each([undefined, 1, 1234, 15000, 75000])('CIM 남은시간 %s는 기본15초 상한 안에서 실제 요청 옵션에 전달한다', async timeout => {
  vi.stubEnv('SystemRoot', 'C:/합성Windows'); observation.mockResolvedValue({ stdout: 'idle', stderr: '' });
  await expect(installationIdle('C:/합성설치', timeout)).resolves.toBe(true);
  expect(observation).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { windowsHide: true, shell: false, timeout: Math.min(timeout ?? 15000, 15000), maxBuffer: 65536 });
});
it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('CIM 잘못된 시간 %s는 시간제한 해제나 관측 성공으로 바꾸지 않는다', async timeout => {
  await expect(installationIdle('C:/합성설치', timeout)).rejects.toThrow('process-observation-unavailable'); expect(observation).not.toHaveBeenCalled();
});
it.each(['', 'unexpected', 'idle\nbusy'])('CIM 불명확한 출력 %j를 유휴로 판정하지 않는다', async stdout => {
  vi.stubEnv('SystemRoot', 'C:/합성Windows'); observation.mockResolvedValue({ stdout, stderr: '' });
  await expect(installationIdle('C:/합성설치', 3000)).rejects.toThrow('process-observation-unavailable');
});
it('CIM busy와 관측 오류 및 관측 경로 누락의 기존 보호를 유지한다', async () => {
  vi.stubEnv('SystemRoot', 'C:/합성Windows'); observation.mockResolvedValueOnce({ stdout: 'busy', stderr: '' });
  await expect(installationIdle('C:/합성설치', 3000)).resolves.toBe(false);
  observation.mockRejectedValueOnce(new Error('관측 시간 초과')); await expect(installationIdle('C:/합성설치', 3000)).rejects.toThrow();
  observation.mockClear(); vi.stubEnv('SystemRoot', undefined); await expect(installationIdle('C:/합성설치', 3000)).rejects.toThrow('process-observation-unavailable');
  expect(observation).not.toHaveBeenCalled();
});

class FakeMetadataRequest extends EventEmitter {
  end = vi.fn(); followRedirect = vi.fn();
  abort = vi.fn(() => { this.emit('abort'); this.emit('close'); });
}
function metadataRequest() {
  const request = new FakeMetadataRequest();
  const factory = vi.fn((_options: ClientRequestConstructorOptions) => request as unknown as ClientRequest);
  const result = readUpdateMetadata(factory);
  const respond = (chunks: Buffer[], statusCode = 200) => {
    const response = Object.assign(new EventEmitter(), { statusCode }); request.emit('response', response);
    for (const chunk of chunks) response.emit('data', chunk);
    response.emit('end'); return response;
  };
  return { request, factory, result, respond };
}
it('공식 RELEASES만 자격 없이 수동 리디렉션으로 요청하고 UTF8 원문을 돌려준다', async () => {
  const { request, factory, result, respond } = metadataRequest(); const source = metadata();
  expect(factory).toHaveBeenCalledWith({ url: `${updateFeed}/RELEASES`, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
  expect(request.end).toHaveBeenCalledOnce(); respond([Buffer.from(source)]); await expect(result).resolves.toBe(source);
  expect(request.abort).not.toHaveBeenCalled();
});
it('공식 GitHub와 asset HTTPS 리디렉션만 최대 다섯 번 동기적으로 따른다', async () => {
  const { request, result, respond } = metadataRequest();
  for (let index = 0; index < 5; index++) request.emit('redirect', 302, 'GET', index % 2 ? 'https://release-assets.githubusercontent.com/asset?signature=synthetic' : 'https://github.com/yeunlee1/checkmate/releases/download/v1.0.1/RELEASES');
  expect(request.followRedirect).toHaveBeenCalledTimes(5); respond([Buffer.from(metadata())]); await expect(result).resolves.toBe(metadata());
});
it.each([
  'http://github.com/RELEASES', 'https://github.com.evil.example/RELEASES', 'https://evil.example/RELEASES',
  'https://release-assets.githubusercontent.com.evil.example/RELEASES', 'https://user:secret@github.com/RELEASES',
  'https://github.com:444/RELEASES', 'file:///RELEASES', 'https://github.com/RELEASES#fragment', 'not-a-url',
])('허용 범위 밖 리디렉션을 따르지 않고 비밀 주소를 출력하지 않는다 %s', async destination => {
  const { request, result } = metadataRequest(); request.emit('redirect', 302, 'GET', destination);
  await expect(result).rejects.toThrow('update-metadata-unavailable'); expect(request.followRedirect).not.toHaveBeenCalled(); expect(request.abort).toHaveBeenCalledOnce();
});
it('여섯 번째 리디렉션과 GET 이외 메서드는 거부한다', async () => {
  const first = metadataRequest(); for (let index = 0; index < 6; index++) first.request.emit('redirect', 302, 'GET', 'https://github.com/RELEASES');
  await expect(first.result).rejects.toThrow(); expect(first.request.followRedirect).toHaveBeenCalledTimes(5);
  const second = metadataRequest(); second.request.emit('redirect', 307, 'POST', 'https://github.com/RELEASES');
  await expect(second.result).rejects.toThrow(); expect(second.request.followRedirect).not.toHaveBeenCalled();
});
it.each([204, 301, 401, 403, 404, 500])('HTTP %i 응답은 본문이 정상이어도 조회 실패다', async status => {
  const { result, respond } = metadataRequest(); respond([Buffer.from(metadata())], status); await expect(result).rejects.toThrow();
});
it('누적 실제 본문은 64KiB까지만 허용한다', async () => {
  const allowed = metadataRequest(); allowed.respond([Buffer.alloc(32768, 97), Buffer.alloc(32768, 97)]);
  await expect(allowed.result).resolves.toHaveLength(65536);
  const oversized = metadataRequest(); oversized.respond([Buffer.alloc(32768, 97), Buffer.alloc(32769, 97)]);
  await expect(oversized.result).rejects.toThrow(); expect(oversized.request.abort).toHaveBeenCalledOnce();
});
it('빈 본문과 손상 UTF8은 거부하며 청크 경계의 정상 UTF8은 보존한다', async () => {
  const empty = metadataRequest(); empty.respond([]); await expect(empty.result).rejects.toThrow();
  const broken = metadataRequest(); broken.respond([Buffer.from([0xc3, 0x28])]); await expect(broken.result).rejects.toThrow();
  const split = metadataRequest(); const data = Buffer.from('업데이트'); split.respond([data.subarray(0, 1), data.subarray(1)]);
  await expect(split.result).resolves.toBe('업데이트');
});
it('리디렉션을 거쳐도 전체 15초 제한을 연장하지 않는다', async () => {
  vi.useFakeTimers(); const { request, result } = metadataRequest(); const rejected = expect(result).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10000); request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/asset');
  await vi.advanceTimersByTimeAsync(4999); expect(request.abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await rejected; expect(request.abort).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['error', 'abort', 'close'])('요청 %s도 최신 버전으로 처리하지 않는다', async event => {
  const { request, result } = metadataRequest(); request.emit(event, new Error('비밀 주소')); await expect(result).rejects.toThrow('update-metadata-unavailable');
});
it.each(['error', 'aborted'])('응답 %s 뒤의 부분 본문은 성공하지 않는다', async event => {
  const { request, result } = metadataRequest(); const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  request.emit('response', response); response.emit('data', Buffer.from(metadata())); response.emit(event, new Error('응답 중단')); response.emit('end');
  await expect(result).rejects.toThrow();
});
it('요청 생성과 동기 리디렉션 실패도 제한 타이머를 정리한다', async () => {
  vi.useFakeTimers(); await expect(readUpdateMetadata(() => { throw new Error('요청 생성 실패'); })).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0); const { request, result } = metadataRequest();
  request.followRedirect.mockImplementation(() => { throw new Error('리디렉션 실패'); }); request.emit('redirect', 302, 'GET', 'https://github.com/RELEASES');
  await expect(result).rejects.toThrow(); expect(vi.getTimerCount()).toBe(0);
});
