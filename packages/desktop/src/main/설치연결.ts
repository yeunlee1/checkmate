// Squirrel 설치 이벤트와 사용자 전용 CLI 진입점의 안전한 생성을 관리한다.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const launcherMark = '@rem CheckMate managed launcher v1\r\n';
const dataMark = JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' });

export function squirrelAction(argument: string | undefined): '--createShortcut' | '--removeShortcut' | 'obsolete' | null {
  if (argument === '--squirrel-install' || argument === '--squirrel-updated') return '--createShortcut';
  if (argument === '--squirrel-uninstall') return '--removeShortcut';
  if (argument === '--squirrel-obsolete') return 'obsolete';
  return null;
}

export function handleSquirrelEvent(argument: string | undefined, executable = process.execPath): boolean {
  if (process.platform !== 'win32') return false;
  const action = squirrelAction(argument);
  if (!action) return false;
  if (action === 'obsolete') return true;
  const update = resolve(dirname(executable), '..', 'Update.exe');
  const result = spawnSync(update, [action, basename(executable)], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 12000 });
  if (result.error || result.status !== 0) throw new Error(`Squirrel 바로 가기 작업 실패. ${result.error?.message || result.stderr?.trim() || `종료 코드 ${result.status}`}`);
  return true;
}

function checkedPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) === parse(path).root || /[\r\n%!"^&|<>]/u.test(path))
    throw new Error('CLI 진입점 경로에 cmd 확장 문자 또는 안전하지 않은 문자가 있습니다.');
  return resolve(path);
}

export function launcherText(dataRoot: string, nodeExecutable: string, cliEntry: string): string {
  const root = checkedPath(dataRoot);
  const node = checkedPath(nodeExecutable);
  const cli = checkedPath(cliEntry);
  return `@echo off\r\n${launcherMark}setlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "CHECKMATE_CODEPAGE=%%C"\r\nchcp 65001 >nul\r\n"${node}" "${cli}" --data-dir "${root}" %*\r\nset "CHECKMATE_EXIT=%ERRORLEVEL%"\r\nchcp %CHECKMATE_CODEPAGE% >nul\r\nexit /b %CHECKMATE_EXIT%\r\n`;
}

async function assertNoLinks(path: string): Promise<void> {
  let cursor = resolve(path);
  while (cursor !== dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('CLI 진입점에 링크 경로를 사용할 수 없습니다.'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    cursor = dirname(cursor);
  }
}

async function makePrivate(path: string, file: boolean): Promise<void> {
  if (process.platform !== 'win32') return;
  const { execFileSync } = await import('node:child_process');
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  const kind = file ? 'File' : 'Directory';
  const inheritance = file ? 'None' : 'ContainerInherit,ObjectInherit';
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$identity.User; $acl=[IO.${kind}]::GetAccessControl($target); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]); if (-not $owner.Equals($sid)) { if (-not $owner.Equals($identity.Owner)) { throw 'owner-mismatch' }; $acl.SetOwner($sid) }; $acl.SetAccessRuleProtection($true,$false); foreach ($old in @($acl.Access)) { $acl.RemoveAccessRuleAll($old) }; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','${inheritance}','None','Allow'); $acl.AddAccessRule($rule); [IO.${kind}]::SetAccessControl($target,$acl)`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
}

export async function hasOwnedDataRoot(root: string): Promise<boolean> {
  const path = checkedPath(root);
  await assertNoLinks(path);
  const marker = join(path, '체크메이트자료.json');
  await assertNoLinks(marker);
  try { return (await lstat(path)).isDirectory() && (await lstat(marker)).isFile() && (await lstat(marker)).nlink === 1 && await readFile(marker, 'utf8') === dataMark; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

export async function ensureLauncher(dataRoot: string, nodeExecutable: string, cliEntry: string): Promise<string> {
  const root = checkedPath(dataRoot);
  const contents = launcherText(root, nodeExecutable, cliEntry);
  if (!(await hasOwnedDataRoot(root))) throw new Error('소유 표시가 없는 자료 폴더에는 CLI 진입점을 만들 수 없습니다.');
  await makePrivate(root, false);
  await makePrivate(join(root, '체크메이트자료.json'), true);
  const bin = join(root, 'bin');
  await assertNoLinks(bin);
  await mkdir(bin, { mode: 0o700 }).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; });
  if (!(await lstat(bin)).isDirectory()) throw new Error('CLI 진입점 폴더가 직접 경로가 아닙니다.');
  const canonicalBin = await realpath(bin);
  const target = join(canonicalBin, 'checkmate.cmd');
  await makePrivate(bin, false);
  await assertNoLinks(target);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || !(await readFile(target, 'utf8')).startsWith(`@echo off\r\n${launcherMark}`))
      throw new Error('기존 CLI 진입점은 CheckMate가 만든 파일이 아닙니다.');
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const temporary = join(canonicalBin, `.checkmate-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await makePrivate(temporary, true);
    await assertNoLinks(target);
    await rename(temporary, target);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return target;
}
