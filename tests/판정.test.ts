// 거짓 통과를 막는 판정과 결과 계약의 경계를 검증한다.
import { describe, expect, it } from 'vitest';
import { assessResult, resultExitCode, runResultSchema } from '@checkmate/contracts';
import { completeResult } from './결과자료.js';

describe('완료 증거 판정', () => {
  it('모든 조건을 확인한 결과만 통과시킨다.', () => {
    const result = completeResult();
    expect(runResultSchema.parse(result).verdict).toBe('passed');
    expect(resultExitCode(result)).toBe(0);
  });

  it.each([
    ['workerExitCode', null], ['planHash', null], ['sourceBefore', null], ['sourceAfter', null],
    ['environmentVerified', false], ['environmentVerified', null], ['evidenceVerified', false],
    ['cleanupVerified', false], ['finalized', false],
  ])('%s의 확인이 빠지면 기록된 통과를 거절한다.', (field, value) => {
    const result = { ...completeResult(), [field]: value };
    expect(runResultSchema.safeParse(result).success).toBe(false);
    expect(assessResult(result).verdict).toBe('unknown');
  });

  it.each(['not-run', 'skipped', 'timed-out', 'interrupted'] as const)('%s를 통과로 바꾸지 않는다.', (status) => {
    const result = completeResult();
    result.cases[0]!.status = status;
    expect(assessResult(result).verdict).toBe('incomplete');
    expect(runResultSchema.safeParse(result).success).toBe(false);
  });

  it('필수 검사 누락과 빈 계획을 통과시키지 않는다.', () => {
    expect(assessResult(completeResult({ cases: [] })).verdict).toBe('incomplete');
    expect(assessResult(completeResult({ requiredChecks: [] })).verdict).toBe('incomplete');
  });

  it('소스가 바뀌면 기존 검사가 통과해도 미완료다.', () => {
    const result = completeResult({ sourceAfter: 'c'.repeat(64) });
    expect(assessResult(result)).toMatchObject({ verdict: 'incomplete', reasons: ['source-changed'] });
  });

  it('관측한 실패와 미확인 정리 상태를 함께 남긴다.', () => {
    const result = completeResult({ cleanupVerified: false });
    result.cases[0]!.status = 'failed';
    expect(assessResult(result)).toEqual({ verdict: 'failed', reasons: ['check-failed', 'required-checks-incomplete', 'cleanup-unconfirmed'] });
  });

  it('개별 통과만 있고 작업 프로세스가 실패하면 실패다.', () => {
    const result = completeResult({ workerExitCode: 7 });
    expect(assessResult(result).verdict).toBe('failed');
    expect(resultExitCode(result)).toBe(1);
  });

  it('과거 결과는 현재 성공으로 승격하지 않는다.', () => {
    const result = completeResult({ origin: 'imported', verdict: 'unknown' });
    expect(runResultSchema.safeParse(result).success).toBe(true);
    expect(resultExitCode(result)).toBe(5);
  });

  it.each(['queued', 'running'] as const)('진행 중인 %s는 확정 판정을 갖지 않는다.', (state) => {
    const result = completeResult({ state, finalized: false, verdict: null });
    expect(runResultSchema.safeParse(result).success).toBe(true);
    expect(resultExitCode(result)).toBe(3);
    expect(runResultSchema.safeParse({ ...result, finalized: true }).success).toBe(false);
  });

  it('취소와 확인 불가의 종료코드를 구분한다.', () => {
    expect(resultExitCode(completeResult({ state: 'cancelled', verdict: 'incomplete' }))).toBe(4);
    expect(resultExitCode(completeResult({ state: 'unverifiable', verdict: 'unknown' }))).toBe(5);
  });

  it('취소로 발생한 비영 종료를 검사 실패로 바꾸지 않는다.', () => {
    const result = completeResult({ state: 'cancelled', workerExitCode: 1, verdict: 'incomplete' });
    expect(runResultSchema.safeParse(result).success).toBe(true);
    expect(resultExitCode(result)).toBe(4);
  });

  it('중복 검사와 계획 밖 결과를 거절한다.', () => {
    const result = completeResult();
    expect(runResultSchema.safeParse({ ...result, requiredChecks: ['case-1', 'case-1'] }).success).toBe(false);
    expect(runResultSchema.safeParse({ ...result, cases: [...result.cases, ...result.cases] }).success).toBe(false);
    expect(runResultSchema.safeParse({ ...result, plannedChecks: [] }).success).toBe(false);
  });

  it('알 수 없는 계약 버전과 임의 키를 거절한다.', () => {
    expect(runResultSchema.safeParse({ ...completeResult(), schemaVersion: 2 }).success).toBe(false);
    expect(runResultSchema.safeParse({ ...completeResult(), approved: true }).success).toBe(false);
  });
});
