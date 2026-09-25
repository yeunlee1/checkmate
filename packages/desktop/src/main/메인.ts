// 데스크톱 창과 제한된 로컬 서비스 연결 및 사람의 폴더 선택을 관리한다.
import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRequestSchema, errorResponse, ServiceError } from '@checkmate/contracts/api';
import { callService, initializeLocalStore } from '@checkmate/engine/client';
import { exportRunHtml } from '@checkmate/engine/report';
import { ensureLauncher, handleSquirrelEvent, hasOwnedDataRoot } from './설치연결.js';

let squirrelExitCode: number | null = null;
try { if (app.isPackaged && handleSquirrelEvent(process.argv[1])) squirrelExitCode = 0; }
catch (error) { console.error(error); squirrelExitCode = 1; }
if (squirrelExitCode !== null) app.exit(squirrelExitCode);

const here = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = process.env.CHECKMATE_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(app.getPath('appData'), '..', 'Local'), 'CheckMateData');
const nodeExecutable = app.isPackaged ? join(process.resourcesPath, 'node', 'node.exe') : process.env.CHECKMATE_NODE_PATH;
const serviceEntry = app.isPackaged ? join(process.resourcesPath, 'engine', 'packages', 'engine', 'dist', '서비스', '상주서비스.js')
  : fileURLToPath(new URL('../../../engine/dist/서비스/상주서비스.js', import.meta.url));
const cliEntry = app.isPackaged ? join(process.resourcesPath, 'engine', 'packages', 'engine', 'dist', '명령.js')
  : fileURLToPath(new URL('../../../engine/dist/명령.js', import.meta.url));
let window: BrowserWindow | null = null;
let expectedUrl = '';

function checkSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== expectedUrl) throw new ServiceError('untrusted-frame');
}
function dialogText(language: unknown) {
  if (language !== undefined && language !== 'ko' && language !== 'en') throw new ServiceError('invalid-input');
  return (korean: string, english: string) => language === 'en' ? english : korean;
}
function options() {
  if (!nodeExecutable) throw new ServiceError('node-runtime-missing', '개발용 Node 실행 경로가 없습니다. desktop:dev로 실행해 주세요.');
  return { dataRoot, nodeExecutable, serviceEntry };
}
async function refreshLauncher(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    if (await hasOwnedDataRoot(dataRoot)) await ensureLauncher(dataRoot, options().nodeExecutable, cliEntry);
  } catch (error) {
    console.error(error);
    dialog.showErrorBox('CLI 진입점 준비 실패', error instanceof Error ? error.message : String(error));
  }
}

if (squirrelExitCode !== null) { /* 설치 이벤트는 창과 단일 실행 잠금을 사용하지 않는다. */ }
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
  app.setAppUserModelId('com.squirrel.CheckMate.CheckMate');
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await refreshLauncher();
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, title: 'CheckMate', backgroundColor: '#f5f7fb',
    webPreferences: { preload: join(here, '..', 'preload', '연결.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const developmentUrl = !app.isPackaged ? process.env.CHECKMATE_RENDERER_URL : undefined;
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (url.origin !== 'http://127.0.0.1:5173' || url.pathname !== '/') throw new ServiceError('invalid-renderer-url');
    expectedUrl = url.href;
  } else expectedUrl = new URL('../renderer/index.html', import.meta.url).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== expectedUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  ipcMain.handle('checkmate:request', async (event, raw: unknown) => {
    checkSender(event);
    const requestId = randomUUID();
    try {
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 256 * 1024) throw new ServiceError('message-too-large');
      const request = apiRequestSchema.parse(raw);
      return await callService(request, options());
    } catch (error) { return errorResponse(requestId, error); }
  });
  ipcMain.handle('checkmate:choose-directory', async (event, purpose?: string, language?: unknown) => {
    checkSender(event);
    const t = dialogText(language);
    const title = purpose === 'backup' ? t('완성된 백업 폴더 선택', 'Choose a completed backup') : purpose === 'restore' ? t('복구할 새 빈 자료 폴더 선택', 'Choose an empty folder for recovery') : t('검사할 프로젝트 폴더 선택', 'Choose a project to test');
    const result = await dialog.showOpenDialog(window!, { title, buttonLabel: t('폴더 선택', 'Choose folder'), properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('checkmate:choose-report', async (event, language?: unknown) => {
    checkSender(event);
    const t = dialogText(language);
    const result = await dialog.showOpenDialog(window!, { title: t('아틀리에 과거 보고서 선택', 'Choose a previous Atelier report'), buttonLabel: t('보고서 선택', 'Choose report'), filters: [{ name: t('JSON 보고서', 'JSON report'), extensions: ['json'] }], properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('checkmate:initialize', async (event) => {
    checkSender(event);
    await initializeLocalStore(options());
    await refreshLauncher();
  });
  ipcMain.handle('checkmate:export', async (event, runId: unknown, language?: unknown) => {
    checkSender(event);
    const id = randomUUID();
    try {
      const t = dialogText(language);
      const request = apiRequestSchema.parse({ apiVersion: 1, requestId: id, method: 'result', input: { runId, section: 'summary' } });
      const html = await exportRunHtml((method, input) => callService(apiRequestSchema.parse({ ...request, requestId: randomUUID(), method, input }), options()), String(runId), language === 'en' ? 'en' : 'ko');
      const selected = await dialog.showSaveDialog(window!, { title: t('검증 보고서 저장', 'Save test report'), buttonLabel: t('보고서 저장', 'Save report'), defaultPath: `${t('검증보고서', 'CheckMate-report')}-${String(runId).slice(0, 8)}.html`, filters: [{ name: t('HTML 보고서', 'HTML report'), extensions: ['html'] }] });
      if (selected.canceled || !selected.filePath) return { apiVersion: 1, requestId: id, ok: true, data: { cancelled: true } };
      await writeFile(selected.filePath, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { apiVersion: 1, requestId: id, ok: true, data: { path: selected.filePath } };
    } catch (error) { return errorResponse(id, error instanceof Error && 'code' in error && error.code === 'EEXIST'
      ? new ServiceError('file-exists', '같은 이름의 파일이 있습니다. 새 파일 이름을 선택해 주세요.') : error); }
  });
  ipcMain.handle('checkmate:connection-info', async (event) => {
    checkSender(event);
    return { version: app.getVersion(), dataPath: dataRoot, mcpCommand: { command: options().nodeExecutable, args: [cliEntry, '--data-dir', dataRoot, 'mcp'] } };
  });
  await window.loadURL(expectedUrl);
  window.on('closed', () => { window = null; });
  app.on('window-all-closed', () => app.quit());
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('CheckMate 시작 실패', '앱 화면을 준비하지 못했습니다. 앱을 다시 시작해 주세요.');
    app.exit(1);
  });
}
