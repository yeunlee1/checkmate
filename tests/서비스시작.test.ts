// 전용 자료 폴더의 권한과 여러 클라이언트의 단일 서비스 시작을 검증한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { dataPaths, prepareDataPaths, readConnectionSecret } from '../packages/engine/src/연결/개인경로.js';
import { requestLocal } from '../packages/engine/src/연결/로컬통신.js';
import { acquireServiceOwnership, startLocalService } from '../packages/engine/src/서비스/상주서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { createStoreFixture, writeConcurrentProject } from './저장시험자료.js';
import { executionLockKeys } from '../packages/engine/src/연결/공유잠금.js';
import { databaseSpecs } from '../packages/engine/src/자원/데이터베이스종류.js';

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const f = await createStoreFixture();
  const parent = f.directory;
  cleanups.push(f.cleanup);
  return dataPaths(join(parent, '관리 자료'));
}
const request = () => ({ apiVersion: 1 as const, requestId: randomUUID(), method: 'capabilities' as const, input: {} });

it('기본 자료 경로는 기존 설치 폴더 밖에서 초기화되고 명시한 기존 경로도 유지한다', async () => {
  const parent = dirname((await fixture()).root);
  vi.stubEnv('LOCALAPPDATA', parent);
  vi.stubEnv('CHECKMATE_DATA_DIR', undefined);
  try {
    const installation = join(parent, 'CheckMate');
    await mkdir(installation);
    await writeFile(join(installation, 'Update.exe'), '합성 설치 파일');
    const paths = dataPaths();
    expect(paths.root).toBe(join(parent, 'CheckMateData'));
    await prepareDataPaths(paths);
    expect(await readConnectionSecret(paths)).toHaveLength(32);
    expect(await readFile(join(installation, 'Update.exe'), 'utf8')).toBe('합성 설치 파일');
    expect(dataPaths(installation).root).toBe(installation);
    vi.stubEnv('CHECKMATE_DATA_DIR', installation);
    expect(dataPaths().root).toBe(installation);
  } finally { vi.unstubAllEnvs(); }
});

it('한글과 공백 경로에 전용 자료를 동시 초기화해 기존 비밀을 유지한다', async () => {
  const paths = await fixture();
  await Promise.all(Array.from({ length: 4 }, () => prepareDataPaths(paths)));
  const first = await readConnectionSecret(paths);
  await Promise.all(Array.from({ length: 4 }, () => prepareDataPaths(paths)));
  expect(await readConnectionSecret(paths)).toEqual(first);
  await writeFile(join(paths.runtime, '읽기쓰기.txt'), '한글 자료');
  expect(await readFile(join(paths.runtime, '읽기쓰기.txt'), 'utf8')).toBe('한글 자료');
});

it('완료한 초기화는 다시 검증해 손상된 표식을 거절한다', async () => {
  const paths = await fixture();
  await prepareDataPaths(paths);
  await writeFile(join(paths.root, '체크메이트자료.json'), '손상');
  await expect(prepareDataPaths(paths)).rejects.toMatchObject({ code: 'unrecognized-data-root' });
});

it.runIf(process.platform === 'win32')('Windows DACL은 상속을 끊고 현재 사용자 SID만 허용한다', async () => {
  const paths = await fixture();
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const parentPath = Buffer.from(dirname(paths.root), 'utf8').toString('base64');
  const parentScript = `$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${parentPath}')); [IO.Directory]::GetAccessControl($path).Sddl`;
  const parentAcl = async () => (await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parentScript, 'utf16le').toString('base64')], { windowsHide: true })).stdout.trim();
  const originalParentAcl = await parentAcl();
  await prepareDataPaths(paths);
  const encoded = [paths.root, paths.state, paths.runs, paths.runtime, join(paths.root, '체크메이트자료.json'), paths.secret]
    .map((path) => `'${Buffer.from(path, 'utf8').toString('base64')}'`).join(',');
  const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(${encoded}); $result=@(foreach($item in $items) { $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($item)); $acl=if ([IO.File]::Exists($path)) { [IO.File]::GetAccessControl($path) } else { [IO.Directory]::GetAccessControl($path) }; [PSCustomObject]@{ sid=$sid; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; access=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + ':' + $_.AccessControlType.ToString() }) } }); ConvertTo-Json -InputObject $result -Compress`;
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  const rows = JSON.parse(stdout) as { sid: string; owner: string; protected: boolean; access: string[] }[];
  expect(rows).toHaveLength(6);
  for (const row of rows) {
    expect(row.owner).toBe(row.sid);
    expect(row.protected).toBe(true);
    expect(row.access).toEqual([`${row.sid}:Allow`]);
  }
  expect(await parentAcl()).toBe(originalParentAcl);
});

it('손상된 소유 표식을 보존하고 살아 있는 서비스의 두 번째 시작을 거절한다', async () => {
  const paths = await fixture();
  await prepareDataPaths(paths);
  const lock = join(paths.runtime, '서비스소유.json');
  await writeFile(lock, '{broken');
  await expect(startLocalService(paths.root, 60000, { lockRoot: join(dirname(paths.root), '공유잠금') })).rejects.toMatchObject({ code: 'ownership-unknown' });
  expect(await readFile(lock, 'utf8')).toBe('{broken');
  await rm(lock);
  const service = await startLocalService(paths.root, 10000, { lockRoot: join(dirname(paths.root), '공유잠금') });
  cleanups.push(service.close);
  const owner = await readFile(lock, 'utf8');
  await expect(startLocalService(paths.root, 60000, { lockRoot: join(dirname(paths.root), '공유잠금') })).rejects.toMatchObject({ code: 'service-already-running' });
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
  const first = await startLocalService(paths.root, 10000, { lockRoot: join(dirname(paths.root), '공유잠금') });
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
  const restarted = await startLocalService(paths.root, 10000, { lockRoot: join(dirname(paths.root), '공유잠금') });
  cleanups.push(restarted.close);
  expect(restarted.product.runs.getRun(ids[0]!)!).toMatchObject({ state: 'blocked', verdict: 'incomplete', cleanupVerified: true, finalized: true });
  expect(restarted.product.runs.getRun(ids[1]!)!).toMatchObject({ state: 'unverifiable', verdict: 'unknown', cleanupVerified: null, finalized: true });
});

it('네 독립 클라이언트가 하나의 PID와 DB에 붙고 유휴 종료 뒤 다시 시작한다', async () => {
  // 소유 표식 제거와 OS 프로세스 종료 사이에도 작업 폴더가 잠길 수 있어 실제 종료를 기다린다.
  const waitForServiceExit = async (pid: number) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('합성 서비스의 실제 프로세스 종료를 확인하지 못했습니다.');
  };
  const paths = await fixture();
  await prepareDataPaths(paths);
  const clientUrl = pathToFileURL(resolve('packages/engine/dist/서비스/클라이언트.js')).href;
  const serviceUrl = pathToFileURL(resolve('packages/engine/dist/서비스/상주서비스.js')).href;
  const entry = join(paths.root, '시험서비스.mjs');
  await writeFile(entry, [
    '// 합성 서비스의 시작 결과를 시험 폴더에 남기고 짧은 유휴 종료 시간을 설정한다.',
    "import { writeFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "const diagnosis = join(process.env.CHECKMATE_DATA_DIR, 'runtime', '합성서비스-' + process.pid + '.json');",
    "const record = (value) => writeFile(diagnosis, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...value }), { mode: 0o600 });",
    "const safe = (value) => String(value ?? '').replace(/[0-9a-f]{64}/gi, '[비밀 제외]');",
    "await record({ state: 'starting' });",
    'try {',
    `  const { startLocalService } = await import('${serviceUrl}');`,
    '  await startLocalService(undefined, 2000);',
    "  await record({ state: 'ready' });",
    '} catch (error) {',
    "  const cause = error?.cause;",
    "  await record({ state: 'failed', code: safe(error?.code), name: safe(error?.name), message: safe(error?.message), stack: safe(error?.stack), cause: cause && { code: safe(cause.code), status: cause.status, stderr: safe(cause.stderr?.toString('utf8')).slice(-4000) } });",
    '  process.exitCode = 5;',
    '}',
    '',
  ].join('\n'));
  const script = `import { callService } from '${clientUrl}'; import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import Database from 'better-sqlite3'; import { randomUUID } from 'node:crypto'; const root=process.argv[1]; const serviceEntry=process.argv[2]; const response=await callService({ apiVersion:1,requestId:randomUUID(),method:'capabilities',input:{} },{dataRoot:root,serviceEntry,lockRoot:join(root,'공유잠금')}); if(!response.ok) throw Error('capabilities'); const owner=JSON.parse(readFileSync(join(root,'runtime','서비스소유.json'),'utf8')); const db=new Database(join(root,'state','checkmate.sqlite'),{readonly:true,fileMustExist:true}); const version=db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version; const file=db.pragma('database_list')[0].file; db.close(); console.log(JSON.stringify({pid:owner.pid,id:owner.id,version,file}));`;
  const runClient = async () => {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script, paths.root, entry], { timeout: 35000, windowsHide: true, env: { ...process.env, CHECKMATE_LOCK_DIR: join(paths.root, '공유잠금') } })
      .catch((error: { code?: string | number; killed?: boolean; signal?: string; stderr?: string }) => {
        throw new Error(`독립 클라이언트 실패. 코드 ${error.code}, 시간 제한 종료 ${error.killed}, 신호 ${error.signal}. ${error.stderr?.slice(-4000) ?? ''}`);
      });
    return JSON.parse(stdout) as { pid: number; id: string; version: number; file: string };
  };
  const results = await Promise.allSettled(Array.from({ length: 4 }, runClient));
  if (results.some((result) => result.status === 'rejected')) {
    const attempts = await Promise.all((await readdir(paths.runtime)).filter((name) => /^합성서비스-\d+\.json$/.test(name)).map(async (name) => {
      const record = await readFile(join(paths.runtime, name), 'utf8').then((value) => JSON.parse(value) as { pid: number; state: string })
        .catch((error: { code?: string }) => ({ pid: Number(name.match(/\d+/)?.[0]), state: 'unreadable', error: error.code ?? 'invalid-record' }));
      let alive = true;
      try { process.kill(record.pid, 0); } catch { alive = false; }
      return { ...record, alive };
    }));
    const ownerFile = join(paths.runtime, '서비스소유.json');
    const owner = await readFile(ownerFile, 'utf8').then((value) => JSON.parse(value) as { pid: number; id: string })
      .catch((error: { code?: string }) => ({ error: error.code ?? 'invalid-owner' }));
    let ownerAlive: boolean | null = null;
    if ('pid' in owner) {
      try { process.kill(owner.pid, 0); ownerAlive = true; } catch { ownerAlive = false; }
    }
    const summary = { clients: results.map((result, index) => result.status === 'fulfilled'
      ? { index, status: 'fulfilled', ...result.value }
      : { index, status: 'rejected', error: String(result.reason) }), attempts, owner, ownerAlive };
    throw new Error(`독립 클라이언트 시작 진단. ${JSON.stringify(summary).replace(/[0-9a-f]{64}/gi, '[비밀 제외]')}`);
  }
  const rows = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  expect(new Set(rows.map((row) => row.pid)).size).toBe(1);
  expect(new Set(rows.map((row) => row.id)).size).toBe(1);
  expect(new Set(rows.map((row) => row.file)).size).toBe(1);
  expect(rows.every((row) => row.version === 3)).toBe(true);
  const firstPid = rows[0]!.pid;
  const lock = join(paths.runtime, '서비스소유.json');
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { await readFile(lock); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  await waitForServiceExit(firstPid);
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
  await waitForServiceExit(restarted.pid);
}, 120000);

it('사람 저장 이행의 소유 표식이 서비스 시작과 상호 배타적이다.', async () => {
  const paths = await fixture();
  await prepareDataPaths(paths);
  const release = await acquireServiceOwnership(paths);
  try {
    await expect(startLocalService(paths.root, 10000, { lockRoot: join(dirname(paths.root), '공유잠금') })).rejects.toMatchObject({ code: 'service-already-running' });
    await expect(acquireServiceOwnership(paths)).rejects.toMatchObject({ code: 'service-already-running' });
  } finally { await release(); }
  const service = await startLocalService(paths.root, 10000, { lockRoot: join(dirname(paths.root), '공유잠금') });
  cleanups.push(service.close);
  await expect(acquireServiceOwnership(paths)).rejects.toMatchObject({ code: 'service-already-running' });
});


it.each(['admitted', 'intent', 'generation', 'corrupt', 'marker', 'prepared-cleaned'] as const)('queued 재시작 %s 표식은 원판정을 보존하고 미확인 해제 없이 사람만 복구한다.', async phase => {
  const paths = await fixture(), lockRoot = join(dirname(paths.root), '공유잠금');
  const project = await writeConcurrentProject(dirname(paths.root), '대기복구원본');
  await mkdir(join(project.projectRoot, '.runtime'));
  project.source.project.commands[0]!.writes = ['.runtime'];
  await writeFile(join(project.projectRoot, 'checkmate', '프로젝트.json'), JSON.stringify(project.source.project));
  await writeFile(join(project.projectRoot, '검사.mjs'), "// 합성 실행 착수만 기록한다.\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('.runtime/spawn.txt','started');\n");
  const first = await startLocalService(paths.root, 60000, { lockRoot });
  const call = (method: 'register' | 'inspect' | 'approve', input: Record<string, string>) => first.product.handle({ apiVersion: 1, requestId: randomUUID(), method, input }, 'human');
  const registered = await call('register', { path: project.projectRoot }); expect(registered.ok).toBe(true);
  const info = registered.ok && registered.data as { workspaceId: string };
  if (!info) throw new Error('합성 등록 실패');
  const inspected = await call('inspect', { projectId: project.projectId, workspaceId: info.workspaceId, profile: 'quick' }); expect(inspected.ok).toBe(true);
  const plan = inspected.ok && inspected.data as { planId: string; fingerprint: string };
  if (!plan) throw new Error('합성 계획 실패');
  expect((await call('approve', { planId: plan.planId, fingerprint: plan.fingerprint })).ok).toBe(true);
  const owner = first.product.sessions.verify(first.product.sessions.open().credential);
  const runId = randomUUID(), registeredPlan = first.product.runs.getPlan(plan.planId)!;
  const lease = first.product.locks.acquire(runId, owner.ownerId, 'a'.repeat(64), executionLockKeys(project.projectRoot, ['.runtime'], [],
    [join(registeredPlan.plan.outputStorage!.runsRoot, runId)]));
  first.product.runs.admitRun({ projectId: project.projectId, planId: plan.planId, requestId: randomUUID(), runId, requestHash: 'a'.repeat(64), createdAt: new Date().toISOString(), owner, lease: { ...lease } });
  first.product.locks.admit(lease);
  const prior = first.product.locks.acquire(randomUUID(), null, 'b'.repeat(64), ['named:prior-protected']); first.product.locks.admit(prior);
  const file = join(lockRoot, `${runId}-${lease.generation}.json`), otherFile = join(lockRoot, `${prior.runId}-${prior.generation}.json`);
  const originalLease = await readFile(file, 'utf8'), otherLease = await readFile(otherFile, 'utf8');
  await first.close();
  const restarted = await startLocalService(paths.root, 60000, { lockRoot }); cleanups.push(restarted.close);
  const start = vi.spyOn(restarted.product.execution, 'start');
  const reader = connectStore(join(paths.state, 'checkmate.sqlite')); cleanups.push(async () => { reader.close(); });
  const original = (reader.prepare('SELECT summary_json FROM runs WHERE id=?').get(runId) as { summary_json: string }).summary_json;
  const originalOwner = restarted.product.runs.getControl(runId);
  expect(JSON.parse(original)).toMatchObject({ state: 'blocked', finalized: true, verdict: 'incomplete', cleanupVerified: true });
  expect(await readFile(file, 'utf8')).toBe(originalLease);
  await expect(readFile(join(project.projectRoot, '.runtime', 'spawn.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (phase === 'intent') await writeFile(file, JSON.stringify({ ...lease, phase: 'intent' }));
  if (phase === 'generation') await writeFile(file, JSON.stringify({ ...lease, generation: randomUUID(), phase: 'admitted' }));
  if (phase === 'corrupt') await writeFile(file, '{broken');
  if (phase === 'marker') await writeFile(join(lockRoot, '조정잠금'), '합성 소유 불명 조정 표식');
  if (phase === 'prepared-cleaned') {
    const id = randomUUID();
    reader.prepare('INSERT INTO resources (id,run_id,kind,owner_token_hash,state,descriptor_json,cleanup_json) VALUES (?,?,?,?,?,?,?)')
      .run(id, runId, 'postgres-test', 'd'.repeat(64), 'cleaned', JSON.stringify({ name: `cm-pg-${runId}-${id}`, image: databaseSpecs['postgres-test'].image,
        endpoint: 'unix:///synthetic-not-connected.sock', daemonId: 'synthetic-not-connected' }), JSON.stringify({ verified: true, checkedAt: new Date().toISOString(), reason: '합성 준비 기록의 정리 확인' }));
  }
  const frozenFile = await readFile(file, 'utf8');
  const request = { apiVersion: 1 as const, requestId: randomUUID(), method: 'acknowledge-cleanup' as const, input: { runId, confirm: true, note: '합성 사람이 재시작 대기 실행의 자원 및 착수 부재를 직접 확인했다.' } };
  expect(await restarted.product.handle(request, 'agent')).toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  const acknowledged = await restarted.product.handle(request, 'human');
  if (phase !== 'admitted') {
    expect(acknowledged).toMatchObject({ ok: false });
    expect(reader.prepare("SELECT count(*) AS count FROM audit_events WHERE action='cleanup-acknowledged' AND entity_id=?").get(runId)).toEqual({ count: 0 });
    expect(reader.prepare('SELECT summary_json FROM runs WHERE id=?').get(runId)).toEqual({ summary_json: original });
    expect(restarted.product.runs.getControl(runId)).toEqual(originalOwner);
    expect(await readFile(file, 'utf8')).toBe(frozenFile);
    expect(await readFile(otherFile, 'utf8')).toBe(otherLease);
    expect(reader.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(runId)).toBeDefined();
    expect(start).toHaveBeenCalledTimes(0);
    await expect(readFile(join(project.projectRoot, '.runtime', 'spawn.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  expect(acknowledged).toMatchObject({ ok: true, data: { runId, acknowledged: true, reused: false } });
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(otherFile, 'utf8')).toBe(otherLease);
  expect(reader.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(runId)).toBeUndefined();
  expect(reader.prepare('SELECT summary_json FROM runs WHERE id=?').get(runId)).toEqual({ summary_json: original });
  expect(restarted.product.runs.getControl(runId)).toEqual(originalOwner);
  expect(await restarted.product.handle(request, 'human')).toMatchObject({ ok: true, data: { reused: true } });
  expect(start).toHaveBeenCalledTimes(0);
  await expect(readFile(join(project.projectRoot, '.runtime', 'spawn.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);
