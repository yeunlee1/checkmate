// 업데이트 준비 조회가 기록을 보존하고 잠금 중 새 접수와 유휴 지연을 막는지 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceError } from '@checkmate/contracts/api';
import { assessResult } from '@checkmate/contracts';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { createStoreFixture } from './저장시험자료.js';
import { dataPaths, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { requestLocal } from '../packages/engine/src/연결/로컬통신.js';
import { inspectUpdateReadiness } from '../packages/engine/src/연결/업데이트준비.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { startLocalService } from '../packages/engine/src/서비스/상주서비스.js';

const gate = vi.hoisted(() => ({ locked: false }));
vi.mock('../packages/engine/src/연결/업데이트잠금.js', async importOriginal => ({
  ...await importOriginal<object>(),
  assertInstallationAvailable: async () => { if (gate.locked) throw new ServiceError('update-in-progress'); },
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); gate.locked = false; for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const files = await createStoreFixture(); cleanups.push(files.cleanup);
  const paths = dataPaths(join(files.directory, '관리 자료'));
  await prepareDataPaths(paths);
  return { files, paths, lockRoot: join(files.directory, '공유잠금') };
}
const request = (method: 'capabilities' | 'update-readiness') => ({ apiVersion: 1 as const, requestId: randomUUID(), method, input: {} });

it('서비스가 없는 자료의 준비 조회는 DB와 실행을 바꾸지 않는다', async () => {
  const f = await fixture(); const database = join(f.paths.state, 'checkmate.sqlite');
  connectStore(database).close();
  const digest = async () => createHash('sha256').update(await readFile(database)).digest('hex');
  const before = await digest();
  expect(await inspectUpdateReadiness(f.paths.root)).toMatchObject({ ready: true, dataRoot: f.paths.root, serviceEpoch: null });
  expect(await digest()).toBe(before);
  await expect(lstat(join(f.paths.runtime, '서비스소유.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('사람만 준비 상태를 읽으며 정리가 미확인인 기록은 그대로 보류한다', async () => {
  const f = await fixture();
  const service = await startLocalService(f.paths.root, 60000, { lockRoot: f.lockRoot }); cleanups.push(service.close);
  expect(await requestLocal(f.paths, request('update-readiness'), 'agent')).toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  expect(await inspectUpdateReadiness(f.paths.root)).toMatchObject({ ready: true, dataRoot: f.paths.root });
  const plan: PlanRegistration = {
    project: { id: randomUUID(), name: '업데이트 준비 합성', repositoryIdentity: 'synthetic:update-readiness' },
    workspace: { id: randomUUID(), realPath: f.files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick', plannedChecks: ['check-1'], requiredChecks: ['check-1'] },
    createdAt: new Date().toISOString(),
  };
  service.product.runs.registerPlan(plan);
  const runId = randomUUID();
  service.product.runs.admitRun({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID(), requestHash: 'e'.repeat(64), runId, createdAt: plan.createdAt });
  expect(await inspectUpdateReadiness(f.paths.root)).toMatchObject({ ready: false });
  const queued = service.product.runs.getRun(runId)!;
  const final = { ...queued, state: 'unverifiable' as const, finalized: true, cleanupVerified: null };
  service.product.runs.finalizeRun({ ...final, ...assessResult(final) });
  const preserved = service.product.runs.getRun(runId);
  expect(await inspectUpdateReadiness(f.paths.root)).toMatchObject({ ready: false });
  expect(service.product.runs.getRun(runId)).toEqual(preserved);
});

it('죽은 PID만 있고 소유 식별자와 시작 시각이 없으면 준비 완료로 보지 않는다', async () => {
  const f = await fixture(); connectStore(join(f.paths.state, 'checkmate.sqlite')).close();
  await writeFile(join(f.paths.runtime, '서비스소유.json'), JSON.stringify({ pid: 12345 }));
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
  await expect(inspectUpdateReadiness(f.paths.root)).rejects.toMatchObject({ code: 'ownership-unknown' });
  expect(probe).not.toHaveBeenCalled();
});

it('PID 관측 중 새 소유자가 생기면 오프라인 준비 상태를 재사용하지 않는다', async () => {
  const f = await fixture(); connectStore(join(f.paths.state, 'checkmate.sqlite')).close();
  const path = join(f.paths.runtime, '서비스소유.json');
  const owner = { id: randomUUID(), pid: 12345, startedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(owner));
  const changed = { ...owner, id: randomUUID(), pid: process.pid };
  vi.spyOn(process, 'kill').mockImplementation(() => {
    writeFileSync(path, JSON.stringify(changed)); throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  });
  await expect(inspectUpdateReadiness(f.paths.root)).rejects.toMatchObject({ code: 'ownership-unknown' });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(changed);
});

it('설치 잠금은 구 클라이언트 접수도 막고 거절 polling은 자연 종료를 늦추지 않는다', async () => {
  const f = await fixture();
  const service = await startLocalService(f.paths.root, 100, { lockRoot: f.lockRoot }); cleanups.push(service.close);
  gate.locked = true;
  expect(await requestLocal(f.paths, request('capabilities'))).toMatchObject({ ok: false, error: { code: 'update-in-progress' } });
  expect(await requestLocal(f.paths, request('update-readiness'))).toMatchObject({ ok: true, data: { ready: true } });
  let ended = false;
  await vi.waitFor(async () => {
    try {
      const response = await requestLocal(f.paths, request('capabilities'));
      expect(response).toMatchObject({ ok: false, error: { code: 'update-in-progress' } });
    } catch (error) {
      if (error instanceof ServiceError && ['service-unavailable', 'service-disconnected'].includes(error.code)) ended = true;
      else throw error;
    }
    expect(ended).toBe(true);
  }, { timeout: 5000, interval: 60 });
  await expect(lstat(join(f.paths.runtime, '서비스소유.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
