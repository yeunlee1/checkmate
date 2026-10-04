// 격리된 Windows CI에서 자식 PowerShell 환경별 시작과 CIM 조회 시간을 관측한다.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
const pick = names => Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const variants = [
  ['path-only', pick([...keys, 'PATH'])],
  ['module-only', pick([...keys, 'PSModulePath'])],
  ['trusted-modules', { ...pick(keys), PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') }],
  ['minimal-after', pick(keys)],
];
for (const [variant, env] of variants) {
  for (const [probe, script] of [
    ['constant', "'probe-ok'"],
    ['cim', `$item=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'; if ($null -eq $item) { throw 'missing-self' }; @{pid=[int]$item.ProcessId;startedAt=$item.CreationDate.ToUniversalTime().ToString('o');executable=$item.ExecutablePath;commandLine=$item.CommandLine} | ConvertTo-Json -Compress`],
  ]) {
    const started = Date.now();
    const prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ";
    try {
      const result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', prefix + script],
        { env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      const valid = probe === 'constant' ? result.stdout.trim() === 'probe-ok' : JSON.parse(result.stdout).pid === process.pid;
      console.log(JSON.stringify({ variant, probe, exit: 0, valid, durationMs: Date.now() - started, stderrBytes: result.stderr.length }));
    } catch (error) {
      console.log(JSON.stringify({ variant, probe, exit: error.code ?? null, signal: error.signal ?? null,
        killed: error.killed ?? false, durationMs: Date.now() - started, stdoutBytes: error.stdout?.length ?? 0,
        stderrBytes: error.stderr?.length ?? 0, error: error.message.split('\n')[0].slice(0, 100) }));
    }
  }
}
