// 격리된 화면에 검증된 요청과 폴더 선택 기능만 전달한다.
import electron = require('electron');
const { contextBridge, ipcRenderer } = electron;
function language(): 'ko' | 'en' {
  try { return globalThis.localStorage.getItem('checkmate.language') === 'en' ? 'en' : 'ko'; }
  catch { return 'ko'; }
}

contextBridge.exposeInMainWorld('checkmate', {
  request: (method: string, input: Record<string, unknown>, requestId?: string) => ipcRenderer.invoke('checkmate:request', { apiVersion: 1, requestId: requestId ?? globalThis.crypto.randomUUID(), method, input }),
  chooseDirectory: (purpose?: string) => ipcRenderer.invoke('checkmate:choose-directory', purpose, language()),
  chooseReport: () => ipcRenderer.invoke('checkmate:choose-report', language()),
  initializeLocalStore: () => ipcRenderer.invoke('checkmate:initialize'),
  exportReport: (runId: string) => ipcRenderer.invoke('checkmate:export', runId, language()),
  connectionInfo: () => ipcRenderer.invoke('checkmate:connection-info'),
});
