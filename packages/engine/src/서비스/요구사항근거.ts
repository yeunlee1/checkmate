// 실행 당시 원본과 실제 검사 근거를 요구사항별로 연결하고 범위 밖 항목을 표시한다.
import type { RunResult } from '@checkmate/contracts';
import type { ProjectSource } from '@checkmate/contracts/project';

export type RequirementEvidence = {
  requirementId: string; title: string; status: 'passed' | 'failed' | 'incomplete' | 'unknown' | 'out-of-scope';
  checks: string[]; selectedChecks: string[]; outsideChecks: string[]; missingChecks: string[];
  evidenceIds: string[]; codePaths: string[]; reasons: string[];
};

export function requirementEvidence(source: ProjectSource, result: RunResult, integrity: 'verified' | 'degraded' | 'pending'): RequirementEvidence[] {
  const selected = new Set(result.plannedChecks);
  const observations = new Map(result.cases.map(item => [item.testId, item]));
  return source.requirements.map(requirement => {
    const definitions = source.checks.filter(check => check.requirementId === requirement.id);
    const checks = definitions.map(check => check.id);
    const selectedChecks = checks.filter(id => selected.has(id));
    const requiredChecks = definitions.filter(check => check.required).map(check => check.id);
    const outsideChecks = checks.filter(id => !selected.has(id));
    const missingChecks = requiredChecks.filter(id => !selected.has(id) || observations.get(id)?.status !== 'passed');
    const cases = selectedChecks.flatMap(id => observations.get(id) ?? []);
    const reasons: string[] = [];
    let status: RequirementEvidence['status'];
    if (cases.some(item => item.status === 'failed')) { status = 'failed'; reasons.push('check-failed'); }
    else if (checks.length === 0 || requiredChecks.length === 0) { status = 'incomplete'; reasons.push('missing-test'); }
    else if (selectedChecks.length === 0) { status = 'out-of-scope'; reasons.push('profile-outside'); }
    else if (result.origin !== 'live' || integrity !== 'verified' || !result.finalized || result.state === 'unverifiable') {
      status = 'unknown'; reasons.push('evidence-unconfirmed');
    } else if (missingChecks.length || result.verdict !== 'passed') {
      status = 'incomplete'; reasons.push(missingChecks.some(id => !selected.has(id)) ? 'profile-partial' : 'required-checks-incomplete');
    } else status = 'passed';
    return { requirementId: requirement.id, title: requirement.title, status, checks, selectedChecks, outsideChecks, missingChecks,
      evidenceIds: [...new Set(cases.flatMap(item => item.evidenceIds))], codePaths: [...new Set(definitions.flatMap(check => check.codePaths))], reasons };
  });
}
