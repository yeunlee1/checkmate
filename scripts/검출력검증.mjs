// 격리된 합성 권한 함수에 Stryker를 실행해 강한 검사와 약한 검사의 차이를 검증한다.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, realpath, access } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptStrykerReport } from '../packages/engine/src/어댑터/검출력검사.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, '.runtime', '검증', '검출력');
const runId = randomUUID();
const workspace = join(base, runId);
const stryker = join(root, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');
const source = `export function mayView(role, enabled) {
  return role === 'admin' && enabled === true;
}
`;

async function runProcess(cwd) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [stryker, 'run', 'stryker.config.json'], {
      cwd, windowsHide: true, env: { ...process.env, TEMP: join(cwd, '임시'),
        TMP: join(cwd, '임시'), TMPDIR: join(cwd, '임시') },
    });
    let output = '';
    const capture = (chunk) => { output = `${output}${chunk.toString()}`.slice(-12000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Stryker 종료 코드 ${code}, 신호 ${signal ?? '없음'}\n${output}`));
    });
  });
}

async function scenario(name, strong) {
  const directory = join(workspace, name);
  await mkdir(join(directory, '임시'), { recursive: true });
  await writeFile(join(directory, '계산.mjs'), source, 'utf8');
  const tests = strong
    ? `import { it, expect } from 'vitest';
import { mayView } from './계산.mjs';
it('관리자만 활성 권한을 가진다', () => {
  expect(mayView('admin', true)).toBe(true);
  expect(mayView('viewer', true)).toBe(false);
  expect(mayView('admin', false)).toBe(false);
});
`
    : `import { it, expect } from 'vitest';
import { mayView } from './계산.mjs';
it('활성 관리자만 확인한다', () => {
  expect(mayView('admin', true)).toBe(true);
});
`;
  await writeFile(join(directory, '계산.test.mjs'), tests, 'utf8');
  await writeFile(join(directory, 'vitest.config.mjs'), `import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: './.cache/vitest', test: {
  include: ['계산.test.mjs'], fileParallelism: false, maxWorkers: 1,
} });
`, 'utf8');
  const config = {
    mutate: ['계산.mjs'], testFiles: ['계산.test.mjs'], testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'], vitest: { configFile: 'vitest.config.mjs', related: false },
    coverageAnalysis: 'off', reporters: ['json'], jsonReporter: { fileName: 'mutation.json' },
    tempDirName: '.stryker-tmp', cleanTempDir: 'always', concurrency: 1,
    thresholds: { high: 80, low: 60, break: 0 },
  };
  await writeFile(join(directory, 'stryker.config.json'), JSON.stringify(config), 'utf8');
  console.log(`실행 명령 ${process.execPath} ${stryker} run stryker.config.json`);
  await runProcess(directory);
  const raw = JSON.parse(await readFile(join(directory, 'mutation.json'), 'utf8'));
  const result = adaptStrykerReport(raw, { id: name, files: ['계산.mjs'] });
  if (result.score === null || result.status === 'unverified') {
    throw new Error(`${name} 보고서를 검증할 수 없습니다. ${result.reason ?? ''}`);
  }
  console.log(`${name} killed=${result.counts.Killed} survived=${result.counts.Survived} timeout=${result.counts.Timeout} score=${result.score.detected}/${result.score.denominator}`);
  return result;
}

let created = false;
try {
  await access(stryker);
  await mkdir(base, { recursive: true });
  const actualBase = await realpath(base);
  if (resolve(actualBase) !== resolve(base)) throw new Error('검증 폴더가 다른 경로를 가리킵니다.');
  await mkdir(workspace);
  created = true;
  const actualWorkspace = await realpath(workspace);
  if (!resolve(actualWorkspace).startsWith(`${resolve(actualBase)}${sep}`)
    || dirname(resolve(actualWorkspace)) !== resolve(actualBase)) {
    throw new Error('자신이 생성한 검증 폴더를 확인하지 못했습니다.');
  }
  const strong = await scenario('강한검사', true);
  const weak = await scenario('약한검사', false);
  if (strong.counts.Killed <= weak.counts.Killed || strong.counts.Survived >= weak.counts.Survived
    || strong.score.percent <= weak.score.percent) {
    throw new Error('강한 검사와 약한 검사의 검출력 차이가 확인되지 않았습니다.');
  }
  console.log('실제 변이 검출력 차이 확인 완료.');
} finally {
  if (created) {
    const actualWorkspace = await realpath(workspace);
    if (dirname(resolve(actualWorkspace)) !== resolve(base) || !actualWorkspace.endsWith(runId)) {
      throw new Error('검증 폴더 소유 경계가 달라 정리하지 않았습니다.');
    }
    await rm(workspace, { recursive: true });
    try {
      await access(workspace);
      throw new Error('자신이 만든 검증 폴더가 남았습니다.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
