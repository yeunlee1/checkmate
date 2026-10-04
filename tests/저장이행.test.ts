// 합성 v1 저장소의 유휴 확인과 원본 백업 및 명시 이행 실패 보존을 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { acquireServiceOwnership } from '../packages/engine/src/서비스/상주서비스.js';
import { createBackup, migrateStoredData, verifyBackup } from '../packages/engine/src/저장/백업.js';
import { concurrencySql, schemaChecksum, schemaSql } from '../packages/engine/src/저장/스키마.js';
import { createStoreFixture } from './저장시험자료.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const time = '2026-10-04T00:00:00.000Z';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(origin: 'live' | 'imported' = 'live', cleanupVerified: boolean | null = true) {
  const files = await createStoreFixture(); cleanups.push(files.cleanup);
  const paths = dataPaths(join(files.directory, 'v1관리')); await prepareDataPaths(paths);
  const path = join(paths.state, 'checkmate.sqlite');
  const db = new Database(path);
  const projectId = randomUUID(), workspaceId = randomUUID(), planId = randomUUID(), catalogId = randomUUID(), runId = randomUUID();
  db.exec(schemaSql);
  db.prepare('INSERT INTO schema_migrations VALUES (1,?,?,?)').run(schemaChecksum, time, 'synthetic-v1');
  db.prepare('INSERT INTO projects (id,name,repository_identity,created_at) VALUES (?,?,?,?)').run(projectId, '합성 원본', 'synthetic:migration', time);
  db.prepare('INSERT INTO workspaces (id,project_id,real_path,path_fingerprint,created_at) VALUES (?,?,?,?,?)').run(workspaceId, projectId, files.directory, 'a'.repeat(64), time);
  db.prepare('INSERT INTO catalogs (id,project_id,content_hash,source_json,created_at) VALUES (?,?,?,?,?)').run(catalogId, projectId, 'b'.repeat(64), '{}', time);
  db.prepare('INSERT INTO plans (id,workspace_id,catalog_id,fingerprint,plan_json,source_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(planId, workspaceId, catalogId, 'c'.repeat(64), '{}', 'd'.repeat(64), time);
  const summary = { schemaVersion: 1, runId, projectId, profile: 'quick', origin, state: 'unverifiable', verdict: 'unknown',
    planHash: 'c'.repeat(64), sourceBefore: 'd'.repeat(64), sourceAfter: null, workerExitCode: null, environmentVerified: null,
    evidenceVerified: null, cleanupVerified, finalized: true, plannedChecks: [], requiredChecks: [], cases: [], reasons: ['synthetic-original'] };
  const original = JSON.stringify(summary);
  db.prepare('INSERT INTO runs (id,workspace_id,plan_id,origin,state,verdict,phase,started_at,finalized_at,summary_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(runId, workspaceId, planId, origin, summary.state, summary.verdict, 'finished', time, time, original);
  const content = Buffer.from('합성 v1 원본 증거'); await mkdir(join(paths.runs, runId));
  await writeFile(join(paths.runs, runId, '원본.txt'), content);
  db.prepare('INSERT INTO evidence (id,run_id,relative_path,sha256,byte_length,mime,sensitivity,state) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), runId, '원본.txt', hash(content), content.length, 'text/plain', 'public', 'ready');
  db.close();
  const modify = (action: (connection: Database.Database) => void) => { const connection = new Database(path); try { action(connection); } finally { connection.close(); } };
  const snapshot = () => { const reader = new Database(path, { readonly: true, fileMustExist: true }); try {
    return { schema: reader.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), runs: reader.prepare('SELECT * FROM runs ORDER BY id').all(),
      resources: reader.prepare('SELECT * FROM resources ORDER BY id').all(), audit: reader.prepare('SELECT * FROM audit_events ORDER BY id').all(),
      tables: reader.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() };
  } finally { reader.close(); } };
  const audit = (entity = runId, after = hash(original), actor = 'human', confirmation = true) => modify(connection => {
    connection.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,after_hash,recorded_at,detail_json) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), 'cleanup-acknowledged', actor, entity, after, time, JSON.stringify({ manualConfirmation: confirmation, note: '합성 사람이 종료와 자원 부재를 확인한 감사다.' }));
  });
  const migrate = async () => { const release = await acquireServiceOwnership(paths); try { return await migrateStoredData(paths); } finally { await release(); } };
  return { files, paths, path, runId, original, summary, content, modify, snapshot, audit, migrate };
}

it.each(['positive-cleanup', 'imported-unknown', 'human-confirmed', 'cleaned-resource'] as const)('저장 이행 %s는 원래 unknown 판정과 v1 완성 백업 및 증거를 보존한다.', async mode => {
  const f = await fixture(mode === 'imported-unknown' ? 'imported' : 'live', mode === 'positive-cleanup' || mode === 'cleaned-resource' ? true : null);
  if (mode === 'human-confirmed') f.audit();
  if (mode === 'cleaned-resource') f.modify(db => db.prepare('INSERT INTO resources (id,run_id,kind,owner_token_hash,state,descriptor_json,cleanup_json) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), f.runId, 'postgres', 'e'.repeat(64), 'cleaned', '{}', JSON.stringify({ verified: true, checkedAt: time, reason: '합성 정리 확인' })));
  const before = f.snapshot();
  const saved = await f.migrate();
  const manifest = await verifyBackup(saved.backupDirectory);
  expect(manifest.schemaVersion).toBe(1); expect(manifest.schemaChecksum).toBe(schemaChecksum);
  expect(hash(await readFile(join(saved.backupDirectory, '백업명세.json')))).toBe(saved.manifestHash);
  expect(await readFile(join(saved.backupDirectory, 'runs', f.runId, '원본.txt'))).toEqual(f.content);
  const copied = new Database(join(saved.backupDirectory, 'state', 'checkmate.sqlite'), { readonly: true, fileMustExist: true });
  try { expect(copied.prepare('SELECT summary_json FROM runs').get()).toEqual({ summary_json: f.original });
    expect(copied.prepare('SELECT * FROM schema_migrations').all()).toEqual(before.schema); } finally { copied.close(); }
  const current = f.snapshot(); expect(current.schema).toHaveLength(3); expect(current.runs).toEqual(before.runs);
  expect(current.resources).toEqual(before.resources); expect(current.audit).toEqual(before.audit);
});

it.each(['queued', 'running', 'unfinalized', 'cleanup-null', 'cleanup-false', 'resource-intent', 'resource-unverified', 'wrong-run', 'wrong-hash', 'agent-audit', 'missing-confirmation'] as const)
  ('저장 이행 %s는 원본을 바꾸거나 백업 성공으로 공개하지 않는다.', async mode => {
    const f = await fixture('live', ['cleanup-null', 'cleanup-false', 'wrong-run', 'wrong-hash', 'agent-audit', 'missing-confirmation'].includes(mode) ? mode === 'cleanup-false' ? false : null : true);
    if (mode === 'queued' || mode === 'running') f.modify(db => db.prepare('UPDATE runs SET state=?,finalized_at=NULL,summary_json=? WHERE id=?')
      .run(mode, JSON.stringify({ ...f.summary, state: mode, finalized: false, verdict: null }), f.runId));
    if (mode === 'unfinalized') f.modify(db => db.prepare('UPDATE runs SET finalized_at=NULL WHERE id=?').run(f.runId));
    if (mode.startsWith('resource-')) f.modify(db => db.prepare('INSERT INTO resources (id,run_id,kind,owner_token_hash,state,descriptor_json,cleanup_json) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), f.runId, 'postgres', 'e'.repeat(64), mode === 'resource-intent' ? 'intent' : 'cleaned', '{}', mode === 'resource-intent' ? null : JSON.stringify({ verified: false })));
    if (mode === 'wrong-run') f.audit(randomUUID());
    if (mode === 'wrong-hash') f.audit(f.runId, 'f'.repeat(64));
    if (mode === 'agent-audit') f.audit(f.runId, hash(f.original), 'agent');
    if (mode === 'missing-confirmation') f.audit(f.runId, hash(f.original), 'human', false);
    const before = f.snapshot(), bytes = await readFile(f.path);
    await expect(f.migrate()).rejects.toMatchObject({ code: 'storage-busy' });
    expect(f.snapshot()).toEqual(before); expect(await readFile(f.path)).toEqual(bytes);
    await expect(stat(join(f.paths.root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

it('저장 이행은 원본 DB가 없으면 새 SQLite 파일을 만들지 않는다.', async () => {
  const files = await createStoreFixture(); cleanups.push(files.cleanup);
  const paths = dataPaths(join(files.directory, '없는DB')); await prepareDataPaths(paths);
  await expect(migrateStoredData(paths)).rejects.toThrow();
  await expect(stat(join(paths.state, 'checkmate.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('저장 이행 백업 실패는 v1 원본과 이미 완성된 백업을 보존한다.', async () => {
  const f = await fixture();
  const db = new Database(f.path, { readonly: true });
  const prior = await createBackup(db, f.paths, join(f.paths.root, 'backups')); db.close();
  const priorBytes = await readFile(join(prior.backupDirectory, '백업명세.json'));
  const before = f.snapshot(), bytes = await readFile(f.path);
  vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('합성 백업 실패'));
  await expect(f.migrate()).rejects.toThrow('합성 백업 실패');
  expect(f.snapshot()).toEqual(before); expect(await readFile(f.path)).toEqual(bytes);
  expect(await readFile(join(prior.backupDirectory, '백업명세.json'))).toEqual(priorBytes);
  expect((await verifyBackup(prior.backupDirectory)).schemaVersion).toBe(1);
  const directories = await readdir(join(f.paths.root, 'backups'));
  for (const directory of directories.filter(id => id !== prior.manifest.id))
    expect(await readdir(join(f.paths.root, 'backups', directory))).not.toContain('완료표식.txt');
});

it('저장 이행 transaction 실패는 완료된 새 v1 백업과 원본 SQL 및 JSON을 유지한다.', async () => {
  const f = await fixture(), before = f.snapshot();
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    if (sql === concurrencySql) throw new Error('합성 migration 실패');
    return exec.call(this, sql);
  });
  await expect(f.migrate()).rejects.toMatchObject({ code: 'storage-error' });
  expect(f.snapshot()).toEqual(before);
  const directories = await readdir(join(f.paths.root, 'backups')); expect(directories).toHaveLength(1);
  expect((await verifyBackup(join(f.paths.root, 'backups', directories[0]!))).schemaVersion).toBe(1);
});

it('저장 이행은 백업 이후 외부 접수된 queued 상태를 immediate transaction 안에서 재검사한다.', async () => {
  const f = await fixture();
  const close = Database.prototype.close; let injected = false;
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    const inject = !injected && this.name === f.path && this.readonly;
    const result = close.call(this);
    if (inject) { injected = true; f.modify(db => db.prepare('UPDATE runs SET state=?,verdict=NULL,finalized_at=NULL,summary_json=? WHERE id=?')
      .run('queued', JSON.stringify({ ...f.summary, state: 'queued', finalized: false, verdict: null }), f.runId)); }
    return result;
  });
  await expect(f.migrate()).rejects.toMatchObject({ code: 'storage-busy' });
  expect(injected).toBe(true);
  const current = f.snapshot(); expect(current.schema).toHaveLength(1);
  expect(current.runs).toEqual([expect.objectContaining({ state: 'queued', finalized_at: null })]);
  const directories = await readdir(join(f.paths.root, 'backups')); expect(directories).toHaveLength(1);
  expect((await verifyBackup(join(f.paths.root, 'backups', directories[0]!))).schemaVersion).toBe(1);
});

it('저장 이행은 다른 체크섬이나 손상된 참조 증거를 이행하지 않는다.', async () => {
  for (const mode of ['checksum', 'evidence'] as const) {
    const f = await fixture();
    if (mode === 'checksum') f.modify(db => db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('f'.repeat(64)));
    else await writeFile(join(f.paths.runs, f.runId, '원본.txt'), '합성 손상 증거');
    const before = f.snapshot();
    await expect(f.migrate()).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
  }
});

async function cli(f: Awaited<ReturnType<typeof fixture>>, confirm = true) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.CHECKMATE_LOCK_DIR = join(f.files.directory, '공유잠금');
  const args = [resolve('packages/engine/dist/명령.js'), '--json', '--data-dir', f.paths.root, 'migrate-storage', ...(confirm ? ['--confirm'] : [])];
  try { const result = await execute(process.execPath, args, { env, timeout: 20000 });
    return { code: 0, response: JSON.parse(result.stdout) }; }
  catch (error) { const result = error as { code: number; stdout: string }; return { code: result.code, response: JSON.parse(result.stdout) }; }
}

it('새 CLI 명시 이행은 완성된 v1 백업 proof를 반환하고 기존 최종 JSON을 보존한다.', async () => {
  const f = await fixture(), before = f.snapshot();
  const result = await cli(f);
  expect(result).toMatchObject({ code: 0, response: { ok: true, data: { migrated: true, dataRoot: f.paths.root, manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u) } } });
  const saved = result.response.data as { backupDirectory: string; manifestHash: string };
  expect(hash(await readFile(join(saved.backupDirectory, '백업명세.json')))).toBe(saved.manifestHash);
  expect((await verifyBackup(saved.backupDirectory)).schemaVersion).toBe(1);
  expect(f.snapshot().runs).toEqual(before.runs); expect(f.snapshot().schema).toHaveLength(3);
});

it.each(['queued', 'cleanup-null', 'no-confirm', 'service-owner'] as const)('새 CLI %s는 이행과 원본 변경을 거부한다.', async mode => {
  const f = await fixture('live', mode === 'cleanup-null' ? null : true);
  if (mode === 'queued') f.modify(db => db.prepare('UPDATE runs SET state=?,finalized_at=NULL WHERE id=?').run('queued', f.runId));
  const release = mode === 'service-owner' ? await acquireServiceOwnership(f.paths) : null;
  try {
    const before = f.snapshot(), bytes = await readFile(f.path);
    const result = await cli(f, mode !== 'no-confirm');
    expect(result.code).not.toBe(0); expect(result.response.ok).toBe(false);
    expect(f.snapshot()).toEqual(before); expect(await readFile(f.path)).toEqual(bytes);
    await expect(stat(join(f.paths.root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await release?.(); }
});
