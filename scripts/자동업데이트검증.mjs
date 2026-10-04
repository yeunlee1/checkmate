// 별도 Squirrel 합성 설치본으로 실제 다운로드와 실패 복구 및 버전 간 자료 보존을 검증한다.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { cp, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createWindowsInstaller } from 'electron-winstaller';
import { installationIdle } from '../packages/desktop/dist/main/업데이트.js';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Windows 제작 보고서 경로가 필요합니다.');
const built = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(built.status, 'passed');
const root = resolve('.runtime', `update-${randomUUID()}`);
const identity = `CheckMateFixture${randomUUID().replaceAll('-', '')}`;
const install = join(root, identity);
const dataRoot = join(root, '합성 자료');
const dbPath = join(dataRoot, 'state/checkmate.sqlite');
const commandFile = join(root, '명령.json');
const statusFile = join(root, '상태.json');
const env = { ...process.env, CHECKMATE_DATA_DIR: dataRoot };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CHECKMATE_RENDERER_URL', 'CHECKMATE_SIGN_THUMBPRINT']) delete env[key];
const execute = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
const report = { passed: false, root, identity, dataRoot, runtimeBuildCommit: built.source.commit,
  sourceCommit: (await execute('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(),
  sourceDirty: (await execute('git', ['status', '--porcelain'], { windowsHide: true })).stdout.trim().length > 0,
  phases: [] };
const requests = [];
let feedFolder;
let corrupt = true;
let releasePackage;
let packageWaiting = false;
let appChild;
let nodeChild;
let lastCommand = 0;
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1);
    if (name !== 'RELEASES' && !/^[A-Za-z0-9_.-]+-full\.nupkg$/.test(name)) { res.writeHead(404).end(); return; }
    requests.push(name);
    if (!corrupt && name.endsWith('.nupkg')) { packageWaiting = true; await new Promise(done => { releasePackage = done; }); }
    const bytes = corrupt && name.endsWith('.nupkg') ? Buffer.from('손상된 합성 패키지') : await readFile(join(feedFolder, name));
    res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  } catch { res.writeHead(500).end(); }
});
await mkdir(root, { recursive: true });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const feed = `http://127.0.0.1:${server.address().port}`;
async function waitFor(predicate, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const failure = await readFile(join(root, '앱오류.txt'), 'utf8').catch(() => null);
    if (failure) throw new Error(failure);
    if (await predicate()) return; await pause(200);
  }
  throw new Error(`대기 시간 초과. 마지막 상태 ${await readFile(statusFile, 'utf8').catch(() => '없음')}`);
}
async function state() { try { return JSON.parse(await readFile(statusFile, 'utf8')); } catch { return {}; } }
async function action(action, wanted, timeout) {
  const id = ++lastCommand;
  await writeFile(commandFile, JSON.stringify({ id, action }));
  await waitFor(async () => { const value = await state(); return value.command === id && value.state === wanted; }, timeout);
  return state();
}
async function cli(version, ...args) {
  const result = await execute(join(install, `app-${version}`, 'resources/node/node.exe'), [resolve('packages/engine/dist/명령.js'), '--data-dir', dataRoot, '--json', ...args], { env, windowsHide: true, timeout: 40000 });
  const parsed = JSON.parse(result.stdout); assert.equal(parsed.ok, true); return parsed.data;
}
try {
  const entry = join(root, 'main.mjs');
  await writeFile(entry, `// 실제 업데이트 API와 제품 제어기를 사용하는 숨김 합성 앱이다.\nimport {app,autoUpdater} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {UpdateController} from ${JSON.stringify(resolve('packages/desktop/src/main/업데이트.ts').replaceAll('\\', '/'))};
if(process.argv.some(x=>/^--squirrel-(install|updated|uninstall|obsolete)$/.test(x))) app.exit(0);
else { app.setPath('userData',${JSON.stringify(join(root, '화면 자료'))}); void app.whenReady().then(async()=>{
const native={on:(...args)=>autoUpdater.on(...args),setFeedURL:()=>autoUpdater.setFeedURL({url:${JSON.stringify(feed)}}),checkForUpdates:()=>autoUpdater.checkForUpdates(),quitAndInstall:()=>autoUpdater.quitAndInstall()};
const readMetadata=async()=>{const response=await fetch(${JSON.stringify(feed + '/RELEASES')});if(!response.ok)throw new Error('fixture-metadata-unavailable');return (await response.text()).replace(/\\S+-1\\.0\\.1-full\\.nupkg/g,'CheckMate-1.0.1-full.nupkg');};
const controller=new UpdateController(native,${JSON.stringify(install)},app.getVersion(),readMetadata);
autoUpdater.on('error',error=>{void writeFile(${JSON.stringify(join(root, '업데이트오류.log'))},String(error.stack));});
let command=0,busy=false; await controller.recover();
setInterval(async()=>{if(busy)return;busy=true;try{
let next;try{next=JSON.parse(await readFile(${JSON.stringify(commandFile)},'utf8'));}catch{next={};}
if(next.id>command){command=next.id;if(next.action==='quit'){app.quit();return;}if(app.getVersion()==='1.0.0'){if(next.action==='check')await controller.check();if(next.action==='download')await controller.download();if(next.action==='apply')await controller.apply();}}
await writeFile(${JSON.stringify(statusFile)},JSON.stringify({...controller.status(),version:app.getVersion(),pid:process.pid,command}));
}catch(error){await writeFile(${JSON.stringify(join(root, '앱오류.txt'))},String(error.stack));app.exit(1);}finally{busy=false;}},200);
}).catch(error=>{console.error(error);app.exit(1);});
}`);
  for (const version of ['1.0.0', '1.0.1']) {
    const appDir = join(root, `stage-${version}`);
    const originalResources = join(built.packagePath, 'resources');
    await cp(built.packagePath, appDir, { recursive: true, filter: path => path !== originalResources && !path.startsWith(originalResources + sep) });
    const resources = join(appDir, 'resources');
    await mkdir(join(resources, 'app'), { recursive: true });
    await mkdir(join(resources, 'node'));
    await copyFile(join(built.packagePath, 'resources/node/node.exe'), join(resources, 'node/node.exe'));
    await writeFile(join(resources, 'app/package.json'), JSON.stringify({ name: identity.toLowerCase(), version, main: 'main.mjs', type: 'module' }));
    await build({ entryPoints: [entry], outfile: join(resources, 'app/main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron', 'node:*'], logLevel: 'warning' });
    const output = join(root, `feed-${version}`);
    await createWindowsInstaller({ appDirectory: appDir, outputDirectory: output, name: identity, title: identity, version, exe: 'CheckMate.exe', authors: 'CheckMate', description: 'Isolated update acceptance fixture', setupExe: 'Setup.exe', noMsi: true, usePackageJson: false, vendorDirectory: join(built.runRoot, 'squirrel-vendor') });
    report.phases.push(`package-${version}`);
    if (version === '1.0.0') {
      await mkdir(join(install, 'packages'), { recursive: true });
      await cp(appDir, join(install, 'app-1.0.0'), { recursive: true });
      await copyFile(join(built.runRoot, 'squirrel-vendor/Squirrel.exe'), join(install, 'Update.exe'));
      for (const name of await readdir(output)) if (name === 'RELEASES' || name.endsWith('.nupkg')) await copyFile(join(output, name), join(install, 'packages', name));
    } else feedFolder = output;
  }
  await cli('1.0.0', 'setup', '--accept-local-storage');
  // 실제 엔진에서 프로젝트 이력을 만들고 다음 버전에서 같은 목록을 다시 읽는다.
  const project = join(root, '합성 프로젝트'); const projectId = randomUUID();
  await mkdir(join(project, 'checkmate'), { recursive: true });
  await mkdir(join(project, 'tests'));
  await writeFile(join(project, 'tests/check.mjs'), '// 합성 종료 명령이다.\nprocess.exit(0);\n');
  await writeFile(join(project, 'checkmate/프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: '업데이트 이력 보존', repositoryIdentity: 'synthetic:update', commands: [{ id: 'quick', title: '합성 종료', runtime: 'node', entry: 'tests/check.mjs', args: [], env: {}, writes: [], timeoutMs: 5000, resultFormat: 'exit-code' }], profiles: [{ id: 'quick', title: '합성 검사', checkIds: ['check-1'] }] }));
  await writeFile(join(project, 'checkmate/요구사항.json'), JSON.stringify([{ id: 'req-1', title: '보존', description: '프로젝트 이력 보존' }]));
  await writeFile(join(project, 'checkmate/검사항목.json'), JSON.stringify([{ id: 'check-1', title: '종료', requirementId: 'req-1', commandId: 'quick', required: true, kind: 'logic', expected: '종료 0', codePaths: ['tests/check.mjs'] }]));
  await cli('1.0.0', 'register', project, '--trust');
  const plan = await cli('1.0.0', 'inspect', '--project', projectId, '--profile', 'quick');
  await cli('1.0.0', 'approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm');
  report.runBefore = await cli('1.0.0', 'run', '--project', projectId, '--plan', plan.planId, '--request-id', randomUUID(), '--wait');
  report.projectsBefore = await cli('1.0.0', 'projects');
  appChild = spawn(join(install, 'app-1.0.0/CheckMate.exe'), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  appChild.stderr.pipe(createWriteStream(join(root, '앱표준오류.log')));
  await waitFor(async () => (await state()).version === '1.0.0');
  await writeFile(commandFile, JSON.stringify({ id: ++lastCommand, action: 'check' }));
  await waitFor(async () => { const value = await state(); return value.command === lastCommand && value.state !== 'checking'; });
  assert.equal((await state()).state, 'available');
  assert.equal((await state()).availableVersion, '1.0.1');
  assert.equal((await state()).downloaded, false);
  assert.ok(requests.includes('RELEASES'));
  assert.equal(requests.some(name => name.endsWith('.nupkg')), false);
  report.phases.push('active-engine-metadata-check');
  assert.equal((await action('download', 'blocked')).reason, 'engine-active');
  assert.equal(requests.some(name => name.endsWith('.nupkg')), false); report.phases.push('active-engine-download-blocked');
  // 서비스가 스스로 유휴 종료할 때까지 기다린다. 다른 세션 프로세스를 종료하지 않는다.
  await waitFor(async () => {
    const id = ++lastCommand; await writeFile(commandFile, JSON.stringify({ id, action: 'download' }));
    await waitFor(async () => (await state()).command === id, 20000);
    const value = await state();
    // 다른 프로세스가 종료되는 순간 관측이 불명확하면 제품은 안전하게 보류한다.
    if (['check-unavailable', 'download-unavailable'].includes(value.reason)) report.observationDeferrals = (report.observationDeferrals ?? 0) + 1;
    return ['checking', 'downloading'].includes(value.state) || value.reason === 'update-failed';
  }, 120000);
  await waitFor(async () => (await state()).state === 'error');
  assert.ok(requests.some(name => name.endsWith('.nupkg')));
  assert.equal((await state()).version, '1.0.0'); report.phases.push('corrupt-download-rejected');
  assert.equal((await lstat(dbPath)).isFile(), true);
  const digest = async () => createHash('sha256').update(await readFile(dbPath)).digest('hex');
  report.databaseBefore = await digest(); corrupt = false;
  await writeFile(commandFile, JSON.stringify({ id: ++lastCommand, action: 'download' }));
  await waitFor(async () => packageWaiting);
  await assert.rejects(() => cli('1.0.0', 'projects'), error => JSON.parse(error.stdout).error.code === 'update-in-progress');
  report.phases.push('new-cli-blocked-during-download'); releasePackage(); releasePackage = undefined;
  await waitFor(async () => (await state()).state === 'ready', 180000); report.phases.push('native-download-ready');
  assert.equal(await digest(), report.databaseBefore);
  nodeChild = spawn(join(install, 'app-1.0.0/resources/node/node.exe'), ['-e', 'setInterval(()=>{},1000);process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await pause(500);
  assert.equal((await action('apply', 'blocked')).reason, 'engine-active');
  nodeChild.stdin.end(); await new Promise(done => nodeChild.once('exit', done)); nodeChild = undefined;
  await writeFile(commandFile, JSON.stringify({ id: ++lastCommand, action: 'apply' }));
  await waitFor(async () => (await state()).version === '1.0.1', 90000);
  await waitFor(async () => !(await lstat(join(install, '업데이트잠금.json')).then(() => true, () => false)));
  report.databaseAfter = await digest(); assert.equal(report.databaseAfter, report.databaseBefore);
  report.projectsAfter = await cli('1.0.1', 'projects'); assert.deepEqual(report.projectsAfter, report.projectsBefore);
  report.runAfter = await cli('1.0.1', 'result', report.runBefore.runId); assert.deepEqual(report.runAfter, report.runBefore);
  report.phases.push('native-restart-and-data-preserved'); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  releasePackage?.();
  nodeChild?.stdin.end();
  await writeFile(commandFile, JSON.stringify({ id: ++lastCommand, action: 'quit' }));
  if (appChild && appChild.exitCode === null) await Promise.race([new Promise(done => appChild.once('exit', done)), pause(10000)]);
  if (appChild && appChild.exitCode === null) { appChild.kill(); report.passed = false; report.cleanupError = '이번 합성 앱의 정상 종료 실패'; process.exitCode = 1; }
  const pid = (await state()).pid;
  if (pid) await waitFor(async () => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 20000).catch(error => { report.passed = false; report.cleanupError = error.message; process.exitCode = 1; });
  if (report.passed) {
    try {
      await waitFor(() => installationIdle(install), 120000);
      assert.equal(resolve(install), join(root, identity));
      await execute(join(install, 'Update.exe'), ['--uninstall', '--silent'], { cwd: install, env, windowsHide: true, timeout: 40000 });
      await waitFor(async () => !(await lstat(join(install, 'app-1.0.1/CheckMate.exe')).then(() => true, () => false)), 40000);
      assert.equal(createHash('sha256').update(await readFile(dbPath)).digest('hex'), report.databaseAfter);
      report.cleanupVerified = true;
    } catch (error) { report.passed = false; report.cleanupError = error.message; process.exitCode = 1; }
  }
  server.closeAllConnections(); await new Promise(done => server.close(done));
  report.requests = requests; report.finishedAt = new Date().toISOString();
  await writeFile(join(root, '검증결과.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: join(root, '검증결과.json'), phases: report.phases, cleanupVerified: report.cleanupVerified ?? false, error: report.error ?? report.cleanupError ?? null }));
}
