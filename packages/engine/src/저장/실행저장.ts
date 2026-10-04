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
import type { ControlOwner, RunControl, RunMetadata } from '@checkmate/contracts/runs';
import { randomUUID } from 'node:crypto';
import { ServiceError } from '@checkmate/contracts/api';
import type { ProjectStorage } from './프로젝트자료.js';

const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime({ offset: false });
type Row = Record<string, unknown>;

function failure(error: unknown): never {
  if (error instanceof RunStoreError) throw error;
  if (error instanceof ServiceError && error.code === 'plan-stale') throw new RunStoreError('plan-stale');
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) throw new RunStoreError('storage-busy');
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
  constructor(private readonly db: Database.Database, private readonly storage?: ProjectStorage) {}

  registerPlan(input: PlanRegistration): void {
    const parsed = valid(planRegistrationSchema, input);
    const registration = { ...parsed, workspace: { ...parsed.workspace, realPath: absoluteRealPath(parsed.workspace.realPath) } };
    try {
      this.db.transaction(() => {
        const { project, workspace, catalog, plan, createdAt } = registration;
        const oldProject = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as Row | undefined;
        if (oldProject) same(oldProject.repository_identity, project.repositoryIdentity);
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
        this.db.prepare('INSERT INTO workspace_catalog_state (workspace_id,catalog_id) VALUES (?,?) ON CONFLICT(workspace_id) DO NOTHING')
          .run(workspace.id, catalog.id);

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

  admitRun(input: Admission, guard?: () => void): AdmissionResult {
    const parsed = valid(z.strictObject({ projectId: uuid, planId: uuid, requestId: uuid, requestHash: hash, runId: uuid, createdAt: time,
      owner: z.strictObject({ ownerId: uuid, ownerHash: hash, serviceEpoch: uuid }).optional(), lease: z.record(z.string(), z.unknown()).optional() }), input);
    const startedAt = new Date(parsed.createdAt).toISOString();
    let guardRejection: ServiceError | undefined;
    try {
      return this.db.transaction(() => {
        const project = this.db.prepare('SELECT active_catalog_id FROM projects WHERE id = ?').get(parsed.projectId) as { active_catalog_id: string | null } | undefined;
        if (!project) throw new RunStoreError('project-not-found');
        const plan = this.db.prepare(`SELECT p.plan_json, p.catalog_id, p.workspace_id, w.project_id
          FROM plans p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?`).get(parsed.planId) as
          { plan_json: string; catalog_id: string; workspace_id: string; project_id: string } | undefined;
        if (!plan || plan.project_id !== parsed.projectId) throw new RunStoreError('plan-stale');
        const ownedRequest = parsed.owner && this.db.prepare('SELECT request_hash,run_id FROM owner_requests WHERE owner_id=? AND request_id=?')
          .get(parsed.owner.ownerId, parsed.requestId) as { request_hash: string; run_id: string } | undefined;
        if (ownedRequest && ownedRequest.request_hash !== parsed.requestHash) throw new RunStoreError('request-conflict');
        const previous = this.db.prepare('SELECT request_hash, run_id FROM requests WHERE workspace_id = ? AND request_id = ?')
          .get(plan.workspace_id, parsed.requestId) as { request_hash: string; run_id: string } | undefined;
        if (previous) {
          if (parsed.owner) this.assertControl(previous.run_id, parsed.owner);
          if (previous.request_hash !== parsed.requestHash) throw new RunStoreError('request-conflict');
          return { runId: previous.run_id, reused: true };
        }
        const active = this.db.prepare('SELECT catalog_id FROM workspace_catalog_state WHERE workspace_id=?').get(plan.workspace_id) as { catalog_id: string } | undefined;
        if (active?.catalog_id !== plan.catalog_id) throw new RunStoreError('plan-stale');
        const busy = this.db.prepare("SELECT 1 FROM runs WHERE workspace_id = ? AND state IN ('queued','running') LIMIT 1").get(plan.workspace_id);
        if (busy) throw new RunStoreError('workspace-busy');
        const registration = stored(planRegistrationSchema, plan.plan_json);
        same([registration.project.id, registration.workspace.id, registration.catalog.id], [parsed.projectId, plan.workspace_id, plan.catalog_id]);
        try { guard?.(); }
        catch (error) {
          if (error instanceof ServiceError && ['needs-approval', 'agent-control-required'].includes(error.code)) guardRejection = error;
          throw error;
        }
        this.storage?.assertPlan(registration);
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
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(parsed.runId, plan.workspace_id, parsed.planId, 'live', 'queued', null, 'queued', null, startedAt, JSON.stringify(base));
        if (registration.plan.outputStorage) {
          if (!this.storage) throw new RunStoreError('storage-error');
          this.storage.admit(registration, parsed.runId, startedAt);
        }
        this.db.prepare('INSERT INTO requests (workspace_id,request_id,request_hash,run_id) VALUES (?,?,?,?)')
          .run(plan.workspace_id, parsed.requestId, parsed.requestHash, parsed.runId);
        if (parsed.owner) {
          this.db.prepare('INSERT INTO run_control_owners (run_id,owner_id,owner_hash,service_epoch,revision) VALUES (?,?,?,?,1)')
            .run(parsed.runId, parsed.owner.ownerId, parsed.owner.ownerHash, parsed.owner.serviceEpoch);
          this.db.prepare('INSERT INTO owner_requests (owner_id,request_id,request_hash,run_id) VALUES (?,?,?,?)')
            .run(parsed.owner.ownerId, parsed.requestId, parsed.requestHash, parsed.runId);
        }
        if (parsed.lease) this.db.prepare('INSERT INTO execution_locks (run_id,lease_json) VALUES (?,?)').run(parsed.runId, JSON.stringify(parsed.lease));
        return { runId: parsed.runId, reused: false };
      }).immediate();
    } catch (error) {
      if (guardRejection !== undefined && error === guardRejection && !this.db.inTransaction) throw guardRejection;
      failure(error);
    }
  }

  getControl(runId: string): RunControl | null {
    const row = this.db.prepare('SELECT owner_id AS ownerId,owner_hash AS ownerHash,service_epoch AS serviceEpoch,revision FROM run_control_owners WHERE run_id=?').get(runId) as RunControl | undefined;
    return row ?? null;
  }
  assertControl(runId: string, owner: ControlOwner): void {
    const control = this.getControl(runId);
    if (!control || control.ownerId !== owner.ownerId || control.ownerHash !== owner.ownerHash || control.serviceEpoch !== owner.serviceEpoch)
      throw new RunStoreError('run-owner-mismatch');
  }
  metadata(runId: string): RunMetadata {
    const row = this.db.prepare('SELECT workspace_id AS workspaceId,plan_id AS planId FROM runs WHERE id=?').get(runId) as { workspaceId: string; planId: string } | undefined;
    if (!row) throw new RunStoreError('run-not-found');
    const owner = this.getControl(runId);
    return { ...row, ownerId: owner?.ownerId ?? null, ownershipRevision: owner?.revision ?? null };
  }
  handoff(runId: string, expectedOwnerId: string | null, target: ControlOwner, note: string): RunMetadata {
    return this.db.transaction(() => {
      this.metadata(runId);
      const prior = this.getControl(runId);
      if ((prior?.ownerId ?? null) !== expectedOwnerId) throw new RunStoreError('run-owner-mismatch');
      this.db.prepare(`INSERT INTO run_control_owners (run_id,owner_id,owner_hash,service_epoch,revision) VALUES (?,?,?,?,1)
        ON CONFLICT(run_id) DO UPDATE SET owner_id=excluded.owner_id,owner_hash=excluded.owner_hash,service_epoch=excluded.service_epoch,revision=revision+1`)
        .run(runId, target.ownerId, target.ownerHash, target.serviceEpoch);
      this.db.prepare(`INSERT INTO audit_events (id,action,actor_kind,entity_id,recorded_at,detail_json) VALUES (?,'run-control-handed-off','human',?,?,?)`)
        .run(randomUUID(), runId, new Date().toISOString(), JSON.stringify({ expectedOwnerId, ownerId: target.ownerId, note }));
      return this.metadata(runId);
    }).immediate();
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
        this.storage?.saveResult(final);
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

  listRuns(projectId: string, limit = 50, cursor?: string, workspaceId?: string): RunPage {
    valid(uuid, projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RunStoreError('invalid-input');
    let position: { projectId: string; workspaceId?: string; startedAt: string; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!position || position.projectId !== projectId || position.workspaceId !== workspaceId || !time.safeParse(position.startedAt).success || !uuid.safeParse(position.id).success)
          throw new Error('cursor');
      } catch { throw new RunStoreError('invalid-input'); }
    }
    try {
      const rows = this.db.prepare(`SELECT r.id, strftime('%Y-%m-%dT%H:%M:%fZ', r.started_at) AS sort_at, r.summary_json FROM runs r
        JOIN workspaces w ON w.id = r.workspace_id WHERE w.project_id = ? AND (? IS NULL OR w.id=?)
        AND (? IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', r.started_at) < strftime('%Y-%m-%dT%H:%M:%fZ', ?)
          OR (strftime('%Y-%m-%dT%H:%M:%fZ', r.started_at) = strftime('%Y-%m-%dT%H:%M:%fZ', ?) AND r.id < ?))
        ORDER BY sort_at DESC, r.id DESC LIMIT ?`).all(projectId, workspaceId ?? null, workspaceId ?? null, position?.startedAt ?? null,
        position?.startedAt ?? null, position?.startedAt ?? null, position?.id ?? null, limit + 1) as
        { id: string; sort_at: string; summary_json: string }[];
      const page = rows.slice(0, limit);
      return { runs: page.map((row) => stored(runResultSchema, row.summary_json)),
        nextCursor: rows.length > limit && page.length > 0
          ? Buffer.from(JSON.stringify({ projectId, workspaceId, startedAt: page[page.length - 1]!.sort_at, id: page[page.length - 1]!.id })).toString('base64url')
          : null };
    } catch (error) { failure(error); }
  }
}
