// 격리된 Windows CI에서 자식 PowerShell 환경별 시작과 CIM 조회 시간을 관측한다.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
const pick = names => Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const variants = [
  ['module-only', pick([...keys, 'PSModulePath'])],
  ['trusted-both', { ...pick(keys), PSModulePath: [join(process.env.ProgramFiles, 'WindowsPowerShell/Modules'), join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules')].join(';') }],
  ['explicit-import', pick(keys)],
];
for (const [variant, env] of variants) {
  for (const [probe, script] of [
    ['json', "[Console]::WriteLine('before-json'); ConvertTo-Json -Compress -InputObject 'probe-ok'; [Console]::WriteLine('after-json')"],
    ['cim', `[Console]::WriteLine('before-cim'); $item=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'; if ($null -eq $item) { throw 'missing-self' }; [Console]::WriteLine('after-cim'); [Console]::WriteLine((Get-Command Get-CimInstance).Module.Path); [Console]::WriteLine((Get-Command ConvertTo-Json).Module.Path); [Console]::WriteLine('after-commands')`],
  ]) {
    const started = Date.now();
    let prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ";
    if (variant === 'explicit-import') prefix += `Import-Module '${join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')}' -ErrorAction Stop; Import-Module '${join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules/CimCmdlets/CimCmdlets.psd1')}' -ErrorAction Stop; `;
    try {
      const result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', prefix + script],
        { env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      console.log(JSON.stringify({ variant, probe, exit: 0, output: result.stdout.trim(), durationMs: Date.now() - started, stderrBytes: result.stderr.length }));
    } catch (error) {
      console.log(JSON.stringify({ variant, probe, exit: error.code ?? null, signal: error.signal ?? null,
        killed: error.killed ?? false, durationMs: Date.now() - started, output: error.stdout?.slice(0, 1500) ?? '',
        stderrBytes: error.stderr?.length ?? 0, error: error.message.split('\n')[0].slice(0, 100) }));
    }
  }
}
