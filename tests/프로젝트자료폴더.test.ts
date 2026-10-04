// 합성 자료로 프로젝트 출력 구획과 사람 이전 및 위치 복원 경계를 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assessResult, runResultSchema, type RunResult } from '@checkmate/contracts';
import type { ApiRequest, ProjectStoragePreview } from '@checkmate/contracts/api';
import { dataPaths, makePrivate, prepareDataPaths } from '../packages/engine/src/연결/개인경로.js';
import { executionLockKeys, SharedLocks } from '../packages/engine/src/연결/공유잠금.js';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { ProjectStorage, scanRunFiles } from '../packages/engine/src/저장/프로젝트자료.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createBackup, restoreBackup, verifyBackup } from '../packages/engine/src/저장/백업.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { hideCommandOutput } from '../packages/engine/src/작업/비밀가림.js';
import { createStoreFixture, writeConcurrentProject } from './저장시험자료.js';

const copyFault = vi.hoisted(() => ({ at: 0, count: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
    copyFault.count += 1;
    if (copyFault.at === copyFault.count) throw Object.assign(new Error('합성 부분 복사 실패'), { code: 'EACCES' });
    return fs.copyFile(...args);
  } };
});
const close: (() => Promise<void>)[] = [];
afterEach(async () => { copyFault.at = 0; copyFault.count = 0; for (const work of close.splice(0).reverse()) await work(); });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function setup(script?: string, ndjson = false, resourceSecret?: string) {
  const f = await createStoreFixture(); close.push(f.cleanup);
  const paths = dataPaths(join(f.directory, '관리자료'));
  await prepareDataPaths(paths);
  const output = join(f.directory, '선택자료'); await mkdir(output);
  const project = await writeConcurrentProject(f.directory, '합성프로젝트');
  if (script) await writeFile(join(project.projectRoot, '검사.mjs'), script);
  if (ndjson || resourceSecret) {
    const command = project.source.project.commands[0]!;
    const changed = { ...project.source.project, commands: [{ ...command, resultFormat: ndjson ? 'ndjson' : 'exit-code',
      ...(resourceSecret ? { resources: ['postgres-test'] } : {}) }] };
    await writeFile(join(project.projectRoot, 'checkmate', '프로젝트.json'), JSON.stringify(changed));
  }
  const db = connectStore(join(paths.state, 'checkmate.sqlite')); close.push(async () => { db.close(); });
  const evidence = new EvidenceStore(db, paths.runs);
  const resources = resourceSecret ? { prepare: vi.fn(async () => ({ environment: { CHECKMATE_PG_PASSWORD: resourceSecret }, secrets: [resourceSecret] })),
    cleanup: vi.fn(async () => ({ verified: true, resources: [] })) } : undefined;
  const service = new ProductService(db, evidence, createProjectExecutor({ runsRoot: paths.runs,
    evidenceStore: evidence, eventStore: new EventStore(db), ...(resources ? { resources } : {}) }), paths, resources,
    { lockRoot: join(f.directory, '공유잠금') });
  const call = async <T = any>(method: ApiRequest['method'], input: ApiRequest['input'], requestId = randomUUID(), role: 'human' | 'agent' = 'human'): Promise<T> => {
    const response = await service.handle({ apiVersion: 1, requestId, method, input }, role);
    if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
    return response.data as T;
  };
  await call('register', { path: project.projectRoot });
  async function configure(root: string | null = output) {
    const setting = service.storage.settings(project.projectId);
    const preview = await call<ProjectStoragePreview>('preview-project-storage', { projectId: project.projectId, root, expectedRevision: setting.revision });
    const operationId = randomUUID();
    const input = { projectId: project.projectId, previewId: preview.previewId, fingerprint: preview.fingerprint,
      expectedRevision: preview.expectedRevision, confirm: true };
    const applied = await call('apply-project-storage', input, operationId);
    return { preview, operationId, input, applied };
  }
  async function run(workspaceId?: string, requestId = randomUUID()) {
    const review = await call('inspect', { projectId: project.projectId, profile: 'quick', ...(workspaceId ? { workspaceId } : {}) });
    await call('approve', { planId: review.planId, fingerprint: review.fingerprint });
    const admitted = await call('start', { projectId: project.projectId, planId: review.planId, ...(workspaceId ? { workspaceId } : {}) }, requestId);
    const result = await service.execution.wait(admitted.runId);
    for (let attempts = 0; service.active && attempts < 200; attempts += 1) await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.active).toBe(false);
    return { review, result, requestId, root: evidence.runRoot(admitted.runId) };
  }
  return { ...f, ...project, paths, output, db, evidence, service, call, configure, run, resources };
}

it('프로젝트·workspace·dataRoot 이름 공간을 분리하고 새 실행을 선택 폴더에 직접 쓴다.', async () => {
  const f = await setup();
  expect(f.service.storage.settings(f.projectId)).toMatchObject({ namespaceId: null, revision: 0, configuredRoot: null });
  const configured = await f.configure();
  const first = await f.run();
  expect(first.result.verdict).toBe('passed');
  const namespace = configured.applied.settings.namespaceId;
  expect(first.root).toBe(join(f.output, 'CheckMate', f.projectId, namespace, first.review.workspaceId, 'runs', first.result.runId));
  await expect(readFile(join(f.paths.runs, first.result.runId, '소유.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const other = await writeConcurrentProject(f.directory, '다른workspace', f.projectId);
  const registered = await f.call('register', { path: other.projectRoot });
  const second = await f.run(registered.workspaceId);
  expect(second.root).not.toBe(first.root);
  expect(second.review.workspaceId).not.toBe(first.review.workspaceId);
  const paths2 = dataPaths(join(f.directory, '두번째관리')); await prepareDataPaths(paths2);
  const db2 = connectStore(join(paths2.state, 'checkmate.sqlite')); close.push(async () => { db2.close(); });
  const evidence2 = new EvidenceStore(db2, paths2.runs);
  const service2 = new ProductService(db2, evidence2, async (_plan, initial) => initial, paths2, undefined, { lockRoot: join(f.directory, '다른잠금') });
  service2.projects.register(await readProjectSource(f.projectRoot));
  const preview2 = service2.storage.preview(f.projectId, f.output, 0);
  const applied2 = await service2.storage.apply(f.projectId, preview2.previewId, 0, preview2.fingerprint, randomUUID());
  expect(applied2.settings.namespaceId).not.toBe(namespace);
  const thirdProject = await writeConcurrentProject(f.directory, '다른프로젝트');
  await f.call('register', { path: thirdProject.projectRoot });
  const thirdPreview = f.service.storage.preview(thirdProject.projectId, f.output, 0);
  expect(thirdPreview.destinationRoot).not.toBe(configured.preview.destinationRoot);
}, 60_000);

it('한글 stdout·stderr와 known/escaped 비밀 및 ownerToken을 제한 로그로 보존한다.', async () => {
  const secret = '합성\\비밀"줄\n끝';
  const f = await setup(`// 합성 로그와 비밀을 표준 출력으로 전달한다.\nprocess.stdout.write('한글 정상 출력\\n' + process.env.CHECKMATE_PG_PASSWORD + '\\n' + JSON.stringify(process.env.CHECKMATE_PG_PASSWORD));\nprocess.stderr.write('한글 오류 출력\\n' + process.env.CHECKMATE_OWNER_TOKEN + '\\nAuthorization: Bearer sample-private');`, false, secret);
  await f.configure();
  const run = await f.run();
  expect(run.result).toMatchObject({ verdict: 'passed', cleanupVerified: true, evidenceVerified: true });
  const logs = f.evidence.list(run.result.runId).filter(file => file.relativePath.endsWith('.log'));
  expect(logs).toHaveLength(2);
  let length = 0;
  for (const log of logs) {
    expect(log.sensitivity).toBe('restricted');
    const bytes = await readFile(join(run.root, log.relativePath)); length += bytes.length;
    expect(hash(bytes)).toBe(log.sha256); expect(bytes.length).toBe(log.byteLength);
    expect(bytes.toString()).toContain('한글'); expect(bytes.toString()).toContain('[가림]');
    expect(bytes.toString()).not.toContain(secret); expect(bytes.toString()).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(bytes.toString()).not.toContain('sample-private'); expect(bytes.toString()).not.toMatch(/[a-f0-9]{64}/);
    await expect(f.evidence.readText(run.result.runId, log.id)).rejects.toMatchObject({ code: 'evidence-restricted' });
  }
  expect(length).toBeLessThanOrEqual(256 * 1024);
  expect(f.resources!.cleanup).toHaveBeenCalledOnce();
  expect(hideCommandOutput('앞쪽 합성\\비', [secret], true)).toBe('앞쪽 [가림]');
}, 30_000);

it('공식 NDJSON 이미지의 ID·SHA와 협력 기타 파일을 보존하며 보호 본문은 공개하지 않는다.', async () => {
  const f = await setup(String.raw`// 공식 산출물과 원래 증거 ID를 생성한다.
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9QAAAABJRU5ErkJggg==','base64');
const id=randomUUID();
writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR,'그림.png'),bytes);
writeFileSync(join(process.env.CHECKMATE_EVIDENCE_DIR,'합성.bin'),Buffer.from([1,2,3]));
const event=(sequence,type,payload)=>process.stdout.write(JSON.stringify({protocolVersion:1,runId:process.env.CHECKMATE_RUN_ID,sequence,type,time:new Date().toISOString(),payload})+'\n');
event(1,'evidence-created',{id,relativePath:'그림.png',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mime:'image/png',sensitivity:'public'});
event(2,'case-result',{testId:'check-1',status:'passed',requirementId:'requirement-1',expected:'종료코드 0',observed:'그림 확인',evidenceIds:[id],severity:'info',location:null});`, true);
  await f.configure(); const run = await f.run();
  expect(run.result).toMatchObject({ verdict: 'passed', evidenceVerified: true });
  const files = f.evidence.list(run.result.runId);
  const image = files.find(file => file.mime === 'image/png')!;
  expect(image.relativePath).toBe('artifacts/그림.png');
  const events = new EventStore(f.db).list(run.result.runId);
  expect(events[0]!.payload).toMatchObject({ id: image.id, relativePath: '그림.png', sha256: image.sha256 });
  expect(run.result.cases[0]!.evidenceIds).toContain(image.id);
  expect(await f.evidence.readImage(run.result.runId, image.id)).toMatchObject({ width: 1, height: 1, sha256: image.sha256 });
  const binary = files.find(file => file.mime === 'application/octet-stream')!;
  expect(binary).toMatchObject({ sensitivity: 'restricted', byteLength: 3 });
  await expect(f.evidence.readText(run.result.runId, binary.id)).rejects.toMatchObject({ code: 'evidence-restricted' });
  const snapshot = await createBackup(f.db, f.paths, join(f.paths.root, 'backups'));
  expect(snapshot.manifest.files.some(file => file.path.endsWith(binary.relativePath))).toBe(true);
  await expect(f.evidence.register(run.result.runId, { id: randomUUID(), relativePath: binary.relativePath, sha256: binary.sha256,
    byteLength: binary.byteLength, mime: binary.mime, sensitivity: 'public' })).rejects.toMatchObject({ code: 'invalid-input' });
  const log = files.find(file => file.relativePath.startsWith('logs/'))!;
  await expect(f.evidence.replaceCollected(run.result.runId, log.id, { id: randomUUID(), relativePath: log.relativePath, sha256: log.sha256,
    byteLength: log.byteLength, mime: log.mime, sensitivity: 'public' }))
    .rejects.toMatchObject({ code: 'evidence-conflict' });
  const observation = JSON.parse(await readFile(join(run.root, 'results', '결과.json'), 'utf8'));
  expect(observation).toEqual({ recordKind: 'uncommitted-result-observation', commitVerified: false,
    authoritativeResult: 'service-database-query', candidateResult: run.result });
  expect(observation).not.toHaveProperty('finalized');
  expect(observation).not.toHaveProperty('verdict');
  expect(runResultSchema.parse(observation.candidateResult)).toEqual(run.result);
}, 30_000);

it.each(['evidence-insert', 'before-commit'] as const)('결과 관측 뒤 %s 실패는 DB 미확정과 lease 및 원관측을 보존하고 자동 재확정하지 않는다.', async phase => {
  const f = await setup(); await f.configure(); await f.service.locks.prepare();
  const review = await f.call('inspect', { projectId: f.projectId, profile: 'quick' });
  const plan = f.service.runs.getPlan(review.planId)!;
  const runId = randomUUID(), requestId = randomUUID(), requestHash = 'a'.repeat(64);
  const lease = f.service.locks.acquire(runId, null, requestHash,
    executionLockKeys(f.projectRoot, [], [], [join(plan.plan.outputStorage!.runsRoot, runId)]));
  const admission = { projectId: f.projectId, planId: review.planId, requestId, requestHash, runId,
    createdAt: new Date().toISOString(), lease };
  f.service.runs.admitRun(admission); f.service.locks.admit(lease);
  const leasePath = join(f.service.locks.root, `${runId}-${lease.generation}.json`);
  const originalLease = await readFile(leasePath);
  const running = f.service.runs.markRunning(runId);
  const before = f.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  const candidate: RunResult = { ...running, state: 'finished', finalized: true, sourceAfter: running.sourceBefore,
    workerExitCode: 0, environmentVerified: true, evidenceVerified: true, cleanupVerified: true,
    cases: [{ testId: 'check-1', status: 'passed', requirementId: 'requirement-1', expected: null, observed: null,
      evidenceIds: [], severity: 'info', location: null }], verdict: null, reasons: [] };
  const final = { ...candidate, ...assessResult(candidate) };
  const saveResult = f.service.storage.saveResult.bind(f.service.storage);
  const saves = vi.spyOn(f.service.storage, 'saveResult').mockImplementation(value => {
    saveResult(value);
    if (phase === 'before-commit') throw new Error('합성 COMMIT 직전 오류');
  });
  if (phase === 'evidence-insert') f.db.exec(`CREATE TRIGGER reject_result_evidence BEFORE INSERT ON evidence
    WHEN NEW.relative_path='results/결과.json' BEGIN SELECT RAISE(ABORT, '합성 결과 증거 삽입 실패'); END;`);
  expect(() => f.service.runs.finalizeRun(final)).toThrowError(expect.objectContaining({ code: 'storage-error' }));
  const target = join(f.evidence.runRoot(runId), 'results', '결과.json');
  const originalFile = await readFile(target);
  expect(JSON.parse(originalFile.toString('utf8'))).toEqual({ recordKind: 'uncommitted-result-observation', commitVerified: false,
    authoritativeResult: 'service-database-query', candidateResult: final });
  expect(f.db.prepare('SELECT * FROM runs WHERE id=?').get(runId)).toEqual(before);
  expect(f.service.runs.getRun(runId)).toEqual(running);
  expect(f.service.runs.getRun(runId)).toMatchObject({ finalized: false, state: 'running', verdict: null });
  expect(f.db.prepare('SELECT count(*) AS count FROM evidence WHERE run_id=?').get(runId)).toEqual({ count: 0 });
  expect(f.db.prepare('SELECT count(*) AS count FROM case_results WHERE run_id=?').get(runId)).toEqual({ count: 0 });
  expect(await f.call('result', { runId, section: 'summary' })).toMatchObject({ finalized: false, state: 'running', verdict: null });
  expect(f.service.runs.admitRun({ ...admission, runId: randomUUID() })).toEqual({ runId, reused: true });
  expect(saves).toHaveBeenCalledTimes(1);
  expect(f.service.active).toBe(false);
  expect(await readFile(target)).toEqual(originalFile);
  expect(await readFile(leasePath)).toEqual(originalLease);
  expect(f.db.prepare('SELECT lease_json FROM execution_locks WHERE run_id=?').get(runId)).toBeDefined();
  f.service.locks.assert(lease, lease.keys);
  saves.mockRestore();
}, 30_000);

it('기존 자료의 원본·계획·승인·결과 JSON을 보존하고 같은 operationId와 실행 requestId를 재조회한다.', async () => {
  const f = await setup(); const before = await f.run();
  const plans = f.db.prepare('SELECT * FROM plans ORDER BY id').all();
  const approvals = f.db.prepare('SELECT * FROM approvals ORDER BY id').all();
  const results = f.db.prepare('SELECT summary_json FROM runs ORDER BY id').all();
  const files = scanRunFiles(before.root);
  const applied = await f.configure();
  const copiedRoot = f.evidence.runRoot(before.result.runId);
  expect(copiedRoot).not.toBe(before.root);
  expect(scanRunFiles(copiedRoot)).toEqual(files); expect(scanRunFiles(before.root)).toEqual(files);
  expect(f.db.prepare('SELECT * FROM plans ORDER BY id').all()).toEqual(plans);
  expect(f.db.prepare('SELECT * FROM approvals ORDER BY id').all()).toEqual(approvals);
  expect(f.db.prepare('SELECT summary_json FROM runs ORDER BY id').all()).toEqual(results);
  const count = copyFault.count;
  const restarted = new ProjectStorage(f.db, f.paths.runs);
  expect(restarted.operation(f.projectId, applied.operationId)).toMatchObject({ state: 'completed', result: applied.applied });
  expect(await restarted.apply(f.projectId, applied.preview.previewId, 0, applied.preview.fingerprint, applied.operationId)).toEqual(applied.applied);
  expect(copyFault.count).toBe(count);
  expect(await f.call('start', { projectId: f.projectId, planId: before.review.planId }, before.requestId)).toMatchObject({ runId: before.result.runId, reused: true });
  await expect(f.call('start', { projectId: f.projectId, planId: before.review.planId })).rejects.toMatchObject({ code: 'plan-stale' });
  await expect(f.call('apply-project-storage', { ...applied.input, fingerprint: 'f'.repeat(64) }, applied.operationId)).rejects.toMatchObject({ code: 'request-conflict' });
  await expect(f.call('apply-project-storage', applied.input)).rejects.toMatchObject({ code: 'plan-stale' });
  const reads = await f.call('result', { runId: before.result.runId, section: 'summary' }); expect(reads.integrity).toBe('verified');
}, 30_000);

it('preview 이후 source 변조와 새 계획 locator 누락·손상을 fallback 없이 거절한다.', async () => {
  const f = await setup(); const run = await f.run();
  const preview = f.service.storage.preview(f.projectId, f.output, 0);
  const operationId = randomUUID();
  await writeFile(join(run.root, '변경.txt'), 'preview 이후 추가');
  await expect(f.service.storage.apply(f.projectId, preview.previewId, 0, preview.fingerprint, operationId)).rejects.toMatchObject({ code: 'source-changed' });
  expect(f.service.storage.settings(f.projectId).revision).toBe(0);
  expect(f.service.storage.operation(f.projectId, operationId).state).toBe('not-found');
  const locator = f.db.prepare('SELECT * FROM run_storage_locations WHERE run_id=?').get(run.result.runId) as any;
  f.db.prepare('DELETE FROM run_storage_locations WHERE run_id=?').run(run.result.runId);
  expect(() => f.evidence.runRoot(run.result.runId)).toThrowError(expect.objectContaining({ code: 'storage-corrupt' }));
  f.db.prepare('INSERT INTO run_storage_locations (run_id,root_path,storage_id,setting_revision,layout_version,created_at) VALUES (?,?,?,?,?,?)')
    .run(run.result.runId, join(f.output, '임의위치'), locator.storage_id, locator.setting_revision, locator.layout_version, locator.created_at);
  expect(() => f.evidence.runRoot(run.result.runId)).toThrowError(expect.objectContaining({ code: 'storage-corrupt' }));
}, 30_000);

it('접수 transaction에서 revision 경합을 거절하며 runs와 locator를 함께 롤백한다.', async () => {
  const f = await setup(); await f.configure();
  const review = await f.call('inspect', { projectId: f.projectId, profile: 'quick' });
  const store = new SQLiteRunStore(f.db, f.service.storage);
  const runId = randomUUID();
  expect(() => store.admitRun({ projectId: f.projectId, planId: review.planId, requestId: randomUUID(), requestHash: 'a'.repeat(64), runId,
    createdAt: new Date().toISOString() }, () => { f.db.prepare('UPDATE project_storage_settings SET revision=revision+1 WHERE project_id=?').run(f.projectId); }))
    .toThrowError(expect.objectContaining({ code: 'plan-stale' }));
  expect(f.db.prepare('SELECT * FROM runs WHERE id=?').get(runId)).toBeUndefined();
  expect(f.db.prepare('SELECT * FROM run_storage_locations WHERE run_id=?').get(runId)).toBeUndefined();
  expect(f.service.storage.settings(f.projectId).revision).toBe(1);
}, 30_000);

it('부분 복사는 실패 상태와 사본을 남기며 응답 유실과 불명 intent를 자동 재복사하지 않는다.', async () => {
  const f = await setup(); const run = await f.run();
  const preview = f.service.storage.preview(f.projectId, f.output, 0); const operationId = randomUUID();
  copyFault.count = 0; copyFault.at = 2;
  await expect(f.service.storage.apply(f.projectId, preview.previewId, 0, preview.fingerprint, operationId)).rejects.toMatchObject({ code: 'EACCES' });
  expect(f.service.storage.operation(f.projectId, operationId)).toMatchObject({ state: 'failed', error: 'EACCES' });
  expect(f.evidence.runRoot(run.result.runId)).toBe(run.root); expect(f.service.storage.settings(f.projectId).revision).toBe(0);
  expect(scanRunFiles(join(preview.destinationRoot, run.review.workspaceId, 'runs', run.result.runId))).toHaveLength(1);
  const count = copyFault.count;
  await expect(f.service.storage.apply(f.projectId, preview.previewId, 0, preview.fingerprint, operationId)).rejects.toMatchObject({ code: 'EACCES' });
  expect(copyFault.count).toBe(count);
  const unknownId = randomUUID(); const bodyHash = hash(JSON.stringify({ projectId: f.projectId, previewId: preview.previewId, expectedRevision: 0,
    fingerprint: preview.fingerprint, confirm: true }));
  f.db.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,recorded_at,detail_json) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), 'project-storage-intent', 'human', unknownId, new Date().toISOString(), JSON.stringify({ projectId: f.projectId, bodyHash }));
  expect(new ProjectStorage(f.db, f.paths.runs).operation(f.projectId, unknownId).state).toBe('unknown');
  await expect(f.service.storage.apply(f.projectId, preview.previewId, 0, preview.fingerprint, unknownId)).rejects.toMatchObject({ code: 'storage-operation-unknown' });
  expect(copyFault.count).toBe(count);
}, 30_000);

it('live unknown와 사람전용 agent 요청을 거절하고 기본복귀 충돌은 preview에서 원본을 보존한다.', async () => {
  const f = await setup(); const run = await f.run();
  const original = f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(run.result.runId) as { summary_json: string };
  f.db.prepare("UPDATE runs SET verdict='unknown',summary_json=? WHERE id=?")
    .run(JSON.stringify({ ...run.result, verdict: 'unknown' }), run.result.runId);
  expect(() => f.service.storage.preview(f.projectId, f.output, 0)).toThrowError(expect.objectContaining({ code: 'storage-busy' }));
  expect(f.service.storage.settings(f.projectId).revision).toBe(0); expect(copyFault.count).toBe(0);
  f.db.prepare('UPDATE runs SET verdict=?,summary_json=? WHERE id=?').run(run.result.verdict, original.summary_json, run.result.runId);
  const configured = await f.configure();
  await expect(f.call('preview-project-storage', { projectId: f.projectId, root: null, expectedRevision: 1 }, randomUUID(), 'agent'))
    .rejects.toMatchObject({ code: 'human-action-required' });
  await expect(f.call('apply-project-storage', configured.input, randomUUID(), 'agent')).rejects.toMatchObject({ code: 'human-action-required' });
  for (const modified of [false, true]) {
    if (modified) await writeFile(join(run.root, '원본변경.txt'), '원본 경로의 다른 자료');
    expect(() => f.service.storage.preview(f.projectId, null, 1)).toThrowError(expect.objectContaining({ code: 'storage-destination-conflict' }));
    expect(f.service.storage.settings(f.projectId).revision).toBe(1);
  }
  const noOp = f.service.storage.preview(f.projectId, f.output, 1);
  expect((await f.service.storage.apply(f.projectId, noOp.previewId, 1, noOp.fingerprint, randomUUID())).settings.revision).toBe(2);
}, 30_000);

it('legacy와 외부 증거를 논리 runs로 백업하고 사본 locator만 복원하며 원본 접근을 차단한다.', async () => {
  const f = await setup();
  const review = await f.call('inspect', { projectId: f.projectId, profile: 'quick' });
  const legacy = f.service.runs.getPlan(review.planId)!; delete legacy.plan.outputStorage;
  legacy.plan.id = randomUUID(); legacy.plan.fingerprint = hash(legacy.plan.id);
  const store = new SQLiteRunStore(f.db); store.registerPlan(legacy);
  const oldId = randomUUID(); store.admitRun({ projectId: f.projectId, planId: legacy.plan.id, runId: oldId,
    requestId: randomUUID(), requestHash: hash(oldId), createdAt: new Date().toISOString() });
  store.markRunning(oldId);
  const initial = store.getRun(oldId)!;
  const oldResult = { ...initial, state: 'finished' as const, verdict: 'passed' as const, workerExitCode: 0, environmentVerified: true,
    evidenceVerified: true, cleanupVerified: true, finalized: true, sourceAfter: initial.sourceBefore,
    cases: [{ testId: 'check-1', status: 'passed' as const, requirementId: 'requirement-1', expected: '성공', observed: '성공', evidenceIds: [], severity: 'info' as const, location: null }], reasons: [] };
  store.finalizeRun(oldResult);
  await mkdir(join(f.paths.runs, oldId)); const bytes = Buffer.from('legacy 원본');
  await writeFile(join(f.paths.runs, oldId, '이전.txt'), bytes);
  await f.evidence.register(oldId, { id: randomUUID(), relativePath: '이전.txt', sha256: hash(bytes), byteLength: bytes.length, mime: 'text/plain', sensitivity: 'public' });
  const large = Buffer.alloc(9 * 1024 * 1024, 7); await writeFile(join(f.paths.runs, oldId, '큰원본.bin'), large);
  await f.evidence.register(oldId, { id: randomUUID(), relativePath: '큰원본.bin', sha256: hash(large), byteLength: large.length,
    mime: 'application/octet-stream', sensitivity: 'restricted' });
  await f.configure(); const external = await f.run();
  await expect(createBackup(f.db, f.paths, external.root)).rejects.toMatchObject({ code: 'invalid-path' });
  const saved = await createBackup(f.db, f.paths, join(f.paths.root, 'backups'));
  expect((await verifyBackup(saved.backupDirectory)).schemaVersion).toBe(3);
  expect(saved.manifest.files.some(file => file.path === `runs/${oldId}/이전.txt`)).toBe(true);
  expect(saved.manifest.files.find(file => file.path === `runs/${oldId}/큰원본.bin`)).toMatchObject({ sha256: hash(large), byteLength: large.length });
  const target = join(f.directory, '복원사본'); const restored = await restoreBackup(saved.backupDirectory, target);
  const copied = connectStore(join(restored.state, 'checkmate.sqlite')); close.push(async () => { copied.close(); });
  const copiedEvidence = new EvidenceStore(copied, restored.runs);
  expect(copiedEvidence.runRoot(external.result.runId)).toBe(join(restored.runs, external.result.runId));
  expect(new ProjectStorage(copied, restored.runs).settings(f.projectId)).toMatchObject({ configuredRoot: null, revision: 2 });
  expect(copied.prepare('SELECT summary_json FROM runs WHERE id=?').get(external.result.runId)).toEqual(f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(external.result.runId));
  await rename(external.root, `${external.root}-보존`);
  for (const file of copiedEvidence.list(external.result.runId)) expect((await copiedEvidence.inspect(external.result.runId, file.id)).integrity).toBe('verified');
}, 60_000);

it('선택한 링크·DB·runtime·resources·lock·소스와 교체된 namespace를 거절한다.', async () => {
  const f = await setup();
  for (const path of [f.paths.state, f.paths.runtime, join(f.paths.root, 'resources'), f.service.locks.root, f.projectRoot])
    expect(() => f.service.storage.preview(f.projectId, path, 0)).toThrow();
  const link = join(f.directory, '자료연결'); await symlink(f.output, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => f.service.storage.preview(f.projectId, link, 0)).toThrowError(expect.objectContaining({ code: 'unsafe-path' }));
  expect(() => f.service.storage.preview(f.projectId, '\\\\invalid-host\\share', 0)).toThrowError(expect.objectContaining({ code: 'unsafe-path' }));
  const configured = await f.configure(); const namespaceRoot = configured.preview.destinationRoot;
  const marker = await readFile(join(namespaceRoot, '프로젝트소유.json'));
  await rename(namespaceRoot, `${namespaceRoot}-보존`); await mkdir(namespaceRoot); await writeFile(join(namespaceRoot, '프로젝트소유.json'), marker);
  await expect(f.call('inspect', { projectId: f.projectId, profile: 'quick' })).rejects.toMatchObject({ code: 'storage-error' });
}, 30_000);

it('출력 run 구획끼리는 공통 부모를 잠그지 않고 writes와의 겹침만 충돌한다.', async () => {
  const f = await setup(); await f.service.locks.prepare();
  const other = await writeConcurrentProject(f.directory, '잠금프로젝트');
  const output1 = join(f.output, '첫실행'), output2 = join(f.output, '둘째실행');
  const first = f.service.locks.acquire(randomUUID(), null, 'a'.repeat(64), executionLockKeys(f.projectRoot, [], [], [output1]));
  const second = f.service.locks.acquire(randomUUID(), null, 'b'.repeat(64), executionLockKeys(other.projectRoot, [], [], [output2]));
  expect(first.keys).toContain(`path:${process.platform === 'win32' ? output1.toLowerCase() : output1}`);
  const otherLocks = new SharedLocks(f.service.locks.root, f.paths.root);
  expect(() => otherLocks.acquire(randomUUID(), null, 'c'.repeat(64), executionLockKeys(f.output, ['첫실행'], [], [])))
    .toThrowError(expect.objectContaining({ code: 'shared-resource-busy' }));
  f.service.locks.release(second); f.service.locks.release(first);
}, 30_000);

it('협력 크기·개수·깊이·합계는 읽기 전에 제한하고 기존 큰 보관본은 streaming으로 빠짐없이 읽는다.', async () => {
  const f = await createStoreFixture(); close.push(f.cleanup);
  const limits = { maxFileBytes: 8 * 1024 * 1024, maxFiles: 128, maxDepth: 16, maxTotalBytes: 32 * 1024 * 1024 };
  const huge = join(f.directory, '과대'); await mkdir(huge); const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  await writeFile(join(huge, '보관.bin'), bytes);
  expect(() => scanRunFiles(huge, limits)).toThrowError(expect.objectContaining({ code: 'artifact-limit' }));
  expect(scanRunFiles(huge)).toEqual([{ path: '보관.bin', sha256: hash(bytes), byteLength: bytes.length }]);
  const many = join(f.directory, '과다'); await mkdir(many);
  for (let count = 0; count < 129; count += 1) await writeFile(join(many, `${count}.txt`), '합성');
  expect(() => scanRunFiles(many, limits)).toThrowError(expect.objectContaining({ code: 'artifact-limit' }));
  const deep = join(f.directory, '깊이'); await mkdir(join(deep, ...Array.from({ length: 17 }, () => '하위')), { recursive: true });
  expect(() => scanRunFiles(deep, limits)).toThrowError(expect.objectContaining({ code: 'artifact-limit' }));
  const total = join(f.directory, '합계'); await mkdir(total);
  for (let count = 0; count < 5; count += 1) await writeFile(join(total, `${count}.bin`), bytes.subarray(0, 8 * 1024 * 1024));
  expect(() => scanRunFiles(total, limits)).toThrowError(expect.objectContaining({ code: 'artifact-limit' }));
  expect(await readdir(total)).toHaveLength(5);
});

it('합산 stdout·stderr 제한과 잘린 비밀 및 잘못된 UTF8은 성공 판정으로 바뀌지 않는다.', async () => {
  for (const script of [
    `// 합산 출력 제한을 넘는 합성 명령이다.\nprocess.stdout.write('A'.repeat(200000)); process.stderr.write('B'.repeat(100000));`,
    `// 출력 제한 경계에서 비밀의 접두부가 잘린다.\nprocess.stdout.write('X'.repeat(256*1024-6)+process.env.CHECKMATE_PG_PASSWORD);`,
    `// 잘못된 UTF8을 전달하는 합성 명령이다.\nprocess.stdout.write(Buffer.from([0xc0,0xaf]));`,
  ]) {
    const f = await setup(script, false, 'fixed-secret-ABCDEFG'); await f.configure(); const run = await f.run();
    expect(run.result.verdict).not.toBe('passed');
    const logs = f.evidence.list(run.result.runId).filter(file => file.relativePath.startsWith('logs/'));
    let size = 0;
    for (const file of logs) { const bytes = await readFile(join(run.root, file.relativePath)); size += bytes.length;
      expect(bytes.toString()).not.toContain('fixed-'); }
    expect(size).toBeLessThanOrEqual(256 * 1024);
  }
}, 60_000);

it('실물 없는 imported 이력은 메타 자료로 보존하고 불명 이전은 새 operationId로 재복사하지 않는다.', async () => {
  const f = await setup(); const report = join(f.directory, '합성이력.json');
  await writeFile(report, JSON.stringify({ mode: 'quick', status: 'passed', source: { fingerprint: 'a'.repeat(64) },
    sourceAfter: { fingerprint: 'a'.repeat(64) }, steps: [{ id: 'types', status: 'passed', exitCode: 0 }], omitted: [] }));
  const imported = await f.call('import-history', { projectId: f.projectId, path: report });
  const original = f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(imported.runId);
  const applied = await f.configure(); expect(applied.applied.movedRunCount).toBe(0);
  expect(f.db.prepare('SELECT summary_json FROM runs WHERE id=?').get(imported.runId)).toEqual(original);
  const next = f.service.storage.preview(f.projectId, f.output, 1);
  const bodyHash = hash(JSON.stringify({ projectId: f.projectId, previewId: next.previewId, expectedRevision: 1, fingerprint: next.fingerprint, confirm: true }));
  f.db.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,recorded_at,detail_json) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), 'project-storage-intent', 'human', randomUUID(), new Date().toISOString(), JSON.stringify({ projectId: f.projectId, bodyHash }));
  const count = copyFault.count;
  await expect(f.service.storage.apply(f.projectId, next.previewId, 1, next.fingerprint, randomUUID())).rejects.toMatchObject({ code: 'storage-operation-unknown' });
  expect(copyFault.count).toBe(count); expect(f.service.storage.settings(f.projectId).revision).toBe(1);
}, 30_000);

it('같은277자 합성 경로에서 기존 ACL 실패와 확장경로의 실제 소유자·전용권한을 비교한다.', async () => {
  if (process.platform !== 'win32') return;
  const f = await createStoreFixture(); close.push(f.cleanup);
  const directory = join(f.directory, '장경로'); await mkdir(directory);
  const path = join(directory, '가'.repeat(277 - directory.length - 1 - 4) + '.log');
  expect(path.length).toBe(277); await writeFile(path, '합성 원본');
  await expect(makePrivate(path, true)).rejects.toMatchObject({ code: 'private-directory-failed' });
  await makePrivate(`\\\\?\\${path}`, true);
  const script = `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(`\\\\?\\${path}`, 'utf8').toString('base64')}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.File]::GetAccessControl($target); ConvertTo-Json -Compress @{ ownerMatches=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid); protected=$acl.AreAccessRulesProtected; entries=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) }`;
  const raw = execFileSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' });
  const acl = JSON.parse(raw); expect(acl).toMatchObject({ ownerMatches: true, protected: true }); expect(acl.entries).toHaveLength(1);
  expect(await readFile(path, 'utf8')).toBe('합성 원본');
}, 30_000);
