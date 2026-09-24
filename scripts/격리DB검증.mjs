// 새 합성 작업 폴더에서 실제 Docker 자원의 실행과 중단 및 수동 정리를 수용 검사한다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { callService, initializeLocalStore } from '../packages/engine/dist/서비스/클라이언트.js';
import { PostgresResources } from '../packages/engine/dist/자원/격리데이터베이스.js';
import { fingerprintSource } from '../packages/engine/dist/프로젝트/원본읽기.js';

const exec = promisify(execFile);
const IMAGE = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const DATA = '/var/lib/postgresql/data';
const serviceEntry = resolve('packages/engine/dist/서비스/상주서비스.js');
const cliEntry = resolve('packages/engine/dist/명령.js');
const base = resolve('.runtime/검증/격리DB');
const deadlineMs = 180_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, target) => {
  const part = relative(parent, target);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

async function safeBase() {
  const repository = await realpath(resolve('.'));
  assert.equal(repository, resolve('.'), '저장소 경로가 링크를 거칩니다.');
  assert.ok(inside(repository, base) && base !== repository, '검증 루트가 저장소 밖입니다.');
  let cursor = base;
  while (cursor !== repository) {
    try { assert.equal((await lstat(cursor)).isSymbolicLink(), false, '검증 경로에 링크가 있습니다.'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
  await mkdir(base, { recursive: true });
  assert.equal(await realpath(base), base, '검증 루트의 실제 경로가 다릅니다.');
  return base;
}

const dockerExe = process.platform === 'win32'
  ? ['C:/Program Files/Docker/Docker/resources/bin/docker.exe',
    'C:/ProgramData/DockerDesktop/version-bin/docker.exe'].find(existsSync) ?? 'docker.exe' : 'docker';
function dockerEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  return { ...env, ...extra };
}
async function dockerRaw(args, options = {}) {
  const { stdout } = await exec(dockerExe, args, { env: dockerEnv(options.env), windowsHide: true,
    timeout: options.timeoutMs ?? options.timeout ?? 15000, ...(options.signal ? { signal: options.signal } : {}), maxBuffer: 1024 * 1024 });
  return stdout;
}
async function localDocker() {
  const context = (await dockerRaw(['context', 'show'])).trim();
  assert.ok(context && !/[\r\n]/u.test(context), 'Docker context가 불명확합니다.');
  const descriptions = JSON.parse(await dockerRaw(['context', 'inspect', context]));
  const endpoint = descriptions?.length === 1 ? descriptions[0]?.Endpoints?.docker?.Host : null;
  assert.match(endpoint ?? '', /^(unix:\/\/\/[^\r\n]+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+)$/u, '로컬 Docker endpoint만 허용합니다.');
  const info = JSON.parse(await dockerRaw(['--host', endpoint, 'info', '--format', '{{json .}}']));
  assert.equal(info.OSType, 'linux');
  assert.ok(info.ID);
  return { endpoint, daemonId: info.ID };
}
async function docker(local, args, options = {}) {
  const info = JSON.parse(await dockerRaw(['--host', local.endpoint, 'info', '--format', '{{json .}}']));
  assert.equal(info.OSType, 'linux');
  assert.equal(info.ID, local.daemonId, 'Docker daemon이 변경됐습니다.');
  return dockerRaw(['--host', local.endpoint, ...args], options);
}
async function inspect(local, id) {
  assert.match(id, /^[a-f0-9]{64}$/u);
  try { return JSON.parse(await docker(local, ['container', 'inspect', id]))[0]; }
  catch (error) {
    if (!/No such (object|container)/iu.test(String(error))) throw error;
    await docker(local, ['info', '--format', '{{json .}}']);
    return null;
  }
}
function memoryStore(report, label) {
  const rows = new Map();
  const checkpoint = () => {
    report.directRecords[label] = [...rows.values()];
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  };
  return {
    list: runId => [...rows.values()].filter(item => item.runId === runId),
    intent(record) { assert.equal(rows.has(record.id), false); rows.set(record.id, record); checkpoint(); },
    update(id, expected, changes) {
      const old = rows.get(id);
      assert.ok(old && expected.includes(old.state));
      const next = { ...old, ...changes };
      rows.set(id, next);
      checkpoint();
      return next;
    },
    all: () => [...rows.values()],
  };
}
function driver(local, fault = {}) {
  return {
    async command(args, options) {
      if (args[0] === 'context' && args[1] === 'show') return dockerRaw(args);
      if (args[0] === 'context' && args[1] === 'inspect') return dockerRaw(args);
      assert.deepEqual(args.slice(0, 2), ['--host', local.endpoint]);
      if (args[2] === 'run' && fault.lostResponse) {
        fault.lostResponse = false;
        await docker(local, args.slice(2), options);
        throw new Error('합성 생성 응답 유실');
      }
      if (args[2] === 'stop' && fault.stopOnce) {
        fault.stopOnce = false;
        throw new Error('합성 중지 호출 실패');
      }
      return docker(local, args.slice(2), options);
    },
    probe(port) {
      return new Promise((done, fail) => {
        import('node:net').then(({ connect }) => {
          const socket = connect({ host: '127.0.0.1', port });
          socket.setTimeout(2000);
          socket.once('connect', () => { socket.destroy(); done(); });
          socket.once('timeout', () => { socket.destroy(); fail(new Error('연결 시간 초과')); });
          socket.once('error', () => { socket.destroy(); fail(new Error('연결 실패')); });
        }, fail);
      });
    },
  };
}
function safeResource(resource) {
  return { id: resource.id, runId: resource.runId, state: resource.state,
    name: resource.descriptor.name, containerId: resource.descriptor.containerId ?? null,
    cleanupVerified: resource.cleanup?.verified ?? null };
}
function responseData(response, method) {
  assert.equal(response.ok, true, `${method} 요청 실패: ${response.ok ? '' : response.error.code}`);
  return response.data;
}
async function waitUntil(probe, label, timeout = deadlineMs) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`${label} 시간 초과`);
}
async function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}
async function serviceProcess(pid) {
  if (process.platform === 'win32') {
    const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
    const raw = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
    return raw.stdout.trim() ? JSON.parse(raw.stdout) : null;
  }
  try {
    const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    const environment = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
    return { ExecutablePath: command[0], CommandLine: command, Environment: environment };
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function ownedServicePid(dataRoot) {
  const owner = JSON.parse(await readFile(join(dataRoot, 'runtime', '서비스소유.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && /^[a-f0-9-]{36}$/u.test(owner.id));
  const target = await serviceProcess(owner.pid);
  assert.ok(target, '소유 표식의 프로세스가 없습니다.');
  const tokens = Array.isArray(target.CommandLine) ? target.CommandLine
    : target.CommandLine.match(/"[^"]*"|\S+/gu).map(item => item.replace(/^"|"$/gu, ''));
  const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  assert.equal(normalize(tokens[0]), normalize(process.execPath));
  assert.deepEqual(tokens.slice(1).map(normalize), [normalize(serviceEntry)], '서비스 명령줄이 다릅니다.');
  if (process.platform === 'win32') {
    const created = Date.parse(target.CreationDate);
    const owned = Date.parse(owner.startedAt);
    assert.ok(Number.isFinite(created) && Number.isFinite(owned) && owned >= created && owned - created < 25_000,
      '서비스 프로세스의 생성 시각이 소유 표식과 다릅니다.');
  } else assert.ok(target.Environment.includes(`CHECKMATE_DATA_DIR=${dataRoot}`), '서비스 자료 경로가 다릅니다.');
  const again = JSON.parse(await readFile(join(dataRoot, 'runtime', '서비스소유.json'), 'utf8'));
  assert.deepEqual(again, owner, '서비스 소유 표식이 변경됐습니다.');
  return owner.pid;
}

const program = `// 합성 명령의 종료와 부모 연결 중단을 관측한다.\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst mode = process.argv[2];\nwriteFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR, '명령PID.json'), JSON.stringify({ pid: process.pid, runId: process.env.CHECKMATE_RUN_ID }), { flag: 'wx' });\nif (!process.env.CHECKMATE_PG_ADMIN_URL || process.env.CHECKMATE_PG_MANAGED !== '1') process.exit(8);\nif (mode === 'success') process.exit(0);\nif (mode === 'failure') process.exit(1);\nif (mode === 'hold') setInterval(() => {}, 1000);\nelse process.exit(9);\n`;
async function createSource(source) {
  await mkdir(join(source, 'checkmate'), { recursive: true });
  await mkdir(join(source, 'tests'));
  const id = randomUUID();
  const modes = ['success', 'failure', 'cancel', 'crash'];
  const commands = modes.map(mode => ({ id: mode, title: mode, runtime: 'node', entry: 'tests/실행.mjs',
    args: [mode === 'cancel' || mode === 'crash' ? 'hold' : mode], timeoutMs: 120_000,
    env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'exit-code', resources: ['postgres-test'] }));
  const project = { schemaVersion: 1, id, name: '격리 DB 합성 수용', repositoryIdentity: `synthetic:isolated-db:${id}`,
    commands, profiles: modes.map(mode => ({ id: mode, title: mode, checkIds: [mode] })) };
  const requirements = modes.map(mode => ({ id: `req-${mode}`, title: mode, description: `${mode} 종료 확인` }));
  const checks = modes.map(mode => ({ id: mode, title: mode, requirementId: `req-${mode}`, commandId: mode,
    required: true, kind: 'logic', expected: '명령 종료 검증', codePaths: ['tests/실행.mjs'] }));
  await writeFile(join(source, 'checkmate', '프로젝트.json'), JSON.stringify(project), { flag: 'wx' });
  await writeFile(join(source, 'checkmate', '요구사항.json'), JSON.stringify(requirements), { flag: 'wx' });
  await writeFile(join(source, 'checkmate', '검사항목.json'), JSON.stringify(checks), { flag: 'wx' });
  await writeFile(join(source, 'tests', '실행.mjs'), program, { flag: 'wx' });
  return { id, scriptHash: sha(await readFile(join(source, 'tests', '실행.mjs'))) };
}
async function result(runId, options) {
  const response = await callService({ apiVersion: 1, requestId: randomUUID(), method: 'result', input: { runId, section: 'summary' } }, options);
  return responseData(response, 'result');
}
async function resources(runId, options) {
  const response = await callService({ apiVersion: 1, requestId: randomUUID(), method: 'resources', input: { runId } }, options);
  const page = responseData(response, 'resources');
  assert.equal(page.nextCursor, null);
  return page.items;
}
async function api(method, input, options, role = 'human') {
  return callService({ apiVersion: 1, requestId: randomUUID(), method, input }, options, role);
}
async function cli(dataRoot, args) {
  const { stdout } = await exec(process.execPath, [cliEntry, '--json', '--data-dir', dataRoot, ...args],
    { env: dockerEnv(), windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
async function runMode(mode, projectId, source, options, local, report) {
  const plan = responseData(await api('inspect', { projectId, profile: mode }, options), 'inspect');
  assert.ok(plan.resourceEffects?.length > 0 && plan.commands.length === 1);
  responseData(await api('approve', { planId: plan.planId, fingerprint: plan.fingerprint }, options), 'approve');
  const accepted = responseData(await cli(options.dataRoot, ['run', '--project', projectId, '--plan', plan.planId,
    '--request-id', randomUUID()]), 'CLI run');
  const runId = accepted.runId;
  report.runs[mode] = { runId, state: 'started' };
  await saveReport(report);
  if (mode === 'cancel' || mode === 'crash') {
    const pidFile = join(options.dataRoot, 'runs', runId, '명령PID.json');
    const child = await waitUntil(async () => {
      try { return JSON.parse(await readFile(pidFile, 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    }, `${mode} 명령 시작`, 120_000);
    assert.equal(child.runId, runId);
    assert.ok(await processExists(child.pid), '명령 자식 프로세스가 시작되지 않았습니다.');
    report.runs[mode].childPid = child.pid;
    await saveReport(report);
    if (mode === 'cancel') responseData(await api('cancel', { runId }, options), 'cancel');
    else {
      const servicePid = await ownedServicePid(options.dataRoot);
      report.runs[mode].servicePid = servicePid;
      await saveReport(report);
      assert.equal(await ownedServicePid(options.dataRoot), servicePid);
      process.kill(servicePid);
      await waitUntil(async () => !await processExists(servicePid), '부모 종료', 20_000);
    }
    await waitUntil(async () => !await processExists(child.pid), '자식 종료', 25_000);
  }
  const final = await waitUntil(async () => {
    const value = await result(runId, options);
    return value.finalized ? value : null;
  }, `${mode} 최종 결과`);
  const found = await resources(runId, options);
  assert.equal(found.length, 1, '실행 자원은 하나여야 합니다.');
  const item = found[0];
  assert.ok(item.descriptor.containerId);
  report.runs[mode] = { ...report.runs[mode], state: final.state, verdict: final.verdict,
    workerExitCode: final.workerExitCode, cleanupVerified: final.cleanupVerified,
    sourceBefore: final.sourceBefore, sourceAfter: final.sourceAfter,
    resource: safeResource(item) };
  await saveReport(report);
  if (mode === 'success') assert.ok(final.verdict === 'passed' && final.workerExitCode === 0 && final.cleanupVerified === true);
  if (mode === 'failure') {
    const command = JSON.parse(await readFile(join(options.dataRoot, 'runs', runId, '명령-1.json'), 'utf8'));
    assert.ok(final.verdict === 'failed' && final.workerExitCode === 0 && final.cleanupVerified === true);
    assert.equal(command.exitCode, 1, '검사 명령의 실제 실패 종료를 보존해야 합니다.');
    report.runs[mode].commandExitCode = command.exitCode;
  }
  if (mode === 'cancel') assert.ok(final.verdict !== 'passed' && final.state === 'cancelled');
  if (mode === 'crash') assert.ok(final.verdict === 'unknown' && final.state === 'unverifiable' && final.cleanupVerified !== true);
  assert.equal(sha(await readFile(join(source, 'tests', '실행.mjs'))), report.scriptHash);
  if (mode !== 'crash') {
    assert.ok(item.state === 'cleaned' && item.cleanup?.verified === true);
    assert.equal(await inspect(local, item.descriptor.containerId), null);
    return;
  }
  assert.notEqual(item.state, 'cleaned');
  assert.ok(await inspect(local, item.descriptor.containerId), '중단 자원이 남아 있어야 합니다.');
  const rejected = await api('cleanup-resources', { runId, confirm: true }, options, 'agent');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'human-action-required');
  const before = final.verdict;
  const cleaned = responseData(await cli(options.dataRoot, ['cleanup-resources', runId, '--confirm']), 'CLI cleanup-resources');
  assert.ok(cleaned.verified && cleaned.originalVerdict === before);
  assert.equal(await inspect(local, item.descriptor.containerId), null);
  const afterCleanup = await resources(runId, options);
  assert.ok(afterCleanup[0]?.state === 'cleaned' && afterCleanup[0]?.cleanup?.verified === true);
  const childPid = report.runs[mode].childPid;
  assert.equal(await processExists(childPid), false);
  const acknowledged = responseData(await cli(options.dataRoot, ['acknowledge-cleanup', runId, '--confirm',
    '--note', '합성 명령 프로세스 종료와 해당 컨테이너 부재를 직접 확인했습니다.']), 'CLI acknowledge-cleanup');
  assert.ok(acknowledged.acknowledged && acknowledged.originalVerdict === before);
  const after = await result(runId, options);
  assert.equal(after.verdict, before, '수동 정리가 과거 판정을 변경했습니다.');
  report.runs[mode].manualCleanupVerified = true;
  report.runs[mode].acknowledged = true;
  report.runs[mode].resource = safeResource(afterCleanup[0]);
  await saveReport(report);
}

let reportPath;
async function saveReport(report) {
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function main() {
  await safeBase();
  const root = join(base, randomUUID());
  assert.ok(inside(base, root));
  await mkdir(root);
  assert.equal(await realpath(root), root);
  reportPath = join(root, '결과.json');
  const report = { status: 'running', root, startedAt: new Date().toISOString(), runs: {}, direct: {}, directRecords: {}, residual: [] };
  const directStores = [];
  let local;
  let dataRoot;
  try {
    await saveReport(report);
    local = await localDocker();
    try { await docker(local, ['image', 'inspect', IMAGE]); }
    catch (error) {
      if (!/No such image/iu.test(String(error))) throw error;
      await docker(local, ['pull', IMAGE], { timeout: 300_000 });
    }
    const source = join(root, '합성원본');
    dataRoot = join(root, '전용자료');
    const fixture = await createSource(source);
    report.scriptHash = fixture.scriptHash;
    await initializeLocalStore({ dataRoot });
    const options = { dataRoot, nodeExecutable: process.execPath, serviceEntry };
    const registered = responseData(await cli(dataRoot, ['register', source, '--trust']), 'CLI register');
    assert.equal(registered.id, fixture.id);
    const protectiveStore = memoryStore(report, 'protector');
    directStores.push(protectiveStore);
    const protector = new PostgresResources(protectiveStore, driver(local));
    const protectRun = randomUUID();
    await protector.prepare(protectRun, randomBytes(32).toString('hex'), new AbortController().signal);
    const protectedResource = protectiveStore.list(protectRun)[0];
    assert.ok(protectedResource?.descriptor.containerId);
    report.protector = safeResource(protectedResource);
    await saveReport(report);
    const protectedId = protectedResource.descriptor.containerId;
    for (const mode of ['success', 'failure', 'cancel', 'crash']) {
      await runMode(mode, fixture.id, source, options, local, report);
      const active = await inspect(local, protectedId);
      assert.equal(active?.Id, protectedId, '다른 실행의 보호 자원이 변경됐습니다.');
      assert.equal(active?.State?.Running, true);
    }
    for (const [name, fault] of [['response-lost', { lostResponse: true }], ['stop-failed', { stopOnce: true }]]) {
      const store = memoryStore(report, name);
      directStores.push(store);
      const runId = randomUUID();
      const resource = new PostgresResources(store, driver(local, fault));
      await resource.prepare(runId, randomBytes(32).toString('hex'), new AbortController().signal);
      if (name === 'response-lost') assert.equal(fault.lostResponse, false, '생성 응답 유실을 주입하지 못했습니다.');
      const created = store.list(runId)[0];
      assert.ok(created?.descriptor.containerId);
      report.direct[name] = { runId, created: safeResource(created) };
      await saveReport(report);
      const first = await resource.cleanup(runId);
      if (name === 'response-lost') assert.ok(first.verified);
      else {
        assert.equal(fault.stopOnce, false, '중지 실패를 주입하지 못했습니다.');
        assert.equal(first.verified, false);
        assert.ok(await inspect(local, created.descriptor.containerId));
        report.direct[name].cleanupInitiallyVerified = false;
        const recovered = await new PostgresResources(store, driver(local)).cleanup(runId);
        assert.ok(recovered.verified);
      }
      assert.equal(await inspect(local, created.descriptor.containerId), null);
      report.direct[name].cleanupVerified = true;
      assert.equal((await inspect(local, protectedId))?.State?.Running, true);
      await saveReport(report);
    }
    assert.ok((await protector.cleanup(protectRun)).verified);
    assert.equal(await inspect(local, protectedId), null);
    report.protector = { ...report.protector, cleanupVerified: true };
    for (const mode of ['success', 'failure', 'cancel']) {
      const item = report.runs[mode];
      assert.equal(item.sourceBefore, item.sourceAfter, `${mode} 원본 지문이 변경됐습니다.`);
    }
    assert.equal(report.runs.crash.sourceAfter, null, '부모 중단 후 관측하지 못한 지문을 확정하면 안 됩니다.');
    assert.equal(await fingerprintSource(source), report.runs.crash.sourceBefore, '별도 재조회한 현재 소스가 원본과 다릅니다.');
    report.crashSourceRechecked = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error?.message ?? error?.name ?? 'Error')
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[연결 주소 가림]')
      .replace(/(?:POSTGRES_PASSWORD|PGPASSWORD)\s*[:=]\s*[^\s"']+/giu, '[암호 가림]').slice(0, 2000);
    process.exitCode = 1;
  } finally {
    if (local) {
      for (const store of directStores) for (const row of store.all()) {
        if (row.state !== 'cleaned') {
          try { await new PostgresResources(store, driver(local)).cleanup(row.runId); }
          catch { /* 소유가 불명확하면 삭제하지 않는다. */ }
        }
        const latest = store.list(row.runId)[0];
        if (latest?.state !== 'cleaned') report.residual.push(safeResource(latest));
      }
    }
    if (dataRoot) {
      for (const mode of ['success', 'failure', 'cancel', 'crash']) {
        const item = report.runs[mode];
        if (!item?.runId) continue;
        try {
          const options = { dataRoot, nodeExecutable: process.execPath, serviceEntry };
          const current = await result(item.runId, options);
          if (!current.finalized) responseData(await api('cancel', { runId: item.runId }, options), '잔존 실행 취소');
          let found = await resources(item.runId, options);
          if (found.some(row => row.state !== 'cleaned')) {
            await api('cleanup-resources', { runId: item.runId, confirm: true }, options);
            found = await resources(item.runId, options);
          }
          for (const row of found) if (row.state !== 'cleaned') report.residual.push(safeResource(row));
        } catch { if (item.resource && item.resource.state !== 'cleaned') report.residual.push(item.resource); }
      }
      try {
        if (Object.keys(report.runs).length) responseData(await api('capabilities', {},
          { dataRoot, nodeExecutable: process.execPath, serviceEntry }), 'capabilities');
        const pid = await ownedServicePid(dataRoot);
        process.kill(pid);
        await waitUntil(async () => !await processExists(pid), '검증 서비스 종료', 20_000);
      } catch (error) { report.serviceExitUnverified = true;
        report.serviceExitReason = String(error?.message ?? '확인 실패').slice(0, 1000); }
    }
    if (report.residual.length || report.serviceExitUnverified) { report.status = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    await saveReport(report);
    process.stdout.write(`${report.status} ${reportPath}\n`);
  }
}

await main();
