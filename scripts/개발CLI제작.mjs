// 깨끗한 소스를 빌드하고 Windows 실행 helper를 포함한 고정 개발 CLI를 검증해 만든다.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const command = async (file, args) => (await execute(file, args, {
  cwd: root, shell: false, windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
})).stdout.trim();
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Windows x64와 Node 24에서 제작해 주세요.');
  if (process.argv.length !== 2) throw new Error('추가 인자 없이 실행해 주세요.');
  const sourceCommit = await command('git', ['rev-parse', 'HEAD']);
  const assertSource = async () => {
    if (await command('git', ['rev-parse', 'HEAD']) !== sourceCommit
      || await command('git', ['status', '--porcelain=v1', '--untracked-files=normal']))
      throw new Error('소스 커밋과 추적·미추적 변경이 없는 상태를 먼저 확인해 주세요.');
  };
  await assertSource();
  const output = join(root, '.runtime', '개발CLI', `${sourceCommit}-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const report = { sourceCommit, createdAt: new Date().toISOString(), output, status: 'started', standalone: false };
  const reportPath = join(output, '제작결과.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  try {
    const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const buildLog = await command(process.execPath, [npm, 'run', 'build']);
    await writeFile(join(output, '빌드.log'), buildLog + '\n', { flag: 'wx' });
    await assertSource();
    const engine = join(root, 'packages', 'engine');
    const files = [];
    async function collect(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await collect(path);
        else if (item.isFile() && item.name.endsWith('.js')) files.push(path);
        else if (item.isSymbolicLink()) throw new Error('실행물에 링크를 포함할 수 없습니다.');
      }
    }
    await collect(join(engine, 'dist'));
    const helper = join(engine, 'native', '작업보호.exe');
    if (!(await lstat(helper)).isFile()) throw new Error('Windows 작업 보호 helper가 없습니다.');
    files.push(helper);
    const sha256 = {};
    for (const source of files.sort()) {
      const name = relative(engine, source).replaceAll('\\', '/');
      const target = join(output, name);
      await mkdir(dirname(target), { recursive: true });
      const before = await hash(source);
      await copyFile(source, target);
      if (await hash(target) !== before || await hash(source) !== before) throw new Error(`실행물 복사 중 내용이 달라졌습니다. ${name}`);
      sha256[name] = before;
    }
    await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', { flag: 'wx' });
    const cli = join(output, 'dist', '명령.js');
    const doctor = JSON.parse(await command(process.execPath, [cli, '--json', 'doctor']));
    if (!doctor.ok || !doctor.data.supportedRuntime) throw new Error('고정 CLI의 실행 환경 진단이 실패했습니다.');
    const ownedModule = pathToFileURL(join(output, 'dist', '작업', '소유실행.js')).href;
    const probe = `import { runOwnedCommand } from ${JSON.stringify(ownedModule)};
const result = await runOwnedCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("checkmate-development-cli")'], cwd: ${JSON.stringify(root)}, env: {} }, { timeoutMs: 5000 });
console.log(JSON.stringify(result));`;
    const execution = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', probe]));
    if (execution.status !== 'exited' || execution.exitCode !== 0 || !execution.terminationConfirmed || !execution.cleanupVerified
      || execution.stdout !== 'checkmate-development-cli' || execution.stderr !== '')
      throw new Error('고정 CLI의 합성 명령 실행·종료·정리 확인이 실패했습니다.');
    await assertSource();
    for (const [name, expected] of Object.entries(sha256)) {
      if (await hash(join(engine, name)) !== expected || await hash(join(output, name)) !== expected)
        throw new Error(`검증 중 실행물이 달라졌습니다. ${name}`);
    }
    const manifest = { sourceCommit, sha256, standalone: false, execution,
      notes: '저장소의 설치된 의존성을 사용하는 Windows 개발 CLI다. 설치본이 아니며 의존성 교체 후 동일 실행을 보장하지 않는다.' };
    await writeFile(join(output, '버전.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    Object.assign(report, { status: 'passed', cli, fileCount: files.length, helperSha256: sha256['native/작업보호.exe'], execution });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    Object.assign(report, { status: 'failed', message: '제작 또는 실행 검증이 실패했습니다. 이 폴더를 개발 CLI로 사용하지 마세요.' });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    throw error;
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
