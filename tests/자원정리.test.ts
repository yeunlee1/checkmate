// 사람의 자원 정리와 동시 실행 차단 및 과거 판정 보존을 검증한다.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ApiMethod, ApiRequest } from '@checkmate/contracts/api';
import { assessResult } from '@checkmate/contracts';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test.each(['unverifiable', 'blocked'] as const)('%s 실행은 AI 제거를 거절하고 사람의 자원 정리 뒤 원래 판정을 유지한다', async (state) => {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runsRoot = join(files.directory, 'runs'); await mkdir(runsRoot);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let called = 0;
  const product = new ProductService(db, new EvidenceStore(db, runsRoot), async () => { throw new Error('미사용 실행기'); }, undefined, {
    async cleanup(runId) {
      called++; await gate;
      const resource = product.resources.list(runId)[0]!;
      product.resources.update(resource.id, [resource.state], { ...resource, state: 'cleaned',
        cleanup: { verified: true, checkedAt: new Date().toISOString(), reason: '합성 컨테이너 부재 확인' } });
      return { verified: true, resources: product.resources.list(runId) };
    },
  });
  const plan = { project: { id: randomUUID(), name: '복구 시험', repositoryIdentity: 'synthetic:recovery' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'b'.repeat(64), source: {} },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'pg', plannedChecks: ['check'], requiredChecks: ['check'] },
    createdAt: new Date().toISOString() };
  product.runs.registerPlan(plan);
  const runId = randomUUID();
  product.runs.admitRun({ projectId: plan.project.id, planId: plan.plan.id, runId, requestId: randomUUID(), requestHash: 'e'.repeat(64), createdAt: new Date().toISOString() });
  const initial = product.runs.markRunning(runId);
  const interrupted = { ...initial, state, finalized: true };
  product.runs.finalizeRun({ ...interrupted, ...assessResult(interrupted) });
  const original = product.runs.getRun(runId);
  const id = randomUUID();
  product.resources.intent({ id, runId, kind: 'postgres-test', ownerTokenHash: 'f'.repeat(64), state: 'intent', cleanup: null,
    descriptor: { name: `cm-pg-${runId}-${id}`, image: `postgres:17-alpine@sha256:${'a'.repeat(64)}`, endpoint: 'unix:///var/run/docker.sock', daemonId: 'test-daemon' } });
  const call = (method: ApiMethod, input: ApiRequest['input'], role: 'human' | 'agent' = 'human') => product.handle({ apiVersion: 1, requestId: randomUUID(), method, input }, role);
  expect(await call('resources', { runId }, 'agent')).toMatchObject({ ok: true, data: { items: [{ id, state: 'intent' }] } });
  expect(await call('cleanup-resources', { runId, confirm: true }, 'agent')).toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  expect(called).toBe(0);
  const confirmation = { runId, confirm: true, note: '남은 프로세스가 없음을 직접 확인했습니다.' };
  expect(await call('acknowledge-cleanup', confirmation)).toMatchObject({ ok: false, error: { code: 'ownership-unknown' } });
  const pending = call('cleanup-resources', { runId, confirm: true });
  expect(await call('cleanup-resources', { runId, confirm: true })).toMatchObject({ ok: false, error: { code: 'workspace-busy' } });
  expect(await call('acknowledge-cleanup', confirmation)).toMatchObject({ ok: false, error: { code: 'ownership-unknown' } });
  release();
  expect(await pending).toMatchObject({ ok: true, data: { verified: true, originalVerdict: original!.verdict } });
  expect(called).toBe(1);
  expect(await call('acknowledge-cleanup', confirmation)).toMatchObject({ ok: true });
  expect(product.runs.getRun(runId)).toEqual(original);
  expect(db.prepare("SELECT action,actor_kind FROM audit_events WHERE entity_id=? AND action='resources-cleanup'").get(runId))
    .toEqual({ action: 'resources-cleanup', actor_kind: 'human' });
});
