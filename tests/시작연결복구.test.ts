// 앱 시작 읽기의 제한 재시도와 자료 경로 보호 및 늦은 응답 취소를 검증한다.
import { afterEach, expect, it, vi } from 'vitest';
import { readStartupConnection } from '../packages/desktop/src/renderer/시작연결복구.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const dataPath = 'C:/자료/CheckMate';
const capabilities = (dataRoot: unknown = dataPath) => ({ version: '1.0.1', capabilities: ['projects'], connection: { dataRoot } });
const failure = (code: string) => Object.assign(new Error(code), { code });
function fixture() {
  const controller = new AbortController();
  const reads = {
    readConnectionInfo: vi.fn(async () => ({ dataPath, version: '1.0.1' })),
    readCapabilities: vi.fn(async (): Promise<unknown> => capabilities()),
    readProjects: vi.fn(async () => ({ items: ['프로젝트'], nextCursor: null, total: 1 })),
  };
  const run = () => readStartupConnection(reads, { signal: controller.signal });
  return { reads, controller, run };
}
it('시작은 연결 정보와 실제 서비스 경로를 검증한 뒤 프로젝트를 한 번 읽는다', async () => {
  const f = fixture(); const order: string[] = [];
  f.reads.readConnectionInfo.mockImplementation(async () => { order.push('connectionInfo'); return { dataPath, version: '1.0.1' }; });
  f.reads.readCapabilities.mockImplementation(async () => { order.push('capabilities'); return capabilities(); });
  f.reads.readProjects.mockImplementation(async () => { order.push('projects'); return { items: [], nextCursor: null, total: 0 }; });
  expect(await f.run()).toEqual({ connection: { dataPath, version: '1.0.1' }, capabilities: capabilities(), projects: { items: [], nextCursor: null, total: 0 } });
  expect(order).toEqual(['connectionInfo', 'capabilities', 'projects']);
});
it('connectionInfo의 plain update-in-progress 응답을 5초 뒤 다시 읽고 성공한다', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.reads.readConnectionInfo.mockResolvedValueOnce({ ok: false, error: { code: 'update-in-progress', message: '업데이트 대기' } } as never);
  const pending = f.run().then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(4999); expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce(); expect(f.reads.readCapabilities).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toHaveProperty('value.connection.dataPath', dataPath);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2); expect(f.reads.readCapabilities).toHaveBeenCalledOnce(); expect(f.reads.readProjects).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['service-unavailable', 'service-disconnected', 'service-start-failed'])('connectionInfo의 plain 일시 오류 %s도 같은 단일 복구 loop를 사용한다', async code => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readConnectionInfo.mockResolvedValueOnce({ ok: false, error: { code } } as never);
  const pending = f.run().then(value => ({ value }), error => ({ error })); await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toHaveProperty('value.projects.total', 1);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2); expect(f.reads.readCapabilities).toHaveBeenCalledOnce(); expect(f.reads.readProjects).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  'needs-initialization', 'authentication-failed', 'unauthorized', 'unsafe-path', 'ownership-unknown',
  'update-lock-unknown', 'storage-operation-unknown', 'unknown', 'unsupported-version', 'service-update-required',
])('connectionInfo의 plain 보호 오류 %s는 경로 누락으로 덮지 않고 즉시 거부한다', async code => {
  vi.useFakeTimers(); const f = fixture(); const error = { code, message: '연결 보호' };
  f.reads.readConnectionInfo.mockResolvedValue({ ok: false, error } as never);
  await expect(f.run()).rejects.toBe(error); expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce();
  expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each([undefined, null, {}, { code: 7 }, { retryable: true }, 'update-in-progress'])('connectionInfo의 잘못된 plain 오류 %j에 정상 dataPath가 섞여도 준비를 거부한다', async error => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readConnectionInfo.mockResolvedValue({ ok: false, error, dataPath } as never);
  await expect(f.run()).rejects.toMatchObject({ code: 'connection-root-unconfirmed' }); expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce();
  expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('plain 일시 오류가 계속되면 5초와15초 뒤 세 번째 원 오류로 끝낸다', async () => {
  vi.useFakeTimers(); const f = fixture(); const error = { code: 'update-in-progress' };
  f.reads.readConnectionInfo.mockResolvedValue({ ok: false, error } as never);
  const pending = f.run(); const rejected = expect(pending).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(4999); expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(14999); expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); await rejected; await vi.advanceTimersByTimeAsync(90000);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(3); expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('plain 일시 오류 backoff 중 선택 취소는 새 연결 읽기를 금지한다', async () => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readConnectionInfo.mockResolvedValueOnce({ ok: false, error: { code: 'service-disconnected' } } as never);
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'startup-cancelled' });
  await vi.advanceTimersByTimeAsync(1000); f.controller.abort(); await rejected; await vi.advanceTimersByTimeAsync(90000);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce(); expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each([
  { ok: false, error: { code: 'update-in-progress' } },
  { dataPath, version: '1.0.1' },
])('취소 후 늦게 도착한 connectionInfo %j는 재시도나 준비에 쓰지 않는다', async reply => {
  vi.useFakeTimers(); const f = fixture(); let finish!: (value: unknown) => void;
  f.reads.readConnectionInfo.mockImplementationOnce(() => new Promise(resolve => { finish = value => resolve(value as never); }));
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'startup-cancelled' });
  await vi.advanceTimersByTimeAsync(0); f.controller.abort(); await rejected; finish(reply); await vi.advanceTimersByTimeAsync(90000);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce(); expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('plain 오류 복구 뒤 다른 connection root가 오면 고정 경로와 비교해 거부한다', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.reads.readConnectionInfo.mockResolvedValueOnce({ ok: false, error: { code: 'update-in-progress' } } as never)
    .mockResolvedValueOnce({ dataPath: 'C:/다른자료', version: '1.0.1' });
  const pending = readStartupConnection(f.reads, { signal: f.controller.signal, expectedDataPath: dataPath });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-root-mismatch' }); await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2); expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('plain 오류 복구 뒤 실제 capability root가 다르면 프로젝트를 읽지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readConnectionInfo.mockResolvedValueOnce({ ok: false, error: { code: 'service-start-failed' } } as never);
  f.reads.readCapabilities.mockResolvedValue(capabilities('C:/다른자료'));
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-root-mismatch' }); await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2); expect(f.reads.readCapabilities).toHaveBeenCalledOnce(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('plain 오류 복구는 읽기 세 단계만 반복하고 변경 API를 요청하지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); const order: string[] = []; let first = true;
  f.reads.readConnectionInfo.mockImplementation(async () => {
    order.push('connectionInfo'); if (first) { first = false; return { ok: false, error: { code: 'update-in-progress' } } as never; }
    return { dataPath, version: '1.0.1' };
  });
  f.reads.readCapabilities.mockImplementation(async () => { order.push('capabilities'); return capabilities(); });
  f.reads.readProjects.mockImplementation(async () => { order.push('projects'); return { items: [], nextCursor: null, total: 0 }; });
  const mutations = { initializeLocalStore: vi.fn(), start: vi.fn(), cancel: vi.fn(), approve: vi.fn(), handoff: vi.fn(), cleanup: vi.fn(), storageWrite: vi.fn() };
  const pending = readStartupConnection({ ...f.reads, ...mutations }, { signal: f.controller.signal }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(5000); expect(await pending).toHaveProperty('value.projects.total', 0);
  expect(order).toEqual(['connectionInfo', 'connectionInfo', 'capabilities', 'projects']);
  for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['service-unavailable', 'service-disconnected', 'service-start-failed', 'update-in-progress'])('일시 오류 %s만 5초 뒤 다시 읽고 성공한다', async code => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readCapabilities.mockRejectedValueOnce(failure(code));
  const pending = f.run(); await vi.advanceTimersByTimeAsync(4999); expect(f.reads.readCapabilities).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toHaveProperty('projects.total', 1);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledTimes(2); expect(f.reads.readCapabilities).toHaveBeenCalledTimes(2); expect(f.reads.readProjects).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['readConnectionInfo', 'readCapabilities', 'readProjects'] as const)('읽기 단계 %s의 일시 오류도 동일하게 제한 복구한다', async phase => {
  vi.useFakeTimers(); const f = fixture(); f.reads[phase].mockRejectedValueOnce(failure('service-disconnected'));
  const pending = f.run(); await vi.advanceTimersByTimeAsync(5000); await expect(pending).resolves.toBeDefined();
  expect(f.reads[phase]).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
it('두 번 실패하면 5초와15초만 기다리고 세 번째 원래 실패로 끝낸다', async () => {
  vi.useFakeTimers(); const f = fixture(); const error = failure('update-in-progress');
  f.reads.readCapabilities.mockRejectedValue(error); const pending = f.run(); const rejected = expect(pending).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(5000); expect(f.reads.readCapabilities).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(14999); expect(f.reads.readCapabilities).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); await rejected; expect(f.reads.readCapabilities).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(90000); expect(f.reads.readCapabilities).toHaveBeenCalledTimes(3); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each([
  'needs-initialization', 'authentication-failed', 'unauthorized', 'invalid-path', 'unsafe-path', 'ownership-unknown',
  'update-lock-unknown', 'storage-operation-unknown', 'unknown', 'unsupported-version', 'service-update-required', 'invalid-input',
])('영구 또는 보호 오류 %s는 반복하지 않고 그대로 반환한다', async code => {
  vi.useFakeTimers(); const f = fixture(); const error = failure(code); f.reads.readCapabilities.mockRejectedValue(error);
  await expect(f.run()).rejects.toBe(error); expect(f.reads.readCapabilities).toHaveBeenCalledOnce();
  expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each([null, undefined, new Error('연결 예외'), { retryable: true }])('확인되지 않은 예외 %j는 재시도 근거가 아니다', async error => {
  const f = fixture(); f.reads.readCapabilities.mockRejectedValue(error); await expect(f.run()).rejects.toBe(error);
  expect(f.reads.readCapabilities).toHaveBeenCalledOnce();
});
it.each([
  ['C:\\자료\\CheckMate\\', 'c:/자료/checkmate'], ['C:/자료/임시/../CheckMate', 'C:/자료/CheckMate/.'],
  ['//server/share/자료/CheckMate', '\\\\SERVER\\SHARE\\자료\\checkmate\\'], ['/tmp/자료/CheckMate/', '/tmp/자료/CheckMate'],
])('자료 경로 %s와 %s는 정규화 후 같은 대상으로 읽는다', async (expected, actual) => {
  const f = fixture(); f.reads.readConnectionInfo.mockResolvedValue({ dataPath: expected, version: '1.0.1' });
  f.reads.readCapabilities.mockResolvedValue(capabilities(actual)); await expect(f.run()).resolves.toBeDefined(); expect(f.reads.readProjects).toHaveBeenCalledOnce();
});
it.each([
  ['C:/자료/A', 'C:/자료/B'], ['C:/자료/A', 'D:/자료/A'], ['/tmp/자료/A', '/tmp/자료/a'],
  ['//server/share/자료/A', '//server/other/자료/A'],
])('자료 경로 %s와 %s가 다르면 프로젝트와 준비 결과를 수용하지 않는다', async (expected, actual) => {
  const f = fixture(); f.reads.readConnectionInfo.mockResolvedValue({ dataPath: expected, version: '1.0.1' });
  f.reads.readCapabilities.mockResolvedValue(capabilities(actual)); await expect(f.run()).rejects.toMatchObject({ code: 'connection-root-mismatch' });
  expect(f.reads.readCapabilities).toHaveBeenCalledOnce(); expect(f.reads.readProjects).not.toHaveBeenCalled();
});
it.each([null, {}, { connection: null }, { connection: {} }, capabilities(''), capabilities(5), capabilities('relative/path'), capabilities('C:relative'), capabilities('C:/자료\u0000')])('서비스 자료 경로가 없는 구 응답이나 잘못된 응답 %j는 제한한다', async value => {
  const f = fixture(); f.reads.readCapabilities.mockResolvedValue(value);
  await expect(f.run()).rejects.toMatchObject({ code: 'connection-root-unconfirmed' }); expect(f.reads.readProjects).not.toHaveBeenCalled();
});
it.each(['', 'relative/path', 'C:자료', '\\자료', 'C:/../자료', '//?/C:/자료', '//./C:/자료'])('앱 자료 경로 %s가 불명확하면 서비스도 읽지 않는다', async value => {
  const f = fixture(); f.reads.readConnectionInfo.mockResolvedValue({ dataPath: value, version: '1.0.1' });
  await expect(f.run()).rejects.toMatchObject({ code: 'connection-root-unconfirmed' }); expect(f.reads.readCapabilities).not.toHaveBeenCalled();
});
it('앱 연결 정보가 누락돼도 자료 위치 미확인으로 명시하고 서비스를 읽지 않는다', async () => {
  const f = fixture(); f.reads.readConnectionInfo.mockResolvedValue(null as never);
  await expect(f.run()).rejects.toMatchObject({ code: 'connection-root-unconfirmed' }); expect(f.reads.readCapabilities).not.toHaveBeenCalled();
});
it('재시도 도중 앱 경로가 바뀌면 새 경로를 원래 경로로 오인하지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readCapabilities.mockRejectedValueOnce(failure('service-unavailable'));
  f.reads.readConnectionInfo.mockResolvedValueOnce({ dataPath, version: '1.0.1' }).mockResolvedValueOnce({ dataPath: 'C:/다른자료', version: '1.0.1' });
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'connection-root-mismatch' }); await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(f.reads.readCapabilities).toHaveBeenCalledOnce(); expect(f.reads.readProjects).not.toHaveBeenCalled();
});
it('재접속에서도 이전 준비된 자료 경로를 고정하며 다른 계정 경로로 바꾸지 않는다', async () => {
  const f = fixture(); await expect(readStartupConnection(f.reads, { signal: f.controller.signal, expectedDataPath: 'C:/이전계정자료' })).rejects.toMatchObject({ code: 'connection-root-mismatch' });
  expect(f.reads.readCapabilities).not.toHaveBeenCalled(); expect(f.reads.readProjects).not.toHaveBeenCalled();
});
it('잘못된 이전 경로도 자동으로 새 root에 맞추지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); await expect(readStartupConnection(f.reads, { signal: f.controller.signal, expectedDataPath: '' })).rejects.toMatchObject({ code: 'connection-root-unconfirmed' });
  expect(f.reads.readConnectionInfo).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('이미 취소한 시작은 요청과 타이머를 만들지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); f.controller.abort(); await expect(f.run()).rejects.toMatchObject({ code: 'startup-cancelled' });
  expect(f.reads.readConnectionInfo).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('선택 변경이나 unmount로 backoff를 취소하면 후속 읽기를 시작하지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); f.reads.readCapabilities.mockRejectedValue(failure('update-in-progress'));
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'startup-cancelled' });
  await vi.advanceTimersByTimeAsync(1000); f.controller.abort(); await rejected; await vi.advanceTimersByTimeAsync(90000);
  expect(f.reads.readConnectionInfo).toHaveBeenCalledOnce(); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['readConnectionInfo', 'readCapabilities', 'readProjects'] as const)('취소 뒤 늦게 끝난 %s 응답은 후속 읽기와 준비에 사용하지 않는다', async phase => {
  vi.useFakeTimers(); const f = fixture(); let finish!: () => void;
  f.reads[phase].mockImplementationOnce(() => new Promise<never>(resolve => { finish = () => resolve(undefined as never); }));
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'startup-cancelled' });
  await vi.advanceTimersByTimeAsync(0); f.controller.abort(); await rejected;
  const calls = [f.reads.readConnectionInfo.mock.calls.length, f.reads.readCapabilities.mock.calls.length, f.reads.readProjects.mock.calls.length];
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect([f.reads.readConnectionInfo.mock.calls.length, f.reads.readCapabilities.mock.calls.length, f.reads.readProjects.mock.calls.length]).toEqual(calls);
  expect(vi.getTimerCount()).toBe(0);
});
it('응답이 오지 않아도 전체90초에 종료하고 늦은 응답을 수용하지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture(); let finish!: (value: unknown) => void;
  f.reads.readCapabilities.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'startup-timeout' });
  await vi.advanceTimersByTimeAsync(89999); expect(f.reads.readProjects).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await rejected; finish(capabilities()); await vi.advanceTimersByTimeAsync(0);
  expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('개별25초와 backoff를 모두 합쳐90초를 넘기지 않는다', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.reads.readCapabilities.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(failure('service-start-failed')), 25000)));
  const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ code: 'startup-timeout' });
  await vi.advanceTimersByTimeAsync(90000); await rejected; expect(f.reads.readCapabilities).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5000); expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('주입한 clock으로 deadline이 지났으면 타이머 콜백 전에도 준비를 거부한다', async () => {
  const f = fixture(); let now = 0; const clear = vi.fn();
  f.reads.readCapabilities.mockImplementation(async () => { now = 90000; return capabilities(); });
  await expect(readStartupConnection(f.reads, { signal: f.controller.signal, clock: { now: () => now, setTimeout: () => 1, clearTimeout: clear } })).rejects.toMatchObject({ code: 'startup-timeout' });
  expect(f.reads.readProjects).not.toHaveBeenCalled(); expect(clear).toHaveBeenCalledWith(1);
});
