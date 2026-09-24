// 임시 합성 프로젝트로 원본 계약과 읽기 전용 소스 지문을 검증한다.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectSource, fingerprintSource, ProjectSourceError } from '../packages/engine/src/프로젝트/원본읽기.js';

const tempBase = resolve(tmpdir());
let root: string;
let project: Record<string, unknown>;
let requirements: Record<string, unknown>[];
let checks: Record<string, unknown>[];

async function save(): Promise<void> {
  const directory = join(root, 'checkmate');
  await mkdir(directory, { recursive: true });
  for (const [name, value] of [
    ['프로젝트.json', project], ['요구사항.json', requirements], ['검사항목.json', checks],
  ] as const) await writeFile(join(directory, name), JSON.stringify(value), 'utf8');
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ProjectSourceError ? error.code : undefined;
}

beforeEach(async () => {
  root = await mkdtemp(join(tempBase, 'checkmate-source-'));
  project = {
    schemaVersion: 1, id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'synthetic:project',
    commands: [{ id: 'run', title: '검사 실행', runtime: 'node', entry: 'tests/run.mjs',
      args: ['--json'], timeoutMs: 1000, env: { NODE_ENV: 'test', CHECKMATE_MODE: 'safe' },
      writes: ['output/results.ndjson'], resultFormat: 'ndjson' }],
    profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1', 'check-2'] }],
  };
  requirements = [{ id: 'req-1', title: '기능', description: '정상 결과를 확인한다.' }];
  checks = [
    { id: 'check-1', title: '필수 검사', requirementId: 'req-1', commandId: 'run',
      required: true, kind: 'logic', expected: '성공', codePaths: ['src/main.ts'] },
    { id: 'check-2', title: '선택 검사', requirementId: 'req-1', commandId: 'run',
      required: false, kind: 'security', expected: '안전', codePaths: [] },
  ];
  await save();
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1;\n');
});

afterEach(async () => {
  if (root && root.startsWith(`${tempBase}${process.platform === 'win32' ? '\\' : '/'}`)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('프로젝트 원본', () => {
  it('세 원본을 읽고 안정된 해시와 실제 경로를 반환한다.', async () => {
    const first = await readProjectSource(root);
    const second = await readProjectSource(root);
    expect(first.realPath).toBe(root);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).toEqual(second);
    expect(first.source.project.commands).toHaveLength(1);
    expect(first.source.checks).toHaveLength(2);
  });

  it('카탈로그 수정은 두 해시를 바꾸고 키 순서만 바꿔도 카탈로그 해시는 유지한다.', async () => {
    const first = await readProjectSource(root);
    project = { ...project, name: '변경된 이름' };
    await save();
    const changed = await readProjectSource(root);
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.sourceHash).not.toBe(first.sourceHash);
    project = Object.fromEntries(Object.entries(project).reverse());
    await save();
    expect((await readProjectSource(root)).contentHash).toBe(changed.contentHash);
  });

  it('수정 및 미추적 파일을 포함하고 제외 자료 변화는 무시한다.', async () => {
    const first = await fingerprintSource(root);
    await writeFile(join(root, 'src', 'main.ts'), 'export const value = 2;\n');
    const modified = await fingerprintSource(root);
    expect(modified).not.toBe(first);
    await writeFile(join(root, 'src', 'new.ts'), 'export const fresh = true;\n');
    const untracked = await fingerprintSource(root);
    expect(untracked).not.toBe(modified);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, '.git', 'HEAD'), 'changed');
    await writeFile(join(root, 'node_modules', 'lib.js'), 'changed');
    await writeFile(join(root, '.env.local'), 'secret');
    await writeFile(join(root, 'private.pem'), 'secret');
    expect(await fingerprintSource(root)).toBe(untracked);
  });

  it.each(['dist', 'out', 'node_modules', '.runtime', '.git', 'coverage', '.vite'])(
    '%s 안의 명령 진입점은 재빌드 전에도 거절하고 일반 Node 경로는 허용한다.', async (directory) => {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, 'run.mjs'), 'process.exit(0);');
      (project.commands as Record<string, unknown>[])[0]!.entry = `${directory}/run.mjs`;
      await save();
      await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
      await writeFile(join(root, directory, 'run.mjs'), 'process.exit(9);');
      await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
      (project.commands as Record<string, unknown>[])[0]!.entry = 'tests/run.mjs';
      await mkdir(join(root, 'tests'));
      await writeFile(join(root, 'tests', 'run.mjs'), 'process.exit(0);');
      await save();
      const approved = await readProjectSource(root);
      await writeFile(join(root, 'tests', 'run.mjs'), 'process.exit(9);');
      expect((await readProjectSource(root)).sourceHash).not.toBe(approved.sourceHash);
    });

  it('중복과 없는 참조 및 필수 검사가 없는 프로필을 거절한다.', async () => {
    checks.push({ ...checks[0] });
    await save();
    await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
    checks.pop();
    checks[0] = { ...checks[0], commandId: 'missing' };
    await save();
    await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
    checks[0] = { ...checks[0], commandId: 'run' };
    (project.profiles as Record<string, unknown>[])[0] = { id: 'quick', title: '빠른 검사', checkIds: ['check-2'] };
    await save();
    await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
  });

  it('탈출 경로와 비밀 환경 변수 및 허용되지 않은 환경 변수를 거절한다.', async () => {
    const command = (project.commands as Record<string, unknown>[])[0]!;
    for (const entry of ['../outside.mjs', 'C:/outside.mjs', 'tests/file.mjs:secret', 'tests\\run.mjs']) {
      command.entry = entry;
      await save();
      await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
    }
    command.entry = 'tests/run.mjs';
    for (const env of [{ CHECKMATE_API_TOKEN: 'hidden' }, { OTHER_MODE: 'test' }]) {
      command.env = env;
      await save();
      await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
    }
  });

  it('원본 파일 크기와 전체 소스 크기 제한을 거절한다.', async () => {
    await writeFile(join(root, 'checkmate', '요구사항.json'), ' '.repeat(1024 * 1024 + 1));
    await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'source-too-large' });
    await save();
    const large = join(root, 'src', 'large.bin');
    await writeFile(large, '');
    await truncate(large, 256 * 1024 * 1024 + 1);
    await expect(fingerprintSource(root)).rejects.toMatchObject({ code: 'source-too-large' });
  });

  it('정의 배열 상한과 명령 제한 시간을 강제한다.', async () => {
    requirements = Array.from({ length: 1001 }, (_, index) => ({
      id: `req-${index}`, title: '요구사항', description: '합성 설명',
    }));
    await save();
    await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
    requirements = [{ id: 'req-1', title: '기능', description: '정상 결과를 확인한다.' }];
    (project.commands as Record<string, unknown>[])[0]!.timeoutMs = 3_600_001;
    await save();
    await expect(readProjectSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
  });

  it('링크와 손상된 원본을 거절하며 내용은 오류에 싣지 않는다.', async () => {
    const outside = await mkdtemp(join(tempBase, 'checkmate-outside-'));
    try {
      await writeFile(join(outside, 'private.txt'), '비밀 값');
      let linkCreated = false;
      try {
        await symlink(join(outside, 'private.txt'), join(root, 'src', 'linked.txt'));
        linkCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
      if (linkCreated) await expect(fingerprintSource(root)).rejects.toMatchObject({ code: 'invalid-project' });
      if (!linkCreated && process.platform === 'win32') {
        const junction = join(root, 'src', 'linked-dir');
        await symlink(outside, junction, 'junction');
        try { await expect(fingerprintSource(root)).rejects.toMatchObject({ code: 'invalid-project' }); }
        finally { await unlink(junction); }
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
    await writeFile(join(root, 'checkmate', '요구사항.json'), '비밀 값');
    try { await readProjectSource(root); }
    catch (error) {
      expect(codeOf(error)).toBe('invalid-project');
      expect(String(error)).not.toContain('비밀 값');
    }
  });
});
