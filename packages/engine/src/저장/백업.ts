// 관리 SQLite와 등록된 실행 증거를 검증 가능한 전용 폴더로 백업하고 새 자료 폴더에 복구한다.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { dataPaths, prepareDataPaths, rejectLinks, type DataPaths } from '../연결/개인경로.js';
import { verifyEvidence } from '../증거검증.js';
import { schemaChecksum, schemaTables, schemaVersion } from './스키마.js';

const databaseName = 'checkmate.sqlite';
const manifestName = '백업명세.json';
const completeName = '완료표식.txt';
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const fileSchema = z.strictObject({ path: z.string().min(1), sha256: hashSchema,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const manifestSchema = z.strictObject({ formatVersion: z.literal(1), id: z.uuid(),
  createdAt: z.iso.datetime(), schemaVersion: z.literal(schemaVersion), schemaChecksum: z.literal(schemaChecksum),
  files: z.array(fileSchema).min(1) });

export type BackupManifest = z.infer<typeof manifestSchema>;
export type BackupResult = { backupDirectory: string; manifestHash: string; manifest: BackupManifest };

export class BackupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type EvidenceRow = { run_id: string; relative_path: string; sha256: string; byte_length: number; state: string };
type FileRecord = z.infer<typeof fileSchema>;

function fail(code: string, message: string): never { throw new BackupError(code, message); }
function normalized(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}
function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function pathParts(value: string): string[] {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes(':')
    || /[\x00-\x1f\x7f<>"|?*]/u.test(value)) fail('unsafe-path', '백업 파일 경로가 안전하지 않습니다.');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))
    fail('unsafe-path', '백업 파일 경로가 안전하지 않습니다.');
  return parts;
}
function filePath(root: string, path: string): string {
  const result = join(root, ...pathParts(path));
  if (!within(root, result)) fail('unsafe-path', '백업 폴더 밖의 파일은 사용할 수 없습니다.');
  return result;
}
function evidencePath(row: EvidenceRow): string {
  if (!z.uuid().safeParse(row.run_id).success) fail('invalid-evidence', '실행 ID가 올바르지 않습니다.');
  pathParts(row.relative_path);
  return `runs/${row.run_id}/${row.relative_path}`;
}
function snapshot(db: Database.Database): { version: number; changes: number; evidence: EvidenceRow[] } {
  const version = db.pragma('data_version', { simple: true }) as number;
  const changes = (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value;
  const evidence = db.prepare('SELECT run_id, relative_path, sha256, byte_length, state FROM evidence ORDER BY run_id, relative_path')
    .all() as EvidenceRow[];
  return { version, changes, evidence };
}
function validateDatabase(db: Database.Database): EvidenceRow[] {
  if (db.pragma('quick_check', { simple: true }) !== 'ok'
    || (db.pragma('foreign_key_check') as unknown[]).length !== 0)
    fail('database-corrupt', 'SQLite 무결성 또는 연결 검사가 실패했습니다.');
  const versions = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; checksum: string }[];
  if (versions.length !== 1 || versions[0]?.version !== schemaVersion || versions[0].checksum !== schemaChecksum)
    fail('unsupported-schema', '지원하지 않는 저장 스키마입니다.');
  const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string }[];
  const tables = objects.filter((item) => item.type === 'table').map((item) => item.name);
  if (tables.length !== schemaTables.length || schemaTables.some((name) => !tables.includes(name)))
    fail('unsupported-schema', '저장 테이블 구성이 일치하지 않습니다.');
  const active = (db.prepare("SELECT count(*) AS count FROM runs WHERE state IN ('queued','running') OR finalized_at IS NULL")
    .get() as { count: number }).count;
  if (active !== 0) fail('active-runs', '진행 중이거나 확정되지 않은 실행이 있어 백업을 거부합니다.');
  const evidence = db.prepare('SELECT run_id, relative_path, sha256, byte_length, state FROM evidence ORDER BY run_id, relative_path')
    .all() as EvidenceRow[];
  for (const row of evidence) {
    if (row.state !== 'ready' || !hashSchema.safeParse(row.sha256).success
      || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0)
      fail('invalid-evidence', '확인되지 않은 증거가 있어 백업을 거부합니다.');
    evidencePath(row);
  }
  return evidence;
}
function sameEvidence(left: EvidenceRow[], right: EvidenceRow[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function privatePath(path: string, file = false): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, file ? 0o600 : 0o700); return; }
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  const kind = file ? 'File' : 'Directory';
  const inheritance = file ? 'None' : 'ContainerInherit,ObjectInherit';
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.${kind}]::GetAccessControl($target); if (-not $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid)) { throw 'owner-mismatch' }; $acl.SetAccessRuleProtection($true,$false); foreach ($old in @($acl.Access)) { $acl.RemoveAccessRuleAll($old) }; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','${inheritance}','None','Allow'); $acl.AddAccessRule($rule); [IO.${kind}]::SetAccessControl($target,$acl)`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'ignore', timeout: 15000 }); }
  catch { fail('private-directory-failed', '사용자 전용 백업 권한을 설정할 수 없습니다.'); }
}
async function newPrivateFile(path: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await privatePath(path, true);
}
async function checkedFile(root: string, entry: FileRecord): Promise<void> {
  const result = await verifyEvidence(root, { relativePath: entry.path, sha256: entry.sha256,
    byteLength: entry.byteLength });
  if (result.status !== 'verified') fail('file-invalid', `백업 파일 검증 실패: ${result.status}.`);
  let links: number;
  try { links = (await lstat(filePath(root, entry.path))).nlink; }
  catch { fail('file-invalid', '백업 파일을 다시 확인할 수 없습니다.'); }
  if (links !== 1)
    fail('unsafe-path', '외부 파일과 연결된 백업 파일은 사용할 수 없습니다.');
}
async function checkedCopy(sourceRoot: string, targetRoot: string, entry: FileRecord): Promise<void> {
  await checkedFile(sourceRoot, entry);
  const source = filePath(sourceRoot, entry.path);
  const target = filePath(targetRoot, entry.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await privatePath(dirname(target));
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await privatePath(target, true);
  await checkedFile(sourceRoot, entry);
  await checkedFile(targetRoot, entry);
}
async function fileRecord(root: string, path: string): Promise<FileRecord> {
  const full = filePath(root, path);
  const before = await lstat(full, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    fail('file-invalid', '백업 파일이 일반 파일이 아닙니다.');
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      fail('file-changed', '백업 파일이 읽는 동안 바뀌었습니다.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const final = await lstat(full, { bigint: true });
    if (size !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || final.dev !== before.dev || final.ino !== before.ino || final.mtimeNs !== before.mtimeNs
      || final.ctimeNs !== before.ctimeNs || final.isSymbolicLink())
      fail('file-changed', '백업 파일이 읽는 동안 바뀌었습니다.');
    return { path, sha256: hash.digest('hex'), byteLength: size };
  } finally { await handle.close(); }
}
async function exactContents(root: string, files: string[]): Promise<void> {
  const allowedFiles = new Set([manifestName, completeName, ...files]);
  const allowedDirs = new Set<string>();
  for (const name of allowedFiles) {
    const parts = pathParts(name);
    for (let n = 1; n < parts.length; n += 1) allowedDirs.add(parts.slice(0, n).join('/'));
  }
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      pathParts(path);
      const info = await lstat(join(directory, item.name));
      if (info.isSymbolicLink()) fail('unsafe-path', '백업에 링크가 있습니다.');
      if (info.isDirectory() && allowedDirs.has(path)) await visit(join(directory, item.name), path);
      else if (!info.isFile() || !allowedFiles.has(path)) fail('unexpected-file', `백업에 등록되지 않은 항목이 있습니다: ${path}.`);
    }
  }
  await visit(root, '');
}
async function cleanupStaging(staging: string, files: FileRecord[]): Promise<void> {
  try {
    const info = await lstat(staging);
    if (!info.isDirectory() || info.isSymbolicLink()
      || normalized(await realpath(staging)) !== normalized(resolve(staging))) return;
  } catch { return; }
  const names = [...files.map((file) => file.path), 'runtime/연결비밀', '체크메이트자료.json'];
  const directories = new Set(['state', 'runs', 'runtime']);
  for (const name of names) {
    const parts = pathParts(name);
    for (let n = 1; n < parts.length; n += 1) directories.add(parts.slice(0, n).join('/'));
    const path = filePath(staging, name);
    try {
      await rejectLinks(path);
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) await rm(path);
    } catch { /* 다른 자료나 링크는 지우지 않는다. */ }
  }
  for (const name of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try { await rejectLinks(filePath(staging, name)); await rmdir(filePath(staging, name)); }
    catch { /* 비어 있지 않은 폴더는 보존한다. */ }
  }
  try { await rmdir(staging); } catch { /* 알 수 없는 자료가 남아 있으면 보존한다. */ }
}
async function readManifest(directory: string): Promise<BackupManifest> {
  await rejectLinks(directory);
  const root = resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe-path', '백업 폴더가 안전하지 않습니다.');
  let manifestInfo;
  let markerInfo;
  try {
    manifestInfo = await lstat(join(root, manifestName));
    markerInfo = await lstat(join(root, completeName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
      fail('incomplete-backup', '백업 명세 또는 완성 표식이 없습니다.');
    throw error;
  }
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink()
    || manifestInfo.size > 16 * 1024 * 1024 || markerInfo.size !== 64) fail('incomplete-backup', '완성된 백업이 아닙니다.');
  const bytes = await readFile(join(root, manifestName));
  if ((await readFile(join(root, completeName), 'utf8')) !== sha256(bytes))
    fail('incomplete-backup', '백업 완성 표식이 일치하지 않습니다.');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('invalid-manifest', '백업 명세를 읽을 수 없습니다.'); }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) fail('invalid-manifest', '백업 명세 형식이 올바르지 않습니다.');
  return result.data;
}
async function verifyBackup(directory: string): Promise<BackupManifest> {
  const manifest = await readManifest(directory);
  const root = resolve(directory);
  const names = manifest.files.map((file) => file.path);
  if (names.length !== new Set(names.map(normalized)).size || names[0] !== `state/${databaseName}`)
    fail('invalid-manifest', '백업 파일 목록이 올바르지 않습니다.');
  for (const file of manifest.files) await checkedFile(root, file);
  await exactContents(root, names);
  const dbPath = filePath(root, names[0]!);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = validateDatabase(db);
    const expected = rows.map(evidencePath);
    if (names.length !== expected.length + 1 || expected.some((name, index) => name !== names[index + 1]))
      fail('invalid-manifest', '백업 증거 목록과 DB 기록이 다릅니다.');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const file = manifest.files[index + 1]!;
      if (row.sha256 !== file.sha256 || row.byte_length !== file.byteLength)
        fail('invalid-manifest', '백업 증거 해시와 DB 기록이 다릅니다.');
    }
  } finally { db.close(); }
  return manifest;
}

export async function createBackup(db: Database.Database, paths: DataPaths, backupRoot: string): Promise<BackupResult> {
  if (!isAbsolute(backupRoot) || resolve(backupRoot) === parse(backupRoot).root)
    fail('invalid-path', '백업 부모 폴더의 절대 경로가 필요합니다.');
  const source = resolve(paths.root);
  const destination = resolve(backupRoot);
  const dedicated = normalized(destination) === normalized(join(source, 'backups'));
  if ((within(source, destination) && !dedicated) || within(destination, source))
    fail('invalid-path', '백업 폴더는 전용 backups 폴더 또는 별도 위치를 선택해 주세요.');
  await rejectLinks(paths.root);
  await rejectLinks(paths.state);
  await rejectLinks(paths.runs);
  await rejectLinks(destination);
  if (!(await lstat(paths.root)).isDirectory() || !(await lstat(paths.runs)).isDirectory())
    fail('invalid-path', '관리 자료 폴더를 확인할 수 없습니다.');
  const actual = (db.pragma('database_list') as { name: string; file: string }[]).find((row) => row.name === 'main')?.file;
  if (!actual || normalized(await realpath(actual)) !== normalized(await realpath(join(paths.state, databaseName))))
    fail('invalid-path', '연결된 SQLite 파일이 관리 자료 폴더와 다릅니다.');
  const rows = validateDatabase(db);
  const before = snapshot(db);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await rejectLinks(destination);
  const id = randomUUID();
  const directory = join(destination, id);
  await mkdir(directory, { mode: 0o700 });
  await privatePath(directory);
  try {
    const dbCopy = filePath(directory, `state/${databaseName}`);
    await mkdir(dirname(dbCopy), { mode: 0o700 });
    await privatePath(dirname(dbCopy));
    const result = await db.backup(dbCopy);
    if (result.remainingPages !== 0) fail('database-backup-failed', 'SQLite 백업이 끝나지 않았습니다.');
    await privatePath(dbCopy, true);
    const backedUp = new Database(dbCopy, { fileMustExist: true });
    try {
      // 백업 API가 보존한 WAL 모드를 이 사본에서만 닫아 단일 DB 파일로 만든다.
      if (backedUp.pragma('journal_mode = DELETE', { simple: true }) !== 'delete')
        fail('database-backup-failed', '백업 DB를 단일 파일로 확정할 수 없습니다.');
      if (!sameEvidence(rows, validateDatabase(backedUp)))
        fail('database-changed', '백업 중 DB 증거 목록이 바뀌었습니다.');
    } finally { backedUp.close(); }
    const files: FileRecord[] = [await fileRecord(directory, `state/${databaseName}`)];
    for (const row of rows) {
      const path = evidencePath(row);
      const entry = { path, sha256: row.sha256, byteLength: row.byte_length };
      await checkedCopy(paths.root, directory, entry);
      files.push(entry);
    }
    for (const row of rows) await checkedFile(paths.root,
      { path: evidencePath(row), sha256: row.sha256, byteLength: row.byte_length });
    const after = snapshot(db);
    if (before.version !== after.version || before.changes !== after.changes
      || !sameEvidence(before.evidence, after.evidence))
      fail('database-changed', '백업 중 원본 DB가 바뀌었습니다.');
    validateDatabase(db);
    const manifest: BackupManifest = { formatVersion: 1, id, createdAt: new Date().toISOString(),
      schemaVersion, schemaChecksum, files };
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    await newPrivateFile(join(directory, manifestName), bytes);
    const manifestHash = sha256(bytes);
    await newPrivateFile(join(directory, completeName), manifestHash);
    await verifyBackup(directory);
    return { backupDirectory: directory, manifestHash, manifest };
  } catch (error) {
    // 실패한 백업은 완료 표식이 없으며 자동 정리로 증거를 잃지 않는다.
    try { await rm(join(directory, completeName), { force: true }); } catch { /* 검증 중 실패해도 미완성 상태로 둔다. */ }
    throw error;
  }
}

export async function restoreBackup(backupDirectory: string, targetRoot: string): Promise<DataPaths> {
  if (!isAbsolute(backupDirectory) || !isAbsolute(targetRoot)
    || resolve(targetRoot) === parse(targetRoot).root) fail('invalid-path', '백업과 복구 대상에는 절대 경로가 필요합니다.');
  const source = resolve(backupDirectory);
  const target = resolve(targetRoot);
  if (within(source, target) || within(target, source))
    fail('invalid-path', '복구 대상은 백업 폴더와 분리해 주세요.');
  const manifest = await verifyBackup(source);
  await rejectLinks(target);
  let existed = false;
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(target)).length !== 0)
      fail('target-not-empty', '복구 대상은 새 빈 폴더여야 합니다.');
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const staging = join(dirname(target), `.checkmate-restore-${randomUUID()}`);
  await rejectLinks(staging);
  const stagedPaths = dataPaths(staging);
  let created = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    created = true;
    await prepareDataPaths(stagedPaths);
    for (const entry of manifest.files) await checkedCopy(source, staging, entry);
    const stagedDb = new Database(join(stagedPaths.state, databaseName), { readonly: true, fileMustExist: true });
    try { validateDatabase(stagedDb); } finally { stagedDb.close(); }
    if (existed) {
      // 기존의 빈 폴더는 지우지 않는다. 자료 표식을 마지막에 두어 부분 복구를 서비스가 거부하도록 한다.
      if ((await readdir(target)).length !== 0) fail('target-not-empty', '복구 대상이 작업 중 변경됐습니다.');
      await privatePath(target);
      for (const name of ['state', 'runs', 'runtime']) await rename(join(staging, name), join(target, name));
      await rename(join(staging, '체크메이트자료.json'), join(target, '체크메이트자료.json'));
    } else {
      await rename(staging, target);
      created = false;
    }
    return dataPaths(target);
  } finally {
    if (created) await cleanupStaging(staging, manifest.files);
  }
}
