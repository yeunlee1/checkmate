// 실제 CLI와 stdio MCP가 같은 서비스의 승인된 실행과 증거를 조회하는지 확인한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { startLocalService } from '../packages/engine/src/서비스/상주서비스.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
const execute = promisify(execFile);
const cli = resolve('packages/engine/dist/명령.js');
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(exitCode = 0) {
  const f = await createStoreFixture();
  cleanup.push(f.cleanup);
  const root = join(f.directory, '합성 프로젝트');
  await mkdir(join(root, 'checkmate'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', '검사.mjs'), `// 합성 검사의 실제 종료코드를 반환한다.\nprocess.exitCode = ${exitCode};\n`);
  const projectId = randomUUID();
  await writeFile(join(root, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: '연결 합성 프로젝트', repositoryIdentity: 'synthetic:connection',
    commands: [{ id: 'quick-command', title: '합성 빠른 검사', runtime: 'node', entry: 'scripts/검사.mjs', args: [], timeoutMs: 5000, env: { NODE_ENV: 'test', CHECKMATE_LOCK_DIR: join(f.directory, '공유잠금') }, writes: [], resultFormat: 'exit-code' }],
    profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1'] }] }));
  await writeFile(join(root, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'requirement-1', title: '종료 확인', description: '실제 종료코드를 확인한다.' }]));
  await writeFile(join(root, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'check-1', title: '종료 검사', requirementId: 'requirement-1', commandId: 'quick-command', required: true, kind: 'logic', expected: '실제 종료코드가 0이다.', codePaths: ['scripts/검사.mjs'] }]));
  const dataRoot = join(f.directory, '관리 자료');
  const lockRoot = join(f.directory, '공유잠금');
  const childEnv = { ...process.env, CHECKMATE_LOCK_DIR: lockRoot };
  const service = await startLocalService(dataRoot, 60000, { lockRoot });
  cleanup.push(service.close);
  async function command(...args: string[]) {
    try {
      const result = await execute(process.execPath, [cli, '--data-dir', dataRoot, '--json', ...args], { timeout: 12000, windowsHide: true, env: childEnv });
      expect(result.stderr).toBe('');
      return { code: 0, response: JSON.parse(result.stdout) as Record<string, any> };
    } catch (error) {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && 'code' in error) return { code: error.code, response: JSON.parse(error.stdout) as Record<string, any> };
      throw error;
    }
  }
  return { root, dataRoot, service, projectId, command, lockRoot, childEnv };
}

it('CLI 등록과 승인 후 실행하고 MCP에서 같은 확정 결과와 증거를 조회한다', async () => {
  const f = await fixture();
  expect((await f.command('register', f.root, '--trust')).response.ok).toBe(true);
  const reportPath = join(f.dataRoot, '..', '과거보고서.json');
  await writeFile(reportPath, JSON.stringify({ mode: 'quick', status: 'passed', source: { fingerprint: 'a'.repeat(64) },
    sourceAfter: { fingerprint: 'a'.repeat(64) }, steps: [{ id: 'types', status: 'passed', exitCode: 0 }], omitted: [] }));
  const imported = (await f.command('import-history', reportPath, '--project', f.projectId)).response;
  expect(imported).toMatchObject({ ok: true, data: { origin: 'imported', reportedStatus: 'passed', effectiveVerdict: 'unknown', reused: false } });
  expect((await f.command('import-history', reportPath, '--project', f.projectId)).response.data).toMatchObject({ runId: imported.data.runId, reused: true });
  expect((await f.command('result', imported.data.runId, '--section', 'requirements')).response.data.items).toMatchObject([{ status: 'unknown' }]);
  expect((await f.command('result', imported.data.runId, '--section', 'imported')).response.data).toMatchObject({ reportedStatus: 'passed', reusablePassed: false, items: [{ id: 'types' }] });
  expect(await f.service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'import-history', input: { projectId: f.projectId, path: reportPath } }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  const plan = (await f.command('inspect', '--project', f.projectId)).response.data;
  const requestId = randomUUID();
  const runArgs = ['run', '--project', f.projectId, '--plan', plan.planId, '--request-id', requestId];
  expect((await f.command(...runArgs)).code).toBe(3);
  expect((await f.command('approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm')).response.ok).toBe(true);
  const final = await f.command(...runArgs, '--wait');
  expect(final.code).toBe(0);
  expect(final.response.data).toMatchObject({ finalized: true, verdict: 'passed', integrity: 'verified', reusablePassed: true });
  const runId: string = final.response.data.runId;
  expect((await f.command(...runArgs)).response.data).toMatchObject({ runId, reused: true });
  const client = new Client({ name: 'checkmate-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.dataRoot, 'mcp'], stderr: 'pipe', env: f.childEnv });
  cleanup.push(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const result = await client.callTool({ name: 'get_run_result', arguments: { runId, section: 'summary' } });
  expect(result.isError).toBe(false);
  const content = result.content as { type: string; text: string }[];
  expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, data: { runId, verdict: 'passed', integrity: 'verified' } });
  const cases = (await f.command('result', runId, '--section', 'cases')).response.data.items;
  const requirements = (await f.command('result', runId, '--section', 'requirements')).response.data.items;
  expect(requirements).toMatchObject([{ requirementId: 'requirement-1', status: 'passed', selectedChecks: ['check-1'] }]);
  const reportOutput = join(f.dataRoot, '..', '검증보고서.html');
  expect((await f.command('export', runId, '--output', reportOutput)).response.ok).toBe(true);
  expect(await readFile(reportOutput, 'utf8')).toContain('체크메이트 검증 보고서');
  const backup = (await f.command('backup')).response;
  expect(backup).toMatchObject({ ok: true, data: { includesConnectionSecret: false } });
  const restoredRoot = join(f.dataRoot, '..', '복구 자료');
  expect((await f.command('restore', backup.data.backupDirectory, '--target', restoredRoot)).code).toBe(3);
  const restored = (await f.command('restore', backup.data.backupDirectory, '--target', restoredRoot, '--confirm')).response;
  expect(restored).toMatchObject({ ok: true, data: { dataRoot: restoredRoot, switched: false } });
  const restoredService = await startLocalService(restoredRoot, 60000, { lockRoot: join(f.dataRoot, '..', '복구공유잠금') });
  cleanup.push(restoredService.close);
  const preserved = await restoredService.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'result', input: { runId, section: 'summary' } }, 'human');
  expect(preserved).toMatchObject({ ok: true, data: { runId, verdict: 'passed', integrity: 'verified' } });
  expect(restoredService.product.storage.settings(f.projectId)).toMatchObject({ configuredRoot: null, revision: 1 });
  expect(await restoredService.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'start', input: { projectId: f.projectId, planId: plan.planId } }, 'human'))
    .toMatchObject({ ok: false, error: { code: 'plan-stale' } });
  expect(await f.service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'backup', input: {} }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  const evidenceId: string = cases[0].evidenceIds[0];
  const imageDenied = await f.command('evidence-image', runId, evidenceId);
  expect(imageDenied.response).toMatchObject({ ok: false, error: { code: 'evidence-restricted' } });
  const evidence = (await f.command('evidence', runId, evidenceId)).response.data.evidence;
  const file = join(f.service.paths.runs, runId, evidence.relativePath);
  const before = await readFile(file);
  await writeFile(file, Buffer.concat([before, Buffer.from('changed')]));
  const degraded = (await f.command('result', runId)).response.data;
  expect(degraded).toMatchObject({ verdict: 'passed', effectiveVerdict: 'unknown', integrity: 'degraded', reusablePassed: false });
  const repairs = (await f.command('result', runId, '--section', 'repair-bundle')).response.data;
  expect(repairs).toMatchObject({ integrity: 'degraded', items: [{ testId: 'check-1', codePaths: ['scripts/검사.mjs'] }], guidance: { automaticRetry: 0 } });
}, 60000);

it('비영 종료는 CLI 실패로 남고 변경된 소스에는 기존 승인을 사용할 수 없다', async () => {
  const f = await fixture(9);
  await f.command('register', f.root, '--trust');
  const plan = (await f.command('inspect', '--project', f.projectId)).response.data;
  await f.command('approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm');
  const final = await f.command('run', '--project', f.projectId, '--plan', plan.planId, '--request-id', randomUUID(), '--wait');
  expect(final.code).toBe(1);
  expect(final.response.data).toMatchObject({ verdict: 'failed', finalized: true });
  await writeFile(join(f.root, 'scripts', '검사.mjs'), '// 합성 변경을 나타낸다.\nprocess.exitCode = 0;\n');
  const stale = await f.command('run', '--project', f.projectId, '--plan', plan.planId, '--request-id', randomUUID());
  expect(stale.code).toBe(7);
  expect(stale.response.error.code).toBe('plan-stale');
  await expect(startLocalService(f.dataRoot, 60000, { lockRoot: join(f.dataRoot, '..', '공유잠금') })).rejects.toMatchObject({ code: 'service-already-running' });
}, 30000);

it('진행 중에는 백업을 막고 취소가 끝나면 저장소를 다시 사용할 수 있다', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'scripts', '검사.mjs'), '// 합성 대기 작업을 실행한다.\nsetTimeout(() => {}, 4000);\n');
  await f.command('register', f.root, '--trust');
  const plan = (await f.command('inspect', '--project', f.projectId)).response.data;
  await f.command('approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm');
  const started = await f.service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'start', input: { projectId: f.projectId, planId: plan.planId } }, 'human');
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('합성 실행 접수 실패');
  const runId = (started.data as { runId: string }).runId;
  expect(await f.service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'backup', input: {} }, 'human'))
    .toMatchObject({ ok: false, error: { code: 'maintenance-busy' } });
  await f.service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'cancel', input: { runId } }, 'human');
}, 30000);

it('서로 다른 자료의 정상 응답을 CLI와 MCP의 실제 연결 경로로 구별한다', async () => {
  const first = await fixture();
  const second = await fixture();
  for (const f of [first, second]) await f.command('register', f.root, '--trust');
  const connections = [];
  for (const f of [first, second]) {
    const queried = await f.command('capabilities');
    expect(queried.code).toBe(0);
    expect(queried.response.ok).toBe(true);
    expect(queried.response.data.connection).toEqual({ dataRoot: resolve(f.dataRoot) });
    const client = new Client({ name: 'checkmate-connection-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.dataRoot, 'mcp'], stderr: 'pipe', env: f.childEnv });
    cleanup.push(async () => { await client.close(); await transport.close(); });
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(8192);
    const content = result.content as { type: string; text: string }[];
    const response = JSON.parse(content[0]!.text);
    expect(response.ok).toBe(true);
    expect(response.data.connection).toEqual(queried.response.data.connection);
    const listed = await client.callTool({ name: 'list_projects', arguments: {} });
    const projects = JSON.parse((listed.content as { text: string }[])[0]!.text);
    expect(projects).toMatchObject({ ok: true, data: { total: 1, items: [{ id: f.projectId }] } });
    connections.push(response.data.connection.dataRoot);
  }
  expect(connections[0]).not.toBe(connections[1]);
}, 30000);


it('네 독립 stdio MCP 세션은 단일 서비스의 이력을 유지하고 다른 owner의 취소와 위조를 거절하며 사람이 인계한다.', async () => {
  const f = await fixture();
  const reader = new Database(join(f.service.paths.state, 'checkmate.sqlite'), { readonly: true, fileMustExist: true }); cleanup.push(async () => { reader.close(); });
  const registered = (await f.command('register', f.root, '--trust')).response.data;
  const priorPlan = (await f.command('inspect', '--project', f.projectId, '--workspace', registered.workspaceId)).response.data;
  await f.command('approve', '--plan', priorPlan.planId, '--fingerprint', priorPlan.fingerprint, '--confirm');
  const prior = (await f.command('run', '--project', f.projectId, '--workspace', registered.workspaceId, '--plan', priorPlan.planId, '--request-id', randomUUID(), '--wait')).response;
  expect(prior.ok).toBe(true);
  const priorOriginal = (reader.prepare('SELECT summary_json FROM runs WHERE id=?').get(prior.data.runId) as { summary_json: string }).summary_json;
  await mkdir(join(f.root, '.runtime'));
  const definitionPath = join(f.root, 'checkmate', '프로젝트.json');
  const definition = JSON.parse(await readFile(definitionPath, 'utf8'));
  definition.commands[0].writes = ['.runtime']; definition.commands[0].timeoutMs = 30000;
  await writeFile(definitionPath, JSON.stringify(definition));
  await writeFile(join(f.root, 'scripts', '검사.mjs'), "// 합성 실행 횟수와 주입한 잠금 환경을 기록한 뒤 취소를 기다린다.\nimport { appendFileSync } from 'node:fs';\nappendFileSync('.runtime/횟수.txt',process.env.CHECKMATE_LOCK_DIR+'\\n');\nsetTimeout(()=>{},25000);\n");
  const synced = (await f.command('catalog', 'sync', '--project', f.projectId, '--workspace', registered.workspaceId)).response.data;
  await f.command('catalog', 'activate', '--project', f.projectId, '--workspace', registered.workspaceId, '--hash', synced.contentHash, '--confirm');
  const plan = (await f.command('inspect', '--project', f.projectId, '--workspace', registered.workspaceId)).response.data;
  expect((await f.command('approve', '--plan', plan.planId, '--fingerprint', plan.fingerprint, '--confirm')).response.ok).toBe(true);
  const ownerFile = join(f.service.paths.runtime, '서비스소유.json'), serviceOwner = await readFile(ownerFile, 'utf8');
  const connectClient = async (index: number) => {
    const client = new Client({ name: `독립 세션 ${index}`, version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.dataRoot, 'mcp'], stderr: 'pipe', env: f.childEnv });
    cleanup.push(async () => { await client.close(); await transport.close(); }); await client.connect(transport);
    const responses: unknown[] = [];
    const tool = async (name: string, argumentsValue: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: argumentsValue }); responses.push(result);
      return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, any>;
    };
    const capabilities = await tool('get_capabilities', {});
    expect(capabilities).toMatchObject({ ok: true, data: { connection: { dataRoot: f.dataRoot }, coordination: { lockRoot: f.lockRoot } } });
    expect(JSON.stringify(capabilities)).not.toMatch(/credential|ownerHash/u);
    return { client, transport, tool, responses, ownerId: capabilities.data.agentSession.ownerId as string };
  };
  const a = await connectClient(0);
  const requestId = randomUUID(), args = { projectId: f.projectId, workspaceId: registered.workspaceId, planId: plan.planId, requestId };
  // 첫 응답을 애플리케이션에서 버린 뒤 같은 요청을 재전송한다.
  const ignored = await a!.tool('start_run', args); expect(ignored.ok).toBe(true);
  const runId: string = ignored.data.runId;
  await vi.waitFor(async () => expect(await readFile(join(f.root, '.runtime', '횟수.txt'), 'utf8')).toBe(f.lockRoot + '\n'), { timeout: 10000 });
  const beforeRow = reader.prepare('SELECT workspace_id,plan_id,state,summary_json FROM runs WHERE id=?').get(runId);
  const beforeControl = f.service.product.runs.metadata(runId);
  expect(beforeRow).toMatchObject({ state: 'running' });
  const [b, c, d] = await Promise.all([1, 2, 3].map(connectClient));
  const clients = [a, b!, c!, d!];
  expect(new Set(clients.map(client => client.transport.pid)).size).toBe(4);
  expect(new Set(clients.map(client => client.ownerId)).size).toBe(4);
  expect(reader.prepare('SELECT workspace_id,plan_id,state,summary_json FROM runs WHERE id=?').get(runId)).toEqual(beforeRow);
  expect(f.service.product.runs.metadata(runId)).toEqual(beforeControl);
  expect(await readFile(ownerFile, 'utf8')).toBe(serviceOwner);
  expect(await readFile(join(f.root, '.runtime', '횟수.txt'), 'utf8')).toBe(f.lockRoot + '\n');
  expect(reader.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 2 });
  const replay = await a.tool('start_run', args); expect(replay).toMatchObject({ ok: true, data: { runId, reused: true, ownerId: a!.ownerId } });
  for (const other of [b!, c!, d!]) {
    expect(await other.tool('cancel_run', { runId })).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
    expect(await other.tool('start_run', args)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  }
  const forged = await b!.client.callTool({ name: 'cancel_run', arguments: { runId, ownerId: a!.ownerId } }); expect(forged.isError).toBe(true);
  expect(await a!.tool('get_run_status', { runId })).toMatchObject({ ok: true, data: { state: 'running', ownerId: a!.ownerId } });
  expect((await f.command('handoff', runId, '--owner', b!.ownerId, '--expected-owner', a!.ownerId, '--note', '합성 사람이 정확한 run과 owner를 확인했다.', '--confirm')).response).toMatchObject({ ok: true, data: { ownerId: b!.ownerId } });
  expect(await a!.tool('cancel_run', { runId })).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  expect(await a!.tool('start_run', args)).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  expect(await b!.tool('cancel_run', { runId })).toMatchObject({ ok: true, data: { state: 'cancelled', finalized: true, ownerId: b!.ownerId } });
  expect(await readFile(join(f.root, '.runtime', '횟수.txt'), 'utf8')).toBe(f.lockRoot + '\n');
  expect(await readFile(ownerFile, 'utf8')).toBe(serviceOwner);
  expect((reader.prepare('SELECT summary_json FROM runs WHERE id=?').get(prior.data.runId) as { summary_json: string }).summary_json).toBe(priorOriginal);
  expect(reader.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 2 });
  expect(reader.prepare("SELECT count(*) AS count FROM audit_events WHERE action='run-control-handed-off'").get()).toEqual({ count: 1 });
  for (const session of clients) expect(JSON.stringify(session.responses)).not.toMatch(/credential|ownerHash|owner_hash/u);
  if (process.env.CHECKMATE_TEST_LOCK_TRACE) await appendFile(process.env.CHECKMATE_TEST_LOCK_TRACE, JSON.stringify({ kind: 'four-mcp',
    dataRoot: f.dataRoot, lockRoot: f.lockRoot, childEnvLockRoot: f.childEnv.CHECKMATE_LOCK_DIR, nodeObservedLockRoot: f.lockRoot,
    mcpPids: clients.map(session => session.transport.pid), ownerIds: clients.map(session => session.ownerId),
    serviceOwner: JSON.parse(serviceOwner), priorRunId: prior.data.runId, runId, nodeSpawnCount: 1, historyOriginalPreserved: true }) + '\n');
}, 60000);
