// 판정 시험에 필요한 합성 실행 결과를 만든다.
import type { RunResult } from '@checkmate/contracts';

export function completeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    runId: '00000000-0000-4000-8000-000000000001',
    projectId: 'sample',
    profile: 'quick',
    origin: 'live',
    state: 'finished',
    verdict: 'passed',
    planHash: 'a'.repeat(64),
    sourceBefore: 'b'.repeat(64),
    sourceAfter: 'b'.repeat(64),
    workerExitCode: 0,
    environmentVerified: true,
    evidenceVerified: true,
    cleanupVerified: true,
    finalized: true,
    plannedChecks: ['case-1'],
    requiredChecks: ['case-1'],
    cases: [{
      testId: 'case-1', status: 'passed', requirementId: 'requirement-1', expected: '합계가 일치한다.',
      observed: '합계가 일치했다.', evidenceIds: [], severity: 'error', location: null,
    }],
    reasons: [],
    ...overrides,
  };
}
