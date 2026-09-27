// 실행별 합성 DB 컨테이너의 생성과 검증된 정리를 관리한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import type { ResourceDescriptor, ResourceRecord, ResourceStore } from '../저장/자원저장.js';
import { localDockerEndpointSchema } from '../저장/자원저장.js';
import { databaseResourceKinds, databaseResourceNames, type DatabaseResourceKind } from '@checkmate/contracts/resources';
import { databaseConnection, databaseSpecs } from './데이터베이스종류.js';

const execFileAsync = promisify(execFile);
const LABELS = ['checkmate.run-id', 'checkmate.resource-id', 'checkmate.owner-hash', 'checkmate.purpose'] as const;
type CommandOptions = { env?: Record<string, string>; input?: string; signal?: AbortSignal; timeoutMs?: number };

export interface DatabaseTestDriver {
  command(args: string[], options?: CommandOptions): Promise<string>;
  probe(port: number): Promise<void>;
}
export type PostgresTestDriver = DatabaseTestDriver;

function dockerPath(): string {
  if (process.platform !== 'win32') return 'docker';
  const paths = [
    'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
    'C:/ProgramData/DockerDesktop/version-bin/docker.exe',
  ];
  return paths.find(existsSync) ?? 'docker.exe';
}

const systemDriver: DatabaseTestDriver = {
  async command(args, options) {
    const env = { ...process.env };
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
    Object.assign(env, options?.env);
    const pending = execFileAsync(dockerPath(), args, { env, windowsHide: true, maxBuffer: 1024 * 1024,
      timeout: options?.timeoutMs ?? 15000, killSignal: 'SIGKILL', ...(options?.signal ? { signal: options.signal } : {}) });
    // SQL*Plus 인증 입력도 프로세스 인자나 파일에 남기지 않는다.
    pending.child.stdin?.on('error', () => { /* 조기 종료는 명령 결과에서 처리한다. */ });
    pending.child.stdin?.end(options?.input);
    const { stdout } = await pending;
    return stdout;
  },
  probe(port) {
    return new Promise<void>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.setTimeout(2000);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('연결 시간 초과')); });
      socket.once('error', () => { socket.destroy(); reject(new Error('연결 실패')); });
    });
  },
};

function parseObject(value: string): Record<string, any> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Docker 응답 형식 오류');
  return parsed as Record<string, any>;
}

function labels(record: ResourceRecord): Record<string, string> {
  return {
    [LABELS[0]]: record.runId,
    [LABELS[1]]: record.id,
    [LABELS[2]]: record.ownerTokenHash,
    [LABELS[3]]: record.kind,
  };
}

function safeReason(code: string): { verified: false; checkedAt: string; reason: string } {
  return { verified: false, checkedAt: new Date().toISOString(), reason: code };
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, external?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  external?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Docker 요청 시간 초과 또는 취소'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    if (external?.aborted) controller.abort();
    return await Promise.race([controller.signal.aborted ? cancelled : work(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer); external?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export class DatabaseResources {
  private readonly preparing = new Set<string>();
  constructor(private readonly store: ResourceStore, private readonly driver: DatabaseTestDriver = systemDriver) {}

  private async command(endpoint: string, args: string[], options?: CommandOptions): Promise<string> {
    localDockerEndpointSchema.parse(endpoint);
    const timeoutMs = options?.timeoutMs ?? 15000;
    return bounded(signal => this.driver.command(['--host', endpoint, ...args], { ...options, timeoutMs, signal }), timeoutMs, options?.signal);
  }

  private async localDaemon(signal: AbortSignal): Promise<{ endpoint: string; daemonId: string }> {
    if (process.env.DOCKER_HOST) localDockerEndpointSchema.parse(process.env.DOCKER_HOST);
    const context = process.env.DOCKER_CONTEXT ?? (await bounded(signal => this.driver.command(['context', 'show'], { signal, timeoutMs: 15000 }), 15000, signal)).trim();
    if (!context || /[\r\n]/u.test(context)) throw new Error('Docker context 확인 실패');
    const contexts: unknown = JSON.parse(await bounded(signal => this.driver.command(['context', 'inspect', context], { signal, timeoutMs: 15000 }), 15000, signal));
    const endpoint = localDockerEndpointSchema.parse(!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST ? process.env.DOCKER_HOST
      : Array.isArray(contexts) && contexts.length === 1 ? contexts[0]?.Endpoints?.docker?.Host : undefined);
    const info = parseObject(await this.command(endpoint, ['info', '--format', '{{json .}}'], { signal }));
    if (info.OSType !== 'linux' || typeof info.ID !== 'string' || !info.ID) throw new Error('로컬 Linux Docker daemon 확인 실패');
    return { endpoint, daemonId: info.ID };
  }

  private async sameDaemon(record: ResourceRecord, signal?: AbortSignal): Promise<void> {
    const info = parseObject(await this.command(record.descriptor.endpoint, ['info', '--format', '{{json .}}'], signal ? { signal } : {}));
    if (info.OSType !== 'linux' || info.ID !== record.descriptor.daemonId) throw new Error('Docker daemon 소유 정보 불일치');
  }

  private async inspect(record: ResourceRecord, target: string, signal?: AbortSignal): Promise<Record<string, any> | null> {
    try {
      const value: unknown = JSON.parse(await this.command(record.descriptor.endpoint, ['container', 'inspect', target], signal ? { signal } : {}));
      if (!Array.isArray(value) || value.length !== 1) throw new Error('Docker inspect 결과 불명확');
      return value[0] as Record<string, any>;
    } catch (error) {
      if (!/No such (object|container)/iu.test(String(error))) throw error;
      // Docker inspect 실패가 실제 부재인지 daemon 오류인지 별도 info로 확인한다.
      await this.sameDaemon(record, signal);
      return null;
    }
  }

  private async verify(record: ResourceRecord, item: Record<string, any>, requirePort = true, signal?: AbortSignal): Promise<{ id: string; port: number }> {
    const spec = databaseSpecs[record.kind];
    const imageName = record.descriptor.image;
    const portKey = `${spec.port}/tcp`;
    const paths = Object.keys(spec.tmpfs);
    // 저장된 종류와 고정 이미지가 모두 맞아야 과거 실행의 자원도 회수한다.
    if (imageName !== spec.image || record.descriptor.name !== `cm-${spec.prefix}-${record.runId}-${record.id}`)
      throw new Error('시험 DB 종류와 고정 이미지 불일치');
    const expected = labels(record);
    if (!/^[a-f0-9]{64}$/u.test(item.Id) || item.Name !== `/${record.descriptor.name}`
      || (record.descriptor.containerId && item.Id !== record.descriptor.containerId)
      || LABELS.some(key => item.Config?.Labels?.[key] !== expected[key])
      || item.Config?.Image !== imageName || item.HostConfig?.Binds?.length
      || item.HostConfig?.Mounts?.length || !['bridge', 'default'].includes(item.HostConfig?.NetworkMode)
      || item.HostConfig?.Privileged || item.HostConfig?.VolumesFrom?.length || item.HostConfig?.Devices?.length
      || !item.HostConfig?.AutoRemove || Object.keys(item.HostConfig?.Tmpfs ?? {}).length !== paths.length
      || paths.some(path => typeof item.HostConfig?.Tmpfs?.[path] !== 'string'
        || item.HostConfig.Tmpfs[path].split(',').sort().join(',') !== spec.tmpfs[path]!.split(',').sort().join(','))
      || !Array.isArray(item.Mounts) || item.Mounts.length > paths.length
      || item.Mounts.some((mount: Record<string, unknown>) => mount.Type !== 'tmpfs' || !paths.includes(String(mount.Destination)) || mount.RW !== true))
      throw new Error('컨테이너 소유 정보 불일치');
    const binding = item.HostConfig?.PortBindings?.[portKey];
    if (Object.keys(item.HostConfig?.PortBindings ?? {}).some(key => key !== portKey)
      || Object.entries(item.NetworkSettings?.Ports ?? {}).some(([key, value]) => key !== portKey && (!spec.extraPorts.includes(key) || value !== null))
      || !Array.isArray(binding) || binding.length !== 1 || binding[0]?.HostIp !== '127.0.0.1'
      || !['', '0'].includes(binding[0]?.HostPort))
      throw new Error('Docker 연결 범위 불일치');
    const published = item.NetworkSettings?.Ports?.[portKey];
    let port = record.descriptor.hostPort ?? 0;
    if (requirePort || published) {
      if (!Array.isArray(published) || published.length !== 1 || published[0]?.HostIp !== '127.0.0.1'
        || !/^\d+$/u.test(published[0]?.HostPort ?? '')) throw new Error('Docker 연결 범위 불일치');
      port = Number(published[0].HostPort);
      if (port < 1 || port > 65535 || (record.descriptor.hostPort && port !== record.descriptor.hostPort))
        throw new Error('Docker 포트 불일치');
    }
    const image: unknown = JSON.parse(await this.command(record.descriptor.endpoint, ['image', 'inspect', imageName], signal ? { signal } : {}));
    if (!Array.isArray(image) || image.length !== 1 || image[0]?.Id !== item.Image
      || !image[0]?.RepoDigests?.some((value: unknown) => typeof value === 'string' && value.endsWith(imageName.slice(imageName.indexOf('@')))))
      throw new Error('Docker 이미지 불일치');
    if (requirePort) {
      // --tmpfs는 inspect.Mounts가 비어 있을 수 있으므로 실제 커널 마운트도 확인한다.
      const mountInfo = await this.command(record.descriptor.endpoint, ['exec', item.Id, 'cat', '/proc/self/mountinfo'], signal ? { signal } : {});
      for (const path of paths) {
        const mounts = mountInfo.trim().split('\n').map(line => line.split(' ')).filter(parts => parts[4] === path);
        const actual = mounts[0];
        if (mounts.length !== 1 || !actual || actual[actual.indexOf('-') + 1] !== 'tmpfs'
          || !['rw', 'nosuid', 'nodev'].every(flag => actual[5]?.split(',').includes(flag)))
          throw new Error('실제 시험 DB tmpfs 마운트를 확인할 수 없습니다.');
      }
    }
    return { id: item.Id, port };
  }

  private update(record: ResourceRecord, state: ResourceRecord['state'], descriptor = record.descriptor,
    cleanup: ResourceRecord['cleanup'] = null): ResourceRecord {
    return this.store.update(record.id, [record.state], { state, descriptor, cleanup });
  }

  private async waitForAbsence(record: ResourceRecord, id: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!await this.inspect(record, id, signal) && !await this.inspect(record, record.descriptor.name, signal)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('정리 후 컨테이너가 남아 있습니다.');
  }

  async prepare(runId: string, ownerToken: string, signal: AbortSignal, kinds: readonly DatabaseResourceKind[] = ['postgres-test']): Promise<{ environment: Record<string, string>; secrets: string[] }> {
    if (this.preparing.has(runId)) throw new Error('같은 실행의 시험 DB 준비가 진행 중입니다.');
    this.preparing.add(runId);
    try {
      if (!kinds.length || new Set(kinds).size !== kinds.length || kinds.some(kind => !databaseResourceKinds.includes(kind)))
        throw new Error('시험 DB 선언이 올바르지 않습니다.');
      if (this.store.list(runId).length) throw new Error('같은 실행의 시험 DB 자원이 이미 기록됐습니다.');
      const combined = { environment: {} as Record<string, string>, secrets: [] as string[] };
      for (const kind of kinds) {
        const prepared = await this.prepareOne(runId, ownerToken, signal, kind);
        Object.assign(combined.environment, prepared.environment);
        combined.secrets.push(...prepared.secrets);
      }
      return combined;
    } finally {
      this.preparing.delete(runId);
    }
  }

  private async prepareOne(runId: string, ownerToken: string, signal: AbortSignal, kind: DatabaseResourceKind): Promise<{ environment: Record<string, string>; secrets: string[] }> {
    const spec = databaseSpecs[kind];
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(360000)]);
    let record: ResourceRecord | undefined;
    try {
      const { endpoint, daemonId } = await this.localDaemon(deadline);
      const id = randomUUID();
      const password = `Cm9${randomBytes(24).toString('hex')}zA`;
      record = { id, runId, kind, ownerTokenHash: createHash('sha256').update(ownerToken).digest('hex'),
        state: 'intent', descriptor: { name: `cm-${spec.prefix}-${runId}-${id}`, image: spec.image, endpoint, daemonId }, cleanup: null };
      this.store.intent(record);
      if (deadline.aborted) throw new Error('시험 DB 준비가 취소됐습니다.');
      const args = ['run', '--detach', '--rm', '--name', record.descriptor.name];
      for (const [key, value] of Object.entries(labels(record))) args.push('--label', `${key}=${value}`);
      args.push('--publish', `127.0.0.1::${spec.port}`);
      for (const [path, options] of Object.entries(spec.tmpfs)) args.push('--tmpfs', `${path}:${options}`);
      const environment = spec.environment(password);
      for (const key of Object.keys(environment)) args.push('--env', key);
      args.push(spec.image);
      let response = '';
      record = this.update(record, 'creating');
      try {
        // CLI 종료와 외부 생성 완료를 구분한다. 응답 유실은 정리할 때에도 미확인 상태로 남는다.
        response = (await this.command(endpoint, args, { env: environment,
          signal: deadline, timeoutMs: 300000 })).trim();
      } catch { /* 정확한 이름을 inspect해 응답 유실을 복구한다. */ }
      await this.sameDaemon(record, deadline);
      const item = await this.inspect(record, record.descriptor.name, deadline);
      if (!item) throw new Error('시험 DB 생성 확인 실패');
      const verified = await this.verify(record, item, true, deadline);
      if (response && response !== verified.id) throw new Error('Docker 생성 응답 ID 불일치');
      const descriptor: ResourceDescriptor = { ...record.descriptor, containerId: verified.id, hostPort: verified.port };
      record = this.update(record, 'created', descriptor);
      if (deadline.aborted) throw new Error('시험 DB 준비가 취소됐습니다.');
      let ready = false;
      for (let attempt = 0; attempt < spec.readyAttempts; attempt++) {
        if (deadline.aborted) throw new Error('시험 DB 준비가 취소됐습니다.');
        try {
          const probe = spec.probe(password);
          const args = ['exec', ...(probe.input ? ['--interactive'] : [])];
          for (const key of Object.keys(probe.env ?? {})) args.push('--env', key);
          args.push(verified.id, ...probe.args);
          const selected = await this.command(endpoint, args, { ...probe, signal: deadline });
          if (selected.trim() !== '1') throw new Error('고정 조회 결과 불일치');
          await bounded(() => this.driver.probe(verified.port), 2000, deadline);
          ready = true;
          break;
        } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
      }
      if (!ready) throw new Error('시험 DB 준비 확인 실패');
      record = this.update(record, 'ready');
      return databaseConnection(kind, verified.port, password);
    } catch {
      if (record && !['intent', 'ready'].includes(record.state)) {
        try { this.update(record, 'uncertain'); } catch { /* 원래 기록을 보존한다. */ }
      }
      throw new Error(`${databaseResourceNames[kind]} 격리 자원 준비 실패`);
    }
  }

  async cleanup(runId: string): Promise<{ verified: boolean; resources: ResourceRecord[] }> {
    const deadline = AbortSignal.timeout(60000);
    const resources = this.store.list(runId);
    for (const initial of resources) {
      if (initial.state === 'cleaned') continue;
      let record = initial;
      try {
        await this.sameDaemon(record, deadline);
        const target = record.descriptor.containerId ?? record.descriptor.name;
        const item = await this.inspect(record, target, deadline);
        if (!item && !record.descriptor.containerId && record.state !== 'intent')
          throw new Error('생성 요청의 처리 완료를 확인할 수 없습니다.');
        if (item) {
          const verified = await this.verify(record, item, !record.descriptor.containerId, deadline);
          if (!record.descriptor.containerId) {
            record = this.update(record, 'created', { ...record.descriptor, containerId: verified.id, hostPort: verified.port });
          }
          await this.command(record.descriptor.endpoint, ['stop', '--time', '1', verified.id], { signal: deadline });
          await this.waitForAbsence(record, verified.id, deadline);
        }
        if (await this.inspect(record, record.descriptor.name, deadline)) throw new Error('정리 후 이름이 남아 있습니다.');
        this.update(record, 'cleaned', record.descriptor, { verified: true, checkedAt: new Date().toISOString(), reason: '컨테이너 부재 확인' });
      } catch {
        try { this.update(record, record.state === 'intent' ? 'intent' : 'uncertain', record.descriptor, safeReason('Docker 소유 또는 부재 확인 실패')); }
        catch { /* 저장 오류는 검증 실패로 반환한다. */ }
      }
    }
    const latest = this.store.list(runId);
    return { verified: latest.every(resource => resource.state === 'cleaned' && resource.cleanup?.verified), resources: latest };
  }
}

// 기존 PostgreSQL 호출자는 같은 기본 종류와 소유권 계약을 계속 사용한다.
export class PostgresResources extends DatabaseResources {}
