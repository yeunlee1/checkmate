// 실행과 정리 상태를 바꾸지 않고 설치본 교체에 필요한 자료 유휴 상태를 조회한다.
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';
import { engineVersion } from '../버전.js';
import { assertMigrationIdle, assertStoreSchema } from '../저장/연결.js';
import { dataPaths, rejectLinks } from './개인경로.js';
import { requestLocal } from './로컬통신.js';
import { readManagedJson } from './관리연결계약.js';
import { installationRoot } from './업데이트잠금.js';

const ownerSchema = z.strictObject({ id: z.uuid(), pid: z.number().int().positive(), startedAt: z.iso.datetime() });
export async function inspectUpdateReadiness(dataRoot: string): Promise<unknown> {
  const paths = dataPaths(dataRoot);
  await rejectLinks(paths.root);
  const marker = await readManagedJson(join(paths.root, '체크메이트자료.json'));
  if (JSON.stringify(marker) !== JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' })) throw new ServiceError('unrecognized-data-root');
  try {
    const response = await requestLocal(paths, { apiVersion: 1, requestId: randomUUID(), method: 'update-readiness', input: {} });
    if (!response.ok) throw new ServiceError(response.error.code);
    return response.data;
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'service-unavailable') throw error;
  }
  // 엔드포인트가 없더라도 살아 있거나 소유를 확인할 수 없는 시작 프로세스가 있으면 보류한다.
  const readOwner = async () => {
    try { return ownerSchema.parse(await readManagedJson(join(paths.runtime, '서비스소유.json'))); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new ServiceError('ownership-unknown');
    }
  };
  const owner = await readOwner();
  const unchangedOwner = async () => {
    if (JSON.stringify(await readOwner()) !== JSON.stringify(owner)) throw new ServiceError('ownership-unknown');
  };
  if (owner !== null) {
    try { process.kill(owner.pid, 0); throw new ServiceError('ownership-unknown'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
  await unchangedOwner();
  const path = join(paths.state, 'checkmate.sqlite');
  await rejectLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw new ServiceError('unsafe-path');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertStoreSchema(db);
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new ServiceError('storage-corrupt');
    assertMigrationIdle(db);
    // 관측 중 새 서비스가 시작됐으면 오프라인 DB 관측을 준비 완료로 재사용하지 않는다.
    await unchangedOwner();
    try {
      await requestLocal(paths, { apiVersion: 1, requestId: randomUUID(), method: 'update-readiness', input: {} });
      throw new ServiceError('ownership-unknown');
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'service-unavailable') throw error;
    }
    await unchangedOwner();
    return { ready: true, version: engineVersion, dataRoot: paths.root, serviceEpoch: null, installationRoot: await installationRoot() };
  } finally { db.close(); }
}
