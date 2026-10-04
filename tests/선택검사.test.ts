// 합성 단일 선택 wrapper와 정상 및 변이 결과의 엄격한 수집 계약을 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { ProjectStore } from '../packages/engine/src/저장/프로젝트저장.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { readAdapterEvents } from '../packages/engine/src/이벤트읽기.js';
import { createStoreFixture } from './저장시험자료.js';
import { startLocalService } from '../packages/engine/src/서비스/상주서비스.js';
// 고정 예제 모듈은 TypeScript 선언 없이 Node에서 직접 가져온다.
// @ts-expect-error 합성 예제의 ESM 모듈을 직접 검증한다.
import { checkId, runSelected, selectedResult, name, file } from '../examples/선택검사/scripts/단일검사.mjs';

const example = resolve('examples/선택검사');
// 저장소 합성 wrapper의 LF 바이트를 독립적으로 고정하며 실행 중 기대 SHA를 계산하지 않는다.
const wrapperSha = 'd3ac40923d578d218ebd5094c9dfcb6afd876cf2852330182a555b0bca4d4748';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function selectedFixture(status: 'passed' | 'failed') {
  const files = await createStoreFixture();
  cleanup.push(files.cleanup);
  const root = join(files.directory, status === 'passed' ? '정상' : '실패');
  for (const directory of ['scripts', '.runtime/직접실행', 'checkmate']) await mkdir(join(root, directory), { recursive: true });
  const wrapper = (await readFile(join(example, 'scripts/단일검사.mjs'), 'utf8')).replaceAll('\r\n', '\n');
  await writeFile(join(root, 'scripts/단일검사.mjs'), wrapper);
  const passed = status === 'passed';
  const report = { success: passed, numTotalTests: 21, numPassedTests: Number(passed), numFailedTests: Number(!passed),
    testResults: [{ name: resolve(root, file), assertionResults: [
      { fullName: name, status },
      ...Array.from({ length: 20 }, (_, index) => ({ fullName: `합성 필터 제외 ${index + 1}`, status: 'pending' })),
    ] }] };
  await writeFile(join(root, '.runtime/직접실행/단일-Vitest.json'), JSON.stringify(report));
  const project = JSON.parse(await readFile(join(example, 'checkmate/프로젝트.json'), 'utf8'));
  project.id = passed ? 'ddfede76-b1c0-40d4-894e-198c1ea822a9' : '345318aa-3cab-48cc-ab92-3e509f83b6e4';
  project.repositoryIdentity = `synthetic:selected-${status}`;
  await writeFile(join(root, 'checkmate/프로젝트.json'), JSON.stringify(project));
  return root;
}

test('합성 wrapper는 정확 선택 하나만 실행하고 잘못된 ID는 spawn 0이다', () => {
  const spawn = vi.fn();
  expect(() => runSelected('unknown-check', spawn)).toThrow();
  expect(spawn).not.toHaveBeenCalled();
  expect(runSelected(checkId)).toEqual({ status: 'passed', selected: 1, excluded: 20, exitCode: 0 });
});

test('합성 정상 및 변이 자료의 고정 wrapper SHA와 논리 프로젝트 ID를 보존한다', async () => {
  const ids: string[] = [];
  for (const [exitCode, status] of [[0, 'passed'], [1, 'failed']] as const) {
    const root = await selectedFixture(status);
    expect(createHash('sha256').update(await readFile(join(root, 'scripts/단일검사.mjs'))).digest('hex')).toBe(wrapperSha);
    const report = JSON.parse(await readFile(join(root, '.runtime/직접실행/단일-Vitest.json'), 'utf8'));
    expect(selectedResult(report, exitCode, root)).toEqual({ status, selected: 1, excluded: 20 });
    expect(() => selectedResult(report, exitCode, join(root, '다른프로젝트'))).toThrow();
    const project = JSON.parse(await readFile(join(root, 'checkmate/프로젝트.json'), 'utf8'));
    ids.push(project.id);
    expect(project.profiles[0].checkIds).toEqual(['expense-annual-one']);
    expect(project.repositoryIdentity).toBe(`synthetic:selected-${status}`);
  }
  expect(ids).toEqual(['ddfede76-b1c0-40d4-894e-198c1ea822a9', '345318aa-3cab-48cc-ab92-3e509f83b6e4']);
});

test.each(['zero', 'duplicate', 'outside', 'exit', 'skip', 'unknown', 'missing', 'excluded'] as const)('%s 선택 또는 종료 불일치를 거절한다', async fault => {
  const root = await selectedFixture('passed');
  const report = JSON.parse(await readFile(join(root, '.runtime/직접실행/단일-Vitest.json'), 'utf8'));
  const assertions = report.testResults[0].assertionResults;
  const selected = assertions.find((value: { fullName: string }) => value.fullName === name);
  if (fault === 'zero') selected.fullName = '다른 이름';
  if (fault === 'duplicate') assertions.push({ ...selected });
  if (fault === 'outside') assertions.find((value: { fullName: string }) => value.fullName !== name).status = 'passed';
  if (fault === 'skip') selected.status = 'skipped';
  if (fault === 'unknown') selected.status = 'unknown';
  if (fault === 'missing') report.testResults = [];
  if (fault === 'excluded') assertions.pop();
  expect(() => selectedResult(report, fault === 'exit' ? 1 : 0, root)).toThrow();
});

test('합성 wrapper의 NDJSON에는 선택 한 case만 있고 제외20은 required skip이 아니다', async () => {
  const files = await createStoreFixture();
  try {
    const runId = randomUUID();
    const result = spawnSync(process.execPath, [join(example, 'scripts/단일검사.mjs')], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, CHECKMATE_RUN_ID: runId, CHECKMATE_EVIDENCE_DIR: files.directory,
        CHECKMATE_LOCK_DIR: process.env.CHECKMATE_LOCK_DIR! } });
    expect(result.status).toBe(0);
    async function* chunks() { yield Buffer.from(result.stdout); }
    const events = [];
    for await (const event of readAdapterEvents(chunks(), runId)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ testId: checkId, status: 'passed' });
    expect(events.some(event => event.payload.status === 'skipped')).toBe(false);
  } finally { await files.cleanup(); }
});

test('합성 등록과 사람 fixture 승인 후 planned 및 required 하나만 실제 실행한다', async () => {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  try {
    const snapshot = await readProjectSource(example);
    const projects = new ProjectStore(db);
    projects.register(snapshot);
    const plan = projects.inspect(snapshot, 'expense-one');
    projects.approve(plan.planId, plan.fingerprint);
    const runs = new SQLiteRunStore(db);
    expect(runs.getPlan(plan.planId)?.plan.plannedChecks).toEqual([checkId]);
    expect(runs.getPlan(plan.planId)?.plan.requiredChecks).toEqual([checkId]);
    const evidence = new EvidenceStore(db, files.directory);
    const service = new ProductService(db, evidence, createProjectExecutor({ runsRoot: files.directory, evidenceStore: evidence, eventStore: new EventStore(db) }),
      undefined, undefined, { lockRoot: join(files.directory, '공유잠금') });
    const capabilities = await service.handle({ apiVersion: 1, requestId: randomUUID(), method: 'capabilities', input: {} }, 'human');
    expect(capabilities.ok).toBe(true);
    if (!capabilities.ok) throw new Error(capabilities.error.code);
    const nativeSupported = process.platform === 'win32';
    expect(capabilities.data).toMatchObject({ resourceProviders: {
      modes: nativeSupported ? ['docker', 'native'] : ['docker'], nativeHostSupported: nativeSupported,
      nativeKinds: nativeSupported ? ['postgres-test'] : [], binaryConfiguration: 'registered-command-only',
      binaryReadiness: 'verified-per-plan-and-before-use' } });
    expect((capabilities.data as { capabilities: string[] }).capabilities.includes('native-postgres-resource-provider')).toBe(nativeSupported);
    const admitted = await service.handle({ apiVersion: 1, requestId: randomUUID(), method: 'start', input: { projectId: snapshot.source.project.id, planId: plan.planId } }, 'human');
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.code);
    const runId = (admitted.data as { runId: string }).runId;
    const result = await service.execution.wait(runId);
    expect(result.cases.map(item => item.testId)).toEqual([checkId]);
    expect(result.cases[0]?.status).toBe('passed');
    expect(result.cleanupVerified).toBe(true);
    expect(result.environmentVerified).toBe(true);
    expect(result.evidenceVerified).toBe(true);
    for (let attempt = 0; attempt < 100 && service.active; attempt++) await new Promise(accept => setTimeout(accept, 20));
    expect(service.active).toBe(false);
  } finally { db.close(); await files.cleanup(); }
});

test('새 전용 LocalService와 실제 CLI capabilities는 native 지원과 binary 준비를 구분한다', async () => {
  const id = randomUUID();
  const root = resolve('.runtime/릴리스020/시험보완/CLI', id);
  const markerBody = JSON.stringify({ id, token: randomUUID() });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '시험소유.json'), markerBody, { flag: 'wx' });
  const dataRoot = join(root, '자료');
  const lockRoot = join(root, '공유잠금');
  const service = await startLocalService(dataRoot, 60000, { lockRoot });
  let closed = false;
  try {
    const argv = [resolve('packages/engine/dist/명령.js'), '--data-dir', dataRoot, 'capabilities'];
    const result = await promisify(execFile)(process.execPath, argv, { windowsHide: true, timeout: 15000,
      env: { ...process.env, CHECKMATE_LOCK_DIR: lockRoot } });
    const response = JSON.parse(result.stdout);
    expect(response.ok).toBe(true);
    expect(response.data.connection.dataRoot).toBe(dataRoot);
    expect(response.data.coordination.lockRoot).toBe(lockRoot);
    const nativeSupported = process.platform === 'win32';
    expect(response.data.capabilities.includes('native-postgres-resource-provider')).toBe(nativeSupported);
    expect(response.data.resourceProviders.modes).toEqual(nativeSupported ? ['docker', 'native'] : ['docker']);
    expect(response.data.resourceProviders.nativeHostSupported).toBe(nativeSupported);
    expect(response.data.resourceProviders.nativeKinds).toEqual(nativeSupported ? ['postgres-test'] : []);
    expect(response.data.resourceProviders.binaryConfiguration).toBe('registered-command-only');
    expect(response.data.resourceProviders.binaryReadiness).toBe('verified-per-plan-and-before-use');
    await writeFile(resolve('.runtime/릴리스020/시험보완/CLIcapability근거.json'), JSON.stringify({ argv: [process.execPath, ...argv],
      exit: 0, dataRoot, lockRoot, response, service: 'source-local-service-with-compiled-cli' }));
  } finally {
    await service.close(); closed = true;
    if (!closed || root !== resolve('.runtime/릴리스020/시험보완/CLI', id) || await realpath(root) !== root
      || (await lstat(root)).isSymbolicLink() || await readFile(join(root, '시험소유.json'), 'utf8') !== markerBody)
      throw new Error('CLI 합성 자료의 소유 또는 서비스 종료가 다릅니다.');
    await rm(root, { recursive: true });
  }
});
