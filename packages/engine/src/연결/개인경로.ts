// 사용자별 서비스 자료 경로와 비밀 파일의 접근 권한을 준비한다.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { ServiceError } from '@checkmate/contracts/api';

export type DataPaths = { root: string; state: string; runs: string; runtime: string; secret: string; endpoint: string };
export function dataPaths(root = process.env.CHECKMATE_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'CheckMateData')): DataPaths {
  if (!isAbsolute(root) || resolve(root) === parse(root).root) throw new ServiceError('invalid-path', '전용 자료 폴더의 절대 경로가 필요합니다.');
  const resolved = resolve(root);
  const key = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 24);
  // 서비스 자식 프로세스에도 같은 짧은 Unix 소켓 주소를 제공한다.
  return { root: resolved, state: join(resolved, 'state'), runs: join(resolved, 'runs'), runtime: join(resolved, 'runtime'), secret: join(resolved, 'runtime', '연결비밀'),
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\CheckMate-${key}` : join(realpathSync('/tmp'), `checkmate-${process.getuid!()}`, `${key}.sock`) };
}

export async function rejectLinks(path: string): Promise<void> {
  let cursor = resolve(path);
  while (cursor !== dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new ServiceError('unsafe-path', '링크 경로에는 서비스 자료를 저장할 수 없습니다.'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    cursor = dirname(cursor);
  }
}

async function makePrivate(path: string, file = false): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, file ? 0o600 : 0o700); return; }
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const access = file ? 'File' : 'Directory';
  const inheritance = file ? 'None' : 'ContainerInherit,ObjectInherit';
  // 높은 권한 토큰이 만든 전용 파일은 토큰 기본 소유자에서 사용자로 이전한다.
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$identity.User; $acl=[IO.${access}]::GetAccessControl($target); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]); if (-not $owner.Equals($sid)) { if (-not $owner.Equals($identity.Owner)) { throw 'owner-mismatch' }; $acl.SetOwner($sid) }; $acl.SetAccessRuleProtection($true,$false); foreach ($old in @($acl.Access)) { $acl.RemoveAccessRuleAll($old) }; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','${inheritance}','None','Allow'); $acl.AddAccessRule($rule); [IO.${access}]::SetAccessControl($target,$acl)`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 }); }
  catch (error) { const failure = new ServiceError('private-directory-failed', '사용자 전용 폴더 권한을 설정할 수 없습니다.'); failure.cause = error; throw failure; }
}

export async function verifyLocalEndpoint(paths: DataPaths): Promise<void> {
  if (process.platform === 'win32') return;
  await rejectLinks(paths.endpoint);
  let directory;
  try { directory = await lstat(dirname(paths.endpoint)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new ServiceError('service-unavailable', '서비스 연결 폴더가 없습니다.', true);
    throw error;
  }
  if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0)
    throw new ServiceError('unsafe-path', '사용자 전용 연결 폴더의 소유자나 권한이 올바르지 않습니다.');
}

const preparing = new Map<string, Promise<void>>();

export async function prepareDataPaths(paths: DataPaths): Promise<void> {
  // 같은 경로의 진행 중 작업만 공유한다. 호출마다 루트 링크를 확인하고 완료 뒤 다시 전체 검증한다.
  await rejectLinks(paths.root);
  const key = JSON.stringify([paths.root, paths.state, paths.runs, paths.runtime, paths.secret, paths.endpoint]);
  const pending = preparing.get(key);
  if (pending) {
    await pending;
    for (const path of [paths.root, paths.state, paths.runs, paths.runtime, paths.secret]) await rejectLinks(path);
    return;
  }
  const work = prepareDataPathsOnce(paths);
  preparing.set(key, work);
  try { await work; }
  finally { if (preparing.get(key) === work) preparing.delete(key); }
}

async function prepareDataPathsOnce(paths: DataPaths): Promise<void> {
  await rejectLinks(paths.root);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await rejectLinks(paths.root);
  const marker = join(paths.root, '체크메이트자료.json');
  await rejectLinks(marker);
  const expectedMarker = JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' });
  let markerExists = true;
  try { await lstat(marker); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    markerExists = false;
  }
  if (!markerExists) {
    const contents = await readdir(paths.root);
    if (contents.length > 0 && !(contents.length === 1 && contents[0] === '체크메이트자료.json'))
      throw new ServiceError('unrecognized-data-root', '자료 폴더에는 빈 전용 폴더를 선택해 주세요.');
    await makePrivate(paths.root);
    try {
      const handle = await open(marker, 'wx', 0o600);
      try { await handle.writeFile(expectedMarker); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  let validMarker = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await rejectLinks(marker);
    try { validMarker = await readFile(marker, 'utf8') === expectedMarker; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (validMarker) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!validMarker) throw new ServiceError('unrecognized-data-root', '체크메이트 자료 폴더의 표식을 확인할 수 없습니다.');
  await makePrivate(paths.root);
  await makePrivate(marker, true);
  for (const path of [paths.state, paths.runs, paths.runtime]) {
    await rejectLinks(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await rejectLinks(path);
    await makePrivate(path);
  }
  await rejectLinks(paths.secret);
  try {
    const file = await open(paths.secret, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32).toString('hex')); await file.sync(); } finally { await file.close(); }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  await makePrivate(paths.secret, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await readConnectionSecret(paths); break; }
    catch (error) {
      if (!(error instanceof ServiceError && error.code === 'invalid-service-secret') || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (process.platform !== 'win32') {
    await rejectLinks(dirname(paths.endpoint));
    await mkdir(dirname(paths.endpoint), { recursive: true, mode: 0o700 });
    await verifyLocalEndpoint(paths);
  }
}

export async function readConnectionSecret(paths: DataPaths): Promise<Buffer> {
  await rejectLinks(paths.secret);
  const stat = await lstat(paths.secret);
  if (!stat.isFile() || stat.size !== 64 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new ServiceError('invalid-service-secret', '서비스 연결 비밀의 형식이나 권한이 올바르지 않습니다.');
  const value = await readFile(paths.secret, 'utf8');
  if (!/^[0-9a-f]{64}$/.test(value) || await realpath(dirname(paths.secret)) !== await realpath(paths.runtime)) throw new ServiceError('invalid-service-secret');
  return Buffer.from(value, 'hex');
}
