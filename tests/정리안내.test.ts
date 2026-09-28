// 정리된 자원이 있어도 차단된 실행의 사람 확인 안내가 공개 CLI와 MCP에 전달되는지 검증한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, test } from 'vitest';
import type { ApiMethod, ApiRequest } from '@checkmate/contracts/api';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { requestLocal, serveLocal } from '../packages/engine/src/연결/로컬통신.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
const execute = promisify(execFile);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test('자원 정리 후에도 새 프로필 실행을 차단하고 이전 실행과 사람 확인 절차를 안내한다', async () => {
  const files = await createStoreFixture();
  cleanup.push(files.cleanup);
  const paths = dataPaths(join(files.directory, '관리 자료'));
  await prepareDataPaths(paths);
  const db = connectStore(join(paths.state, 'checkmate.sqlite'));
  cleanup.push(async () => { db.close(); });
  let executions = 0;
  const product = new ProductService(db, new EvidenceStore(db, paths.runs), async (_plan, initial) => {
    executions += 1;
    const id = randomUUID();
    const descriptor = { name: `cm-pg-${initial.runId}-${id}`, image: `postgres:17-alpine@sha256:${'b'.repeat(64)}`,
      endpoint: 'unix:///var/run/docker.sock', daemonId: 'synthetic-daemon' };
    product.resources.intent({ id, runId: initial.runId, kind: 'postgres-test', ownerTokenHash: 'a'.repeat(64), state: 'intent', cleanup: null, descriptor });
    product.resources.update(id, ['intent'], { state: 'cleaned', descriptor,
      cleanup: { verified: true, checkedAt: new Date().toISOString(), reason: '합성 컨테이너 부재 확인' } });
    return { ...initial, state: 'unverifiable', workerExitCode: 1, environmentVerified: false, evidenceVerified: false, cleanupVerified: false };
  }, paths);
  const endpoint = await serveLocal(paths, (request, role) => product.handle(request, role));
  cleanup.push(endpoint.close);
  const call = (method: ApiMethod, input: ApiRequest['input']) =>
    product.handle({ apiVersion: 1, requestId: randomUUID(), method, input }, 'human');
  const root = join(files.directory, '합성 프로젝트');
  const projectId = randomUUID();
  await mkdir(join(root, 'checkmate'), { recursive: true });
  await writeFile(join(root, '검사.mjs'), '// 실제 소스 지문을 위한 합성 검사 파일이다.\n');
  await writeFile(join(root, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId, name: '정리 안내 합성 프로젝트', repositoryIdentity: 'synthetic:cleanup-guidance',
    commands: [{ id: 'command-1', title: '합성 검사', runtime: 'node', entry: '검사.mjs', args: [], timeoutMs: 1000, env: {}, writes: [], resultFormat: 'exit-code' }],
    profiles: ['postgres', 'quick'].map(id => ({ id, title: '합성 프로필', checkIds: ['check-1'] })) }));
  await writeFile(join(root, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'req-1', title: '정리 확인', description: '새 실행 차단과 안내를 확인한다.' }]));
  await writeFile(join(root, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'check-1', title: '정리 검사', requirementId: 'req-1', commandId: 'command-1', required: true,
    kind: 'logic', expected: '확인 전에는 새 실행을 차단한다.', codePaths: ['검사.mjs'] }]));
  expect(await call('register', { path: root })).toMatchObject({ ok: true });
  async function approvedPlan(profile: string) {
    const review = await call('inspect', { projectId, profile });
    if (!review.ok) throw new Error(`계획 조회 실패: ${review.error.code}`);
    const plan = review.data as { planId: string; fingerprint: string };
    expect(await call('approve', { planId: plan.planId, fingerprint: plan.fingerprint })).toMatchObject({ ok: true });
    return plan.planId;
  }
  const started = await call('start', { projectId, planId: await approvedPlan('postgres') });
  if (!started.ok) throw new Error(`실행 접수 실패: ${started.error.code}`);
  const runId = (started.data as { runId: string }).runId;
  const original = await product.execution.wait(runId);
  expect(original).toMatchObject({ state: 'unverifiable', verdict: 'unknown', finalized: true, cases: [], workerExitCode: 1, cleanupVerified: false });
  const resources = await call('resources', { runId });
  expect(resources).toMatchObject({ ok: true, data: { items: [{ state: 'cleaned', cleanup: { verified: true } }] } });
  const cli = resolve('packages/engine/dist/명령.js');
  const client = new Client({ name: 'cleanup-guidance-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', paths.root, 'mcp'], stderr: 'pipe' });
  cleanup.push(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  for (const profile of ['postgres', 'quick']) {
    const planId = await approvedPlan(profile);
    const requestId = randomUUID();
    let cliResponse;
    try {
      await execute(process.execPath, [cli, '--data-dir', paths.root, '--json', 'run', '--project', projectId, '--plan', planId, '--request-id', requestId], { windowsHide: true, timeout: 12000 });
      throw new Error('정리 미확인 실행을 잘못 접수했습니다.');
    } catch (error) {
      if (!(error instanceof Error) || !('stdout' in error) || typeof error.stdout !== 'string') throw error;
      expect(error).toMatchObject({ code: 5, stderr: '' });
      cliResponse = JSON.parse(error.stdout);
    }
    expect(cliResponse).toMatchObject({ ok: false, requestId, error: { code: 'ownership-unknown', retryable: false,
      message: expect.stringContaining(runId), nextAction: expect.stringContaining(`acknowledge-cleanup ${runId}`) } });
    for (const text of ['작업자', '자손 프로세스', '사람', '같은 자료 폴더', '--confirm', '--note', 'AI']) expect(cliResponse.error.nextAction).toContain(text);
    const mcpResponse = await client.callTool({ name: 'start_run', arguments: { projectId, planId, requestId } });
    expect(mcpResponse.isError).toBe(true);
    expect(JSON.parse((mcpResponse.content as { text: string }[])[0]!.text)).toEqual(cliResponse);
    expect(Buffer.byteLength(JSON.stringify(mcpResponse), 'utf8')).toBeLessThanOrEqual(8192);
  }
  expect(await requestLocal(paths, { apiVersion: 1, requestId: randomUUID(), method: 'acknowledge-cleanup',
    input: { runId, confirm: true, note: '에이전트가 사람 확인을 대행하는 합성 요청' } }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  expect(executions).toBe(1);
  expect(product.runs.getRun(runId)).toEqual(original);
  expect(await call('resources', { runId })).toMatchObject({ ok: true, data: resources.ok ? resources.data : null });
  expect(db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 });
  expect(db.prepare("SELECT count(*) AS count FROM audit_events WHERE action='cleanup-acknowledged'").get()).toEqual({ count: 0 });
}, 30000);
