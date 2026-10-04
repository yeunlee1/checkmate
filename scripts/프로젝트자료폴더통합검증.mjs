// 실제 격리 Electron과 엔진에서 자료 이전 및 이후 실행의 출력 보존을 검증한다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';
import { startLocalService } from '../packages/engine/dist/서비스/상주서비스.js';

const root = join(resolve(process.env.CHECKMATE_TEST_ROOT ?? '.runtime/프로젝트자료통합검증'), randomUUID());
const project = join(root, '합성 프로젝트');
const output = join(root, '선택한 검사 자료');
const dataRoot = join(root, '관리 자료');
const projectId = randomUUID();
const pageErrors = [];
const report = { evidenceClass: 'synthetic-electron-engine', root, projectId, passed: false,
  osPickerStubbed: true, actualInstalledServiceUsed: false, stages: [], pageErrors };
let service;
let app;
let page;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) result.push(...await inventory(join(directory, entry.name), relativePath));
    else { const bytes = await readFile(join(directory, entry.name)); result.push({ relativePath, byteLength: bytes.length, sha256: sha(bytes) }); }
  }
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
}
async function call(method, input) {
  const response = await page.evaluate(async ({ method, input }) => window.checkmate.request(method, input), { method, input });
  assert.equal(response.ok, true, response.ok ? '' : response.error.code);
  return response.data;
}
async function runFromScreen(expectedCount) {
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('profile-select').selectOption('quick');
  await page.getByTestId('inspect-plan').click();
  await page.getByTestId('plan-consent').check();
  await page.getByTestId('approve-plan').click();
  await page.getByTestId('start-run').click();
  await expect.poll(async () => {
    const history = await call('history', { projectId });
    return history.items.filter(item => item.finalized).length;
  }, { timeout: 45000 }).toBe(expectedCount);
  const history = await call('history', { projectId });
  const runId = history.items[0].runId;
  const result = await call('result', { runId, section: 'summary' });
  assert.equal(result.reusablePassed, true);
  return { runId, result, runRoot: service.product.storage.resolveRun(runId) };
}
try {
  await mkdir(join(project, 'checkmate'), { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(project, '검사.mjs'), [
    '// 공식 출력 폴더에 합성 자료와 정상 검사 결과를 기록한다.',
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR, '관측.txt'), '합성 자료 원본');",
    "writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR, '캡처자료.bin'), Buffer.from([0, 1, 2, 3]));",
    "console.error('한글 검사 로그');",
    "console.log(JSON.stringify({ protocolVersion: 1, runId: process.env.CHECKMATE_RUN_ID, sequence: 1, type: 'case-result', time: new Date().toISOString(), payload: { testId: 'check-1', requirementId: 'req-1', status: 'passed', expected: '자료 보존', observed: '공식 위치에 기록', evidenceIds: [], severity: 'info', location: null } }));",
  ].join('\n'));
  await writeFile(join(project, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId,
    name: '자료 폴더 통합 검증', repositoryIdentity: 'synthetic:project-storage-desktop',
    commands: [{ id: 'quick', title: '합성 자료 기록', runtime: 'node', entry: '검사.mjs', args: [], env: {}, writes: [], timeoutMs: 10000, resultFormat: 'ndjson' }],
    profiles: [{ id: 'quick', title: '자료 보관 검사', checkIds: ['check-1'] }] }));
  await writeFile(join(project, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'req-1', title: '자료 보관', description: '기존 자료와 새 자료의 실제 위치를 확인한다.' }]));
  await writeFile(join(project, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'check-1', title: '합성 자료 기록', requirementId: 'req-1', commandId: 'quick', required: true, kind: 'logic', expected: '자료 보존', codePaths: ['검사.mjs'] }]));
  service = await startLocalService(dataRoot, 60000, { lockRoot: join(root, '격리 잠금') });
  const env = { ...process.env, CHECKMATE_NODE_PATH: process.execPath, CHECKMATE_DATA_DIR: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHECKMATE_RENDERER_URL;
  app = await _electron.launch({ args: [resolve('packages/desktop'), `--user-data-dir=${join(root, '격리 화면')}`], env, timeout: 20000 });
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByTestId('add-project').click();
  await expect(page.getByRole('heading', { name: '자료 폴더 통합 검증', exact: true })).toBeVisible();
  const first = await runFromScreen(1);
  const original = await inventory(first.runRoot);
  assert.ok(original.some(file => file.relativePath.startsWith('logs/')));
  assert.ok(original.some(file => file.relativePath.startsWith('results/')));
  const savedResult = JSON.parse(await readFile(join(first.runRoot, 'results', '결과.json'), 'utf8'));
  assert.equal(savedResult.runId, first.runId);
  assert.equal(savedResult.finalized, true);
  assert.equal(savedResult.verdict, 'passed');
  assert.ok(original.some(file => file.relativePath === 'artifacts/관측.txt'));
  assert.ok(original.some(file => file.relativePath === 'artifacts/캡처자료.bin'));
  report.stages.push({ name: '기본 위치 실행과 출력 구획', passed: true, runId: first.runId, files: original });

  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('storage-revision')).toHaveText('0');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, output);
  await page.getByTestId('storage-choose').click();
  await expect(page.getByTestId('storage-preview')).toBeVisible();
  await expect(page.getByTestId('storage-destination')).toContainText(output);
  await page.screenshot({ path: join(root, '이전미리보기.png'), fullPage: true });
  await page.getByTestId('storage-confirm').check();
  await page.getByTestId('storage-apply').click();
  await expect(page.getByTestId('storage-success')).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId('storage-revision')).toHaveText('1');
  const settings = await call('project-storage', { projectId });
  assert.equal(settings.configuredRoot, output);
  const movedRoot = service.product.storage.resolveRun(first.runId);
  assert.notEqual(movedRoot, first.runRoot);
  assert.deepEqual(await inventory(first.runRoot), original);
  assert.deepEqual(await inventory(movedRoot), original);
  assert.deepEqual(await call('result', { runId: first.runId, section: 'summary' }), first.result);
  report.stages.push({ name: '실제 이전과 원본 해시 및 결과 보존', passed: true, originalRoot: first.runRoot, movedRoot });
  await page.screenshot({ path: join(root, '이전완료.png'), fullPage: true });

  const second = await runFromScreen(2);
  assert.notEqual(second.runId, first.runId);
  assert.ok(second.runRoot.startsWith(join(output, 'CheckMate', projectId, settings.namespaceId)));
  const files = await inventory(second.runRoot);
  assert.ok(files.some(file => file.relativePath === 'artifacts/관측.txt'));
  assert.equal(await readFile(join(second.runRoot, 'artifacts', '관측.txt'), 'utf8'), '합성 자료 원본');
  assert.equal(await readFile(join(second.runRoot, 'logs', '명령-1-stderr.log'), 'utf8'), '한글 검사 로그\n');
  report.stages.push({ name: '변경 뒤 재계획과 새 출력 보관', passed: true, runId: second.runId, runRoot: second.runRoot, files });
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: join(root, '새검사결과.png'), fullPage: true });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  if (page) await page.screenshot({ path: join(root, '실패화면.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  try { await app?.close(); } catch (error) { report.appCloseError = String(error); report.passed = false; process.exitCode = 1; }
  try {
    const deadline = Date.now() + 30000;
    while (service?.product.active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (service?.product.active) throw new Error('합성 서비스의 작업 종료를 확인하지 못해 강제 종료하지 않았습니다.');
    await service?.close();
  } catch (error) { report.serviceCloseError = String(error); report.passed = false; process.exitCode = 1; }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '검증결과.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: join(root, '검증결과.json') }));
}
