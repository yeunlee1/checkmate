// 실행 소유 자원의 생성 의도와 확인된 상태를 비밀 없이 저장한다.
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const localDockerEndpointSchema = z.string().max(1024)
  .regex(/^(?:unix:\/\/\/[^\x00-\x20\x7f?#]+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+)$/u);
export const resourceDescriptorSchema = z.strictObject({
  name: z.string().regex(/^cm-pg-[a-f0-9-]{36}-[a-f0-9-]{36}$/u),
  image: z.string().regex(/^postgres:17-alpine@sha256:[a-f0-9]{64}$/u),
  endpoint: localDockerEndpointSchema,
  daemonId: z.string().min(1).max(256),
  containerId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),
});
const resourceSchema = z.strictObject({
  id: z.uuid(), runId: z.uuid(), kind: z.literal('postgres-test'),
  ownerTokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['intent', 'creating', 'created', 'ready', 'uncertain', 'cleaned']),
  descriptor: resourceDescriptorSchema,
  cleanup: z.strictObject({ verified: z.boolean(), checkedAt: z.iso.datetime(), reason: z.string().max(500) }).nullable(),
});
export type ResourceDescriptor = z.infer<typeof resourceDescriptorSchema>;
export type ResourceRecord = z.infer<typeof resourceSchema>;
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
    if (value.state !== 'intent' || value.cleanup !== null || value.descriptor.containerId !== undefined
      || value.descriptor.hostPort !== undefined) throw new Error('자원 생성 의도가 올바르지 않습니다.');
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
