// 소유 표식으로 확인한 합성 SQLite 시험 폴더만 생성하고 정리한다.
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  if (process.env.CHECKMATE_TEST_LOCK_TRACE) await appendFile(process.env.CHECKMATE_TEST_LOCK_TRACE, JSON.stringify({ fixture: directory,
    processLockRoot: process.env.CHECKMATE_LOCK_DIR ?? null, isolatedLockRoots: ['공유잠금', '공통잠금', '복구공유잠금'].map(name => join(directory, name)) }) + '\n');

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

export async function writeConcurrentProject(directory: string, name: string, id = randomUUID()) {
  const projectRoot = join(directory, name);
  await mkdir(join(projectRoot, 'checkmate'), { recursive: true });
  await writeFile(join(projectRoot, '검사.mjs'), '// 합성 검사 한 개의 종료를 확인한다.\nprocess.exitCode = 0;\n');
  const source = {
    project: { schemaVersion: 1 as const, id, name: '동시사용 합성 프로젝트', repositoryIdentity: `synthetic:${id}`,
      commands: [{ id: 'node-check', title: '합성 검사', runtime: 'node' as const, entry: '검사.mjs', args: [], timeoutMs: 1000, env: { CHECKMATE_LOCK_DIR: join(directory, '공유잠금') }, writes: [] as string[], resultFormat: 'exit-code' as const }],
      profiles: [{ id: 'quick', title: '합성 검사', checkIds: ['check-1'] }] },
    requirements: [{ id: 'requirement-1', title: '종료 확인', description: '합성 Node 명령의 실제 종료를 확인한다.' }],
    checks: [{ id: 'check-1', title: '종료 검사', requirementId: 'requirement-1', commandId: 'node-check', required: true,
      kind: 'logic' as const, expected: '종료코드 0', codePaths: ['검사.mjs'] }],
  };
  for (const [filename, value] of [['프로젝트.json', source.project], ['요구사항.json', source.requirements], ['검사항목.json', source.checks]] as const)
    await writeFile(join(projectRoot, 'checkmate', filename), JSON.stringify(value));
  return { projectRoot, projectId: id, source };
}
