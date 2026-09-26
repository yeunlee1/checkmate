// 승인된 로컬 저장소의 서비스를 찾아 연결하고 없으면 숨김 실행한다.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorResponse, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import { dataPaths, prepareDataPaths } from '../연결/개인경로.js';
import { requestLocal } from '../연결/로컬통신.js';
import type { ClientRole } from '../연결/로컬통신.js';

export type ClientOptions = { dataRoot?: string; nodeExecutable?: string; serviceEntry?: string };
const pending = new Map<string, Promise<ApiResponse>>();
const updateGuidance = '기존 검사와 조회는 유지하세요. 같은 자료 폴더의 서비스는 작업과 연결이 없고 마지막 요청 후 60초가 지나야 자연 종료합니다. 계속 조회하는 앱이 있으면 유휴 상태가 되지 않습니다. 강제 종료하지 말고 유휴 종료 후 새 CLI로 capabilities를 다시 확인하세요.';
function missingFeatures(data: unknown): string[] {
  const value = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  const connection = value.connection;
  return [
    ...(typeof connection === 'object' && connection !== null && 'dataRoot' in connection && typeof connection.dataRoot === 'string' && connection.dataRoot.length > 0 ? [] : ['connection-data-root']),
    ...(Array.isArray(value.capabilities) && value.capabilities.includes('public-images') ? [] : ['public-images']),
  ];
}
export async function initializeLocalStore(options: ClientOptions = {}): Promise<void> {
  await prepareDataPaths(dataPaths(options.dataRoot));
}

export async function connectService(options: ClientOptions = {}): Promise<ApiResponse> {
  const paths = dataPaths(options.dataRoot);
  const existing = pending.get(paths.root);
  if (existing) return existing;
  const work = (async () => {
    try { await access(paths.secret); }
    catch { throw new ServiceError('needs-initialization', '체크메이트 로컬 저장소를 먼저 준비해 주세요.', false, '설정에서 로컬 저장소를 준비하거나 setup --accept-local-storage를 실행해 주세요.'); }
    const probe: ApiRequest = { apiVersion: 1, requestId: randomUUID(), method: 'capabilities', input: {} };
    try { return await requestLocal(paths, probe); }
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
      try { return await requestLocal(paths, probe); }
      catch (error) { if (!(error instanceof ServiceError) || !['service-unavailable', 'service-disconnected'].includes(error.code)) throw error; }
    }
    throw new ServiceError('service-start-failed', '로컬 서비스의 준비를 확인하지 못했습니다.', true, `전용 자료 폴더의 진단 기록을 확인해 주세요. ${join(paths.runtime, '시작오류.json')}`);
  })();
  pending.set(paths.root, work);
  try { return await work; } finally { pending.delete(paths.root); }
}

export async function callService(request: ApiRequest, options: ClientOptions = {}, role: ClientRole = 'human'): Promise<ApiResponse> {
  const probe = await connectService(options);
  if (!probe.ok) return { ...probe, requestId: request.requestId };
  if (request.method === 'evidence-image' && missingFeatures(probe.data).includes('public-images')) {
    return errorResponse(request.requestId, new ServiceError('service-update-required', '연결된 서비스가 공개 PNG 조회 기능을 제공하지 않습니다. 새 CLI 파일만으로 실행 중인 서비스가 교체되지는 않습니다.', false, updateGuidance));
  }
  const response = await requestLocal(dataPaths(options.dataRoot), request, role);
  if (request.method !== 'capabilities' || !response.ok || typeof response.data !== 'object' || response.data === null || Array.isArray(response.data)) return response;
  const missing = missingFeatures(response.data);
  return { ...response, data: { ...response.data, clientCompatibility: {
    checkedFeatures: ['connection-data-root', 'public-images'], missingFeatures: missing,
    status: missing.length === 0 ? 'supported' : 'limited',
    nextAction: missing.length === 0 ? null : updateGuidance,
  } } };
}
