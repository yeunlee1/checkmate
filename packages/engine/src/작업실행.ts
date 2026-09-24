// 등록된 명령의 직접 자식을 실행하고 종료와 중단 여부를 구분한다.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type RegisteredCommand = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
};
export type ProcessOutcome = {
  status: 'exited' | 'spawn-error' | 'timed-out' | 'cancelled' | 'output-limit' | 'unverifiable';
  exitCode: number | null;
  terminationConfirmed: boolean;
  outputBytes: number;
};

export function runRegisteredCommand(
  registry: ReadonlyMap<string, RegisteredCommand>,
  commandId: string,
  options: { timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number; terminationWaitMs?: number },
): Promise<ProcessOutcome> {
  const command = registry.get(commandId);
  if (!command || !isAbsolute(command.executable) || !isAbsolute(command.cwd)) {
    return Promise.reject(new Error('등록된 실행 파일과 작업 폴더의 절대 경로가 필요합니다.'));
  }
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const terminationWaitMs = options.terminationWaitMs ?? 10000;
  for (const value of [options.timeoutMs, maxOutputBytes, terminationWaitMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
      return Promise.reject(new Error('시간과 출력 제한은 지원 범위의 양의 정수여야 합니다.'));
    }
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ status: 'cancelled', exitCode: null, terminationConfirmed: true, outputBytes: 0 });
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command.executable, [...command.args], {
        cwd: command.cwd, env: { ...command.env }, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { reject(error); return; }
    let status: ProcessOutcome['status'] = 'exited';
    let bytes = 0;
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null, terminationConfirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(terminationTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (!terminationConfirmed) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve({ status, exitCode, terminationConfirmed, outputBytes: bytes });
    };
    const stop = (reason: ProcessOutcome['status']) => {
      if (settled || status !== 'exited') return;
      status = reason;
      child.kill();
      terminationTimer = setTimeout(() => {
        status = 'unverifiable';
        finish(null, false);
      }, terminationWaitMs);
    };
    const cancel = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timed-out'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const countOutput = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) stop('output-limit');
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    child.once('error', () => {
      // 생성된 PID가 없으면 시작 실패로, 이미 있으면 종료 확인 불가로 구분한다.
      status = child.pid === undefined ? 'spawn-error' : 'unverifiable';
      finish(null, child.pid === undefined);
    });
    child.once('close', (code) => {
      if (status === 'exited' && code === null) status = 'unverifiable';
      finish(code, true);
    });
  });
}
