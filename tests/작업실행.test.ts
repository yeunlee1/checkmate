// 실제 자식 프로세스로 종료코드와 시간 제한 및 취소 경계를 검증한다.
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { runRegisteredCommand, type RegisteredCommand } from '../packages/engine/src/작업실행.js';

function registry(script: string): Map<string, RegisteredCommand> {
  return new Map([['fixture', { executable: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {} }]]);
}

describe('직접 자식 실행', () => {
  it('실제 비영 종료코드를 보존한다.', async () => {
    const result = await runRegisteredCommand(registry('process.exit(9)'), 'fixture', { timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 'exited', exitCode: 9, terminationConfirmed: true });
  });

  it('부모 환경변수 전체를 상속하지 않는다.', async () => {
    process.env.CHECKMATE_SYNTHETIC_SECRET = 'test-only';
    try {
      const result = await runRegisteredCommand(registry('process.exit(process.env.CHECKMATE_SYNTHETIC_SECRET ? 9 : 0)'), 'fixture', { timeoutMs: 5000 });
      expect(result.exitCode).toBe(0);
    } finally { delete process.env.CHECKMATE_SYNTHETIC_SECRET; }
  });

  it('시간 제한으로 종료한 작업을 정상 종료로 표시하지 않는다.', async () => {
    const result = await runRegisteredCommand(registry('setInterval(() => {}, 1000)'), 'fixture', { timeoutMs: 200 });
    expect(result).toMatchObject({ status: 'timed-out', terminationConfirmed: true });
  });

  it('실행 중 사용자 취소를 보존한다.', async () => {
    const controller = new AbortController();
    const task = runRegisteredCommand(registry('setInterval(() => {}, 1000)'), 'fixture', { timeoutMs: 5000, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 200);
    try { expect(await task).toMatchObject({ status: 'cancelled', terminationConfirmed: true }); }
    finally { clearTimeout(timer); }
  });

  it('시작 전에 취소된 요청은 프로세스를 만들지 않는다.', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runRegisteredCommand(registry('process.exit(99)'), 'fixture', { timeoutMs: 5000, signal: controller.signal });
    expect(result).toEqual({ status: 'cancelled', exitCode: null, terminationConfirmed: true, outputBytes: 0 });
  });

  it('과도한 출력은 메모리에 쌓지 않고 중단한다.', async () => {
    const result = await runRegisteredCommand(registry('process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000)'), 'fixture', { timeoutMs: 5000, maxOutputBytes: 1024 });
    expect(result).toMatchObject({ status: 'output-limit', terminationConfirmed: true });
    expect(result.outputBytes).toBeGreaterThan(1024);
  });

  it('등록되지 않은 명령은 실행 전에 거절한다.', async () => {
    await expect(runRegisteredCommand(registry(''), 'unknown', { timeoutMs: 1000 })).rejects.toThrow('등록된');
  });

  it('프로세스 시작 실패를 종료코드0으로 바꾸지 않는다.', async () => {
    const commands = registry('');
    commands.get('fixture')!.executable = resolve('존재하지않는실행파일.exe');
    const result = await runRegisteredCommand(commands, 'fixture', { timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 'spawn-error', exitCode: null, terminationConfirmed: true });
  });
});
