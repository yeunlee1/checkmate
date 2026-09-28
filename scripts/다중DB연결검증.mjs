// 새 합성 자료 폴더에서 공개 CLI의 다중 DB 승인과 실행 및 결과 조회를 검증한다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { databaseResourceKinds, databaseEnvironmentPrefixes, databaseResourceNames } from '../packages/contracts/dist/시험자원.js';
import { startLocalService } from '../packages/engine/dist/서비스/상주서비스.js';
import { callService } from '../packages/engine/dist/서비스/클라이언트.js';

const root = resolve('.runtime/검증/다중DB연결', randomUUID());
const source = join(root, '합성프로젝트');
const dataRoot = join(root, '검사자료');
await mkdir(join(source, 'checkmate'), { recursive: true });
assert.equal(await realpath(root), root);
const projectId = randomUUID();
const profiles = [...databaseResourceKinds.map(kind => ({ id: kind, kinds: [kind] })), { id: 'mixed', kinds: ['mysql-test', 'mssql-test'] }];
const reportPath = join(root, '결과.json');
const report = { startedAt: new Date().toISOString(), scope: '공개 CLI 승인·실행과 실제 DB 준비 및 명령 연결·증거·정리', cases: [] };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const program = `// 전달된 종류의 연결과 포트를 검사하고 값 없는 관측만 출력한다.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
const prefixes = JSON.parse(process.argv[2]);
for (const prefix of prefixes) {
  assert.equal(process.env[prefix + 'MANAGED'], '1');
  const connection = JSON.parse(process.env[prefix + 'CONNECTION_JSON']);
  assert.equal(connection.host, '127.0.0.1');
  assert.ok(connection.password && connection.user && connection.database);
  await new Promise((resolve, reject) => {
    const socket = connect({host:connection.host, port:connection.port});
    socket.setTimeout(2000);
    socket.once('connect', () => {socket.destroy(); resolve();});
    socket.once('error', () => {socket.destroy(); reject(new Error('시험 포트 연결 실패'));});
    socket.once('timeout', () => {socket.destroy(); reject(new Error('시험 포트 시간 초과'));});
  });
}
const known = ['CHECKMATE_PG_', 'CHECKMATE_MYSQL_', 'CHECKMATE_MARIADB_', 'CHECKMATE_MSSQL_', 'CHECKMATE_ORACLE_', 'CHECKMATE_MONGO_'];
assert.ok(Object.keys(process.env).every(key => !known.some(prefix => key.startsWith(prefix)) || prefixes.some(prefix => key.startsWith(prefix))));
console.log(JSON.stringify({ protocolVersion:1, runId:process.env.CHECKMATE_RUN_ID, sequence:1, type:'case-result', time:new Date().toISOString(),
 payload:{testId:process.argv[3], requirementId:'req', status:'passed', expected:'선언한 DB 연결만 전달', observed:'연결 계약과 호스트 포트 확인', severity:'info', location:null, evidenceIds:[]} }));
`;
await writeFile(join(source, '검사.mjs'), program);
await writeFile(join(source, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: '다중 DB 연결 합성 검증', repositoryIdentity: `synthetic:${projectId}`,
  commands: profiles.map(({ id, kinds }) => ({ id, title: id, runtime: 'node', entry: '검사.mjs', args: [JSON.stringify(kinds.map(kind => databaseEnvironmentPrefixes[kind])), id],
    timeoutMs: 30000, env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'ndjson', resources: kinds })),
  profiles: profiles.map(({ id }) => ({ id, title: id, checkIds: [id] })) }));
await writeFile(join(source, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'req', title: '연결 범위', description: '선언한 DB만 검사 명령에 전달' }]));
await writeFile(join(source, 'checkmate', '검사항목.json'), JSON.stringify(profiles.map(({ id }) => ({ id, title: id, requirementId: 'req', commandId: id,
  required: true, kind: 'logic', expected: '연결 계약 확인', codePaths: ['검사.mjs'] }))));
const execute = promisify(execFile);
const service = await startLocalService(dataRoot, 3_600_000);
async function cli(args) {
  const response = JSON.parse((await execute(process.execPath, [resolve('packages/engine/dist/명령.js'), '--json', '--data-dir', dataRoot, ...args],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);
  assert.equal(response.ok, true, response.error?.code);
  return response.data;
}
async function api(method, input) {
  const response = await callService({ apiVersion: 1, requestId: randomUUID(), method, input }, { dataRoot });
  assert.equal(response.ok, true, response.error?.code);
  return response.data;
}
console.log(JSON.stringify({ reportPath }));
try {
  const capabilities = await cli(['capabilities']);
  assert.deepEqual(capabilities.databaseResources, [...databaseResourceKinds]);
  report.capabilities = capabilities;
  await cli(['register', source, '--trust']);
  for (const profile of profiles) {
    const plan = await cli(['inspect', '--project', projectId, '--profile', profile.id]);
    for (const kind of profile.kinds) assert.ok(plan.resourceEffects.some(effect => effect.includes(databaseResourceNames[kind])));
    await cli(['approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm']);
    const accepted = await cli(['run', '--project', projectId, '--plan', plan.planId, '--request-id', randomUUID()]);
    const item = { profile: profile.id, runId: accepted.runId };
    report.cases.push(item); await save();
    const deadline = Date.now() + 600000;
    while (!(await api('status', { runId: item.runId })).finalized) {
      assert.ok(Date.now() < deadline, '검사 최종 확정 시간 초과');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    item.summary = await api('result', { runId: item.runId, section: 'summary' });
    item.resources = (await api('resources', { runId: item.runId })).items;
    await save();
    assert.equal(item.summary.verdict, 'passed');
    assert.equal(item.summary.reusablePassed, true);
    assert.equal(item.summary.cleanupVerified, true);
    assert.equal(item.summary.sourceBefore, item.summary.sourceAfter);
    assert.deepEqual(item.resources.map(row => row.kind).sort(), [...profile.kinds].sort());
    assert.ok(item.resources.every(row => row.state === 'cleaned' && row.cleanup?.verified));
    console.log(JSON.stringify({ profile: profile.id, passed: true, resources: item.resources.length }));
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error?.message ?? error).slice(0, 1000); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await save();
  // 실행 중이면 서비스를 끊지 않는다. 정상 완료한 이번 합성 서비스만 닫는다.
  if (!service.product.active) await service.close();
  console.log(JSON.stringify({ passed: report.passed, reportPath }));
}
