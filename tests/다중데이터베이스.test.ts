// 여섯 DB의 소유권과 연결 정보 분리 및 부분 준비 실패의 회수 경계를 검증한다.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseResourceKinds, databaseEnvironmentPrefixes, selectDatabaseEnvironment } from '@checkmate/contracts/resources';
import type { DatabaseResourceKind } from '@checkmate/contracts/resources';
import { projectDefinitionSchema } from '@checkmate/contracts/project';
import { DatabaseResources, type PostgresTestDriver } from '../packages/engine/src/자원/격리데이터베이스.js';
import { databaseSpecs } from '../packages/engine/src/자원/데이터베이스종류.js';
import type { ResourceRecord, ResourceStore } from '../packages/engine/src/저장/자원저장.js';

function fixture() {
  const records: ResourceRecord[] = [];
  const containers = new Map<string, Record<string, any>>();
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const stored: string[] = [];
  let failKind: DatabaseResourceKind | undefined;
  let lostResponse = false;
  const store = {
    list: (runId: string) => records.filter(row => row.runId === runId),
    intent: (record: ResourceRecord) => { records.push(record); stored.push(JSON.stringify(record)); },
    update: (id: string, expected: ResourceRecord['state'][], change: Partial<ResourceRecord>) => {
      const index = records.findIndex(row => row.id === id);
      expect(expected).toContain(records[index]!.state);
      records[index] = { ...records[index]!, ...change };
      stored.push(JSON.stringify(records[index]));
      return records[index]!;
    },
  } as unknown as ResourceStore;
  const driver: PostgresTestDriver = {
    async command(args, options) {
      calls.push({ args, env: options?.env ?? {} });
      if (args[0] === 'context') return args[1] === 'show' ? 'default'
        : JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
      expect(args.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
      if (args[2] === 'info') return JSON.stringify({ ID: 'synthetic-daemon', OSType: 'linux' });
      if (args[2] === 'run') {
        const record = records.find(row => row.descriptor.name === args[args.indexOf('--name') + 1])!;
        expect(record.state).toBe('creating');
        if (record.kind === failKind) throw new Error('생성 응답 미확인');
        const spec = databaseSpecs[record.kind];
        const id = records.length.toString(16).padStart(64, '0');
        const portKey = `${spec.port}/tcp`;
        containers.set(id, { Id: id, Name: `/${record.descriptor.name}`, Image: `sha256:${record.kind}`,
          Config: { Image: spec.image, Labels: { 'checkmate.run-id': record.runId, 'checkmate.resource-id': record.id,
            'checkmate.owner-hash': record.ownerTokenHash, 'checkmate.purpose': record.kind } },
          HostConfig: { AutoRemove: true, NetworkMode: 'bridge', Tmpfs: { ...spec.tmpfs },
            PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] } },
          NetworkSettings: { Ports: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(49000 + records.length) }],
            ...Object.fromEntries(spec.extraPorts.map(port => [port, null])) } }, Mounts: [],
        });
        if (lostResponse) throw new Error('생성 응답 유실');
        return id;
      }
      if (args[2] === 'container') {
        const item = [...containers.values()].find(item => item.Id === args[4] || item.Name === `/${args[4]}`);
        if (!item) throw new Error('No such container');
        return JSON.stringify([item]);
      }
      if (args[2] === 'image') {
        const record = records.find(row => row.descriptor.image === args[4])!;
        return JSON.stringify([{ Id: `sha256:${record.kind}`, RepoDigests: [args[4]] }]);
      }
      if (args[2] === 'exec') {
        const item = [...containers.values()].find(item => args.includes(item.Id))!;
        if (args.includes('cat')) return Object.keys(item.HostConfig.Tmpfs).map(path => `1 2 0:1 / ${path} rw,nosuid,nodev - tmpfs tmpfs rw`).join('\n');
        if (args.includes('sqlplus')) {
          expect(args).toContain('--interactive');
          expect(options?.input).toContain('WHENEVER SQLERROR EXIT FAILURE');
          expect(options?.input).toContain('FREEPDB1');
        }
        return '1\n';
      }
      if (args[2] === 'stop') { containers.delete(args.at(-1)!); return ''; }
      throw new Error('예상하지 않은 합성 명령');
    },
    async probe(port) { expect(port).toBeGreaterThan(49000); },
  };
  return { controller: new DatabaseResources(store, driver), records, containers, calls, stored,
    fail: (kind: DatabaseResourceKind) => { failKind = kind; }, loseResponse: () => { lostResponse = true; } };
}

describe('다중 DB 자원', () => {
  it.each(databaseResourceKinds)('%s의 인증 연결과 소유 자원을 준비하고 정리한다', async kind => {
    const test = fixture();
    const runId = randomUUID();
    const result = await test.controller.prepare(runId, 'owner', new AbortController().signal, [kind]);
    const prefix = databaseEnvironmentPrefixes[kind];
    const connection = JSON.parse(result.environment[`${prefix}CONNECTION_JSON`]!);
    expect(connection).toMatchObject({ host: '127.0.0.1', port: 49001, user: databaseSpecs[kind].user });
    expect(result.environment[`${prefix}MANAGED`]).toBe('1');
    expect(result.secrets).toContain(connection.password);
    expect(JSON.stringify(test.calls.map(call => call.args))).not.toContain(connection.password);
    expect(test.stored.join('\n')).not.toContain(connection.password);
    if (kind === 'mssql-test') expect(test.calls.find(call => call.args[2] === 'run')?.env).toMatchObject({ ACCEPT_EULA: 'Y', MSSQL_PID: 'Developer' });
    expect((await test.controller.cleanup(runId)).verified).toBe(true);
    expect(test.containers.size).toBe(0);
  });

  it('여러 종류를 공유하되 명령별 선언 외의 연결을 전달하지 않는다', async () => {
    const test = fixture();
    const runId = randomUUID();
    const result = await test.controller.prepare(runId, 'owner', new AbortController().signal, databaseResourceKinds);
    expect(test.records).toHaveLength(6);
    const mysqlOnly = selectDatabaseEnvironment(['mysql-test'], result.environment);
    expect(Object.keys(mysqlOnly)).toEqual(['CHECKMATE_MYSQL_MANAGED', 'CHECKMATE_MYSQL_CONNECTION_JSON']);
    expect(selectDatabaseEnvironment([], result.environment)).toEqual({});
    expect((await test.controller.cleanup(runId)).verified).toBe(true);
    expect(test.containers.size).toBe(0);
  });

  it.each(databaseResourceKinds)('%s의 생성 응답 유실은 정확한 소유 정보로 복구한다', async kind => {
    const test = fixture(); test.loseResponse();
    const runId = randomUUID();
    await test.controller.prepare(runId, 'owner', new AbortController().signal, [kind]);
    expect((await test.controller.cleanup(runId)).verified).toBe(true);
  });

  it.each(databaseResourceKinds)('%s의 다른 소유자 자원을 종료하지 않는다', async kind => {
    const test = fixture();
    const runId = randomUUID();
    await test.controller.prepare(runId, 'owner', new AbortController().signal, [kind]);
    test.containers.values().next().value!.Config.Labels['checkmate.owner-hash'] = 'another-owner';
    expect((await test.controller.cleanup(runId)).verified).toBe(false);
    expect(test.calls.some(call => call.args[2] === 'stop')).toBe(false);
  });

  it.each(['extra-port', 'extra-volume', 'wrong-image', 'wrong-kind'] as const)('%s 변조를 회수 근거로 사용하지 않는다', async fault => {
    const test = fixture();
    const runId = randomUUID();
    await test.controller.prepare(runId, 'owner', new AbortController().signal, ['mongodb-test']);
    const item = test.containers.values().next().value!;
    if (fault === 'extra-port') item.NetworkSettings.Ports['80/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '80' }];
    if (fault === 'extra-volume') item.Mounts.push({ Type: 'volume', Destination: '/other', RW: true });
    if (fault === 'wrong-image') item.Image = 'sha256:other';
    if (fault === 'wrong-kind') item.Config.Labels['checkmate.purpose'] = 'mysql-test';
    expect((await test.controller.cleanup(runId)).verified).toBe(false);
    expect(test.calls.some(call => call.args[2] === 'stop')).toBe(false);
  });

  it('두 번째 DB의 불명확한 실패에서도 먼저 만든 자원만 회수하고 미확인을 보존한다', async () => {
    const test = fixture(); test.fail('mssql-test');
    const runId = randomUUID();
    await expect(test.controller.prepare(runId, 'owner', new AbortController().signal, ['mysql-test', 'mssql-test'])).rejects.toThrow('SQL Server');
    expect((await test.controller.cleanup(runId)).verified).toBe(false);
    expect(test.records.map(row => [row.kind, row.state])).toEqual([['mysql-test', 'cleaned'], ['mssql-test', 'uncertain']]);
    expect(test.containers.size).toBe(0);
  });

  it('자원 중복과 예약 연결 설정 위조를 계약에서 거절한다', () => {
    const base = { schemaVersion: 1, id: randomUUID(), name: '합성', repositoryIdentity: 'synthetic',
      commands: [{ id: 'test', title: '시험', runtime: 'node', entry: 'test.mjs', args: [], timeoutMs: 1000,
        env: {}, writes: [], resultFormat: 'exit-code', resources: [...databaseResourceKinds] }], profiles: [] };
    expect(projectDefinitionSchema.safeParse(base).success).toBe(true);
    for (const prefix of Object.values(databaseEnvironmentPrefixes)) {
      expect(projectDefinitionSchema.safeParse({ ...base, commands: [{ ...base.commands[0], env: { [`${prefix}MANAGED`]: '1' } }] }).success).toBe(false);
    }
    expect(projectDefinitionSchema.safeParse({ ...base, commands: [{ ...base.commands[0], resources: ['mysql-test', 'mysql-test'] }] }).success).toBe(false);
  });
});
