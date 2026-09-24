// 실제 Node 부모와 자손으로 소유 트리 종료와 무관한 프로세스 생존을 검증한다.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOwnedCommand, type OwnedProcessOutcome } from '../packages/engine/src/작업/소유실행.js';
import type { RegisteredCommand } from '../packages/engine/src/작업실행.js';

const cwd = resolve(process.cwd());
const children = new Set<number>();

function command(script: string, args: string[] = []): RegisteredCommand {
  return { executable: process.execPath, args: ['-e', script, '--', ...args], cwd, env: {} };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function gone(pid: number): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (!alive(pid)) return true;
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        if (/\)\s+[ZX]\s/u.test(stat)) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

function childPid(result: OwnedProcessOutcome): number {
  const match = result.stdout.match(/CHILD:(\d+)/u);
  expect(match).not.toBeNull();
  const pid = Number(match?.[1]);
  expect(Number.isSafeInteger(pid)).toBe(true);
  children.add(pid);
  return pid;
}

const descendant = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write('CHILD:'+child.pid+'\\n');";

beforeAll(() => {
  if (process.platform !== 'win32' && process.platform !== 'linux') throw new Error('지원하지 않는 시험 운영 체제입니다.');
});

afterAll(async () => {
  for (const pid of children) {
    if (!alive(pid)) continue;
    try { process.kill(pid); } catch { /* 시험에서 만든 자손이 이미 종료될 수 있다. */ }
  }
});

describe('소유 프로세스 실행', () => {
  it('인자 공백과 한글, 따옴표, 끝 역슬래시를 그대로 전달하고 종료코드를 보존한다.', async () => {
    const values = ['한글 공백', 'a"b', '끝\\', ''];
    const result = await runOwnedCommand(command("process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write('오류');process.exit(9)", values),
      { timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 'exited', exitCode: 9, terminationConfirmed: true,
      cleanupVerified: true });
    expect(JSON.parse(result.stdout)).toEqual(values);
    expect(result.stderr).toBe('오류');
  });

  it('부모가 정상 종료해도 남은 자손을 정리한다.', async () => {
    const result = await runOwnedCommand(command(descendant), { timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, cleanupVerified: true });
    expect(await gone(childPid(result))).toBe(true);
  });

  it('시간 제한 뒤 소유 자손을 정리하고 무관한 sibling은 살려 둔다.', async () => {
    const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { cwd, env: {}, shell: false, stdio: 'ignore' });
    const siblingPid = sibling.pid;
    expect(siblingPid).toBeDefined();
    try {
      const result = await runOwnedCommand(command(`${descendant}setInterval(()=>{},1000);`),
        { timeoutMs: 900, terminationWaitMs: 5000 });
      expect(result).toMatchObject({ status: 'timed-out', exitCode: null, cleanupVerified: true });
      expect(await gone(childPid(result))).toBe(true);
      expect(alive(siblingPid!)).toBe(true);
    } finally {
      sibling.kill();
      await new Promise((resolve) => sibling.once('close', resolve));
    }
  });

  it('취소 뒤 소유 자손을 정리한다.', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const result = await runOwnedCommand(command(`${descendant}setInterval(()=>{},1000);`),
        { timeoutMs: 5000, signal: controller.signal });
      expect(result).toMatchObject({ status: 'cancelled', exitCode: null, cleanupVerified: true });
      expect(await gone(childPid(result))).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it('출력 제한과 시작 실패를 구분한다.', async () => {
    const limited = await runOwnedCommand(command("process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"),
      { timeoutMs: 5000, maxOutputBytes: 256 });
    expect(limited).toMatchObject({ status: 'output-limit', cleanupVerified: true });
    expect(Buffer.byteLength(limited.stdout) + Buffer.byteLength(limited.stderr)).toBeLessThanOrEqual(256);
    const invalid = { ...command(''), executable: resolve(cwd, '존재하지않는실행파일.exe') };
    const failure = await runOwnedCommand(invalid, { timeoutMs: 5000 });
    expect(failure).toMatchObject({ status: 'spawn-error', exitCode: null, cleanupVerified: true });
  });

  it('손상된 UTF-8을 정상 텍스트나 성공으로 표시하지 않는다.', async () => {
    const result = await runOwnedCommand(command('process.stdout.write(Buffer.from([255]))'),
      { timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 'unverifiable', stdout: '', cleanupVerified: true });
  });

  it('호출자 환경의 합성 비밀 변수를 대상에게 상속하지 않는다.', async () => {
    process.env.CHECKMATE_SYNTHETIC_SECRET = 'synthetic-value';
    try {
      const result = await runOwnedCommand(command(
        "process.stdout.write(process.env.CHECKMATE_SYNTHETIC_SECRET ? 'leaked' : 'clear')"),
      { timeoutMs: 5000 });
      expect(result).toMatchObject({ status: 'exited', exitCode: 0, stdout: 'clear' });
    } finally { delete process.env.CHECKMATE_SYNTHETIC_SECRET; }
  });

  it('시작 전 취소는 대상 프로세스를 만들지 않는다.', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runOwnedCommand(command('process.exit(99)'),
      { timeoutMs: 5000, signal: controller.signal });
    expect(result).toMatchObject({ status: 'cancelled', exitCode: null,
      terminationConfirmed: true, cleanupVerified: true, outputBytes: 0 });
  });

  it.skipIf(process.platform !== 'win32')('helper stdin EOF가 본인 Job을 정리한다.', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'checkmate-eof-'));
    const statusPath = join(folder, 'status.txt');
    const helper = resolve(cwd, 'packages/engine/native/작업보호.exe');
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error('Windows 시스템 경로가 없습니다.');
    const child = spawn(helper, [statusPath, process.execPath, cwd, '5000', '1', 'SystemRoot', systemRoot,
      '3', '-e', `${descendant}setInterval(()=>{},1000);`, '--'],
    { cwd, env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      for (let index = 0; index < 100 && !output.includes('CHILD:'); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const match = output.match(/CHILD:(\d+)/u);
      expect(match).not.toBeNull();
      const pid = Number(match?.[1]);
      children.add(pid);
      child.stdin.end();
      await closed;
      expect((await readFile(statusPath, 'utf8')).trim()).toBe('CLEAN');
      expect(await gone(pid)).toBe(true);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await closed;
      try { await unlink(statusPath); } catch { /* helper가 상태를 쓰지 못했을 수 있다. */ }
      try { await rmdir(folder); } catch { /* 시험 경로 외부는 정리하지 않는다. */ }
    }
  });
});
