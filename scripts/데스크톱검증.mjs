// 실제 Electron 화면에서 합성 프로젝트의 등록과 승인 및 결과 조회를 검증한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { _electron } from 'playwright';
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
      timeoutMs: 5000, env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'ndjson' }],
    profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['logic-1'] }] }));
  await writeFile(join(project, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'requirement-1', title: '실제 종료 확인', description: '화면에서 승인한 명령의 종료를 확인한다.' }]));
  await writeFile(join(project, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'logic-1', title: '정상 종료', requirementId: 'requirement-1',
    commandId: 'quick', required: true, kind: 'logic', expected: '종료코드 0', codePaths: ['scripts/검사.mjs'] }]));
  service = await startLocalService(dataRoot);
  const env = { ...process.env, CHECKMATE_NODE_PATH: process.execPath, CHECKMATE_DATA_DIR: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHECKMATE_RENDERER_URL;
  app = await _electron.launch({ args: [resolve('packages/desktop')], env, timeout: 20000 });
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
  await page.getByRole('button', { name: '+ 프로젝트 추가', exact: true }).click();
  await expect(page.getByRole('heading', { name: '데스크톱 합성 검증', exact: true })).toBeVisible();
  await page.getByLabel('검사 프로필', { exact: true }).selectOption('quick');
  await page.getByRole('button', { name: '계획 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '검사 실행', exact: true })).toBeDisabled();
  await page.getByLabel('위 명령, 환경 값, 쓰기 범위를 확인했습니다.', { exact: true }).check();
  await page.getByRole('button', { name: '이 계획 승인', exact: true }).click();
  await page.getByRole('button', { name: '검사 실행', exact: true }).click();
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).toBeVisible({ timeout: 20000 });
  const history = await page.evaluate(async (id) => window.checkmate.request('history', { projectId: id }), projectId);
  assert.equal(history.ok, true);
  const runId = history.data.items[0].runId;
  const stored = await service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'result', input: { runId, section: 'summary' } }, 'human');
  assert.equal(stored.ok, true);
  assert.equal(stored.data.reusablePassed, true);
  await page.getByRole('tab', { name: '검사 결과', exact: true }).click();
  await expect(page.locator('.case-card')).toHaveCount(1);
  await page.locator('.case-card .evidence-links button').first().click();
  await page.getByRole('button', { name: '안전한 텍스트 보기', exact: true }).click();
  await expect(page.locator('.evidence-text')).not.toBeEmpty();
  assert.equal(await page.evaluate(() => globalThis.checkmateEvidenceExecuted), undefined);
  await expect(page.locator('.evidence-text')).toContainText('<script>');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('tab', { name: '요약', exact: true }).click();
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
  assert.deepEqual(errors, []);
  const report = { passed: true, runId, projectId, security, sizes, errors, scope: '실제 Electron과 로컬 SQLite 및 작업 프로세스. OS 폴더 선택 결과만 합성 경로로 고정.' };
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
