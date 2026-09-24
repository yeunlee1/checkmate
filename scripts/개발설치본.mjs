// 검증된 Node와 엔진을 동봉한 서명 없는 Windows 개발 설치본을 새 폴더에 만든다.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import forge from '@electron-forge/core';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = '24.18.0';
const nodeBase = `https://nodejs.org/dist/v${version}`;
const nodeUrl = `${nodeBase}/win-x64/node.exe`;
const sumsUrl = `${nodeBase}/SHASUMS256.txt`;
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
const nativeSource = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
const scriptPath = fileURLToPath(import.meta.url);
const forgePath = join(root, 'forge.config.cjs');
const zipLauncherSource = join(root, 'scripts', '압축실행기.cs');

function command(executable, args, cwd = root, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${basename(executable)} ${args[0]} 실패. ${result.error?.message ?? result.stderr?.trim() ?? `종료 코드 ${result.status}`}`);
  }
  return result.stdout.trim();
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}

async function download(url, target) {
  const source = new URL(url);
  if (source.protocol !== 'https:' || !['nodejs.org', 'raw.githubusercontent.com'].includes(source.hostname)) throw new Error('허용되지 않은 다운로드 주소입니다.');
  await mkdir(dirname(target), { recursive: true });
  await new Promise((done, fail) => {
    get(source, response => {
      if (response.statusCode !== 200) { response.resume(); fail(new Error(`${source.pathname} 다운로드 실패. HTTP ${response.statusCode}`)); return; }
      pipeline(response, createWriteStream(target, { flags: 'wx' })).then(done, fail);
    }).on('error', fail);
  });
}

async function copyRequired(source, target) {
  if (!(await lstat(source)).isFile()) throw new Error(`필수 파일이 아닙니다. ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function copyJsTree(source, target) {
  for (const item of await readdir(source, { withFileTypes: true })) {
    const from = join(source, item.name);
    const to = join(target, item.name);
    if (item.isDirectory()) await copyJsTree(from, to);
    else if (item.isFile() && item.name.endsWith('.js')) await copyRequired(from, to);
  }
}

async function fingerprint(paths) {
  const rows = [];
  for (const path of [...paths].sort()) rows.push(`${relative(root, path).replaceAll('\\', '/')} ${await sha256(path)}`);
  return { sha256: createHash('sha256').update(rows.join('\n')).digest('hex'), files: rows };
}

async function dependencyInventory(engineRoot) {
  const result = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith('@')) { await scan(path); continue; }
      const manifestPath = join(path, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const licenseFiles = (await readdir(path)).filter(name => /^(LICEN[CS]E|COPYING|NOTICE)(\.|$)/i.test(name));
      result.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? null, licenseFiles });
      const nested = join(path, 'node_modules');
      try { if ((await lstat(nested)).isDirectory()) await scan(nested); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await scan(join(engineRoot, 'node_modules'));
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64에서만 제작할 수 있습니다.');
  const outputRoot = join(root, '.runtime', '개발설치본');
  await mkdir(outputRoot, { recursive: true });
  const runId = randomUUID();
  const runRoot = join(outputRoot, runId);
  const asciiAlias = join(root, '.runtime', `cm-${runId}`);
  await mkdir(runRoot);
  const reportPath = join(runRoot, '제작보고서.json');
  const report = { status: 'started', createdAt: new Date().toISOString(), runRoot, signed: false, installed: false, installationAcceptanceTest: '미실행' };
  try {
    const required = [
      'package.json', 'package-lock.json', 'packages/contracts/package.json', 'packages/engine/package.json', 'packages/desktop/package.json',
      'packages/desktop/dist/main/메인.js', 'packages/desktop/dist/preload/연결.cjs', 'packages/desktop/dist/renderer/index.html',
      'packages/engine/dist/명령.js', 'packages/engine/dist/서비스/상주서비스.js', 'packages/engine/native/작업보호.exe',
    ].map(path => join(root, path));
    for (const path of required) await lstat(path);
    if (!(await lstat(nativeSource)).isFile()) throw new Error(`검증된 Node24 SQLite 모듈이 없습니다. ${nativeSource}`);
    const git = args => command('git', args);
    report.source = { commit: git(['rev-parse', 'HEAD']), dirtyAtStart: git(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0 };
    const sourcePaths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
      .filter(path => !path.split(/[\\/]/).some(part => ['.runtime', 'node_modules', 'dist', 'out'].includes(part)))
      .map(path => join(root, path));
    const sourceFiles = [];
    for (const path of sourcePaths) {
      try { if ((await lstat(path)).isFile()) sourceFiles.push(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    report.source.codeFingerprint = { sha256: (await fingerprint(sourceFiles)).sha256, fileCount: sourceFiles.length };
    const rendererAssets = join(root, 'packages', 'desktop', 'dist', 'renderer', 'assets');
    for (const name of await readdir(rendererAssets)) required.push(join(rendererAssets, name));
    report.source.inputs = await fingerprint([...required, nativeSource, scriptPath, forgePath, zipLauncherSource]);

    const resourceRoot = join(runRoot, 'resources');
    const nodeDir = join(resourceRoot, 'node');
    const nodeExe = join(nodeDir, 'node.exe');
    await mkdir(nodeDir, { recursive: true });
    const sumsPath = join(nodeDir, 'SHASUMS256.txt');
    await download(sumsUrl, sumsPath);
    const sums = await readFile(sumsPath, 'utf8');
    const match = sums.match(/^([a-f0-9]{64})\s+win-x64\/node\.exe\s*$/m);
    if (!match) throw new Error('공식 SHASUMS256.txt에 win-x64/node.exe 항목이 없습니다.');
    const expected = match[1];
    if (process.version === `v${version}` && await sha256(process.execPath) === expected) await copyRequired(process.execPath, nodeExe);
    else await download(nodeUrl, nodeExe);
    if (await sha256(nodeExe) !== expected) throw new Error('동봉 Node의 SHA256이 공식 값과 다릅니다.');
    const nodeIdentity = command(nodeExe, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules})']);
    const identity = JSON.parse(nodeIdentity);
    if (identity.version !== `v${version}` || identity.platform !== 'win32' || identity.arch !== 'x64') throw new Error('동봉 Node 버전 또는 아키텍처가 다릅니다.');
    await download(licenseUrl, join(nodeDir, 'LICENSE'));
    report.node = { version: identity.version, platform: identity.platform, arch: identity.arch, abi: identity.abi, sha256: expected, url: nodeUrl, licenseUrl, licenseSha256: await sha256(join(nodeDir, 'LICENSE')) };

    const engineRoot = join(resourceRoot, 'engine');
    for (const path of required.slice(0, 5)) await copyRequired(path, join(engineRoot, relative(root, path)));
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await lstat(npmCli);
    command(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], engineRoot);
    for (const name of ['contracts', 'engine']) {
      await copyJsTree(join(root, 'packages', name, 'dist'), join(engineRoot, 'packages', name, 'dist'));
    }
    await copyRequired(join(root, 'packages', 'engine', 'native', '작업보호.exe'), join(engineRoot, 'packages', 'engine', 'native', '작업보호.exe'));
    const workspaceModules = join(engineRoot, 'node_modules', '@checkmate');
    for (const name of ['contracts', 'engine', 'desktop']) {
      const link = join(workspaceModules, name);
      const status = await lstat(link);
      if (!status.isSymbolicLink()) throw new Error(`예상한 workspace 연결이 아닙니다. ${link}`);
      await unlink(link);
      await mkdir(link);
      await copyRequired(join(engineRoot, 'packages', name, 'package.json'), join(link, 'package.json'));
      if (name !== 'desktop') await copyJsTree(join(engineRoot, 'packages', name, 'dist'), join(link, 'dist'));
      if (name === 'engine') await copyRequired(join(engineRoot, 'packages', name, 'native', '작업보호.exe'), join(link, 'native', '작업보호.exe'));
    }
    const nativeTarget = join(engineRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
    await copyRequired(nativeSource, nativeTarget);
    if (await sha256(nativeTarget) !== await sha256(nativeSource)) throw new Error('SQLite 모듈 복사본의 SHA256이 다릅니다.');
    const abiProbe = 'const Database=require(process.argv[1]);const db=new Database(":memory:");const value=db.prepare("SELECT 1 AS value").get().value;db.close();if(value!==1)process.exit(2);console.log(JSON.stringify({abi:process.versions.modules,value}));';
    const abiResult = JSON.parse(command(nodeExe, ['-e', abiProbe, join(engineRoot, 'node_modules', 'better-sqlite3')]));
    report.node.sqliteLoad = { passed: abiResult.value === 1, abi: abiResult.abi, nativeSha256: await sha256(nativeTarget) };
    const dependencies = await dependencyInventory(engineRoot);
    await writeFile(join(runRoot, '의존성목록.json'), JSON.stringify(dependencies, null, 2), { flag: 'wx' });
    report.dependencies = { count: dependencies.length, list: join(runRoot, '의존성목록.json') };

    const appRoot = join(runRoot, 'app');
    await mkdir(appRoot);
    const desktopPackage = JSON.parse(await readFile(join(root, 'packages', 'desktop', 'package.json'), 'utf8'));
    const appPackage = {
      name: 'checkmate', productName: 'CheckMate', version: '0.1.0-alpha.1',
      author: 'yeunlee1', description: desktopPackage.description, type: 'module',
      main: 'dist/main/메인.js', devDependencies: { electron: '44.4.5' },
      config: { forge: forgePath },
    };
    await writeFile(join(appRoot, 'package.json'), JSON.stringify(appPackage, null, 2), { flag: 'wx' });
    await build({ entryPoints: [join(root, 'packages', 'desktop', 'dist', 'main', '메인.js')], outfile: join(appRoot, 'dist', 'main', '메인.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron', 'node:*'], logLevel: 'warning' });
    await copyRequired(join(root, 'packages', 'desktop', 'dist', 'preload', '연결.cjs'), join(appRoot, 'dist', 'preload', '연결.cjs'));
    await cp(join(root, 'packages', 'desktop', 'dist', 'renderer'), join(appRoot, 'dist', 'renderer'), { recursive: true });
    const squirrelVendor = join(runRoot, 'squirrel-vendor');
    await cp(join(root, 'node_modules', 'electron-winstaller', 'vendor'), squirrelVendor, { recursive: true });
    await copyRequired(join(squirrelVendor, '7z-x64.dll'), join(squirrelVendor, '7z.dll'));
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const compilers = windowsRoot ? [
      join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ] : [];
    const compiler = compilers.find(existsSync);
    if (!compiler) throw new Error('설치된 .NET Framework C# 컴파일러를 찾지 못했습니다.');
    command(compiler, ['/nologo', '/target:exe', `/out:${join(squirrelVendor, '7z.exe')}`, zipLauncherSource]);
    report.squirrelZip = { launcherSha256: await sha256(join(squirrelVendor, '7z.exe')), nativeSha256: await sha256(join(squirrelVendor, '7z-x64.exe')), unicodePathExtra: '0x7075' };
    report.source.stagedAt = new Date().toISOString();
    process.env.CHECKMATE_BUILD_RESOURCE_ROOT = resourceRoot;
    await symlink(runRoot, asciiAlias, 'junction');
    const forgeOut = join(asciiAlias, 'forge');
    let made;
    try {
      made = await forge.api.make({ dir: appRoot, outDir: forgeOut, platform: 'win32', arch: 'x64' });
    } finally {
      await unlink(asciiAlias);
    }
    const packagePath = join(runRoot, 'forge', 'CheckMate-win32-x64');
    const artifacts = made.flatMap(result => result.artifacts.map(path => join(runRoot, relative(asciiAlias, path))));
    if (!artifacts.some(path => basename(path) === 'CheckMate-개발설치.exe')) throw new Error('예상한 개발 설치 파일이 생성되지 않았습니다.');
    report.packagePath = packagePath;
    report.artifacts = [];
    for (const path of artifacts) report.artifacts.push({ path, sha256: await sha256(path) });
    report.source.dirtyAtEnd = git(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(`제작 보고서: ${reportPath}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
