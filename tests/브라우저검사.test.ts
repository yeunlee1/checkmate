// 실제 Chromium에서 디자인 규칙과 접근성 위반의 위치 판정을 확인한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { checkAccessibility, checkBrowserDesign } from '../packages/engine/src/어댑터/브라우저검사.js';

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 400, height: 300 } });
  page = await context.newPage();
});
afterAll(async () => { await context?.close(); await browser?.close(); });

describe('브라우저 디자인 검사', () => {
  it('정상 화면과 빈 정책을 구분한다', async () => {
    await page.setContent('<!doctype html><html lang="ko"><head><title>정상</title><style>#card{color:rgb(0, 0, 0)}</style></head><body><main><h1 id="card">정상</h1></main></body></html>');
    const result = await checkBrowserDesign(page, [{ id: 'color', selector: '#card', visible: true,
      allowedStyles: { color: ['rgb(0, 0, 0)'] }, fitViewport: true }]);
    expect(result.status).toBe('passed');
    expect(result.findings[0]?.boundingBox).not.toBeNull();
    expect(result.findings[0]?.viewport).toEqual({ width: 400, height: 300 });
    expect((await checkBrowserDesign(page, [])).status).toBe('unverified');
  });

  it('색상, 화면 넘침, 누락 및 중복 선택자를 잡는다', async () => {
    await page.setContent('<!doctype html><html lang="ko"><head><title>위반</title><style>#wide{position:absolute;left:390px;width:80px;color:red}</style></head><body><div id="wide">위반</div><p class="copy">가</p><p class="copy">나</p></body></html>');
    const result = await checkBrowserDesign(page, [
      { id: 'color', selector: '#wide', allowedStyles: { color: ['rgb(0, 0, 0)'] } },
      { id: 'overflow', selector: '#wide', fitViewport: true },
      { id: 'missing', selector: '#absent' },
      { id: 'duplicate', selector: '.copy' },
    ]);
    expect(result.status).toBe('failed');
    expect(result.findings.map((item) => item.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(result.findings[1]?.observed.overflowsViewport).toBe(true);
    expect(result.findings[2]?.observed.count).toBe(0);
    expect(result.findings[3]?.observed.count).toBe(2);
  });
});

describe('접근성 검사', () => {
  it('이미지 대체 문구 누락을 규칙과 좌표로 보고한다', async () => {
    await page.setContent('<!doctype html><html lang="ko"><head><title>위반</title></head><body><main><h1>제목</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></main></body></html>');
    const result = await checkAccessibility(page);
    expect(result.status, result.reason ?? '').toBe('failed');
    const image = result.violations.find((item) => item.ruleId === 'image-alt');
    expect(image?.target).toContain('img');
    expect(image?.boundingBox).not.toBeNull();
  });

  it('정상 문서에서는 위반을 반환하지 않는다', async () => {
    await page.setContent('<!doctype html><html lang="ko"><head><title>정상</title></head><body><main><h1>제목</h1><p>설명</p></main></body></html>');
    const result = await checkAccessibility(page);
    expect(result.violations).toEqual([]);
    expect(result.status, result.reason ?? '').toBe('passed');
  });
});
