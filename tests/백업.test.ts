// 합성 SQLite와 실제 증거 파일로 백업의 무결성과 새 빈 폴더 복구를 검증한다.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { assessResult } from '@checkmate/contracts';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { createBackup, restoreBackup } from '../packages/engine/src/저장/백업.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
const execute = promisify(execFile);
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const files = await createStoreFixture();
  const paths = dataPaths(join(files.directory, '관리'));
  await prepareDataPaths(paths);
  const db = connectStore(join(paths.state, 'checkmate.sqlite'));
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runId = randomUUID();
  const registration: PlanRegistration = {
    project: { id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'local-test' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] }, createdAt: new Date().toISOString(),
  };
  const runs = new SQLiteRunStore(db);
  runs.registerPlan(registration);
  runs.admitRun({ projectId: registration.project.id, planId: registration.plan.id,
    requestId: randomUUID(), requestHash: 'e'.repeat(64), runId, createdAt: new Date().toISOString() });
  const cancelled = { ...runs.getRun(runId)!, state: 'cancelled' as const, finalized: true };
  const assessment = assessResult(cancelled);
  runs.finalizeRun({ ...cancelled, verdict: assessment.verdict, reasons: assessment.reasons });
  await mkdir(join(paths.runs, runId));
  const content = Buffer.from('합성 증거 원본', 'utf8');
  await writeFile(join(paths.runs, runId, '결과.txt'), content);
  const evidence = { id: randomUUID(), relativePath: '결과.txt', sha256: hash(content),
    byteLength: content.length, mime: 'text/plain' as const, sensitivity: 'public' as const };
  await new EvidenceStore(db, paths.runs).register(runId, evidence);
  return { files, paths, db, runId, content, evidence,
    backupRoot: join(files.directory, '백업'), target: join(files.directory, '새자료') };
}

test('SQLite와 증거를 함께 백업하고 빈 폴더에서 이력과 해시를 복구한다', async () => {
  const f = await fixture();
  const originalSecret = await readFile(f.paths.secret);
  const before = (f.db.prepare('SELECT total_changes() AS value').get() as { value: number }).value;
  const defaultRoot = join(f.paths.root, 'backups');
  const result = await createBackup(f.db, f.paths, defaultRoot);
  expect(result.backupDirectory.startsWith(defaultRoot)).toBe(true);
  expect(result.manifest.files.map((file) => file.path)).toEqual([
    'state/checkmate.sqlite', `runs/${f.runId}/결과.txt`,
  ]);
  expect(result.manifest.files[1]).toMatchObject({ sha256: f.evidence.sha256, byteLength: f.content.length });
  expect(result.manifestHash).toBe(hash(await readFile(join(result.backupDirectory, '백업명세.json'))));
  expect((await readdir(result.backupDirectory)).sort()).toEqual(['runs', 'state', '백업명세.json', '완료표식.txt'].sort());
  expect((await readFile(join(result.backupDirectory, '백업명세.json'), 'utf8'))).not.toContain(originalSecret.toString('utf8'));
  expect((f.db.prepare('SELECT total_changes() AS value').get() as { value: number }).value).toBe(before);

  await mkdir(f.target);
  const restored = await restoreBackup(result.backupDirectory, f.target);
  const copied = await readFile(join(restored.runs, f.runId, '결과.txt'));
  expect(copied).toEqual(f.content);
  expect(hash(copied)).toBe(f.evidence.sha256);
  expect(await readFile(restored.secret)).not.toEqual(originalSecret);
  const restoredDb = new Database(join(restored.state, 'checkmate.sqlite'), { readonly: true, fileMustExist: true });
  try {
    expect(restoredDb.prepare('SELECT state FROM runs WHERE id = ?').get(f.runId)).toMatchObject({ state: 'cancelled' });
    expect(restoredDb.prepare('SELECT sha256 FROM evidence WHERE run_id = ?').get(f.runId))
      .toMatchObject({ sha256: f.evidence.sha256 });
    expect(restoredDb.pragma('quick_check', { simple: true })).toBe('ok');
  } finally { restoredDb.close(); }
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'target-not-empty' });
  const second = await restoreBackup(result.backupDirectory, join(f.files.directory, '없는자료'));
  expect(await readFile(join(second.runs, f.runId, '결과.txt'))).toEqual(f.content);
}, 30_000);

test('전용 backups 이외의 관리 자료 하위와 자료 루트 조상은 백업 위치로 거부한다', async () => {
  const f = await fixture();
  for (const path of [f.paths.root, f.paths.state, join(f.paths.runs, '백업'), f.files.directory]) {
    await expect(createBackup(f.db, f.paths, path)).rejects.toMatchObject({ code: 'invalid-path' });
  }
});

test.runIf(process.platform === 'win32')('짧은 입력 경로와 실제 경로가 달라도 관리 자료 내부 백업 경계를 지킨다', async () => {
  const f = await fixture();
  const actualRoot = await realpath(f.paths.root);
  if (actualRoot.toLowerCase() === f.paths.root.toLowerCase()) return;
  await expect(createBackup(f.db, f.paths, join(actualRoot, 'state')))
    .rejects.toMatchObject({ code: 'invalid-path' });
  const result = await createBackup(f.db, f.paths, join(actualRoot, 'backups'));
  expect(result.manifest.files.map((file) => file.path)).toContain(`runs/${f.runId}/결과.txt`);
});

test.runIf(process.platform === 'win32')('기존 8.3 별칭으로 지정한 폴더의 하위 복구를 거부한다', async () => {
  const longRoot = process.env.ProgramFiles;
  if (!longRoot) return;
  const encodedPath = Buffer.from(longRoot, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder result, uint length); }'; $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $result=New-Object Text.StringBuilder 32768; if ([ShortPath]::GetShortPathName($path,$result,[uint32]$result.Capacity) -eq 0) { throw 'short-path-failed' }; $result.ToString()`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  const shortRoot = stdout.trim();
  if (!shortRoot || shortRoot.toLowerCase() === longRoot.toLowerCase()) return;
  await expect(restoreBackup(shortRoot, join(longRoot, '체크메이트 복구 대상')))
    .rejects.toMatchObject({ code: 'invalid-path' });
});

test.runIf(process.platform === 'win32')('Windows 백업 내부 ACL만 현재 사용자 전용으로 바꾸고 상위 ACL은 보존한다', async () => {
  const f = await fixture();
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const inspect = async (paths: string[]) => {
    const encoded = paths.map((path) => `'${Buffer.from(path, 'utf8').toString('base64')}'`).join(',');
    const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(${encoded}); $result=@(foreach($item in $items) { $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($item)); $acl=if ([IO.File]::Exists($path)) { [IO.File]::GetAccessControl($path) } else { [IO.Directory]::GetAccessControl($path) }; [PSCustomObject]@{ sid=$sid; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; access=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + ':' + $_.AccessControlType.ToString() }); sddl=$acl.Sddl } }); ConvertTo-Json -InputObject $result -Compress`;
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    return JSON.parse(stdout) as { sid: string; owner: string; protected: boolean; access: string[]; sddl: string }[];
  };
  const before = (await inspect([f.files.directory]))[0]!.sddl;
  const result = await createBackup(f.db, f.paths, f.backupRoot);
  const internal = [result.backupDirectory, join(result.backupDirectory, 'state'),
    join(result.backupDirectory, 'state', 'checkmate.sqlite'),
    join(result.backupDirectory, 'runs', f.runId), join(result.backupDirectory, 'runs', f.runId, '결과.txt'),
    join(result.backupDirectory, '백업명세.json'), join(result.backupDirectory, '완료표식.txt')];
  for (const row of await inspect(internal)) {
    expect(row.owner).toBe(row.sid);
    expect(row.protected).toBe(true);
    expect(row.access).toEqual([`${row.sid}:Allow`]);
  }
  expect((await inspect([f.files.directory]))[0]!.sddl).toBe(before);
});

test('손상·누락·미완성 백업과 비어 있지 않은 대상은 복구 전에 거부한다', async () => {
  const f = await fixture();
  const result = await createBackup(f.db, f.paths, f.backupRoot);
  await writeFile(f.target, '기존 자료');
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'target-not-empty' });
  expect(await readFile(f.target, 'utf8')).toBe('기존 자료');
  await rm(f.target);
  const evidencePath = join(result.backupDirectory, 'runs', f.runId, '결과.txt');
  await writeFile(evidencePath, '변조된 증거');
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'file-invalid' });
  await writeFile(evidencePath, f.content);
  await rm(evidencePath);
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'file-invalid' });
  await writeFile(evidencePath, f.content);
  await rm(join(result.backupDirectory, '완료표식.txt'));
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'incomplete-backup' });
  await writeFile(join(result.backupDirectory, '완료표식.txt'), result.manifestHash);
  const unknown = join(result.backupDirectory, '추가.txt');
  await writeFile(unknown, '등록되지 않은 파일');
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'unexpected-file' });
  await rm(unknown);
  await writeFile(join(result.backupDirectory, 'state', 'checkmate.sqlite'), '손상된 DB');
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'file-invalid' });
  expect((f.db.prepare('SELECT count(*) AS value FROM runs').get() as { value: number }).value).toBe(1);
});

test('백업 내부 링크와 등록 증거의 링크를 거부한다', async () => {
  const f = await fixture();
  const result = await createBackup(f.db, f.paths, f.backupRoot);
  const copied = join(result.backupDirectory, 'runs', f.runId, '결과.txt');
  await rm(copied);
  try {
    await symlink(join(f.paths.runs, f.runId, '결과.txt'), copied);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    const external = join(f.files.directory, '외부');
    await mkdir(external);
    await writeFile(join(external, '결과.txt'), f.content);
    await rm(join(result.backupDirectory, 'runs', f.runId), { recursive: true });
    await symlink(external, join(result.backupDirectory, 'runs', f.runId), 'junction');
  }
  await expect(restoreBackup(result.backupDirectory, f.target)).rejects.toMatchObject({ code: 'file-invalid' });
  const originalRun = join(f.paths.runs, f.runId);
  await rm(join(originalRun, '결과.txt'));
  try {
    await symlink(join(f.files.directory, '소유표식.txt'), join(originalRun, '결과.txt'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    const external = join(f.files.directory, '외부원본');
    await mkdir(external);
    await writeFile(join(external, '결과.txt'), f.content);
    await rm(originalRun, { recursive: true });
    await symlink(external, originalRun, 'junction');
  }
  await expect(createBackup(f.db, f.paths, f.backupRoot)).rejects.toMatchObject({ code: 'file-invalid' });
});

test('진행 중 실행이 있는 DB는 정상 백업으로 공개하지 않는다', async () => {
  const f = await fixture();
  const extra = randomUUID();
  const plan = f.db.prepare('SELECT id, workspace_id FROM plans LIMIT 1').get() as { id: string; workspace_id: string };
  f.db.prepare(`INSERT INTO runs (id,workspace_id,plan_id,origin,state,phase,started_at,summary_json)
    VALUES (?,?,?,'live','queued','queued',?,?)`).run(extra, plan.workspace_id, plan.id, new Date().toISOString(), '{}');
  await expect(createBackup(f.db, f.paths, f.backupRoot)).rejects.toMatchObject({ code: 'active-runs' });
});

test('백업 중 증거 파일이 바뀌면 완성 표식을 남기지 않는다', async () => {
  const f = await fixture();
  const backup = f.db.backup.bind(f.db);
  const mocked = vi.spyOn(f.db, 'backup').mockImplementation(async (destination, options) => {
    await writeFile(join(f.paths.runs, f.runId, '결과.txt'), '백업 중 바뀜');
    return backup(destination, options);
  });
  try {
    await expect(createBackup(f.db, f.paths, f.backupRoot)).rejects.toMatchObject({ code: 'file-invalid' });
    const directories = await readdir(f.backupRoot);
    expect(directories).toHaveLength(1);
    expect(await readdir(join(f.backupRoot, directories[0]!))).not.toContain('완료표식.txt');
  } finally { mocked.mockRestore(); }
});
