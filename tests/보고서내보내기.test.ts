// 보고서의 비신뢰 문자가 실행되지 않고 증거 상태 변경을 숨기지 않는지 확인한다.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ApiResponse } from '@checkmate/contracts/api';
import { exportRunHtml } from '../packages/engine/src/서비스/보고서내보내기.js';
import { resultSummary } from '../packages/engine/src/서비스/조회결과.js';
import { completeResult } from './결과자료.js';

const response = (data: unknown): ApiResponse => ({ apiVersion: 1, requestId: randomUUID(), ok: true, data });
it('스크립트와 태그를 텍스트로 보존하고 모든 상세 페이지를 포함한다.', async () => {
  const run = completeResult();
  const html = await exportRunHtml(async (_method, input) => {
    if (input.section === 'summary') return response(resultSummary(run, 'verified'));
    if (input.section === 'requirements') return response({ items: [], nextCursor: null });
    return response({ items: [{ ...run.cases[0], testId: input.cursor ? 'second' : '<script>alert(1)</script>', observed: '<img src=x onerror=alert(2)>', truncated: true }], nextCursor: input.cursor ? null : 'page-2' });
  }, run.runId);
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('second');
  expect(html).toContain('축약되었습니다');
  expect(html).toContain('<meta charset="utf-8">');
});
it('진행 중 실행이나 조회 중 증거 손상은 내보내지 않는다.', async () => {
  const run = completeResult();
  await expect(exportRunHtml(async () => response({ ...resultSummary(run), finalized: false }), run.runId)).rejects.toMatchObject({ code: 'run-not-finalized' });
  let summaries = 0;
  await expect(exportRunHtml(async (_method, input) => input.section === 'summary'
    ? response(resultSummary(run, ++summaries === 1 ? 'verified' : 'degraded'))
    : response({ items: [], nextCursor: null }), run.runId)).rejects.toMatchObject({ code: 'evidence-changed' });
});
