// 공백과 한글 경로의 실제 포장 앱과 동봉 Node로 첫 실행과 검사 및 이력 보존을 확인한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Windows 포장 앱 폴더를 지정해 주세요.');
if (process.argv[3] && process.argv[3] !== '--installed') throw new Error('지원하지 않는 검증 옵션입니다.');
const installed = process.argv[3] === '--installed';
const root = resolve('.runtime/검증/포장앱', randomUUID());
const appPath = installed ? resolve(process.argv[2]) : join(root, '한글 앱');
const dataRoot = installed ? join(process.env.LOCALAPPDATA, 'CheckMateData') : join(root, '관리 자료');
const project = join(root, '합성 프로젝트');
const projectId = randomUUID();
const execute = promisify(execFile);
const env = { ...process.env, CHECKMATE_DATA_DIR: dataRoot, PATH: join(process.env.SystemRoot, 'System32') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CHECKMATE_NODE_PATH', 'CHECKMATE_RENDERER_URL', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
if (installed) {
  delete env.CHECKMATE_DATA_DIR;
  const child = relative(join(process.env.LOCALAPPDATA, 'CheckMate'), appPath);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error('사용자 CheckMate 설치 폴더 아래 앱 버전을 지정해 주세요.');
  await lstat(dataRoot).then(() => { throw new Error('기존 사용자 자료가 있으므로 첫 설치 시험을 실행하지 않습니다.'); }, error => {
    if (error.code !== 'ENOENT') throw error;
  });
}
let app;
let runId;
const report = { passed: false, root, appPath, dataRoot, installed, systemNodeOnPath: false };
try {
  await mkdir(root, { recursive: true });
  if (!installed) await cp(resolve(process.argv[2]), appPath, { recursive: true, errorOnExist: true, force: false });
  const node = join(appPath, 'resources', 'node', 'node.exe');
  const cli = join(appPath, 'resources', 'engine', 'packages', 'engine', 'dist', '명령.js');
  const command = async (...args) => {
    const output = await execute(node, [cli, '--data-dir', dataRoot, '--json', ...args], { env, windowsHide: true, timeout: 40000 });
    const parsed = JSON.parse(output.stdout); assert.equal(parsed.ok, true); return parsed.data;
  };
  report.doctor = await command('doctor');
  assert.equal(report.doctor.node, '24.18.0');
  await mkdir(join(project, 'checkmate'), { recursive: true });
  await mkdir(join(project, 'tests'));
  const caseResult = { testId: 'check-1', requirementId: 'req-1', status: 'passed', expected: '동봉 Node에서 종료', observed: '동봉 Node 실행 성공', evidenceIds: [], severity: 'info', location: null };
  await writeFile(join(project, 'tests', '검사.mjs'), `// 동봉 Node의 실제 명령 실행을 확인한다.\nconsole.log(JSON.stringify({protocolVersion:1,runId:process.env.CHECKMATE_RUN_ID,sequence:1,type:'case-result',time:new Date().toISOString(),payload:${JSON.stringify(caseResult)}}));\n`);
  await writeFile(join(project, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: '포장 앱 합성 검증', repositoryIdentity: 'synthetic:packaged', commands: [{ id: 'quick', title: '동봉 Node 실행', runtime: 'node', entry: 'tests/검사.mjs', args: [], env: {}, writes: [], timeoutMs: 5000, resultFormat: 'ndjson' }], profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1'] }] }));
  await writeFile(join(project, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'req-1', title: '설치 실행 확인', description: '별도 Node 설치 없이 실행한다.' }]));
  await writeFile(join(project, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'check-1', title: '실제 명령 종료', requirementId: 'req-1', commandId: 'quick', required: true, kind: 'logic', expected: '동봉 Node에서 종료', codePaths: ['tests/검사.mjs'] }]));
  const launch = async () => {
    app = await _electron.launch({ executablePath: join(appPath, 'CheckMate.exe'), args: [`--user-data-dir=${join(root, '화면 자료')}`], env, timeout: 30000 });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); return page;
  };
  let page = await launch();
  const renderedFonts = async () => {
    await page.evaluate(() => document.fonts.ready);
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('DOM.enable');
      await session.send('CSS.enable');
      const { root: documentNode } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.run-panel h2' });
      assert.ok(nodeId, '결과 제목을 찾을 수 있어야 합니다.');
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      const used = fonts.filter(font => font.glyphCount > 0);
      assert.ok(used.length > 0 && used.every(font => font.isCustomFont && font.familyName.startsWith('Pretendard')), '결과 제목이 실제 동봉 글꼴로 그려져야 합니다.');
      return used;
    } finally { await session.detach(); }
  };
  assert.equal((await page.evaluate(() => window.checkmate.connectionInfo())).dataPath, dataRoot);
  await execute(join(appPath, 'CheckMate.exe'), [`--user-data-dir=${join(root, '화면 자료')}`], { env, windowsHide: true, timeout: 15000 });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  report.singleInstance = true;
  await page.getByRole('button', { name: '로컬 저장소 준비', exact: true }).click();
  await expect(page.getByTestId('add-project')).toBeEnabled({ timeout: 30000 });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
  await page.getByTestId('add-project').click();
  await page.getByTestId('profile-select').selectOption('quick');
  await page.getByTestId('inspect-plan').click();
  await expect(page.getByTestId('start-run')).toBeDisabled();
  await page.getByTestId('plan-consent').check();
  await page.getByTestId('approve-plan').click();
  await page.getByTestId('start-run').click();
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).toBeVisible({ timeout: 30000 });
  const history = await command('history', '--project', projectId);
  runId = history.items[0].runId;
  report.result = await command('result', runId);
  assert.equal(report.result.reusablePassed, true);
  report.connection = await page.evaluate(() => window.checkmate.connectionInfo());
  assert.equal(report.connection.mcpCommand.command, node);
  report.renderedFonts = { ko: await renderedFonts() };
  await page.screenshot({ path: join(root, '포장앱.png'), fullPage: true });
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.run-panel .panel-heading').getByText('Passed', { exact: true })).toBeVisible();
  report.renderedFonts.en = await renderedFonts();
  report.fontLoaded = true;
  await page.screenshot({ path: join(root, '포장앱-영어.png'), fullPage: true });
  await app.close(); app = undefined;
  console.log(JSON.stringify({ phase: '첫 실행 완료', runId, root }));
  page = await launch();
  await expect(page.getByTestId('language-select')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByTestId('project-select').selectOption(projectId);
  await expect(page.getByRole('heading', { name: '포장 앱 합성 검증', exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByTestId('nav-history').click();
  await page.locator('.history-list .history-open').first().click();
  await expect(page.locator('.run-panel .panel-heading').getByText('Passed', { exact: true })).toBeVisible();
  assert.equal((await command('result', runId)).reusablePassed, true);
  await page.getByTestId('language-select').selectOption('ko');
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).toBeVisible();
  report.languagePersisted = true;
  report.restarted = true;
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (app) {
    const page = await app.firstWindow();
    report.screen = (await page.locator('body').innerText()).slice(-6000);
    await page.screenshot({ path: join(root, '실패화면.png'), fullPage: true });
  }
  throw error;
} finally {
  if (app) await app.close();
  await writeFile(join(root, '검증결과.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, runId, report: join(root, '검증결과.json') }));
}
