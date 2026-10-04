// 로컬 SQLite 파일의 출처와 스키마를 확인한 뒤 저장 연결을 연다.
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resultInputSchema } from '@checkmate/contracts';
import { engineVersion } from '../버전.js';
import { dirname, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { schemaTables, currentSchemaTables, currentSchemaVersion, storeMigrations } from './스키마.js';

export class StoreSchemaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type Migration = { version: number; checksum: string };

export function assertStoreSchema(db: Database.Database): number {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
  if (!tables.includes('schema_migrations')) {
    throw new StoreSchemaError('unrecognized-database', '출처를 확인할 수 없는 저장 파일입니다.');
  }

  const migrations = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Migration[];
  if (migrations.length < 1 || migrations.length > storeMigrations.length
    || migrations.some((row, index) => row.version !== storeMigrations[index]?.version)) {
    throw new StoreSchemaError('unsupported-version', '지원하지 않는 저장 스키마 버전입니다.');
  }
  if (migrations.some((row, index) => row.checksum !== storeMigrations[index]?.checksum)) {
    throw new StoreSchemaError('schema-mismatch', '저장 스키마의 체크섬이 일치하지 않습니다.');
  }
  const actual = new Set(tables);
  const expected = migrations.length === 1 ? schemaTables : currentSchemaTables;
  if (actual.size !== expected.length || expected.some((name) => !actual.has(name))) {
    throw new StoreSchemaError('unrecognized-database', '저장 파일의 테이블 구성이 일치하지 않습니다.');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new StoreSchemaError('storage-corrupt', '저장 파일의 연결 무결성이 손상되었습니다.');
  }
  return migrations[migrations.length - 1]!.version;
}

export function assertMigrationIdle(db: Database.Database): void {
  const refuse = () => { throw new StoreSchemaError('storage-busy', '진행 또는 정리가 확인되지 않은 기록이 있어 저장 이행을 거부합니다.'); };
  if (db.prepare("SELECT 1 FROM runs WHERE state IN ('queued','running') OR finalized_at IS NULL LIMIT 1").get()) refuse();
  for (const row of db.prepare("SELECT id,state,summary_json FROM runs WHERE origin='live'").all() as { id: string; state: string; summary_json: string }[]) {
    const parsed = resultInputSchema.safeParse(JSON.parse(row.summary_json));
    if (!parsed.success || parsed.data.runId !== row.id || parsed.data.origin !== 'live'
      || parsed.data.state !== row.state || !parsed.data.finalized) refuse();
    if (parsed.success && parsed.data.cleanupVerified === true) continue;
    const hash = createHash('sha256').update(row.summary_json).digest('hex');
    if (!db.prepare(`SELECT 1 FROM audit_events WHERE entity_id=? AND action='cleanup-acknowledged' AND actor_kind='human'
      AND after_hash=? AND json_type(detail_json,'$.manualConfirmation')='true' LIMIT 1`).get(row.id, hash)) refuse();
  }
  for (const resource of db.prepare('SELECT state,cleanup_json FROM resources').all() as { state: string; cleanup_json: string | null }[]) {
    if (resource.state !== 'cleaned' || resource.cleanup_json === null || JSON.parse(resource.cleanup_json)?.verified !== true) refuse();
  }
}

export function connectStore(path: string, options: { migrate?: boolean } = {}): Database.Database {
  if (!isAbsolute(path)) {
    throw new StoreSchemaError('invalid-path', '저장 파일에는 절대 경로가 필요합니다.');
  }
  try {
    if (!statSync(dirname(path)).isDirectory()) throw new Error('parent-not-directory');
  } catch {
    throw new StoreSchemaError('invalid-path', '저장 파일의 부모 폴더가 준비되지 않았습니다.');
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    if (db.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new StoreSchemaError('storage-corrupt', '저장 파일의 무결성이 손상되었습니다.');
    }
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string }[];
    const tables = objects.filter((row) => row.type === 'table').map((row) => row.name);
    if (tables.length === 0 && objects.length > 0) {
      throw new StoreSchemaError('unrecognized-database', '출처를 확인할 수 없는 저장 파일입니다.');
    }
    const version = tables.length > 0 ? assertStoreSchema(db) : 0;
    if (version > 0 && version < currentSchemaVersion && options.migrate !== true)
      throw new StoreSchemaError('migration-required', '기존 자료는 보존됩니다. 서비스가 유휴인 상태에서 사람이 저장 이행을 확인해 주세요.');

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new StoreSchemaError('storage-error', '필수 SQLite 연결 설정을 적용할 수 없습니다.');
    }

    if (version < currentSchemaVersion) {
      db.transaction(() => {
        if (version > 0) assertMigrationIdle(db!);
        for (const migration of storeMigrations.filter(item => item.version > version)) {
          db!.exec(migration.sql);
          db!.prepare('INSERT INTO schema_migrations (version, checksum, applied_at, app_version) VALUES (?, ?, ?, ?)')
            .run(migration.version, migration.checksum, new Date().toISOString(), engineVersion);
        }
        assertStoreSchema(db!);
      }).immediate();
    }
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof StoreSchemaError) throw error;
    throw new StoreSchemaError('storage-error', '저장 파일을 열거나 확인할 수 없습니다.');
  }
}
