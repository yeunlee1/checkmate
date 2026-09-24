// 등록된 계획과 실행 결과를 SQLite 트랜잭션으로 보존한다.
import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assessResult, runResultSchema } from '@checkmate/contracts';
import type { RunResult } from '@checkmate/contracts';
import { planRegistrationSchema, RunStoreError } from '@checkmate/contracts/runs';
import type { Admission, AdmissionResult, PlanRegistration, RunPage, RunStore } from '@checkmate/contracts/runs';

const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime({ offset: false });
type Row = Record<string, unknown>;

function failure(error: unknown): never {
  if (error instanceof RunStoreError) throw error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') throw new RunStoreError('storage-busy');
  throw new RunStoreError('storage-error');
}

function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RunStoreError('invalid-input');
  return result.data;
}

function stored<T>(schema: z.ZodType<T>, input: string): T {
  try {
    const result = schema.safeParse(JSON.parse(input));
    if (result.success) return result.data;
  } catch { /* 손상된 저장값은 오류로 반환한다. */ }
  throw new RunStoreError('storage-error');
}

function absoluteRealPath(path: string): string {
  if (!isAbsolute(path)) throw new RunStoreError('invalid-input');
  try {
    const resolved = normalize(realpathSync.native(path));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    throw new RunStoreError('invalid-input');
  }
}

function same(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new RunStoreError('invalid-input');
}

export class SQLiteRunStore implements RunStore {
  constructor(private readonly db: Database.Database) {}

  registerPlan(input: PlanRegistration): void {
    const parsed = valid(planRegistrationSchema, input);
    const registration = { ...parsed, workspace: { ...parsed.workspace, realPath: absoluteRealPath(parsed.workspace.realPath) } };
    try {
      this.db.transaction(() => {
        const { project, workspace, catalog, plan, createdAt } = registration;
        const oldProject = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Row | undefined;
        if (oldProject) same([oldProject.name, oldProject.repository_identity], [project.name, project.repositoryIdentity]);
        else this.db.prepare('INSERT INTO projects (id,name,repository_identity,active_catalog_id,created_at) VALUES (?,?,?,NULL,?)')
          .run(project.id, project.name, project.repositoryIdentity, createdAt);

        const oldWorkspace = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace.id) as Row | undefined;
        if (oldWorkspace) same([oldWorkspace.project_id, oldWorkspace.real_path, oldWorkspace.path_fingerprint],
          [project.id, workspace.realPath, workspace.pathFingerprint]);
        else this.db.prepare('INSERT INTO workspaces (id,project_id,real_path,path_fingerprint,created_at) VALUES (?,?,?,?,?)')
          .run(workspace.id, project.id, workspace.realPath, workspace.pathFingerprint, createdAt);

        const oldCatalog = this.db.prepare('SELECT * FROM catalogs WHERE id = ?').get(catalog.id) as Row | undefined;
        if (oldCatalog) same([oldCatalog.project_id, oldCatalog.content_hash, JSON.parse(String(oldCatalog.source_json))],
          [project.id, catalog.contentHash, catalog.source]);
        else this.db.prepare('INSERT INTO catalogs (id,project_id,content_hash,source_json,created_at) VALUES (?,?,?,?,?)')
          .run(catalog.id, project.id, catalog.contentHash, JSON.stringify(catalog.source), createdAt);
        if (!oldProject || oldProject.active_catalog_id === null) {
          this.db.prepare('UPDATE projects SET active_catalog_id = ? WHERE id = ? AND active_catalog_id IS NULL').run(catalog.id, project.id);
        }

        const oldPlan = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id) as Row | undefined;
        if (oldPlan) {
          same([oldPlan.workspace_id, oldPlan.catalog_id, oldPlan.fingerprint, oldPlan.source_hash, stored(planRegistrationSchema, String(oldPlan.plan_json))],
            [workspace.id, catalog.id, plan.fingerprint, plan.sourceHash, registration]);
        } else this.db.prepare('INSERT INTO plans (id,workspace_id,catalog_id,fingerprint,plan_json,source_hash,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(plan.id, workspace.id, catalog.id, plan.fingerprint, JSON.stringify(registration), plan.sourceHash, createdAt);
      })();
    } catch (error) { failure(error); }
  }

  getPlan(planId: string): PlanRegistration | null {
    valid(uuid, planId);
    try {
      const row = this.db.prepare('SELECT plan_json FROM plans WHERE id = ?').get(planId) as { plan_json: string } | undefined;
      if (!row) return null;
      const plan = stored(planRegistrationSchema, row.plan_json);
      if (plan.plan.id !== planId) throw new RunStoreError('storage-error');
      return plan;
    } catch (error) { failure(error); }
  }

  admitRun(input: Admission): AdmissionResult {
    const parsed = valid(z.strictObject({ projectId: uuid, planId: uuid, requestId: uuid, requestHash: hash, runId: uuid, createdAt: time }), input);
    try {
      return this.db.transaction(() => {
        const project = this.db.prepare('SELECT active_catalog_id FROM projects WHERE id = ?').get(parsed.projectId) as { active_catalog_id: string | null } | undefined;
        if (!project) throw new RunStoreError('project-not-found');
        const plan = this.db.prepare(`SELECT p.plan_json, p.catalog_id, p.workspace_id, w.project_id
          FROM plans p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?`).get(parsed.planId) as
          { plan_json: string; catalog_id: string; workspace_id: string; project_id: string } | undefined;
        if (!plan || plan.project_id !== parsed.projectId) throw new RunStoreError('plan-stale');
        const previous = this.db.prepare('SELECT request_hash, run_id FROM requests WHERE workspace_id = ? AND request_id = ?')
          .get(plan.workspace_id, parsed.requestId) as { request_hash: string; run_id: string } | undefined;
        if (previous) {
          if (previous.request_hash !== parsed.requestHash) throw new RunStoreError('request-conflict');
          return { runId: previous.run_id, reused: true };
        }
        if (project.active_catalog_id !== plan.catalog_id) throw new RunStoreError('plan-stale');
        const busy = this.db.prepare("SELECT 1 FROM runs WHERE workspace_id = ? AND state IN ('queued','running') LIMIT 1").get(plan.workspace_id);
        if (busy) throw new RunStoreError('workspace-busy');
        const registration = stored(planRegistrationSchema, plan.plan_json);
        const base: RunResult = {
          schemaVersion: 1, runId: parsed.runId, projectId: parsed.projectId, profile: registration.plan.profile,
          origin: 'live', state: 'queued', verdict: null, planHash: registration.plan.fingerprint,
          sourceBefore: registration.plan.sourceHash, sourceAfter: null, workerExitCode: null,
          environmentVerified: null, evidenceVerified: null, cleanupVerified: null, finalized: false,
          plannedChecks: [...registration.plan.plannedChecks], requiredChecks: [...registration.plan.requiredChecks],
          cases: [], reasons: [],
        };
        base.reasons = assessResult(base).reasons;
        valid(runResultSchema, base);
        this.db.prepare(`INSERT INTO runs (id,workspace_id,plan_id,origin,state,verdict,phase,worker_exit_code,started_at,summary_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(parsed.runId, plan.workspace_id, parsed.planId, 'live', 'queued', null, 'queued', null, parsed.createdAt, JSON.stringify(base));
        this.db.prepare('INSERT INTO requests (workspace_id,request_id,request_hash,run_id) VALUES (?,?,?,?)')
          .run(plan.workspace_id, parsed.requestId, parsed.requestHash, parsed.runId);
        return { runId: parsed.runId, reused: false };
      })();
    } catch (error) { failure(error); }
  }

  markRunning(runId: string): RunResult {
    valid(uuid, runId);
    try {
      return this.db.transaction(() => {
        const current = this.getRun(runId);
        if (!current) throw new RunStoreError('run-not-found');
        if (current.state !== 'queued') throw new RunStoreError('invalid-state');
        const result: RunResult = { ...current, state: 'running', reasons: ['run-not-finished'] };
        this.db.prepare("UPDATE runs SET state = 'running', phase = 'running', summary_json = ? WHERE id = ? AND state = 'queued'")
          .run(JSON.stringify(result), runId);
        return result;
      })();
    } catch (error) { failure(error); }
  }

  finalizeRun(result: RunResult): RunResult {
    const final = valid(runResultSchema, result);
    if (!final.finalized || !['finished', 'blocked', 'cancelled', 'unverifiable'].includes(final.state)
      || !isDeepStrictEqual(assessResult(final), { verdict: final.verdict, reasons: final.reasons })) {
      throw new RunStoreError('invalid-input');
    }
    try {
      return this.db.transaction(() => {
        const row = this.db.prepare('SELECT plan_id, summary_json FROM runs WHERE id = ?').get(final.runId) as
          { plan_id: string; summary_json: string } | undefined;
        if (!row) throw new RunStoreError('run-not-found');
        const current = stored(runResultSchema, row.summary_json);
        if (current.finalized) {
          if (isDeepStrictEqual(current, final)) return current;
          throw new RunStoreError('invalid-state');
        }
        if (final.state === 'finished' && current.state !== 'running') throw new RunStoreError('invalid-state');
        if (!['queued', 'running'].includes(current.state)) throw new RunStoreError('invalid-state');
        const plan = this.getPlan(row.plan_id);
        if (!plan || !isDeepStrictEqual(
          [final.runId, final.projectId, final.profile, final.origin, final.planHash, final.sourceBefore, final.plannedChecks, final.requiredChecks],
          [current.runId, plan.project.id, plan.plan.profile, 'live', plan.plan.fingerprint, plan.plan.sourceHash, plan.plan.plannedChecks, plan.plan.requiredChecks],
        )) throw new RunStoreError('invalid-input');
        this.db.prepare(`UPDATE runs SET state = ?, verdict = ?, phase = ?, worker_exit_code = ?, finished_at = ?, finalized_at = ?, summary_json = ? WHERE id = ?`)
          .run(final.state, final.verdict, final.state, final.workerExitCode, new Date().toISOString(), new Date().toISOString(), JSON.stringify(final), final.runId);
        const insertCase = this.db.prepare(`INSERT INTO case_results
          (run_id,test_id,attempt,requirement_id,status,severity,expected_json,observed_json,location_json)
          VALUES (?,?,1,?,?,?,?,?,?)`);
        for (const item of final.cases) insertCase.run(final.runId, item.testId, item.requirementId, item.status, item.severity,
          item.expected === null ? null : JSON.stringify(item.expected), item.observed === null ? null : JSON.stringify(item.observed),
          item.location === null ? null : JSON.stringify(item.location));
        return final;
      })();
    } catch (error) { failure(error); }
  }

  getRun(runId: string): RunResult | null {
    valid(uuid, runId);
    try {
      const row = this.db.prepare('SELECT summary_json FROM runs WHERE id = ?').get(runId) as { summary_json: string } | undefined;
      if (!row) return null;
      const result = stored(runResultSchema, row.summary_json);
      if (result.runId !== runId) throw new RunStoreError('storage-error');
      return result;
    } catch (error) { failure(error); }
  }

  listRuns(projectId: string, limit = 50, cursor?: string): RunPage {
    valid(uuid, projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RunStoreError('invalid-input');
    let position: { projectId: string; startedAt: string; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!position || position.projectId !== projectId || !time.safeParse(position.startedAt).success || !uuid.safeParse(position.id).success)
          throw new Error('cursor');
      } catch { throw new RunStoreError('invalid-input'); }
    }
    try {
      const rows = this.db.prepare(`SELECT r.id, r.started_at, r.summary_json FROM runs r
        JOIN workspaces w ON w.id = r.workspace_id WHERE w.project_id = ?
        AND (? IS NULL OR r.started_at < ? OR (r.started_at = ? AND r.id < ?))
        ORDER BY r.started_at DESC, r.id DESC LIMIT ?`).all(projectId, position?.startedAt ?? null,
        position?.startedAt ?? null, position?.startedAt ?? null, position?.id ?? null, limit + 1) as
        { id: string; started_at: string; summary_json: string }[];
      const page = rows.slice(0, limit);
      return { runs: page.map((row) => stored(runResultSchema, row.summary_json)),
        nextCursor: rows.length > limit && page.length > 0
          ? Buffer.from(JSON.stringify({ projectId, startedAt: page[page.length - 1]!.started_at, id: page[page.length - 1]!.id })).toString('base64url')
          : null };
    } catch (error) { failure(error); }
  }
}
