// 자신이 만든 검사 프로세스 그룹 또는 Windows Job만 실행하고 정리를 확인한다.
import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ProcessOutcome, RegisteredCommand } from '../작업실행.js';

export type OwnedProcessOutcome = ProcessOutcome & {
  stdout: string;
  stderr: string;
  cleanupVerified: boolean;
};

export class OwnedProcessError extends Error {
  constructor(public readonly code: 'invalid-input' | 'helper-unavailable', message: string) {
    super(message);
    this.name = 'OwnedProcessError';
  }
}

type RunOptions = { timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number; terminationWaitMs?: number };
type Reason = 'timed-out' | 'cancelled' | 'output-limit';

function limits(command: RegisteredCommand, options: RunOptions): { maxOutputBytes: number; terminationWaitMs: number } {
  if (!command || !isAbsolute(command.executable) || !isAbsolute(command.cwd)
    || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || !command.env || Object.entries(command.env).some(([key, value]) =>
      !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'))) {
    throw new OwnedProcessError('invalid-input', '등록된 명령의 실행 파일과 작업 폴더 및 인자가 올바르지 않습니다.');
  }
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const terminationWaitMs = options.terminationWaitMs ?? 10_000;
  for (const value of [options.timeoutMs, maxOutputBytes, terminationWaitMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new OwnedProcessError('invalid-input', '시간과 출력 제한은 지원 범위의 양의 정수여야 합니다.');
    }
  }
  return { maxOutputBytes, terminationWaitMs };
}

function empty(status: ProcessOutcome['status'], verified: boolean): OwnedProcessOutcome {
  return { status, exitCode: null, terminationConfirmed: verified, outputBytes: 0,
    stdout: '', stderr: '', cleanupVerified: verified };
}

function collector(maxBytes: number, stop: (reason: Reason) => void) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let stored = 0;
  let validUtf8 = true;
  function add(target: Buffer[], chunk: Buffer): void {
    outputBytes += chunk.length;
    const available = Math.max(0, maxBytes - stored);
    const keep = Math.min(available, chunk.length);
    if (keep) { target.push(Buffer.from(chunk.subarray(0, keep))); stored += keep; }
    if (outputBytes > maxBytes) stop('output-limit');
  }
  return {
    addStdout: (chunk: Buffer) => add(stdout, chunk),
    addStderr: (chunk: Buffer) => add(stderr, chunk),
    result: () => {
      const decode = (chunks: Buffer[]) => {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { validUtf8 = false; return ''; }
      };
      return { stdout: decode(stdout), stderr: decode(stderr), outputBytes };
    },
    valid: () => validUtf8,
  };
}

async function helperPath(): Promise<string> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native', '작업보호.exe');
  try { await access(path); }
  catch { throw new OwnedProcessError('helper-unavailable', 'Windows 작업 보호 helper가 없습니다.'); }
  return path;
}

async function runWindows(command: RegisteredCommand, options: RunOptions,
  maxOutputBytes: number, terminationWaitMs: number): Promise<OwnedProcessOutcome> {
  const helper = await helperPath();
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new OwnedProcessError('invalid-input', 'Windows 시스템 경로를 확인할 수 없습니다.');
  const childEnv = { SystemRoot: systemRoot, ...command.env };
  const block = Buffer.from(Object.entries(childEnv).map(([key, value]) => `${key}=${value}\0`).join('') + '\0', 'utf16le');
  if (block.length > 1024 * 1024) {
    throw new OwnedProcessError('invalid-input', 'Windows 환경 블록이 지원 크기를 초과합니다.');
  }
  const frame = Buffer.allocUnsafe(4 + block.length);
  frame.writeUInt32LE(block.length, 0);
  block.copy(frame, 4);
  const folder = await mkdtemp(join(tmpdir(), 'checkmate-owned-'));
  const statusPath = join(folder, 'status.txt');
  const args = [statusPath, command.executable, command.cwd, String(terminationWaitMs),
    'stdin-env-v1', String(command.args.length), ...command.args];
  try {
    if (options.signal?.aborted) return empty('cancelled', true);
    return await new Promise<OwnedProcessOutcome>((resolveResult) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(helper, args, { cwd: command.cwd, env: {}, shell: false, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { resolveResult(empty('spawn-error', true)); return; }
      let reason: Reason | undefined;
      let settled = false;
      let forced = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: OwnedProcessOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', cancel);
        resolveResult(outcome);
      };
      const stop = (value: Reason) => {
        if (reason || settled) return;
        reason = value;
        child.stdin.write('X', () => child.stdin.end());
        deadline = setTimeout(() => {
          forced = true;
          child.kill();
          child.stdout.destroy(); child.stderr.destroy();
          child.unref();
          finish({ ...empty('unverifiable', false), ...output.result() });
        }, Math.min(2_147_483_647, terminationWaitMs + 1000));
      };
      const cancel = () => stop('cancelled');
      const output = collector(maxOutputBytes, stop);
      const timeout = setTimeout(() => stop('timed-out'), options.timeoutMs);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stdin.on('error', () => {});
      if (!reason) child.stdin.write(frame);
      child.stdout.on('data', output.addStdout);
      child.stderr.on('data', output.addStderr);
      child.once('error', () => finish({ ...empty(child.pid === undefined ? 'spawn-error' : 'unverifiable',
        child.pid === undefined), ...output.result() }));
      child.once('close', async () => {
        if (settled || forced) return;
        let state = '';
        try { state = (await readFile(statusPath, 'utf8')).trim(); } catch { /* 상태 없음은 확인 불가다. */ }
        const data = output.result();
        if (!output.valid() && reason !== 'output-limit') {
          const clean = state === 'CLEAN' || /^OK:\d+$/u.test(state);
          finish({ status: 'unverifiable', exitCode: null, terminationConfirmed: clean,
            cleanupVerified: clean, ...data });
          return;
        }
        if (/^OK:\d+$/u.test(state)) {
          const code = Number(state.slice(3));
          finish({ status: reason ?? 'exited', exitCode: reason ? null : code,
            terminationConfirmed: true, cleanupVerified: true, ...data });
        } else if (state === 'CLEAN' && reason) {
          finish({ status: reason, exitCode: null, terminationConfirmed: true, cleanupVerified: true, ...data });
        } else if (state.startsWith('SPAWN:')) {
          finish({ status: 'spawn-error', exitCode: null, terminationConfirmed: true, cleanupVerified: true, ...data });
        } else {
          finish({ status: 'unverifiable', exitCode: null, terminationConfirmed: false,
            cleanupVerified: false, ...data });
        }
      });
    });
  } finally {
    try { await unlink(statusPath); } catch { /* 상태 파일이 없을 수 있다. */ }
    try { await rmdir(folder); } catch { /* 다른 자료가 있으면 지우지 않는다. */ }
  }
}

async function groupDone(group: number): Promise<boolean | null> {
  try { process.kill(-group, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    return null;
  }
  let names: string[];
  try { names = await readdir('/proc'); }
  catch { return null; }
  let members = 0;
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    let stat: string;
    try { stat = await readFile(`/proc/${name}/stat`, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return null;
    }
    const end = stat.lastIndexOf(')');
    const fields = end < 0 ? [] : stat.slice(end + 2).split(' ');
    if (Number(fields[2]) !== group) continue;
    members += 1;
    if (fields[0] !== 'Z' && fields[0] !== 'X') return false;
  }
  if (members > 0) return true;
  try { process.kill(-group, 0); return null; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : null; }
}

function signalGroup(group: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-group, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function cleanGroup(group: number, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  if (await groupDone(group) === true) return true;
  if (!signalGroup(group, 'SIGTERM')) return false;
  const grace = Math.min(until, Date.now() + Math.min(500, Math.floor(waitMs / 2)));
  while (Date.now() < grace) {
    if (await groupDone(group) === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (await groupDone(group) !== true && !signalGroup(group, 'SIGKILL')) return false;
  while (Date.now() < until) {
    if (await groupDone(group) === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await groupDone(group) === true;
}

function runLinux(command: RegisteredCommand, options: RunOptions,
  maxOutputBytes: number, terminationWaitMs: number): Promise<OwnedProcessOutcome> {
  return new Promise((resolveResult) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command.executable, [...command.args], { cwd: command.cwd, env: { ...command.env },
        detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolveResult(empty('spawn-error', true)); return; }
    let reason: Reason | undefined;
    let exited = false;
    let exitCode: number | null = null;
    let settled = false;
    let cleanup: Promise<boolean> | undefined;
    const finish = (outcome: OwnedProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
      resolveResult(outcome);
    };
    const startCleanup = (): Promise<boolean> => {
      if (!cleanup) cleanup = child.pid ? cleanGroup(child.pid, terminationWaitMs) : Promise.resolve(false);
      return cleanup;
    };
    const stop = (value: Reason) => {
      if (reason || settled) return;
      reason = value;
      void startCleanup();
    };
    const cancel = () => stop('cancelled');
    const output = collector(maxOutputBytes, stop);
    const timeout = setTimeout(() => stop('timed-out'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdout.on('data', output.addStdout);
    child.stderr.on('data', output.addStderr);
    child.once('error', () => finish({ ...empty(child.pid === undefined ? 'spawn-error' : 'unverifiable',
      child.pid === undefined), ...output.result() }));
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      void startCleanup();
    });
    child.once('close', async () => {
      if (settled) return;
      const verified = await startCleanup();
      const data = output.result();
      const status = verified && exited && (output.valid() || reason === 'output-limit')
        && (reason || exitCode !== null)
        ? reason ?? 'exited' : 'unverifiable';
      finish({ status, exitCode: status === 'exited' ? exitCode : null,
        terminationConfirmed: verified && exited, cleanupVerified: verified, ...data });
    });
  });
}

export async function runOwnedCommand(command: RegisteredCommand, options: RunOptions): Promise<OwnedProcessOutcome> {
  const { maxOutputBytes, terminationWaitMs } = limits(command, options);
  if (options.signal?.aborted) return empty('cancelled', true);
  if (process.platform === 'win32') return runWindows(command, options, maxOutputBytes, terminationWaitMs);
  if (process.platform === 'linux') return runLinux(command, options, maxOutputBytes, terminationWaitMs);
  throw new OwnedProcessError('invalid-input', '지원하지 않는 운영 체제입니다.');
}
