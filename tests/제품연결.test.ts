// 실제 CLI와 stdio MCP가 같은 서비스의 승인된 실행과 증거를 조회하는지 확인한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
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
    commands: [{ id: 'quick-command', title: '합성 빠른 검사', runtime: 'node', entry: 'scripts/검사.mjs', args: [], timeoutMs: 5000, env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'exit-code' }],
    profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1'] }] }));
  await writeFile(join(root, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'requirement-1', title: '종료 확인', description: '실제 종료코드를 확인한다.' }]));
  await writeFile(join(root, 'checkmate', '검사항목.json'), JSON.stringify([{ id: 'check-1', title: '종료 검사', requirementId: 'requirement-1', commandId: 'quick-command', required: true, kind: 'logic', expected: '실제 종료코드가 0이다.', codePaths: ['scripts/검사.mjs'] }]));
  const dataRoot = join(f.directory, '관리 자료');
  const service = await startLocalService(dataRoot);
  cleanup.push(service.close);
  async function command(...args: string[]) {
    try {
      const result = await execute(process.execPath, [cli, '--data-dir', dataRoot, '--json', ...args], { timeout: 12000, windowsHide: true });
      expect(result.stderr).toBe('');
      return { code: 0, response: JSON.parse(result.stdout) as Record<string, any> };
    } catch (error) {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && 'code' in error) return { code: error.code, response: JSON.parse(error.stdout) as Record<string, any> };
      throw error;
    }
  }
  return { root, dataRoot, service, projectId, command };
}

it('CLI 등록과 승인 후 실행하고 MCP에서 같은 확정 결과와 증거를 조회한다', async () => {
  const f = await fixture();
  expect((await f.command('register', f.root, '--trust')).response.ok).toBe(true);
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.dataRoot, 'mcp'], stderr: 'pipe' });
  cleanup.push(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const result = await client.callTool({ name: 'get_run_result', arguments: { runId, section: 'summary' } });
  expect(result.isError).toBe(false);
  const content = result.content as { type: string; text: string }[];
  expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, data: { runId, verdict: 'passed', integrity: 'verified' } });
  const cases = (await f.command('result', runId, '--section', 'cases')).response.data.items;
  const requirements = (await f.command('result', runId, '--section', 'requirements')).response.data.items;
  expect(requirements).toMatchObject([{ requirementId: 'requirement-1', status: 'passed', selectedChecks: ['check-1'] }]);
  const backup = (await f.command('backup')).response;
  expect(backup).toMatchObject({ ok: true, data: { includesConnectionSecret: false } });
  const restoredRoot = join(f.dataRoot, '..', '복구 자료');
  expect((await f.command('restore', backup.data.backupDirectory, '--target', restoredRoot)).code).toBe(3);
  const restored = (await f.command('restore', backup.data.backupDirectory, '--target', restoredRoot, '--confirm')).response;
  expect(restored).toMatchObject({ ok: true, data: { dataRoot: restoredRoot, switched: false } });
  const restoredService = await startLocalService(restoredRoot);
  cleanup.push(restoredService.close);
  const preserved = await restoredService.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'result', input: { runId, section: 'summary' } }, 'human');
  expect(preserved).toMatchObject({ ok: true, data: { runId, verdict: 'passed', integrity: 'verified' } });
  expect(await f.service.product.handle({ apiVersion: 1, requestId: randomUUID(), method: 'backup', input: {} }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  const evidenceId: string = cases[0].evidenceIds[0];
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
  await expect(startLocalService(f.dataRoot)).rejects.toMatchObject({ code: 'service-already-running' });
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
