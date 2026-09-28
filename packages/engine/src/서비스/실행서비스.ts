// 신뢰된 실행기를 접수된 실행에만 최대 두 개 연결하고 결과를 확정한다.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assessResult, resultInputSchema, runResultSchema } from '@checkmate/contracts';
import type { RunResult } from '@checkmate/contracts';
import { projectSourceSchema } from '@checkmate/contracts/project';
import { RunStoreError } from '@checkmate/contracts/runs';
import type { AdmissionResult, PlanRegistration, RunProgress, RunStore } from '@checkmate/contracts/runs';

export type ProgressUpdate = Pick<RunProgress, 'phase' | 'currentCommand' | 'completedCommands' | 'totalCommands' | 'available'>;
export type RunExecutor = (plan: PlanRegistration, initialResult: RunResult, signal: AbortSignal,
  onProgress?: (progress: ProgressUpdate) => void) => Promise<RunResult>;

type LocalRun = {
  controller: AbortController;
  promise: Promise<RunResult>;
  resolve: (result: RunResult) => void;
  reject: (error: unknown) => void;
  started: boolean;
  cancelled: boolean;
  progress: ProgressUpdate & { updatedAt: string | null };
};

export class RunService {
  private active = 0;
  private readonly queue: { runId: string; planId: string; local: LocalRun }[] = [];
  private readonly local = new Map<string, LocalRun>();

  constructor(private readonly store: RunStore, private readonly executor: RunExecutor) {}

  start(input: { projectId: string; planId: string; requestId: string }): AdmissionResult {
    const parsed = z.strictObject({ projectId: z.uuid(), planId: z.uuid(), requestId: z.uuid() }).safeParse(input);
    if (!parsed.success) throw new RunStoreError('invalid-input');
    const { projectId, planId, requestId } = parsed.data;
    const requestHash = createHash('sha256').update(JSON.stringify([projectId, planId, requestId])).digest('hex');
    const admitted = this.store.admitRun({ projectId, planId, requestId, requestHash, runId: randomUUID(), createdAt: new Date().toISOString() });
    if (!admitted.reused && !this.local.has(admitted.runId)) {
      let resolve!: (result: RunResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<RunResult>((onSuccess, onFailure) => { resolve = onSuccess; reject = onFailure; });
      const local: LocalRun = { controller: new AbortController(), started: false, cancelled: false, promise, resolve, reject,
        progress: { phase: 'queued', available: true, currentCommand: null, completedCommands: 0,
          totalCommands: 0, updatedAt: new Date().toISOString() } };
      this.local.set(admitted.runId, local);
      void promise.then(() => this.local.delete(admitted.runId), () => this.local.delete(admitted.runId));
      this.queue.push({ runId: admitted.runId, planId, local });
      this.drain();
    }
    return admitted;
  }

  private drain(): void {
    while (this.active < 2 && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.local.cancelled) continue;
      this.active += 1;
      void Promise.resolve().then(() => this.execute(next.runId, next.planId, next.local)).then(
        (result) => { this.active -= 1; next.local.resolve(result); this.drain(); },
        (error: unknown) => { this.active -= 1; next.local.reject(error); this.drain(); },
      );
    }
  }

  async wait(runId: string): Promise<RunResult> {
    if (!z.uuid().safeParse(runId).success) throw new RunStoreError('invalid-input');
    const local = this.local.get(runId);
    if (local) return local.promise;
    const result = this.store.getRun(runId);
    if (!result) throw new RunStoreError('run-not-found');
    if (!result.finalized) throw new RunStoreError('invalid-state');
    return result;
  }

  progress(runId: string): RunProgress {
    if (!z.uuid().safeParse(runId).success) throw new RunStoreError('invalid-input');
    const result = this.store.getRun(runId);
    if (!result) throw new RunStoreError('run-not-found');
    const local = this.local.get(runId);
    const progress = local && !result.finalized ? local.progress : null;
    return { runId, state: result.state, finalized: result.finalized,
      available: progress?.available ?? false,
      phase: progress?.phase ?? (result.finalized ? 'finished' : 'unavailable'),
      currentCommand: progress?.currentCommand ?? null,
      completedCommands: progress?.completedCommands ?? 0,
      totalCommands: progress?.totalCommands ?? 0,
      updatedAt: progress?.updatedAt ?? null };
  }

  async cancel(runId: string): Promise<RunResult> {
    if (!z.uuid().safeParse(runId).success) throw new RunStoreError('invalid-input');
    const local = this.local.get(runId);
    if (!local) {
      const result = this.store.getRun(runId);
      if (!result) throw new RunStoreError('run-not-found');
      if (result.finalized) return result;
      throw new RunStoreError('invalid-state');
    }
    if (!local.started) {
      const current = this.store.getRun(runId);
      if (!current) throw new RunStoreError('run-not-found');
      if (current.finalized) return current;
      if (current.state !== 'queued') throw new RunStoreError('invalid-state');
      const result = this.store.finalizeRun(this.finish(current, 'cancelled'));
      local.cancelled = true;
      local.controller.abort();
      local.resolve(result);
      this.local.delete(runId);
      return result;
    }
    local.cancelled = true;
    local.progress = { ...local.progress, available: false, phase: 'unavailable', currentCommand: null,
      updatedAt: new Date().toISOString() };
    local.controller.abort();
    return local.promise;
  }

  private async execute(runId: string, planId: string, local: LocalRun): Promise<RunResult> {
    local.started = true;
    const initial = this.store.getRun(runId);
    if (!initial) throw new RunStoreError('run-not-found');
    if (initial.finalized) return initial;
    if (initial.state !== 'queued') throw new RunStoreError('invalid-state');
    if (local.cancelled) return this.store.finalizeRun(this.finish(initial, 'cancelled'));
    const plan = this.store.getPlan(planId);
    if (!plan || plan.plan.id !== planId || plan.project.id !== initial.projectId) throw new RunStoreError('plan-stale');
    const source = projectSourceSchema.safeParse(plan.catalog.source);
    const selectedIds = new Set(source.success ? source.data.checks
      .filter((check) => plan.plan.plannedChecks.includes(check.id)).map((check) => check.commandId) : []);
    const titles = new Map(source.success ? source.data.project.commands
      .filter((command) => selectedIds.has(command.id)).map((command) => [command.id, command.title] as const) : []);
    const running = this.store.markRunning(runId);
    local.progress = { ...local.progress, available: false, phase: 'unavailable', updatedAt: new Date().toISOString() };
    let candidate: RunResult | undefined;
    try {
      candidate = await this.executor(structuredClone(plan), structuredClone(running), local.controller.signal, (progress) => {
        if (local.cancelled || !['preparing', 'running', 'verifying', 'cleaning', 'unavailable'].includes(progress.phase)
          || !Number.isSafeInteger(progress.completedCommands) || !Number.isSafeInteger(progress.totalCommands)
          || progress.completedCommands < 0 || progress.totalCommands < progress.completedCommands
          || progress.totalCommands !== titles.size
          || typeof progress.available !== 'boolean'
          || (progress.currentCommand !== null && (typeof progress.currentCommand?.id !== 'string'
            || typeof progress.currentCommand?.title !== 'string' || !titles.has(progress.currentCommand.id)
            || (progress.currentCommand.title !== titles.get(progress.currentCommand.id)
              && progress.currentCommand.title !== '[가림]')))) return;
        local.progress = { phase: progress.phase, available: progress.available,
          currentCommand: progress.currentCommand ? { id: progress.currentCommand.id,
            title: /[\\/]|authorization|cookie|bearer|token|password|secret|api[ _-]?key/iu.test(progress.currentCommand.title)
              ? '[가림]' : progress.currentCommand.title } : null,
          completedCommands: progress.completedCommands, totalCommands: progress.totalCommands,
          updatedAt: new Date().toISOString() };
      });
    } catch {
      // 실행기 오류의 세부 정보는 결과에 복사하지 않는다.
    }
    if (local.cancelled) return this.store.finalizeRun(this.finish(candidate && this.validCandidate(running, candidate) ? candidate : running, 'cancelled'));
    if (!candidate || !this.validCandidate(running, candidate))
      return this.store.finalizeRun(this.finish(running, 'unverifiable'));
    let final: RunResult;
    try { final = this.finish(candidate, candidate.state); }
    catch (error) {
      if (!(error instanceof RunStoreError) || error.code !== 'invalid-input') throw error;
      final = this.finish(running, 'unverifiable');
    }
    return this.store.finalizeRun(final);
  }

  private validCandidate(initial: RunResult, candidate: RunResult): boolean {
    if (!resultInputSchema.safeParse(candidate).success || candidate.finalized ||
      !['finished', 'blocked', 'cancelled', 'unverifiable'].includes(candidate.state)) return false;
    return isDeepStrictEqual(
      [candidate.schemaVersion, candidate.runId, candidate.projectId, candidate.profile, candidate.origin,
        candidate.planHash, candidate.sourceBefore, candidate.plannedChecks, candidate.requiredChecks],
      [initial.schemaVersion, initial.runId, initial.projectId, initial.profile, initial.origin,
        initial.planHash, initial.sourceBefore, initial.plannedChecks, initial.requiredChecks],
    );
  }

  private finish(result: RunResult, state: RunResult['state']): RunResult {
    const final: RunResult = {
      ...result, state, finalized: true, verdict: null, reasons: [],
      ...((state === 'cancelled' || state === 'unverifiable') && ['queued', 'running'].includes(result.state) ? {
        workerExitCode: null, environmentVerified: null, evidenceVerified: null,
        cleanupVerified: state === 'cancelled' && result.state === 'queued' ? true : null,
      } : {}),
    };
    const assessment = assessResult(final);
    final.verdict = assessment.verdict;
    final.reasons = assessment.reasons;
    if (!runResultSchema.safeParse(final).success) throw new RunStoreError('invalid-input');
    return final;
  }
}
