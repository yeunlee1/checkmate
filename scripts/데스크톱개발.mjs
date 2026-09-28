// 개발 화면 서버와 동봉 전 준비된 Electron 앱을 함께 실행한다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--config', 'packages/desktop/vite.config.ts', 'packages/desktop'], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
let application;
const stop = () => { application?.kill(); vite.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (vite.exitCode !== null) throw new Error('화면 서버를 시작하지 못했습니다.');
  try { ready = (await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(300) })).ok; } catch { /* 시작 준비를 기다린다. */ }
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) { vite.kill(); throw new Error('화면 서버의 준비 시간이 초과됐습니다.'); }
const environment = { ...process.env, CHECKMATE_NODE_PATH: process.execPath, CHECKMATE_RENDERER_URL: 'http://127.0.0.1:5173/' };
delete environment.ELECTRON_RUN_AS_NODE;
application = spawn(require('electron'), ['packages/desktop'], { cwd: root, shell: false, windowsHide: false, stdio: 'inherit', env: environment });
application.on('exit', (code) => { vite.kill(); process.exitCode = code ?? 1; });
application.on('error', () => { vite.kill(); process.exitCode = 1; });
