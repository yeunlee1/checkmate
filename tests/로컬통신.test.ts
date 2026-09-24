// 실제 로컬 소켓의 양방향 인증과 사람 전용 작업 경계를 검증한다.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiRequest } from '@checkmate/contracts/api';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { requestLocal, serveLocal } from '../packages/engine/src/연결/로컬통신.js';
import { JsonFrames } from '../packages/engine/src/연결/프레임.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'checkmate-ipc-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  await prepareDataPaths(paths);
  let calls = 0;
  const service = await serveLocal(paths, async (request) => { calls += 1; return { apiVersion: 1, requestId: request.requestId, ok: true, data: { method: request.method } }; });
  cleanups.push(service.close);
  return { paths, service, calls: () => calls };
}
const request = (method: ApiRequest['method'] = 'capabilities'): ApiRequest => ({ apiVersion: 1, requestId: randomUUID(), method, input: {} });

describe('실제 로컬 통신', () => {
  it('인증된 연결의 응답을 받고 에이전트의 사람 전용 작업을 거절한다', async () => {
    const f = await fixture();
    expect(await requestLocal(f.paths, request())).toMatchObject({ ok: true, data: { method: 'capabilities' } });
    expect(await requestLocal(f.paths, request('approve'), 'agent')).toMatchObject({ ok: false, error: { code: 'human-action-required' } });
    expect(f.calls()).toBe(1);
    expect(await requestLocal(f.paths, request('approve'), 'human')).toMatchObject({ ok: true });
  });
  it('다른 비밀로 만든 연결은 실제 처리기에 도달하지 않는다', async () => {
    const f = await fixture();
    const original = await readFile(f.paths.secret);
    await writeFile(f.paths.secret, '0'.repeat(64));
    await expect(requestLocal(f.paths, request())).rejects.toThrow();
    expect(f.calls()).toBe(0);
    await writeFile(f.paths.secret, original);
    expect(await requestLocal(f.paths, request())).toMatchObject({ ok: true });
  });
  it('같은 연결 주소의 두 번째 서버를 거절한다', async () => {
    const f = await fixture();
    await expect(serveLocal(f.paths, async (r) => ({ apiVersion: 1, requestId: r.requestId, ok: true, data: {} }))).rejects.toThrow();
    expect(await requestLocal(f.paths, request())).toMatchObject({ ok: true });
  });
  it('인증 전 과대 메시지를 닫고 다른 정상 연결은 유지한다', async () => {
    const f = await fixture();
    const socket = createConnection(f.paths.endpoint);
    const frames = new JsonFrames(socket);
    await frames.read();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write('x'.repeat(270000));
    await closed;
    expect(f.calls()).toBe(0);
    expect(await requestLocal(f.paths, request())).toMatchObject({ ok: true });
  });
  it('기존 자료가 있는 임의 폴더의 권한이나 내용을 바꾸지 않는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkmate-foreign-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, '보존.txt'), '보존');
    await expect(prepareDataPaths(dataPaths(root))).rejects.toMatchObject({ code: 'unrecognized-data-root' });
    expect(await readFile(join(root, '보존.txt'), 'utf8')).toBe('보존');
  });
});
