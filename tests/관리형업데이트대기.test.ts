// 여러 자료 폴더의 업데이트 준비 조회가 전체 시간 예산과 마지막 경로 확인을 지키는지 검증한다.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForManagedIdle } from '../packages/desktop/src/main/업데이트준비.js';

const fake = vi.hoisted(() => ({ execute: vi.fn(), idle: vi.fn(), roots: vi.fn(), descriptor: vi.fn(), target: vi.fn(), stat: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => fake.execute }));
vi.mock('node:fs/promises', () => ({ lstat: fake.stat }));
vi.mock('../packages/desktop/src/main/업데이트.js', () => ({ installationIdle: fake.idle }));
vi.mock('@checkmate/engine/managed-connection', () => ({
  managedDirectory: (root: string) => `${root}/managed`, sameManagedPath: (left: string, right: string) => left === right,
  readRegisteredRoots: fake.roots, readManagedDescriptor: fake.descriptor, readManagedTarget: fake.target,
}));
const response = (root: string) => ({ stdout: JSON.stringify({ ok: true, data: { ready: true, version: '1.0.0', dataRoot: root, installationRoot: 'C:/install' } }) });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.resetAllMocks();
  fake.stat.mockResolvedValue({}); fake.roots.mockResolvedValue(['C:/a', 'C:/b']);
  fake.descriptor.mockResolvedValue({ generation: 'first' });
  fake.target.mockImplementation(async () => ({ generation: 'first', version: '1.0.0', nodeExecutable: 'node.exe' }));
  fake.execute.mockImplementation(async (_node: string, args: string[]) => response(args[2]!));
  fake.idle.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); });

it('두 자료 폴더를 전후로 확인하고 마지막 유휴 관측까지 수행한다', async () => {
  expect(await waitForManagedIdle('C:/install')).toBe(true);
  expect(fake.execute.mock.calls.map(call => call[1][2])).toEqual(['C:/a', 'C:/b', 'C:/a', 'C:/b']);
  expect(fake.idle).toHaveBeenCalledTimes(2);
});
it('두 폴더의 전후 조회 시간을 합산하여 75초를 넘기지 않는다', async () => {
  fake.execute.mockImplementation(async (_node: string, args: string[]) => {
    await new Promise(resolve => setTimeout(resolve, 34000)); return response(args[2]!);
  });
  let finished = false;
  const work = waitForManagedIdle('C:/install').then(value => { finished = true; return value; });
  await vi.advanceTimersByTimeAsync(75000);
  expect(finished).toBe(true); expect(await work).toBe(false);
  expect(fake.execute.mock.calls[2]?.[2].timeout).toBeLessThanOrEqual(7000);
});
it('초기 파일 조회가 끝나지 않아도 같은 전체 시간 예산으로 종료한다', async () => {
  fake.stat.mockImplementation(() => new Promise(() => {}));
  let finished = false;
  const work = waitForManagedIdle('C:/install').then(value => { finished = true; return value; });
  await vi.advanceTimersByTimeAsync(75000);
  expect(finished).toBe(true); expect(await work).toBe(false); expect(fake.execute).not.toHaveBeenCalled();
});
it('한 폴더라도 미준비이면 유휴 대기로 넘어가지 않는다', async () => {
  fake.execute.mockResolvedValueOnce(response('C:/a')).mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, data: { ready: false } }) });
  expect(await waitForManagedIdle('C:/install')).toBe(false); expect(fake.idle).not.toHaveBeenCalled();
});
it('마지막 등록 목록 또는 설치 경로가 바뀌면 기존 관측을 사용하지 않는다', async () => {
  fake.roots.mockResolvedValueOnce(['C:/a', 'C:/b']).mockResolvedValueOnce(['C:/a', 'C:/c']);
  expect(await waitForManagedIdle('C:/install')).toBe(false); expect(fake.execute).toHaveBeenCalledTimes(2);
  fake.roots.mockResolvedValue(['C:/a']); fake.execute.mockResolvedValue(response('C:/other'));
  expect(await waitForManagedIdle('C:/install')).toBe(false);
});
