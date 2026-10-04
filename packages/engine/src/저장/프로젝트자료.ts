// 프로젝트별 출력 위치와 확인된 기존 자료의 보존 이전 및 실행 위치를 관리한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';
import type { ProjectStorageApplied, ProjectStorageOperation, ProjectStoragePreview, ProjectStorageSettings } from '@checkmate/contracts/api';
import { outputStorageSchema, planRegistrationSchema } from '@checkmate/contracts/runs';
import type { OutputStorageSnapshot, PlanRegistration } from '@checkmate/contracts/runs';
import type { RunResult } from '@checkmate/contracts';
import { makePrivate } from '../연결/개인경로.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const markerName = '프로젝트소유.json';
const privateStoragePath = (path: string, file = false) => makePrivate(process.platform === 'win32' ? `\\\\?\\${resolve(path)}` : path, file);
type Identity = { dev: string; ino: string };
type StoredLocation = { root_path: string; storage_id: string | null; setting_revision: number; layout_version: number };
type FileRecord = { path: string; sha256: string; byteLength: number };
type RunFiles = { runId: string; workspaceId: string; sourceRoot: string; targetRoot: string; planHash: string;
  summaryHash: string; present: boolean; identity: Identity | null; files: FileRecord[] };
type FrozenPreview = { projectId: string; previewId: string; expectedRevision: number; currentRoot: string | null;
  targetRoot: string | null; namespaceId: string; rootIdentity: Identity; namespaceIdentity: Identity | null;
  destinationRoot: string; runs: RunFiles[]; fingerprint: string };

function fail(code: string): never { throw new ServiceError(code, '프로젝트 자료의 위치와 소유권을 다시 확인해 주세요.'); }
export function pathWithin(root: string, path: string): boolean {
  const rest = relative(normalized(root), normalized(path));
  return !rest || rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function assertStorageOwner(path: string): void {
  if (process.platform !== 'win32') {
    if (process.getuid && lstatSync(path).uid !== process.getuid()) fail('storage-ownership-unknown');
    return;
  }
  const encoded = Buffer.from(`\\\\?\\${resolve(path)}`, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $owner=[IO.Directory]::GetAccessControl($target).GetOwner([Security.Principal.SecurityIdentifier]); if (-not $owner.Equals($identity.User) -and -not $owner.Equals($identity.Owner)) { throw 'owner-mismatch' }`;
  try { execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', timeout: 15000 }); }
  catch { fail('storage-ownership-unknown'); }
}
export function checkedStoragePath(path: string, allowMissing = false): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path)) fail('unsafe-path');
  const target = resolve(path);
  for (let cursor = target;; cursor = dirname(cursor)) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || (!info.isDirectory() && cursor !== target) || (info.isFile() && info.nlink !== 1)) fail('unsafe-path');
      if (normalized(realpathSync.native(cursor)) !== normalized(cursor)) fail('unsafe-path');
    } catch (error) {
      if (!(allowMissing && (error as NodeJS.ErrnoException)?.code === 'ENOENT')) throw error;
    }
    if (cursor === dirname(cursor)) break;
  }
  return target;
}
function snapshotRoot(value: OutputStorageSnapshot, projectId: string, workspaceId: string, defaultRunsRoot: string): string {
  const expected = value.configuredRoot === null ? defaultRunsRoot
    : join(value.configuredRoot, 'CheckMate', projectId, value.namespaceId!, workspaceId, 'runs');
  if (normalized(expected) !== normalized(value.runsRoot)) fail('storage-corrupt');
  return value.runsRoot;
}
function location(value: StoredLocation) {
  return { rootPath: value.root_path, namespaceId: value.storage_id, revision: value.setting_revision, layoutVersion: value.layout_version };
}
function audit(db: Database.Database, action: string, entity: string, detail: unknown, actor = 'human'): void {
  db.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,recorded_at,detail_json) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), action, actor, entity, new Date().toISOString(), JSON.stringify(detail));
}

export class ProjectStorage {
  readonly defaultRunsRoot: string;
  private readonly copying = new Set<string>();
  constructor(private readonly db: Database.Database, runsRoot: string,
    private readonly protectedPaths: string[] = []) {
    this.defaultRunsRoot = checkedStoragePath(runsRoot);
    if (!lstatSync(this.defaultRunsRoot).isDirectory()) fail('unsafe-path');
  }

  settings(projectId: string): ProjectStorageSettings {
    if (!z.uuid().safeParse(projectId).success) fail('invalid-input');
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) fail('project-not-found');
    const row = this.db.prepare('SELECT storage_id,root_path,revision FROM project_storage_settings WHERE project_id=?')
      .get(projectId) as { storage_id: string; root_path: string | null; revision: number } | undefined;
    if (row && (!z.uuid().safeParse(row.storage_id).success || !Number.isSafeInteger(row.revision) || row.revision < 1
      || (row.root_path !== null && !isAbsolute(row.root_path)))) fail('storage-corrupt');
    return { projectId, namespaceId: row?.storage_id ?? null, configuredRoot: row?.root_path ?? null,
      revision: row?.revision ?? 0, defaultRunsRoot: this.defaultRunsRoot, layoutVersion: 1 };
  }

  planSnapshot(projectId: string, workspaceId: string): OutputStorageSnapshot {
    const settings = this.settings(projectId);
    if (settings.configuredRoot !== null) this.verifyNamespace(settings.configuredRoot, projectId, settings.namespaceId!);
    return { layoutVersion: 1, configuredRoot: settings.configuredRoot, namespaceId: settings.namespaceId,
      revision: settings.revision, runsRoot: settings.configuredRoot === null ? this.defaultRunsRoot
        : join(settings.configuredRoot, 'CheckMate', projectId, settings.namespaceId!, workspaceId, 'runs') };
  }

  assertPlan(plan: PlanRegistration): void {
    if (!plan.plan.outputStorage && this.db.prepare("SELECT 1 FROM audit_events WHERE action='project-storage-restore-default' AND actor_kind='human' AND recorded_at>=? LIMIT 1")
      .get(plan.createdAt)) fail('plan-stale');
    const current = this.planSnapshot(plan.project.id, plan.workspace.id);
    if (plan.plan.outputStorage ? !isDeepStrictEqual(current, plan.plan.outputStorage) : current.revision !== 0) fail('plan-stale');
  }

  admit(plan: PlanRegistration, runId: string, createdAt: string): void {
    this.assertPlan(plan);
    const output = plan.plan.outputStorage;
    if (!output) return;
    snapshotRoot(output, plan.project.id, plan.workspace.id, this.defaultRunsRoot);
    this.db.prepare(`INSERT INTO run_storage_locations (run_id,root_path,storage_id,setting_revision,layout_version,created_at)
      VALUES (?,?,?,?,1,?)`).run(runId, join(output.runsRoot, runId), output.namespaceId, output.revision, createdAt);
  }

  resolveRun(runId: string): string {
    if (!z.uuid().safeParse(runId).success) fail('invalid-input');
    const run = this.db.prepare(`SELECT r.workspace_id,r.summary_json,p.plan_json FROM runs r JOIN plans p ON p.id=r.plan_id WHERE r.id=?`)
      .get(runId) as { workspace_id: string; summary_json: string; plan_json: string } | undefined;
    if (!run) fail('run-not-found');
    let plan: PlanRegistration;
    try { plan = planRegistrationSchema.parse(JSON.parse(run.plan_json)); } catch { fail('storage-corrupt'); }
    const row = this.db.prepare('SELECT root_path,storage_id,setting_revision,layout_version FROM run_storage_locations WHERE run_id=?')
      .get(runId) as StoredLocation | undefined;
    const output = plan.plan.outputStorage;
    if (!row) {
      if (output) fail('storage-corrupt');
      return checkedStoragePath(join(this.defaultRunsRoot, runId), true);
    }
    if (!row.root_path || !isAbsolute(row.root_path) || row.layout_version !== 1 || !Number.isSafeInteger(row.setting_revision)
      || row.setting_revision < 0 || (row.storage_id !== null && !z.uuid().safeParse(row.storage_id).success)) fail('storage-corrupt');
    const expected = output ? { rootPath: join(snapshotRoot(output, plan.project.id, plan.workspace.id,
      output.configuredRoot === null ? output.runsRoot : this.defaultRunsRoot), runId),
      namespaceId: output.namespaceId, revision: output.revision, layoutVersion: 1 } : null;
    if (!expected || !isDeepStrictEqual(expected, location(row))) {
      const authorized = this.db.prepare(`SELECT action,detail_json FROM audit_events WHERE actor_kind='human'
        AND action IN ('project-storage-completed','run-storage-restored') ORDER BY recorded_at DESC,id DESC`).all() as { action: string; detail_json: string }[];
      if (!authorized.some(event => {
        try {
          const detail = JSON.parse(event.detail_json) as { locations?: { runId: string; planHash: string; location: unknown }[] };
          return detail.locations?.some(item => item.runId === runId && item.planHash === plan.plan.fingerprint
            && isDeepStrictEqual(item.location, location(row))) === true;
        } catch { return false; }
      })) fail('storage-corrupt');
    }
    if (output && isDeepStrictEqual(expected, location(row)) && output.configuredRoot !== null)
      this.verifyNamespace(output.configuredRoot, plan.project.id, output.namespaceId!);
    // 이전된 위치도 현재 자기 이름 공간과 표식을 일치시킨다. 복원 위치는 기본 runs로만 허용한다.
    if (row.storage_id !== null && normalized(row.root_path) !== normalized(join(this.defaultRunsRoot, runId))) {
      const root = dirname(dirname(dirname(dirname(dirname(dirname(row.root_path))))));
      const expectedPath = join(root, 'CheckMate', plan.project.id, row.storage_id, run.workspace_id, 'runs', runId);
      if (normalized(expectedPath) !== normalized(row.root_path)) fail('storage-corrupt');
      this.verifyNamespace(root, plan.project.id, row.storage_id);
    } else if (normalized(row.root_path) !== normalized(join(this.defaultRunsRoot, runId))) fail('storage-corrupt');
    return checkedStoragePath(row.root_path, true);
  }

  saveResult(result: RunResult): void {
    const root = this.resolveRun(result.runId);
    checkedStoragePath(root, true);
    mkdirSync(join(root, 'results'), { recursive: true, mode: 0o700 });
    checkedStoragePath(join(root, 'results'));
    const path = 'results/결과.json';
    const bytes = Buffer.from(JSON.stringify({ recordKind: 'uncommitted-result-observation', commitVerified: false,
      authoritativeResult: 'service-database-query', candidateResult: result }), 'utf8');
    const target = join(root, 'results', '결과.json');
    try { writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      checkedStoragePath(target);
      if (digest(readFileSync(target)) !== digest(bytes)) fail('evidence-conflict');
    }
    const prior = this.db.prepare('SELECT sha256,byte_length FROM evidence WHERE run_id=? AND relative_path=?').get(result.runId, path) as
      { sha256: string; byte_length: number } | undefined;
    if (prior) { if (prior.sha256 !== digest(bytes) || prior.byte_length !== bytes.length) fail('evidence-conflict'); return; }
    this.db.prepare(`INSERT INTO evidence (id,run_id,relative_path,sha256,byte_length,mime,sensitivity,state) VALUES (?,?,?,?,?,'application/json','restricted','ready')`)
      .run(randomUUID(), result.runId, path, digest(bytes), bytes.length);
  }

  private owner(root: string, projectId: string, namespaceId: string) {
    return { version: 1, projectId, namespaceId,
      dataRootHash: digest(normalized(resolve(dirname(this.db.name)))) , rootIdentity: identity(root) };
  }
  private namespace(root: string, projectId: string, namespaceId: string): string {
    return join(root, 'CheckMate', projectId, namespaceId);
  }
  private verifyNamespace(root: string, projectId: string, namespaceId: string): Identity {
    checkedStoragePath(root);
    const namespace = checkedStoragePath(this.namespace(root, projectId, namespaceId));
    const marker = checkedStoragePath(join(namespace, markerName));
    const info = lstatSync(marker);
    if (!info.isFile() || info.size > 8192 || !isDeepStrictEqual(JSON.parse(readFileSync(marker, 'utf8')), this.owner(root, projectId, namespaceId))) fail('storage-ownership-unknown');
    const completed = this.db.prepare("SELECT detail_json FROM audit_events WHERE action='project-storage-completed' AND actor_kind='human' ORDER BY recorded_at DESC,id DESC")
      .all() as { detail_json: string }[];
    const expected = completed.map(event => JSON.parse(event.detail_json) as { result: ProjectStorageApplied; namespaceIdentity: Identity | null })
      .find(event => event.result.settings.projectId === projectId && event.result.settings.namespaceId === namespaceId && event.result.settings.configuredRoot === root);
    const actual = identity(namespace);
    if (expected?.namespaceIdentity && !isDeepStrictEqual(expected.namespaceIdentity, actual)) fail('storage-ownership-unknown');
    return actual;
  }

  private selectedRoot(root: string | null): string | null {
    if (root === null) return null;
    if (!outputStorageSchema.shape.configuredRoot.safeParse(root).success) fail('unsafe-path');
    const actual = checkedStoragePath(root);
    if (actual === parse(actual).root || !lstatSync(actual).isDirectory()) fail('unsafe-path');
    assertStorageOwner(actual);
    const workspaces = this.db.prepare('SELECT real_path FROM workspaces').all() as { real_path: string }[];
    for (const protectedPath of [...this.protectedPaths, this.defaultRunsRoot, dirname(this.db.name), ...workspaces.map(row => row.real_path)]) {
      const protectedRoot = checkedStoragePath(protectedPath, true);
      if (pathWithin(actual, protectedRoot) || pathWithin(protectedRoot, actual)) fail('unsafe-path');
    }
    return actual;
  }

  private idle(projectId: string): void {
    const runs = this.db.prepare(`SELECT r.id,r.origin,r.state,r.verdict,r.finalized_at,r.summary_json FROM runs r JOIN workspaces w ON w.id=r.workspace_id WHERE w.project_id=?`)
      .all(projectId) as { id: string; origin: string; state: string; verdict: string | null; finalized_at: string | null; summary_json: string }[];
    for (const run of runs) {
      if (run.origin === 'imported') continue;
      if (['queued','running','unverifiable'].includes(run.state) || run.verdict === 'unknown' || !run.finalized_at
        || JSON.parse(run.summary_json).cleanupVerified !== true
        || this.db.prepare("SELECT 1 FROM resources WHERE run_id=? AND state!='cleaned'").get(run.id)
        || this.db.prepare('SELECT 1 FROM execution_locks WHERE run_id=?').get(run.id)) fail('storage-busy');
    }
  }

  private inventory(projectId: string, targetRoot: string | null, namespaceId: string, copied = false): RunFiles[] {
    const rows = this.db.prepare(`SELECT r.id,r.workspace_id,r.origin,r.summary_json,p.fingerprint FROM runs r JOIN workspaces w ON w.id=r.workspace_id
      JOIN plans p ON p.id=r.plan_id WHERE w.project_id=? ORDER BY r.id`).all(projectId) as
      { id: string; workspace_id: string; origin: string; summary_json: string; fingerprint: string }[];
    return rows.map(row => {
      const sourceRoot = this.resolveRun(row.id);
      const target = targetRoot === null ? join(this.defaultRunsRoot, row.id) : join(targetRoot, 'CheckMate', projectId, namespaceId, row.workspace_id, 'runs', row.id);
      let present = true;
      try { if (!lstatSync(sourceRoot).isDirectory()) fail('storage-corrupt'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || row.origin !== 'imported') throw error;
        present = false;
      }
      const files = present ? scanRunFiles(sourceRoot) : [];
      const evidence = this.db.prepare('SELECT relative_path,sha256,byte_length,state FROM evidence WHERE run_id=? ORDER BY relative_path').all(row.id) as
        { relative_path: string; sha256: string; byte_length: number; state: string }[];
      for (const item of evidence) {
        const file = files.find(file => file.path === item.relative_path);
        if (!file || item.state !== 'ready' || file.sha256 !== item.sha256 || file.byteLength !== item.byte_length) fail('evidence-degraded');
      }
      checkedStoragePath(target, true);
      if (!copied && present && normalized(sourceRoot) !== normalized(target)) {
        try { lstatSync(target); fail('storage-destination-conflict'); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      }
      return { runId: row.id, workspaceId: row.workspace_id, sourceRoot, targetRoot: target, present,
        planHash: row.fingerprint, summaryHash: digest(row.summary_json), identity: present ? identity(sourceRoot) : null, files };
    });
  }

  preview(projectId: string, root: string | null, expectedRevision: number): ProjectStoragePreview {
    this.idle(projectId);
    const settings = this.settings(projectId);
    if (settings.revision !== expectedRevision) fail('plan-stale');
    const targetRoot = this.selectedRoot(root);
    const namespaceId = settings.namespaceId ?? randomUUID();
    const destinationRoot = targetRoot === null ? this.defaultRunsRoot : this.namespace(targetRoot, projectId, namespaceId);
    let namespaceIdentity: Identity | null = null;
    try {
      if (targetRoot !== null && lstatSync(destinationRoot)) namespaceIdentity = this.verifyNamespace(targetRoot, projectId, namespaceId);
    } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    const base = { projectId, previewId: randomUUID(), expectedRevision, currentRoot: settings.configuredRoot, targetRoot, namespaceId,
      destinationRoot, rootIdentity: identity(targetRoot ?? this.defaultRunsRoot), namespaceIdentity,
      runs: this.inventory(projectId, targetRoot, namespaceId) };
    const frozen: FrozenPreview = { ...base, fingerprint: digest(JSON.stringify(base)) };
    audit(this.db, 'project-storage-preview', base.previewId, frozen);
    const files = frozen.runs.flatMap(run => run.files);
    return { projectId, previewId: frozen.previewId, expectedRevision, currentRoot: frozen.currentRoot, targetRoot,
      destinationRoot, fingerprint: frozen.fingerprint, runCount: frozen.runs.filter(run => run.present).length,
      fileCount: files.length, byteLength: files.reduce((sum, file) => sum + file.byteLength, 0), originalsPreserved: true };
  }

  operation(projectId: string, operationId: string): ProjectStorageOperation {
    this.settings(projectId);
    if (!z.uuid().safeParse(operationId).success) fail('invalid-input');
    const rows = this.db.prepare("SELECT action,detail_json FROM audit_events WHERE entity_id=? AND action IN ('project-storage-intent','project-storage-completed','project-storage-failed','project-storage-unknown') ORDER BY recorded_at DESC,id DESC")
      .all(operationId) as { action: string; detail_json: string }[];
    const events = rows.map(row => ({ action: row.action, detail: JSON.parse(row.detail_json) as
      { projectId: string; result?: ProjectStorageApplied; error?: string } }));
    if (events.some(row => row.detail.projectId !== projectId)) fail('request-conflict');
    const final = events.find(row => ['project-storage-completed','project-storage-failed','project-storage-unknown'].includes(row.action));
    if (final?.action === 'project-storage-completed' && final.detail.result) return { projectId, operationId, state: 'completed', result: final.detail.result };
    if (final) return { projectId, operationId, state: final.action === 'project-storage-failed' ? 'failed' : 'unknown', error: final.detail.error ?? 'storage-error' };
    return { projectId, operationId, state: events.length === 0 ? 'not-found' : this.copying.has(operationId) ? 'copying' : 'unknown' };
  }

  async apply(projectId: string, previewId: string, expectedRevision: number, fingerprint: string, operationId: string): Promise<ProjectStorageApplied> {
    const bodyHash = digest(JSON.stringify({ projectId, previewId, expectedRevision, fingerprint, confirm: true }));
    const intent = this.db.prepare("SELECT detail_json FROM audit_events WHERE entity_id=? AND action='project-storage-intent'").get(operationId) as { detail_json: string } | undefined;
    if (intent) {
      const old = JSON.parse(intent.detail_json) as { bodyHash: string; projectId: string };
      if (old.bodyHash !== bodyHash || old.projectId !== projectId) fail('request-conflict');
      const status = this.operation(projectId, operationId);
      if (status.state === 'completed' && status.result) return status.result;
      fail(status.error ?? 'storage-operation-unknown');
    }
    const row = this.db.prepare("SELECT detail_json FROM audit_events WHERE entity_id=? AND action='project-storage-preview' AND actor_kind='human'")
      .get(previewId) as { detail_json: string } | undefined;
    if (!row) fail('plan-stale');
    const frozen = JSON.parse(row.detail_json) as FrozenPreview;
    const { fingerprint: savedFingerprint, ...base } = frozen;
    if (digest(JSON.stringify(base)) !== savedFingerprint || fingerprint !== savedFingerprint || projectId !== frozen.projectId
      || expectedRevision !== frozen.expectedRevision) fail('plan-stale');
    this.checkFrozen(frozen);
    this.db.transaction(() => {
      this.checkFrozen(frozen);
      const unresolved = this.db.prepare(`SELECT a.entity_id FROM audit_events a WHERE a.action='project-storage-intent'
        AND json_extract(a.detail_json,'$.projectId')=? AND NOT EXISTS (SELECT 1 FROM audit_events b WHERE b.entity_id=a.entity_id
        AND b.action IN ('project-storage-completed','project-storage-failed')) LIMIT 1`).get(projectId);
      if (unresolved) fail('storage-operation-unknown');
      audit(this.db, 'project-storage-intent', operationId, { projectId, bodyHash, previewId, fingerprint });
    }).immediate();
    this.copying.add(operationId);
    let committing = false;
    try {
      if (frozen.targetRoot !== null) await this.createNamespace(frozen);
      const createdNamespaceIdentity = frozen.targetRoot === null ? null : identity(frozen.destinationRoot);
      for (const run of frozen.runs.filter(run => run.present && normalized(run.sourceRoot) !== normalized(run.targetRoot))) {
        checkedStoragePath(run.targetRoot, true);
        await mkdir(dirname(run.targetRoot), { recursive: true, mode: 0o700 });
        checkedStoragePath(dirname(run.targetRoot));
        await privateStoragePath(dirname(run.targetRoot));
        await mkdir(run.targetRoot, { mode: 0o700 });
        await privateStoragePath(run.targetRoot);
        for (const file of run.files) {
          const target = join(run.targetRoot, ...file.path.split('/'));
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          checkedStoragePath(dirname(target));
          await copyFile(join(run.sourceRoot, ...file.path.split('/')), target, constants.COPYFILE_EXCL);
          await privateStoragePath(target, true);
        }
        if (!isDeepStrictEqual(scanRunFiles(run.targetRoot), run.files)) fail('evidence-degraded');
      }
      this.checkFrozen(frozen, true);
      const namespaceIdentity = frozen.targetRoot === null ? null : identity(frozen.destinationRoot);
      if (!isDeepStrictEqual(createdNamespaceIdentity, namespaceIdentity)) fail('storage-ownership-unknown');
      committing = true;
      return this.db.transaction(() => {
        this.checkFrozen(frozen, true);
        const now = new Date().toISOString();
        const current = this.settings(projectId);
        if (current.revision !== expectedRevision) fail('plan-stale');
        if (expectedRevision === 0) this.db.prepare('INSERT INTO project_storage_settings (project_id,storage_id,root_path,revision,updated_at) VALUES (?,?,?,1,?)')
          .run(projectId, frozen.namespaceId, frozen.targetRoot, now);
        else if (this.db.prepare('UPDATE project_storage_settings SET root_path=?,revision=revision+1,updated_at=? WHERE project_id=? AND revision=?')
          .run(frozen.targetRoot, now, projectId, expectedRevision).changes !== 1) fail('plan-stale');
        const locations = frozen.runs.filter(run => run.present).map(run => {
          const value = { rootPath: run.targetRoot, namespaceId: frozen.namespaceId, revision: expectedRevision + 1, layoutVersion: 1 };
          this.db.prepare(`INSERT INTO run_storage_locations (run_id,root_path,storage_id,setting_revision,layout_version,created_at) VALUES (?,?,?,?,1,?)
            ON CONFLICT(run_id) DO UPDATE SET root_path=excluded.root_path,storage_id=excluded.storage_id,setting_revision=excluded.setting_revision,layout_version=1`)
            .run(run.runId, run.targetRoot, frozen.namespaceId, expectedRevision + 1, now);
          return { runId: run.runId, from: run.sourceRoot, planHash: run.planHash, location: value };
        });
        const files = frozen.runs.flatMap(run => run.files);
        const result: ProjectStorageApplied = { settings: this.settings(projectId), operationId,
          movedRunCount: locations.length, fileCount: files.length, byteLength: files.reduce((sum, file) => sum + file.byteLength, 0), originalsPreserved: true };
        audit(this.db, 'project-storage-completed', operationId, { projectId, bodyHash, previewId, fingerprint, locations, namespaceIdentity,
          metadataOnlyRuns: frozen.runs.filter(run => !run.present), result });
        return result;
      }).immediate();
    } catch (error) {
      const status = this.operation(projectId, operationId);
      if (status.state === 'completed' && status.result) return status.result;
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'storage-error';
      try { audit(this.db, committing ? 'project-storage-unknown' : 'project-storage-failed', operationId, { projectId, bodyHash, previewId, error: code }); }
      catch { /* 원본과 부분 복사를 보존하며 intent를 불명 상태로 남긴다. */ }
      const failure = new ServiceError(code); failure.cause = error; throw failure;
    } finally { this.copying.delete(operationId); }
  }

  private checkFrozen(frozen: FrozenPreview, created = false): void {
    this.idle(frozen.projectId);
    const settings = this.settings(frozen.projectId);
    if (settings.revision !== frozen.expectedRevision || settings.configuredRoot !== frozen.currentRoot) fail('plan-stale');
    this.selectedRoot(frozen.targetRoot);
    if (!isDeepStrictEqual(identity(frozen.targetRoot ?? this.defaultRunsRoot), frozen.rootIdentity)
      || !isDeepStrictEqual(this.inventory(frozen.projectId, frozen.targetRoot, frozen.namespaceId, created), frozen.runs)) fail('source-changed');
    if (frozen.targetRoot !== null && (created || frozen.namespaceIdentity !== null)) {
      const actual = this.verifyNamespace(frozen.targetRoot, frozen.projectId, frozen.namespaceId);
      if (frozen.namespaceIdentity !== null && !isDeepStrictEqual(actual, frozen.namespaceIdentity)) fail('storage-ownership-unknown');
    }
    if (created) for (const run of frozen.runs.filter(run => run.present))
      if (!isDeepStrictEqual(scanRunFiles(run.targetRoot), run.files)) fail('evidence-degraded');
  }

  private async createNamespace(frozen: FrozenPreview): Promise<void> {
    if (frozen.namespaceIdentity !== null) { this.verifyNamespace(frozen.targetRoot!, frozen.projectId, frozen.namespaceId); return; }
    checkedStoragePath(frozen.destinationRoot, true);
    await mkdir(dirname(frozen.destinationRoot), { recursive: true, mode: 0o700 });
    checkedStoragePath(dirname(frozen.destinationRoot));
    await mkdir(frozen.destinationRoot, { mode: 0o700 });
    await privateStoragePath(frozen.destinationRoot);
    const marker = join(frozen.destinationRoot, markerName);
    const file = await open(marker, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(this.owner(frozen.targetRoot!, frozen.projectId, frozen.namespaceId))); await file.sync(); }
    finally { await file.close(); }
    await privateStoragePath(marker, true);
  }
}

export function scanRunFiles(root: string, limits: { maxFileBytes?: number; maxFiles?: number; maxDepth?: number;
  maxTotalBytes?: number; exclude?: ReadonlySet<string> } = {}): FileRecord[] {
  checkedStoragePath(root);
  const files: FileRecord[] = [];
  let totalBytes = 0;
  function visit(directory: string, prefix: string, depth: number): void {
    if (limits.maxDepth !== undefined && depth > limits.maxDepth) fail('artifact-limit');
    for (const name of readdirSync(directory).sort()) {
      if (!name || name === '.' || name === '..' || /[\\:\x00-\x1f\x7f<>"|?*]/u.test(name) || /[. ]$/u.test(name)) fail('unsafe-path');
      const path = join(directory, name);
      checkedStoragePath(path);
      const info = lstatSync(path, { bigint: true });
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) visit(path, relativePath, depth + 1);
      else {
        if (limits.exclude?.has(relativePath)) continue;
        if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('unsafe-path');
        totalBytes += Number(info.size);
        if ((limits.maxFileBytes !== undefined && info.size > BigInt(limits.maxFileBytes))
          || (limits.maxFiles !== undefined && files.length >= limits.maxFiles)
          || (limits.maxTotalBytes !== undefined && totalBytes > limits.maxTotalBytes)) fail('artifact-limit');
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = fstatSync(fd, { bigint: true });
          if (opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1n) fail('source-changed');
          const hash = createHash('sha256');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let size = 0;
          for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; size += count; hash.update(buffer.subarray(0, count)); }
          const after = fstatSync(fd, { bigint: true });
          const final = lstatSync(path, { bigint: true });
          if ([after, final].some(stat => stat.dev !== info.dev || stat.ino !== info.ino || stat.size !== info.size
            || stat.mtimeNs !== info.mtimeNs || stat.ctimeNs !== info.ctimeNs || stat.nlink !== 1n || stat.isSymbolicLink())
            || size !== Number(info.size)) fail('source-changed');
          files.push({ path: relativePath, sha256: hash.digest('hex'), byteLength: size });
        } finally { closeSync(fd); }
      }
    }
  }
  visit(root, '', 0);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function restoredRunLocations(db: Database.Database, runsRoot: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_storage_locations'").get()) {
    audit(db, 'project-storage-restore-default', randomUUID(), { runsRoot, futurePlansRequireReview: true });
    return;
  }
  const rows = db.prepare('SELECT r.id,p.plan_json FROM runs r JOIN plans p ON p.id=r.plan_id').all() as { id: string; plan_json: string }[];
  for (const row of rows) {
    const plan = planRegistrationSchema.parse(JSON.parse(row.plan_json));
    const output = plan.plan.outputStorage;
    const prior = db.prepare('SELECT 1 FROM run_storage_locations WHERE run_id=?').get(row.id);
    if (!output && !prior) continue;
    const value = { rootPath: join(runsRoot, row.id), namespaceId: null, revision: 0, layoutVersion: 1 };
    db.prepare(`INSERT INTO run_storage_locations (run_id,root_path,storage_id,setting_revision,layout_version,created_at) VALUES (?,?,NULL,0,1,?)
      ON CONFLICT(run_id) DO UPDATE SET root_path=excluded.root_path,storage_id=NULL,setting_revision=0,layout_version=1`)
      .run(row.id, value.rootPath, new Date().toISOString());
    audit(db, 'run-storage-restored', row.id, { locations: [{ runId: row.id, planHash: plan.plan.fingerprint, location: value }] });
  }
  db.prepare('UPDATE project_storage_settings SET root_path=NULL,revision=revision+1,updated_at=?').run(new Date().toISOString());
  for (const project of db.prepare('SELECT id FROM projects WHERE id NOT IN (SELECT project_id FROM project_storage_settings)').all() as { id: string }[]) {
    db.prepare('INSERT INTO project_storage_settings (project_id,storage_id,root_path,revision,updated_at) VALUES (?,?,NULL,1,?)')
      .run(project.id, randomUUID(), new Date().toISOString());
  }
  audit(db, 'project-storage-restore-default', randomUUID(), { runsRoot });
}
