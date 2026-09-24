// 승인된 로컬 저장소의 서비스를 찾아 연결하고 없으면 숨김 실행한다.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import { dataPaths, prepareDataPaths } from '../연결/개인경로.js';
import { requestLocal } from '../연결/로컬통신.js';
import type { ClientRole } from '../연결/로컬통신.js';

export type ClientOptions = { dataRoot?: string; nodeExecutable?: string; serviceEntry?: string };
const pending = new Map<string, Promise<void>>();
export async function initializeLocalStore(options: ClientOptions = {}): Promise<void> {
  await prepareDataPaths(dataPaths(options.dataRoot));
}

export async function connectService(options: ClientOptions = {}): Promise<void> {
  const paths = dataPaths(options.dataRoot);
  const existing = pending.get(paths.root);
  if (existing) return existing;
  const work = (async () => {
    try { await access(paths.secret); }
    catch { throw new ServiceError('needs-initialization', '체크메이트 로컬 저장소를 먼저 준비해 주세요.', false, '설정에서 로컬 저장소를 준비하거나 setup --accept-local-storage를 실행해 주세요.'); }
    const probe: ApiRequest = { apiVersion: 1, requestId: randomUUID(), method: 'capabilities', input: {} };
    try { await requestLocal(paths, probe); return; }
    catch (error) { if (!(error instanceof ServiceError) || error.code !== 'service-unavailable') throw error; }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.CHECKMATE_DATA_DIR = paths.root;
    const child = spawn(options.nodeExecutable ?? process.execPath, [options.serviceEntry ?? fileURLToPath(new URL('./상주서비스.js', import.meta.url))], {
      detached: true, windowsHide: true, shell: false, stdio: 'ignore', env, cwd: paths.root,
    });
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    child.unref();
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (spawnFailed) throw new ServiceError('service-start-failed', '로컬 서비스를 시작할 수 없습니다.');
      await new Promise((resolve) => setTimeout(resolve, 150));
      try { await requestLocal(paths, probe); return; }
      catch (error) { if (!(error instanceof ServiceError) || !['service-unavailable', 'service-disconnected'].includes(error.code)) throw error; }
    }
    throw new ServiceError('service-start-failed', '로컬 서비스의 준비를 확인하지 못했습니다.', true, `전용 자료 폴더의 진단 기록을 확인해 주세요. ${join(paths.runtime, '시작오류.json')}`);
  })();
  pending.set(paths.root, work);
  try { await work; } finally { pending.delete(paths.root); }
}

export async function callService(request: ApiRequest, options: ClientOptions = {}, role: ClientRole = 'human'): Promise<ApiResponse> {
  await connectService(options);
  return requestLocal(dataPaths(options.dataRoot), request, role);
}
