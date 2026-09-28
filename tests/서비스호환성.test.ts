// 실제 CLI와 MCP가 구 서비스의 기능 부족을 알리고 기존 연결과 권한을 보존하는지 검증한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { errorResponse, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest } from '@checkmate/contracts/api';
import { afterEach, expect, it } from 'vitest';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { serveLocal } from '../packages/engine/src/연결/로컬통신.js';
import { callService } from '../packages/engine/src/서비스/클라이언트.js';

const cleanups: (() => Promise<void>)[] = [];
const execute = promisify(execFile);
const cli = resolve('packages/engine/dist/명령.js');
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'checkmate-compat-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  await prepareDataPaths(paths);
  const owner = join(paths.runtime, '서비스소유.json');
  const ownership = JSON.stringify({ id: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() });
  await writeFile(owner, ownership);
  let capabilities: unknown = { version: '0.1.0-alpha.1', capabilities: ['projects', 'evidence'] };
  let probeError: ServiceError | null = null;
  const requests: ApiRequest[] = [];
  const roles: string[] = [];
  const projectId = randomUUID();
  const service = await serveLocal(paths, async (request, role) => {
    requests.push(request); roles.push(role);
    if (request.method === 'capabilities') return probeError ? errorResponse(request.requestId, probeError)
      : { apiVersion: 1, requestId: request.requestId, ok: true, data: capabilities };
    if (request.method === 'projects') return { apiVersion: 1, requestId: request.requestId, ok: true, data: { items: [{ id: projectId }], total: 1, nextCursor: null } };
    if (request.method === 'evidence-image') return errorResponse(request.requestId, new ServiceError('evidence-restricted'));
    return errorResponse(request.requestId, new ServiceError('invalid-input'));
  });
  cleanups.push(service.close);
  const command = async (...args: string[]) => {
    try {
      const result = await execute(process.execPath, [cli, '--data-dir', root, '--json', ...args], { windowsHide: true, timeout: 10000 });
      return { code: 0, response: JSON.parse(result.stdout), stderr: result.stderr };
    } catch (error) {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && 'code' in error)
        return { code: error.code, response: JSON.parse(error.stdout), stderr: 'stderr' in error ? error.stderr : '' };
      throw error;
    }
  };
  return { paths, service, owner, ownership, requests, roles, projectId, command,
    capabilities: (value: unknown) => { capabilities = value; }, probeError: (value: ServiceError | null) => { probeError = value; } };
}
const request = (method: ApiRequest['method'], input: ApiRequest['input'] = {}): ApiRequest => ({ apiVersion: 1, requestId: randomUUID(), method, input });

it('구 서비스의 실제 CLI와 MCP 조회는 유지하고 공개 PNG만 기능 부족으로 안내한다', async () => {
  const f = await fixture();
  const queried = await f.command('capabilities');
  expect(queried).toMatchObject({ code: 0, stderr: '', response: { ok: true, data: { capabilities: ['projects', 'evidence'], clientCompatibility: {
    status: 'limited', checkedFeatures: ['connection-data-root', 'public-images'], missingFeatures: ['connection-data-root', 'public-images'],
  } } } });
  expect(queried.response.data).not.toHaveProperty('connection');
  expect(queried.response.data.clientCompatibility.nextAction).toContain('강제 종료하지 말고');
  expect((await f.command('projects')).response).toMatchObject({ ok: true, data: { items: [{ id: f.projectId }] } });
  const input = { runId: randomUUID(), evidenceId: randomUUID() };
  const denied = await f.command('evidence-image', input.runId, input.evidenceId);
  expect(denied).toMatchObject({ code: 6, stderr: '', response: { ok: false, error: { code: 'service-update-required', retryable: false } } });
  expect(denied.response.error.nextAction).toContain('60초');

  const client = new Client({ name: 'compatibility-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.paths.root, 'mcp'], stderr: 'pipe' });
  cleanups.push(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const cap = await client.callTool({ name: 'get_capabilities', arguments: {} });
  const capData = JSON.parse((cap.content as { text: string }[])[0]!.text);
  expect(capData.data).toEqual(queried.response.data);
  expect(cap.isError).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(cap), 'utf8')).toBeLessThanOrEqual(8192);
  const images = await client.callTool({ name: 'get_evidence_image', arguments: input });
  expect(images.isError).toBe(true);
  expect(JSON.parse((images.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false, error: { code: 'service-update-required', retryable: false } });
  expect(f.requests.filter((r) => r.method === 'evidence-image')).toHaveLength(0);
  const listed = await client.callTool({ name: 'list_projects', arguments: {} });
  expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toMatchObject({ ok: true, data: { items: [{ id: f.projectId }] } });
  expect(f.roles[f.requests.findLastIndex((r) => r.method === 'projects')]).toBe('agent');
  expect(await readFile(f.owner, 'utf8')).toBe(f.ownership);
  expect(f.service.server.listening).toBe(true);
}, 30000);

it('같은 버전 문자열의 최신 응답을 매번 확인하고 실제 이미지 접근 제한을 유지한다', async () => {
  const f = await fixture();
  const input = { runId: randomUUID(), evidenceId: randomUUID() };
  expect(await callService(request('evidence-image', input), { dataRoot: f.paths.root }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'service-update-required' } });
  f.capabilities({ version: '0.1.0-alpha.1', connection: { dataRoot: f.paths.root }, capabilities: ['projects', 'public-images'] });
  expect((await f.command('capabilities')).response).toMatchObject({ ok: true, data: { connection: { dataRoot: f.paths.root },
    clientCompatibility: { status: 'supported', missingFeatures: [], nextAction: null } } });
  expect(await callService(request('evidence-image', input), { dataRoot: f.paths.root }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'evidence-restricted' } });
  expect(f.requests.filter((r) => r.method === 'evidence-image')).toHaveLength(1);
  expect(f.roles[f.requests.findIndex((r) => r.method === 'evidence-image')]).toBe('agent');
  expect(await callService(request('approve'), { dataRoot: f.paths.root }, 'agent'))
    .toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  expect(f.requests.filter((r) => r.method === 'approve')).toHaveLength(0);
  f.capabilities({ version: '0.1.0-alpha.1', connection: null, capabilities: ['public-images'] });
  expect((await f.command('capabilities')).response).toMatchObject({ ok: true, data: { connection: null,
    clientCompatibility: { status: 'limited', missingFeatures: ['connection-data-root'] } } });
  expect(await readFile(f.owner, 'utf8')).toBe(f.ownership);
});

it('기능 조회 자체가 실패하면 원래 오류와 요청 ID를 보존하고 후속 명령을 보내지 않는다', async () => {
  const f = await fixture();
  f.probeError(new ServiceError('storage-error', '합성 저장 오류', false, '합성 진단을 확인하세요.'));
  const query = request('evidence-image', { runId: randomUUID(), evidenceId: randomUUID() });
  expect(await callService(query, { dataRoot: f.paths.root }, 'agent')).toMatchObject({ requestId: query.requestId, ok: false,
    error: { code: 'storage-error', message: '합성 저장 오류', retryable: false, nextAction: '합성 진단을 확인하세요.' } });
  expect(f.requests.map((r) => r.method)).toEqual(['capabilities']);
  expect(f.service.server.listening).toBe(true);
  expect(await readFile(f.owner, 'utf8')).toBe(f.ownership);
});
