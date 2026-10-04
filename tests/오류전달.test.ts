// 실제 프로젝트 저장 오류의 공개 코드와 안전한 안내를 검증한다.
import { describe, expect, test } from 'vitest';
import { apiResponseSchema, errorResponse } from '@checkmate/contracts/api';
import { ProjectStoreError } from '../packages/engine/src/저장/프로젝트저장.js';

const requestId = '00000000-0000-4000-8000-000000000001';

describe('프로젝트 저장 오류 전달', () => {
  test.each(['project-conflict', 'catalog-stale'])('%s를 공개 응답에서 보존한다', code => {
    const error = new ProjectStoreError(code);
    error.message = 'synthetic-private-value';
    const response = errorResponse(requestId, error);
    expect(apiResponseSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({ requestId, ok: false, error: { code, retryable: false } });
    if (response.ok) throw new Error('저장 오류가 성공으로 전달됐습니다.');
    expect(response.error.nextAction.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toContain(error.message);
  });

  test('알 수 없는 오류 코드와 원문은 노출하지 않는다', () => {
    const error = Object.assign(new Error('synthetic-private-value'), { code: 'synthetic-private-code' });
    const response = errorResponse(requestId, error);
    expect(response).toMatchObject({ ok: false, error: { code: 'internal-error', retryable: false } });
    expect(JSON.stringify(response)).not.toContain(error.message);
    expect(JSON.stringify(response)).not.toContain(error.code);
  });

  test('기존 작업 공간 경합 코드를 유지한다', () => {
    expect(errorResponse(requestId, new ProjectStoreError('workspace-busy')))
      .toMatchObject({ ok: false, error: { code: 'workspace-busy' } });
  });
});
