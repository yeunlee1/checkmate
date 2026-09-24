// 실제 CLI 프로세스의 JSON 출력과 오류 및 읽기 전용 동작을 검증한다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { completeResult } from './결과자료.js';

const cli = resolve('packages/engine/dist/명령.js');
let directory: string;
const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', timeout: 10000 });

beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'checkmate-검사-')); });
afterAll(async () => {
  const child = relative(tmpdir(), directory);
  if (!child.startsWith('checkmate-검사-') || child.startsWith('..') || isAbsolute(child)) throw new Error('시험 폴더 범위를 벗어났습니다.');
  await rm(directory, { recursive: true, force: true });
});

describe('명령 입구', () => {
  it('진단은 DB나 이력을 생성하지 않고 제공 기능과 설치본 제한을 표시한다.', async () => {
    const before = await readdir(directory);
    const result = invoke('doctor', '--json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { stage: 'development', capabilities: ['report-validation', 'project-runs', 'database', 'mcp'], unavailable: ['installer'] } });
    expect(await readdir(directory)).toEqual(before);
  });

  it('한글과 공백 경로의 결과를 변경 없이 검증한다.', async () => {
    const path = join(directory, '정상 결과.json');
    const content = JSON.stringify(completeResult());
    await writeFile(path, content);
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { validation: 'consistent', evidenceAuthenticated: false, reportedVerdict: 'passed' } });
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8192);
  });

  it('증거가 빠진 성공 보고서의 통과 주장을 거절한다.', async () => {
    const path = join(directory, '거짓통과.json');
    await writeFile(path, JSON.stringify(completeResult({ evidenceVerified: false })));
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('invalid-report');
  });

  it('올바른 실패 보고서의 형식 검증과 검사 실패를 구분한다.', async () => {
    const path = join(directory, '실패결과.json');
    const report = completeResult({ verdict: 'failed', workerExitCode: 1 });
    await writeFile(path, JSON.stringify(report));
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { reportedVerdict: 'failed', evidenceAuthenticated: false } });
  });

  it('손상된 JSON에 들어 있는 원본 값을 오류로 노출하지 않는다.', async () => {
    const path = join(directory, '손상결과.json');
    await writeFile(path, '{ "private": "synthetic-private-value",');
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-value');
    expect(JSON.parse(result.stdout).error.code).toBe('report-json');
  });

  it('지원하지 않는 버전은 별도 종료코드로 알려준다.', async () => {
    const path = join(directory, '새버전.json');
    await writeFile(path, JSON.stringify({ ...completeResult(), schemaVersion: 2 }));
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout).error.code).toBe('unsupported-version');
  });

  it('잘못된 UTF-8을 묵인하지 않는다.', async () => {
    const path = join(directory, '잘못된인코딩.json');
    await writeFile(path, Buffer.from([0xFF, 0xFE, 0x7B]));
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('report-encoding');
  });

  it('과대 파일을 읽기 전에 거절한다.', async () => {
    const path = join(directory, '과대결과.json');
    await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1));
    const result = invoke('report', 'validate', path, '--json');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('report-size');
  });

  it('미지원 명령의 JSON에도 다른 출력이 섞이지 않는다.', () => {
    const result = invoke('run', '--json');
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).error.code).toBe('invalid-input');
  });
});
