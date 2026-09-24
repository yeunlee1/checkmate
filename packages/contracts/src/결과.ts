// 실행 결과의 형식과 통과에 필요한 증거 조건을 검증한다.
import { z } from 'zod';

export const caseStatusSchema = z.enum([
  'passed', 'failed', 'not-run', 'skipped', 'timed-out', 'interrupted', 'unknown',
]);
export const verdictSchema = z.enum(['passed', 'failed', 'incomplete', 'unknown']);
const identifier = z.string().min(1).max(160);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const caseSchema = z.strictObject({
  testId: identifier,
  status: caseStatusSchema,
  requirementId: identifier.nullable(),
  expected: z.string().max(4096).nullable(),
  observed: z.string().max(4096).nullable(),
  evidenceIds: z.array(identifier).max(100),
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  location: z.strictObject({ file: z.string().max(1024), line: z.number().int().positive() }).nullable(),
});

export const resultInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  projectId: identifier,
  profile: identifier,
  origin: z.enum(['live', 'imported']),
  state: z.enum(['queued', 'running', 'finished', 'blocked', 'cancelled', 'unverifiable']),
  verdict: verdictSchema.nullable(),
  planHash: fingerprint.nullable(),
  sourceBefore: fingerprint.nullable(),
  sourceAfter: fingerprint.nullable(),
  workerExitCode: z.number().int().nullable(),
  environmentVerified: z.boolean().nullable(),
  evidenceVerified: z.boolean().nullable(),
  cleanupVerified: z.boolean().nullable(),
  finalized: z.boolean(),
  plannedChecks: z.array(identifier).max(100000),
  requiredChecks: z.array(identifier).max(100000),
  cases: z.array(caseSchema).max(100000),
  reasons: z.array(z.string().min(1).max(256)).max(100),
});

export type RunResult = z.infer<typeof resultInputSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Assessment = { verdict: Verdict | null; reasons: string[] };

export function assessResult(result: RunResult): Assessment {
  if (result.state === 'queued' || result.state === 'running') {
    return { verdict: null, reasons: ['run-not-finished'] };
  }
  if (result.origin === 'imported') return { verdict: 'unknown', reasons: ['imported-evidence'] };

  const reasons: string[] = [];
  const cases = new Map(result.cases.map((item) => [item.testId, item]));
  const observedFailure = result.cases.some((item) => item.status === 'failed');
  if (observedFailure) reasons.push('check-failed');
  const workerFailed = result.state === 'finished' && result.workerExitCode !== null && result.workerExitCode !== 0;
  if (workerFailed) reasons.push('worker-failed');
  if (!result.finalized) reasons.push('result-not-finalized');
  if (result.state !== 'finished') reasons.push(`run-${result.state}`);
  if (result.requiredChecks.length === 0) reasons.push('required-checks-empty');
  const missing = result.requiredChecks.filter((id) => cases.get(id)?.status !== 'passed');
  if (missing.length > 0) reasons.push('required-checks-incomplete');
  if (result.workerExitCode === null) reasons.push('exit-unconfirmed');
  if (result.planHash === null) reasons.push('plan-unconfirmed');
  if (result.sourceBefore === null || result.sourceAfter === null) reasons.push('source-unconfirmed');
  else if (result.sourceBefore !== result.sourceAfter) reasons.push('source-changed');
  if (result.environmentVerified !== true) reasons.push('environment-unconfirmed');
  if (result.evidenceVerified !== true) reasons.push('evidence-unconfirmed');
  if (result.cleanupVerified !== true) reasons.push('cleanup-unconfirmed');

  if (observedFailure || workerFailed) {
    return { verdict: 'failed', reasons };
  }
  if (result.state === 'blocked' || result.state === 'cancelled') return { verdict: 'incomplete', reasons };
  if (!result.finalized || result.state === 'unverifiable' || reasons.some((reason) => reason.endsWith('-unconfirmed')) ||
    result.requiredChecks.some((id) => cases.get(id)?.status === 'unknown')) {
    return { verdict: 'unknown', reasons };
  }
  return { verdict: reasons.length === 0 ? 'passed' : 'incomplete', reasons };
}

export const runResultSchema = resultInputSchema.superRefine((result, context) => {
  for (const [key, ids] of [
    ['plannedChecks', result.plannedChecks],
    ['requiredChecks', result.requiredChecks],
    ['cases', result.cases.map((item) => item.testId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: [key], message: '검사 ID가 중복되었습니다.' });
    }
  }
  const planned = new Set(result.plannedChecks);
  if (result.requiredChecks.some((id) => !planned.has(id)) || result.cases.some((item) => !planned.has(item.testId))) {
    context.addIssue({ code: 'custom', path: ['plannedChecks'], message: '계획에 없는 검사 ID가 포함되었습니다.' });
  }
  if ((result.state === 'queued' || result.state === 'running') && result.finalized) {
    context.addIssue({ code: 'custom', path: ['finalized'], message: '진행 중인 실행을 확정할 수 없습니다.' });
  }
  if (assessResult(result).verdict !== result.verdict) {
    context.addIssue({ code: 'custom', path: ['verdict'], message: '판정과 확인된 조건이 일치하지 않습니다.' });
  }
});

export function resultExitCode(result: RunResult): number {
  const verdict = assessResult(result).verdict;
  if (verdict === 'failed') return 1;
  if (result.state === 'cancelled') return 4;
  if (verdict === 'passed') return 0;
  if (verdict === 'unknown') return 5;
  return 3;
}
