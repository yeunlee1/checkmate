// 신뢰된 실행기를 접수된 실행에만 직렬로 연결하고 결과를 확정한다.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assessResult, resultInputSchema, runResultSchema } from '@checkmate/contracts';
import type { RunResult } from '@checkmate/contracts';
import { RunStoreError } from '@checkmate/contracts/runs';
import type { AdmissionResult, PlanRegistration, RunStore } from '@checkmate/contracts/runs';

export type RunExecutor = (plan: PlanRegistration, initialResult: RunResult, signal: AbortSignal) => Promise<RunResult>;

type LocalRun = {
  controller: AbortController;
  promise: Promise<RunResult>;
  resolve: (result: RunResult) => void;
  reject: (error: unknown) => void;
  started: boolean;
  cancelled: boolean;
};

export class RunService {
  private tail: Promise<unknown> = Promise.resolve();
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
      const local: LocalRun = { controller: new AbortController(), started: false, cancelled: false, promise, resolve, reject };
      const job = this.tail.then(() => local.cancelled ? undefined : this.execute(admitted.runId, planId, local));
      this.local.set(admitted.runId, local);
      this.tail = job.then(() => undefined, () => undefined);
      void job.then((result) => { if (result) local.resolve(result); }, local.reject);
      void promise.then(() => this.local.delete(admitted.runId), () => this.local.delete(admitted.runId));
    }
    return admitted;
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
    const running = this.store.markRunning(runId);
    let candidate: RunResult | undefined;
    try {
      candidate = await this.executor(structuredClone(plan), structuredClone(running), local.controller.signal);
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
