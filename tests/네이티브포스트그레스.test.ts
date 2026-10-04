// 합성 드라이버와 새 전용 클러스터로 네이티브 제공자의 소유 및 정리 반례를 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { nativePostgresProviderSchema, resourceProviderSchema, selectedResourceProvider, type NativePostgresProvider } from '@checkmate/contracts/resources';
import { projectDefinitionSchema } from '@checkmate/contracts/project';
import { apiInputs } from '@checkmate/contracts/api';
import { NativePostgresResources, nativePostgresSystemDriver, verifyNativePostgresProvider, type NativePostgresDriver } from '../packages/engine/src/자원/네이티브포스트그레스.js';
import { DatabaseResources } from '../packages/engine/src/자원/격리데이터베이스.js';
import { ResourceStore, type ResourceRecord } from '../packages/engine/src/저장/자원저장.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { createStoreFixture } from './저장시험자료.js';

const workerRoot = resolve('.runtime/릴리스020/시험보완/네이티브');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const fakeProvider: NativePostgresProvider = { mode: 'native', binaryRoot: resolve('합성실행파일'),
  postgresVersion: '17.11', sha256: { initdb: 'a'.repeat(64), pg_ctl: 'b'.repeat(64), postgres: 'c'.repeat(64) } };

// CIM 첫 조회 준비와 제품 관측을 분리하며 준비 실패도 그대로 시험 실패로 남긴다.
describe('실제 자기 PID 관측 준비와 UTF8 신원', () => {
beforeAll(async () => {
  if (process.platform !== 'win32') return;
  const shell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').ProcessId`;
  const argv = ['-NoProfile', '-NonInteractive', '-Command', script];
  const startedAt = Date.now();
  const result = await promisify(execFile)(shell, argv, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(Number(result.stdout.trim())).toBe(process.pid);
  await mkdir(workerRoot, { recursive: true });
  await writeFile(join(workerRoot, 'CIM준비근거.json'), JSON.stringify({ argv: [shell, ...argv], exit: 0,
    startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
    observedPid: Number(result.stdout.trim()), timeoutMs: 10000 }));
}, 15000);

test.skipIf(process.platform !== 'win32')('실제 자기 PID 관측은 한글 argv와 실행 경로의 UTF8 신원을 보존한다', async () => {
  const module = pathToFileURL(resolve('packages/engine/dist/자원/네이티브포스트그레스.js')).href;
  const script = `import { nativePostgresSystemDriver } from ${JSON.stringify(module)}; console.log(JSON.stringify({ expectedPid: process.pid, identity: await nativePostgresSystemDriver.observe(process.pid) }));`;
  const args = ['--input-type=module', '--eval', script, '한글 경로 인코딩 검사'];
  const startedAt = Date.now();
  const result = await promisify(execFile)(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const { expectedPid, identity } = JSON.parse(result.stdout) as { expectedPid: number;
    identity: { pid: number; executable: string; commandLine: string; argv: string[] } };
  expect(identity.pid).toBe(expectedPid);
  expect(identity.executable).toBe(process.execPath);
  expect(identity.commandLine).toContain('한글 경로 인코딩 검사');
  expect(identity.argv).toContain('한글 경로 인코딩 검사');
  await mkdir(workerRoot, { recursive: true });
  await writeFile(join(workerRoot, '한글신원관측근거.json'), JSON.stringify({ argv: [process.execPath, ...args], exit: 0, identity,
    startedAt: new Date(startedAt).toISOString(), checkedAt: new Date().toISOString(), source: module,
    durationMs: Date.now() - startedAt, timeoutMs: 15000 }, null, 2));
});
});

function realProvider(): NativePostgresProvider {
  const binaryRoot = realpathSync.native('C:/Users/ADMIN/AppData/Local/AtelierNote/PostgreSQL17/pgsql/bin');
  return { mode: 'native', binaryRoot, postgresVersion: '17.11', sha256: Object.fromEntries(
    ['initdb', 'pg_ctl', 'postgres'].map(name => [name, sha(readFileSync(join(binaryRoot, `${name}.exe`)))])) as NativePostgresProvider['sha256'] };
}

function newRun(db: ReturnType<typeof connectStore>, directory: string): string {
  const runs = new SQLiteRunStore(db);
  const plan = { project: { id: randomUUID(), name: '네이티브 합성 시험', repositoryIdentity: `synthetic:${randomUUID()}` },
    workspace: { id: randomUUID(), realPath: directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'pg', plannedChecks: ['check'], requiredChecks: ['check'] },
    createdAt: new Date().toISOString() };
  runs.registerPlan(plan);
  const runId = randomUUID();
  runs.admitRun({ projectId: plan.project.id, planId: plan.plan.id, runId, requestId: randomUUID(), requestHash: 'e'.repeat(64), createdAt: new Date().toISOString() });
  return runId;
}

async function fixture(real = false) {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  const rootId = randomUUID();
  const root = join(workerRoot, '자원시험', rootId);
  await mkdir(root, { recursive: true });
  const actualRoot = await realpath(root);
  const marker = join(actualRoot, '시험소유.json');
  const markerBody = JSON.stringify({ rootId, token: randomUUID(), kind: real ? '새네이티브실제시험' : '합성드라이버시험' });
  await writeFile(marker, markerBody, { flag: 'wx', mode: 0o600 });
  const store = new ResourceStore(db);
  const runId = newRun(db, files.directory);
  let retain = false;
  cleanup.push(async () => {
    try {
      const records = (db.prepare('SELECT id FROM resources').all() as { id: string }[]).map(row => store.get(row.id));
      if (records.some(record => record.state !== 'cleaned' || record.cleanup?.verified !== true)) retain = true;
    } catch { retain = true; }
    db.close();
    if (retain) return;
    if (root !== join(workerRoot, '자원시험', rootId) || actualRoot !== root) throw new Error('시험 자원 root의 절대 경계가 다릅니다.');
    for (let part = root; ; part = dirname(part)) {
      if ((await lstat(part)).isSymbolicLink() || await realpath(part) !== part) throw new Error('시험 root의 링크 또는 실제 경로가 다릅니다.');
      if (dirname(part) === part) break;
    }
    const markerInfo = await lstat(marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1 || await readFile(marker, 'utf8') !== markerBody)
      throw new Error('시험 root의 UUID와 소유 표식이 다릅니다.');
    await files.cleanup();
    await rm(actualRoot, { recursive: true });
  });
  return { files, db, root: actualRoot, store, runId, preserve: () => { retain = true; }, real };
}

async function synthetic() {
  const f = await fixture();
  const calls: string[] = [];
  let identity: Awaited<ReturnType<NativePostgresDriver['observe']>> = null;
  let cluster = '';
  let conflict = false;
  let responseLost = false;
  let stopLies = false;
  let portRemains = false;
  let initFailure = '';
  let otherFilePid = false;
  let childRemains = false;
  let grandchildRemains = false;
  const driver: NativePostgresDriver = {
    async command(_provider, binary, args) {
      calls.push(binary);
      if (binary === 'initdb') {
        expect(f.store.list(f.runId)[0]?.state).toBe('creating');
        cluster = args[1]!;
        await mkdir(cluster);
        expect(args).toContain('--no-clean');
        if (initFailure) throw new Error(initFailure);
      }
      if (binary === 'pg_ctl' && !stopLies) { identity = null; await unlink(join(cluster, 'postmaster.pid')); }
    },
    async start(provider, args) {
      calls.push('start');
      identity = { pid: 50001, startedAt: '2026-10-04T00:00:00Z', executable: join(provider.binaryRoot, `postgres${process.platform === 'win32' ? '.exe' : ''}`),
        commandLine: JSON.stringify(args), argv: [join(provider.binaryRoot, `postgres${process.platform === 'win32' ? '.exe' : ''}`), ...args] };
      await writeFile(join(cluster, 'postmaster.pid'), `${otherFilePid ? 50002 : 50001}\n${cluster}\n1791072000\n41001\n\n127.0.0.1\n0\nready\n`);
      if (responseLost) throw new Error('합성 시작 응답 유실');
      return 50001;
    },
    async observe(pid) {
      if (pid === 50003 && childRemains) return { pid: 50003, startedAt: '2026-10-04T00:00:01Z',
        executable: join(fakeProvider.binaryRoot, `postgres${process.platform === 'win32' ? '.exe' : ''}`), commandLine: '합성 자손', argv: ['합성 자손'] };
      return identity;
    }, async freePort() { return 41001; },
    async family(pid) {
      const child = { pid: 50003, startedAt: '2026-10-04T00:00:01Z',
        executable: join(fakeProvider.binaryRoot, `postgres${process.platform === 'win32' ? '.exe' : ''}`), commandLine: '합성 자손', argv: ['합성 자손'] };
      if (pid === 50003 && grandchildRemains && !identity) return [{ ...child, pid: 50004, commandLine: '고아 손자', argv: ['고아 손자'] }];
      return pid === 50001 && (childRemains || grandchildRemains && identity) ? [child] : [];
    },
    async portAbsent() { if (conflict || portRemains) throw new Error('합성 포트 충돌'); },
    async portOwned() { if (conflict) throw new Error('합성 포트 소유 불일치'); },
  };
  const verify = vi.fn((provider: NativePostgresProvider) => provider);
  const native = new NativePostgresResources(f.store, f.root, driver, verify);
  const docker = { command: vi.fn(async () => { throw new Error('Docker에 접근하지 않습니다.'); }), probe: vi.fn() };
  const resources = new DatabaseResources(f.store, docker, native);
  return { ...f, driver, verify, native, resources, calls, docker,
    setConflict: () => { conflict = true; }, loseResponse: () => { responseLost = true; }, lieStop: () => { stopLies = true; }, keepPort: () => { portRemains = true; },
    failInit: (reason: string) => { initFailure = reason; },
    otherFilePid: () => { otherFilePid = true; }, keepChild: () => { childRemains = true; },
    keepGrandchild: () => { grandchildRemains = true; },
    reusePid: () => { identity = { ...identity!, startedAt: '2026-10-04T00:01:00Z' }; } };
}

test('명시적 합성 949 자료는 한글 원바이트와 잘못된 바이트의 엄격한 디코딩을 구분한다', () => {
  const original = Buffer.from('c7d1b1dbb0e6b7ce', 'hex');
  const decoder = new TextDecoder('euc-kr', { fatal: true });
  expect(decoder.decode(original)).toBe('한글경로');
  expect(original.toString('hex')).toBe('c7d1b1dbb0e6b7ce');
  for (const invalid of [[0xc7], [0xff], [0xc7, 0xff]]) expect(() => decoder.decode(Buffer.from(invalid))).toThrow();
});

test.skipIf(process.platform !== 'win32')('실제 PID 파일 reader는 OS 코드 페이지의 표현 가능한 원바이트를 보존하고 BOM 및 손실을 거절한다', async () => {
  const f = await fixture();
  const path = join(f.root, '한글PID.txt');
  const shell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
    $encoding=[System.Text.Encoding]::GetEncoding([System.Text.Encoding]::Default.CodePage,[System.Text.EncoderFallback]::ExceptionFallback,[System.Text.DecoderFallback]::ExceptionFallback);
    $koreanPath='${join(f.root, '한글경로').replaceAll("'", "''")}'; $koreanLossRejected=$false;
    try { $encoding.GetBytes($koreanPath) | Out-Null } catch [System.Text.EncoderFallbackException] { $koreanLossRejected=$true };
    $resourcePath=if ($koreanLossRejected) { 'C:\\synthetic-pid\\cluster' } else { $koreanPath };
    $expected="${process.pid}\n"+$resourcePath+"\n1791072000\n41001\n\n127.0.0.1\n0\nready\n";
    $original=$encoding.GetBytes($expected); if ($encoding.GetString($original) -cne $expected) { throw 'strict-roundtrip' };
    [System.IO.File]::WriteAllBytes('${path.replaceAll("'", "''")}', $original);
    $invalidByteRejected=$false; $singleByteText=$null;
    try { $singleByteText=$encoding.GetString([byte[]]@(0x81)) } catch [System.Text.DecoderFallbackException] { $invalidByteRejected=$true };
    $encoderLossRejected=$false;
    try { $encoding.GetBytes([string][char]0xD800) | Out-Null } catch [System.Text.EncoderFallbackException] { $encoderLossRejected=$true };
    @{codePage=$encoding.CodePage;expected=$expected;koreanLossRejected=$koreanLossRejected;invalidByteRejected=$invalidByteRejected;singleByteText=$singleByteText;encoderLossRejected=$encoderLossRejected} | ConvertTo-Json -Compress`;
  const argv = ['-NoProfile', '-NonInteractive', '-Command', script];
  const result = await promisify(execFile)(shell, argv, { encoding: 'utf8', windowsHide: true });
  const host = JSON.parse(result.stdout) as { codePage: number; expected: string; koreanLossRejected: boolean;
    invalidByteRejected: boolean; singleByteText: string | null; encoderLossRejected: boolean };
  expect(Number.isInteger(host.codePage) && host.codePage > 0).toBe(true);
  expect(host.encoderLossRejected).toBe(true);
  if (host.codePage === 1252) expect(host.koreanLossRejected).toBe(true);
  if (host.codePage === 949) expect(host.koreanLossRejected).toBe(false);
  const original = await readFile(path);
  expect(await nativePostgresSystemDriver.pidFile!(path)).toBe(host.expected);
  expect(await readFile(path)).toEqual(original);
  for (const bom of [[0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff], [0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff]]) {
    await writeFile(path, Buffer.concat([Buffer.from(bom), original]));
    await expect(nativePostgresSystemDriver.pidFile!(path)).rejects.toMatchObject({ stderr: expect.stringContaining('pid-bom') });
  }
  await writeFile(path, Buffer.from([0x81]));
  if (host.invalidByteRejected) await expect(nativePostgresSystemDriver.pidFile!(path)).rejects.toThrow();
  else expect(await nativePostgresSystemDriver.pidFile!(path)).toBe(host.singleByteText);
  expect(await readFile(path)).toEqual(Buffer.from([0x81]));
  await writeFile(path, Buffer.alloc(8192, 0x41));
  expect(await nativePostgresSystemDriver.pidFile!(path)).toBe('A'.repeat(8192));
  await writeFile(path, Buffer.alloc(8193, 0x41));
  await expect(nativePostgresSystemDriver.pidFile!(path)).rejects.toMatchObject({ stderr: expect.stringContaining('pid-size') });
  await writeFile(join(workerRoot, 'PID코드페이지근거.json'), JSON.stringify({ argv: [shell, ...argv], exit: 0, host,
    originalSha256: sha(original), originalBytesPreserved: true, bomRejected: 5, sizeAccepted: 8192, sizeRejected: 8193 }));
});

test('strict 제공자는 누락 Docker를 주입하지 않고 잘못된 mode와 start 덮어쓰기를 거절한다', () => {
  expect(resourceProviderSchema.parse({ mode: 'docker' })).toEqual({ mode: 'docker' });
  for (const input of [{ mode: 'automatic' }, { ...fakeProvider, extra: true }, { ...fakeProvider, binaryRoot: 'relative' },
    { ...fakeProvider, sha256: { ...fakeProvider.sha256, postgres: 'bad' } }]) expect(resourceProviderSchema.safeParse(input).success).toBe(false);
  const command = { id: 'run', title: '합성 검사', runtime: 'node' as const, entry: 'tests/run.mjs', args: [], timeoutMs: 1000, env: {}, writes: [], resultFormat: 'ndjson' as const };
  const project = { schemaVersion: 1, id: randomUUID(), name: '합성 검사', repositoryIdentity: 'synthetic:provider', commands: [command], profiles: [] };
  expect(projectDefinitionSchema.parse(project).commands[0]).not.toHaveProperty('resourceProvider');
  expect(projectDefinitionSchema.safeParse({ ...project, commands: [{ ...command, resources: ['mysql-test'], resourceProvider: fakeProvider }] }).success).toBe(false);
  expect(apiInputs.start.safeParse({ projectId: randomUUID(), planId: randomUUID(), resourceProvider: fakeProvider }).success).toBe(false);
  expect(nativePostgresProviderSchema.parse(fakeProvider)).toEqual(fakeProvider);
});

test('선택 제공자는 혼합 모드와 서로 다른 native 구성 및 PG 외 자원을 거절한다', () => {
  const pg = { resources: ['postgres-test'] as ['postgres-test'], resourceProvider: fakeProvider };
  expect(selectedResourceProvider([pg, pg])).toEqual(fakeProvider);
  for (const other of [{ resources: ['postgres-test'] as ['postgres-test'] },
    { ...pg, resourceProvider: { ...fakeProvider, postgresVersion: '17.10' } },
    { ...pg, resourceProvider: { ...fakeProvider, sha256: { ...fakeProvider.sha256, initdb: 'd'.repeat(64) } } },
    { resources: ['mysql-test'] as ['mysql-test'], resourceProvider: fakeProvider }])
    expect(() => selectedResourceProvider([pg, other])).toThrow();
});

test('intent 선행과 실제 신원 기록 및 종료·포트·자료 세 근거가 모두 있어야 정리된다', async () => {
  const f = await synthetic();
  const prepared = await f.resources.prepare(f.runId, '합성소유토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  expect(JSON.parse(prepared.environment.CHECKMATE_PG_CONNECTION_JSON!).database).toBe('respiro_test');
  expect(f.verify).toHaveBeenCalled();
  const ready = f.store.list(f.runId)[0]!;
  expect(ready.descriptor.process?.pid).toBe(50001);
  expect(() => f.store.update(ready.id, ['ready'], { ...ready, descriptor: { ...ready.descriptor, hostPort: 42001 } })).toThrow();
  expect(() => f.store.update(ready.id, ['ready'], { ...ready, state: 'cleaned', cleanup: { verified: true, checkedAt: new Date().toISOString(), reason: 'pg_ctl만 성공' } })).toThrow();
  const result = await f.resources.cleanup(f.runId);
  expect(result.verified).toBe(true);
  expect(result.resources[0]?.descriptor.cleanupProof).toEqual({ processExited: true, descendantsExited: true, descendants: [], portAbsent: true, directoryAbsent: true });
  expect(f.docker.command).not.toHaveBeenCalled();
});

test.each(['marker', 'row-owner', 'pid', 'binding', 'binary', 'path', 'restart', 'version-race'] as const)('%s 소유 불일치에서는 정지 명령과 자료 삭제가 없다', async fault => {
  const f = await synthetic();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  const ready = f.store.list(f.runId)[0]!;
  if (fault === 'marker') await writeFile(join(ready.descriptor.resourcePath!, '소유.json'), '다른 표식');
  if (fault === 'row-owner') f.db.prepare('UPDATE resources SET owner_token_hash=? WHERE id=?').run('d'.repeat(64), ready.id);
  if (fault === 'pid') f.reusePid();
  if (fault === 'binding') await writeFile(join(ready.descriptor.clusterPath!, 'postmaster.pid'), '다른 PID');
  if (fault === 'binary') f.verify.mockImplementation(() => { throw new Error('binary 바뀜'); });
  if (fault === 'version-race') { let checks = 0; f.verify.mockImplementation(provider => { if (++checks === 2) f.reusePid(); return provider; }); }
  if (fault === 'path') f.db.prepare('UPDATE resources SET descriptor_json=? WHERE id=?').run(JSON.stringify({ ...ready.descriptor, resourcePath: f.files.directory }), ready.id);
  if (fault === 'restart') await new DatabaseResources(f.store, f.docker, new NativePostgresResources(f.store, f.root, f.driver, f.verify)).cleanup(f.runId);
  const result = fault === 'path' ? await f.resources.cleanup(f.runId).catch(() => ({ verified: false })) : await f.resources.cleanup(f.runId);
  expect(result.verified).toBe(false);
  expect(f.calls).not.toContain('pg_ctl');
  expect(await readFile(join(ready.descriptor.resourcePath!, '소유.json'), 'utf8')).toBeTruthy();
});

test.each(['family-marker', 'family-binary', 'final-pid', 'final-port', 'final-observe'] as const)('%s 관측 중 소유 변경은 정지 명령 없이 자원을 보존한다', async fault => {
  const f = await synthetic();
  f.preserve();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  const ready = f.store.list(f.runId)[0]!;
  const markerPath = join(ready.descriptor.resourcePath!, '소유.json');
  let afterFamily = false;
  const family = f.driver.family.bind(f.driver);
  f.driver.family = async pid => {
    const children = await family(pid);
    afterFamily = true;
    if (fault === 'family-marker') await writeFile(markerPath, '자손 관측 중 바뀐 합성 표식');
    if (fault === 'family-binary') f.verify.mockImplementation(() => { throw new Error('자손 관측 중 binary 변경'); });
    return children;
  };
  const pidFile = (path: string) => readFile(path, 'utf8');
  f.driver.pidFile = async path => {
    const text = await pidFile(path);
    if (afterFamily && fault === 'final-pid') await writeFile(markerPath, '마지막 PID 관측 중 바뀐 합성 표식');
    return text;
  };
  const portOwned = f.driver.portOwned.bind(f.driver);
  f.driver.portOwned = async (port, pid) => {
    await portOwned(port, pid);
    if (afterFamily && fault === 'final-port') await writeFile(markerPath, '마지막 포트 관측 중 바뀐 합성 표식');
  };
  const observe = f.driver.observe.bind(f.driver);
  f.driver.observe = async pid => {
    const identity = await observe(pid);
    if (afterFamily && fault === 'final-observe') await writeFile(markerPath, '마지막 신원 관측 중 바뀐 합성 표식');
    return identity;
  };
  f.verify.mockClear();
  const result = await f.resources.cleanup(f.runId);
  const markerAfter = await readFile(markerPath, 'utf8');
  if (process.env.CHECKMATE_P2_EVIDENCE_ROOT) await writeFile(join(process.env.CHECKMATE_P2_EVIDENCE_ROOT, `네이티브-${fault}.json`), JSON.stringify({
    utc: new Date().toISOString(), fixture: f.files.directory, root: f.root, runId: f.runId, fault, calls: f.calls,
    result, markerAfter, resourceDirectoryPresent: (await lstat(ready.descriptor.resourcePath!)).isDirectory(), retained: true,
  }, null, 2));
  expect(f.calls).not.toContain('pg_ctl');
  expect(result.verified).toBe(false);
  expect(f.store.list(f.runId)[0]).toMatchObject({ state: 'uncertain', cleanup: { verified: false } });
  expect((await lstat(ready.descriptor.resourcePath!)).isDirectory()).toBe(true);
});

test.each(['native', 'forward-slash'] as const)('%s PID 경로의 정확 표기는 합성 정리를 허용한다', async format => {
  const f = await synthetic();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  const ready = f.store.list(f.runId)[0]!;
  const path = join(ready.descriptor.clusterPath!, 'postmaster.pid');
  const parts = (await readFile(path, 'utf8')).split('\n');
  parts[1] = format === 'native' ? ready.descriptor.clusterPath! : ready.descriptor.clusterPath!.replaceAll('\\', '/');
  await writeFile(path, parts.join('\n'));
  const result = await f.resources.cleanup(f.runId);
  if (process.env.CHECKMATE_P2_EVIDENCE_ROOT) await writeFile(join(process.env.CHECKMATE_P2_EVIDENCE_ROOT, `PID-${format}.json`), JSON.stringify({
    utc: new Date().toISOString(), fixture: f.files.directory, root: f.root, runId: f.runId, format, pidPath: parts[1], calls: f.calls, result,
  }, null, 2));
  expect(result.verified).toBe(true);
  expect(f.calls.filter(binary => binary === 'pg_ctl')).toHaveLength(1);
  await expect(lstat(ready.descriptor.resourcePath!)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['dotdot', 'dot', 'duplicate', 'case', 'other', 'relative', 'space'] as const)('%s PID 경로 별칭은 정지 명령 없이 원문과 자료를 보존한다', async alias => {
  const f = await synthetic();
  f.preserve();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  const ready = f.store.list(f.runId)[0]!;
  const cluster = ready.descriptor.clusterPath!;
  const separator = process.platform === 'win32' ? '\\' : '/';
  const path = join(cluster, 'postmaster.pid');
  const parts = (await readFile(path, 'utf8')).split('\n');
  parts[1] = alias === 'dotdot' ? `${cluster}${separator}..${separator}cluster`
    : alias === 'dot' ? `${dirname(cluster)}${separator}.${separator}cluster`
    : alias === 'duplicate' ? `${dirname(cluster)}${separator}${separator}cluster`
    : alias === 'case' ? `${cluster.slice(0, -7)}CLUSTER`
    : alias === 'other' ? `${cluster}-other`
    : alias === 'relative' ? 'cluster' : ` ${cluster} `;
  const originalPid = parts.join('\n');
  await writeFile(path, originalPid);
  const originalMarker = await readFile(join(ready.descriptor.resourcePath!, '소유.json'), 'utf8');
  const result = await f.resources.cleanup(f.runId);
  const pidAfter = await readFile(path, 'utf8').catch(() => null);
  const markerAfter = await readFile(join(ready.descriptor.resourcePath!, '소유.json'), 'utf8').catch(() => null);
  if (process.env.CHECKMATE_P2_EVIDENCE_ROOT) await writeFile(join(process.env.CHECKMATE_P2_EVIDENCE_ROOT, `PID-${alias}.json`), JSON.stringify({
    utc: new Date().toISOString(), fixture: f.files.directory, root: f.root, runId: f.runId, alias, originalPid, pidAfter, originalMarker, markerAfter, calls: f.calls, result, retained: true,
  }, null, 2));
  expect(f.calls).not.toContain('pg_ctl');
  expect(result.verified).toBe(false);
  expect(f.store.list(f.runId)[0]).toMatchObject({ state: 'uncertain', cleanup: { verified: false } });
  expect(pidAfter).toBe(originalPid);
  expect(markerAfter).toBe(originalMarker);
});

test.each(['response', 'conflict', 'binary-before', 'initdb-failure', 'initdb-timeout'] as const)('%s 준비 실패는 자동 fallback·정리·재요청 없이 보존한다', async fault => {
  const f = await synthetic();
  if (fault === 'response') f.loseResponse();
  if (fault === 'conflict') f.setConflict();
  if (fault === 'binary-before') f.verify.mockImplementation(() => { throw new Error('계획 후 binary 바뀜'); });
  if (fault.startsWith('initdb-')) f.failInit(fault);
  await expect(f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider)).rejects.toThrow();
  if (fault !== 'binary-before') {
    expect((await f.resources.cleanup(f.runId)).verified).toBe(false);
    expect(f.store.list(f.runId)[0]?.state).toBe('uncertain');
    if (fault.startsWith('initdb-')) expect(await readFile(join(f.store.list(f.runId)[0]!.descriptor.resourcePath!, '초기암호.txt'), 'utf8')).toBeTruthy();
  } else expect(f.store.list(f.runId)).toEqual([]);
  expect(f.calls).not.toContain('pg_ctl');
  expect(f.docker.command).not.toHaveBeenCalled();
});

test('pg_ctl 성공이어도 포트가 남으면 자료를 보존하고 cleanupVerified를 거절한다', async () => {
  const f = await synthetic();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  f.keepPort();
  expect((await f.resources.cleanup(f.runId)).verified).toBe(false);
  expect(f.calls).toContain('pg_ctl');
  expect(f.store.list(f.runId)[0]?.state).toBe('uncertain');
});

test('pg_ctl 성공 응답이어도 실제 프로세스가 남으면 자료를 보존한다', async () => {
  const f = await synthetic();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  f.lieStop();
  expect((await f.resources.cleanup(f.runId)).verified).toBe(false);
  expect(f.store.list(f.runId)[0]?.descriptor.cleanupProof).toBeUndefined();
});

test('실제 시작 PID와 다른 postmaster.pid는 ready로 채택하지 않는다', async () => {
  const f = await synthetic();
  f.otherFilePid();
  await expect(f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider)).rejects.toThrow();
  expect(f.store.list(f.runId)[0]?.state).toBe('uncertain');
  expect(f.store.list(f.runId)[0]?.descriptor.process).toBeUndefined();
  expect((await f.resources.cleanup(f.runId)).verified).toBe(false);
  expect(f.calls).not.toContain('pg_ctl');
}, 20000);

test('main 종료 이후에도 postgres 자손이 남으면 자료 삭제와 정리 완료를 거절한다', async () => {
  const f = await synthetic();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  f.keepChild();
  expect((await f.resources.cleanup(f.runId)).verified).toBe(false);
  expect(await readFile(join(f.store.list(f.runId)[0]!.descriptor.resourcePath!, '소유.json'), 'utf8')).toBeTruthy();
});

test('관측 child 종료 뒤 그 PPID에 늦게 남은 고아 손자는 삭제를 차단한다', async () => {
  const f = await synthetic();
  await f.resources.prepare(f.runId, '합성토큰', new AbortController().signal, ['postgres-test'], fakeProvider);
  f.keepGrandchild();
  expect((await f.resources.cleanup(f.runId)).verified).toBe(false);
  expect(f.calls).toContain('pg_ctl');
  expect(await readFile(join(f.store.list(f.runId)[0]!.descriptor.resourcePath!, '소유.json'), 'utf8')).toBeTruthy();
});

test('비지원 host의 default driver는 binary 관측과 intent 및 시작 전에 거절한다', async () => {
  const f = await fixture();
  const verify = vi.fn((provider: NativePostgresProvider) => provider);
  const native = new NativePostgresResources(f.store, f.root, nativePostgresSystemDriver, verify);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    await expect(native.prepare(f.runId, '합성토큰', new AbortController().signal, fakeProvider)).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(f.store.list(f.runId)).toEqual([]);
  } finally { Object.defineProperty(process, 'platform', original); }
});

test.skipIf(process.env.CHECKMATE_NATIVE_PG_TEST !== '1')('실제 새 PG17.11 클러스터 두 개는 독립 port와 process로 동시에 실행하고 정리한다', async () => {
  const f = await fixture(true);
  const provider = verifyNativePostgresProvider(realProvider());
  const secondWorkspace = join(f.files.directory, '두번째실행');
  await mkdir(secondWorkspace);
  const runIds = [f.runId, newRun(f.db, secondWorkspace)];
  const commands: unknown[] = [];
  const driver: NativePostgresDriver = { ...nativePostgresSystemDriver,
    async command(config, binary, args, options) {
      const startedAt = new Date().toISOString();
      try { await nativePostgresSystemDriver.command(config, binary, args, options); commands.push({ binary, args, startedAt, exit: 0 }); }
      catch (error) { commands.push({ binary, args, startedAt, exit: null, error: String(error) }); throw error; }
    },
    async start(config, args, log) { const pid = await nativePostgresSystemDriver.start(config, args, log); commands.push({ binary: 'postgres', args, log, pid }); return pid; },
  };
  const native = new NativePostgresResources(f.store, f.root, driver);
  const resources = new DatabaseResources(f.store, undefined, native);
  let ready: ResourceRecord[] = [];
  let cleaned: unknown[] = [];
  let prepareFailures: unknown[] = [];
  try {
    const prepared = await Promise.allSettled(runIds.map(runId => resources.prepare(runId, randomUUID(), new AbortController().signal, ['postgres-test'], provider)));
    prepareFailures = prepared.flatMap((result, index) => result.status === 'rejected' ? [{ runId: runIds[index],
      reason: result.reason instanceof Error ? { name: result.reason.name, message: result.reason.message === '네이티브 PostgreSQL 전용 자원 준비를 확인하지 못했습니다.'
        ? result.reason.message : '준비 예외 상세는 공개하지 않습니다.' } : { name: 'unknown', message: '준비 예외 형식 미확인' } }] : []);
    expect(prepared.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    ready = runIds.map(runId => f.store.list(runId)[0]!);
    expect(new Set(ready.map(record => record.descriptor.hostPort)).size).toBe(2);
    expect(new Set(ready.map(record => record.descriptor.process?.pid)).size).toBe(2);
    for (const record of ready) {
      expect(record.state).toBe('ready');
      await driver.portOwned(record.descriptor.hostPort!, record.descriptor.process!.pid);
    }
    cleaned = await Promise.all(runIds.map(runId => resources.cleanup(runId)));
    expect(cleaned.every(value => (value as { verified: boolean }).verified)).toBe(true);
  } finally {
    const remaining = runIds.flatMap(runId => f.store.list(runId));
    if (remaining.some(record => record.state !== 'cleaned')) f.preserve();
    await appendFile(join(workerRoot, '실제PG근거.jsonl'), JSON.stringify({ provider, resourceRoot: f.root,
      dataRoot: f.files.directory, lockRoot: process.env.CHECKMATE_LOCK_DIR, commands, prepareFailures, ready, cleaned, remaining }) + '\n');
  }
}, 120000);
