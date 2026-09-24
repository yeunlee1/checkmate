// 실행 결과를 작은 요약과 범위에 묶인 상세 페이지로 나눈다.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';
import type { RunResult } from '@checkmate/contracts';

const cursorSchema = z.strictObject({ scope: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative() });
export function boundedPage<T>(items: readonly T[], scope: string, cursor?: string, limit = 50, maxBytes = 6000): { items: T[]; nextCursor: string | null; total: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('invalid-input');
  const scopeHash = createHash('sha256').update(scope).digest('hex');
  let offset = 0;
  if (cursor !== undefined) {
    try {
      const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (parsed.scope !== scopeHash || parsed.offset > items.length) throw new Error('cursor');
      offset = parsed.offset;
    } catch { throw new ServiceError('invalid-input', '조회 범위에 맞지 않는 페이지입니다.'); }
  }
  const page: T[] = [];
  const output = () => ({ items: page, nextCursor: offset + page.length < items.length
    ? Buffer.from(JSON.stringify({ scope: scopeHash, offset: offset + page.length })).toString('base64url') : null, total: items.length });
  for (const item of items.slice(offset, offset + limit)) {
    page.push(item);
    if (Buffer.byteLength(JSON.stringify(output()), 'utf8') > maxBytes) { page.pop(); break; }
  }
  if (page.length === 0 && offset < items.length) throw new ServiceError('response-too-large', '한 항목이 조회 크기를 넘었습니다.', false, '증거 본문이나 더 작은 항목으로 나눠 조회해 주세요.');
  return output();
}

export function compactCase(item: RunResult['cases'][number]) {
  return { ...item, expected: item.expected?.slice(0, 384) ?? null, observed: item.observed?.slice(0, 384) ?? null,
    evidenceIds: item.evidenceIds.slice(0, 10), truncated: (item.expected?.length ?? 0) > 384 || (item.observed?.length ?? 0) > 384 || item.evidenceIds.length > 10 };
}

export function resultSummary(result: RunResult, integrity: 'verified' | 'degraded' | 'pending' = 'pending') {
  const statuses: Record<string, number> = {};
  for (const item of result.cases) statuses[item.status] = (statuses[item.status] ?? 0) + 1;
  return { runId: result.runId, projectId: result.projectId, profile: result.profile, origin: result.origin,
    state: result.state, verdict: result.verdict, effectiveVerdict: integrity === 'degraded' && result.verdict === 'passed' ? 'unknown' : result.verdict,
    finalized: result.finalized, integrity, reusablePassed: result.verdict === 'passed' && integrity === 'verified',
    planHash: result.planHash, sourceBefore: result.sourceBefore, sourceAfter: result.sourceAfter,
    workerExitCode: result.workerExitCode, environmentVerified: result.environmentVerified, evidenceVerified: result.evidenceVerified,
    cleanupVerified: result.cleanupVerified, planned: result.plannedChecks.length, required: result.requiredChecks.length,
    counts: statuses, reasons: result.reasons, failures: result.cases.filter((item) => item.status !== 'passed').slice(0, 5).map(compactCase) };
}
