// 합성 SQLite 파일에서 스키마 제약과 재개방 안전성을 검증한다.
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { schemaChecksum, schemaTables, schemaVersion } from '../packages/engine/src/저장/스키마.js';
import { createStoreFixture } from './저장시험자료.js';

const time = '2026-09-25T03:00:00.000Z';
const digest = (character: string) => character.repeat(64);

describe('SQLite 저장 스키마', () => {
  let fixture: Awaited<ReturnType<typeof createStoreFixture>>;
  let db: Database.Database | undefined;

  beforeEach(async () => { fixture = await createStoreFixture(); });
  afterEach(async () => {
    try { db?.close(); }
    finally { await fixture.cleanup(); }
  });

  function open() {
    db = connectStore(fixture.dbPath);
    return db;
  }

  function seed() {
    const connection = db!;
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const catalogId = randomUUID();
    const planId = randomUUID();
    const runId = randomUUID();
    connection.prepare('INSERT INTO projects (id, name, repository_identity, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId, '합성 프로젝트', 'repo-test', time);
    connection.prepare('INSERT INTO workspaces (id, project_id, real_path, path_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, projectId, `C:/synthetic/${workspaceId}`, digest('a'), time);
    connection.prepare('INSERT INTO catalogs (id, project_id, content_hash, source_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(catalogId, projectId, digest('b'), '{}', time);
    connection.prepare('INSERT INTO plans (id, workspace_id, catalog_id, fingerprint, plan_json, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(planId, workspaceId, catalogId, digest('c'), '{}', digest('d'), time);
    connection.prepare('INSERT INTO runs (id, workspace_id, plan_id, origin, state, phase, started_at, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, workspaceId, planId, 'live', 'queued', '준비', time, '{}');
    return { projectId, workspaceId, catalogId, planId, runId };
  }

  it('17개 테이블과 연결 설정을 원자적으로 준비한다.', () => {
    const connection = open();
    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables.map((row) => row.name).sort()).toEqual([...schemaTables].sort());
    const indexes = connection.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(indexes.map((row) => row.name).sort()).toEqual([
      'runs_workspace_started', 'runs_state', 'case_results_run_status',
      'evidence_run_state', 'gaps_project_state', 'audit_events_entity_recorded',
    ].sort());
    expect(connection.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(connection.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(connection.pragma('synchronous', { simple: true })).toBe(2);
    expect(connection.pragma('foreign_key_check')).toEqual([]);
    expect(connection.prepare('SELECT version, checksum FROM schema_migrations').get())
      .toEqual({ version: schemaVersion, checksum: schemaChecksum });
  });

  it('재개방 시 등록 자료와 스키마 버전을 보존한다.', () => {
    const connection = open();
    const ids = seed();
    connection.close();
    db = undefined;
    const reopened = open();
    expect(reopened.prepare('SELECT name FROM projects WHERE id = ?').get(ids.projectId)).toEqual({ name: '합성 프로젝트' });
    expect(reopened.prepare('SELECT id FROM runs WHERE id = ?').get(ids.runId)).toEqual({ id: ids.runId });
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
  });

  it('연결 FK와 중복, 열거값, JSON 제약을 거절한다.', () => {
    const connection = open();
    const ids = seed();
    expect(() => connection.prepare('INSERT INTO workspaces (id, project_id, real_path, path_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), randomUUID(), 'C:/synthetic/missing', digest('a'), time)).toThrow();
    expect(() => connection.prepare('INSERT INTO catalogs (id, project_id, content_hash, source_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), ids.projectId, digest('b'), '{}', time)).toThrow();
    expect(() => connection.prepare('INSERT INTO definitions (catalog_id, kind, definition_id, content_json) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'unexpected', 'definition', '{}')).toThrow();
    expect(() => connection.prepare('INSERT INTO definitions (catalog_id, kind, definition_id, content_json) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'check', 'broken', '{')).toThrow();
    expect(() => connection.prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run('2026-09-25T12:00:00+09:00', ids.projectId)).toThrow();
    expect(() => connection.prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run('2026-02-30T03:00:00Z', ids.projectId)).toThrow();
    connection.prepare('UPDATE projects SET archived_at = ? WHERE id = ?')
      .run('2026-09-25T03:00:00Z', ids.projectId);
    expect(() => connection.prepare('UPDATE runs SET state = ? WHERE id = ?').run('passed', ids.runId)).toThrow();
    expect(() => connection.prepare('INSERT INTO events (run_id, sequence, type, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(ids.runId, 1, 'step-started', time, '{')).toThrow();
    connection.prepare('INSERT INTO events (run_id, sequence, type, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(ids.runId, 1, 'step-started', time, '{}');
    expect(() => connection.prepare('INSERT INTO events (run_id, sequence, type, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(ids.runId, 1, 'step-started', time, '{}')).toThrow();
    expect(() => connection.prepare('INSERT INTO events (run_id, sequence, type, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(ids.runId, 2, 'unsupported', time, '{}')).toThrow();
  });

  it('일반 SQLite 기본키에도 NULL을 허용하지 않는다.', () => {
    const connection = open();
    expect(() => connection.prepare('INSERT INTO projects (id, name, repository_identity, created_at) VALUES (NULL, ?, ?, ?)')
      .run('합성 프로젝트', 'repo-null', time)).toThrow();
    expect(() => connection.prepare('INSERT INTO schema_migrations (version, checksum, applied_at, app_version) VALUES (NULL, ?, ?, ?)')
      .run(digest('a'), time, 'test')).toThrow();
    for (const table of ['projects', 'workspaces', 'catalogs', 'plans', 'approvals', 'runs', 'evidence', 'gaps', 'resources', 'audit_events']) {
      const columns = connection.pragma(`table_info(${table})`) as { name: string; notnull: number }[];
      expect(columns.find((column) => column.name === 'id')?.notnull).toBe(1);
    }
  });

  it('정수 의미 열은 소수와 숫자가 아닌 텍스트를 모두 거절하고 nullable 종료코드는 NULL을 허용한다.', () => {
    const connection = open();
    const ids = seed();
    connection.prepare('INSERT INTO definitions (catalog_id, kind, definition_id, content_json) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'requirement', 'requirement-1', '{}');
    connection.prepare('INSERT INTO definitions (catalog_id, kind, definition_id, content_json) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'check', 'check-1', '{}');
    const cases: { column: string; sql: string; values: (value: number | string) => unknown[] }[] = [
      { column: 'version', sql: 'UPDATE schema_migrations SET version = ? WHERE version = 1', values: (value) => [value] },
      { column: 'required', sql: 'INSERT INTO requirement_checks (catalog_id, requirement_id, check_id, required) VALUES (?, ?, ?, ?)',
        values: (value) => [ids.catalogId, 'requirement-1', 'check-1', value] },
      { column: 'worker_exit_code', sql: 'UPDATE runs SET worker_exit_code = ? WHERE id = ?', values: (value) => [value, ids.runId] },
      { column: 'ordinal', sql: 'INSERT INTO steps (run_id, step_id, ordinal, status, observed_json) VALUES (?, ?, ?, ?, ?)',
        values: (value) => [ids.runId, randomUUID(), value, 'finished', '{}'] },
      { column: 'exit_code', sql: 'INSERT INTO steps (run_id, step_id, ordinal, status, exit_code, observed_json) VALUES (?, ?, ?, ?, ?, ?)',
        values: (value) => [ids.runId, randomUUID(), 1, 'finished', value, '{}'] },
      { column: 'attempt', sql: 'INSERT INTO case_results (run_id, test_id, attempt, status, severity) VALUES (?, ?, ?, ?, ?)',
        values: (value) => [ids.runId, 'check-1', value, 'passed', 'info'] },
      { column: 'byte_length', sql: 'INSERT INTO evidence (id, run_id, relative_path, sha256, byte_length, mime, sensitivity, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        values: (value) => [randomUUID(), ids.runId, `${randomUUID()}.txt`, digest('f'), value, 'text/plain', 'internal', 'ready'] },
      { column: 'sequence', sql: 'INSERT INTO events (run_id, sequence, type, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?)',
        values: (value) => [ids.runId, value, 'step-started', time, '{}'] },
    ];
    for (const { column, sql, values } of cases) {
      for (const value of [1.5, 'not-an-integer']) {
        expect(() => connection.prepare(sql).run(...values(value)), `${column}=${value}`).toThrow();
      }
    }
    connection.prepare('UPDATE runs SET worker_exit_code = NULL WHERE id = ?').run(ids.runId);
    connection.prepare('INSERT INTO steps (run_id, step_id, ordinal, status, exit_code, observed_json) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(ids.runId, 'nullable-step', 1, 'finished', '{}');
    expect(connection.prepare('SELECT worker_exit_code FROM runs WHERE id = ?').get(ids.runId)).toEqual({ worker_exit_code: null });
    expect(connection.prepare('SELECT exit_code FROM steps WHERE step_id = ?').get('nullable-step')).toEqual({ exit_code: null });
  });

  it('requirement와 check 종류 및 같은 프로젝트 연결을 강제한다.', () => {
    const connection = open();
    const ids = seed();
    connection.prepare('INSERT INTO definitions (catalog_id, kind, definition_id, content_json) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'requirement', 'requirement-1', '{}');
    connection.prepare('INSERT INTO definitions (catalog_id, kind, definition_id, content_json) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'check', 'check-1', '{}');
    connection.prepare('INSERT INTO requirement_checks (catalog_id, requirement_id, check_id, required) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'requirement-1', 'check-1', 1);
    expect(() => connection.prepare('INSERT INTO requirement_checks (catalog_id, requirement_id, check_id, required) VALUES (?, ?, ?, ?)')
      .run(ids.catalogId, 'check-1', 'requirement-1', 1)).toThrow();
    expect(() => connection.prepare('INSERT INTO requirement_checks (catalog_id, requirement_id, check_id, required, requirement_kind) VALUES (?, ?, ?, ?, ?)')
      .run(ids.catalogId, 'requirement-1', 'check-1', 1, 'check')).toThrow();

    const otherProject = randomUUID();
    const otherCatalog = randomUUID();
    connection.prepare('INSERT INTO projects (id, name, repository_identity, created_at) VALUES (?, ?, ?, ?)')
      .run(otherProject, '다른 합성 프로젝트', 'repo-other', time);
    connection.prepare('INSERT INTO catalogs (id, project_id, content_hash, source_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(otherCatalog, otherProject, digest('e'), '{}', time);
    connection.prepare('UPDATE projects SET active_catalog_id = ? WHERE id = ?')
      .run(ids.catalogId, ids.projectId);
    expect(() => connection.prepare('UPDATE projects SET active_catalog_id = ? WHERE id = ?')
      .run(otherCatalog, ids.projectId)).toThrow();
    expect(() => connection.prepare('INSERT INTO plans (id, workspace_id, catalog_id, fingerprint, plan_json, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), ids.workspaceId, otherCatalog, digest('f'), '{}', digest('d'), time)).toThrow();
    expect(() => connection.prepare('UPDATE workspaces SET project_id = ? WHERE id = ?')
      .run(otherProject, ids.workspaceId)).toThrow();
    expect(() => connection.prepare('UPDATE catalogs SET project_id = ? WHERE id = ?')
      .run(otherProject, ids.catalogId)).toThrow();
  });

  it('새 손상 fixture의 체크섬 불일치를 거절하고 파일을 보존한다.', async () => {
    const connection = open();
    connection.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(digest('0'));
    connection.close();
    db = undefined;
    await expect(stat(fixture.dbPath)).resolves.toBeDefined();
    expect(() => connectStore(fixture.dbPath)).toThrowError(expect.objectContaining({ code: 'schema-mismatch' }));
    const reader = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(reader.prepare('SELECT checksum FROM schema_migrations').get()).toEqual({ checksum: digest('0') });
    } finally { reader.close(); }
  });

  it('새 손상 fixture의 미지원 버전을 거절하고 기록을 보존한다.', () => {
    const connection = open();
    connection.prepare('UPDATE schema_migrations SET version = 2 WHERE version = 1').run();
    connection.close();
    db = undefined;
    expect(() => connectStore(fixture.dbPath)).toThrowError(expect.objectContaining({ code: 'unsupported-version' }));
    const reader = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(reader.prepare('SELECT version FROM schema_migrations').get()).toEqual({ version: 2 });
    } finally { reader.close(); }
  });

  it('출처 불명 테이블과 손상 파일을 자동 초기화하지 않는다.', async () => {
    const unknown = new Database(fixture.dbPath);
    unknown.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    unknown.close();
    expect(() => connectStore(fixture.dbPath)).toThrowError(expect.objectContaining({ code: 'unrecognized-database' }));
    const reader = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(reader.prepare("SELECT name FROM sqlite_master WHERE name = 'unrelated'").get()).toEqual({ name: 'unrelated' });
    } finally { reader.close(); }

    const corrupt = Buffer.from('not a sqlite database');
    await writeFile(fixture.dbPath, corrupt);
    expect(() => connectStore(fixture.dbPath)).toThrow();
    expect(await readFile(fixture.dbPath)).toEqual(corrupt);
  });

  it('기존 뷰만 있는 저장 파일도 빈 신규 DB로 취급하지 않는다.', () => {
    const unknown = new Database(fixture.dbPath);
    unknown.exec('CREATE VIEW unrelated AS SELECT 1 AS id');
    unknown.close();
    expect(() => connectStore(fixture.dbPath)).toThrowError(expect.objectContaining({ code: 'unrecognized-database' }));
    const reader = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(reader.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").get()).toEqual({ name: 'unrelated' });
    } finally { reader.close(); }
  });

  it('상대 경로와 준비되지 않은 부모 폴더를 거절한다.', () => {
    expect(() => connectStore('relative.sqlite')).toThrowError(expect.objectContaining({ code: 'invalid-path' }));
    expect(() => connectStore(`${fixture.directory}/missing/checkmate.sqlite`))
      .toThrowError(expect.objectContaining({ code: 'invalid-path' }));
  });

  it('소유 표식이 달라진 폴더는 정리하지 않는다.', async () => {
    const marker = join(fixture.directory, '소유표식.txt');
    const original = await readFile(marker, 'utf8');
    await writeFile(marker, '다른 소유자');
    await expect(fixture.cleanup()).rejects.toThrow('소유권');
    await expect(stat(fixture.directory)).resolves.toBeDefined();
    await writeFile(marker, original);
  });
});
