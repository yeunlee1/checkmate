// 수동 정리 확인의 사람 권한과 감사 기록 및 다음 실행 허용 범위를 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ApiMethod, ApiRequest } from '@checkmate/contracts/api';
import type { RunResult } from '@checkmate/contracts';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

test('수동 확인은 원래 판정을 보존하고 해당 실행의 작업 폴더만 다시 허용한다', async () => {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runsRoot = join(files.directory, 'runs');
  await mkdir(runsRoot);
  let mode: 'fail' | 'hold' | 'pass' | 'blocked-resource' = 'fail';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const product = new ProductService(db, new EvidenceStore(db, runsRoot), async (_plan, initial) => {
    if (mode === 'fail') throw new Error('합성 실행 생존 확인 실패');
    if (mode === 'blocked-resource') {
      const id = randomUUID();
      product.resources.intent({ id, runId: initial.runId, kind: 'postgres-test', ownerTokenHash: 'a'.repeat(64), state: 'intent', cleanup: null,
        descriptor: { name: `cm-pg-${initial.runId}-${id}`, image: `postgres:17-alpine@sha256:${'b'.repeat(64)}`,
          endpoint: 'unix:///var/run/docker.sock', daemonId: 'synthetic-daemon' } });
      return { ...initial, state: 'blocked', cleanupVerified: false };
    }
    if (mode === 'hold') await gate;
    return { ...initial, state: 'finished', sourceAfter: initial.sourceBefore, workerExitCode: 0,
      environmentVerified: true, evidenceVerified: true, cleanupVerified: true,
      cases: [{ testId: 'check-1', status: 'passed', requirementId: 'req-1', expected: null, observed: null,
        evidenceIds: [], severity: 'info', location: null }] } satisfies RunResult;
  });
  const call = (method: ApiMethod, input: ApiRequest['input'], role: 'human' | 'agent' = 'human') =>
    product.handle({ apiVersion: 1, requestId: randomUUID(), method, input }, role);
  async function register(name: string) {
    const projectId = randomUUID();
    const root = join(files.directory, name);
    await mkdir(join(root, 'checkmate'), { recursive: true });
    await writeFile(join(root, 'test.mjs'), '// 실제 소스 지문을 위한 합성 검사 파일이다.\n');
    const definition = { schemaVersion: 1, id: projectId, name, repositoryIdentity: `synthetic:${name}`,
      commands: [{ id: 'command-1', title: '합성 검사', runtime: 'node', entry: 'test.mjs', args: [],
        timeoutMs: 1000, env: {}, writes: [], resultFormat: 'exit-code' }],
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1'] }] };
    await writeFile(join(root, 'checkmate', '프로젝트.json'), JSON.stringify(definition));
    await writeFile(join(root, 'checkmate', '요구사항.json'), JSON.stringify([
      { id: 'req-1', title: '결과 확인', description: '검사 완료 여부를 확인한다.' }]));
    await writeFile(join(root, 'checkmate', '검사항목.json'), JSON.stringify([
      { id: 'check-1', title: '결과 검사', requirementId: 'req-1', commandId: 'command-1', required: true,
        kind: 'logic', expected: '실제 결과가 통과한다.', codePaths: ['test.mjs'] }]));
    expect(await call('register', { path: root })).toMatchObject({ ok: true });
    const review = await call('inspect', { projectId, profile: 'quick' });
    if (!review.ok) throw new Error(`계획 조회 실패: ${review.error.code}`);
    const plan = review.data as { planId: string; fingerprint: string };
    expect(await call('approve', { planId: plan.planId, fingerprint: plan.fingerprint })).toMatchObject({ ok: true });
    return { projectId, planId: plan.planId };
  }
  async function start(project: { projectId: string; planId: string }) {
    const response = await call('start', project);
    if (!response.ok) throw new Error(`실행 접수 실패: ${response.error.code}`);
    return (response.data as { runId: string }).runId;
  }
  const firstProject = await register('첫 프로젝트');
  const secondProject = await register('둘째 프로젝트');
  const firstRunId = await start(firstProject);
  const secondRunId = await start(secondProject);
  expect(await product.execution.wait(firstRunId)).toMatchObject({ state: 'unverifiable', verdict: 'unknown', cleanupVerified: null });
  expect(await product.execution.wait(secondRunId)).toMatchObject({ state: 'unverifiable', verdict: 'unknown', cleanupVerified: null });
  expect(await call('start', firstProject)).toMatchObject({ ok: false, error: { code: 'ownership-unknown', message: expect.stringContaining(firstRunId) } });
  const input = { runId: firstRunId, confirm: true, note: '합성 실행 자원을 수동으로 확인했다.' };
  expect(await call('acknowledge-cleanup', input, 'agent')).toMatchObject({ ok: false, error: { code: 'human-action-required' } });
  expect(await call('acknowledge-cleanup', input)).toMatchObject({ ok: true,
    data: { runId: firstRunId, acknowledged: true, reused: false, originalVerdict: 'unknown' } });
  expect(await call('acknowledge-cleanup', input)).toMatchObject({ ok: true,
    data: { runId: firstRunId, acknowledged: true, reused: true, originalVerdict: 'unknown' } });
  const original = product.runs.getRun(firstRunId)!;
  expect(original).toMatchObject({ state: 'unverifiable', verdict: 'unknown', cleanupVerified: null });
  const row = db.prepare("SELECT after_hash,actor_kind,detail_json FROM audit_events WHERE entity_id=? AND action='cleanup-acknowledged'")
    .get(firstRunId) as { after_hash: string; actor_kind: string; detail_json: string };
  const stored = db.prepare('SELECT summary_json FROM runs WHERE id=?').get(firstRunId) as { summary_json: string };
  expect(row.after_hash).toBe(createHash('sha256').update(stored.summary_json).digest('hex'));
  expect(row.actor_kind).toBe('human');
  expect(JSON.parse(row.detail_json)).toMatchObject({ note: input.note, manualConfirmation: true });
  expect(db.prepare("SELECT count(*) AS count FROM audit_events WHERE entity_id=? AND action='cleanup-acknowledged'").get(firstRunId))
    .toEqual({ count: 1 });
  expect(await call('start', secondProject)).toMatchObject({ ok: false, error: { code: 'ownership-unknown', message: expect.stringContaining(secondRunId) } });
  mode = 'hold';
  const nextRunId = await start(firstProject);
  expect(await call('acknowledge-cleanup', input)).toMatchObject({ ok: false, error: { code: 'workspace-busy' } });
  mode = 'pass';
  release();
  expect(await product.execution.wait(nextRunId)).toMatchObject({ state: 'finished', verdict: 'passed' });
  expect(product.runs.getRun(firstRunId)).toEqual(original);
  mode = 'blocked-resource';
  const blockedRunId = await start(firstProject);
  expect(await product.execution.wait(blockedRunId)).toMatchObject({ state: 'blocked', verdict: 'incomplete', cleanupVerified: false });
  expect(await call('start', firstProject)).toMatchObject({ ok: false, error: { code: 'ownership-unknown' } });
  expect(await call('acknowledge-cleanup', { ...input, runId: blockedRunId })).toMatchObject({ ok: false, error: { code: 'ownership-unknown' } });
});
