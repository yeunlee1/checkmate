// 프로젝트 등록과 승인된 실행 및 결과 조회를 모든 입구에 공통으로 제공한다.
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { apiInputs, errorResponse, humanMethods, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import type { RunResult } from '@checkmate/contracts';
import { projectSourceSchema } from '@checkmate/contracts/project';
import { readProjectSource } from '../프로젝트/원본읽기.js';
import { SQLiteRunStore } from '../저장/실행저장.js';
import { ProjectStore } from '../저장/프로젝트저장.js';
import { EvidenceStore } from '../저장/증거저장.js';
import { RunService } from './실행서비스.js';
import type { RunExecutor } from './실행서비스.js';
import type { ClientRole } from '../연결/로컬통신.js';
import { boundedPage, compactCase, resultSummary } from './조회결과.js';
import { requirementEvidence } from './요구사항근거.js';

export class ProductService {
  readonly projects: ProjectStore;
  readonly runs: SQLiteRunStore;
  readonly execution: RunService;
  private readonly pending = new Set<string>();
  private storageFailure = false;

  constructor(private readonly db: Database.Database, private readonly evidence: EvidenceStore, executor: RunExecutor) {
    this.projects = new ProjectStore(db);
    this.runs = new SQLiteRunStore(db);
    this.execution = new RunService(this.runs, executor);
  }
  get active(): boolean { return this.pending.size > 0; }

  async handle(request: ApiRequest, role: ClientRole): Promise<ApiResponse> {
    try {
      if (role === 'agent' && humanMethods.has(request.method)) throw new ServiceError('human-action-required');
      if (this.storageFailure && ['start', 'register', 'activate', 'approve', 'sync'].includes(request.method)) throw new ServiceError('storage-error', '저장 상태를 확인하기 전에는 새 작업을 접수할 수 없습니다.');
      const data = await this.dispatch(request);
      return { apiVersion: 1, requestId: request.requestId, ok: true, data };
    } catch (error) { return errorResponse(request.requestId, error); }
  }

  private async dispatch(request: ApiRequest): Promise<unknown> {
    const raw = request.input;
    switch (request.method) {
      case 'capabilities':
        apiInputs.capabilities.parse(raw);
        return { version: '0.1.0-alpha.1', apiVersion: 1, node: process.versions.node, storageHealthy: !this.storageFailure,
          capabilities: ['projects', 'plans', 'approval', 'project-runs', 'evidence', 'history', 'mcp'],
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
        const unresolved = this.db.prepare(`SELECT 1 FROM runs r WHERE r.workspace_id=? AND r.state='unverifiable'
          AND json_extract(r.summary_json,'$.cleanupVerified') IS NOT 1 LIMIT 1`).get(plan.workspace.id);
        if (unresolved) throw new ServiceError('ownership-unknown', '이전 실행의 정리가 확인되지 않았습니다.');
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
      case 'result': {
        const input = apiInputs.result.parse(raw);
        const result = this.requireRun(input.runId);
        const integrity = await this.integrity(result);
        if (input.section === 'summary') return resultSummary(result, integrity);
        if (input.section === 'cases') return boundedPage(result.cases.map(compactCase), `cases:${input.runId}`, input.cursor, input.limit);
        const registration = this.db.prepare('SELECT p.id FROM plans p JOIN runs r ON r.plan_id=p.id WHERE r.id=?').get(input.runId) as { id: string };
        const plan = this.runs.getPlan(registration.id)!;
        const source = projectSourceSchema.parse(plan.catalog.source);
        if (input.section === 'requirements') return boundedPage(requirementEvidence(source, result, integrity), `requirements:${input.runId}`, input.cursor, input.limit);
        if (input.section === 'gaps') return boundedPage(this.runGaps(result), `gaps:${input.runId}`, input.cursor, input.limit);
        const byId = new Map(source.checks.map(check => [check.id, check]));
        const failures = result.plannedChecks.flatMap(id => {
          const definition = byId.get(id)!;
          const item = result.cases.find(candidate => candidate.testId === id);
          if (item?.status === 'passed' && integrity === 'verified') return [];
          return [{ ...compactCase(item ?? { testId: id, status: 'not-run', requirementId: definition.requirementId,
            expected: definition.expected, observed: null, evidenceIds: [], severity: 'warning', location: null }),
            codePaths: definition.codePaths, integrity, missingObservation: !item,
            instruction: '기대값과 실제 관측 및 필요한 증거를 확인하고 테스트를 약화하지 않은 채 수정해 주세요.' }];
        });
        return { runId: result.runId, planHash: result.planHash, sourceBefore: result.sourceBefore, sourceAfter: result.sourceAfter,
          integrity, reasons: result.reasons, guidance: { untrustedEvidence: true, automaticRetry: 0, suggestedRepairAttempts: 2, suggestedBudgetMinutes: 15,
            nextAction: '코드와 검사를 보완한 뒤 원본 변경을 다시 확인하고 새 계획으로 실행해 주세요. 기준 약화는 사람의 확인이 필요합니다.' },
          ...boundedPage(failures, `repair:${input.runId}`, input.cursor, input.limit ?? 5, 4500) };
      }
      case 'evidence': {
        const input = apiInputs.evidence.parse(raw);
        this.requireRun(input.runId);
        return input.content ? this.evidence.readText(input.runId, input.evidenceId, { ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.limit === undefined ? {} : { limit: input.limit }) })
          : this.evidence.inspect(input.runId, input.evidenceId);
      }
      case 'cancel': {
        const input = apiInputs.cancel.parse(raw);
        const result = await this.execution.cancel(input.runId);
        return resultSummary(result);
      }
      case 'history': {
        const input = apiInputs.history.parse(raw);
        this.projects.get(input.projectId);
        const page = this.runs.listRuns(input.projectId, Math.min(input.limit ?? 10, 10), input.cursor);
        return { items: page.runs.map((run) => ({ runId: run.runId, profile: run.profile, state: run.state, verdict: run.verdict, finalized: run.finalized })), nextCursor: page.nextCursor };
      }
      case 'gaps': {
        const input = apiInputs.gaps.parse(raw);
        this.projects.get(input.projectId);
        const rows = this.db.prepare('SELECT id,requirement_id AS requirementId,opened_run_id AS openedRunId,kind,state,detail_json FROM gaps WHERE project_id=? ORDER BY id').all(input.projectId) as { id: string; requirementId: string | null; openedRunId: string; kind: string; state: string; detail_json: string }[];
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
  private runGaps(run: RunResult) {
    return run.requiredChecks.flatMap((id) => {
      const item = run.cases.find((candidate) => candidate.testId === id);
      if (item?.status === 'passed') return [];
      return [{ testId: id, requirementId: item?.requirementId ?? null, kind: !item ? 'missing-test' : item.status === 'unknown' ? 'missing-evidence' : 'environment-blocked', status: item?.status ?? 'not-run' }];
    });
  }
  private recordGaps(run: RunResult): void {
    this.db.transaction(() => {
      for (const gap of this.runGaps(run)) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO gaps (id,project_id,requirement_id,opened_run_id,resolved_run_id,kind,state,detail_json) VALUES (?,?,?,?,NULL,?,?,?)')
          .run(id, run.projectId, gap.requirementId, run.runId, gap.kind, 'open', JSON.stringify(gap));
      }
      this.db.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json) VALUES (?,?,?,?,NULL,?,NULL,?,?)')
        .run(randomUUID(), 'run-finalized', 'service', run.runId, createHash('sha256').update(JSON.stringify(run)).digest('hex'), new Date().toISOString(), JSON.stringify({ state: run.state, verdict: run.verdict }));
    })();
  }
}
