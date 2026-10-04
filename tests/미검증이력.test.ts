// 실제 SQLite에서 미검증 공백의 중복 방지와 검증 후 해소 이력을 확인한다.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { RunResult } from '@checkmate/contracts';
import type { ApiMethod, ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import type { ProjectSource } from '@checkmate/contracts/project';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
test('실패는 공백이 아니고 같은 공백은 누적하지 않으며 관련 검증만 원래 공백을 닫는다', async () => {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const runsRoot = join(files.directory, 'runs');
  await mkdir(runsRoot);
  const root = join(files.directory, 'project');
  await mkdir(join(root, 'checkmate'), { recursive: true });
  await writeFile(join(root, 'test.mjs'), '// 합성 이력 시험의 실제 원본 지문을 제공한다.\n');
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
  const call = (method: ApiMethod, input: ApiRequest['input']) =>
    product.handle({ apiVersion: 1, method, requestId: randomUUID(), input }, 'human');
  async function writeSource(value: ProjectSource) {
    for (const [filename, contents] of [['프로젝트.json', value.project], ['요구사항.json', value.requirements],
      ['검사항목.json', value.checks]] as const)
      await writeFile(join(root, 'checkmate', filename), JSON.stringify(contents));
  }
  async function approvedPlan(profile: string): Promise<PlanRegistration> {
    const inspected = await call('inspect', { projectId, profile });
    if (!inspected.ok) throw new Error(`계획 조회 실패: ${inspected.error.code}`);
    const review = inspected.data as { planId: string; fingerprint: string };
    expect(await call('approve', { planId: review.planId, fingerprint: review.fingerprint })).toMatchObject({ ok: true });
    return product.runs.getPlan(review.planId)!;
  }
  await writeSource(source);
  expect(await call('register', { path: root })).toMatchObject({ ok: true });
  const base = await approvedPlan('quick');
  async function execute(plan: PlanRegistration, nextMode: Mode) {
    mode = nextMode;
    const admitted = await call('start', { projectId, planId: plan.plan.id });
    if (!admitted.ok) throw new Error(`실행 접수 실패: ${admitted.error.code}`);
    const result = await product.execution.wait((admitted.data as { runId: string }).runId);
    while (product.active) await new Promise(resolve => setTimeout(resolve, 10));
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
  await writeSource(updatedSource);
  const change = await call('sync', { projectId });
  if (!change.ok) throw new Error(`카탈로그 조회 실패: ${change.error.code}`);
  expect(await call('activate', { projectId, contentHash: (change.data as { contentHash: string }).contentHash })).toMatchObject({ ok: true });
  const partial = await approvedPlan('quick');
  await execute(partial, 'passed');
  expect((await gaps()).find(gap => gap.id === original.id)?.state).toBe('open');
  const full = await approvedPlan('full');
  const resolved = await execute(full, 'passed');
  expect((await gaps()).find(gap => gap.id === original.id)).toMatchObject({ openedRunId: failed.runId,
    resolvedRunId: resolved.runId, state: 'resolved' });
  expect(product.runs.getRun(failed.runId)).toMatchObject({ verdict: 'failed', finalized: true });
});

test.each(['requirement', 'check', 'command', 'missing-requirement', 'missing-check', 'unrelated',
  'unselected', 'no-required', 'other-workspace', 'failed', 'unknown', 'imported'] as const)(
  '과거 카탈로그 공백을 정의 및 실행 경계가 다르면 닫지 않는다 %s', async boundary => {
    const files = await createStoreFixture();
    const db = connectStore(files.dbPath);
    const runsRoot = join(files.directory, 'runs');
    await mkdir(runsRoot);
    type Mode = 'evidence' | 'passed' | 'failed' | 'unknown';
    let mode: Mode = 'evidence';
    const product = new ProductService(db, new EvidenceStore(db, runsRoot), async (_plan, initial) => ({
      ...initial, state: mode === 'unknown' ? 'unverifiable' : 'finished', sourceAfter: initial.sourceBefore,
      workerExitCode: mode === 'unknown' ? 1 : 0, environmentVerified: true,
      evidenceVerified: mode !== 'evidence', cleanupVerified: true,
      cases: initial.plannedChecks.map(testId => ({ testId, status: mode === 'failed' && testId === 'check-2' ? 'failed' : 'passed',
        requirementId: (_plan.catalog.source as unknown as ProjectSource).checks.find(check => check.id === testId)!.requirementId,
        expected: null, observed: null,
        evidenceIds: [], severity: 'info', location: null })),
    }));
    cleanup.push(async () => { while (product.active) await new Promise(resolve => setTimeout(resolve, 10)); db.close(); await files.cleanup(); });
    const projectId = randomUUID();
    const source: ProjectSource = {
      project: { schemaVersion: 1, id: projectId, name: '공백 경계 시험', repositoryIdentity: 'synthetic:gap-boundary',
        commands: [{ id: 'command-1', title: '합성 검사', runtime: 'node', entry: 'test.mjs', args: [], timeoutMs: 1000,
          env: {}, writes: [], resultFormat: 'exit-code' }], profiles: [{ id: 'quick', title: '부분 검사', checkIds: ['check-1'] }] },
      requirements: [{ id: 'req-1', title: '검사 공백', description: '원 검사 정의를 확인한다.' },
        { id: 'req-2', title: '누락 공백', description: '관련 필수 검사 전체를 확인한다.' }],
      checks: [{ id: 'check-1', title: '첫 검사', requirementId: 'req-1', commandId: 'command-1', required: true,
        kind: 'logic', expected: '통과', codePaths: ['test.mjs'] }],
    };
    const root = join(files.directory, '원본');
    async function writeSource(path: string, value: ProjectSource) {
      await mkdir(join(path, 'checkmate'), { recursive: true });
      await writeFile(join(path, 'test.mjs'), '// 공백 경계 시험의 합성 원본이다.\n');
      for (const [filename, contents] of [['프로젝트.json', value.project], ['요구사항.json', value.requirements],
        ['검사항목.json', value.checks]] as const) await writeFile(join(path, 'checkmate', filename), JSON.stringify(contents));
    }
    const call = (method: ApiMethod, input: ApiRequest['input']) =>
      product.handle({ apiVersion: 1, method, requestId: randomUUID(), input }, 'human');
    function data<T>(response: ApiResponse): T { if (!response.ok) throw new Error(response.error.code); return response.data as T; }
    async function execute(workspaceId: string, profile: string) {
      const plan = data<{ planId: string; fingerprint: string }>(await call('inspect', { projectId, workspaceId, profile }));
      data(await call('approve', { planId: plan.planId, fingerprint: plan.fingerprint }));
      const started = data<{ runId: string }>(await call('start', { projectId, workspaceId, planId: plan.planId }));
      const result = await product.execution.wait(started.runId);
      while (product.active) await new Promise(resolve => setTimeout(resolve, 10));
      return result;
    }
    await writeSource(root, source);
    const workspace = data<{ workspaceId: string }>(await call('register', { path: root }));
    const opened = await execute(workspace.workspaceId, 'quick');
    const before = data<{ items: { id: string; requirementId: string; state: string; openedRunId: string; resolvedRunId: string | null }[] }>(
      await call('gaps', { projectId, workspaceId: workspace.workspaceId })).items;
    expect(before).toHaveLength(2);
    expect(before.every(gap => gap.state === 'open')).toBe(true);
    const changed: ProjectSource = structuredClone(source);
    changed.checks.push({ ...changed.checks[0]!, id: 'check-2', requirementId: 'req-2', title: '둘째 검사' });
    changed.project.profiles.push({ id: 'full', title: '전체 검사', checkIds: ['check-1', 'check-2'] });
    if (boundary === 'requirement') for (const requirement of changed.requirements) requirement.description = '다른 정의';
    if (boundary === 'check') changed.checks[0]!.expected = '다른 기대';
    if (boundary === 'command') changed.project.commands[0]!.args = ['다른인수'];
    if (boundary === 'no-required') changed.checks[1]!.required = false;
    if (boundary === 'unrelated') changed.checks[0]!.requirementId = 'req-2';
    if (boundary === 'missing-requirement' || boundary === 'missing-check') {
      changed.checks = changed.checks.filter(check => check.id !== 'check-1');
      changed.project.profiles = [{ id: 'full', title: '관련 없는 검사', checkIds: ['check-2'] }];
      if (boundary === 'missing-requirement') changed.requirements = changed.requirements.filter(requirement => requirement.id !== 'req-1');
    }
    await writeSource(root, changed);
    const synced = data<{ contentHash: string }>(await call('sync', { projectId, workspaceId: workspace.workspaceId }));
    data(await call('activate', { projectId, workspaceId: workspace.workspaceId, contentHash: synced.contentHash }));
    let selectedWorkspace = workspace.workspaceId;
    if (boundary === 'other-workspace') {
      const other = join(files.directory, '다른원본');
      await writeSource(other, changed);
      selectedWorkspace = data<{ workspaceId: string }>(await call('register', { path: other })).workspaceId;
    }
    mode = boundary === 'failed' ? 'failed' : boundary === 'unknown' || boundary === 'imported' ? 'unknown' : 'passed';
    const verified = await execute(selectedWorkspace, boundary === 'unselected' ? 'quick' : 'full');
    if (boundary === 'imported') await (product as unknown as { recordGaps(result: RunResult): Promise<void> }).recordGaps({
      ...verified, origin: 'imported', runId: randomUUID(), state: 'finished', verdict: 'passed', workerExitCode: 0,
      environmentVerified: true, evidenceVerified: true,
    });
    const after = data<{ items: typeof before }>(await call('gaps', { projectId, workspaceId: workspace.workspaceId })).items;
    const protectedGaps = ['requirement', 'other-workspace', 'failed', 'unknown', 'imported'].includes(boundary)
      ? before : before.filter(gap => gap.requirementId === (['unselected', 'no-required'].includes(boundary) ? 'req-2' : 'req-1'));
    for (const gap of protectedGaps) expect(after.find(item => item.id === gap.id)).toMatchObject({
      openedRunId: opened.runId, state: 'open', resolvedRunId: null,
    });
    expect(product.runs.getRun(opened.runId)).toEqual(opened);
  },
);
