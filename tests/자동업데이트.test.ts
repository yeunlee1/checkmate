// 설치본 업데이트의 실행 보호와 중복 확인 및 실패 복구 경계를 검증한다.
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateController, updateFeed } from '../packages/desktop/src/main/업데이트.js';
import { acquireUpdateLock, assertInstallationAvailable, installationRoot, recoverExitedUpdateLock } from '../packages/engine/src/연결/업데이트잠금.js';

class FakeUpdater extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
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
  const native = new FakeUpdater(); const controller = new UpdateController(native, null);
  expect((await controller.check()).state).toBe('disabled'); await controller.apply();
  expect(native.setFeedURL).not.toHaveBeenCalled(); expect(native.checkForUpdates).not.toHaveBeenCalled(); expect(native.quitAndInstall).not.toHaveBeenCalled();
});
it('살아 있는 엔진이 있으면 다운로드도 시작하지 않고 잠금을 반환한다', async () => {
  const native = new FakeUpdater(); const release = vi.fn(async () => {});
  const { root } = await fixture(); const active = new UpdateController(native, root, async () => false, async () => release);
  expect((await active.check()).state).toBe('blocked'); expect(native.checkForUpdates).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});
it('다운로드는 한 번만 시작하고 준비 후에도 엔진이 생기면 적용을 미룬다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater(); let idle = true;
  const controller = new UpdateController(native, root, async () => idle);
  await Promise.all([controller.check(), controller.check()]);
  expect(native.setFeedURL).toHaveBeenCalledWith({ url: updateFeed }); expect(native.checkForUpdates).toHaveBeenCalledOnce();
  native.emit('update-available'); expect(controller.status().state).toBe('downloading');
  native.emit('update-downloaded', {}, '', '1.0.1'); await settle(controller, 'ready');
  expect(controller.status()).toMatchObject({ state: 'ready', downloaded: true, release: '1.0.1' });
  idle = false; expect((await controller.apply()).state).toBe('blocked'); expect(native.quitAndInstall).not.toHaveBeenCalled();
  idle = true; await controller.apply(); expect(native.quitAndInstall).toHaveBeenCalledOnce();
  await controller.apply(); expect(native.quitAndInstall).toHaveBeenCalledOnce();
});
it('현재 버전 및 네트워크 실패에서 잠금을 풀고 다시 확인할 수 있다', async () => {
  const { root, node } = await fixture(); const native = new FakeUpdater(); const controller = new UpdateController(native, root, async () => true);
  await controller.check(); await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
  native.emit('update-not-available'); await settle(controller, 'idle'); await expect(assertInstallationAvailable(node)).resolves.toBeUndefined();
  await controller.check(); native.emit('error', new Error('외부 URL과 비밀 오류')); await settle(controller, 'error');
  expect(controller.status()).toMatchObject({ state: 'error', reason: 'update-failed' });
  expect(JSON.stringify(controller.status())).not.toContain('비밀'); await expect(assertInstallationAvailable(node)).resolves.toBeUndefined();
  await controller.check(); expect(native.checkForUpdates).toHaveBeenCalledTimes(3); native.emit('update-not-available'); await settle(controller, 'idle');
});
it('프로세스를 관측하지 못하거나 잠금이 경합하면 설치를 시작하지 않는다', async () => {
  const { root } = await fixture(); const native = new FakeUpdater();
  const controller = new UpdateController(native, root, async () => { throw new Error('권한 부족'); });
  expect((await controller.check()).state).toBe('error'); expect(native.checkForUpdates).not.toHaveBeenCalled();
  const release = await acquireUpdateLock(root); expect((await controller.check()).state).toBe('error'); await release();
});
it('앱을 닫아도 다운로드 중 잠금을 먼저 해제하지 않는다', async () => {
  const { root, node } = await fixture(); const native = new FakeUpdater(); const controller = new UpdateController(native, root, async () => true);
  await controller.check(); await controller.close(); await expect(assertInstallationAvailable(node)).rejects.toMatchObject({ code: 'update-in-progress' });
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
