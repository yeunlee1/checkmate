// 합성 프로젝트와 가짜 PostgreSQL 자원으로 실행기 연결과 비밀 경계를 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { resultSummary, compactRepairCase } from '../packages/engine/src/서비스/조회결과.js';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const workerControl = vi.hoisted(() => ({ killNext: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, fork: (...args: Parameters<typeof original.fork>) => {
    const child = original.fork(...args);
    if (workerControl.killNext) {
      workerControl.killNext = false;
      child.once('spawn', () => { child.kill(); });
    }
    return child;
  } };
});

const secret = 'synthdbvalue42';
const url = `postgresql://test:${secret}@127.0.0.1:5432/test`;
const program = String.raw`
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
const id = process.argv[3];
const declared = process.argv[4] === 'yes';
const value = process.env.CHECKMATE_PG_ADMIN_URL;
if (declared !== Boolean(value)) process.exit(8);
if (declared && process.env.CHECKMATE_PG_MANAGED !== '1') process.exit(9);
if (mode === 'cancel') { setInterval(() => {}, 1000); await new Promise(() => {}); }
const event = (sequence, type, payload) => JSON.stringify({ protocolVersion: 1,
  runId: process.env.CHECKMATE_RUN_ID, sequence, type, time: new Date().toISOString(), payload });
const evidenceIds = [];
if (mode === 'text' || mode === 'binary') {
  const bytes = mode === 'text' ? Buffer.from('자료 ' + value) : Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(value)]);
  const relativePath = mode === 'text' ? '자료.txt' : '자료.png';
  writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR, relativePath), bytes);
  const evidence = { id: randomUUID(), relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
    mime: mode === 'text' ? 'text/plain' : 'image/png', sensitivity: 'restricted' };
  evidenceIds.push(evidence.id);
  process.stdout.write(event(1, 'evidence-created', evidence) + '\n');
}
if (mode === 'claim') process.stdout.write(event(1, 'resource-created', { kind: 'postgres-test' }) + '\n');
process.stdout.write(event(mode === 'text' || mode === 'binary' || mode === 'claim' ? 2 : 1, 'case-result', {
  testId: id, status: 'passed', requirementId: 'req',
  expected: mode === 'ansi-output' ? new URL(value).password.slice(0, 5) + '\u001b[31m' + new URL(value).password.slice(5) + '\u001b[0m' : '성공',
  observed: mode === 'ansi-output' ? 'Authoriza\u001b[31mtion: safevalue\u001b[0m' : mode === 'output' ? value : '성공', evidenceIds, severity: 'info', location: null }) + '\n');
`;

type Mode = 'normal' | 'ansi-output' | 'output' | 'text' | 'binary' | 'claim' | 'cancel';
async function scenario(mode: Mode, options: { declared?: boolean; second?: boolean;
  prepareFails?: boolean; cleanupVerified?: boolean; cancel?: boolean; noResources?: boolean;
  workerCrash?: boolean } = {}) {
  const fixture = await createStoreFixture();
  const root = join(fixture.directory, '합성프로젝트');
  const runsRoot = join(fixture.directory, '실행');
  await mkdir(join(root, 'checkmate'), { recursive: true });
  await mkdir(join(root, 'tests'));
  await mkdir(runsRoot);
  const projectId = randomUUID();
  const commands = (options.second ? ['first', 'second'] : ['first']).map((id, index) => {
    const declared = options.declared === true && index === 0;
    return { id, title: id, runtime: 'node', entry: 'tests/run.mjs',
      args: [mode, id, declared ? 'yes' : 'no'], timeoutMs: 5000,
      env: { NODE_ENV: 'test' }, writes: [], resultFormat: 'ndjson',
      ...(declared ? { resources: ['postgres-test'] } : {}) };
  });
  const project = { schemaVersion: 1, id: projectId, name: '합성 프로젝트',
    repositoryIdentity: 'synthetic:resource', commands,
    profiles: [{ id: 'quick', title: '빠른 검사', checkIds: commands.map((item) => item.id) }] };
  const requirements = [{ id: 'req', title: '요구사항', description: '합성 검사' }];
  const checks = commands.map((item) => ({ id: item.id, title: item.id, requirementId: 'req',
    commandId: item.id, required: true, kind: 'logic', expected: '성공', codePaths: [] }));
  await writeFile(join(root, 'checkmate', '프로젝트.json'), JSON.stringify(project));
  await writeFile(join(root, 'checkmate', '요구사항.json'), JSON.stringify(requirements));
  await writeFile(join(root, 'checkmate', '검사항목.json'), JSON.stringify(checks));
  await writeFile(join(root, 'tests', 'run.mjs'), program);
  const snapshot = await readProjectSource(root);
  const plan: PlanRegistration = {
    project: { id: projectId, name: project.name, repositoryIdentity: project.repositoryIdentity },
    workspace: { id: randomUUID(), realPath: snapshot.realPath,
      pathFingerprint: createHash('sha256').update(snapshot.realPath).digest('hex') },
    catalog: { id: randomUUID(), contentHash: snapshot.contentHash,
      source: JSON.parse(JSON.stringify(snapshot.source)) as PlanRegistration['catalog']['source'] },
    plan: { id: randomUUID(), fingerprint: createHash('sha256').update('synthetic').digest('hex'),
      sourceHash: snapshot.sourceHash, profile: 'quick', plannedChecks: commands.map((item) => item.id),
      requiredChecks: commands.map((item) => item.id) }, createdAt: new Date().toISOString(),
  };
  const db = connectStore(fixture.dbPath);
  const prepare = vi.fn(async () => {
    if (options.prepareFails) throw new Error('합성 준비 실패');
    return { environment: { CHECKMATE_PG_ADMIN_URL: url, CHECKMATE_PG_MANAGED: '1' }, secrets: [url, secret] };
  });
  const cleanup = vi.fn(async () => ({ verified: options.cleanupVerified !== false, resources: [] }));
  try {
    const store = new SQLiteRunStore(db);
    store.registerPlan(plan);
    const evidence = new EvidenceStore(db, runsRoot);
    const events = new EventStore(db);
    const service = new RunService(store, createProjectExecutor({ runsRoot, evidenceStore: evidence,
      eventStore: events, ...(options.noResources ? {} : { resources: { prepare, cleanup } }) }));
    if (options.workerCrash) workerControl.killNext = true;
    const admitted = service.start({ projectId, planId: plan.plan.id, requestId: randomUUID() });
    if (options.cancel) setTimeout(() => { void service.cancel(admitted.runId); }, 500);
    const result = await service.wait(admitted.runId);
    return { result, events: events.list(admitted.runId), evidence: evidence.list(admitted.runId), prepare, cleanup };
  } finally { db.close(); await fixture.cleanup(); }
}

describe('부모 소유 자원 실행 연결', () => {
  it('ANSI로 나눈 합성 비밀과 인증 표지를 정규화한 뒤 가리고 조회에서 되살리지 않는다', async () => {
    const { result, events } = await scenario('ansi-output', { declared: true });
    expect(result.verdict).toBe('passed');
    expect(result.cases[0]).toMatchObject({ expected: '[가림]', observed: '[가림]' });
    const outputs = { result, events, summary: resultSummary(result), repair: result.cases.map(compactRepairCase) };
    expect(JSON.stringify(outputs)).not.toContain(secret);
    expect(JSON.stringify(outputs)).not.toContain('safevalue');
  });

  it('선언한 명령에만 환경을 주고 한 실행에 한 번 준비 및 정리한다.', async () => {
    const { result, prepare, cleanup } = await scenario('normal', { declared: true, second: true });
    expect(result.verdict).toBe('passed');
    expect(result.cases).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('선언 없는 명령은 자원 제공자를 호출하지 않고 선언에 제공자가 없으면 차단한다.', async () => {
    const plain = await scenario('normal');
    expect(plain.result.verdict).toBe('passed');
    expect(plain.prepare).not.toHaveBeenCalled();
    expect(plain.cleanup).not.toHaveBeenCalled();
    const blocked = await scenario('normal', { declared: true, noResources: true });
    expect(blocked.result.state).toBe('blocked');
    expect(blocked.result.verdict).not.toBe('passed');
  });

  it('준비 실패에도 정리하고 검사를 통과시키지 않는다.', async () => {
    const { result, prepare, cleanup } = await scenario('normal', { declared: true, prepareFails: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('blocked');
    expect(result.cleanupVerified).toBe(true);
    expect(result.verdict).not.toBe('passed');
    const unknown = await scenario('normal', { declared: true, prepareFails: true, cleanupVerified: false });
    expect(unknown.result.state).toBe('unverifiable');
    expect(unknown.result.cleanupVerified).toBe(false);
    expect(unknown.result.verdict).not.toBe('passed');
  });

  it('취소와 자원 정리 실패를 통과로 확정하지 않는다.', async () => {
    const cancelled = await scenario('cancel', { declared: true, cancel: true });
    expect(cancelled.cleanup).toHaveBeenCalledTimes(1);
    expect(cancelled.result.verdict).not.toBe('passed');
    const unclean = await scenario('normal', { declared: true, cleanupVerified: false });
    expect(unclean.result.cleanupVerified).toBe(false);
    expect(unclean.result.verdict).not.toBe('passed');
  });

  it('작업 프로세스 시작 직후 실패해도 자원을 정리한다.', async () => {
    const { result, cleanup } = await scenario('normal', { declared: true, workerCrash: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('unverifiable');
    expect(result.verdict).not.toBe('passed');
  });

  it('동적 URL 출력은 가리고 원문이 든 텍스트 증거는 등록하지 않는다.', async () => {
    const output = await scenario('output', { declared: true });
    expect(output.result.verdict).toBe('passed');
    expect(JSON.stringify({ result: output.result, events: output.events })).not.toContain(secret);
    expect(JSON.stringify(output.events)).not.toContain(url);
    for (const mode of ['text', 'binary'] as const) {
      const leaked = await scenario(mode, { declared: true });
      expect(leaked.result.verdict).not.toBe('passed');
      expect(leaked.evidence).toHaveLength(1);
      expect(leaked.evidence[0]?.relativePath).toBe('명령-1.json');
    }
  });

  it('선언 없는 어댑터의 자원 주장으로 환경 확인을 승격하지 않는다.', async () => {
    const { result } = await scenario('claim');
    expect(result.environmentVerified).toBe(false);
    expect(result.verdict).not.toBe('passed');
  });
});
