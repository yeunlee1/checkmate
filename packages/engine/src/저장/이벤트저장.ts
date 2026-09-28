// 검증된 어댑터 이벤트를 실행별 순서대로 SQLite에 보존한다.
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { adapterEventSchema, type AdapterEvent } from '@checkmate/contracts/events';

export class EventStoreError extends Error {
  constructor(public readonly code: string) {
    super('이벤트를 저장하거나 조회할 수 없습니다.');
  }
}

type EventRow = { run_id: string; sequence: number; type: AdapterEvent['type']; recorded_at: string; payload_json: string };

function failure(error: unknown): never {
  if (error instanceof EventStoreError) throw error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) throw new EventStoreError('storage-busy');
  throw new EventStoreError('storage-error');
}

function fromRow(row: EventRow): AdapterEvent {
  try {
    const parsed = adapterEventSchema.safeParse({ protocolVersion: 1, runId: row.run_id,
      sequence: row.sequence, type: row.type, time: row.recorded_at, payload: JSON.parse(row.payload_json) });
    if (parsed.success) return parsed.data;
  } catch { /* 저장값 손상은 공개 오류로만 반환한다. */ }
  throw new EventStoreError('storage-error');
}

export class EventStore {
  constructor(private readonly db: Database.Database) {}

  append(event: AdapterEvent): { reused: boolean } {
    const parsed = adapterEventSchema.safeParse(event);
    if (!parsed.success) throw new EventStoreError('invalid-input');
    let encoded: string;
    try {
      encoded = JSON.stringify(parsed.data);
      if (!isDeepStrictEqual(JSON.parse(encoded), parsed.data) || Buffer.byteLength(encoded, 'utf8') > 64 * 1024)
        throw new EventStoreError('invalid-input');
    } catch { throw new EventStoreError('invalid-input'); }
    try {
      return this.db.transaction(() => {
        const run = this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(parsed.data.runId);
        if (!run) throw new EventStoreError('run-not-found');
        const old = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence = ?')
          .get(parsed.data.runId, parsed.data.sequence) as EventRow | undefined;
        if (old) {
          if (!isDeepStrictEqual(fromRow(old), parsed.data)) throw new EventStoreError('event-conflict');
          return { reused: true };
        }
        const last = this.db.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE run_id = ?')
          .get(parsed.data.runId) as { sequence: number | null };
        if (parsed.data.sequence !== (last.sequence ?? 0) + 1) throw new EventStoreError('event-sequence');
        this.db.prepare('INSERT INTO events (run_id, sequence, type, recorded_at, payload_json) VALUES (?,?,?,?,?)')
          .run(parsed.data.runId, parsed.data.sequence, parsed.data.type, parsed.data.time, JSON.stringify(parsed.data.payload));
        return { reused: false };
      })();
    } catch (error) { failure(error); }
  }

  list(runId: string, afterSequence = 0, limit = 50): AdapterEvent[] {
    if (!adapterEventSchema.shape.runId.safeParse(runId).success || !Number.isSafeInteger(afterSequence)
      || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new EventStoreError('invalid-input');
    try {
      const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(runId, afterSequence, limit) as EventRow[];
      return rows.map(fromRow);
    } catch (error) { failure(error); }
  }
}
