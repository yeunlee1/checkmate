// 합성 SQLite에서 프로젝트 카탈로그와 계획 및 승인 저장의 경계를 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { databaseResourceKinds, databaseResourceNames, type NativePostgresProvider } from '@checkmate/contracts/resources';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ProjectSnapshot, ProjectSource } from '@checkmate/contracts/project';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { ProjectStore } from '../packages/engine/src/저장/프로젝트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshot(realPath: string, source: ProjectSource, sourceHash = 'd'.repeat(64)): ProjectSnapshot {
  return { realPath, source, contentHash: hash(canonical(source)), sourceHash };
}

async function fixture() {
  const files = await createStoreFixture();
  const db = connectStore(files.dbPath);
  cleanup.push(async () => { db.close(); await files.cleanup(); });
  const source: ProjectSource = {
    project: { schemaVersion: 1, id: randomUUID(), name: '합성 프로젝트', repositoryIdentity: 'local:one',
      commands: [{ id: 'run', title: '검사 명령', runtime: 'node', entry: 'tests/run.mjs', args: [],
        timeoutMs: 1000, env: {}, writes: ['output/result.json'], resultFormat: 'ndjson' }],
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-1', 'check-2'] }] },
    requirements: [{ id: 'req-1', title: '요구사항', description: '합성 시험용 요구사항이다.' }],
    checks: [
      { id: 'check-1', title: '필수 검사', requirementId: 'req-1', commandId: 'run', required: true,
        kind: 'logic', expected: '성공', codePaths: ['src/main.ts'] },
      { id: 'check-2', title: '선택 검사', requirementId: 'req-1', commandId: 'run', required: false,
        kind: 'design', expected: '표시', codePaths: [] },
    ],
  };
  return { files, db, source, store: new ProjectStore(db), initial: snapshot(files.directory, source) };
}

test('선택한 여섯 DB의 생성과 쓰기 및 사용 조건을 승인 계획에 표시한다', async () => {
  const { source, files, store } = await fixture();
  source.project.commands[0]!.resources = [...databaseResourceKinds];
  const input = snapshot(files.directory, source);
  store.register(input);
  const plan = store.inspect(input, 'quick');
  for (const name of Object.values(databaseResourceNames)) expect(plan.resourceEffects.join('\n')).toContain(name);
  expect(plan.resourceEffects.join('\n')).toContain('EULA');
  expect(plan.resourceEffects.join('\n')).toContain('Oracle Database Free');
  expect(plan.needsApproval).toBe(true);
  store.approve(plan.planId, plan.fingerprint);
  expect(store.inspect(input, 'quick').needsApproval).toBe(false);
});

test('등록 재사용과 ID, 경로, 저장소 식별자 및 이름 충돌을 구분한다', async () => {
  const { files, db, source, store, initial } = await fixture();
  const info = store.register(initial);
  expect(info).toMatchObject({ id: source.project.id, activeCatalogHash: initial.contentHash,
    profiles: [{ id: 'quick', title: '빠른 검사' }] });
  expect(store.register(initial)).toEqual(info);
  expect(store.get(source.project.id)).toEqual(info);
  expect(store.list()).toEqual([info]);
  const otherPath = join(files.directory, '다른경로');
  await mkdir(otherPath);
  const other = store.register(snapshot(otherPath, source));
  expect(other.workspaceId).not.toBe(info.workspaceId);
  expect(store.get(source.project.id, info.workspaceId)).toEqual(info);
  expect(store.get(source.project.id, other.workspaceId)).toEqual(other);
  expect(() => store.get(source.project.id)).toThrowError(expect.objectContaining({ code: 'workspace-required' }));
  expect(() => store.register(snapshot(otherPath, { ...source,
    project: { ...source.project, id: randomUUID() } })))
    .toThrowError(expect.objectContaining({ code: 'project-conflict' }));
  expect(() => store.register(snapshot(files.directory, { ...source,
    project: { ...source.project, id: randomUUID(), repositoryIdentity: 'local:other' } })))
    .toThrowError(expect.objectContaining({ code: 'project-conflict' }));
  expect(() => store.register(snapshot(files.directory, { ...source,
    project: { ...source.project, name: '무단 변경' } })))
    .toThrowError(expect.objectContaining({ code: 'catalog-stale' }));
  expect((db.prepare('SELECT count(*) AS count FROM projects').get() as { count: number }).count).toBe(1);
});

test('초기 원본과 요구사항 연결을 저장하고 실패한 등록을 모두 되돌린다', async () => {
  const { db, store, initial } = await fixture();
  db.exec("CREATE TRIGGER reject_check BEFORE INSERT ON definitions WHEN NEW.kind = 'check' BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
  expect(() => store.register(initial)).toThrowError(expect.objectContaining({ code: 'storage-error' }));
  expect((db.prepare('SELECT count(*) AS count FROM projects').get() as { count: number }).count).toBe(0);
  expect((db.prepare('SELECT count(*) AS count FROM catalogs').get() as { count: number }).count).toBe(0);
  db.exec('DROP TRIGGER reject_check');
  store.register(initial);
  expect((db.prepare('SELECT count(*) AS count FROM definitions').get() as { count: number }).count).toBe(4);
  expect((db.prepare('SELECT count(*) AS count FROM requirement_checks').get() as { count: number }).count).toBe(2);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

test('계획을 재사용하고 정확한 지문 승인만 보존하며 소스 변경은 새 승인을 요구한다', async () => {
  const { db, source, store, initial } = await fixture();
  store.register(initial);
  const first = store.inspect(initial, 'quick');
  expect(first).toMatchObject({ projectId: source.project.id, needsApproval: true,
    checks: [{ id: 'check-1', title: '필수 검사', required: true },
      { id: 'check-2', title: '선택 검사', required: false }], writes: ['output/result.json'] });
  expect(first.commands).toHaveLength(1);
  expect(store.inspect(initial, 'quick').planId).toBe(first.planId);
  expect(store.hasApproval(first.planId)).toBe(false);
  expect(() => store.approve(first.planId, 'f'.repeat(64))).toThrowError(expect.objectContaining({ code: 'plan-stale' }));
  const approval = store.approve(first.planId, first.fingerprint);
  expect(store.approve(first.planId, first.fingerprint)).toEqual(approval);
  expect(store.hasApproval(first.planId)).toBe(true);
  expect(store.inspect(initial, 'quick').needsApproval).toBe(false);
  const changed = snapshot(initial.realPath, source, 'e'.repeat(64));
  const second = store.inspect(changed, 'quick');
  expect(second.planId).not.toBe(first.planId);
  expect(second.needsApproval).toBe(true);
  expect(store.hasApproval(second.planId)).toBe(false);
  expect((db.prepare('SELECT count(*) AS count FROM approvals').get() as { count: number }).count).toBe(1);
});

test('프로필의 검사 순서대로 명령을 중복 없이 선택한다', async () => {
  const { files, source, store } = await fixture();
  const secondCommand = { ...source.project.commands[0]!, id: 'other', title: '두 번째 명령',
    writes: ['output/other.json', 'output/result.json'] };
  const ordered: ProjectSource = { ...source,
    project: { ...source.project, commands: [source.project.commands[0]!, secondCommand],
      profiles: [{ id: 'quick', title: '빠른 검사', checkIds: ['check-2', 'check-1'] }] },
    checks: [source.checks[0]!, { ...source.checks[1]!, commandId: 'other' }] };
  const input = snapshot(files.directory, ordered);
  store.register(input);
  const plan = store.inspect(input, 'quick');
  expect(plan.commands.map((item) => item.id)).toEqual(['other', 'run']);
  expect(plan.writes).toEqual(['output/other.json', 'output/result.json']);
  expect(plan.checks.map((item) => item.id)).toEqual(['check-2', 'check-1']);
});

test('후보 카탈로그는 활성 버전을 유지하고 승인된 전환 뒤 이전 계획 승인을 무효화한다', async () => {
  const { db, source, store, initial } = await fixture();
  store.register(initial);
  const plan = store.inspect(initial, 'quick');
  store.approve(plan.planId, plan.fingerprint);
  const revised: ProjectSource = { ...source, checks: source.checks.map((item) => item.id === 'check-1'
    ? { ...item, required: false, expected: '변경됨', codePaths: ['src/changed.ts'] } : { ...item, required: true }) };
  const candidate = snapshot(initial.realPath, revised);
  const preview = store.sync(candidate);
  expect(preview).toMatchObject({ active: false, added: [], removed: [], changed: ['check-1', 'check-2'],
    weakened: ['check-1'] });
  expect(store.get(source.project.id).activeCatalogHash).toBe(initial.contentHash);
  expect(store.hasApproval(plan.planId)).toBe(true);
  expect(() => store.inspect(candidate, 'quick')).toThrowError(expect.objectContaining({ code: 'catalog-stale' }));
  expect(store.sync(candidate, true).active).toBe(true);
  expect(store.get(source.project.id).activeCatalogHash).toBe(candidate.contentHash);
  expect(store.hasApproval(plan.planId)).toBe(false);
  expect(() => store.approve(plan.planId, plan.fingerprint)).toThrowError(expect.objectContaining({ code: 'plan-stale' }));
  const newPlan = store.inspect(candidate, 'quick');
  expect(newPlan.needsApproval).toBe(true);
  expect((db.prepare('SELECT count(*) AS count FROM audit_events').get() as { count: number }).count).toBe(2);
});

test('활성 전환 감사 기록 실패는 후보 삽입과 활성 변경을 함께 되돌린다', async () => {
  const { db, source, store, initial } = await fixture();
  store.register(initial);
  const candidate = snapshot(initial.realPath, { ...source,
    checks: source.checks.map((item) => item.id === 'check-1' ? { ...item, expected: '새 기대값' } : item) });
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
  expect(() => store.sync(candidate, true)).toThrowError(expect.objectContaining({ code: 'storage-error' }));
  expect(store.get(source.project.id).activeCatalogHash).toBe(initial.contentHash);
  expect((db.prepare('SELECT count(*) AS count FROM catalogs').get() as { count: number }).count).toBe(1);
  db.exec('DROP TRIGGER reject_audit');
  expect(store.sync(candidate, true).active).toBe(true);
});

test('등록 입력과 저장 JSON 손상을 거절하고 만료 또는 철회된 승인을 제외한다', async () => {
  const { db, source, store, initial } = await fixture();
  expect(() => store.register({ ...initial, contentHash: '0'.repeat(64) }))
    .toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  store.register(initial);
  const plan = store.inspect(initial, 'quick');
  const approval = store.approve(plan.planId, plan.fingerprint);
  db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', approval.approvalId);
  expect(store.hasApproval(plan.planId)).toBe(false);
  const renewed = store.approve(plan.planId, plan.fingerprint);
  expect(renewed.approvalId).not.toBe(approval.approvalId);
  db.prepare('UPDATE approvals SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), renewed.approvalId);
  expect(store.hasApproval(plan.planId)).toBe(false);
  const catalogId = (db.prepare('SELECT active_catalog_id FROM projects WHERE id = ?').get(source.project.id) as
    { active_catalog_id: string }).active_catalog_id;
  db.prepare('UPDATE catalogs SET source_json = ? WHERE id = ?').run('{}', catalogId);
  expect(() => store.get(source.project.id)).toThrowError(expect.objectContaining({ code: 'storage-error' }));
});

function registeredNativeProvider(): NativePostgresProvider {
  const binaryRoot = realpathSync.native('C:/Users/ADMIN/AppData/Local/AtelierNote/PostgreSQL17/pgsql/bin');
  return { mode: 'native', binaryRoot, postgresVersion: '17.11', sha256: Object.fromEntries(
    ['initdb', 'pg_ctl', 'postgres'].map(name => [name, createHash('sha256').update(readFileSync(join(binaryRoot, `${name}.exe`))).digest('hex')])) as NativePostgresProvider['sha256'] };
}

test('native 계획과 승인에는 등록 binary와 정확한 전용 root 및 생성 정리 효과가 고정된다', async () => {
  const { db, source, files } = await fixture();
  const resourceRoot = join(files.directory, '전용자원');
  await mkdir(resourceRoot);
  const root = realpathSync.native(resourceRoot);
  const provider = registeredNativeProvider();
  const store = new ProjectStore(db, root);
  const native = { ...source, project: { ...source.project, commands: source.project.commands.map(command =>
    ({ ...command, resources: ['postgres-test'] as ['postgres-test'], resourceProvider: provider })) } };
  const input = snapshot(files.directory, native);
  store.register(input);
  const plan = store.inspect(input, 'quick');
  expect(plan.nativeResourceRoot).toBe(root);
  expect(plan.commands[0]?.resourceProvider).toEqual(provider);
  expect(plan.resourceEffects.join('\n')).toContain(root);
  expect(plan.resourceEffects.join('\n')).toContain(provider.sha256.postgres);
  const stored = JSON.parse((db.prepare('SELECT plan_json FROM plans WHERE id=?').get(plan.planId) as { plan_json: string }).plan_json);
  expect(stored.plan.nativeResourceRoot).toBe(root);
  store.approve(plan.planId, plan.fingerprint);
  const scope = JSON.parse((db.prepare('SELECT scope_json FROM approvals WHERE plan_id=?').get(plan.planId) as { scope_json: string }).scope_json);
  expect(scope.nativeResourceRoot).toBe(root);
  expect(scope.commands[0].resourceProvider).toEqual(provider);
  const otherRoot = join(files.directory, '다른전용자원');
  await mkdir(otherRoot);
  const changedStore = new ProjectStore(db, realpathSync.native(otherRoot));
  expect(() => changedStore.hasApproval(plan.planId)).toThrowError(expect.objectContaining({ code: 'plan-stale' }));
  expect(changedStore.inspect(input, 'quick').fingerprint).not.toBe(plan.fingerprint);
});

test('native와 Docker 혼합 선택은 inspect에서 거절하고 서로 다른 native hash도 등록에서 거절한다', async () => {
  const { db, source, files } = await fixture();
  const resourceRoot = join(files.directory, '전용자원');
  await mkdir(resourceRoot);
  const provider = registeredNativeProvider();
  const store = new ProjectStore(db, realpathSync.native(resourceRoot));
  const commands = [
    { ...source.project.commands[0]!, resources: ['postgres-test'] as ['postgres-test'], resourceProvider: provider },
    { ...source.project.commands[0]!, id: 'other', resources: ['postgres-test'] as ['postgres-test'] },
  ];
  const mixed = { ...source, project: { ...source.project, commands }, checks: source.checks.map((check, index) => ({ ...check, commandId: index === 0 ? 'run' : 'other' })) };
  const input = snapshot(files.directory, mixed);
  store.register(input);
  expect(() => store.inspect(input, 'quick')).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
  const changed = { ...mixed, project: { ...mixed.project, commands: commands.map(command => ({ ...command,
    resourceProvider: { ...provider, sha256: { ...provider.sha256, postgres: '0'.repeat(64) } } })) } };
  expect(() => store.sync(snapshot(files.directory, changed), true)).toThrowError(expect.objectContaining({ code: 'invalid-input' }));
});

test('기존 Docker catalog plan 승인 JSON은 native 지원을 읽어도 바이트와 지문이 동일하다', async () => {
  const { db, source, store, initial } = await fixture();
  store.register(initial);
  const plan = store.inspect(initial, 'quick');
  store.approve(plan.planId, plan.fingerprint);
  const catalog = db.prepare('SELECT source_json FROM catalogs WHERE project_id=?').get(source.project.id);
  const originalPlan = db.prepare('SELECT plan_json,fingerprint FROM plans WHERE id=?').get(plan.planId);
  const originalScope = db.prepare('SELECT scope_json FROM approvals WHERE plan_id=?').get(plan.planId);
  const resourceRoot = join(initial.realPath, '전용자원');
  await mkdir(resourceRoot);
  const nativeStore = new ProjectStore(db, realpathSync.native(resourceRoot));
  expect(nativeStore.inspect(initial, 'quick').fingerprint).toBe(plan.fingerprint);
  expect(nativeStore.hasApproval(plan.planId)).toBe(true);
  expect(db.prepare('SELECT source_json FROM catalogs WHERE project_id=?').get(source.project.id)).toEqual(catalog);
  expect(db.prepare('SELECT plan_json,fingerprint FROM plans WHERE id=?').get(plan.planId)).toEqual(originalPlan);
  expect(db.prepare('SELECT scope_json FROM approvals WHERE plan_id=?').get(plan.planId)).toEqual(originalScope);
});
