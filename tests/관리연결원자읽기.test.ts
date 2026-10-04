// 관리 파일 조회 사이의 원자 교체와 파일 증가를 열린 파일의 실제 바이트로 거절하는지 검증한다.
import { beforeEach, expect, it, vi } from 'vitest';
import { readManagedJson } from '../packages/engine/src/연결/관리연결계약.js';
const fake = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn(), stat: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('node:fs/promises', () => ({ lstat: fake.lstat, open: fake.open, readdir: vi.fn(), realpath: vi.fn() }));
vi.mock('../packages/engine/src/연결/개인경로.js', () => ({ rejectLinks: async () => {} }));
const info = { isFile: () => true, nlink: 1, dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 };
beforeEach(() => {
  vi.resetAllMocks(); fake.lstat.mockResolvedValue(info); fake.stat.mockResolvedValue(info);
  fake.open.mockResolvedValue({ stat: fake.stat, read: fake.read, close: fake.close });
  fake.read.mockImplementation(async (buffer: Buffer, offset: number) => {
    if (offset === 0) { buffer.write('{}'); return { bytesRead: 2 }; } return { bytesRead: 0 };
  });
});
it('열기 직전에 원자 교체된 다른 파일은 읽지 않는다', async () => {
  fake.stat.mockResolvedValue({ ...info, ino: 2 });
  await expect(readManagedJson('C:/fixture/file.json')).rejects.toMatchObject({ code: 'managed-connection-invalid' });
  expect(fake.read).not.toHaveBeenCalled(); expect(fake.close).toHaveBeenCalledTimes(1);
});
it('열린 뒤 파일이 증가해도 실제 읽기는 16385바이트로 제한하고 거절한다', async () => {
  fake.read.mockImplementation(async (buffer: Buffer, offset: number, length: number) => {
    buffer.fill(32, offset, offset + length); return { bytesRead: length };
  });
  await expect(readManagedJson('C:/fixture/file.json')).rejects.toMatchObject({ code: 'managed-connection-invalid' });
  expect(fake.read).toHaveBeenCalledTimes(1); expect(fake.read.mock.calls[0]![2]).toBe(16385);
  expect(fake.close).toHaveBeenCalledTimes(1);
});
it('읽기 뒤 경로가 교체되거나 열린 파일이 하드링크가 되면 거절한다', async () => {
  fake.lstat.mockResolvedValueOnce(info).mockResolvedValue({ ...info, ino: 2 });
  await expect(readManagedJson('C:/fixture/file.json')).rejects.toMatchObject({ code: 'managed-connection-invalid' });
  fake.lstat.mockResolvedValue(info); fake.stat.mockResolvedValueOnce(info).mockResolvedValue({ ...info, nlink: 2 });
  await expect(readManagedJson('C:/fixture/file.json')).rejects.toMatchObject({ code: 'managed-connection-invalid' });
});
