// 합성 표식으로 역할별 DOM과 명시적 API 응답의 정보 노출을 검사한다.
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { CheckStatus } from './브라우저검사.js';

export type ExposurePolicy = {
  ruleId: string;
  role: string;
  allowedMarkers: readonly string[];
  forbiddenMarkers: readonly string[];
  sources: readonly ('dom' | 'api')[];
};
export type ObservedApiResponse = { status: number; body: string };
export type ExposureLocation = { source: 'dom' | 'api'; responseIndex: number | null; offset: number };
export type ExposureFinding = {
  ruleId: string;
  role: string;
  permission: 'allowed' | 'forbidden';
  source: 'dom' | 'api';
  responseStatus: number | null;
  markerSha256: string;
  count: number;
  locations: ExposureLocation[];
};
export type ExposureResult = { status: CheckStatus; findings: ExposureFinding[]; reason: string | null };

function offsets(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const position = haystack.indexOf(needle, from);
    if (position < 0) return positions;
    positions.push(position);
    from = position + needle.length;
  }
}

export async function checkRoleExposure(
  page: Page,
  policy: ExposurePolicy,
  responses: readonly ObservedApiResponse[],
): Promise<ExposureResult> {
  if (!policy.ruleId || !policy.role || policy.sources.length === 0
    || (policy.allowedMarkers.length === 0 && policy.forbiddenMarkers.length === 0)
    || [...policy.allowedMarkers, ...policy.forbiddenMarkers].some((marker) => marker.length === 0)) {
    return { status: 'unverified', findings: [], reason: '역할, 관측 범위 또는 합성 표식 정책 누락' };
  }
  if (policy.sources.includes('api') && responses.length === 0) {
    return { status: 'unverified', findings: [], reason: 'API 응답 관측 누락' };
  }
  try {
    const dom = policy.sources.includes('dom')
      ? await page.evaluate(() => document.documentElement.outerHTML) : null;
    const findings: ExposureFinding[] = [];
    for (const [permission, markers] of [
      ['allowed', policy.allowedMarkers], ['forbidden', policy.forbiddenMarkers],
    ] as const) {
      for (const marker of markers) {
        const markerSha256 = createHash('sha256').update(marker).digest('hex');
        if (dom !== null) {
          const positions = offsets(dom, marker);
          findings.push({ ruleId: policy.ruleId, role: policy.role, permission, source: 'dom',
            responseStatus: null, markerSha256, count: positions.length,
            locations: positions.map((offset) => ({ source: 'dom', responseIndex: null, offset })) });
        }
        if (policy.sources.includes('api')) {
          responses.forEach((response, responseIndex) => {
            const positions = offsets(response.body, marker);
            findings.push({ ruleId: policy.ruleId, role: policy.role, permission, source: 'api',
              responseStatus: response.status, markerSha256, count: positions.length,
              locations: positions.map((offset) => ({ source: 'api', responseIndex, offset })) });
          });
        }
      }
    }
    return { status: findings.some((item) => item.permission === 'forbidden' && item.count > 0)
      ? 'failed' : 'passed', findings, reason: null };
  } catch {
    return { status: 'unverified', findings: [], reason: 'DOM 관측 실패' };
  }
}
