// 공식 MCP 클라이언트로 도구 노출과 요청 중복 식별자 및 응답 상한을 확인한다.
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it } from 'vitest';
import type { ApiRequest } from '@checkmate/contracts/api';
import { createAgentServer } from '../packages/engine/src/연결/에이아이서버.js';
import type { AgentInvoker } from '../packages/engine/src/연결/에이아이서버.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function connect(invoke: AgentInvoker) {
  const server = createAgentServer(invoke);
  const client = new Client({ name: 'checkmate-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

it('사람 승인과 임의 명령 도구를 노출하지 않고 실제 SDK로 준비 상태를 조회한다', async () => {
  const calls: ApiRequest[] = [];
  const client = await connect(async (request) => { calls.push(request); return { apiVersion: 1, requestId: request.requestId, ok: true, data: { ready: true } }; });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toHaveLength(12);
  expect(names).toContain('inspect_project');
  expect(names).not.toContain('approve');
  expect(names).not.toContain('register');
  expect(names).not.toContain('execute_command');
  const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
  expect(result.isError).toBe(false);
  expect(calls[0]).toMatchObject({ method: 'capabilities', input: {} });
});

it('같은 start_run 요청 ID를 서비스에 그대로 전달하고 알 수 없는 입력 키를 거절한다', async () => {
  const calls: ApiRequest[] = [];
  const client = await connect(async (request) => { calls.push(request); return { apiVersion: 1, requestId: request.requestId, ok: true, data: { accepted: true } }; });
  const args = { projectId: randomUUID(), planId: randomUUID(), requestId: randomUUID() };
  await client.callTool({ name: 'start_run', arguments: args });
  await client.callTool({ name: 'start_run', arguments: args });
  expect(calls.map((call) => call.requestId)).toEqual([args.requestId, args.requestId]);
  expect(calls[0]?.input).toEqual({ projectId: args.projectId, planId: args.planId });
  const invalid = await client.callTool({ name: 'start_run', arguments: { ...args, command: 'arbitrary' } });
  expect(invalid.isError).toBe(true);
  expect(calls).toHaveLength(2);
});

it('과대 JSON 응답을 중간에서 자르지 않고 제한된 오류로 돌려준다', async () => {
  const client = await connect(async (request) => ({ apiVersion: 1, requestId: request.requestId, ok: true, data: { text: '한글'.repeat(20000) } }));
  const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
  expect(result.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(8192);
  expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('response-too-large') })]));
});
