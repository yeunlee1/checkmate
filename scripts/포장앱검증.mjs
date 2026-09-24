// 공백과 한글 경로의 실제 포장 앱과 동봉 Node로 첫 실행과 검사 및 이력 보존을 확인한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Windows 포장 앱 폴더를 지정해 주세요.');
const root = resolve('.runtime/검증/포장앱', randomUUID());
const appPath = join(root, '한글 앱');
const dataRoot = join(root, '관리 자료');
const project = join(root, '합성 프로젝트');
const projectId = randomUUID();
const execute = promisify(execFile);
const env = { ...process.env, CHECKMATE_DATA_DIR: dataRoot, PATH: join(process.env.SystemRoot, 'System32') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CHECKMATE_NODE_PATH', 'CHECKMATE_RENDERER_URL', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
let app;
let runId;
const report = { passed: false, root, systemNodeOnPath: false };
try {
  await mkdir(root, { recursive: true });
  await cp(resolve(process.argv[2]), appPath, { recursive: true, errorOnExist: true, force: false });
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
  await page.getByRole('button', { name: '로컬 저장소 준비', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ 프로젝트 추가', exact: true })).toBeEnabled({ timeout: 30000 });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
  await page.getByRole('button', { name: '+ 프로젝트 추가', exact: true }).click();
  await page.getByLabel('검사 프로필', { exact: true }).selectOption('quick');
  await page.getByRole('button', { name: '계획 확인', exact: true }).click();
  await page.getByLabel('위 명령, 환경 값, 쓰기 범위를 확인했습니다.', { exact: true }).check();
  await page.getByRole('button', { name: '이 계획 승인', exact: true }).click();
  await page.getByRole('button', { name: '검사 실행', exact: true }).click();
  await expect(page.locator('.run-panel .panel-heading').getByText('통과', { exact: true })).toBeVisible({ timeout: 30000 });
  const history = await command('history', '--project', projectId);
  runId = history.items[0].runId;
  report.result = await command('result', runId);
  assert.equal(report.result.reusablePassed, true);
  report.connection = await page.evaluate(() => window.checkmate.connectionInfo());
  assert.equal(report.connection.mcpCommand.command, node);
  await page.screenshot({ path: join(root, '포장앱.png'), fullPage: true });
  await app.close(); app = undefined;
  page = await launch();
  await page.getByRole('button').filter({ has: page.getByText('포장 앱 합성 검증', { exact: true }) }).click();
  await expect(page.getByRole('heading', { name: '포장 앱 합성 검증', exact: true })).toBeVisible({ timeout: 30000 });
  assert.equal((await command('result', runId)).reusablePassed, true);
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
