// 실제 CLI와 MCP가 구 서비스의 기능 부족을 알리고 기존 연결과 권한을 보존하는지 검증한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { errorResponse, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest } from '@checkmate/contracts/api';
import { afterEach, expect, it } from 'vitest';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { serveLocal } from '../packages/engine/src/연결/로컬통신.js';
import { createStoreFixture } from './저장시험자료.js';
import { callService, createAgentInvoker } from '../packages/engine/src/서비스/클라이언트.js';
import { guiProjectInput, guiSupports, guiWorkspaceMatches } from '../packages/desktop/src/renderer/앱.js';

const cleanups: (() => Promise<void>)[] = [];
const execute = promisify(execFile);
const cli = resolve('packages/engine/dist/명령.js');
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const f = await createStoreFixture(); cleanups.push(f.cleanup);
  const root = join(f.directory, '관리자료');
  const childEnv = { ...process.env, CHECKMATE_LOCK_DIR: join(f.directory, '공유잠금') };
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
  let guiRead: { workspaceId: string; runId: string } | null = null;
  const service = await serveLocal(paths, async (request, role) => {
    requests.push(request); roles.push(role);
    if (request.method === 'capabilities') return probeError ? errorResponse(request.requestId, probeError)
      : { apiVersion: 1, requestId: request.requestId, ok: true, data: capabilities };
    if (request.method === 'projects') return { apiVersion: 1, requestId: request.requestId, ok: true, data: { items: [guiRead
      ? { id: projectId, workspaceId: guiRead.workspaceId, name: '합성 구 서비스', realPath: f.directory, repositoryIdentity: 'synthetic:legacy', profiles: [], activeCatalogHash: 'a'.repeat(64) }
      : { id: projectId }], total: 1, nextCursor: null } };
    if (guiRead && ['checks', 'history', 'gaps'].includes(request.method)) return { apiVersion: 1, requestId: request.requestId, ok: true,
      data: { items: [], total: 0, nextCursor: null } };
    if (guiRead && request.method === 'inspect') return { apiVersion: 1, requestId: request.requestId, ok: true,
      data: { projectId, planId: randomUUID(), fingerprint: 'b'.repeat(64), needsApproval: true } };
    if (guiRead && request.method === 'result') return { apiVersion: 1, requestId: request.requestId, ok: true,
      data: { projectId, runId: guiRead.runId, state: 'unverifiable', verdict: 'unknown', finalized: true } };
    if (guiRead && request.method === 'start' && role === 'human') return { apiVersion: 1, requestId: request.requestId, ok: true,
      data: { runId: guiRead.runId, reused: false } };
    if (request.method === 'evidence-image') return errorResponse(request.requestId, new ServiceError('evidence-restricted'));
    return errorResponse(request.requestId, new ServiceError('invalid-input'));
  });
  cleanups.push(service.close);
  const command = async (...args: string[]) => {
    try {
      const result = await execute(process.execPath, [cli, '--data-dir', root, '--json', ...args], { windowsHide: true, timeout: 10000, env: childEnv });
      return { code: 0, response: JSON.parse(result.stdout), stderr: result.stderr };
    } catch (error) {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && 'code' in error)
        return { code: error.code, response: JSON.parse(error.stdout), stderr: 'stderr' in error ? error.stderr : '' };
      throw error;
    }
  };
  return { paths, service, childEnv, owner, ownership, requests, roles, projectId, command,
    guiRead: (workspaceId: string, runId: string) => { guiRead = { workspaceId, runId }; },
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.paths.root, 'mcp'], stderr: 'pipe', env: f.childEnv });
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


it('새 클라이언트는 구 서비스에 제어 또는 workspace 작업을 보내지 않고 조회를 보존한다.', async () => {
  const f = await fixture(), invoke = createAgentInvoker({ dataRoot: f.paths.root, lockRoot: f.childEnv.CHECKMATE_LOCK_DIR });
  for (const query of [request('start', { projectId: f.projectId, planId: randomUUID() }), request('cancel', { runId: randomUUID() })])
    expect(await invoke(query)).toMatchObject({ ok: false, error: { code: 'service-update-required' } });
  expect(await invoke(request('projects'))).toMatchObject({ ok: true });
  expect(await callService(request('checks', { projectId: f.projectId, workspaceId: randomUUID() }), { dataRoot: f.paths.root })).toMatchObject({ ok: false, error: { code: 'service-update-required' } });
  expect(f.requests.some(r => ['open-agent-session', 'start', 'cancel', 'checks'].includes(r.method))).toBe(false);
  expect(await readFile(f.owner, 'utf8')).toBe(f.ownership);
  const client = new Client({ name: '구 서비스 거부 검사', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--data-dir', f.paths.root, 'mcp'], stderr: 'pipe', env: f.childEnv });
  cleanups.push(async () => { await client.close(); await transport.close(); }); await client.connect(transport);
  const denied = await client.callTool({ name: 'start_run', arguments: { projectId: f.projectId, planId: randomUUID(), requestId: randomUUID() } });
  expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false, error: { code: 'service-update-required' } });
  const listed = await client.callTool({ name: 'list_projects', arguments: {} });
  expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toMatchObject({ ok: true });
  expect(f.requests.some(r => ['start', 'cancel', 'open-agent-session'].includes(r.method))).toBe(false);
}, 30000);

it('GUI의 실제 legacy 단일대상 협상은 기존 조회와 inspect 및 human start만 유지한다.', async () => {
  const f = await fixture(), workspaceId = randomUUID(), runId = randomUUID(); f.guiRead(workspaceId, runId);
  const options = { dataRoot: f.paths.root, lockRoot: f.childEnv.CHECKMATE_LOCK_DIR };
  const capabilities = await callService(request('capabilities'), options);
  const projects = await callService(request('projects'), options);
  expect(capabilities.ok && projects.ok).toBe(true);
  if (!capabilities.ok || !projects.ok) throw new Error('합성 구서비스 조회 실패');
  const page = projects.data as { items: { id: string; workspaceId: string }[]; total: number; nextCursor: null };
  const input = guiProjectInput(capabilities.data, page, f.projectId, workspaceId);
  expect(input).toEqual({ projectId: f.projectId });
  for (const method of ['checks', 'history', 'gaps', 'inspect'] as const) {
    const result = await callService(request(method, { ...input, ...(method === 'inspect' ? { profile: 'quick' } : {}) }), options);
    expect(result.ok).toBe(true);
    if (method === 'inspect' && result.ok) expect(guiWorkspaceMatches(capabilities.data, page, f.projectId, workspaceId, result.data as { projectId: string })).toBe(true);
  }
  const result = await callService(request('result', { runId, section: 'summary' }), options); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('합성 결과 조회 실패');
  expect(guiWorkspaceMatches(capabilities.data, page, f.projectId, workspaceId, result.data as { projectId: string })).toBe(true);
  expect(result.data).not.toHaveProperty('workspaceId'); expect(result.data).not.toHaveProperty('ownerId');
  expect(guiSupports(capabilities.data, 'run-handoff')).toBe(false);
  expect(await callService(request('start', { ...input, planId: randomUUID() }), options, 'human')).toMatchObject({ ok: true, data: { runId } });
  const protectedAgent = createAgentInvoker(options);
  expect(await protectedAgent(request('start', { ...input, planId: randomUUID() }))).toMatchObject({ ok: false, error: { code: 'service-update-required' } });
  for (const recorded of f.requests.filter(item => ['checks', 'history', 'gaps', 'inspect', 'start'].includes(item.method))) expect(recorded.input).not.toHaveProperty('workspaceId');
  expect(f.requests.filter(item => item.method === 'start')).toHaveLength(1);
  expect(await readFile(f.owner, 'utf8')).toBe(f.ownership);
});

it('GUI legacy는 다중대상과 페이지 미확인 및 기능 미확인 선택을 생략하지 않는다.', () => {
  const id = randomUUID(), workspaceId = randomUUID(), legacy = { capabilities: ['projects'] };
  const page = { items: [{ id, workspaceId }], total: 1, nextCursor: null };
  for (const ambiguous of [
    { ...page, items: [...page.items, { id, workspaceId: randomUUID() }], total: 2 },
    { ...page, total: 2 }, { ...page, nextCursor: 'more' },
  ]) expect(() => guiProjectInput(legacy, ambiguous, id, workspaceId)).toThrow();
  for (const missing of [null, {}, { capabilities: ['projects', 1] }]) expect(() => guiProjectInput(missing, page, id, workspaceId)).toThrow();
  expect(() => guiProjectInput(legacy, page, id, randomUUID())).toThrow();
  expect(guiWorkspaceMatches(legacy, page, id, workspaceId, { projectId: randomUUID() })).toBe(false);
  expect(guiWorkspaceMatches(legacy, page, id, workspaceId, { projectId: id, workspaceId: randomUUID() })).toBe(false);
});

it('GUI 새 서비스는 작업 폴더를 명시하고 없는 또는 다른 metadata를 수용하지 않는다.', () => {
  const id = randomUUID(), a = randomUUID(), b = randomUUID();
  const page = { items: [{ id, workspaceId: a }, { id, workspaceId: b }], total: 2, nextCursor: null };
  const current = { capabilities: ['projects', 'multi-workspace', 'run-handoff'] };
  expect(guiProjectInput(current, page, id, b)).toEqual({ projectId: id, workspaceId: b });
  expect(guiWorkspaceMatches(current, page, id, b, { projectId: id })).toBe(false);
  expect(guiWorkspaceMatches(current, page, id, b, { projectId: id, workspaceId: a })).toBe(false);
  expect(guiWorkspaceMatches(current, page, id, b, { projectId: id, workspaceId: b })).toBe(true);
  expect(guiSupports(current, 'run-handoff')).toBe(true);
  expect(guiSupports({ capabilities: ['projects'] }, 'run-handoff')).toBe(false);
});
