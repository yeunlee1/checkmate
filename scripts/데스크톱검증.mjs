// 실제 Electron 화면에서 합성 프로젝트의 등록과 승인 및 결과 조회를 검증한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { _electron, chromium } from 'playwright';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startLocalService } from '../packages/engine/dist/서비스/상주서비스.js';

const base = resolve('.runtime/검증/데스크톱');
const root = join(base, randomUUID());
const project = join(root, '합성 프로젝트');
const dataRoot = join(root, '관리 자료');
const artifacts = resolve('.runtime/데스크톱검증');
const projectId = randomUUID();
let service;
let app;
const errors = [];
try {
  await mkdir(join(project, 'checkmate'), { recursive: true });
  await mkdir(join(project, 'scripts'));
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(project, 'scripts', '검사.mjs'), `// 실제 합성 검사와 공개 증거의 저장을 확인한다.
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
await new Promise(resolve => setTimeout(resolve, 3500));
const id = randomUUID();
const content = Buffer.from('<script>globalThis.checkmateEvidenceExecuted = true</script>합성 증거');
writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR, '증거.html'), content);
let sequence = 0;
function emit(type, payload) { console.log(JSON.stringify({ protocolVersion: 1, runId: process.env.CHECKMATE_RUN_ID, sequence: ++sequence, type, time: new Date().toISOString(), payload })); }
emit('evidence-created', { id, relativePath: '증거.html', sha256: createHash('sha256').update(content).digest('hex'), byteLength: content.length, mime: 'text/html', sensitivity: 'public' });
emit('case-result', { testId: 'logic-1', status: 'passed', requirementId: 'requirement-1', expected: '종료코드 0', observed: '정상 종료', evidenceIds: [id], severity: 'info', location: null });
`);
  await writeFile(join(project, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId,
    name: '데스크톱 합성 검증', repositoryIdentity: 'synthetic:desktop',
    commands: [{ id: 'quick', title: '합성 명령 실행', runtime: 'node', entry: 'scripts/검사.mjs', args: [],
      timeoutMs: 10000, env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'ndjson' },
      { id: 'database', title: '시험 DB 승인 안내 검증', runtime: 'node', entry: 'scripts/검사.mjs', args: [],
        timeoutMs: 10000, env: {}, writes: [], resultFormat: 'ndjson', resources: ['postgres-test'] }],
    profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['logic-1'] },
      { id: 'database', title: '시험 DB 계획', checkIds: ['database-1'] }] }));
  await writeFile(join(project, 'checkmate', '요구사항.json'), JSON.stringify([
    { id: 'requirement-1', title: '실제 종료 확인', description: '화면에서 승인한 명령의 종료를 확인한다.' },
    { id: 'requirement-database', title: '시험 DB 계획 안내', description: '영어 승인 안내만 확인하고 실행하지 않는다.' }]));
  await writeFile(join(project, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'logic-1', title: '정상 종료', requirementId: 'requirement-1',
    commandId: 'quick', required: true, kind: 'logic', expected: '종료코드 0', codePaths: ['scripts/검사.mjs'] },
    { id: 'database-1', title: '시험 DB 승인 안내', requirementId: 'requirement-database', commandId: 'database',
      required: true, kind: 'logic', expected: '승인 범위 안내', codePaths: [] }]));
  service = await startLocalService(dataRoot);
  const env = { ...process.env, CHECKMATE_NODE_PATH: process.execPath, CHECKMATE_DATA_DIR: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHECKMATE_RENDERER_URL;
  app = await _electron.launch({ args: [resolve('packages/desktop'), `--user-data-dir=${join(root, '화면 자료')}`], env, timeout: 20000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const security = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox };
  });
  assert.deepEqual(security, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  // OS 폴더 선택 결과만 고정하고 모든 등록과 실행 요청은 실제 서비스를 사용한다.
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByTestId('add-project').click();
  await expect(page.getByRole('heading', { name: '데스크톱 합성 검증', exact: true })).toBeVisible();
  const checkSetTop = await page.getByTestId('profile-select').evaluate(element => element.getBoundingClientRect().top);
  assert.ok(checkSetTop < await page.evaluate(() => window.innerHeight), '프로젝트 선택 뒤 첫 화면에서 검사 선택을 찾을 수 있어야 합니다.');
  await page.getByTestId('profile-select').selectOption('quick');
  await page.getByTestId('inspect-plan').click();
  await expect(page.getByTestId('start-run')).toBeDisabled();
  await page.screenshot({ path: join(artifacts, '검사계획.png'), fullPage: true });
  await page.getByTestId('plan-consent').check();
  await page.getByTestId('approve-plan').click();
  await page.getByTestId('start-run').click();
  await expect(page.getByTestId('active-command')).toContainText('합성 명령 실행', { timeout: 15000 });
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).not.toBeVisible();
  await page.screenshot({ path: join(artifacts, '검사진행.png'), fullPage: true });
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).toBeVisible({ timeout: 20000 });
  const history = await page.evaluate(async (id) => window.checkmate.request('history', { projectId: id }), projectId);
  assert.equal(history.ok, true);
  const runId = history.data.items[0].runId;
  const stored = await service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'result', input: { runId, section: 'summary' } }, 'human');
  assert.equal(stored.ok, true);
  assert.equal(stored.data.reusablePassed, true);
  await page.getByRole('tab', { name: '요구사항 근거', exact: true }).click();
  await expect(page.locator('.case-card').getByText('실제 종료 확인', { exact: true })).toBeVisible();
  await expect(page.locator('.case-card').getByText('통과', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '검사 결과', exact: true }).click();
  await expect(page.locator('.case-card')).toHaveCount(1);
  await page.locator('.case-card .evidence-links button').first().click();
  await page.getByRole('button', { name: '안전한 텍스트 보기', exact: true }).click();
  await expect(page.locator('.evidence-text')).not.toBeEmpty();
  assert.equal(await page.evaluate(() => globalThis.checkmateEvidenceExecuted), undefined);
  await expect(page.locator('.evidence-text')).toContainText('<script>');
  // 이전 증거를 닫지 않고 같은 계획을 다시 실행해 실행 간 자료 혼입을 확인한다.
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('start-run').click();
  await expect(page.getByTestId('active-command')).toContainText('합성 명령 실행', { timeout: 15000 });
  await expect(page.locator('.evidence-panel')).toHaveCount(0);
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.evidence-panel')).toHaveCount(0);
  await page.getByRole('tab', { name: '요약', exact: true }).click();
  const reportPath = join(root, '검증보고서.html');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, reportPath);
  await page.getByRole('button', { name: 'HTML 보고서 저장', exact: true }).click();
  await expect(page.getByText('보고서를 저장했습니다.', { exact: false })).toBeVisible();
  const html = await readFile(reportPath, 'utf8');
  assert.ok(html.includes('<meta charset="utf-8">'));
  await writeFile(join(artifacts, '결과보고서.html'), html);
  const reportBrowser = await chromium.launch({ headless: true });
  try {
    const reportPage = await reportBrowser.newPage();
    await reportPage.goto(pathToFileURL(reportPath).href);
    for (const width of [390, 1280]) {
      await reportPage.setViewportSize({ width, height: 800 });
      assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
      assert.ok((await reportPage.locator('body').innerText()).includes('요구사항 근거'));
    }
  } finally { await reportBrowser.close(); }
  // 같은 실제 실행을 영어로 다시 열고 언어 저장, 기본 대화상자와 내보내기를 확인한다.
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByTestId('nav-help').click();
  await expect(page.getByRole('heading', { name: 'Get started with CheckMate', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('language-select')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByTestId('project-select').selectOption(projectId);
  await page.getByTestId('nav-history').click();
  await page.locator('.history-list .history-open').first().click();
  await expect(page.locator('.run-panel .panel-heading').getByText('Passed', { exact: true })).toBeVisible();
  const englishReportPath = join(root, '영어보고서.html');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async (...args) => {
    globalThis.checkmateDialogTitle = args.at(-1).title;
    return { canceled: false, filePath: path };
  }; }, englishReportPath);
  await page.getByRole('button', { name: 'Save HTML report', exact: true }).click();
  await expect(page.getByText('Report saved', { exact: false })).toBeVisible();
  assert.equal(await app.evaluate(() => globalThis.checkmateDialogTitle), 'Save test report');
  const englishReport = await readFile(englishReportPath, 'utf8');
  assert.ok(englishReport.includes('<html lang="en">'));
  assert.ok(englishReport.includes('Expected behavior'));
  assert.ok(englishReport.includes('합성 증거') === false);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Pretendard' && font.status === 'loaded')), true);
  const englishViolations = (await new AxeBuilder({ page }).setLegacyMode().analyze()).violations;
  assert.equal(englishViolations.length, 0, JSON.stringify(englishViolations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))));
  await page.screenshot({ path: join(artifacts, '영어결과.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
  await page.waitForTimeout(150);
  for (const item of await page.locator('.side-nav .nav-item').all()) {
    assert.ok(await item.evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 12, '작은 창에서도 메뉴 이름을 읽을 수 있어야 합니다.');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  assert.equal((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations.length, 0);
  await page.screenshot({ path: join(artifacts, '영어결과-작은창.png'), fullPage: true });
  // DB 생성 없이 실제 계획 응답의 고정 자원 안내와 승인 경계를 영어로 확인한다.
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('profile-select').selectOption('database');
  await page.getByTestId('inspect-plan').click();
  await expect(page.getByText('Creates a new disposable PostgreSQL container', { exact: false })).toBeVisible();
  await expect(page.getByText('Allows migrations, writes, and deletion', { exact: false })).toBeVisible();
  await expect(page.getByTestId('start-run')).toBeDisabled();
  await page.getByTestId('nav-history').click();
  await page.locator('.history-list .history-open').first().click();
  await expect(page.locator('.run-panel .panel-heading').getByText('Passed', { exact: true })).toBeVisible();
  await expect(page.locator('.run-panel .recorded-profile').first()).toContainText('Current name · Recorded ID');
  await page.getByTestId('language-select').selectOption('ko');
  const sizes = [];
  for (const [width, height, zoom] of [[1280, 800, 1], [1920, 1080, 1], [1440, 960, 1.5], [1920, 1080, 2]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
      window.webContents.setZoomFactor(size.zoom);
    }, { width, height, zoom });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.equal(overflow, false, `${width}/${zoom} 화면 넘침`);
    // Electron은 새 탭 생성 API를 제공하지 않는다. 앱은 단일 프레임으로 검사한다.
    const violations = (await new AxeBuilder({ page }).setLegacyMode().analyze()).violations;
    assert.equal(violations.length, 0, JSON.stringify(violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))));
    await page.screenshot({ path: join(artifacts, `실행결과-${width}-${zoom}.png`), fullPage: true });
    sizes.push({ width, height, zoom, overflow, violations: violations.length });
  }
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 960); window.webContents.setZoomFactor(1); });
  await page.getByTestId('nav-help').click();
  await expect(page.getByRole('heading', { name: '체크메이트 시작하기', exact: true })).toBeVisible();
  await page.getByText('실행이 중단되거나 정리가 확인되지 않을 때', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('과거 판정은 그대로 보존됩니다.', { exact: false })).toBeVisible();
  assert.equal((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  await page.screenshot({ path: join(artifacts, '도움말.png'), fullPage: true });
  await page.getByTestId('nav-settings').click();
  await page.getByRole('button', { name: '현재 자료 백업', exact: true }).click();
  await page.getByText('백업 지문', { exact: true }).click();
  await expect(page.getByRole('button', { name: '백업 지문 복사', exact: true })).toBeVisible({ timeout: 30000 });
  const restoreRoot = join(root, '복구 자료');
  await mkdir(restoreRoot);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, restoreRoot);
  await page.getByRole('button', { name: '복구할 빈 폴더 선택', exact: true }).click();
  await page.getByLabel('선택한 백업을 새 빈 폴더에 복구하겠습니다.', { exact: true }).check();
  await page.getByRole('button', { name: '새 폴더로 복구', exact: true }).click();
  await expect(page.getByText('복구한 자료 위치', { exact: false })).toBeVisible({ timeout: 30000 });
  const restored = await startLocalService(restoreRoot);
  try { assert.equal(restored.product.runs.getRun(runId)?.verdict, 'passed'); } finally { await restored.close(); }
  await page.getByTestId('nav-history').click();
  const importedPath = join(root, '과거보고서.json');
  await writeFile(importedPath, JSON.stringify({ mode: 'quick', status: 'passed', source: { fingerprint: 'a'.repeat(64) },
    sourceAfter: { fingerprint: 'a'.repeat(64) }, steps: [{ id: 'types', status: 'passed', exitCode: 0 }], omitted: [] }));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, importedPath);
  await page.getByRole('button', { name: '과거 보고서 가져오기', exact: true }).click();
  await expect(page.getByRole('tab', { name: '가져온 원래 기록', exact: true })).toBeVisible();
  await expect(page.locator('.run-panel .panel-heading').getByText('미확인', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '가져온 원래 기록', exact: true }).click();
  await expect(page.locator('.evidence-text')).toContainText('"reportedStatus": "passed"');
  await page.getByTestId('nav-projects').click();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, resolve('examples/대표검증'));
  await page.getByTestId('add-project').click();
  await page.getByTestId('profile-select').selectOption('defect');
  await page.getByTestId('inspect-plan').click();
  await page.getByTestId('plan-consent').check();
  await page.getByTestId('approve-plan').click();
  await page.getByTestId('start-run').click();
  await expect(page.locator('.run-panel .panel-heading').getByText('실패', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('tab', { name: '검사 결과', exact: true }).click();
  const designCase = page.locator('.case-card').filter({ has: page.getByText('defect-design', { exact: true }) });
  await designCase.locator('.evidence-links button').first().click();
  await page.getByRole('button', { name: '안전한 텍스트 보기', exact: true }).click();
  await page.getByRole('button', { name: '캡처에서 위반 위치 보기', exact: true }).click();
  await expect(page.getByRole('img', { name: '검사 당시 화면 캡처', exact: true })).toBeVisible();
  await expect(page.locator('.visual-evidence__box')).toBeVisible();
  assert.equal(await page.getByRole('img', { name: '검사 당시 화면 캡처' }).evaluate(image => image.complete && image.naturalWidth === 400), true);
  for (const zoom of [1, 2]) {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value), zoom);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
    assert.equal((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations.length, 0);
    await page.screenshot({ path: join(artifacts, `위반위치-${zoom}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, runId, projectId, security, sizes, errors, reportExport: true, backupRestore: true, importedHistory: true, designOverlay: true,
    liveProgress: true, englishInterface: true, languagePersistence: true, englishReport: true, bundledFont: true,
    runEvidenceIsolation: true, compactNavigationLabels: true, englishResourceApproval: true,
    scope: '실제 Electron과 로컬 SQLite 및 작업 프로세스. OS 파일 선택 결과만 합성 경로로 고정.' };
  await writeFile(join(artifacts, '결과.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: join(artifacts, '실패화면.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(-7000));
  }
  throw error;
} finally {
  if (app) await app.close();
  if (service) await service.close();
  const child = relative(base, root);
  assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
  await rm(root, { recursive: true, force: true });
}
