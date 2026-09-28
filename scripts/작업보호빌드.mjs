// Windows에서 소유 프로세스 Job Object helper를 .NET Framework 컴파일러로 빌드한다.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stdout.write('비 Windows에서는 작업 보호 helper 빌드를 건너뜁니다.\n');
} else if (Number(process.versions.node.split('.')[0]) !== 24) {
  process.stderr.write('Node 24가 필요합니다.\n');
  process.exitCode = 2;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(root, 'packages', 'engine', 'native', '작업보호.cs');
  const output = join(root, 'packages', 'engine', 'native', '작업보호.exe');
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const paths = windowsRoot ? [
    join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ] : [];
  const compiler = paths.find(existsSync);
  if (!compiler || !existsSync(source)) {
    process.stderr.write('설치된 .NET Framework C# 컴파일러 또는 helper 소스를 찾지 못했습니다.\n');
    process.exitCode = 2;
  } else {
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${output}`, source], {
      cwd: root, shell: false, windowsHide: true, encoding: 'utf8',
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    process.exitCode = result.status ?? 2;
  }
}
