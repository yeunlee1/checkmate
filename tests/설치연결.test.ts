// Squirrel 이벤트와 고정 CLI 진입점의 파일 경계를 검증한다.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ensureLauncher, hasOwnedDataRoot, launcherText, squirrelAction } from '../packages/desktop/src/main/설치연결.js';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'CheckMate 설치 시험 '));
  temporary.push(root);
  return root;
}

test('설치와 갱신은 바로 가기 생성, 제거는 삭제, 구버전은 종료만 선택한다', () => {
  expect(squirrelAction('--squirrel-install')).toBe('--createShortcut');
  expect(squirrelAction('--squirrel-updated')).toBe('--createShortcut');
  expect(squirrelAction('--squirrel-uninstall')).toBe('--removeShortcut');
  expect(squirrelAction('--squirrel-obsolete')).toBe('obsolete');
  expect(squirrelAction('--squirrel-firstrun')).toBeNull();
});

test('경로의 공백과 한글은 보존하고 cmd 확장 문자는 거절한다', () => {
  const root = join(tmpdir(), '자료 폴더');
  const node = join(tmpdir(), '설치 경로 (x86)', 'node.exe');
  const cli = join(tmpdir(), '명령 도구', '명령.js');
  expect(launcherText(root, node, cli)).toContain(`"${node}" "${cli}" --data-dir "${root}" %*`);
  expect(() => launcherText(root, join(tmpdir(), '값%PATH%', 'node.exe'), cli)).toThrow(/cmd/);
  expect(() => launcherText(join(tmpdir(), '자료&실행'), node, cli)).toThrow(/cmd/);
});

test('소유 표시가 없는 폴더와 다른 사용자의 명령 파일은 덮어쓰지 않는다', async () => {
  const base = await fixture();
  const root = join(base, '관리 자료');
  await mkdir(root);
  expect(await hasOwnedDataRoot(root)).toBe(false);
  await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow(/소유 표시/);
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  await mkdir(join(root, 'bin'));
  const other = join(root, 'bin', 'checkmate.cmd');
  await writeFile(other, '@echo off\r\necho 다른 파일\r\n');
  await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow(/CheckMate가 만든/);
  expect(await readFile(other, 'utf8')).toContain('다른 파일');
});

test('자체 명령 파일은 버전별 실행 경로로 원자적으로 갱신한다', async () => {
  const base = await fixture();
  const root = join(base, '관리 자료');
  await mkdir(root);
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  const first = join(base, '버전 첫째', '명령.js');
  const second = join(base, '버전 둘째', '명령.js');
  const target = await ensureLauncher(root, process.execPath, first);
  expect(await readFile(target, 'utf8')).toContain(first);
  expect(await ensureLauncher(root, process.execPath, second)).toBe(target);
  const updated = await readFile(target, 'utf8');
  expect(updated).toContain(second);
  expect(updated).not.toContain(first);
});

test('bin 링크가 외부 폴더를 가리키면 파일을 만들지 않는다', async () => {
  const base = await fixture();
  const root = join(base, '관리 자료');
  const outside = join(base, '외부 폴더');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  await symlink(outside, join(root, 'bin'), 'junction');
  await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow(/링크 경로/);
  await expect(readFile(join(outside, 'checkmate.cmd'))).rejects.toMatchObject({ code: 'ENOENT' });
});

const resources = process.env.CHECKMATE_PACKAGED_RESOURCES;
test.skipIf(!resources)('실제 포장 Node와 CLI를 공백과 한글 자료 경로에서 doctor로 호출한다', async () => {
  const base = await fixture();
  const root = join(base, '관리 (자료)', '새 합성 자료');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  const node = join(resources!, 'node', 'node.exe');
  const cli = join(resources!, 'engine', 'packages', 'engine', 'dist', '명령.js');
  const direct = spawnSync(node, [cli, '--data-dir', root, '--json', 'doctor'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(direct.status, JSON.stringify({ stderr: direct.stderr, stdout: direct.stdout, error: direct.error?.message })).toBe(0);
  const launcher = await ensureLauncher(root, node, cli);
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" --json doctor"`], { encoding: 'utf8', windowsHide: true, timeout: 15000, windowsVerbatimArguments: true });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as { ok: boolean; data: { node: string; supportedRuntime: boolean } };
  expect(report.ok).toBe(true);
  expect(report.data.node).toBe('24.18.0');
  expect(report.data.supportedRuntime).toBe(true);
});
