// 독립 브라우저 컨텍스트의 실제 로컬 응답에서 역할별 합성 표식 누출을 검증한다.
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { checkRoleExposure, type ExposurePolicy } from '../packages/engine/src/어댑터/정보노출검사.js';

const privateMarker = 'SYNTHETIC_PRIVATE_MARKER_9842';
const publicMarker = 'SYNTHETIC_PUBLIC_MARKER_2271';
let server: Server;
let browser: Browser;
let baseUrl: string;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const role = request.headers['x-test-role'];
    const leaked = request.url?.includes('leak=1') ?? false;
    const content = role === 'admin' || leaked ? `${publicMarker} ${privateMarker}` : publicMarker;
    if (request.url?.startsWith('/api')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ content }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="ko"><head><title>역할 시험</title></head><body><main>${content}</main></body></html>`);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('시험 서버 포트 확인 실패');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  await browser?.close();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const policy = (role: string): ExposurePolicy => ({
  ruleId: 'role-marker', role, allowedMarkers: [publicMarker], forbiddenMarkers: role === 'admin' ? [] : [privateMarker],
  sources: ['dom', 'api'],
});

async function observe(role: string, leak: boolean) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-test-role': role } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?leak=${leak ? 1 : 0}`);
  const response = await context.request.get(`${baseUrl}/api?leak=${leak ? 1 : 0}`);
  return checkRoleExposure(page, policy(role), [{ status: response.status(), body: await response.text() }]);
}

describe('역할별 정보 노출 검사', () => {
  it('독립 컨텍스트의 허용 사례와 정상 역할 응답을 통과시킨다', async () => {
    const admin = await observe('admin', false);
    const viewer = await observe('viewer', false);
    expect(admin.status).toBe('passed');
    expect(viewer.status).toBe('passed');
    expect(viewer.findings.filter((item) => item.permission === 'forbidden').every((item) => item.count === 0)).toBe(true);
  });

  it('DOM과 API 응답 누출을 각각 찾고 원문을 결과에 남기지 않는다', async () => {
    const result = await observe('viewer', true);
    expect(result.status).toBe('failed');
    const leaks = result.findings.filter((item) => item.permission === 'forbidden' && item.count > 0);
    expect(leaks.map((item) => item.source)).toEqual(['dom', 'api']);
    expect(leaks[0]?.markerSha256).toBe(createHash('sha256').update(privateMarker).digest('hex'));
    expect(leaks[1]?.responseStatus).toBe(200);
    expect(leaks[1]?.locations[0]?.responseIndex).toBe(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateMarker);
    expect(serialized).not.toContain(publicMarker);
    expect(serialized).not.toContain('content');
  });

  it('빈 역할 또는 관측 범위는 미검증으로 처리한다', async () => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(baseUrl);
    expect((await checkRoleExposure(page, { ...policy('viewer'), role: '' }, [])).status).toBe('unverified');
    expect((await checkRoleExposure(page, { ...policy('viewer'), sources: [] }, [])).status).toBe('unverified');
    expect((await checkRoleExposure(page, policy('viewer'), [])).status).toBe('unverified');
  });
});
