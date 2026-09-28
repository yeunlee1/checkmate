// 공식 Stryker 상태와 수동 제외가 검출력 판정에 반영되는지 검증한다.
import { describe, expect, it } from 'vitest';
import { adaptStrykerReport, type MutationStatus } from '../packages/engine/src/어댑터/검출력검사.js';

const scope = { id: '합성 계산 검사', files: ['계산.mjs'] };
const secret = '민감한 실패 메시지와 원본 코드';

function report(...statuses: MutationStatus[]) {
  return {
    schemaVersion: '2.0', thresholds: { high: 80, low: 60 },
    files: {
      '계산.mjs': {
        language: 'javascript', source: secret,
        mutants: statuses.map((status, index) => ({
          id: String(index), mutatorName: 'EqualityOperator', status,
          location: { start: { line: 2, column: 3 }, end: { line: 2, column: 5 } },
          statusReason: secret, replacement: secret,
        })),
      },
    },
  };
}

describe('Stryker 검출력 결과 어댑터', () => {
  it('실제 상태를 모두 보존하고 공식 점수의 분자와 분모를 명시한다', () => {
    const result = adaptStrykerReport(report(
      'Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending',
    ), scope);
    expect(result.status).toBe('failed');
    expect(result.findings.map((item) => item.status)).toEqual([
      'Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending',
    ]);
    expect(result.findings[0]).toMatchObject({
      file: '계산.mjs', mutatorName: 'EqualityOperator',
      location: { start: { line: 2, column: 3 }, end: { line: 2, column: 5 } },
    });
    expect(result.score).toEqual({ detected: 2, denominator: 4, percent: 50 });
    expect(result.counts).toMatchObject({ Killed: 1, Timeout: 1, Survived: 1, NoCoverage: 1,
      CompileError: 1, RuntimeError: 1, Ignored: 1, Pending: 1 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('빈 보고서와 알 수 없는 상태를 검증 완료로 취급하지 않는다', () => {
    expect(adaptStrykerReport(report(), scope)).toMatchObject({ status: 'unverified', score: null });
    const unknown = report('Killed');
    unknown.files['계산.mjs'].mutants[0]!.status = 'Mystery' as MutationStatus;
    expect(adaptStrykerReport(unknown, scope)).toMatchObject({ status: 'unverified', score: null });
    expect(adaptStrykerReport({ files: {} }, scope).status).toBe('unverified');
  });

  it('시간 초과와 오류를 통과 판정으로 바꾸지 않는다', () => {
    const result = adaptStrykerReport(report('Killed', 'Timeout', 'RuntimeError'), scope);
    expect(result.status).toBe('unverified');
    expect(result.counts).toMatchObject({ Killed: 1, Timeout: 1, RuntimeError: 1 });
    expect(result.score).toEqual({ detected: 2, denominator: 2, percent: 100 });
  });

  it('동등 변이는 사람이 지정한 대상과 사유가 있을 때만 별도 제외한다', () => {
    const raw = report('Killed', 'Survived');
    expect(adaptStrykerReport(raw, scope).status).toBe('failed');
    const exclusion = { file: '계산.mjs', id: '1', kind: 'equivalent' as const, reason: '같은 동작을 확인함' };
    const approved = adaptStrykerReport(raw, scope, [exclusion]);
    expect(approved.status).toBe('passed');
    expect(approved.score).toEqual({ detected: 1, denominator: 1, percent: 100 });
    expect(approved.findings[1]?.exclusion).toEqual(exclusion);
    expect(adaptStrykerReport(raw, scope, [{ ...exclusion, reason: ' ' }]).status).toBe('unverified');
    expect(adaptStrykerReport(raw, scope, [{ ...exclusion, id: '없는 항목' }]).status).toBe('unverified');
  });

  it('무시된 변이는 승인된 제외 사유가 없으면 미검증이다', () => {
    const raw = report('Killed', 'Ignored');
    expect(adaptStrykerReport(raw, scope).status).toBe('unverified');
    expect(adaptStrykerReport(raw, scope, [{ file: '계산.mjs', id: '1', kind: 'excluded',
      reason: '검사 범위 밖 코드' }]).status).toBe('passed');
  });

  it('선택 범위, 위치, 중복 식별자를 검증한다', () => {
    expect(adaptStrykerReport(report('Killed'), { ...scope, files: ['다른.mjs'] }).status).toBe('unverified');
    const malformed = report('Killed');
    malformed.files['계산.mjs'].mutants[0]!.location.start.line = 0;
    expect(adaptStrykerReport(malformed, scope).status).toBe('unverified');
    const duplicate = report('Killed', 'Killed');
    duplicate.files['계산.mjs'].mutants[1]!.id = '0';
    expect(adaptStrykerReport(duplicate, scope).status).toBe('unverified');
  });

  it('위치의 추가 필드에 숨긴 원문도 결과에 복사하지 않는다', () => {
    const raw = report('Killed');
    Object.assign(raw.files['계산.mjs'].mutants[0]!.location.start, { message: secret });
    const result = adaptStrykerReport(raw, scope);
    expect(result.status).toBe('passed');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
