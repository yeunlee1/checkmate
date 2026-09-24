// 소유한 임시 폴더에서 Stryker를 실행하고 정규화한 검출력 근거를 기록한다.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from '@checkmate/engine/reporter';
import { adaptStrykerReport } from '@checkmate/engine/mutation';

const profile = process.argv[2];
if (profile !== 'strong' && profile !== 'weak') throw new Error('strong 또는 weak 프로필이 필요합니다.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime');
const runId = randomUUID();
const work = join(runtime, runId);
const sourceFiles = ['권한.mjs', `tests/${profile === 'strong' ? '강한' : '약한'}.test.mjs`, 'tests/검사.mjs'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = new Map(await Promise.all(sourceFiles.map(async (name) =>
  [name, digest(await readFile(join(root, name)))])));
const reporter = createReporter();
const stryker = resolve(root, '..', '..', 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');

async function runStryker() {
  return new Promise((finish, reject) => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const windowsEnvironment = process.platform === 'win32' && systemRoot
      ? { PATH: `${join(systemRoot, 'System32')};${systemRoot}`,
        ComSpec: join(systemRoot, 'System32', 'cmd.exe') } : {};
    const child = spawn(process.execPath, [stryker, 'run', 'stryker.config.json'], {
      cwd: work, shell: false, windowsHide: true, detached: false,
      env: { ...process.env, TEMP: join(work, '임시'), TMP: join(work, '임시'),
        TMPDIR: join(work, '임시'), ...windowsEnvironment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let total = 0;
    const collect = (chunk) => {
      total += chunk.length;
      if (Buffer.byteLength(log) < 64000) log += chunk.toString('utf8').slice(0, 64000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (code, signal) => finish({ code, signal, log: log.slice(0, 64000), total }));
  });
}

let owned = false;
try {
  await mkdir(runtime, { recursive: true });
  const runtimeInfo = await lstat(runtime);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()
    || resolve(await realpath(runtime)) !== resolve(runtime)) throw new Error('임시 폴더 경계가 다릅니다.');
  await mkdir(work);
  owned = true;
  await writeFile(join(work, '소유표식.txt'), runId, { flag: 'wx' });
  await mkdir(join(work, '임시'));
  await writeFile(join(work, '권한.mjs'), await readFile(join(root, '권한.mjs')), { flag: 'wx' });
  await writeFile(join(work, '권한.test.mjs'), await readFile(join(root, `tests/${profile === 'strong' ? '강한' : '약한'}.test.mjs`)), { flag: 'wx' });
  await writeFile(join(work, 'vitest.config.mjs'), `// 격리된 합성 권한 검사를 한 작업자로 실행한다.\nimport { defineConfig } from 'vitest/config';\nexport default defineConfig({ cacheDir: './.cache/vitest', test: { include: ['권한.test.mjs'], fileParallelism: false, maxWorkers: 1 } });\n`, { flag: 'wx' });
  const config = { mutate: ['권한.mjs'], testFiles: ['권한.test.mjs'], testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'], vitest: { configFile: 'vitest.config.mjs', related: false },
    coverageAnalysis: 'off', reporters: ['json'], jsonReporter: { fileName: 'mutation.json' },
    tempDirName: '.stryker-tmp', cleanTempDir: 'always', concurrency: 1,
    thresholds: { high: 80, low: 60, break: 0 } };
  await writeFile(join(work, 'stryker.config.json'), JSON.stringify(config), { flag: 'wx' });
  const execution = await runStryker();
  const logEvidence = await reporter.evidence({ relativePath: `Stryker-${profile}.txt`,
    content: `종료 코드 ${execution.code}, 신호 ${execution.signal ?? '없음'}, 출력 바이트 ${execution.total}\n${execution.log}`,
    mime: 'text/plain', sensitivity: 'restricted' });
  if (execution.code !== 0) throw new Error(`Stryker 종료 코드 ${execution.code}, 로그 증거 ${logEvidence.id}`);
  const normalized = adaptStrykerReport(JSON.parse(await readFile(join(work, 'mutation.json'), 'utf8')),
    { id: profile, files: ['권한.mjs'] });
  for (const [name, hash] of original) {
    if (digest(await readFile(join(root, name))) !== hash) throw new Error(`원본 바이트가 변경되었습니다. ${name}`);
  }
  const evidence = await reporter.evidence({ relativePath: `변이보고서-${profile}.json`,
    content: JSON.stringify(normalized), mime: 'application/json', sensitivity: 'public', synthetic: true });
  const status = normalized.status === 'unverified' ? 'unknown' : normalized.status;
  const score = normalized.score;
  const observed = `Stryker ${normalized.status}, Killed ${normalized.counts.Killed}, Survived ${normalized.counts.Survived}, NoCoverage ${normalized.counts.NoCoverage}, Timeout ${normalized.counts.Timeout}, 점수 ${score ? `${score.detected}/${score.denominator} (${score.percent}%)` : '없음'}`;
  const surviving = normalized.findings.find((item) => item.status === 'Survived' || item.status === 'NoCoverage');
  reporter.caseResult({ testId: `${profile}-mutation`, requirementId: `req-${profile}-mutation`,
    status, expected: '모든 권한 함수 변이가 검출되고 생존 변이가 0개다.', observed,
    evidenceIds: [evidence.id, logEvidence.id], severity: status === 'passed' ? 'info' : 'error',
    location: surviving ? { file: surviving.file, line: surviving.location.start.line } : null });
} finally {
  if (owned) {
    const info = await lstat(work);
    if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(work)) !== await realpath(runtime)
      || await readFile(join(work, '소유표식.txt'), 'utf8') !== runId) {
      throw new Error('자신의 임시 폴더 소유권을 확인하지 못해 정리하지 않았습니다.');
    }
    await rm(work, { recursive: true });
  }
}
