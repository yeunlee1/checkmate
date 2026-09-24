// 데스크톱 창과 제한된 로컬 서비스 연결 및 사람의 폴더 선택을 관리한다.
import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRequestSchema, errorResponse, ServiceError } from '@checkmate/contracts/api';
import { callService, initializeLocalStore } from '@checkmate/engine/client';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = process.env.CHECKMATE_DATA_DIR ?? join(app.getPath('appData'), '..', 'Local', 'CheckMate');
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
function options() {
  if (!nodeExecutable) throw new ServiceError('node-runtime-missing', '개발용 Node 실행 경로가 없습니다. desktop:dev로 실행해 주세요.');
  return { dataRoot, nodeExecutable, serviceEntry };
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
  app.setAppUserModelId('com.squirrel.CheckMate.CheckMate');
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
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
  ipcMain.handle('checkmate:choose-directory', async (event, purpose?: string) => {
    checkSender(event);
    const title = purpose === 'backup' ? '완성된 백업 폴더 선택' : purpose === 'restore' ? '복구할 새 빈 자료 폴더 선택' : '검사할 프로젝트 폴더 선택';
    const result = await dialog.showOpenDialog(window!, { title, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('checkmate:initialize', async (event) => { checkSender(event); await initializeLocalStore(options()); });
  ipcMain.handle('checkmate:connection-info', async (event) => {
    checkSender(event);
    return { version: app.getVersion(), dataPath: dataRoot, mcpCommand: { command: options().nodeExecutable, args: [cliEntry, '--data-dir', dataRoot, 'mcp'] } };
  });
  await window.loadURL(expectedUrl);
  window.on('closed', () => { window = null; });
  app.on('window-all-closed', () => app.quit());
  }).catch(() => {
    dialog.showErrorBox('CheckMate 시작 실패', '앱 화면을 준비하지 못했습니다. 앱을 다시 시작해 주세요.');
    app.exit(1);
  });
}
