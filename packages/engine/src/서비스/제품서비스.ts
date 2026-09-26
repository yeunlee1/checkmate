// 프로젝트 등록과 승인된 실행 및 결과 조회를 모든 입구에 공통으로 제공한다.
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { apiInputs, errorResponse, humanMethods, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import type { RunResult } from '@checkmate/contracts';
import type { ProjectSource } from '@checkmate/contracts/project';
import { projectSourceSchema } from '@checkmate/contracts/project';
import { readProjectSource } from '../프로젝트/원본읽기.js';
import { SQLiteRunStore } from '../저장/실행저장.js';
import { ProjectStore } from '../저장/프로젝트저장.js';
import { EvidenceStore } from '../저장/증거저장.js';
import { RunService } from './실행서비스.js';
import type { RunExecutor } from './실행서비스.js';
import type { ClientRole } from '../연결/로컬통신.js';
import { boundedPage, compactCase, compactRepairCase, failurePriority, resultSummary } from './조회결과.js';
import { requirementEvidence } from './요구사항근거.js';
import { BackupError, createBackup, restoreBackup } from '../저장/백업.js';
import type { DataPaths } from '../연결/개인경로.js';
import { getImportedHistory, importHistory, ImportHistoryError } from '../저장/가져온이력.js';
import { ResourceStore } from '../저장/자원저장.js';
import type { PostgresResources } from '../자원/격리데이터베이스.js';

const mutations = new Set(['register', 'inspect', 'approve', 'start', 'cancel', 'sync', 'activate', 'backup', 'restore', 'import-history', 'acknowledge-cleanup', 'cleanup-resources']);

export class ProductService {
  readonly projects: ProjectStore;
  readonly runs: SQLiteRunStore;
  readonly execution: RunService;
  private readonly pending = new Set<string>();
  private storageFailure = false;
  private maintenance = false;
  private writing = 0;
  private readonly cleaning = new Set<string>();
  readonly resources: ResourceStore;

  constructor(private readonly db: Database.Database, private readonly evidence: EvidenceStore, executor: RunExecutor, private readonly paths?: DataPaths,
    private readonly resourceController?: Pick<PostgresResources, 'cleanup'>) {
    this.projects = new ProjectStore(db);
    this.runs = new SQLiteRunStore(db);
    this.execution = new RunService(this.runs, executor);
    this.resources = new ResourceStore(db);
  }
  get active(): boolean { return this.pending.size > 0 || this.maintenance || this.writing > 0; }

  async handle(request: ApiRequest, role: ClientRole): Promise<ApiResponse> {
    let writing = false;
    try {
      if (role === 'agent' && humanMethods.has(request.method)) throw new ServiceError('human-action-required');
      if (mutations.has(request.method)) {
        if (this.storageFailure) throw new ServiceError('storage-error', '저장 상태를 확인하기 전에는 새 작업을 접수할 수 없습니다.');
        if (this.maintenance) throw new ServiceError('maintenance-busy', '자료 백업 또는 복구가 진행 중입니다.', true);
        this.writing += 1; writing = true;
      }
      const data = await this.dispatch(request);
      return { apiVersion: 1, requestId: request.requestId, ok: true, data };
    } catch (error) { return errorResponse(request.requestId, error instanceof ImportHistoryError
      ? new ServiceError(error.code, error.message) : error instanceof BackupError
      ? new ServiceError(error.code, error.message, false, '백업의 완성 표식과 복구 대상이 새 빈 폴더인지 확인해 주세요.') : error); }
    finally { if (writing) this.writing -= 1; }
  }

  private async dispatch(request: ApiRequest): Promise<unknown> {
    const raw = request.input;
    switch (request.method) {
      case 'capabilities':
        apiInputs.capabilities.parse(raw);
        return { version: '0.1.0-alpha.1', apiVersion: 1, node: process.versions.node, storageHealthy: !this.storageFailure,
          connection: this.paths ? { dataRoot: this.paths.root } : null,
          capabilities: ['projects', 'plans', 'approval', 'project-runs', 'evidence', 'requirements', 'history', 'mcp', 'backup', 'restore', 'isolated-postgres', 'resource-recovery', 'public-images'],
          limitations: ['등록된 Node 명령과 선택한 검사 범위만 실행합니다.', '같은 OS 사용자 권한의 악성 코드를 격리하는 샌드박스가 아닙니다.'],
          defaults: { summaryBytes: 8192, evidenceBytes: 32768, maxFailures: 5 } };
      case 'projects': {
        const input = apiInputs.projects.parse(raw);
        return boundedPage(this.projects.list(), 'projects', input.cursor, input.limit);
      }
      case 'register': {
        const input = apiInputs.register.parse(raw);
        return this.projects.register(await readProjectSource(input.path));
      }
      case 'checks': {
        const input = apiInputs.checks.parse(raw);
        const project = this.projects.get(input.projectId);
        const row = this.db.prepare('SELECT source_json FROM catalogs WHERE project_id = ? AND content_hash = ?').get(input.projectId, project.activeCatalogHash) as { source_json: string };
        const source = projectSourceSchema.parse(JSON.parse(row.source_json));
        return boundedPage(source.checks, `checks:${input.projectId}:${project.activeCatalogHash}`, input.cursor, input.limit);
      }
      case 'inspect': {
        const input = apiInputs.inspect.parse(raw);
        const project = this.projects.get(input.projectId);
        return this.projects.inspect(await readProjectSource(project.realPath), input.profile);
      }
      case 'approve': {
        const input = apiInputs.approve.parse(raw);
        const plan = this.runs.getPlan(input.planId);
        if (!plan) throw new ServiceError('plan-stale');
        const current = await readProjectSource(plan.workspace.realPath);
        if (current.sourceHash !== plan.plan.sourceHash || current.contentHash !== plan.catalog.contentHash) throw new ServiceError('plan-stale', '계획 이후 원본이 바뀌었습니다. 다시 계획을 확인해 주세요.');
        return this.projects.approve(input.planId, input.fingerprint);
      }
      case 'start': {
        const input = apiInputs.start.parse(raw);
        const plan = this.runs.getPlan(input.planId);
        if (!plan || plan.project.id !== input.projectId) throw new ServiceError('plan-stale');
        const previous = this.db.prepare('SELECT run_id FROM requests WHERE workspace_id = ? AND request_id = ?').get(plan.workspace.id, request.requestId);
        if (previous) return this.execution.start({ ...input, requestId: request.requestId });
        if (!this.projects.hasApproval(input.planId)) throw new ServiceError('needs-approval', '이 계획의 명령과 쓰기 범위에 대한 확인이 필요합니다.', false, '사람용 계획 화면 또는 CLI approve에서 정확한 지문을 확인해 주세요.');
        const current = await readProjectSource(plan.workspace.realPath);
        if (current.sourceHash !== plan.plan.sourceHash || current.contentHash !== plan.catalog.contentHash) throw new ServiceError('plan-stale');
        if (this.cleaning.has(plan.workspace.id)) throw new ServiceError('workspace-busy', '이전 실행의 자원을 정리하고 있습니다.');
        if (this.db.prepare(`SELECT 1 FROM resources owned JOIN runs r ON r.id=owned.run_id
          WHERE r.workspace_id=? AND owned.state!='cleaned' LIMIT 1`).get(plan.workspace.id))
          throw new ServiceError('ownership-unknown', '이전 실행의 시험 DB 정리가 확인되지 않았습니다.');
        const unresolved = this.db.prepare(`SELECT r.id AS runId FROM runs r WHERE r.workspace_id=? AND r.origin='live' AND r.state IN ('unverifiable','cancelled')
          AND json_extract(r.summary_json,'$.cleanupVerified') IS NOT 1
          AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_id=r.id AND a.action='cleanup-acknowledged' AND a.actor_kind='human') LIMIT 1`).get(plan.workspace.id) as { runId: string } | undefined;
        if (unresolved) throw new ServiceError('ownership-unknown', `이전 실행 ${unresolved.runId}의 프로세스 종료와 정리가 확인되지 않았습니다.`, false,
          `이전 실행 ${unresolved.runId}의 작업자·자손 프로세스 종료와 자원 부재를 사람이 직접 확인하세요. resources=cleaned/verified만으로 프로세스 종료가 확인되지는 않습니다. 확인한 경우에만 같은 자료 폴더의 사람용 CLI에서 acknowledge-cleanup ${unresolved.runId} --confirm --note "실제 확인 근거"를 실행하세요. 기존 판정은 보존됩니다. AI는 사람 확인을 대행하지 마세요.`);
        const accepted = this.execution.start({ ...input, requestId: request.requestId });
        this.pending.add(accepted.runId);
        void this.execution.wait(accepted.runId).then((result) => this.recordGaps(result), () => { this.storageFailure = true; })
          .catch(() => { this.storageFailure = true; }).finally(() => this.pending.delete(accepted.runId));
        return accepted;
      }
      case 'status': {
        const input = apiInputs.status.parse(raw);
        return resultSummary(this.requireRun(input.runId));
      }
      case 'progress': {
        const input = apiInputs.progress.parse(raw);
        return this.execution.progress(input.runId);
      }
      case 'result': {
        const input = apiInputs.result.parse(raw);
        const result = this.requireRun(input.runId);
        const integrity = await this.integrity(result);
        if (input.section === 'summary') return resultSummary(result, integrity);
        if (input.section === 'imported') {
          const imported = getImportedHistory(this.db, result.runId);
          if (!imported) throw new ServiceError('not-imported', '가져온 보고서가 아닙니다.');
          return { origin: 'imported', reportedStatus: imported.reportedStatus, effectiveVerdict: 'unknown', reusablePassed: false,
            mode: imported.mode, environment: imported.environment, source: imported.source, originalSha256: imported.originalSha256,
            summary: imported.summary, declaredOmissions: imported.omissions.declaredCount,
            ...boundedPage(imported.steps, `imported:${input.runId}`, input.cursor, input.limit ?? 10, 4000) };
        }
        if (input.section === 'cases') return boundedPage(result.cases.map(compactCase), `cases:${input.runId}`, input.cursor, input.limit);
        const registration = this.db.prepare('SELECT p.id FROM plans p JOIN runs r ON r.plan_id=p.id WHERE r.id=?').get(input.runId) as { id: string };
        const plan = this.runs.getPlan(registration.id)!;
        const source = projectSourceSchema.parse(plan.catalog.source);
        if (input.section === 'requirements') return boundedPage(requirementEvidence(source, result, integrity), `requirements:${input.runId}`, input.cursor, input.limit);
        if (input.section === 'gaps') return boundedPage(this.runGaps(result, source, integrity), `gaps:${input.runId}`, input.cursor, input.limit);
        const byId = new Map(source.checks.map(check => [check.id, check]));
        const failures = result.plannedChecks.flatMap(id => {
          const definition = byId.get(id)!;
          const item = result.cases.find(candidate => candidate.testId === id);
          if (item?.status === 'passed' && integrity === 'verified') return [];
          return [{ ...compactRepairCase(item ?? { testId: id, status: 'not-run', requirementId: definition.requirementId,
            expected: definition.expected, observed: null, evidenceIds: [], severity: 'warning', location: null }),
            codePaths: definition.codePaths, integrity, missingObservation: !item,
            instruction: '기대값과 실제 관측 및 필요한 증거를 확인하고 테스트를 약화하지 않은 채 수정해 주세요.' }];
        }).sort((left, right) => failurePriority(left) - failurePriority(right));
        const compactFailures = failures.map(item => {
          const compact = compactCase(item);
          return { ...item, ...compact, truncated: item.truncated || compact.truncated };
        });
        const page = boundedPage(compactFailures, `repair:${input.runId}`, input.cursor, input.limit ?? 5, 4500);
        const data = { runId: result.runId, planHash: result.planHash, sourceBefore: result.sourceBefore, sourceAfter: result.sourceAfter,
          integrity, reasons: result.reasons, guidance: { untrustedEvidence: true, automaticRetry: 0, suggestedRepairAttempts: 2, suggestedBudgetMinutes: 15,
            nextAction: '코드와 검사를 보완한 뒤 원본 변경을 다시 확인하고 새 계획으로 실행해 주세요. 기준 약화는 사람의 확인이 필요합니다.' }, ...page };
        for (let index = 0; index < page.items.length; index += 1) {
          const compact = page.items[index]!;
          page.items[index] = failures.find(item => item.testId === compact.testId)!;
          const response = { apiVersion: 1, requestId: request.requestId, ok: true, data };
          const bytes = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(response) }], isError: false }), 'utf8');
          if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 4500 || bytes > 7800) page.items[index] = compact;
        }
        return data;
      }
      case 'evidence': {
        const input = apiInputs.evidence.parse(raw);
        this.requireRun(input.runId);
        return input.content ? this.evidence.readText(input.runId, input.evidenceId, { ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.limit === undefined ? {} : { limit: input.limit }) })
          : this.evidence.inspect(input.runId, input.evidenceId);
      }
      case 'evidence-image': {
        const input = apiInputs['evidence-image'].parse(raw);
        this.requireRun(input.runId);
        return this.evidence.readImage(input.runId, input.evidenceId, input.cursor ? { cursor: input.cursor } : {});
      }
      case 'cancel': {
        const input = apiInputs.cancel.parse(raw);
        const result = await this.execution.cancel(input.runId);
        return resultSummary(result);
      }
      case 'acknowledge-cleanup': {
        const input = apiInputs['acknowledge-cleanup'].parse(raw);
        return this.db.transaction(() => {
          const row = this.db.prepare('SELECT workspace_id,summary_json FROM runs WHERE id=?').get(input.runId) as
            { workspace_id: string; summary_json: string } | undefined;
          if (!row) throw new ServiceError('run-not-found');
          const run = this.requireRun(input.runId);
          if (run.origin !== 'live' || !run.finalized || !['blocked', 'unverifiable', 'cancelled'].includes(run.state)
            || run.cleanupVerified === true) throw new ServiceError('invalid-state', '수동 정리 확인 대상 실행이 아닙니다.');
          const busy = this.db.prepare("SELECT 1 FROM runs WHERE workspace_id=? AND state IN ('queued','running') LIMIT 1")
            .get(row.workspace_id);
          if (busy) throw new ServiceError('workspace-busy', '같은 작업 폴더의 실행이 끝난 뒤 확인해 주세요.');
          if (this.cleaning.has(row.workspace_id) || this.resources.list(run.runId).some(resource => resource.state !== 'cleaned'))
            throw new ServiceError('ownership-unknown', '기록된 시험 DB의 정리를 먼저 확인해 주세요.');
          const prior = this.db.prepare("SELECT id FROM audit_events WHERE entity_id=? AND action='cleanup-acknowledged' AND actor_kind='human' LIMIT 1")
            .get(run.runId);
          if (prior) return { runId: run.runId, acknowledged: true, reused: true, originalVerdict: run.verdict };
          this.db.prepare(`INSERT INTO audit_events
            (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json)
            VALUES (?,'cleanup-acknowledged','human',?,NULL,?,NULL,?,?)`)
            .run(randomUUID(), run.runId, createHash('sha256').update(row.summary_json).digest('hex'),
              new Date().toISOString(), JSON.stringify({ note: input.note, manualConfirmation: true }));
          return { runId: run.runId, acknowledged: true, reused: false, originalVerdict: run.verdict };
        })();
      }
      case 'resources': {
        const input = apiInputs.resources.parse(raw);
        this.requireRun(input.runId);
        return boundedPage(this.resources.list(input.runId), `resources:${input.runId}`, input.cursor, input.limit);
      }
      case 'cleanup-resources': {
        const input = apiInputs['cleanup-resources'].parse(raw);
        const run = this.requireRun(input.runId);
        if (run.origin !== 'live' || !run.finalized || !['blocked', 'unverifiable', 'cancelled'].includes(run.state)
          || run.cleanupVerified === true) throw new ServiceError('invalid-state', '중단된 실행의 자원만 수동 정리할 수 있습니다.');
        const row = this.db.prepare('SELECT workspace_id FROM runs WHERE id=?').get(run.runId) as { workspace_id: string };
        if (this.cleaning.has(row.workspace_id) || this.db.prepare("SELECT 1 FROM runs WHERE workspace_id=? AND state IN ('queued','running') LIMIT 1").get(row.workspace_id))
          throw new ServiceError('workspace-busy', '같은 작업 폴더의 작업이 끝난 뒤 정리해 주세요.');
        if (!this.resourceController) throw new ServiceError('unsupported-operation', '자원 정리 기능이 연결되지 않았습니다.');
        this.cleaning.add(row.workspace_id);
        try {
          const result = await this.resourceController.cleanup(run.runId);
          this.db.prepare(`INSERT INTO audit_events
            (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json)
            VALUES (?,'resources-cleanup','human',?,NULL,NULL,NULL,?,?)`)
            .run(randomUUID(), run.runId, new Date().toISOString(), JSON.stringify({ verified: result.verified, resourceIds: result.resources.map(resource => resource.id) }));
          return { runId: run.runId, verified: result.verified, originalVerdict: run.verdict,
            resources: result.resources, nextAction: '명령 프로세스의 종료도 확인한 뒤 수동 정리 확인을 남겨 주세요. 과거 판정은 유지됩니다.' };
        } finally { this.cleaning.delete(row.workspace_id); }
      }
      case 'history': {
        const input = apiInputs.history.parse(raw);
        this.projects.get(input.projectId);
        const page = this.runs.listRuns(input.projectId, Math.min(input.limit ?? 10, 10), input.cursor);
        return { items: page.runs.map((run) => ({ runId: run.runId, profile: run.profile, origin: run.origin, state: run.state, verdict: run.verdict, finalized: run.finalized })), nextCursor: page.nextCursor };
      }
      case 'import-history': {
        const input = apiInputs['import-history'].parse(raw);
        const saved = await importHistory(this.db, input.projectId, input.path);
        return { runId: saved.runId, reused: saved.reused, origin: 'imported', effectiveVerdict: 'unknown', reportedStatus: saved.report.reportedStatus,
          originalSha256: saved.report.originalSha256, summary: saved.report.summary, reusablePassed: false };
      }
      case 'gaps': {
        const input = apiInputs.gaps.parse(raw);
        this.projects.get(input.projectId);
        const rows = this.db.prepare('SELECT id,requirement_id AS requirementId,opened_run_id AS openedRunId,resolved_run_id AS resolvedRunId,kind,state,detail_json FROM gaps WHERE project_id=? ORDER BY id').all(input.projectId) as { id: string; requirementId: string | null; openedRunId: string; resolvedRunId: string | null; kind: string; state: string; detail_json: string }[];
        return boundedPage(rows.map(({ detail_json, ...rest }) => ({ ...rest, detail: JSON.parse(detail_json) as unknown })), `project-gaps:${input.projectId}`, input.cursor, input.limit);
      }
      case 'sync': {
        const input = apiInputs.sync.parse(raw);
        return this.projects.sync(await readProjectSource(this.projects.get(input.projectId).realPath));
      }
      case 'activate': {
        const input = apiInputs.activate.parse(raw);
        const source = await readProjectSource(this.projects.get(input.projectId).realPath);
        if (source.contentHash !== input.contentHash) throw new ServiceError('catalog-stale');
        return this.projects.sync(source, true);
      }
      case 'backup': {
        apiInputs.backup.parse(raw);
        if (!this.paths) throw new ServiceError('unavailable');
        if (this.pending.size > 0 || this.writing !== 1) throw new ServiceError('maintenance-busy', '실행과 저장 작업이 끝난 뒤 백업할 수 있습니다.', true);
        this.maintenance = true;
        try {
          const saved = await createBackup(this.db, this.paths, join(this.paths.root, 'backups'));
          return { backupDirectory: saved.backupDirectory, manifestHash: saved.manifestHash, fileCount: saved.manifest.files.length,
            createdAt: saved.manifest.createdAt, includesConnectionSecret: false };
        } finally { this.maintenance = false; }
      }
      case 'restore': {
        const input = apiInputs.restore.parse(raw);
        if (this.pending.size > 0 || this.writing !== 1) throw new ServiceError('maintenance-busy', '실행과 저장 작업이 끝난 뒤 복구할 수 있습니다.', true);
        this.maintenance = true;
        try {
          const restored = await restoreBackup(input.backupDirectory, input.targetRoot);
          return { dataRoot: restored.root, switched: false, nextAction: '현재 자료는 유지됩니다. 복구한 자료는 CLI --data-dir로 연결해 확인해 주세요.' };
        } finally { this.maintenance = false; }
      }
    }
  }

  private requireRun(runId: string): RunResult {
    const run = this.runs.getRun(runId);
    if (!run) throw new ServiceError('run-not-found');
    return run;
  }
  private async integrity(run: RunResult): Promise<'verified' | 'degraded' | 'pending'> {
    if (!run.finalized) return 'pending';
    if (!run.evidenceVerified) return 'degraded';
    for (const id of new Set(run.cases.flatMap((item) => item.evidenceIds))) {
      try { if ((await this.evidence.inspect(run.runId, id)).integrity !== 'verified') return 'degraded'; }
      catch { return 'degraded'; }
    }
    return 'verified';
  }
  private runGaps(run: RunResult, source: ProjectSource, integrity: 'verified' | 'degraded' | 'pending') {
    if (run.origin !== 'live' || !run.finalized) return [];
    const checks = new Map(source.checks.map(check => [check.id, check]));
    const gaps: { testId: string | null; requirementId: string | null; kind: string; status: string }[] = [];
    for (const requirement of source.requirements) {
      if (!source.checks.some(check => check.requirementId === requirement.id))
        gaps.push({ testId: null, requirementId: requirement.id, kind: 'missing-test', status: 'not-run' });
    }
    for (const id of run.plannedChecks) {
      const item = run.cases.find(candidate => candidate.testId === id);
      if (item?.status === 'failed') continue;
      const kind = !item || item.status === 'not-run' || item.status === 'skipped' ? 'missing-test'
        : item.status === 'unknown' ? 'missing-evidence'
        : item.status !== 'passed' ? 'environment-blocked'
        : run.evidenceVerified !== true || integrity !== 'verified' ? 'missing-evidence'
        : run.state !== 'finished' || run.workerExitCode !== 0
          || run.sourceBefore === null || run.sourceBefore !== run.sourceAfter
          || run.environmentVerified !== true || run.cleanupVerified !== true ? 'environment-blocked' : null;
      if (kind) gaps.push({ testId: id, requirementId: checks.get(id)?.requirementId ?? item?.requirementId ?? null,
        kind, status: item?.status ?? 'not-run' });
    }
    return gaps;
  }
  private async recordGaps(run: RunResult): Promise<void> {
    if (run.origin !== 'live' || !run.finalized) return;
    const row = this.db.prepare('SELECT plan_id FROM runs WHERE id=?').get(run.runId) as { plan_id: string } | undefined;
    const plan = row && this.runs.getPlan(row.plan_id);
    if (!plan) throw new ServiceError('plan-stale');
    const source = projectSourceSchema.parse(plan.catalog.source);
    const integrity = await this.integrity(run);
    const gaps = this.runGaps(run, source, integrity);
    const trusted = run.state === 'finished' && run.workerExitCode === 0 && run.sourceBefore !== null
      && run.sourceBefore === run.sourceAfter && run.environmentVerified === true
      && run.evidenceVerified === true && run.cleanupVerified === true && integrity === 'verified';
    this.db.transaction(() => {
      const open = this.db.prepare("SELECT id,requirement_id,kind,detail_json FROM gaps WHERE project_id=? AND state='open'")
        .all(run.projectId) as { id: string; requirement_id: string | null; kind: string; detail_json: string }[];
      for (const gap of gaps) {
        if (open.some(row => row.requirement_id === gap.requirementId && row.kind === gap.kind
          && (JSON.parse(row.detail_json) as { testId?: string | null }).testId === gap.testId)) continue;
        this.db.prepare('INSERT INTO gaps (id,project_id,requirement_id,opened_run_id,resolved_run_id,kind,state,detail_json) VALUES (?,?,?,?,NULL,?,?,?)')
          .run(randomUUID(), run.projectId, gap.requirementId, run.runId, gap.kind, 'open', JSON.stringify(gap));
      }
      if (trusted) for (const gap of open) {
        const { testId } = JSON.parse(gap.detail_json) as { testId?: string | null };
        const related = testId ? source.checks.filter(check => check.id === testId && check.requirementId === gap.requirement_id)
          : source.checks.filter(check => check.requirementId === gap.requirement_id && check.required);
        if (related.length === 0 || !related.every(check => run.plannedChecks.includes(check.id)
          && run.cases.some(item => item.testId === check.id && item.status === 'passed'))) continue;
        this.db.prepare("UPDATE gaps SET state='resolved',resolved_run_id=? WHERE id=? AND state='open'").run(run.runId, gap.id);
      }
      this.db.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json) VALUES (?,?,?,?,NULL,?,NULL,?,?)')
        .run(randomUUID(), 'run-finalized', 'service', run.runId, createHash('sha256').update(JSON.stringify(run)).digest('hex'), new Date().toISOString(), JSON.stringify({ state: run.state, verdict: run.verdict }));
    })();
  }
}
