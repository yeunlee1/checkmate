// 실제 SQLite에서 미검증 공백의 중복 방지와 검증 후 해소 이력을 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { RunResult } from '@checkmate/contracts';
import type { ProjectSource } from '@checkmate/contracts/project';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function catalogHash(value: unknown): string {
  const canonical = (item: unknown): string => Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
    : item !== null && typeof item === 'object'
      ? `{${Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
      : JSON.stringify(item);
  return createHash('sha256').update(canonical(value)).digest('hex');
}

test('실패는 공백이 아니고 같은 공백은 누적하지 않으며 관련 검증만 원래 공백을 닫는다', async () => {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runsRoot = join(files.directory, 'runs');
  await mkdir(runsRoot);
  type Mode = 'failed' | 'missing' | 'evidence' | 'environment' | 'passed';
  let mode: Mode = 'failed';
  const projectId = randomUUID();
  const source: ProjectSource = {
    project: { schemaVersion: 1, id: projectId, name: '미검증 시험', repositoryIdentity: 'synthetic:gaps',
      commands: [{ id: 'command-1', title: '합성 명령', runtime: 'node', entry: 'test.mjs', args: [], timeoutMs: 1000,
        env: {}, writes: [], resultFormat: 'exit-code' }],
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1'] }] },
    requirements: [{ id: 'req-1', title: '첫 요구사항', description: '첫 검사를 확인한다.' },
      { id: 'req-2', title: '둘째 요구사항', description: '연결 검사 보완을 확인한다.' }],
    checks: [{ id: 'check-1', title: '첫 검사', requirementId: 'req-1', commandId: 'command-1', required: true,
      kind: 'logic', expected: '결과가 통과한다.', codePaths: ['test.mjs'] }],
  };
  const product = new ProductService(db, new EvidenceStore(db, runsRoot), async (_plan, initial) => {
    const cases: RunResult['cases'] = mode === 'missing' ? [] : initial.plannedChecks.map(testId => ({
      testId, status: mode === 'failed' && testId === 'check-1' ? 'failed' : 'passed',
      requirementId: testId === 'check-1' ? 'req-1' : 'req-2', expected: null, observed: null,
      evidenceIds: [], severity: 'info', location: null,
    }));
    return { ...initial, state: 'finished', sourceAfter: initial.sourceBefore, workerExitCode: 0,
      environmentVerified: mode !== 'environment', evidenceVerified: mode !== 'evidence', cleanupVerified: true, cases };
  });
  const base: PlanRegistration = {
    project: { id: projectId, name: '미검증 시험', repositoryIdentity: 'synthetic:gaps' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'a'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: catalogHash(source), source },
    plan: { id: randomUUID(), fingerprint: 'c'.repeat(64), sourceHash: 'd'.repeat(64), profile: 'quick',
      plannedChecks: ['check-1'], requiredChecks: ['check-1'] },
    createdAt: new Date().toISOString(),
  };
  product.runs.registerPlan(base);
  async function execute(plan: PlanRegistration, nextMode: Mode) {
    mode = nextMode;
    const admitted = product.execution.start({ projectId, planId: plan.plan.id, requestId: randomUUID() });
    const result = await product.execution.wait(admitted.runId);
    await (product as unknown as { recordGaps(result: RunResult): Promise<void> }).recordGaps(result);
    return result;
  }
  async function gaps() {
    const response = await product.handle({ apiVersion: 1, method: 'gaps', requestId: randomUUID(), input: { projectId } }, 'human');
    if (!response.ok) throw new Error(`공백 조회 실패: ${response.error.code}`);
    return (response.data as { items: { id: string; requirementId: string; openedRunId: string;
      resolvedRunId: string | null; kind: string; state: string; detail: { testId: string | null } }[] }).items;
  }
  const failed = await execute(base, 'failed');
  expect(failed.verdict).toBe('failed');
  expect(await gaps()).toMatchObject([{ requirementId: 'req-2', kind: 'missing-test', state: 'open' }]);
  const original = (await gaps())[0]!;
  await execute(base, 'failed');
  expect(await gaps()).toHaveLength(1);
  await execute(base, 'missing');
  const missing = (await gaps()).find(gap => gap.requirementId === 'req-1' && gap.kind === 'missing-test')!;
  await execute(base, 'evidence');
  expect((await gaps()).some(gap => gap.requirementId === 'req-1' && gap.kind === 'missing-evidence')).toBe(true);
  await execute(base, 'environment');
  expect((await gaps()).some(gap => gap.requirementId === 'req-1' && gap.kind === 'environment-blocked')).toBe(true);
  expect((await gaps()).find(gap => gap.id === missing.id)?.state).toBe('open');
  await (product as unknown as { recordGaps(result: RunResult): Promise<void> }).recordGaps({
    ...failed, origin: 'imported', runId: randomUUID(), verdict: 'unknown', cases: [{ testId: 'check-1', status: 'passed',
      requirementId: 'req-1', expected: null, observed: null, evidenceIds: [], severity: 'info', location: null }],
  });
  expect((await gaps()).find(gap => gap.id === missing.id)?.state).toBe('open');
  const verified = await execute(base, 'passed');
  expect((await gaps()).filter(gap => gap.requirementId === 'req-1')).toMatchObject([
    { state: 'resolved', resolvedRunId: verified.runId },
    { state: 'resolved', resolvedRunId: verified.runId },
    { state: 'resolved', resolvedRunId: verified.runId },
  ]);
  expect((await gaps()).find(gap => gap.id === original.id)).toMatchObject({ openedRunId: failed.runId, state: 'open', resolvedRunId: null });

  const updatedSource: ProjectSource = { ...source,
    project: { ...source.project, profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1'] },
      { id: 'full', title: '전체 검사', checkIds: ['check-1', 'check-2'] }] },
    checks: [...source.checks, { id: 'check-2', title: '둘째 검사', requirementId: 'req-2', commandId: 'command-1',
      required: true, kind: 'logic', expected: '결과가 통과한다.', codePaths: ['test.mjs'] }],
  };
  const partial: PlanRegistration = { ...base, catalog: { id: randomUUID(), contentHash: catalogHash(updatedSource), source: updatedSource },
    plan: { ...base.plan, id: randomUUID(), fingerprint: 'f'.repeat(64) } };
  product.runs.registerPlan(partial);
  db.prepare('UPDATE projects SET active_catalog_id=? WHERE id=?').run(partial.catalog.id, projectId);
  await execute(partial, 'passed');
  expect((await gaps()).find(gap => gap.id === original.id)?.state).toBe('open');
  const full: PlanRegistration = { ...partial, plan: { ...partial.plan, id: randomUUID(), fingerprint: '1'.repeat(64),
    profile: 'full', plannedChecks: ['check-1', 'check-2'], requiredChecks: ['check-1', 'check-2'] } };
  product.runs.registerPlan(full);
  const resolved = await execute(full, 'passed');
  expect((await gaps()).find(gap => gap.id === original.id)).toMatchObject({ openedRunId: failed.runId,
    resolvedRunId: resolved.runId, state: 'resolved' });
  expect(product.runs.getRun(failed.runId)).toMatchObject({ verdict: 'failed', finalized: true });
});
