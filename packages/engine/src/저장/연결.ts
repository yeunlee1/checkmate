// 로컬 SQLite 파일의 출처와 스키마를 확인한 뒤 저장 연결을 연다.
import { statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { schemaChecksum, schemaSql, schemaTables, schemaVersion } from './스키마.js';

export class StoreSchemaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type Migration = { version: number; checksum: string };

function assertExistingSchema(db: Database.Database, tables: string[]): void {
  if (!tables.includes('schema_migrations')) {
    throw new StoreSchemaError('unrecognized-database', '출처를 확인할 수 없는 저장 파일입니다.');
  }

  const migrations = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Migration[];
  if (migrations.length !== 1 || migrations[0]?.version !== schemaVersion) {
    throw new StoreSchemaError('unsupported-version', '지원하지 않는 저장 스키마 버전입니다.');
  }
  if (migrations[0].checksum !== schemaChecksum) {
    throw new StoreSchemaError('schema-mismatch', '저장 스키마의 체크섬이 일치하지 않습니다.');
  }
  const actual = new Set(tables);
  if (actual.size !== schemaTables.length || schemaTables.some((name) => !actual.has(name))) {
    throw new StoreSchemaError('unrecognized-database', '저장 파일의 테이블 구성이 일치하지 않습니다.');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new StoreSchemaError('storage-corrupt', '저장 파일의 연결 무결성이 손상되었습니다.');
  }
}

export function connectStore(path: string): Database.Database {
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
    if (tables.length > 0) assertExistingSchema(db, tables);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new StoreSchemaError('storage-error', '필수 SQLite 연결 설정을 적용할 수 없습니다.');
    }

    if (tables.length === 0) {
      db.transaction(() => {
        db!.exec(schemaSql);
        db!.prepare('INSERT INTO schema_migrations (version, checksum, applied_at, app_version) VALUES (?, ?, ?, ?)')
          .run(schemaVersion, schemaChecksum, new Date().toISOString(), '0.1.0-alpha.1');
      })();
    }
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof StoreSchemaError) throw error;
    throw new StoreSchemaError('storage-error', '저장 파일을 열거나 확인할 수 없습니다.');
  }
}
