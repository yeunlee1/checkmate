// 같은 Windows 설치본의 엔진 시작과 업데이트가 겹치지 않게 소유 잠금을 관리한다.
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';

const ownerSchema = z.strictObject({ id: z.uuid(), pid: z.number().int().positive() });
const lockName = '업데이트잠금.json';
export async function installationRoot(executable = process.execPath): Promise<string | null> {
  const normalized = resolve(executable).replaceAll('\\', '/');
  const match = normalized.match(/^(.*)\/app-[^/]+\/(?:CheckMate\.exe|resources\/node\/node\.exe)$/i);
  if (!match) return null;
  const root = resolve(match[1]!);
  try { const stat = await lstat(join(root, 'Update.exe')); return stat.isFile() && !stat.isSymbolicLink() ? root : null; }
  catch (error) { if (isMissing(error)) return null; throw error; }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
async function readOwner(root: string) {
  const file = join(root, lockName);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512) throw new Error('invalid-lock');
    return ownerSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ServiceError('update-lock-unknown', '업데이트 소유 표식을 확인할 수 없습니다.');
  }
}
export async function assertInstallationAvailable(executable = process.execPath): Promise<void> {
  const root = await installationRoot(executable);
  if (root && await readOwner(root)) throw new ServiceError('update-in-progress', '설치본 업데이트 중에는 새 연결을 시작할 수 없습니다.', true, '업데이트가 끝난 뒤 다시 연결해 주세요. 실행 중인 검사는 그대로 유지됩니다.');
}
export async function acquireUpdateLock(root: string): Promise<() => Promise<void>> {
  const file = join(root, lockName);
  const owner = { id: randomUUID(), pid: process.pid };
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch { throw new ServiceError('update-in-progress', '다른 업데이트가 진행 중이거나 소유 확인이 필요합니다.'); }
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
  return async () => {
    const current = await readOwner(root);
    if (!current || current.id !== owner.id || current.pid !== owner.pid) throw new ServiceError('update-lock-unknown');
    await unlink(file);
  };
}
export async function recoverExitedUpdateLock(root: string, idle: () => Promise<boolean>): Promise<void> {
  const previous = await readOwner(root);
  if (!previous) return;
  try { process.kill(previous.pid, 0); return; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) return; }
  // 앱이 종료됐어도 Update.exe나 엔진이 남아 있으면 잠금을 제거하지 않는다.
  if (!await idle()) return;
  const current = await readOwner(root);
  if (current?.id !== previous.id || current.pid !== previous.pid) throw new ServiceError('update-lock-unknown');
  await unlink(join(root, lockName));
}
