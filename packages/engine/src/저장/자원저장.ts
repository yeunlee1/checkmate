// 실행 소유 자원의 생성 의도와 확인된 상태를 비밀 없이 저장한다.
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { databaseResourceKindSchema, nativePostgresProviderSchema } from '@checkmate/contracts/resources';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { databaseSpecs } from '../자원/데이터베이스종류.js';

export const localDockerEndpointSchema = z.string().max(1024)
  .regex(/^(?:unix:\/\/\/[^\x00-\x20\x7f?#]+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+)$/u);
export const dockerResourceDescriptorSchema = z.strictObject({
  name: z.string().regex(/^cm-(?:pg|mysql|mariadb|mssql|oracle|mongo)-[a-f0-9-]{36}-[a-f0-9-]{36}$/u),
  image: z.string().max(256).regex(/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/u),
  endpoint: localDockerEndpointSchema,
  daemonId: z.string().min(1).max(256),
  containerId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),
});
export const nativeProcessIdentitySchema = z.strictObject({ pid: z.number().int().positive(), startedAt: z.string().min(1).max(128),
  executable: z.string().min(1).max(4096), commandLine: z.string().min(1).max(16384),
  argv: z.array(z.string().max(4096)).min(1).max(32) });
export const nativeResourceDescriptorSchema = z.strictObject({
  provider: z.literal('native'), version: z.literal(1),
  name: z.string().regex(/^cm-pg-[a-f0-9-]{36}-[a-f0-9-]{36}$/u),
  resourceRoot: z.string().min(1).max(4096), resourcePath: z.string().min(1).max(4096), clusterPath: z.string().min(1).max(4096),
  markerSha256: z.string().regex(/^[a-f0-9]{64}$/u), binaries: nativePostgresProviderSchema,
  hostPort: z.number().int().min(1).max(65535),
  process: nativeProcessIdentitySchema.extend({ postmasterStart: z.number().int().positive() }).optional(),
  cleanupProof: z.strictObject({ processExited: z.literal(true), descendantsExited: z.literal(true),
    descendants: z.array(nativeProcessIdentitySchema).max(128), portAbsent: z.literal(true), directoryAbsent: z.literal(true) }).optional(),
});
export const resourceDescriptorSchema = z.union([dockerResourceDescriptorSchema, nativeResourceDescriptorSchema]);
const resourceSchema = z.strictObject({
  id: z.uuid(), runId: z.uuid(), kind: databaseResourceKindSchema,
  ownerTokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['intent', 'creating', 'created', 'ready', 'uncertain', 'cleaned']),
  descriptor: resourceDescriptorSchema,
  cleanup: z.strictObject({ verified: z.boolean(), checkedAt: z.iso.datetime(), reason: z.string().max(500) }).nullable(),
}).superRefine((record, context) => {
  const spec = databaseSpecs[record.kind];
  if ('provider' in record.descriptor) {
    const descriptor = record.descriptor;
    if (record.kind !== 'postgres-test' || descriptor.name !== `cm-pg-${record.runId}-${record.id}`
      || resolve(descriptor.resourceRoot) !== descriptor.resourceRoot
      || join(descriptor.resourceRoot, record.runId, record.id) !== descriptor.resourcePath
      || join(descriptor.resourcePath, 'cluster') !== descriptor.clusterPath)
      context.addIssue({ code: 'custom', message: '네이티브 자원의 전용 경로와 소유 정보가 다릅니다.' });
    return;
  }
  if (record.descriptor.name !== `cm-${spec.prefix}-${record.runId}-${record.id}`
    || record.descriptor.image.split('@')[0] !== spec.image.split('@')[0]) {
    context.addIssue({ code: 'custom', message: '시험 DB 종류와 소유 정보가 다릅니다.' });
  }
});
export type DockerResourceDescriptor = z.infer<typeof dockerResourceDescriptorSchema>;
export type NativeResourceDescriptor = z.infer<typeof nativeResourceDescriptorSchema>;
type UnionKeys<T> = T extends T ? keyof T : never;
type CompleteUnion<T, All = T> = T extends T ? T & Partial<Record<Exclude<UnionKeys<All>, keyof T>, never>> : never;
export type ResourceDescriptor = CompleteUnion<DockerResourceDescriptor | NativeResourceDescriptor>;
export type ResourceRecord = Omit<z.infer<typeof resourceSchema>, 'descriptor'> & { descriptor: ResourceDescriptor };
export type DockerResourceRecord = Omit<ResourceRecord, 'descriptor'> & { descriptor: DockerResourceDescriptor };
export type ResourceState = ResourceRecord['state'];

type Row = { id: string; run_id: string; kind: string; owner_token_hash: string; state: string; descriptor_json: string; cleanup_json: string | null };
function read(row: Row): ResourceRecord {
  return resourceSchema.parse({ id: row.id, runId: row.run_id, kind: row.kind,
    ownerTokenHash: row.owner_token_hash, state: row.state, descriptor: JSON.parse(row.descriptor_json),
    cleanup: row.cleanup_json === null ? null : JSON.parse(row.cleanup_json) });
}

export class ResourceStore {
  constructor(private readonly db: Database.Database) {}
  list(runId: string): ResourceRecord[] {
    z.uuid().parse(runId);
    return (this.db.prepare('SELECT * FROM resources WHERE run_id=? ORDER BY id').all(runId) as Row[]).map(read);
  }
  get(id: string): ResourceRecord {
    z.uuid().parse(id);
    const row = this.db.prepare('SELECT * FROM resources WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('기록된 자원을 찾을 수 없습니다.');
    return read(row);
  }
  intent(record: ResourceRecord): void {
    const value = resourceSchema.parse(record);
    if (value.state !== 'intent' || value.cleanup !== null || ('provider' in value.descriptor
      ? value.descriptor.process !== undefined || value.descriptor.cleanupProof !== undefined
      : value.descriptor.containerId !== undefined || value.descriptor.hostPort !== undefined))
      throw new Error('자원 생성 의도가 올바르지 않습니다.');
    this.db.prepare(`INSERT INTO resources (id,run_id,kind,owner_token_hash,state,descriptor_json,cleanup_json)
      VALUES (?,?,?,?,?,?,NULL)`).run(value.id, value.runId, value.kind, value.ownerTokenHash, value.state, JSON.stringify(value.descriptor));
  }
  update(id: string, expected: ResourceState[], change: Pick<ResourceRecord, 'state' | 'descriptor' | 'cleanup'>): ResourceRecord {
    return this.db.transaction(() => {
      const prior = this.get(id);
      if (!expected.includes(prior.state) || prior.state === 'cleaned') throw new Error('자원의 이전 상태가 다릅니다.');
      const next = resourceSchema.parse({ ...prior, ...change });
      const transitions: Record<Exclude<ResourceState, 'cleaned'>, ResourceState[]> = {
        intent: ['intent', 'creating', 'cleaned'], creating: ['created', 'uncertain'],
        created: ['ready', 'uncertain', 'cleaned'], ready: ['uncertain', 'cleaned'], uncertain: ['created', 'uncertain', 'cleaned'],
      };
      if (!transitions[prior.state].includes(next.state)) throw new Error('허용하지 않는 자원 상태 전이입니다.');
      if (prior.descriptor.provider === 'native') {
        if (!('provider' in next.descriptor)) throw new Error('자원의 제공자는 바꿀 수 없습니다.');
        const { process: oldProcess, cleanupProof: oldProof, ...oldIdentity } = prior.descriptor;
        const { process: newProcess, cleanupProof: newProof, ...newIdentity } = next.descriptor;
        if (!isDeepStrictEqual(oldIdentity, newIdentity) || (oldProcess && !isDeepStrictEqual(oldProcess, newProcess))
          || (oldProof && !isDeepStrictEqual(oldProof, newProof))
          || (['created', 'ready', 'cleaned'].includes(next.state) && !newProcess)
          || (next.state === 'cleaned' && (next.cleanup?.verified !== true || !newProof))
          || (newProof && next.state !== 'cleaned')) throw new Error('네이티브 자원의 소유 정보와 정리 근거가 다릅니다.');
        this.db.prepare('UPDATE resources SET state=?,descriptor_json=?,cleanup_json=? WHERE id=?')
          .run(next.state, JSON.stringify(next.descriptor), next.cleanup === null ? null : JSON.stringify(next.cleanup), id);
        return next;
      }
      if ('provider' in next.descriptor) throw new Error('자원의 제공자는 바꿀 수 없습니다.');
      const { containerId: oldId, hostPort: oldPort, ...oldIdentity } = prior.descriptor;
      const { containerId: newId, hostPort: newPort, ...newIdentity } = next.descriptor;
      if (JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity) || (oldId !== undefined && oldId !== newId)
        || (oldPort !== undefined && oldPort !== newPort)
        || (next.state === 'cleaned' && (next.cleanup?.verified !== true
          || (prior.state !== 'intent' && next.descriptor.containerId === undefined)))) throw new Error('자원의 소유 정보는 바꿀 수 없습니다.');
      this.db.prepare('UPDATE resources SET state=?,descriptor_json=?,cleanup_json=? WHERE id=?')
        .run(next.state, JSON.stringify(next.descriptor), next.cleanup === null ? null : JSON.stringify(next.cleanup), id);
      return next;
    })();
  }
}
