// 소유 표식으로 확인한 합성 SQLite 시험 폴더만 생성하고 정리한다.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(workspace, '.runtime', '검증', 'sqlite');
const markerName = '소유표식.txt';

export async function createStoreFixture() {
  await mkdir(root, { recursive: true });
  const id = randomUUID();
  const token = randomUUID();
  const directory = join(root, id);
  await mkdir(directory);
  await writeFile(join(directory, markerName), token, { flag: 'wx' });

  return {
    directory,
    dbPath: join(directory, 'checkmate.sqlite'),
    async cleanup() {
      const actualRoot = await realpath(root);
      const actualWorkspace = await realpath(workspace);
      const actualDirectory = await realpath(directory);
      const marker = join(directory, markerName);
      const folder = await lstat(directory);
      const markerInfo = await lstat(marker);
      if (relative(actualWorkspace, actualRoot) !== join('.runtime', '검증', 'sqlite') ||
        resolve(directory) !== resolve(root, id) || dirname(actualDirectory) !== actualRoot ||
        !folder.isDirectory() || folder.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink() ||
        await readFile(marker, 'utf8') !== token) {
        throw new Error('시험 DB 폴더의 소유권을 확인할 수 없습니다.');
      }
      await rm(directory, { recursive: true });
    },
  };
}
