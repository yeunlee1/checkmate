// 확정된 실행 요약과 요구사항 및 검사 결과를 안전한 단일 HTML로 내보낸다.
import { z } from 'zod';
import type { ApiMethod, ApiResponse } from '@checkmate/contracts/api';
import { ServiceError } from '@checkmate/contracts/api';

type Invoke = (method: ApiMethod, input: Record<string, unknown>) => Promise<ApiResponse>;
const summarySchema = z.object({ runId: z.uuid(), projectId: z.string(), profile: z.string(), origin: z.string(),
  state: z.string(), verdict: z.string().nullable(), effectiveVerdict: z.string().nullable(), finalized: z.boolean(),
  integrity: z.string(), planHash: z.string().nullable(), sourceBefore: z.string().nullable(), sourceAfter: z.string().nullable(),
  workerExitCode: z.number().nullable(), cleanupVerified: z.boolean().nullable(), reasons: z.array(z.string()), omittedReasons: z.number().optional() });
const caseSchema = z.object({ testId: z.string(), status: z.string(), requirementId: z.string().nullable(), expected: z.string().nullable(),
  observed: z.string().nullable(), evidenceIds: z.array(z.string()), truncated: z.boolean().optional() });
const requirementSchema = z.object({ requirementId: z.string(), title: z.string(), status: z.string(), selectedChecks: z.array(z.string()),
  outsideChecks: z.array(z.string()), missingChecks: z.array(z.string()), codePaths: z.array(z.string()), reasons: z.array(z.string()) });
const pageSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() });
const maxBytes = 16 * 1024 * 1024;
const labels: Record<string, string> = { passed: '통과', failed: '실패', incomplete: '미완료', unknown: '미확인', 'out-of-scope': '범위 밖',
  'not-run': '미실행', skipped: '건너뜀', 'timed-out': '시간 초과', interrupted: '중단', live: '직접 실행', imported: '가져온 이력' };
const escape = (value: unknown) => String(value ?? '기록 없음').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const list = (values: string[]) => values.length ? values.map(escape).join(' · ') : '없음';

export async function exportRunHtml(invoke: Invoke, runId: string): Promise<string> {
  z.uuid().parse(runId);
  async function read(section: string, cursor?: string): Promise<unknown> {
    const response = await invoke('result', { runId, section, ...(cursor ? { cursor } : {}) });
    if (!response.ok) throw new ServiceError(response.error.code, response.error.message, response.error.retryable, response.error.nextAction);
    return response.data;
  }
  const summary = summarySchema.parse(await read('summary'));
  if (!summary.finalized) throw new ServiceError('run-not-finalized', '실행이 확정된 뒤 보고서를 저장할 수 있습니다.');
  let usedBytes = 0;
  async function collect<T>(section: string, schema: z.ZodType<T>): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = pageSchema.parse(await read(section, cursor));
      usedBytes += Buffer.byteLength(JSON.stringify(page.items), 'utf8');
      if (usedBytes > maxBytes || items.length + page.items.length > 100_000) throw new ServiceError('report-too-large', '보고서 크기 한도를 넘었습니다. CLI에서 상세 구간을 조회해 주세요.');
      items.push(...page.items.map(item => schema.parse(item)));
      if (page.nextCursor && seen.has(page.nextCursor)) throw new ServiceError('invalid-cursor');
      if (page.nextCursor) seen.add(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }
  const requirements = await collect('requirements', requirementSchema);
  const cases = await collect('cases', caseSchema);
  const after = summarySchema.parse(await read('summary'));
  if (JSON.stringify(after) !== JSON.stringify(summary)) throw new ServiceError('evidence-changed', '조회 중 증거 상태가 바뀌었습니다. 다시 저장해 주세요.');
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>체크메이트 검증 보고서</title><style>
:root{font-family:'Segoe UI','Malgun Gothic',sans-serif;color:#172033;background:#f5f7fb;font-size:16px;line-height:1.6}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:40px 24px}h1{font-size:32px;margin:8px 0}h2{margin:32px 0 12px}h3{font-size:18px;margin:0}p{margin:8px 0}.eyebrow{font-weight:700;color:#1e4da1}section,article{background:white;border:1px solid #d9e1ed;border-radius:12px;padding:20px;margin:14px 0;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:160px minmax(0,1fr);gap:8px 20px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#f5f7fb;padding:12px;border-radius:8px}.status{font-weight:700}small{color:#526078}@media(max-width:600px){main{padding:24px 12px}h1{font-size:26px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}}@media print{body{background:white}main{max-width:none;padding:0}article{break-inside:avoid}}
</style></head><body><main><p class="eyebrow">CHECKMATE · 검증 보고서</p><h1>${escape(labels[summary.effectiveVerdict ?? 'unknown'] ?? summary.effectiveVerdict)}</h1>
<p>선택한 프로필의 확정 기록입니다. 현재 증거 상태는 내보낸 시점의 관측이며, 파일을 공유한 뒤의 상태를 자동 확인하지 않습니다.</p>
<section aria-label="실행 요약"><dl><dt>실행 ID</dt><dd>${escape(summary.runId)}</dd><dt>프로필</dt><dd>${escape(summary.profile)}</dd>
<dt>출처</dt><dd>${escape(labels[summary.origin] ?? summary.origin)}</dd><dt>저장 판정</dt><dd>${escape(summary.verdict)}</dd><dt>현재 증거 상태</dt><dd>${escape(summary.integrity)}</dd>
<dt>명령 작업 종료</dt><dd>${escape(summary.workerExitCode)}</dd><dt>정리 확인</dt><dd>${summary.cleanupVerified === true ? '확인됨' : '미확인'}</dd>
<dt>계획 지문</dt><dd>${escape(summary.planHash)}</dd><dt>실행 전 소스</dt><dd>${escape(summary.sourceBefore)}</dd><dt>실행 후 소스</dt><dd>${escape(summary.sourceAfter)}</dd></dl>
<p>판정 사유 · ${list(summary.reasons)}${summary.omittedReasons ? ` · 추가 ${summary.omittedReasons}건은 CLI 상세 조회가 필요합니다.` : ''}</p></section>
<h2>요구사항 근거 · ${requirements.length}개</h2>${requirements.map(item => `<article><h3>${escape(item.title)} <span class="status">· ${escape(labels[item.status] ?? item.status)}</span></h3><p>${escape(item.requirementId)}</p><dl><dt>선택 검사</dt><dd>${list(item.selectedChecks)}</dd><dt>범위 밖 검사</dt><dd>${list(item.outsideChecks)}</dd><dt>부족한 검사</dt><dd>${list(item.missingChecks)}</dd><dt>관련 소스</dt><dd>${list(item.codePaths)}</dd></dl><p>${list(item.reasons)}</p></article>`).join('')}
<h2>검사 결과 · ${cases.length}개</h2>${cases.map(item => `<article><h3>${escape(item.testId)} <span class="status">· ${escape(labels[item.status] ?? item.status)}</span></h3><p>요구사항 · ${escape(item.requirementId)}</p><strong>기대</strong><pre>${escape(item.expected)}</pre><strong>관측</strong><pre>${escape(item.observed)}</pre><p>증거 ID · ${list(item.evidenceIds)}</p>${item.truncated ? '<p>긴 관측 또는 증거 목록이 축약되었습니다. 원본 증거를 앱에서 확인해 주세요.</p>' : ''}</article>`).join('')}
<small>원본 로그·스크린샷·연결 비밀은 이 파일에 포함하지 않습니다. 가져온 과거 결과는 현재 요구사항의 통과 근거로 사용할 수 없습니다.</small></main></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new ServiceError('report-too-large', 'HTML 보고서 크기 한도를 넘었습니다.');
  return html;
}
