// Squirrel 설치 이벤트와 사용자 전용 CLI 진입점의 안전한 생성을 관리한다.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { compareManagedVersions, managedBackendSchema, managedDirectory, managedRegistrationSchema, managedRootKey,
  managedVersion, readManagedDescriptor, readManagedJson, readRegisteredRoots, sameManagedPath } from '@checkmate/engine/managed-connection';
import { assertInstallationAvailable, installationRoot } from '@checkmate/engine/update-lock';

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
  const bin = join(root, 'bin');
  await assertNoLinks(bin);
  let createdBin = false;
  try { await mkdir(bin, { mode: 0o700 }); createdBin = true; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  if (!(await lstat(bin)).isDirectory()) throw new Error('CLI 진입점 폴더가 직접 경로가 아닙니다.');
  const canonicalBin = await realpath(bin);
  const target = join(canonicalBin, 'checkmate.cmd');
  await assertNoLinks(target);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || !(await readFile(target, 'utf8')).startsWith(`@echo off\r\n${launcherMark}`))
      throw new Error('기존 CLI 진입점은 CheckMate가 만든 파일이 아닙니다.');
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  // 기존 디렉터리 ACL을 바꾸면 하위 하드링크의 외부 원본까지 바뀔 수 있다.
  if (createdBin) await makePrivate(bin, false);
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

const runtimeMarker = '체크메이트런타임.json';
const runtimeSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('checkmate-managed-runtime'),
  installationRoot: z.string(), dataRoot: z.string(), version: managedVersion, generation: z.uuid(),
  files: z.record(z.string(), z.string().regex(/^(?:[a-f0-9]{64}|directory)$/u)), operationId: z.uuid().optional() });
const publicationSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('checkmate-managed-publication'),
  operationId: z.uuid(), previousBackend: managedBackendSchema.nullable(), backend: managedBackendSchema, files: runtimeSchema.shape.files });
const publications = new Map<string, Promise<unknown>>();
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}
async function directFile(path: string): Promise<void> {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw new Error('관리형 연결 파일은 링크가 없는 직접 파일이어야 합니다.');
}
async function ownedDirectory(path: string, marker: string, expected: object): Promise<void> {
  await assertNoLinks(path);
  let created = false;
  try { await mkdir(path, { mode: 0o700 }); created = true; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  if (!(await lstat(path)).isDirectory()) throw new Error('관리형 연결 폴더가 직접 경로가 아닙니다.');
  const mark = join(path, marker);
  if (created) {
    await makePrivate(path, false);
    const handle = await open(mark, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(expected)); await handle.sync(); } finally { await handle.close(); }
  }
  let value: unknown;
  try { value = await readManagedJson(mark); }
  catch (error) { if (missing(error)) throw new Error('관리 표식이 없는 기존 폴더에는 관리형 연결을 만들 수 없습니다.'); throw error; }
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('관리형 연결 폴더의 소유 표식이 일치하지 않습니다.');
}
async function atomicJson(path: string, value: object): Promise<void> {
  await assertNoLinks(path);
  try { await directFile(path); } catch (error) { if (!missing(error)) throw error; }
  const temporary = join(dirname(path), `.관리발행-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try {
    await makePrivate(temporary, true);
    await assertNoLinks(path);
    try { await directFile(path); } catch (error) { if (!missing(error)) throw error; }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function runtimeFiles(base: string, node: string, engine: string): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  const visit = async (path: string) => {
    await assertNoLinks(path);
    const info = await lstat(path), key = relative(base, path).replaceAll('\\', '/');
    if (info.isDirectory()) {
      entries.push([key, 'directory']);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else {
      if (!info.isFile() || info.nlink !== 1) throw new Error('관리형 런타임의 링크 또는 특수 파일은 복사할 수 없습니다.');
      entries.push([key, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  };
  await directFile(node);
  entries.push(['node.exe', createHash('sha256').update(await readFile(node)).digest('hex')]);
  if (!(await lstat(engine)).isDirectory()) throw new Error('패키지 engine 폴더를 확인할 수 없습니다.');
  await visit(engine);
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
async function readRuntimeJson(path: string): Promise<unknown> {
  await directFile(path);
  if ((await lstat(path)).size > 16 * 1024 * 1024) throw new Error('관리형 런타임 표식이 너무 큽니다.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)));
}
async function verifySnapshot(snapshot: string, expected: z.infer<typeof runtimeSchema>): Promise<void> {
  await assertNoLinks(snapshot);
  if (!(await lstat(snapshot)).isDirectory()) throw new Error('관리형 런타임 폴더가 직접 경로가 아닙니다.');
  const actual = runtimeSchema.parse(await readRuntimeJson(join(snapshot, runtimeMarker)));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('관리형 런타임 표식 또는 원본이 변조됐습니다.');
  const names = (await readdir(snapshot)).sort();
  if (JSON.stringify(names) !== JSON.stringify(['engine', 'node.exe', runtimeMarker].sort())
    || JSON.stringify(await runtimeFiles(snapshot, join(snapshot, 'node.exe'), join(snapshot, 'engine'))) !== JSON.stringify(expected.files))
    throw new Error('관리형 런타임 복사 무결성을 확인할 수 없습니다.');
}

export async function ensureManagedConnection(dataRoot: string, nodeExecutable: string, cliEntry: string, version: string): Promise<{ command: string; args: string[] }> {
  const root = checkedPath(dataRoot), node = checkedPath(nodeExecutable), cli = checkedPath(cliEntry);
  managedVersion.parse(version);
  const installation = await installationRoot(node);
  if (!installation) throw new Error('관리형 연결에는 실제 Squirrel 설치본 Node가 필요합니다.');
  const key = process.platform === 'win32' ? installation.toLowerCase() : installation;
  const previous = publications.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => publishManagedConnection(root, node, cli, version, installation));
  publications.set(key, work);
  try { return await work; } finally { if (publications.get(key) === work) publications.delete(key); }
}

async function publishManagedConnection(root: string, node: string, cli: string, version: string, installation: string): Promise<{ command: string; args: string[] }> {
  const resources = join(installation, `app-${version}`, 'resources'), engine = join(resources, 'engine');
  if (!sameManagedPath(node, join(resources, 'node', 'node.exe'))
    || !sameManagedPath(cli, join(engine, 'packages', 'engine', 'dist', '명령.js')))
    throw new Error('관리형 연결은 지정 버전의 정확한 resources 경로만 사용합니다.');
  await assertNoLinks(installation);
  await directFile(join(installation, 'Update.exe'));
  await directFile(node); await directFile(cli);
  await directFile(join(engine, 'packages', 'engine', 'dist', '서비스', '상주서비스.js'));
  if (!sameManagedPath(await realpath(installation), installation)
    || !await hasOwnedDataRoot(root) || !sameManagedPath(await realpath(root), root))
    throw new Error('관리형 연결의 설치 또는 자료 폴더 소유를 확인할 수 없습니다.');
  if (inside(installation, root)) throw new Error('관리형 런타임은 설치 트리 밖의 자료 폴더에 두어야 합니다.');
  const manifest = await readManagedJson(join(engine, 'packages', 'engine', 'package.json'));
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== version)
    throw new Error('관리형 연결의 패키지 버전이 일치하지 않습니다.');
  await assertInstallationAvailable(node);
  const managed = managedDirectory(installation);
  await ownedDirectory(managed, '체크메이트연결.json', { schemaVersion: 1, kind: 'checkmate-managed-directory', installationRoot: installation });
  const lock = join(managed, '발행잠금.json'), owner = randomUUID();
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch { throw new Error('다른 관리형 연결 발행이 진행 중이거나 소유 확인이 필요합니다.'); }
  try { await handle.writeFile(JSON.stringify({ id: owner })); await handle.sync(); } finally { await handle.close(); }
  try {
    let descriptor;
    try { descriptor = await readManagedDescriptor(installation); } catch (error) { if (!missing(error)) throw error; }
    const comparison = descriptor ? compareManagedVersions(version, descriptor.version) : 1;
    if (comparison < 0) throw new Error('관리형 연결 버전을 낮출 수 없습니다.');
    const registrations = join(managed, '자료');
    await assertNoLinks(registrations);
    try { await mkdir(registrations, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (!(await lstat(registrations)).isDirectory()) throw new Error('관리형 자료 등록 폴더가 직접 경로가 아닙니다.');
    if ((await readdir(registrations)).length > 0) await readRegisteredRoots(installation);
    const registrationPath = join(registrations, `${managedRootKey(root)}.json`);
    const registration = managedRegistrationSchema.parse({ schemaVersion: 1, kind: 'checkmate-managed-root', installationRoot: installation, dataRoot: root });
    let registered = false;
    try {
      const old = managedRegistrationSchema.parse(await readManagedJson(registrationPath));
      if (!sameManagedPath(old.dataRoot, root) || !sameManagedPath(old.installationRoot, installation)) throw new Error('기존 자료 등록이 일치하지 않습니다.');
      registered = true;
    } catch (error) { if (!missing(error)) throw error; }
    const bin = join(root, 'bin');
    await assertNoLinks(bin);
    try { await mkdir(bin, { mode: 0o700 }); await makePrivate(bin, false); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    if (!(await lstat(bin)).isDirectory()) throw new Error('관리형 연결 bin 폴더가 직접 경로가 아닙니다.');
    const runtimes = join(bin, '관리런타임');
    await ownedDirectory(runtimes, '체크메이트관리.json', { schemaVersion: 1, kind: 'checkmate-managed-runtimes', installationRoot: installation, dataRoot: root });
    const snapshot = join(runtimes, version);
    const files = await runtimeFiles(resources, node, engine);
    let exists = true;
    try { await lstat(snapshot); } catch (error) { if (!missing(error)) throw error; exists = false; }
    if (exists) await directFile(join(snapshot, runtimeMarker));
    const journal = join(managed, `발행준비-${version}.json`);
    let publication: z.infer<typeof publicationSchema> | undefined;
    try { publication = publicationSchema.parse(await readRuntimeJson(journal)); } catch (error) { if (!missing(error)) throw error; }
    if (publication) {
      if (!sameManagedPath(publication.backend.installationRoot, installation) || publication.backend.version !== version
        || JSON.stringify(publication.files) !== JSON.stringify(files)
        || (publication.previousBackend && (!sameManagedPath(publication.previousBackend.installationRoot, installation)
          || compareManagedVersions(version, publication.previousBackend.version) <= 0
          || publication.backend.generation === publication.previousBackend.generation)))
        throw new Error('관리형 발행 기록의 설치 identity, 버전 또는 원본 지문이 일치하지 않습니다.');
      // descriptor가 발행됐다면 그 세대가 우선이며, 중단 상태는 원 previousBackend에만 이어 붙인다.
      if (comparison === 0 ? publication.backend.generation !== descriptor!.generation
        : JSON.stringify(publication.previousBackend) !== JSON.stringify(descriptor ?? null))
        throw new Error('관리형 런타임 표식 또는 원본이 변조됐습니다.');
    } else if (comparison > 0) {
      if (exists) throw new Error('기존 snapshot의 원 발행 operation을 확인할 수 없습니다.');
      publication = publicationSchema.parse({ schemaVersion: 1, kind: 'checkmate-managed-publication', operationId: randomUUID(),
        previousBackend: descriptor ?? null, backend: { schemaVersion: 1, kind: 'checkmate-managed-backend', installationRoot: installation,
          version, generation: randomUUID() }, files });
      // 설치 전체의 버전별 원 operation과 generation을 최초 한 번만 만들며 덮어쓰지 않는다.
      const prepared = await open(journal, 'wx', 0o600);
      try { await prepared.writeFile(JSON.stringify(publication)); await prepared.sync(); } finally { await prepared.close(); }
      await makePrivate(journal, true);
    }
    const next = comparison === 0 ? descriptor! : publication!.backend;
    const expected = runtimeSchema.parse({ schemaVersion: 1, kind: 'checkmate-managed-runtime', installationRoot: installation, dataRoot: root, version,
      generation: next.generation, files, ...(publication ? { operationId: publication.operationId } : {}) });
    if (exists) await verifySnapshot(snapshot, expected);
    else {
      const staging = join(runtimes, `.관리복사-${randomUUID()}.tmp`);
      await mkdir(staging, { mode: 0o700 }); await makePrivate(staging, false);
      // 실패한 복사와 살아 있는 이전 snapshot은 제거하거나 덮어쓰지 않는다.
      for (const [name, digest] of Object.entries(files)) {
        const destination = join(staging, name);
        if (digest === 'directory') await mkdir(destination, { mode: 0o700 });
        else {
          const source = name === 'node.exe' ? node : join(resources, name);
          await directFile(source);
          await copyFile(source, destination, constants.COPYFILE_EXCL);
          if (createHash('sha256').update(await readFile(destination)).digest('hex') !== digest)
            throw new Error('관리형 런타임 복사 SHA256이 일치하지 않습니다.');
        }
      }
      const mark = await open(join(staging, runtimeMarker), 'wx', 0o600);
      try { await mark.writeFile(JSON.stringify(expected)); await mark.sync(); } finally { await mark.close(); }
      await verifySnapshot(staging, expected);
      if (JSON.stringify(await runtimeFiles(resources, node, engine)) !== JSON.stringify(files)) throw new Error('복사 중 원본 패키지가 변경됐습니다.');
      await assertNoLinks(snapshot);
      try { await lstat(snapshot); throw new Error('관리형 런타임 대상이 다른 발행으로 생성됐습니다.'); } catch (error) { if (!missing(error)) throw error; }
      await rename(staging, snapshot);
    }
    await assertInstallationAvailable(node);
    if (!registered) await atomicJson(registrationPath, registration);
    if (comparison > 0) await atomicJson(join(managed, '백엔드.json'), next);
    return { command: join(snapshot, 'node.exe'), args: [join(snapshot, 'engine', 'packages', 'engine', 'dist', '명령.js'),
      '--data-dir', root, 'mcp-managed', '--installation-root', installation] };
  } finally {
    const current = await readManagedJson(lock);
    if (!current || typeof current !== 'object' || !('id' in current) || current.id !== owner) throw new Error('관리형 연결 발행 잠금 소유를 확인할 수 없습니다.');
    await unlink(lock);
  }
}
