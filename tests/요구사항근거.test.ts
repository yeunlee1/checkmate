// 일부 프로필 통과와 근거 손상을 요구사항 전체 완료로 오인하지 않는지 확인한다.
import { expect, it } from 'vitest';
import type { ProjectSource } from '@checkmate/contracts/project';
import { requirementEvidence } from '../packages/engine/src/서비스/요구사항근거.js';
import { completeResult } from './결과자료.js';

function source(): ProjectSource {
  return { project: { schemaVersion: 1, id: '00000000-0000-4000-8000-000000000002', name: '합성 원본', repositoryIdentity: 'synthetic:requirements', commands: [], profiles: [] },
    requirements: [{ id: 'requirement-1', title: '합계 계산', description: '합계 검증' }, { id: 'requirement-2', title: '아직 없는 검사', description: '누락 검증' }],
    checks: [{ id: 'case-1', title: '정상 합계', commandId: 'quick', requirementId: 'requirement-1', required: true, kind: 'logic', expected: '합계 일치', codePaths: ['src/합계.ts'] }] };
}

it('모든 필수 검사 근거가 있는 요구사항과 검사가 없는 요구사항을 구분한다', () => {
  expect(requirementEvidence(source(), completeResult(), 'verified')).toMatchObject([
    { requirementId: 'requirement-1', status: 'passed', codePaths: ['src/합계.ts'] },
    { requirementId: 'requirement-2', status: 'incomplete', reasons: ['missing-test'] },
  ]);
});

it('빠른 검사만 통과해도 같은 요구사항의 범위 밖 필수 검사가 남으면 미완료다', () => {
  const original = source();
  original.checks.push({ ...original.checks[0]!, id: 'case-2', title: '경계 합계' });
  expect(requirementEvidence(original, completeResult(), 'verified')[0]).toMatchObject({ status: 'incomplete', outsideChecks: ['case-2'], missingChecks: ['case-2'], reasons: ['profile-partial'] });
  expect(requirementEvidence(original, completeResult({ plannedChecks: [], requiredChecks: [], cases: [] }), 'verified')[0]?.status).toBe('out-of-scope');
});

it('증거 손상과 가져온 과거 결과 및 미확인 실행은 요구사항 통과를 재사용하지 못한다', () => {
  for (const result of [completeResult({ origin: 'imported', verdict: 'unknown' }), completeResult({ finalized: false }), completeResult({ state: 'unverifiable', verdict: 'unknown' })]) {
    expect(requirementEvidence(source(), result, 'verified')[0]?.status).toBe('unknown');
  }
  expect(requirementEvidence(source(), completeResult(), 'degraded')[0]?.status).toBe('unknown');
  const imported = completeResult({ origin: 'imported', verdict: 'unknown', plannedChecks: [], requiredChecks: [], cases: [] });
  expect(requirementEvidence(source(), imported, 'verified').every(item => item.status === 'unknown' && item.reasons.includes('imported-evidence'))).toBe(true);
});

it('관측한 실패는 미확인 근거와 함께 있어도 실패로 남는다', () => {
  const result = completeResult({ verdict: 'failed' });
  result.cases[0]!.status = 'failed';
  expect(requirementEvidence(source(), result, 'degraded')[0]?.status).toBe('failed');
});
