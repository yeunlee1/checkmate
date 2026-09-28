// 합성 보고서의 안전한 파일 읽기와 SQLite 과거 이력 저장 계약을 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { importHistory, getImportedHistory } from '../packages/engine/src/저장/가져온이력.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function report(overrides: Record<string, unknown> = {}) {
  return { mode: 'quick', status: 'passed', source: { fingerprint: 'a'.repeat(64) },
    sourceAfter: { fingerprint: 'a'.repeat(64) }, omitted: ['민감한 누락 설명'],
    steps: [{ id: 'format', status: 'passed', exitCode: 0, log: 'secret-token' }], ...overrides };
}

async function fixture() {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { if (db.open) db.close(); await files.cleanup(); });
  const projectId = randomUUID();
  const registration: PlanRegistration = {
    project: { id: projectId, name: '합성 프로젝트', repositoryIdentity: 'synthetic:history' },
    workspace: { id: randomUUID(), realPath: files.directory, pathFingerprint: 'b'.repeat(64) },
    catalog: { id: randomUUID(), contentHash: 'c'.repeat(64), source: { check: { id: 'current-check' } } },
    plan: { id: randomUUID(), fingerprint: 'd'.repeat(64), sourceHash: 'e'.repeat(64), profile: 'quick',
      plannedChecks: ['current-check'], requiredChecks: ['current-check'] },
    createdAt: new Date().toISOString(),
  };
  const runs = new SQLiteRunStore(db);
  runs.registerPlan(registration);
  const path = join(files.directory, '과거보고서.json');
  await writeFile(path, `${JSON.stringify(report())}\n`);
  return { files, db, runs, registration, path };
}

test('원래 통과도 미검증으로 저장하고 안전 요약만 다시 읽는다', async () => {
  const { db, runs, registration, path } = await fixture();
  const original = `${JSON.stringify(report())}\n`;
  const imported = await importHistory(db, registration.project.id, path);
  expect(imported.reused).toBe(false);
  const run = runs.getRun(imported.runId)!;
  expect(run).toMatchObject({ origin: 'imported', state: 'unverifiable', verdict: 'unknown',
    profile: 'imported-atelier', plannedChecks: [], requiredChecks: [], cases: [],
    reasons: ['imported-evidence'], workerExitCode: null });
  expect(runs.listRuns(registration.project.id).runs.map(item => item.runId)).toContain(imported.runId);
  const planId = (db.prepare('SELECT plan_id FROM runs WHERE id = ?').get(imported.runId) as { plan_id: string }).plan_id;
  const plan = runs.getPlan(planId)!;
  expect(plan.plan.plannedChecks).toEqual([]);
  expect(plan.plan.requiredChecks).toEqual([]);
  expect(plan.plan.fingerprint).not.toBe(registration.plan.fingerprint);
  const history = getImportedHistory(db, imported.runId)!;
  expect(history).toMatchObject({ reportedStatus: 'passed', effectiveVerdict: 'unknown',
    omissions: { declaredCount: 1 }, summary: { passed: 1 }, originalSha256: createHash('sha256').update(original).digest('hex') });
  expect(JSON.stringify(history)).not.toMatch(/secret-token|민감한 누락 설명|과거보고서\.json/u);
  const audit = db.prepare("SELECT actor_kind, detail_json FROM audit_events WHERE entity_id = ? AND action = 'history-imported'")
    .get(imported.runId) as { actor_kind: string; detail_json: string };
  expect(audit.actor_kind).toBe('human');
  expect(audit.detail_json).not.toMatch(/secret-token|민감한 누락 설명|과거보고서\.json/u);
  expect(getImportedHistory(db, randomUUID())).toBeNull();
});

test('원래 실패와 미실행을 보존하고 같은 프로젝트의 중복 원본을 재사용한다', async () => {
  const { db, runs, registration, path } = await fixture();
  await writeFile(path, JSON.stringify(report({ status: 'failed', sourceAfter: undefined,
    steps: [{ id: 'format', status: 'failed', exitCode: 2 }, { id: 'types', status: 'not-run' }] })));
  const first = await importHistory(db, registration.project.id, path);
  const second = await importHistory(db, registration.project.id, path);
  expect(second).toEqual({ ...first, reused: true });
  expect(getImportedHistory(db, first.runId)).toMatchObject({ reportedStatus: 'failed',
    omissions: { notRunStepIds: ['types'] }, summary: { failed: 1, notRun: 1 },
    source: { afterFingerprint: null } });
  expect(runs.listRuns(registration.project.id).runs).toHaveLength(1);
  expect(db.prepare('SELECT count(*) AS count FROM plans').get()).toEqual({ count: 2 });
  expect(db.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({ count: 1 });
});

test('같은 보고서라도 다른 프로젝트에서는 별도 실행이다', async () => {
  const { files, db, runs, registration, path } = await fixture();
  const otherFolder = join(files.directory, '다른프로젝트');
  await mkdir(otherFolder);
  const other: PlanRegistration = {
    ...registration, project: { ...registration.project, id: randomUUID(), name: '다른 합성 프로젝트', repositoryIdentity: 'synthetic:other' },
    workspace: { ...registration.workspace, id: randomUUID(), realPath: otherFolder },
    catalog: { ...registration.catalog, id: randomUUID() }, plan: { ...registration.plan, id: randomUUID() },
  };
  runs.registerPlan(other);
  const first = await importHistory(db, registration.project.id, path);
  const second = await importHistory(db, other.project.id, path);
  expect(second.reused).toBe(false);
  expect(second.runId).not.toBe(first.runId);
  expect(runs.listRuns(other.project.id).runs.map(item => item.runId)).toEqual([second.runId]);
});

test('잘못된 경로, 링크, 과대 파일, 손상 인코딩과 JSON을 거절한다', async () => {
  const { files, db, registration, path } = await fixture();
  const importFile = (file: string) => importHistory(db, registration.project.id, file);
  await expect(importFile('상대경로.json')).rejects.toMatchObject({ code: 'invalid-input' });
  await expect(importFile(files.directory)).rejects.toMatchObject({ code: 'invalid-file' });
  await expect(importFile(join(files.directory, '없음.json'))).rejects.toMatchObject({ code: 'invalid-file' });
  const hardlink = join(files.directory, '하드링크.json');
  await link(path, hardlink);
  await expect(importFile(path)).rejects.toMatchObject({ code: 'invalid-file' });
  await expect(importFile(hardlink)).rejects.toMatchObject({ code: 'invalid-file' });
  const plain = join(files.directory, '일반.json');
  await writeFile(plain, JSON.stringify(report()));
  const linked = join(files.directory, '링크.json');
  try {
    await symlink(plain, linked, 'file');
    await expect(importFile(linked)).rejects.toMatchObject({ code: 'invalid-file' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
  }
  const actualFolder = join(files.directory, '실제폴더');
  await mkdir(actualFolder);
  await writeFile(join(actualFolder, '일반.json'), JSON.stringify(report()));
  const linkedFolder = join(files.directory, '연결폴더');
  try {
    await symlink(actualFolder, linkedFolder, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(importFile(join(linkedFolder, '일반.json'))).rejects.toMatchObject({ code: 'invalid-file' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
  }
  const large = join(files.directory, '과대.json');
  await writeFile(large, 'x'.repeat(1024 * 1024 + 1));
  await expect(importFile(large)).rejects.toMatchObject({ code: 'file-too-large' });
  const invalid = join(files.directory, '손상.json');
  await writeFile(invalid, Buffer.from([0xff]));
  await expect(importFile(invalid)).rejects.toMatchObject({ code: 'invalid-report' });
  await writeFile(invalid, '{');
  await expect(importFile(invalid)).rejects.toMatchObject({ code: 'invalid-report' });
  expect(db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
});

test('감사 삽입 오류는 계획과 실행까지 되돌리고 접수 중인 live 실행은 그대로 둔다', async () => {
  const { db, runs, registration, path } = await fixture();
  const admission = { projectId: registration.project.id, planId: registration.plan.id,
    requestId: randomUUID(), requestHash: 'f'.repeat(64), runId: randomUUID(), createdAt: new Date().toISOString() };
  runs.admitRun(admission);
  const before = runs.getRun(admission.runId);
  db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON audit_events WHEN NEW.action = 'history-imported' BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
  await expect(importHistory(db, registration.project.id, path)).rejects.toMatchObject({ code: 'storage-error' });
  expect(db.prepare('SELECT count(*) AS count FROM plans').get()).toEqual({ count: 1 });
  expect(db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 });
  expect(runs.getRun(admission.runId)).toEqual(before);
  expect(db.prepare('SELECT count(*) AS count FROM requests').get()).toEqual({ count: 1 });
  db.exec('DROP TRIGGER reject_import');
  const history = await importHistory(db, registration.project.id, path);
  expect(history.reused).toBe(false);
  expect(runs.getRun(admission.runId)).toEqual(before);
  expect(runs.listRuns(registration.project.id).runs).toHaveLength(2);
});
