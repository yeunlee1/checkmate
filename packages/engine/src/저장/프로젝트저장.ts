// 프로젝트 원본과 계획 및 사람의 승인을 같은 SQLite 저장소에 연결한다.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { projectSourceSchema, type ProjectDefinition, type ProjectSnapshot, type ProjectSource } from '@checkmate/contracts/project';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { SQLiteRunStore } from './실행저장.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const snapshotSchema = z.strictObject({ realPath: z.string(), source: projectSourceSchema,
  contentHash: hashSchema, sourceHash: hashSchema });
const scopeSchema = z.strictObject({ planId: z.uuid(), fingerprint: hashSchema,
  sourceHash: hashSchema, writes: z.array(z.string()), commands: z.array(projectSourceSchema.shape.project.shape.commands.element) });

export type ProjectInfo = { id: string; name: string; repositoryIdentity: string; workspaceId: string;
  realPath: string; activeCatalogHash: string; profiles: { id: string; title: string }[] };
export type CatalogChange = { projectId: string; contentHash: string; active: boolean;
  added: string[]; removed: string[]; changed: string[]; weakened: string[] };
export type PlanReview = { planId: string; projectId: string; profile: string; fingerprint: string; sourceHash: string;
  checks: { id: string; title: string; required: boolean }[]; commands: ProjectDefinition['commands'];
  writes: string[]; resourceEffects: string[]; needsApproval: boolean };

export class ProjectStoreError extends Error {
  constructor(public readonly code: string) { super('프로젝트 저장 작업을 처리할 수 없습니다.'); }
}

type ProjectRow = { id: string; name: string; repository_identity: string; active_catalog_id: string | null };
type WorkspaceRow = { id: string; project_id: string; real_path: string; path_fingerprint: string };
type CatalogRow = { id: string; project_id: string; content_hash: string; source_json: string };
type PlanRow = { id: string; workspace_id: string; catalog_id: string; fingerprint: string };
type ApprovalScope = z.infer<typeof scopeSchema>;

function fail(error: unknown): never {
  if (error instanceof ProjectStoreError) throw error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) throw new ProjectStoreError('storage-busy');
  throw new ProjectStoreError('storage-error');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function realProjectPath(path: string): string {
  if (!isAbsolute(path)) throw new ProjectStoreError('invalid-input');
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid-directory');
    const actual = normalize(realpathSync.native(path));
    return process.platform === 'win32' ? actual.toLowerCase() : actual;
  } catch { throw new ProjectStoreError('invalid-input'); }
}

function snapshot(input: ProjectSnapshot): ProjectSnapshot {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success || parsed.data.contentHash !== sha256(canonical(parsed.data.source)))
    throw new ProjectStoreError('invalid-input');
  return { ...parsed.data, realPath: realProjectPath(parsed.data.realPath) };
}

function storedSource(json: string): ProjectSource {
  try {
    const parsed = projectSourceSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch { /* 손상된 JSON은 저장 오류로만 반환한다. */ }
  throw new ProjectStoreError('storage-error');
}

function selection(source: ProjectSource, profileId: string) {
  const profile = source.project.profiles.find((item) => item.id === profileId);
  if (!profile) throw new ProjectStoreError('invalid-input');
  const checks = profile.checkIds.map((id) => source.checks.find((item) => item.id === id)!);
  const byId = new Map(source.project.commands.map((item) => [item.id, item]));
  const commands = [...new Set(checks.map((item) => item.commandId))].map((id) => byId.get(id)!);
  const writes = [...new Set(commands.flatMap((item) => item.writes))];
  return { checks, commands, writes };
}

function changes(before: ProjectSource, after: ProjectSource): Omit<CatalogChange, 'projectId' | 'contentHash' | 'active'> {
  const old = new Map(before.checks.map((item) => [item.id, item]));
  const next = new Map(after.checks.map((item) => [item.id, item]));
  const added = [...next.keys()].filter((id) => !old.has(id)).sort();
  const removed = [...old.keys()].filter((id) => !next.has(id)).sort();
  const changed: string[] = [];
  const weakened = [...removed];
  for (const [id, item] of next) {
    const prior = old.get(id);
    if (!prior) continue;
    if (!isDeepStrictEqual(prior, item)) changed.push(id);
    if ((prior.required && !item.required) || prior.requirementId !== item.requirementId
      || prior.expected !== item.expected || prior.commandId !== item.commandId
      || !isDeepStrictEqual(prior.codePaths, item.codePaths)) weakened.push(id);
  }
  return { added, removed, changed: changed.sort(), weakened: [...new Set(weakened)].sort() };
}

export class ProjectStore {
  private readonly runs: SQLiteRunStore;
  constructor(private readonly db: Database.Database) { this.runs = new SQLiteRunStore(db); }

  private project(id: string): ProjectRow {
    if (!z.uuid().safeParse(id).success) throw new ProjectStoreError('invalid-input');
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new ProjectStoreError('project-not-found');
    return row;
  }

  private workspace(id: string): WorkspaceRow {
    const rows = this.db.prepare('SELECT * FROM workspaces WHERE project_id = ?').all(id) as WorkspaceRow[];
    if (rows.length !== 1) throw new ProjectStoreError('storage-error');
    return rows[0]!;
  }

  private catalog(id: string): { row: CatalogRow; source: ProjectSource } {
    const row = this.db.prepare('SELECT * FROM catalogs WHERE id = ?').get(id) as CatalogRow | undefined;
    if (!row) throw new ProjectStoreError('storage-error');
    const source = storedSource(row.source_json);
    if (sha256(canonical(source)) !== row.content_hash) throw new ProjectStoreError('storage-error');
    return { row, source };
  }

  private saveCatalog(projectId: string, source: ProjectSource, contentHash: string): CatalogRow {
    const prior = this.db.prepare('SELECT * FROM catalogs WHERE project_id = ? AND content_hash = ?')
      .get(projectId, contentHash) as CatalogRow | undefined;
    if (prior) {
      if (!isDeepStrictEqual(storedSource(prior.source_json), source)) throw new ProjectStoreError('storage-error');
      return prior;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO catalogs (id,project_id,content_hash,source_json,created_at) VALUES (?,?,?,?,?)')
      .run(id, projectId, contentHash, JSON.stringify(source), new Date().toISOString());
    const definition = this.db.prepare('INSERT INTO definitions (catalog_id,kind,definition_id,content_json) VALUES (?,?,?,?)');
    for (const item of source.requirements) definition.run(id, 'requirement', item.id, JSON.stringify(item));
    for (const item of source.checks) definition.run(id, 'check', item.id, JSON.stringify(item));
    for (const item of source.project.profiles) definition.run(id, 'profile', item.id, JSON.stringify(item));
    const link = this.db.prepare('INSERT INTO requirement_checks (catalog_id,requirement_id,check_id,required) VALUES (?,?,?,?)');
    for (const item of source.checks) link.run(id, item.requirementId, item.id, item.required ? 1 : 0);
    return { id, project_id: projectId, content_hash: contentHash, source_json: JSON.stringify(source) };
  }

  register(input: ProjectSnapshot): ProjectInfo {
    const value = snapshot(input);
    const { project: definition } = value.source;
    try {
      this.db.transaction(() => {
        const sameId = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(definition.id) as ProjectRow | undefined;
        const sameIdentity = this.db.prepare('SELECT id FROM projects WHERE repository_identity = ?')
          .all(definition.repositoryIdentity) as { id: string }[];
        const samePath = this.db.prepare('SELECT * FROM workspaces WHERE real_path = ? COLLATE NOCASE')
          .get(value.realPath) as WorkspaceRow | undefined;
        if (sameIdentity.some((item) => item.id !== definition.id) || (samePath && samePath.project_id !== definition.id))
          throw new ProjectStoreError('project-conflict');
        if (sameId) {
          if (sameId.name !== definition.name || sameId.repository_identity !== definition.repositoryIdentity
            || !samePath || samePath.project_id !== definition.id || this.workspace(definition.id).id !== samePath.id)
            throw new ProjectStoreError('project-conflict');
          const active = this.catalog(sameId.active_catalog_id!);
          if (active.row.content_hash !== value.contentHash || !isDeepStrictEqual(active.source, value.source))
            throw new ProjectStoreError('catalog-stale');
          return;
        }
        this.db.prepare('INSERT INTO projects (id,name,repository_identity,active_catalog_id,created_at) VALUES (?,?,?,NULL,?)')
          .run(definition.id, definition.name, definition.repositoryIdentity, new Date().toISOString());
        this.db.prepare('INSERT INTO workspaces (id,project_id,real_path,path_fingerprint,created_at) VALUES (?,?,?,?,?)')
          .run(randomUUID(), definition.id, value.realPath, sha256(value.realPath), new Date().toISOString());
        const catalog = this.saveCatalog(definition.id, value.source, value.contentHash);
        this.db.prepare('UPDATE projects SET active_catalog_id = ? WHERE id = ?').run(catalog.id, definition.id);
      })();
      return this.get(definition.id);
    } catch (error) { fail(error); }
  }

  get(projectId: string): ProjectInfo {
    try {
      const project = this.project(projectId);
      const workspace = this.workspace(projectId);
      if (!project.active_catalog_id) throw new ProjectStoreError('storage-error');
      const { row, source } = this.catalog(project.active_catalog_id);
      if (row.project_id !== projectId || source.project.id !== projectId
        || source.project.name !== project.name || source.project.repositoryIdentity !== project.repository_identity)
        throw new ProjectStoreError('storage-error');
      return { id: project.id, name: project.name, repositoryIdentity: project.repository_identity,
        workspaceId: workspace.id, realPath: workspace.real_path, activeCatalogHash: row.content_hash,
        profiles: source.project.profiles.map(({ id, title }) => ({ id, title })) };
    } catch (error) { fail(error); }
  }

  list(): ProjectInfo[] {
    try {
      const ids = this.db.prepare('SELECT id FROM projects ORDER BY id').all() as { id: string }[];
      return ids.map(({ id }) => this.get(id));
    } catch (error) { fail(error); }
  }

  sync(input: ProjectSnapshot, activate = false): CatalogChange {
    const value = snapshot(input);
    if (typeof activate !== 'boolean') throw new ProjectStoreError('invalid-input');
    const projectId = value.source.project.id;
    try {
      return this.db.transaction(() => {
        const project = this.project(projectId);
        if (project.repository_identity !== value.source.project.repositoryIdentity
          || this.workspace(projectId).real_path !== value.realPath) throw new ProjectStoreError('project-conflict');
        if (!project.active_catalog_id) throw new ProjectStoreError('storage-error');
        const previous = this.catalog(project.active_catalog_id);
        const diff = changes(previous.source, value.source);
        const candidate = this.saveCatalog(projectId, value.source, value.contentHash);
        if (activate && candidate.id !== previous.row.id) {
          this.db.prepare('UPDATE projects SET active_catalog_id = ?, name = ? WHERE id = ?')
            .run(candidate.id, value.source.project.name, projectId);
          this.audit('catalog-activated', projectId, previous.row.content_hash, value.contentHash, null,
            { catalogId: candidate.id });
        }
        return { projectId, contentHash: value.contentHash,
          active: activate || candidate.id === previous.row.id, ...diff };
      })();
    } catch (error) { fail(error); }
  }

  private audit(action: string, entityId: string, beforeHash: string | null, afterHash: string | null,
    approvalId: string | null, detail: Record<string, string>): void {
    this.db.prepare(`INSERT INTO audit_events
      (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json)
      VALUES (?,?, 'human', ?,?,?,?,?,?)`).run(randomUUID(), action, entityId, beforeHash, afterHash,
      approvalId, new Date().toISOString(), JSON.stringify(detail));
  }

  inspect(input: ProjectSnapshot, profileId: string): PlanReview {
    const value = snapshot(input);
    if (typeof profileId !== 'string') throw new ProjectStoreError('invalid-input');
    const projectId = value.source.project.id;
    try {
      const plan = this.db.transaction(() => {
        const project = this.project(projectId);
        const workspace = this.workspace(projectId);
        if (workspace.real_path !== value.realPath || project.repository_identity !== value.source.project.repositoryIdentity)
          throw new ProjectStoreError('project-conflict');
        if (!project.active_catalog_id) throw new ProjectStoreError('storage-error');
        const catalog = this.catalog(project.active_catalog_id);
        if (catalog.row.content_hash !== value.contentHash || !isDeepStrictEqual(catalog.source, value.source))
          throw new ProjectStoreError('catalog-stale');
        const selected = selection(catalog.source, profileId);
        const fingerprint = sha256(canonical({ projectId, realPath: workspace.real_path,
          catalogHash: catalog.row.content_hash, sourceHash: value.sourceHash, profileId,
          checks: selected.checks, commands: selected.commands, node: process.version }));
        const old = this.db.prepare('SELECT * FROM plans WHERE workspace_id = ? AND catalog_id = ? AND fingerprint = ? ORDER BY created_at, id LIMIT 1')
          .get(workspace.id, catalog.row.id, fingerprint) as PlanRow | undefined;
        const planId = old?.id ?? randomUUID();
        const registration: PlanRegistration = {
          project: { id: projectId, name: project.name, repositoryIdentity: project.repository_identity },
          workspace: { id: workspace.id, realPath: workspace.real_path, pathFingerprint: workspace.path_fingerprint },
          catalog: { id: catalog.row.id, contentHash: catalog.row.content_hash,
            source: z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(catalog.source))) },
          plan: { id: planId, fingerprint, sourceHash: value.sourceHash, profile: profileId,
            plannedChecks: selected.checks.map((item) => item.id),
            requiredChecks: selected.checks.filter((item) => item.required).map((item) => item.id) },
          createdAt: new Date().toISOString(),
        };
        if (old) {
          const stored = this.runs.getPlan(old.id);
          if (!stored || !isDeepStrictEqual(stored.project, registration.project)
            || !isDeepStrictEqual(stored.workspace, registration.workspace)
            || !isDeepStrictEqual(stored.catalog, registration.catalog)
            || !isDeepStrictEqual(stored.plan, registration.plan))
            throw new ProjectStoreError('storage-error');
        } else this.runs.registerPlan(registration);
        return { planId, projectId, profile: profileId, fingerprint, sourceHash: value.sourceHash,
          checks: selected.checks.map(({ id, title, required }) => ({ id, title, required })),
          commands: selected.commands, writes: selected.writes,
          resourceEffects: selected.commands.some(command => command.resources?.includes('postgres-test'))
            ? ['새 일회용 PostgreSQL 컨테이너를 만들고 이 컴퓨터의 동적 포트로 연결합니다.',
              '컨테이너 안의 합성 DB 전체에 마이그레이션·쓰기·삭제를 허용하며, 실행 종료 시 컨테이너와 자료를 제거합니다. 기존 DB와 볼륨은 연결하지 않습니다.'] : [] };
      })();
      return { ...plan, needsApproval: !this.hasApproval(plan.planId) };
    } catch (error) { fail(error); }
  }

  private planContext(planId: string) {
    if (!z.uuid().safeParse(planId).success) throw new ProjectStoreError('invalid-input');
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
    if (!row) return null;
    const registration = this.runs.getPlan(planId);
    if (!registration || registration.plan.fingerprint !== row.fingerprint
      || registration.workspace.id !== row.workspace_id || registration.catalog.id !== row.catalog_id)
      throw new ProjectStoreError('storage-error');
    const project = this.project(registration.project.id);
    if (this.workspace(project.id).id !== row.workspace_id) throw new ProjectStoreError('storage-error');
    const catalog = this.catalog(row.catalog_id);
    if (catalog.row.project_id !== project.id || catalog.row.content_hash !== registration.catalog.contentHash
      || !isDeepStrictEqual(catalog.source, registration.catalog.source)) throw new ProjectStoreError('storage-error');
    const selected = selection(catalog.source, registration.plan.profile);
    const scope: ApprovalScope = { planId, fingerprint: registration.plan.fingerprint,
      sourceHash: registration.plan.sourceHash, writes: selected.writes, commands: selected.commands };
    return { row, project, registration, scope, active: project.active_catalog_id === row.catalog_id };
  }

  private approval(planId: string, scope: ApprovalScope): string | null {
    const rows = this.db.prepare(`SELECT id,scope_json,expires_at,evidence_kind,evidence_ref FROM approvals
      WHERE plan_id = ? AND scope_hash = ? AND revoked_at IS NULL ORDER BY granted_at DESC, id DESC`)
      .all(planId, scope.fingerprint) as { id: string; scope_json: string; expires_at: string | null;
        evidence_kind: string; evidence_ref: string }[];
    for (const row of rows) {
      if (row.evidence_kind !== 'local-user-confirmation' || row.evidence_ref !== `plan:${planId}`)
        throw new ProjectStoreError('storage-error');
      let parsed: z.infer<typeof scopeSchema>;
      try {
        const result = scopeSchema.safeParse(JSON.parse(row.scope_json));
        if (!result.success) throw new Error('invalid-scope');
        parsed = result.data;
      } catch { throw new ProjectStoreError('storage-error'); }
      if (!isDeepStrictEqual(parsed, scope)) throw new ProjectStoreError('storage-error');
      if (row.expires_at === null || Date.parse(row.expires_at) > Date.now()) return row.id;
    }
    return null;
  }

  approve(planId: string, fingerprint: string): { approvalId: string } {
    if (!z.uuid().safeParse(planId).success || !hashSchema.safeParse(fingerprint).success)
      throw new ProjectStoreError('invalid-input');
    try {
      return this.db.transaction(() => {
        const context = this.planContext(planId);
        if (!context || !context.active || context.registration.plan.fingerprint !== fingerprint)
          throw new ProjectStoreError('plan-stale');
        const existing = this.approval(planId, context.scope);
        if (existing) return { approvalId: existing };
        const approvalId = randomUUID();
        this.db.prepare(`INSERT INTO approvals (id,plan_id,scope_hash,scope_json,evidence_kind,evidence_ref,granted_at)
          VALUES (?,?,?,?,?,?,?)`).run(approvalId, planId, fingerprint, JSON.stringify(context.scope),
          'local-user-confirmation', `plan:${planId}`, new Date().toISOString());
        this.audit('plan-approved', planId, null, fingerprint, approvalId, { planId });
        return { approvalId };
      })();
    } catch (error) { fail(error); }
  }

  hasApproval(planId: string): boolean {
    try {
      const context = this.planContext(planId);
      return !!context?.active && this.approval(planId, context.scope) !== null;
    } catch (error) { fail(error); }
  }
}
