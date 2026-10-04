// 격리된 설치본 두 버전에서 살아 있는 MCP 파이프와 기존 검사 이력의 자동 재연결을 검증한다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureManagedConnection } from '../packages/desktop/dist/main/설치연결.js';
import { waitForManagedIdle } from '../packages/desktop/dist/main/업데이트준비.js';
import { installationIdle } from '../packages/desktop/dist/main/업데이트.js';
import { acquireUpdateLock } from '../packages/engine/dist/연결/업데이트잠금.js';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Windows 제작 보고서 경로가 필요합니다.');
const built = JSON.parse(await readFile(process.argv[2], 'utf8')); assert.equal(built.status, 'passed');
const root = resolve('.runtime/검증/관리형연결', randomUUID());
const install = join(root, '한글 설치');
const dataRoots = [join(root, '관리 자료 하나'), join(root, '관리 자료 둘')];
const execute = promisify(execFile);
const env = { ...process.env, CHECKMATE_LOCK_DIR: join(root, '공유잠금') };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'CHECKMATE_DATA_DIR']) delete env[key];
const report = { passed: false, root, install, dataRoots, phases: [], runtimeBuildCommit: built.source.commit };
const clients = [];
let release;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(predicate, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error('격리 연결 대기 시간 초과'); await pause(300); }
}
const locations = version => ({ node: join(install, `app-${version}`, 'resources/node/node.exe'),
  cli: join(install, `app-${version}`, 'resources/engine/packages/engine/dist/명령.js') });
async function command(version, dataRoot, ...args) {
  const paths = locations(version);
  const response = await execute(paths.node, [paths.cli, '--data-dir', dataRoot, '--json', ...args], { env, windowsHide: true, timeout: 40000 });
  const parsed = JSON.parse(response.stdout); assert.equal(parsed.ok, true); return parsed.data;
}
async function tool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse(response.content[0].text);
}
try {
  await mkdir(install, { recursive: true });
  // 외부 설치 프로그램을 실행하지 않는 경로 판별용 합성 표식이다.
  await writeFile(join(install, 'Update.exe'), 'synthetic-managed-installation');
  for (const version of ['1.0.0', '1.0.1']) {
    const resources = join(install, `app-${version}`, 'resources'); await mkdir(resources, { recursive: true });
    for (const name of ['engine', 'node']) await cp(join(built.packagePath, 'resources', name), join(resources, name), { recursive: true, force: false, errorOnExist: true });
    for (const location of ['packages/engine', 'node_modules/@checkmate/engine']) {
      const path = join(resources, 'engine', location, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.version = version;
      await writeFile(path, JSON.stringify(manifest, null, 2));
    }
  }
  for (const dataRoot of dataRoots) {
    await command('1.0.0', dataRoot, 'setup', '--accept-local-storage');
    const paths = locations('1.0.0');
    const connection = await ensureManagedConnection(dataRoot, paths.node, paths.cli, '1.0.0');
    assert.ok(!connection.command.toLowerCase().startsWith(install.toLowerCase()));
    const client = new Client({ name: 'checkmate-managed-fixture', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...connection, env, stderr: 'pipe' });
    clients.push({ client, transport, dataRoot });
    await client.connect(transport);
    const capabilities = await tool(client, 'get_capabilities');
    assert.equal(capabilities.ok, true); assert.equal(capabilities.data.version, '1.0.0');
    assert.equal(capabilities.data.connection.dataRoot, dataRoot);
  }
  report.pipePidsBefore = clients.map(entry => entry.transport.pid);
  assert.ok(report.pipePidsBefore.every(Number.isSafeInteger)); report.phases.push('two-managed-roots-connected');
  const project = join(root, '합성 프로젝트'); const projectId = randomUUID();
  await mkdir(join(project, 'checkmate'), { recursive: true }); await mkdir(join(project, 'tests'));
  await writeFile(join(project, 'tests/check.mjs'), '// 합성 명령의 정상 종료를 확인한다.\nprocess.exit(0);\n');
  await writeFile(join(project, 'checkmate/프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: '관리 연결 보존', repositoryIdentity: 'synthetic:managed',
    commands: [{ id: 'quick', title: '합성 종료', runtime: 'node', entry: 'tests/check.mjs', args: [], env: {}, writes: [], timeoutMs: 5000, resultFormat: 'exit-code' }],
    profiles: [{ id: 'quick', title: '합성 검사', checkIds: ['check-1'] }] }));
  await writeFile(join(project, 'checkmate/요구사항.json'), JSON.stringify([{ id: 'req-1', title: '기록 보존', description: '버전 변경 뒤에도 기존 실행을 보존한다.' }]));
  await writeFile(join(project, 'checkmate/검사항목.json'), JSON.stringify([{ id: 'check-1', title: '종료', requirementId: 'req-1', commandId: 'quick', required: true, kind: 'logic', expected: '종료 0', codePaths: ['tests/check.mjs'] }]));
  await command('1.0.0', dataRoots[0], 'register', project, '--trust');
  const plan = await command('1.0.0', dataRoots[0], 'inspect', '--project', projectId, '--profile', 'quick');
  await command('1.0.0', dataRoots[0], 'approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm');
  const startArgs = { projectId, planId: plan.planId, requestId: randomUUID() };
  const accepted = await tool(clients[0].client, 'start_run', startArgs); assert.equal(accepted.ok, true);
  const runId = accepted.data.runId;
  await waitFor(async () => (await tool(clients[0].client, 'get_run_status', { runId })).data.finalized === true);
  report.before = await tool(clients[0].client, 'get_run_result', { runId, section: 'summary' });
  assert.equal(report.before.ok, true); assert.equal(report.before.data.cleanupVerified, true);
  release = await acquireUpdateLock(install);
  for (const entry of clients) assert.equal((await tool(entry.client, 'get_capabilities')).error.code, 'update-in-progress');
  assert.equal(await waitForManagedIdle(install), true); report.phases.push('all-roots-drained-with-pipes-alive');
  await release(); release = undefined;
  const next = locations('1.0.1');
  for (const dataRoot of dataRoots) await ensureManagedConnection(dataRoot, next.node, next.cli, '1.0.1');
  for (const entry of clients) {
    const response = await tool(entry.client, 'get_capabilities');
    assert.equal(response.ok, true); assert.equal(response.data.version, '1.0.1');
    assert.equal(response.data.connection.dataRoot, entry.dataRoot);
  }
  report.pipePidsAfter = clients.map(entry => entry.transport.pid);
  assert.deepEqual(report.pipePidsAfter, report.pipePidsBefore); report.phases.push('same-stdio-pipes-new-backend');
  report.after = await tool(clients[0].client, 'get_run_result', { runId, section: 'summary' });
  assert.deepEqual(report.after.data, report.before.data);
  const duplicate = await tool(clients[0].client, 'start_run', startArgs);
  assert.equal(duplicate.ok, false); assert.equal(duplicate.error.code, 'run-owner-mismatch');
  const cancel = await tool(clients[0].client, 'cancel_run', { runId });
  assert.equal(cancel.ok, false); assert.equal(cancel.error.code, 'run-owner-mismatch');
  const history = await command('1.0.1', dataRoots[0], 'history', '--project', projectId);
  assert.equal(history.nextCursor, null); assert.equal(history.items.length, 1); assert.equal(history.items[0].runId, runId);
  report.phases.push('history-preserved-no-old-control-or-replay'); report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await release?.();
  for (const entry of clients.reverse()) await entry.client.close();
  try {
    await waitFor(async () => {
      try { return await installationIdle(install); }
      catch { report.cleanupObservationDeferrals = (report.cleanupObservationDeferrals ?? 0) + 1; return false; }
    }, 90000);
    report.cleanupVerified = true;
  }
  catch (error) { report.cleanupVerified = false; report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, '검증결과.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, cleanupVerified: report.cleanupVerified, phases: report.phases, report: join(root, '검증결과.json'), error: report.error ?? report.cleanupError ?? null }));
}
