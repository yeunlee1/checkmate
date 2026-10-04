// 관리형 stdio 브리지의 세대 전환과 이전 자격 보호 및 변경 요청 재전송 금지를 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { errorResponse, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import { createManagedInvoker } from '../packages/engine/src/연결/관리형브리지.js';
import { managedDirectory, managedRootKey } from '../packages/engine/src/연결/관리연결계약.js';
import { SessionControl } from '../packages/engine/src/연결/세션제어.js';
import type { DataPaths } from '../packages/engine/src/연결/개인경로.js';
import type { ClientRole } from '../packages/engine/src/연결/로컬통신.js';

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../packages/engine/src/연결/로컬통신.js', () => ({ requestLocal: transport.send }));
type Backend = { version: string; sessions: SessionControl; opened: number; capOverride?: unknown;
  calls: ApiRequest[]; runs: Map<string, string>; startGate?: Promise<void>; loseStart?: boolean;
  admitted: Map<string, { hash: string; runId: string; ownerId: string }>; probes: number;
  onCapabilities?: () => void; beforeOpen?: () => void; afterOpen?: () => void; reportedRoot?: string };
const temporary: string[] = [], services = new Map<string, Backend>();
beforeEach(() => {
  services.clear(); transport.send.mockReset();
  transport.send.mockImplementation(async (paths: DataPaths, request: ApiRequest, _role: ClientRole, credential?: string): Promise<ApiResponse> => {
    const backend = services.get(paths.root)!;
    backend.calls.push(request);
    const ok = (data: unknown): ApiResponse => ({ apiVersion: 1, requestId: request.requestId, ok: true, data });
    try {
      if (request.method === 'capabilities') { backend.probes++; backend.onCapabilities?.(); }
      const owner = credential === undefined ? undefined : backend.sessions.verify(credential);
      if (request.method === 'capabilities') return ok(backend.capOverride ?? { apiVersion: 1, version: backend.version,
        serviceEpoch: backend.sessions.epoch, connection: { dataRoot: backend.reportedRoot ?? paths.root }, capabilities: ['mcp', 'agent-run-control', 'public-images'],
        agentSession: owner ? { ownerId: owner.ownerId, serviceEpoch: owner.serviceEpoch } : null });
      if (request.method === 'open-agent-session') {
        backend.beforeOpen?.(); backend.opened++;
        const session = backend.sessions.open(); backend.afterOpen?.(); return ok(session);
      }
      if (request.method === 'start') {
        const control = backend.sessions.assert(owner), hash = createHash('sha256').update(JSON.stringify(request.input)).digest('hex');
        const previous = backend.admitted.get(request.requestId);
        if (previous) {
          if (previous.ownerId !== control.ownerId) throw new ServiceError('run-owner-mismatch');
          if (previous.hash !== hash) throw new ServiceError('request-conflict');
          return ok({ runId: previous.runId, reused: true, dataRoot: paths.root });
        }
        const runId = randomUUID();
        backend.admitted.set(request.requestId, { hash, runId, ownerId: control.ownerId });
        backend.runs.set(runId, control.ownerId);
        await backend.startGate;
        if (backend.loseStart) throw new ServiceError('service-disconnected');
        return ok({ runId, reused: false, dataRoot: paths.root });
      }
      if (request.method === 'cancel') {
        const control = backend.sessions.assert(owner);
        if (backend.runs.get(String(request.input.runId)) !== control.ownerId) throw new ServiceError('run-owner-mismatch');
        return ok({ cancelled: true });
      }
      return ok({ dataRoot: paths.root, items: [] });
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'service-disconnected') throw error;
      return errorResponse(request.requestId, error);
    }
  });
});
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
const request = (method: ApiRequest['method'], input: ApiRequest['input'] = {}): ApiRequest => ({ apiVersion: 1, requestId: randomUUID(), method, input });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'CheckMate 관리형 브리지 ')); temporary.push(base);
  const installation = join(base, '설치 경로'), root = join(base, '자료 루트 A');
  await mkdir(join(managedDirectory(installation), '자료'), { recursive: true });
  await writeFile(join(installation, 'Update.exe'), '합성 설치 파일');
  let generation: string = randomUUID();
  const publish = async (version = '0.2.0', nextGeneration: string = randomUUID()) => {
    const resources = join(installation, `app-${version}`, 'resources');
    await mkdir(join(resources, 'node'), { recursive: true });
    await mkdir(join(resources, 'engine', 'packages', 'engine', 'dist', '서비스'), { recursive: true });
    await writeFile(join(resources, 'node', 'node.exe'), '합성 Node');
    await writeFile(join(resources, 'engine', 'packages', 'engine', 'dist', '서비스', '상주서비스.js'), '// 합성 서비스');
    await writeFile(join(resources, 'engine', 'packages', 'engine', 'package.json'), JSON.stringify({ version }));
    generation = nextGeneration;
    await writeFile(join(managedDirectory(installation), '백엔드.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'checkmate-managed-backend', installationRoot: installation, version, generation }));
  };
  const register = async (path: string) => {
    await mkdir(join(path, 'runtime'), { recursive: true });
    await writeFile(join(path, 'runtime', '연결비밀'), '합성 비밀 표식');
    await writeFile(join(managedDirectory(installation), '자료', `${managedRootKey(path)}.json`), JSON.stringify({
      schemaVersion: 1, kind: 'checkmate-managed-root', installationRoot: installation, dataRoot: path }));
    const backend: Backend = { version: '0.2.0', sessions: new SessionControl(), opened: 0, calls: [], runs: new Map(), admitted: new Map(), probes: 0 };
    services.set(path, backend); return backend;
  };
  await publish('0.2.0', generation);
  const backend = await register(root);
  return { base, installation, root, backend, register, publish, generation: () => generation,
    invoke: createManagedInvoker(installation, root) };
}

test('동일 세대 조회와 실행은 하나의 자격을 재사용하고 승인된 버전 증가만 새 자격을 만든다', async () => {
  const f = await fixture();
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: true });
  const started = await f.invoke(request('start'));
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('합성 실행 실패');
  const runId = (started.data as { runId: string }).runId;
  expect(f.backend.opened).toBe(1);
  expect(await f.invoke(request('capabilities'))).toMatchObject({ ok: true });
  expect(f.backend.opened).toBe(1);
  await f.publish('0.2.1'); f.backend.version = '0.2.1'; f.backend.sessions = new SessionControl();
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: true });
  expect(f.backend.opened).toBe(2);
  expect(await f.invoke(request('cancel', { runId }))).toMatchObject({ ok: false, error: { code: 'run-owner-mismatch' } });
  expect(await f.invoke(request('start'))).toMatchObject({ ok: true });
});

test('epoch만 바뀌면 실제 기존 invoker의 읽기는 복구하며 start와 cancel 및 자격 재발급은 차단한다', async () => {
  const f = await fixture();
  expect(await f.invoke(request('capabilities'))).toMatchObject({ ok: true });
  f.backend.sessions = new SessionControl();
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: true });
  expect(await f.invoke(request('capabilities'))).toMatchObject({ ok: true });
  for (const method of ['start', 'cancel'] as const)
    expect(await f.invoke(request(method))).toMatchObject({ ok: false, error: { code: 'agent-control-required' } });
  expect(f.backend.opened).toBe(1);
  expect(f.backend.calls.filter(call => ['start', 'cancel'].includes(call.method))).toHaveLength(0);
});

test('동일 버전의 generation 교체와 감소 및 증가하면서 generation 또는 epoch를 유지하면 거절한다', async () => {
  const f = await fixture();
  await f.invoke(request('projects'));
  const originalGeneration = f.generation();
  await f.publish('0.2.0');
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: false, error: { code: 'managed-generation-mismatch' } });
  await f.publish('0.1.9');
  expect(await f.invoke(request('start'))).toMatchObject({ ok: false, error: { code: 'managed-version-downgrade' } });
  await f.publish('0.2.1', originalGeneration);
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: false, error: { code: 'managed-generation-mismatch' } });
  await f.publish('0.2.1'); f.backend.version = '0.2.1';
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: false, error: { code: 'managed-service-epoch-mismatch' } });
  expect(f.backend.opened).toBe(1);
});

test('실제 capabilities의 다른 root와 구 endpoint 및 비호환 API와 epoch 누락은 원 요청을 보내지 않는다', async () => {
  const f = await fixture();
  const valid = { apiVersion: 1, version: '0.2.0', serviceEpoch: f.backend.sessions.epoch,
    connection: { dataRoot: f.root }, capabilities: ['mcp', 'agent-run-control'] };
  for (const [override, code] of [
    [{ ...valid, connection: { dataRoot: f.base } }, 'managed-root-mismatch'],
    [{ ...valid, version: '0.1.0' }, 'managed-service-version-mismatch'],
    [{ ...valid, apiVersion: 2 }, 'managed-service-incompatible'],
    [{ ...valid, serviceEpoch: undefined }, 'managed-service-incompatible'],
  ] as const) {
    f.backend.capOverride = override;
    expect(await f.invoke(request('start'))).toMatchObject({ ok: false, error: { code } });
  }
  expect(f.backend.opened).toBe(0);
  expect(f.backend.calls.every(call => call.method === 'capabilities')).toBe(true);
  await writeFile(join(managedDirectory(f.installation), '백엔드.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'checkmate-managed-backend', installationRoot: f.base, version: '0.2.0', generation: randomUUID() }));
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: false, error: { code: 'managed-installation-mismatch' } });
});

test('설치 중 원본 Node가 없어도 update-in-progress를 반환하고 같은 invoker는 잠금 해제 후 계속 사용한다', async () => {
  const f = await fixture();
  const lock = join(f.installation, '업데이트잠금.json');
  await writeFile(lock, JSON.stringify({ id: randomUUID(), pid: process.pid }));
  await rm(join(f.installation, 'app-0.2.0', 'resources', 'node', 'node.exe'));
  const query = request('projects');
  expect(await f.invoke(query)).toMatchObject({ requestId: query.requestId, ok: false, error: { code: 'update-in-progress' } });
  expect(f.backend.calls).toHaveLength(0);
  await rm(lock); await f.publish('0.2.0', f.generation());
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: true });
});

test('응답 유실 mutation과 구세대 inflight를 재전송하지 않고 완료 뒤 새세대 mutation을 접수한다', async () => {
  const f = await fixture();
  let release!: () => void;
  f.backend.startGate = new Promise<void>(resolve => { release = resolve; }); f.backend.loseStart = true;
  const lost = request('start'), oldWork = f.invoke(lost);
  await vi.waitFor(() => expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(1));
  await f.publish('0.2.1'); f.backend.version = '0.2.1'; f.backend.sessions = new SessionControl();
  const next = request('start'), newWork = f.invoke(next);
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(1);
  expect(f.backend.opened).toBe(1);
  release();
  expect(await oldWork).toMatchObject({ requestId: lost.requestId, ok: false, error: { code: 'service-disconnected' } });
  delete f.backend.startGate; f.backend.loseStart = false;
  expect(await newWork).toMatchObject({ requestId: next.requestId, ok: true });
  expect(f.backend.calls.filter(call => call.method === 'start').map(call => call.requestId)).toEqual([lost.requestId, next.requestId]);
  expect(await f.invoke(lost)).toMatchObject({ requestId: lost.requestId, ok: false, error: { code: 'run-owner-mismatch' } });
  expect(f.backend.calls.filter(call => call.method === 'start').map(call => call.requestId)).toEqual([lost.requestId, next.requestId, lost.requestId]);
  expect(f.backend.opened).toBe(2);
});

test('두 자료 root의 invoker와 실제 자격은 독립이며 공통 descriptor 증가를 각각 검증한다', async () => {
  const f = await fixture(), secondRoot = join(f.base, '자료 루트 B');
  const second = await f.register(secondRoot), invokeB = createManagedInvoker(f.installation, secondRoot);
  expect(await f.invoke(request('start'))).toMatchObject({ ok: true, data: { dataRoot: f.root } });
  expect(await invokeB(request('start'))).toMatchObject({ ok: true, data: { dataRoot: secondRoot } });
  expect([f.backend.opened, second.opened]).toEqual([1, 1]);
  await f.publish('0.2.1');
  for (const backend of [f.backend, second]) { backend.version = '0.2.1'; backend.sessions = new SessionControl(); }
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: true, data: { dataRoot: f.root } });
  expect(await invokeB(request('projects'))).toMatchObject({ ok: true, data: { dataRoot: secondRoot } });
  expect([f.backend.opened, second.opened]).toEqual([2, 2]);
});

test('설치 식별 파일이 하드링크로 바뀌어도 설치 잠금 조회를 우회하지 않는다', async () => {
  const f = await fixture(), update = join(f.installation, 'Update.exe');
  const outside = join(f.base, '외부 설치 표시'); await writeFile(outside, '합성 설치 파일');
  await rm(update); await link(outside, update);
  expect(await f.invoke(request('start'))).toMatchObject({ ok: false, error: { code: 'managed-installation-mismatch' } });
  expect(f.backend.calls).toHaveLength(0);
});

test('같은 owner의 명시적 동일 요청은 원 run을 재확인하고 변경 본문은 request-conflict로 보존한다', async () => {
  const f = await fixture(), original = request('start', { projectId: randomUUID(), planId: randomUUID() });
  const started = await f.invoke(original);
  expect(started).toMatchObject({ ok: true, data: { reused: false } });
  if (!started.ok) throw new Error('합성 실행 실패');
  const runId = (started.data as { runId: string }).runId;
  expect(await f.invoke({ ...original, input: { ...original.input } })).toMatchObject({ ok: true, data: { runId, reused: true } });
  expect(await f.invoke({ ...original, input: { ...original.input, planId: randomUUID() } })).toMatchObject({
    ok: false, error: { code: 'request-conflict' } });
  expect(f.backend.runs.size).toBe(1); expect(f.backend.opened).toBe(1);
});

test('응답 유실 후 자동 재전송은 0이며 명시적 같은 요청으로 원 run 하나를 재확인한다', async () => {
  const f = await fixture(), original = request('start'); f.backend.loseStart = true;
  expect(await f.invoke(original)).toMatchObject({ ok: false, error: { code: 'service-disconnected' } });
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(1);
  expect(f.backend.runs.size).toBe(1);
  const runId = f.backend.admitted.get(original.requestId)!.runId;
  expect(await f.invoke(request('projects'))).toMatchObject({ ok: true });
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(1);
  f.backend.loseStart = false;
  expect(await f.invoke(original)).toMatchObject({ ok: true, data: { runId, reused: true } });
  expect(f.backend.runs.size).toBe(1); expect(f.backend.opened).toBe(1);
});

test('최초 probe A 뒤 세션 열기 전에 epoch B가 되면 원 start를 보내지 않는다', async () => {
  const f = await fixture();
  f.backend.onCapabilities = () => { if (f.backend.probes === 2) f.backend.sessions = new SessionControl(); };
  const response = await f.invoke(request('start'));
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(0);
  expect(response).toMatchObject({ ok: false }); expect(f.backend.opened).toBe(1);
});

test('새 세션을 연 뒤 epoch가 바뀌면 readonly fallback을 새 자격 확인으로 간주하지 않는다', async () => {
  const f = await fixture();
  f.backend.afterOpen = () => { f.backend.sessions = new SessionControl(); };
  const response = await f.invoke(request('cancel', { runId: randomUUID() }));
  expect(f.backend.calls.filter(call => call.method === 'cancel')).toHaveLength(0);
  expect(response).toMatchObject({ ok: false }); expect(f.backend.opened).toBe(1);
});

test.each([
  ['before', 'start'], ['before', 'cancel'], ['after', 'start'], ['after', 'cancel'],
] as const)('업그레이드 세션 %s 단계의 epoch 경합은 %s 전송과 추가 자격 발급 없이 기존 current와 owner를 보존한다', async (phase, method) => {
  const f = await fixture(), original = request('start');
  const originalSessions = f.backend.sessions, generation = f.generation();
  const started = await f.invoke(original);
  if (!started.ok) throw new Error('합성 실행 실패');
  const runId = (started.data as { runId: string }).runId;
  await f.publish('0.2.1'); f.backend.version = '0.2.1'; f.backend.sessions = new SessionControl();
  const changeEpoch = () => { f.backend.sessions = new SessionControl(); };
  if (phase === 'before') f.backend.beforeOpen = changeEpoch; else f.backend.afterOpen = changeEpoch;
  expect(await f.invoke(request(method, method === 'cancel' ? { runId } : {}))).toMatchObject({ ok: false });
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(1);
  expect(f.backend.calls.filter(call => call.method === 'cancel')).toHaveLength(0);
  delete f.backend.beforeOpen; delete f.backend.afterOpen;
  expect(await f.invoke(request('start'))).toMatchObject({ ok: false });
  expect(f.backend.opened).toBe(2);
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(1);
  // 합성 descriptor와 서비스만 원 상태로 돌려 실패한 후보가 기존 closure를 교체하지 않았음을 확인한다.
  await f.publish('0.2.0', generation); f.backend.version = '0.2.0'; f.backend.sessions = originalSessions;
  expect(await f.invoke(original)).toMatchObject({ ok: true, data: { runId, reused: true } });
  expect(await f.invoke(request('cancel', { runId }))).toMatchObject({ ok: true });
  expect(f.backend.opened).toBe(2); expect(f.backend.runs.size).toBe(1);
});

test.each(['root', 'version'] as const)('세션 생성 중 %s 치환은 자격이 연결된 capabilities에서 거절하고 start를 전송하지 않는다', async field => {
  const f = await fixture();
  f.backend.beforeOpen = () => {
    if (field === 'root') f.backend.reportedRoot = f.base; else f.backend.version = '0.2.1';
  };
  expect(await f.invoke(request('start'))).toMatchObject({ ok: false,
    error: { code: field === 'root' ? 'managed-root-mismatch' : 'managed-service-version-mismatch' } });
  expect(f.backend.calls.filter(call => call.method === 'start')).toHaveLength(0);
  expect(f.backend.opened).toBe(1);
});
