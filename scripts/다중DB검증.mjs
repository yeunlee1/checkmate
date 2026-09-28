// 새 로컬 합성 컨테이너에서 여섯 DB의 인증과 쓰기 및 소유 자원 제거를 직접 검증한다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseResources } from '../packages/engine/dist/자원/격리데이터베이스.js';
import { databaseSpecs } from '../packages/engine/dist/자원/데이터베이스종류.js';
import { databaseResourceKinds, databaseEnvironmentPrefixes } from '../packages/contracts/dist/시험자원.js';

const execute = promisify(execFile);
const selected = process.argv.slice(2);
const kinds = selected.length ? selected : databaseResourceKinds;
assert.ok(kinds.every(kind => databaseResourceKinds.includes(kind)) && new Set(kinds).size === kinds.length);
const root = resolve('.runtime/검증/다중DB', randomUUID());
mkdirSync(root, { recursive: true });
assert.equal(await realpath(root), root, '시험 경로가 링크를 거칩니다.');
const reportPath = join(root, '결과.json');
const report = { startedAt: new Date().toISOString(), scope: '로컬 합성 DB 인증·쓰기·중복 거절·관계형 롤백·정리', cases: [], resources: [] };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const store = {
  list: runId => report.resources.filter(row => row.runId === runId),
  intent(record) { report.resources.push(record); save(); },
  update(id, expected, change) {
    const index = report.resources.findIndex(row => row.id === id);
    assert.ok(index >= 0 && expected.includes(report.resources[index].state));
    const next = { ...report.resources[index], ...change };
    report.resources[index] = next; save(); return next;
  },
};
const resources = new DatabaseResources(store);
const dockerExe = process.platform === 'win32'
  ? ['C:/Program Files/Docker/Docker/resources/bin/docker.exe', 'C:/ProgramData/DockerDesktop/version-bin/docker.exe'].find(existsSync) ?? 'docker.exe'
  : 'docker';
async function docker(args, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  const pending = execute(dockerExe, args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  pending.child.stdin?.on('error', () => {});
  pending.child.stdin?.end(options.input);
  return (await pending).stdout;
}
async function query(record, connection, sql) {
  const spec = databaseSpecs[record.kind];
  const probe = spec.probe(connection.password);
  let args = [...probe.args];
  let input = probe.input;
  if (record.kind === 'postgres-test') args[args.indexOf('-tAc') + 1] = sql;
  else if (['mysql-test', 'mariadb-test'].includes(record.kind)) {
    args[args.indexOf('-NBe') + 1] = sql;
    args.push('-Dcheckmate_test');
  } else if (record.kind === 'mssql-test') args[args.indexOf('-Q') + 1] = `SET NOCOUNT ON; ${sql}`;
  else if (record.kind === 'oracle-test') input = input.replace('SELECT 1 FROM DUAL;', sql.replaceAll(';', ';\n'));
  else args[args.indexOf('--eval') + 1] = `const admin = db.getSiblingDB("admin"); if (!admin.auth("checkmate_test", process.env.CHECKMATE_DB_PASSWORD).ok) quit(1); const test = db.getSiblingDB("checkmate_test"); ${sql}`;
  const command = ['--host', record.descriptor.endpoint, 'exec', ...(input ? ['--interactive'] : [])];
  for (const key of Object.keys(probe.env ?? {})) command.push('--env', key);
  command.push(record.descriptor.containerId, ...args);
  return docker(command, { env: probe.env, input });
}

save();
console.log(JSON.stringify({ reportPath }));
for (const kind of kinds) {
  const runId = randomUUID();
  const item = { kind, runId, state: 'preparing', authenticated: false, writeRead: false, duplicateRejected: false,
    rollback: kind === 'mongodb-test' ? 'not-supported-standalone' : false, deleteVerified: false, cleanupVerified: false };
  report.cases.push(item); save();
  let secrets = [];
  try {
    const prepared = await resources.prepare(runId, randomUUID(), new AbortController().signal, [kind]);
    secrets = prepared.secrets;
    const connection = JSON.parse(prepared.environment[`${databaseEnvironmentPrefixes[kind]}CONNECTION_JSON`]);
    const record = store.list(runId)[0];
    assert.equal(connection.host, '127.0.0.1');
    assert.equal(connection.port, record.descriptor.hostPort);
    item.authenticated = true;
    item.state = 'checking'; save();
    const table = 'checkmate_probe';
    let setup, duplicate, remove;
    if (kind === 'mongodb-test') {
      setup = `test.${table}.insertOne({_id:1,value:"synthetic"}); test.${table}.updateOne({_id:1},{$set:{value:"checked"}}); print(test.${table}.countDocuments({_id:1,value:"checked"}));`;
      duplicate = `test.${table}.insertOne({_id:1,value:"duplicate"});`;
      remove = `test.${table}.deleteOne({_id:1}); print(test.${table}.countDocuments({}));`;
    } else {
      const oracle = kind === 'oracle-test';
      const mssql = kind === 'mssql-test';
      const begin = oracle ? '' : mssql ? 'BEGIN TRANSACTION;' : 'BEGIN;';
      const use = mssql ? 'USE checkmate_test;' : '';
      if (mssql) await query(record, connection, 'CREATE DATABASE checkmate_test;');
      await query(record, connection, `${use} CREATE TABLE ${table} (id INT PRIMARY KEY, value ${oracle ? 'VARCHAR2' : 'VARCHAR'}(32)); INSERT INTO ${table} VALUES (1,'synthetic'); ${oracle ? 'COMMIT;' : ''}`);
      setup = `${use} ${begin} UPDATE ${table} SET value='rollback' WHERE id=1; ROLLBACK; SELECT COUNT(*) FROM ${table} WHERE id=1 AND value='synthetic';`;
      duplicate = `${use} INSERT INTO ${table} VALUES (1,'duplicate');`;
      remove = `${use} DELETE FROM ${table} WHERE id=1; ${oracle ? 'COMMIT;' : ''} SELECT COUNT(*) FROM ${table};`;
    }
    const output = await query(record, connection, setup);
    assert.match(output.trim(), /(?:^|\s)1\s*$/u, '합성 자료 저장·조회 또는 롤백 확인 실패');
    item.writeRead = true;
    if (kind !== 'mongodb-test') item.rollback = true;
    let rejected = false;
    try { await query(record, connection, duplicate); } catch (error) {
      const expected = { 'postgres-test': /duplicate key/iu, 'mysql-test': /1062/u, 'mariadb-test': /1062/u,
        'mssql-test': /2627/u, 'oracle-test': /ORA-00001/u, 'mongodb-test': /E11000/u };
      rejected = expected[kind].test(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`);
    }
    assert.equal(rejected, true, '중복 기본키를 허용했습니다.');
    item.duplicateRejected = true;
    assert.match((await query(record, connection, remove)).trim(), /(?:^|\s)0\s*$/u, '합성 자료 삭제 확인 실패');
    item.deleteVerified = true;
    item.state = 'passed';
  } catch (error) {
    item.state = 'failed';
    let message = `${String(error?.message ?? error)}\n${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    for (const secret of secrets) message = message.replaceAll(secret, '[가림]');
    // 준비 전 오류는 제품이 이미 값 없는 오류로 축약한다.
    item.error = message.slice(0, 2000);
    process.exitCode = 1;
  } finally {
    const cleanup = await resources.cleanup(runId);
    item.cleanupVerified = cleanup.verified;
    if (!cleanup.verified) { item.state = 'failed'; process.exitCode = 1; }
    save();
    console.log(JSON.stringify({ kind, state: item.state, authenticated: item.authenticated, cleanupVerified: item.cleanupVerified }));
  }
  if (!item.cleanupVerified) break;
}
report.finishedAt = new Date().toISOString();
report.passed = report.cases.length === kinds.length && report.cases.every(item => item.state === 'passed' && item.cleanupVerified);
if (!report.passed) process.exitCode = 1;
save();
console.log(JSON.stringify({ passed: report.passed, reportPath }));
