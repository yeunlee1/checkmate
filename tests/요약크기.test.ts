// 실제 MCP 클라이언트에서 긴 한글 실패 결과의 요약 크기와 필수 상태를 검증한다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { resultInputSchema } from '@checkmate/contracts';
import type { ApiResponse } from '@checkmate/contracts/api';
import { createAgentServer } from '../packages/engine/src/연결/에이아이서버.js';
import { compactCase, compactRepairCase, resultSummary } from '../packages/engine/src/서비스/조회결과.js';
import { completeResult } from './결과자료.js';

it('긴 한글 실패 다섯 건을 result와 status에서 8KiB 안에 조회한다.', async () => {
  const cases = Array.from({ length: 5 }, (_, index) => ({
    testId: `case-${index}`, status: 'failed' as const, requirementId: 'requirement-1',
    expected: '기대'.repeat(384), observed: '관측'.repeat(384), evidenceIds: [],
    severity: 'error' as const, location: null,
  }));
  const result = completeResult({ verdict: 'failed', cases, plannedChecks: cases.map((item) => item.testId),
    requiredChecks: cases.map((item) => item.testId), reasons: ['check-failed'] });
  const server = createAgentServer(async (request): Promise<ApiResponse> => ({
    apiVersion: 1, requestId: request.requestId, ok: true,
    data: resultSummary(result, request.method === 'result' ? 'verified' : 'pending'),
  }));
  const client = new Client({ name: 'summary-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const [name, args] of [
      ['get_run_result', { runId: result.runId, section: 'summary' }],
      ['get_run_status', { runId: result.runId }],
    ] as const) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(8192);
      const content = (response as { content?: Array<{ type: string; text?: string }> }).content
        ?.find((item) => item.type === 'text');
      if (!content?.text) throw new Error('요약 본문이 없습니다.');
      const parsed = JSON.parse(content.text) as { ok: boolean; data: ReturnType<typeof resultSummary> };
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toMatchObject({ state: 'finished', verdict: 'failed', total: 5,
        counts: { failed: 5 }, omittedFailures: 5 - parsed.data.failures.length });
      expect(parsed.data.failures.length).toBeGreaterThan(0);
      expect(parsed.data.failures.length).toBeLessThanOrEqual(5);
      expect(parsed.data.detail).toContain('cases');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it('최대 식별자와 이유 및 JSON escape가 많아도 실제 MCP 조회가 성공한다.', async () => {
  const noisy = '\\"\n\t'.repeat(900);
  const cases = Array.from({ length: 5 }, (_, index) => ({
    testId: String(index).repeat(160), status: 'failed' as const, requirementId: 'r'.repeat(160),
    expected: noisy, observed: noisy, evidenceIds: [], severity: 'error' as const,
    location: { file: 'f'.repeat(1024), line: 1 },
  }));
  const result = completeResult({ projectId: 'p'.repeat(160), profile: 'q'.repeat(160), verdict: 'failed',
    cases, plannedChecks: cases.map((item) => item.testId), requiredChecks: cases.map((item) => item.testId),
    reasons: Array.from({ length: 100 }, () => 'r'.repeat(256)) });
  expect(resultInputSchema.safeParse(result).success).toBe(true);
  const summary = resultSummary(result);
  expect(summary).toMatchObject({ state: 'finished', verdict: 'failed', total: 5, counts: { failed: 5 } });
  expect(summary.omittedFailures).toBe(5 - summary.failures.length);
  expect(summary.omittedReasons).toBe(100 - summary.reasons.length);
  expect(compactCase(cases[0]!).truncated).toBe(true);
  const server = createAgentServer(async (request): Promise<ApiResponse> => ({
    apiVersion: 1, requestId: request.requestId, ok: true, data: summary,
  }));
  const client = new Client({ name: 'summary-edge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const [name, args] of [
      ['get_run_result', { runId: result.runId, section: 'summary' }],
      ['get_run_status', { runId: result.runId }],
    ] as const) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(8192);
      const content = (response as { content?: Array<{ type: string; text?: string }> }).content
        ?.find((item) => item.type === 'text');
      if (!content?.text) throw new Error('요약 본문이 없습니다.');
      expect(JSON.parse(content.text)).toMatchObject({ ok: true, data: {
        state: 'finished', verdict: 'failed', total: 5, omittedFailures: summary.omittedFailures,
      } });
    }
  } finally {
    await client.close();
    await server.close();
  }
});

it('수정 묶음은 긴 진단을 제공하되 과거 ANSI 문자열과 출처를 바꾸지 않는다', () => {
  const observed = '\u001b[31m' + 'safe diagnostic '.repeat(60) + '\u001b[0m';
  const item = { ...completeResult().cases[0]!, status: 'failed' as const, observed };
  expect(compactCase(item).observed).toHaveLength(384);
  expect(compactRepairCase(item).observed).toBe(observed);
  expect(compactRepairCase(item).truncated).toBe(false);
  expect(compactRepairCase(item)).not.toHaveProperty('failureOrigin');
  expect(item.observed).toBe(observed);
  const long = compactRepairCase({ ...item, observed: '긴진단'.repeat(2000) });
  expect(long.truncated).toBe(true);
  expect(long.observed!.length).toBe(1024);
});
