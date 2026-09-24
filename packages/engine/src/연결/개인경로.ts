// 사용자별 서비스 자료 경로와 비밀 파일의 접근 권한을 준비한다.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { ServiceError } from '@checkmate/contracts/api';

export type DataPaths = { root: string; state: string; runs: string; runtime: string; secret: string; endpoint: string };
export function dataPaths(root = process.env.CHECKMATE_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'CheckMate')): DataPaths {
  if (!isAbsolute(root) || resolve(root) === parse(root).root) throw new ServiceError('invalid-path', '전용 자료 폴더의 절대 경로가 필요합니다.');
  const resolved = resolve(root);
  const key = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 24);
  return { root: resolved, state: join(resolved, 'state'), runs: join(resolved, 'runs'), runtime: join(resolved, 'runtime'), secret: join(resolved, 'runtime', '연결비밀'),
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\CheckMate-${key}` : join(resolved, 'runtime', 'service.sock') };
}

export async function rejectLinks(path: string): Promise<void> {
  let cursor = resolve(path);
  while (cursor !== dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new ServiceError('unsafe-path', '링크 경로에는 서비스 자료를 저장할 수 없습니다.'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    cursor = dirname(cursor);
  }
}

async function makePrivate(path: string): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, 0o700); return; }
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($target,$acl)`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', timeout: 15000 }); }
  catch { throw new ServiceError('private-directory-failed', '사용자 전용 폴더 권한을 설정할 수 없습니다.'); }
}

export async function prepareDataPaths(paths: DataPaths): Promise<void> {
  await rejectLinks(paths.root);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const marker = join(paths.root, '체크메이트자료.json');
  await rejectLinks(marker);
  try {
    const existing = JSON.parse(await readFile(marker, 'utf8')) as unknown;
    if (JSON.stringify(existing) !== JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' })) throw new Error('marker');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new ServiceError('unrecognized-data-root', '체크메이트 자료 폴더의 표식을 확인할 수 없습니다.');
    if ((await readdir(paths.root)).length !== 0) throw new ServiceError('unrecognized-data-root', '자료 폴더에는 빈 전용 폴더를 선택해 주세요.');
    const handle = await open(marker, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' })); await handle.sync(); } finally { await handle.close(); }
  }
  await makePrivate(paths.root);
  for (const path of [paths.state, paths.runs, paths.runtime]) {
    await rejectLinks(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await rejectLinks(paths.secret);
  try {
    const file = await open(paths.secret, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32).toString('hex')); await file.sync(); } finally { await file.close(); }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await readConnectionSecret(paths);
}

export async function readConnectionSecret(paths: DataPaths): Promise<Buffer> {
  await rejectLinks(paths.secret);
  const stat = await lstat(paths.secret);
  if (!stat.isFile() || stat.size !== 64 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new ServiceError('invalid-service-secret', '서비스 연결 비밀의 형식이나 권한이 올바르지 않습니다.');
  const value = await readFile(paths.secret, 'utf8');
  if (!/^[0-9a-f]{64}$/.test(value) || await realpath(dirname(paths.secret)) !== await realpath(paths.runtime)) throw new ServiceError('invalid-service-secret');
  return Buffer.from(value, 'hex');
}
