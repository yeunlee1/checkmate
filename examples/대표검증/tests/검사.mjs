// 등록된 두 합성 프로필을 실제 브라우저로 실행하고 구조화된 결과를 남긴다.
import { chromium } from 'playwright';
import { createReporter } from '@checkmate/engine/reporter';
import { checkBrowserDesign, checkAccessibility } from '@checkmate/engine/browser';
import { checkRoleExposure } from '@checkmate/engine/exposure';
import { createFixtureApp } from '../가상앱.mjs';

const mode = process.argv[2];
if (mode !== 'normal' && mode !== 'defect') throw new Error('normal 또는 defect 프로필이 필요합니다.');
const reporter = createReporter();
const server = createFixtureApp(mode);
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('localhost 포트 배정 실패');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
  const page = await context.newPage();
  await page.goto(base);
  const prefix = mode === 'normal' ? 'normal' : 'defect';
  const result = (kind, status, expected, observed, evidenceIds = [], location = null) =>
    reporter.caseResult({ testId: `${prefix}-${kind}`, status, requirementId: `req-${prefix}-${kind}`,
      expected, observed, evidenceIds, severity: status === 'passed' ? 'info' : 'error', location });

  await page.locator('#item').fill('합성 주문');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#saved')?.textContent?.length > 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#saved')?.textContent?.length > 0);
  const saved = await page.locator('#saved').textContent();
  const workflowEvidence = await reporter.evidence({ relativePath: '저장재조회.json',
    content: JSON.stringify({ input: '합성 주문', reloaded: saved }), mime: 'application/json' });
  result('workflow', saved === '합성 주문' ? 'passed' : 'failed', '저장 후 재조회 값은 합성 주문',
    `재조회 값 ${saved}`, [workflowEvidence.id], saved === '합성 주문' ? null : { file: '가상앱.mjs', line: 21 });

  if (process.env.CHECKMATE_TEST_OBSERVATION_FAILURE === '1') {
    await page.evaluate(() => {
      Object.defineProperty(Element.prototype, 'outerHTML', { configurable: true,
        get() { throw new Error('합성 DOM 관측 실패'); } });
      Object.defineProperty(window, 'innerWidth', { configurable: true,
        get() { throw new Error('합성 화면 관측 실패'); } });
    });
  }

  const roleResponse = await page.request.get(`${base}/api/role`);
  const roleBody = await roleResponse.text();
  const exposure = await checkRoleExposure(page, { ruleId: 'viewer-marker', role: 'viewer',
    allowedMarkers: ['SYNTHETIC_VIEWER_ONLY'], forbiddenMarkers: ['SYNTHETIC_ADMIN_ONLY'],
    sources: ['dom', 'api'] }, [{ status: roleResponse.status(), body: roleBody }]);
  const exposureEvidence = await reporter.evidence({ relativePath: '역할노출.json',
    content: JSON.stringify(exposure), mime: 'application/json' });
  result('exposure', exposure.status === 'unverified' ? 'unknown' : exposure.status, 'viewer 응답에 관리자 표식 없음',
    `상태 ${exposure.status}, 금지 표식 위치 ${exposure.findings.filter(f=>f.permission==='forbidden'&&f.count>0).map(f=>`${f.source}:${f.locations.map(p=>p.offset).join(',')}`).join(';') || '없음'}`,
    [exposureEvidence.id], exposure.status === 'failed' ? { file: '가상앱.mjs', line: 27 } : null);

  const design = await checkBrowserDesign(page, [{ id: 'decor-in-viewport', selector: '#decor',
    visible: true, fitViewport: true }]);
  const screenshot = await reporter.evidence({ relativePath: '화면.png', content: await page.screenshot(),
    mime: 'image/png', sensitivity: 'public', synthetic: true });
  const designEvidence = await reporter.evidence({ relativePath: '디자인위치.json',
    content: JSON.stringify({ kind: 'checkmate-design', schemaVersion: 1,
      screenshotEvidenceId: screenshot.id, viewport: design.findings[0]?.viewport ?? null,
      status: design.status, findings: design.findings }),
    mime: 'application/json', sensitivity: 'public', synthetic: true });
  result('design', design.status === 'unverified' ? 'unknown' : design.status, '합성 표시가 400x300 화면 안에 있음',
    `상태 ${design.status}, 위치 ${JSON.stringify(design.findings[0]?.boundingBox)}, 화면 ${JSON.stringify(design.findings[0]?.viewport)}`,
    [designEvidence.id, screenshot.id], design.status === 'failed' ? { file: '가상앱.mjs', line: 39 } : null);

  const accessibility = await checkAccessibility(page);
  const accessibilityEvidence = await reporter.evidence({ relativePath: '접근성.json',
    content: JSON.stringify(accessibility), mime: 'application/json' });
  result('accessibility', accessibility.status === 'passed' ? 'passed' : accessibility.status === 'failed' ? 'failed' : 'unknown',
    '자동 접근성 위반 없음', `상태 ${accessibility.status}, 위반 ${accessibility.violations.map(v=>v.ruleId).join(',') || '없음'}`,
    [accessibilityEvidence.id], accessibility.status === 'passed' ? null : { file: '가상앱.mjs', line: 35 });

  const totalResponse = await page.request.get(`${base}/api/total`);
  const total = (await totalResponse.json()).total;
  const detectionEvidence = await reporter.evidence({ relativePath: '계산결함.json',
    content: JSON.stringify({ expected: 12, actual: total, method: '명시적 합성 fixture 비교', stryker: false }),
    mime: 'application/json' });
  result('detection', total === 12 ? 'passed' : 'failed', '합성 계산 값은 12',
    `실제 값 ${total}, 수동 fixture 비교이며 Stryker 변이 점수 아님`, [detectionEvidence.id],
    total === 12 ? null : { file: '가상앱.mjs', line: 31 });
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
