// 합성 아틀리에 보고서의 읽기 전용 정규화와 오류 경계를 검증한다.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importAtelierReport } from '../packages/engine/src/어댑터/아틀리에이력.js';

const hash = 'a'.repeat(64);
const step = (id: string, status: string, exitCode?: number) => ({ id, status, ...(exitCode === undefined ? {} : { exitCode }),
  label: '고객 이름과 토큰을 포함할 수 있는 원문', log: 'C:/private/customer.log', args: ['secret-token'] });
const report = (overrides: Record<string, unknown> = {}) => ({ mode: 'quick', status: 'passed', source: { commit: 'b'.repeat(40), fingerprint: hash, files: 4 },
  sourceAfter: { commit: 'b'.repeat(40), fingerprint: hash, files: 4 },
  omitted: ['격리 DB 통합 검사'], steps: [step('format', 'passed', 0), step('types', 'passed', 0),
    step('runner', 'passed', 0), step('unit', 'passed', 0)], ...overrides });

describe('아틀리에 과거 보고서', () => {
  it('원문 상태를 보존하고 검증되지 않은 이력으로만 돌려준다', () => {
    const raw = JSON.stringify(report());
    const result = importAtelierReport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({ origin: 'imported', reportedStatus: 'passed', mode: 'quick',
      environment: { kind: 'unknown', verified: false }, reusablePassed: false, effectiveVerdict: 'unknown',
      summary: { passed: 4, failed: 0, notRun: 0, total: 4 }, omissions: { declaredCount: 1, notRunStepIds: [] } });
    expect(result.report.originalSha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(JSON.stringify(result.report)).not.toMatch(/고객 이름|secret-token|private\/customer|격리 DB/);
  });

  it('실패 뒤 미실행과 최종 종료 미기록을 개별 성공으로 만들지 않는다', () => {
    const result = importAtelierReport(report({ status: 'failed', sourceAfter: undefined,
      steps: [step('format', 'failed', 2), step('types', 'not-run'), step('runner', 'not-run')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({ reportedStatus: 'failed', effectiveVerdict: 'unknown',
      source: { afterFingerprint: null }, summary: { passed: 0, failed: 1, notRun: 2 },
      omissions: { notRunStepIds: ['types', 'runner'] } });
    expect(result.report.steps[1]).toMatchObject({ status: 'not-run', exitCode: null });
  });

  it('환경 단서는 구분하되 실행 환경 확인으로 승격하지 않는다', () => {
    const d1 = importAtelierReport(report({ mode: 'e2e', steps: [step('customers', 'passed', 0)] }));
    const mock = importAtelierReport(report({ mode: 'e2e', steps: [step('staff-ui', 'passed', 0)] }));
    const mixed = importAtelierReport(report({ mode: 'full', steps: [step('customers', 'passed', 0), step('staff-ui', 'passed', 0)] }));
    const unknown = importAtelierReport(report({ steps: [step('postgres', 'passed', 0)] }));
    expect(d1.ok && d1.report.environment).toMatchObject({ kind: 'D1', verified: false });
    expect(mock.ok && mock.report.environment).toMatchObject({ kind: 'mock-api', verified: false });
    expect(mixed.ok && mixed.report.environment.kind).toBe('unknown');
    expect(unknown.ok && unknown.report.environment.kind).toBe('unknown');
  });

  it('손상 JSON과 과대 입력을 구조화해 거절한다', () => {
    expect(importAtelierReport('{').ok).toBe(false);
    expect(importAtelierReport(Buffer.from([0xff]))).toEqual({ ok: false, errors: [{ code: 'invalid-json', path: '$' }] });
    expect(importAtelierReport('x'.repeat(1024 * 1024 + 1))).toEqual({ ok: false, errors: [{ code: 'too-large', path: '$' }] });
    expect(importAtelierReport(report({ steps: [] }))).toEqual({ ok: false, errors: [{ code: 'invalid-report', path: '$' }] });
    expect(importAtelierReport(report({ omitted: ['x'.repeat(257)] }))).toEqual({ ok: false,
      errors: [{ code: 'invalid-report', path: '$.omitted' }] });
    expect(importAtelierReport(report({ steps: Array.from({ length: 65 }, (_, index) => step(`id-${index}`, 'passed', 0)) }))).toEqual({ ok: false,
      errors: [{ code: 'invalid-report', path: '$' }] });
  });

  it('잘못된 소스 지문과 중복 또는 모순 단계 기록을 거절한다', () => {
    expect(importAtelierReport(report({ source: { fingerprint: 'bad' } }))).toEqual({ ok: false,
      errors: [{ code: 'invalid-fingerprint', path: '$.source' }] });
    expect(importAtelierReport(report({ steps: [step('format', 'passed', 0), step('format', 'passed', 0)] }))).toEqual({ ok: false,
      errors: [{ code: 'duplicate-step', path: '$.steps[1]' }] });
    expect(importAtelierReport(report({ steps: [step('format', 'passed', 1)] }))).toEqual({ ok: false,
      errors: [{ code: 'invalid-step', path: '$.steps[0]' }] });
    expect(importAtelierReport(report({ status: 'passed', steps: [step('format', 'failed', 1)] }))).toEqual({ ok: false,
      errors: [{ code: 'invalid-report', path: '$.status' }] });
  });
});
