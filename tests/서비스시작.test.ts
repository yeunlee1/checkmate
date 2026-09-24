// 전용 자료 폴더의 권한과 여러 클라이언트의 단일 서비스 시작을 검증한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { dataPaths, prepareDataPaths, readConnectionSecret } from '../packages/engine/src/연결/개인경로.js';
import { requestLocal } from '../packages/engine/src/연결/로컬통신.js';
import { startLocalService } from '../packages/engine/src/서비스/상주서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), '체크메이트 서비스 '));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  return dataPaths(join(parent, '관리 자료'));
}
const request = () => ({ apiVersion: 1 as const, requestId: randomUUID(), method: 'capabilities' as const, input: {} });

it('한글과 공백 경로에 전용 자료를 동시 초기화해 기존 비밀을 유지한다', async () => {
  const paths = await fixture();
  await Promise.all(Array.from({ length: 4 }, () => prepareDataPaths(paths)));
  const first = await readConnectionSecret(paths);
  await Promise.all(Array.from({ length: 4 }, () => prepareDataPaths(paths)));
  expect(await readConnectionSecret(paths)).toEqual(first);
  await writeFile(join(paths.runtime, '읽기쓰기.txt'), '한글 자료');
  expect(await readFile(join(paths.runtime, '읽기쓰기.txt'), 'utf8')).toBe('한글 자료');
});

it.runIf(process.platform === 'win32')('Windows DACL은 상속을 끊고 현재 사용자 SID만 허용한다', async () => {
  const paths = await fixture();
  await prepareDataPaths(paths);
  const encoded = [paths.root, paths.state, paths.runs, paths.runtime, join(paths.root, '체크메이트자료.json'), paths.secret]
    .map((path) => `'${Buffer.from(path, 'utf8').toString('base64')}'`).join(',');
  const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(${encoded}); $result=@(foreach($item in $items) { $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($item)); $acl=if ([IO.File]::Exists($path)) { [IO.File]::GetAccessControl($path) } else { [IO.Directory]::GetAccessControl($path) }; [PSCustomObject]@{ sid=$sid; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; access=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + ':' + $_.AccessControlType.ToString() }) } }); ConvertTo-Json -InputObject $result -Compress`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  const rows = JSON.parse(stdout) as { sid: string; owner: string; protected: boolean; access: string[] }[];
  expect(rows).toHaveLength(6);
  for (const row of rows) {
    expect(row.owner).toBe(row.sid);
    expect(row.protected).toBe(true);
    expect(row.access).toEqual([`${row.sid}:Allow`]);
  }
});

it('손상된 소유 표식을 보존하고 살아 있는 서비스의 두 번째 시작을 거절한다', async () => {
  const paths = await fixture();
  await prepareDataPaths(paths);
  const lock = join(paths.runtime, '서비스소유.json');
  await writeFile(lock, '{broken');
  await expect(startLocalService(paths.root)).rejects.toMatchObject({ code: 'ownership-unknown' });
  expect(await readFile(lock, 'utf8')).toBe('{broken');
  await rm(lock);
  const service = await startLocalService(paths.root, 10000);
  cleanups.push(service.close);
  const owner = await readFile(lock, 'utf8');
  await expect(startLocalService(paths.root)).rejects.toMatchObject({ code: 'service-already-running' });
  expect(await readFile(lock, 'utf8')).toBe(owner);
  expect(await requestLocal(paths, request())).toMatchObject({ ok: true });
});

it('링크 자료 경로를 거절하고 기존 폴더를 보존한다', async () => {
  const paths = await fixture();
  const target = join(resolve(paths.root, '..'), '보존 자료');
  await prepareDataPaths(dataPaths(target));
  const linked = join(resolve(paths.root, '..'), '연결 자료');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(prepareDataPaths(dataPaths(linked))).rejects.toMatchObject({ code: 'unsafe-path' });
  expect(await readFile(join(target, '체크메이트자료.json'), 'utf8')).toContain('checkmate-data');
});

it('재시작 때 미착수 실행은 정리 완료로 막고 진행 실행은 미확인으로 보존한다', async () => {
  const paths = await fixture();
  const first = await startLocalService(paths.root, 10000);
  await first.close();
  const db = connectStore(join(paths.state, 'checkmate.sqlite'));
  const store = new SQLiteRunStore(db);
  const ids: string[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const registration: PlanRegistration = {
        project: { id: randomUUID(), name: `합성 프로젝트 ${index}`, repositoryIdentity: `synthetic:${index}` },
        workspace: { id: randomUUID(), realPath: index === 0 ? paths.state : paths.runs, pathFingerprint: `${index + 1}`.repeat(64) },
        catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: { check: { id: 'check-1' } } },
        plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
          plannedChecks: ['check-1'], requiredChecks: ['check-1'] },
        createdAt: new Date().toISOString(),
      };
      store.registerPlan(registration);
      const runId = randomUUID();
      store.admitRun({ projectId: registration.project.id, planId: registration.plan.id, requestId: randomUUID(),
        requestHash: 'e'.repeat(64), runId, createdAt: new Date().toISOString() });
      if (index === 1) store.markRunning(runId);
      ids.push(runId);
    }
  } finally { db.close(); }
  const restarted = await startLocalService(paths.root, 10000);
  cleanups.push(restarted.close);
  expect(restarted.product.runs.getRun(ids[0]!)!).toMatchObject({ state: 'blocked', verdict: 'incomplete', cleanupVerified: true, finalized: true });
  expect(restarted.product.runs.getRun(ids[1]!)!).toMatchObject({ state: 'unverifiable', verdict: 'unknown', cleanupVerified: null, finalized: true });
});

it('네 독립 클라이언트가 하나의 PID와 DB에 붙고 유휴 종료 뒤 다시 시작한다', async () => {
  const paths = await fixture();
  await prepareDataPaths(paths);
  const clientUrl = pathToFileURL(resolve('packages/engine/dist/서비스/클라이언트.js')).href;
  const serviceUrl = pathToFileURL(resolve('packages/engine/dist/서비스/상주서비스.js')).href;
  const entry = join(paths.root, '시험서비스.mjs');
  await writeFile(entry, `// 합성 서비스의 짧은 유휴 종료 시간을 설정한다.\nimport { startLocalService } from '${serviceUrl}';\nawait startLocalService(undefined, 2000);\n`);
  const script = `import { callService } from '${clientUrl}'; import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import Database from 'better-sqlite3'; import { randomUUID } from 'node:crypto'; const root=process.argv[1]; const serviceEntry=process.argv[2]; const response=await callService({ apiVersion:1,requestId:randomUUID(),method:'capabilities',input:{} },{dataRoot:root,serviceEntry}); if(!response.ok) throw Error('capabilities'); const owner=JSON.parse(readFileSync(join(root,'runtime','서비스소유.json'),'utf8')); const db=new Database(join(root,'state','checkmate.sqlite'),{readonly:true,fileMustExist:true}); const version=db.prepare('SELECT version FROM schema_migrations').get().version; const file=db.pragma('database_list')[0].file; db.close(); console.log(JSON.stringify({pid:owner.pid,id:owner.id,version,file}));`;
  const runClient = async () => {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script, paths.root, entry], { timeout: 20000, windowsHide: true });
    return JSON.parse(stdout) as { pid: number; id: string; version: number; file: string };
  };
  const rows = await Promise.all(Array.from({ length: 4 }, runClient));
  expect(new Set(rows.map((row) => row.pid)).size).toBe(1);
  expect(new Set(rows.map((row) => row.id)).size).toBe(1);
  expect(new Set(rows.map((row) => row.file)).size).toBe(1);
  expect(rows.every((row) => row.version === 1)).toBe(true);
  const firstPid = rows[0]!.pid;
  const lock = join(paths.runtime, '서비스소유.json');
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { await readFile(lock); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  const restarted = await runClient();
  expect(restarted.pid).not.toBe(firstPid);
  expect(restarted.file).toBe(rows[0]!.file);
  const nextDeadline = Date.now() + 12000;
  while (Date.now() < nextDeadline) {
    try { await readFile(lock); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
}, 45000);
