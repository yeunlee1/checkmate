// 합성 Docker 응답으로 PostgreSQL 자원의 소유 검증과 정리 경계를 시험한다.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresResources, type PostgresTestDriver } from '../packages/engine/src/자원/격리데이터베이스.js';
import type { ResourceRecord, ResourceStore } from '../packages/engine/src/저장/자원저장.js';

const image = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const containerId = 'a'.repeat(64);
const endpoint = 'npipe:////./pipe/docker_engine';
afterEach(() => { vi.useRealTimers(); });

function fixture() {
  const records: ResourceRecord[] = [];
  const calls: string[][] = [];
  const events: string[] = [];
  let present = false;
  let responseLost = false;
  let wrongLabel = false;
  let stopFails = false;
  let intentFails = false;
  let daemonChanged = false;
  let delayedCreation = false;
  let hangs = false;
  let mountInfo = '527 515 0:109 / /var/lib/postgresql/data rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw\n';
  let inspectChange: ((item: Record<string, any>) => void) | undefined;
  let onRun: (() => void) | undefined;
  const store = {
    list: (runId: string) => records.filter(row => row.runId === runId),
    intent: (record: ResourceRecord) => {
      events.push('intent');
      if (intentFails) throw new Error('DB 쓰기 실패');
      records.push(record);
    },
    update: (id: string, expected: ResourceRecord['state'][], change: Pick<ResourceRecord, 'state' | 'descriptor' | 'cleanup'>) => {
      const index = records.findIndex(row => row.id === id);
      const current = records[index]!;
      if (!expected.includes(current.state)) throw new Error('상태 불일치');
      const next = { ...current, ...change };
      records[index] = next;
      events.push(change.state);
      return next;
    },
  } as unknown as ResourceStore;
  const driver: PostgresTestDriver = {
    async command(args) {
      calls.push(args);
      if (args[0] === 'context' && args[1] === 'show') return 'default';
      if (args[0] === 'context' && args[1] === 'inspect') return JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]);
      const command = args[2];
      if (command === 'info') return JSON.stringify({ ID: daemonChanged ? 'daemon-2' : 'daemon-1', OSType: 'linux' });
      if (command === 'run') {
        expect(events).toContain('intent');
        expect(events).toContain('creating');
        if (hangs) return await new Promise<string>(() => {});
        if (delayedCreation) throw new Error('생성 요청 처리 중 응답 유실');
        present = true;
        onRun?.();
        if (responseLost) throw new Error('응답 유실');
        return `${containerId}\n`;
      }
      if (command === 'container' && args[3] === 'inspect') {
        if (!present) throw new Error('No such container');
        const row = records[0]!;
        const item = {
          Id: containerId, Name: `/${row.descriptor.name}`, Image: 'sha256:image',
          Config: { Image: image, Labels: {
            'checkmate.run-id': row.runId,
            'checkmate.resource-id': row.id,
            'checkmate.owner-hash': wrongLabel ? 'wrong' : row.ownerTokenHash,
            'checkmate.purpose': 'postgres-test',
          } },
          HostConfig: { Binds: null, Mounts: null, NetworkMode: 'bridge', AutoRemove: true,
            Tmpfs: { '/var/lib/postgresql/data': 'rw,nosuid,nodev' },
            PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
          NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } },
          Mounts: [{ Type: 'tmpfs', Destination: '/var/lib/postgresql/data', RW: true }],
        };
        inspectChange?.(item);
        return JSON.stringify([item]);
      }
      if (command === 'image' && args[3] === 'inspect') return JSON.stringify([{
        Id: 'sha256:image', RepoDigests: [`postgres@${image.split('@')[1]}`],
      }]);
      if (command === 'exec') return args.includes('cat') ? mountInfo : args.includes('psql') ? '1\n' : '';
      if (command === 'stop') {
        if (stopFails) throw new Error('stop 실패');
        present = false;
        return containerId;
      }
      throw new Error(`예상하지 않은 명령 ${command}`);
    },
    async probe(port) { expect(port).toBe(49153); },
  };
  return { resources: new PostgresResources(store, driver), records, calls, events,
    setResponseLost: () => { responseLost = true; },
    setWrongLabel: () => { wrongLabel = true; },
    setStopFails: () => { stopFails = true; },
    setIntentFails: () => { intentFails = true; },
    setDaemonChanged: () => { daemonChanged = true; },
    setDelayedCreation: () => { delayedCreation = true; },
    revealContainer: () => { present = true; },
    setHangs: () => { hangs = true; },
    setMountInfo: (value: string) => { mountInfo = value; },
    setInspectChange: (change: (item: Record<string, any>) => void) => { inspectChange = change; },
    setOnRun: (callback: () => void) => { onRun = callback; },
  };
}

describe('격리 PostgreSQL 자원', () => {
  it('실제 Docker의 빈 Mounts는 커널 tmpfs 확인과 함께 허용한다.', async () => {
    const test = fixture();
    test.setInspectChange(item => { item.Mounts = []; });
    const runId = randomUUID();
    await test.resources.prepare(runId, 'owner-secret', new AbortController().signal);
    expect(test.records[0]?.state).toBe('ready');
    expect((await test.resources.cleanup(runId)).verified).toBe(true);
  });

  it.each([
    '527 515 0:109 / /var/lib/postgresql/data rw,nosuid,nodev - ext4 /dev/sda rw\n',
    '527 515 0:109 / /var/lib/postgresql/data rw - tmpfs tmpfs rw\n',
    '527 515 0:109 / /another-path rw,nosuid,nodev - tmpfs tmpfs rw\n',
  ])('설정이 맞아도 실제 커널 마운트가 다르면 준비를 거절한다. %s', async mount => {
    const test = fixture();
    test.setInspectChange(item => { item.Mounts = []; });
    test.setMountInfo(mount);
    await expect(test.resources.prepare(randomUUID(), 'owner-secret', new AbortController().signal)).rejects.toThrow();
    expect(test.records[0]?.state).toBe('uncertain');
    expect(test.records[0]?.descriptor.containerId).toBeUndefined();
  });

  it('의도를 먼저 저장하고 준비와 정리 부재를 검증한다.', async () => {
    const test = fixture();
    const runId = randomUUID();
    const prepared = await test.resources.prepare(runId, 'owner-secret', new AbortController().signal);
    expect(test.events.slice(0, 4)).toEqual(['intent', 'creating', 'created', 'ready']);
    expect(prepared.environment.CHECKMATE_PG_MANAGED).toBe('1');
    expect(prepared.environment.CHECKMATE_PG_ADMIN_URL).toContain('127.0.0.1:49153');
    expect(test.records[0]?.descriptor.containerId).toBe(containerId);
    expect(JSON.stringify(test.records)).not.toContain('owner-secret');
    expect(JSON.stringify(test.records)).not.toContain(prepared.secrets[0]);
    expect(JSON.stringify(test.calls)).not.toContain(prepared.secrets[0]);
    await expect(test.resources.prepare(runId, 'owner-secret', new AbortController().signal)).rejects.toThrow();
    const cleaned = await test.resources.cleanup(runId);
    expect(cleaned.verified).toBe(true);
    expect(cleaned.resources[0]?.state).toBe('cleaned');
    expect((await test.resources.cleanup(runId)).verified).toBe(true);
  });

  it('의도 저장 실패 시 Docker 생성 명령을 호출하지 않는다.', async () => {
    const test = fixture();
    test.setIntentFails();
    await expect(test.resources.prepare(randomUUID(), 'token', new AbortController().signal)).rejects.toThrow('PostgreSQL 격리 자원 준비 실패');
    expect(test.calls.some(args => args[2] === 'run')).toBe(false);
  });

  it('생성 전 취소는 생성하지 않고 기록된 의도를 정리한다.', async () => {
    const test = fixture();
    const runId = randomUUID();
    const signal = new AbortController();
    signal.abort();
    await expect(test.resources.prepare(runId, 'token', signal.signal)).rejects.toThrow();
    expect(test.calls.some(args => args[2] === 'run')).toBe(false);
    expect((await test.resources.cleanup(runId)).verified).toBe(true);
  });

  it('생성 응답 유실을 정확한 이름의 소유 컨테이너로 복구한다.', async () => {
    const test = fixture();
    test.setResponseLost();
    await test.resources.prepare(randomUUID(), 'token', new AbortController().signal);
    expect(test.records[0]?.state).toBe('ready');
  });

  it('생성 호출 중 취소한 미확인 ID는 정리 때 소유권 확인 후 복구한다.', async () => {
    const test = fixture();
    const signal = new AbortController();
    test.setOnRun(() => signal.abort());
    const runId = randomUUID();
    await expect(test.resources.prepare(runId, 'token', signal.signal)).rejects.toThrow('PostgreSQL 격리 자원 준비 실패');
    expect(test.records[0]?.state).toBe('uncertain');
    expect((await test.resources.cleanup(runId)).verified).toBe(true);
    expect(test.records[0]?.descriptor.containerId).toBe(containerId);
  });

  it('응답 유실 뒤 라벨이 다르면 생성 ID를 채택하지 않는다.', async () => {
    const test = fixture();
    test.setResponseLost();
    test.setWrongLabel();
    const runId = randomUUID();
    await expect(test.resources.prepare(runId, 'token', new AbortController().signal)).rejects.toThrow();
    expect(test.records[0]?.descriptor.containerId).toBeUndefined();
    expect((await test.resources.cleanup(runId)).verified).toBe(false);
    expect(test.calls.some(args => args[2] === 'stop')).toBe(false);
  });

  it('소유 라벨이 다르면 중지하지 않고 미확인으로 보존한다.', async () => {
    const test = fixture();
    await test.resources.prepare(randomUUID(), 'token', new AbortController().signal);
    test.setWrongLabel();
    const result = await test.resources.cleanup(test.records[0]!.runId);
    expect(result.verified).toBe(false);
    expect(result.resources[0]?.state).toBe('uncertain');
    expect(test.calls.some(args => args[2] === 'stop')).toBe(false);
  });

  it('중지 실패를 정리 완료로 표시하지 않는다.', async () => {
    const test = fixture();
    await test.resources.prepare(randomUUID(), 'token', new AbortController().signal);
    test.setStopFails();
    const result = await test.resources.cleanup(test.records[0]!.runId);
    expect(result.verified).toBe(false);
    expect(result.resources[0]?.cleanup?.verified).toBe(false);
  });

  it('daemon ID가 달라지면 해당 자원을 중지하지 않는다.', async () => {
    const test = fixture();
    await test.resources.prepare(randomUUID(), 'token', new AbortController().signal);
    test.setDaemonChanged();
    const result = await test.resources.cleanup(test.records[0]!.runId);
    expect(result.verified).toBe(false);
    expect(test.calls.some(args => args[2] === 'stop')).toBe(false);
  });

  it('응답 유실 뒤 일시 부재를 완료로 올리지 않고 늦게 나타난 소유 자원을 정리한다.', async () => {
    const test = fixture(); const runId = randomUUID();
    test.setDelayedCreation();
    await expect(test.resources.prepare(runId, 'token', new AbortController().signal)).rejects.toThrow();
    expect((await test.resources.cleanup(runId)).verified).toBe(false);
    expect(test.records[0]?.state).toBe('uncertain');
    test.revealContainer();
    expect((await test.resources.cleanup(runId)).verified).toBe(true);
    expect(test.calls.filter(args => args[2] === 'stop')).toHaveLength(1);
  });

  it('멈춘 생성 응답은 취소와 유한 시간 한도로 반환하고 미확인 상태를 보존한다.', async () => {
    vi.useFakeTimers();
    const test = fixture(); test.setHangs();
    const controller = new AbortController(); const runId = randomUUID();
    const result = test.resources.prepare(runId, 'token', controller.signal).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(1);
    expect(test.records[0]?.state).toBe('creating');
    controller.abort();
    expect(await result).toBe('failed');
    expect((await test.resources.cleanup(runId)).verified).toBe(false);
    const timed = fixture(); timed.setHangs();
    const timeoutResult = timed.resources.prepare(randomUUID(), 'token', new AbortController().signal).catch(() => 'timeout');
    await vi.advanceTimersByTimeAsync(300001);
    expect(await timeoutResult).toBe('timeout');
    expect(timed.records[0]?.state).toBe('uncertain');
  });

  it('복구 행의 원격 주소는 첫 Docker 호출 전에 거절한다.', async () => {
    const test = fixture(); const runId = randomUUID();
    await test.resources.prepare(runId, 'token', new AbortController().signal);
    test.records[0]!.descriptor.endpoint = 'tcp://synthetic.invalid:2375';
    const before = test.calls.length;
    expect((await test.resources.cleanup(runId)).verified).toBe(false);
    expect(test.calls).toHaveLength(before);
  });

  it.each(['bind', 'volume', 'port', 'fixed', 'flags', 'tmpfs-target'])('예상 밖 %s 구조를 환경 검증과 정리 권한으로 사용하지 않는다.', async kind => {
    const test = fixture(); const runId = randomUUID();
    test.setInspectChange(item => {
      if (kind === 'bind') item.Mounts.push({ Type: 'bind', Destination: '/foreign', RW: true });
      if (kind === 'volume') item.Mounts[0].Type = 'volume';
      if (kind === 'port') item.NetworkSettings.Ports['9000/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '49000' }];
      if (kind === 'fixed') item.HostConfig.PortBindings['5432/tcp'][0].HostPort = '49153';
      if (kind === 'flags') item.HostConfig.Tmpfs['/var/lib/postgresql/data'] += ',suid,dev';
      if (kind === 'tmpfs-target') item.HostConfig.Tmpfs['/foreign'] = 'rw,nosuid,nodev';
    });
    await expect(test.resources.prepare(runId, 'token', new AbortController().signal)).rejects.toThrow();
    expect((await test.resources.cleanup(runId)).verified).toBe(false);
    expect(test.calls.some(args => args[2] === 'stop')).toBe(false);
  });
});
