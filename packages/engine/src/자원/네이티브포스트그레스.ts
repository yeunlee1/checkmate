// 동결한 PostgreSQL 실행 파일로 전용 합성 클러스터를 만들고 소유가 확인된 자원만 정리한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { nativePostgresProviderSchema, type NativePostgresProvider } from '@checkmate/contracts/resources';
import type { NativeResourceDescriptor, ResourceRecord, ResourceStore } from '../저장/자원저장.js';
import { nativeProcessIdentitySchema } from '../저장/자원저장.js';
import { z } from 'zod';
import { databaseConnection } from './데이터베이스종류.js';

const execute = promisify(execFile);
const names = ['initdb', 'pg_ctl', 'postgres'] as const;
type Binary = typeof names[number];
type Identity = Omit<NonNullable<NativeResourceDescriptor['process']>, 'postmasterStart'>;
type CommandOptions = { signal?: AbortSignal; input?: string };
export interface NativePostgresDriver {
  command(provider: NativePostgresProvider, binary: Binary, args: string[], options?: CommandOptions): Promise<void>;
  start(provider: NativePostgresProvider, args: string[], log: string): Promise<number>;
  observe(pid: number): Promise<Identity | null>;
  family(pid: number): Promise<Identity[]>;
  pidFile?(path: string): Promise<string>;
  freePort(): Promise<number>;
  portAbsent(port: number): Promise<void>;
  portOwned(port: number, pid: number): Promise<void>;
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const binaryPath = (provider: NativePostgresProvider, name: Binary) => join(provider.binaryRoot, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const safeEnvironment = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
const markerSchema = z.strictObject({ runId: z.uuid(), resourceId: z.uuid(), ownerTokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  binaries: nativePostgresProviderSchema, nonce: z.uuid() });

function observedIdentity(input: unknown): Identity {
  const item = input as Record<string, unknown>;
  if (!item || typeof item.commandLine !== 'string') throw new Error('프로세스 관측이 불명확합니다.');
  const argv = [...item.commandLine.matchAll(/"([^"\r\n]*)"|([^\s"]+)/gu)].map(match => match[1] ?? match[2]!);
  return nativeProcessIdentitySchema.parse({ ...item, argv });
}

function actualPath(path: string, directory: boolean): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('정규 절대 실제 경로가 필요합니다.');
  for (let part = path; ; part = dirname(part)) {
    const stat = lstatSync(part);
    if (stat.isSymbolicLink() || (part !== path && !stat.isDirectory())) throw new Error('링크 경로를 허용하지 않습니다.');
    if (dirname(part) === part) break;
  }
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || realpathSync.native(path) !== path)
    throw new Error('실제 경로와 등록 경로가 다릅니다.');
  return path;
}

export function verifyNativePostgresProvider(input: NativePostgresProvider): NativePostgresProvider {
  const provider = nativePostgresProviderSchema.parse(input);
  actualPath(provider.binaryRoot, true);
  for (const name of names) {
    const path = actualPath(binaryPath(provider, name), false);
    if (sha(readFileSync(path)) !== provider.sha256[name]) throw new Error('등록 실행 파일 지문이 바뀌었습니다.');
    const output = execFileSync(path, ['--version'], { encoding: 'utf8', env: safeEnvironment(), windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    if (!new RegExp(`^${name} \\(PostgreSQL\\) ${provider.postgresVersion.replaceAll('.', '\\.')}\\s*$`, 'u').test(output))
      throw new Error('등록 PostgreSQL 버전이 다릅니다.');
    if (sha(readFileSync(actualPath(path, false))) !== provider.sha256[name]) throw new Error('버전 확인 중 실행 파일이 바뀌었습니다.');
  }
  return provider;
}

function bindPort(port: number): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('시험 포트를 확인하지 못했습니다.')); return; }
      server.close(error => error ? reject(error) : accept(address.port));
    });
  });
}

async function powershell(script: string): Promise<string> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) throw new Error('네이티브 소유 관측은 Windows에서 지원합니다.');
  const path = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // 제한 환경의 자동 모듈 검색을 피하고 실행한 Windows PowerShell의 기본 모듈만 읽는다.
  const modules = ['Microsoft.PowerShell.Utility', 'CimCmdlets'].map(name =>
    `Import-Module ($PSHOME + '\\Modules\\${name}\\${name}.psd1') -ErrorAction Stop;`).join(' ');
  return (await execute(path, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${modules} ${script}`],
    { env: safeEnvironment(), windowsHide: true, timeout: 10000, maxBuffer: 65536 })).stdout;
}

export const nativePostgresSystemDriver: NativePostgresDriver = {
  async pidFile(path) {
    // Windows PostgreSQL의 경로 바이트는 OS 활성 코드 페이지로 읽고 잘못된 바이트는 거절한다.
    const text: unknown = JSON.parse(await powershell(`$bytes=[System.IO.File]::ReadAllBytes('${path.replaceAll("'", "''")}');
      if ($bytes.Length -gt 8192) { throw 'pid-size' };
      if (($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) -or ($bytes.Length -ge 2 -and (($bytes[0] -eq 255 -and $bytes[1] -eq 254) -or ($bytes[0] -eq 254 -and $bytes[1] -eq 255))) -or ($bytes.Length -ge 4 -and $bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 254 -and $bytes[3] -eq 255)) { throw 'pid-bom' };
      $encoding=[System.Text.Encoding]::GetEncoding([System.Text.Encoding]::Default.CodePage,[System.Text.EncoderFallback]::ExceptionFallback,[System.Text.DecoderFallback]::ExceptionFallback);
      $value=$encoding.GetString($bytes);
      if ([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($encoding.GetBytes($value))) { throw 'pid-roundtrip' };
      ConvertTo-Json -Compress -InputObject $value`));
    if (typeof text !== 'string') throw new Error('PID 파일 인코딩 관측이 불명확합니다.');
    return text;
  },
  async command(provider, binary, args, options) {
    const pending = execute(binaryPath(provider, binary), args, { env: safeEnvironment(), windowsHide: true,
      timeout: 60000, maxBuffer: 1024 * 1024, ...(options?.signal ? { signal: options.signal } : {}) });
    pending.child.stdin?.on('error', () => {});
    pending.child.stdin?.end(options?.input);
    await pending;
  },
  async start(provider, args, log) {
    const file = await open(log, 'wx', 0o600);
    try {
      return await new Promise<number>((accept, reject) => {
        const child = spawn(binaryPath(provider, 'postgres'), args, { env: safeEnvironment(), windowsHide: true,
          shell: false, stdio: ['ignore', file.fd, file.fd] });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); accept(child.pid!); });
      });
    } finally { await file.close(); }
  },
  async observe(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('PID가 올바르지 않습니다.');
    const text = await powershell(`$item=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($null -eq $item) { 'null' } else { @{pid=[int]$item.ProcessId;startedAt=$item.CreationDate.ToUniversalTime().ToString('o');executable=$item.ExecutablePath;commandLine=$item.CommandLine} | ConvertTo-Json -Compress }`);
    const value: unknown = JSON.parse(text);
    if (!value) return null;
    return observedIdentity(value);
  },
  async family(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('PID가 올바르지 않습니다.');
    const text = await powershell(`$queue=New-Object 'System.Collections.Generic.Queue[int]'; $queue.Enqueue(${pid}); $seen=@{}; $items=@(); while ($queue.Count -gt 0) { $parent=$queue.Dequeue(); foreach ($item in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $parent))) { $id=[int]$item.ProcessId; if ($seen.ContainsKey($id)) { throw 'process-cycle' }; $seen[$id]=$true; if ($seen.Count -gt 128) { throw 'process-limit' }; $queue.Enqueue($id); $items+=@{pid=$id;startedAt=$item.CreationDate.ToUniversalTime().ToString('o');executable=$item.ExecutablePath;commandLine=$item.CommandLine} } }; ConvertTo-Json -Compress -InputObject @($items)`);
    const items: unknown = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error('자손 프로세스 관측이 불명확합니다.');
    return items.map(observedIdentity);
  },
  freePort: () => bindPort(0),
  async portAbsent(port) { await bindPort(port); },
  async portOwned(port, pid) {
    const value: unknown = JSON.parse(await powershell(`Import-Module ($PSHOME + '\\Modules\\NetTCPIP\\NetTCPIP.psd1') -ErrorAction Stop; ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object LocalAddress,OwningProcess)`));
    if (!Array.isArray(value) || value.length !== 1 || value[0]?.LocalAddress !== '127.0.0.1' || value[0]?.OwningProcess !== pid)
      throw new Error('전용 loopback 포트의 프로세스 소유가 다릅니다.');
  },
};

async function durableFile(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error; }
}

async function checkedTree(path: string): Promise<void> {
  actualPath(path, true);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await checkedTree(child);
    else actualPath(child, false);
  }
}

export class NativePostgresResources {
  private readonly live = new Set<string>();
  private readonly preparing = new Set<string>();
  constructor(private readonly store: ResourceStore, readonly resourceRoot: string,
    private readonly driver: NativePostgresDriver = nativePostgresSystemDriver,
    private readonly verifyProvider = verifyNativePostgresProvider) {}

  private async ownership(record: ResourceRecord): Promise<NativeResourceDescriptor> {
    const descriptor = record.descriptor;
    if (descriptor.provider !== 'native' || descriptor.resourceRoot !== this.resourceRoot
      || descriptor.resourcePath !== join(this.resourceRoot, record.runId, record.id)
      || descriptor.clusterPath !== join(descriptor.resourcePath, 'cluster')) throw new Error('전용 자원 경로가 다릅니다.');
    actualPath(this.resourceRoot, true);
    actualPath(descriptor.resourcePath, true);
    const marker = actualPath(join(descriptor.resourcePath, '소유.json'), false);
    const bytes = await readFile(marker);
    const value = markerSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (sha(bytes) !== descriptor.markerSha256 || value.runId !== record.runId || value.resourceId !== record.id
      || value.ownerTokenHash !== record.ownerTokenHash || !isDeepStrictEqual(value.binaries, descriptor.binaries))
      throw new Error('전용 자원 표식과 저장 소유 정보가 다릅니다.');
    this.verifyProvider(descriptor.binaries);
    return descriptor;
  }

  private async pidBinding(descriptor: NativeResourceDescriptor, expectedPid: number): Promise<number> {
    actualPath(descriptor.clusterPath, true);
    const path = actualPath(join(descriptor.clusterPath, 'postmaster.pid'), false);
    const text = this.driver.pidFile ? await this.driver.pidFile(path) : await readFile(path, 'utf8');
    const parts = text.trim().split(/\r?\n/u);
    const pid = Number(parts[0]);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid !== expectedPid
      || (parts[1] !== descriptor.clusterPath && (process.platform !== 'win32' || parts[1] !== descriptor.clusterPath.replaceAll('\\', '/')))
      || Number(parts[3]) !== descriptor.hostPort || parts[5]?.trim() !== '127.0.0.1'
      || parts[7]?.trim() !== 'ready' || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) < 1)
      throw new Error('실제 클러스터와 PID 및 포트의 연결이 다릅니다.');
    if (descriptor.process && (descriptor.process.pid !== pid || descriptor.process.postmasterStart !== Number(parts[2])))
      throw new Error('PID가 재사용되었거나 클러스터 시작 신원이 다릅니다.');
    return Number(parts[2]);
  }

  async prepare(runId: string, ownerToken: string, signal: AbortSignal, input: NativePostgresProvider): Promise<{ environment: Record<string, string>; secrets: string[] }> {
    if (this.driver === nativePostgresSystemDriver && process.platform !== 'win32') throw new Error('이 호스트는 네이티브 PostgreSQL 소유 관측을 지원하지 않습니다.');
    if (this.preparing.has(runId) || this.store.list(runId).length) throw new Error('같은 실행의 자원이 이미 준비되었거나 기록됐습니다.');
    this.preparing.add(runId);
    let record: ResourceRecord | undefined;
    try {
      const provider = this.verifyProvider(input);
      actualPath(this.resourceRoot, true);
      if (signal.aborted) throw new Error('네이티브 준비가 취소됐습니다.');
      const id = randomUUID();
      const resourcePath = join(this.resourceRoot, runId, id);
      const marker = JSON.stringify({ runId, resourceId: id, ownerTokenHash: sha(ownerToken), binaries: provider, nonce: randomUUID() });
      const descriptor: NativeResourceDescriptor = { provider: 'native', version: 1, name: `cm-pg-${runId}-${id}`,
        resourceRoot: this.resourceRoot, resourcePath, clusterPath: join(resourcePath, 'cluster'),
        markerSha256: sha(marker), binaries: provider, hostPort: await this.driver.freePort() };
      record = { id, runId, kind: 'postgres-test', ownerTokenHash: sha(ownerToken), state: 'intent', descriptor, cleanup: null };
      // SQLite 생성 의도를 기록하기 전에는 파일과 DB 프로세스를 만들지 않는다.
      this.store.intent(record);
      record = this.store.update(id, ['intent'], { ...record, state: 'creating' });
      await mkdir(join(this.resourceRoot, runId), { mode: 0o700 });
      await mkdir(resourcePath, { mode: 0o700 });
      await durableFile(join(resourcePath, '소유.json'), marker);
      await this.ownership(record);
      const password = `Cm9${randomBytes(24).toString('hex')}zA`;
      const passwordFile = join(resourcePath, '초기암호.txt');
      await durableFile(passwordFile, password + '\n');
      await this.driver.command(provider, 'initdb', ['-D', descriptor.clusterPath, '--username=respiro_test', '--encoding=UTF8',
        '--no-locale', '--no-clean', '--auth=scram-sha-256', `--pwfile=${passwordFile}`], { signal });
      // 응답 불명에서는 늦은 initdb가 아직 읽을 수 있으므로 암호파일도 보존한다.
      await unlink(passwordFile);
      // 기존 연결 환경 계약의 합성 DB 이름만 전용 클러스터 안에 만든다.
      await this.driver.command(provider, 'postgres', ['--single', '-D', descriptor.clusterPath, 'template1'],
        { signal, input: 'CREATE DATABASE respiro_test;\n' });
      await this.driver.command(provider, 'postgres', ['--single', '-D', descriptor.clusterPath, 'respiro_test'],
        { signal, input: 'SELECT 1;\n' });
      await this.ownership(record);
      if (signal.aborted) throw new Error('네이티브 준비가 취소됐습니다.');
      await this.driver.portAbsent(descriptor.hostPort);
      const args = ['-D', descriptor.clusterPath, '-h', '127.0.0.1', '-p', String(descriptor.hostPort),
        '-c', 'unix_socket_directories=', '-c', 'ssl=off'];
      const pid = await this.driver.start(provider, args, join(resourcePath, '서버.log'));
      let identity: Identity | null = null;
      let start = 0;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (signal.aborted) throw new Error('네이티브 준비가 취소됐습니다.');
        try {
          start = await this.pidBinding(descriptor, pid);
          identity = await this.driver.observe(pid);
          if (!identity || identity.pid !== pid || identity.executable !== binaryPath(provider, 'postgres')
            || !isDeepStrictEqual(identity.argv, [binaryPath(provider, 'postgres'), ...args])) throw new Error('실제 프로세스 신원이 다릅니다.');
          await this.driver.portOwned(descriptor.hostPort, pid);
          break;
        } catch { identity = null; await new Promise(accept => setTimeout(accept, 250)); }
      }
      if (!identity) throw new Error('네이티브 프로세스 시작과 포트 소유를 확인하지 못했습니다.');
      record = this.store.update(id, ['creating'], { ...record, state: 'created', descriptor: { ...descriptor, process: { ...identity, postmasterStart: start } } });
      record = this.store.update(id, ['created'], { ...record, state: 'ready' });
      this.live.add(id);
      return databaseConnection('postgres-test', descriptor.hostPort, password);
    } catch {
      if (record && record.state !== 'intent') {
        try { this.store.update(record.id, [record.state], { ...record, state: 'uncertain' }); } catch { /* 원래 기록을 보존한다. */ }
      }
      throw new Error('네이티브 PostgreSQL 전용 자원 준비를 확인하지 못했습니다.');
    } finally { this.preparing.delete(runId); }
  }

  async cleanupResource(initial: ResourceRecord): Promise<void> {
    let record = initial;
    try {
      if (!this.live.has(record.id) || !['created', 'ready'].includes(record.state)) throw new Error('재시작 또는 준비 응답 유실의 소유 상태를 보존합니다.');
      const descriptor = await this.ownership(record);
      const expected = descriptor.process;
      if (!expected) throw new Error('실제 프로세스 시작 근거가 없습니다.');
      const actual = await this.driver.observe(expected.pid);
      if (actual) {
        const { postmasterStart: _start, ...identity } = expected;
        if (!isDeepStrictEqual(actual, identity)) throw new Error('PID와 프로세스 시작 신원이 다릅니다.');
        await this.pidBinding(descriptor, expected.pid);
        await this.driver.portOwned(descriptor.hostPort, expected.pid);
      }
      const descendants = await this.driver.family(expected.pid);
      if (descendants.some(child => child.executable !== expected.executable)) throw new Error('자손 프로세스의 실행 파일 소유를 확인하지 못했습니다.');
      if (actual) {
        const { postmasterStart: _start, ...identity } = expected;
        // 자손 조회 이후 등록 실행 파일과 소유 표식을 다시 확인한다.
        await this.ownership(record);
        // binary 버전 관측과 자손 조회 이후 정지 직전의 신원을 다시 결합한다.
        await this.pidBinding(descriptor, expected.pid);
        await this.driver.portOwned(descriptor.hostPort, expected.pid);
        if (!isDeepStrictEqual(await this.driver.observe(expected.pid), identity)) throw new Error('정지 직전에 프로세스 신원이 바뀌었습니다.');
        // 마지막 비동기 관측 중 바뀐 표식도 정지 명령 전에 동기로 거절한다.
        actualPath(this.resourceRoot, true);
        actualPath(descriptor.resourcePath, true);
        const marker = actualPath(join(descriptor.resourcePath, '소유.json'), false);
        if (sha(readFileSync(marker)) !== descriptor.markerSha256) throw new Error('정지 직전에 전용 자원 표식이 바뀌었습니다.');
        await this.driver.command(descriptor.binaries, 'pg_ctl', ['stop', '-D', descriptor.clusterPath, '-m', 'fast', '-w', '-t', '30']);
      }
      for (let attempt = 0; attempt < 20 && await this.driver.observe(expected.pid); attempt++)
        await new Promise(accept => setTimeout(accept, 250));
      if (await this.driver.observe(expected.pid)) throw new Error('프로세스 종료를 확인하지 못했습니다.');
      for (const child of descendants) {
        for (let attempt = 0; attempt < 20 && await this.driver.observe(child.pid); attempt++)
          await new Promise(accept => setTimeout(accept, 250));
        if (await this.driver.observe(child.pid)) throw new Error('자손 프로세스 종료를 확인하지 못했습니다.');
      }
      for (const ancestor of [expected.pid, ...descendants.map(child => child.pid)])
        if ((await this.driver.family(ancestor)).length) throw new Error('정리 뒤 자손 또는 고아 손자 프로세스가 남아 있습니다.');
      await this.driver.portAbsent(descriptor.hostPort);
      if (!await absent(join(descriptor.clusterPath, 'postmaster.pid'))) throw new Error('클러스터 PID 기록이 남아 있습니다.');
      await this.ownership(record);
      await checkedTree(descriptor.resourcePath);
      // 자료 삭제 직전에도 프로세스와 포트 부재를 긍정 확인한다.
      if (await this.driver.observe(expected.pid)) throw new Error('삭제 전 PID가 재사용되었습니다.');
      for (const ancestor of [expected.pid, ...descendants.map(child => child.pid)])
        if ((await this.driver.family(ancestor)).length) throw new Error('삭제 전 자손 또는 고아 손자 프로세스가 남아 있습니다.');
      await this.driver.portAbsent(descriptor.hostPort);
      await rm(descriptor.resourcePath, { recursive: true });
      if (!await absent(descriptor.resourcePath)) throw new Error('전용 자료 제거를 확인하지 못했습니다.');
      this.store.update(record.id, [record.state], { ...record, state: 'cleaned', descriptor: { ...descriptor,
        cleanupProof: { processExited: true, descendantsExited: true, descendants, portAbsent: true, directoryAbsent: true } as const },
        cleanup: { verified: true, checkedAt: new Date().toISOString(), reason: '실제 프로세스 종료·loopback 포트 부재·전용 자료 제거 확인' } });
      this.live.delete(record.id);
    } catch {
      try { this.store.update(record.id, [record.state], { ...record, state: record.state === 'intent' ? 'intent' : 'uncertain',
        cleanup: { verified: false, checkedAt: new Date().toISOString(), reason: '네이티브 소유 또는 종료·포트·자료 제거 확인 실패, 자원 보존' } }); }
      catch { /* 저장 오류에서도 완료를 주장하지 않는다. */ }
    }
  }
}
