// 승인한 제품 실행에서 실제 Stryker 검출력과 증거 및 정리 경계를 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequestSchema } from '@checkmate/contracts/api';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples', '검출력검증');
const projectId = 'e2e2c580-475a-4cb5-94e7-1e9a87e0794e';
type MutationEvidence = { status: string; findings: { file: string; status: string;
  location: { start: { line: number } } }[];
  counts: { Killed: number; Survived: number; NoCoverage: number; Timeout: number };
  score: { detected: number; denominator: number; percent: number } | null };

it('승인한 두 프로필의 실제 변이 실행을 통과와 실패로 확정하고 근거를 보존한다', async () => {
  const fixture = await createStoreFixture();
  const runsRoot = join(fixture.directory, '실행');
  const runtime = join(root, '.runtime');
  const foreignId = randomUUID();
  const foreign = join(runtime, foreignId);
  await mkdir(runsRoot);
  await mkdir(runtime, { recursive: true });
  await mkdir(foreign);
  await writeFile(join(foreign, '다른작업.txt'), '유지', { flag: 'wx' });
  const beforeEntries = (await readdir(runtime)).sort();
  const before = await readProjectSource(root);
  const db = connectStore(fixture.dbPath);
  try {
    const evidenceStore = new EvidenceStore(db, runsRoot);
    const product = new ProductService(db, evidenceStore,
      createProjectExecutor({ runsRoot, evidenceStore, eventStore: new EventStore(db) }));
    const call = async (method: string, input: Record<string, unknown>) => {
      const response = await product.handle(apiRequestSchema.parse({ apiVersion: 1,
        requestId: randomUUID(), method, input }), 'human');
      if (!response.ok) throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
      return response.data as any;
    };
    expect((await call('register', { path: root })).id).toBe(projectId);
    const outcomes: MutationEvidence[] = [];
    for (const profile of ['strong', 'weak']) {
      const plan = await call('inspect', { projectId, profile });
      expect(plan.writes).toEqual(['.runtime']);
      await call('approve', { planId: plan.planId, fingerprint: plan.fingerprint });
      const accepted = await call('start', { projectId, planId: plan.planId });
      const result = await product.execution.wait(accepted.runId);
      expect(result).toMatchObject({ finalized: true, state: 'finished', workerExitCode: 0,
        environmentVerified: true, evidenceVerified: true, cleanupVerified: true,
        verdict: profile === 'strong' ? 'passed' : 'failed' });
      expect(result.sourceBefore).toBe(before.sourceHash);
      expect(result.sourceAfter).toBe(before.sourceHash);
      const summary = await call('result', { runId: accepted.runId, section: 'summary' });
      expect(summary).toMatchObject({ integrity: 'verified', verdict: result.verdict });
      const cases = await call('result', { runId: accepted.runId, section: 'cases' });
      expect(cases.items).toHaveLength(1);
      expect(cases.items[0]).toMatchObject({ testId: `${profile}-mutation`,
        status: profile === 'strong' ? 'passed' : 'failed',
        expected: '모든 권한 함수 변이가 검출되고 생존 변이가 0개다.' });
      expect(cases.items[0].observed).toContain('점수');
      const files = evidenceStore.list(accepted.runId);
      const normalized = files.find((item) => item.relativePath === `변이보고서-${profile}.json`);
      const log = files.find((item) => item.relativePath === `Stryker-${profile}.txt`);
      expect(normalized?.sensitivity).toBe('public');
      expect(log?.sensitivity).toBe('restricted');
      expect(cases.items[0].evidenceIds).toContain(normalized?.id);
      for (const file of files) {
        expect((await evidenceStore.inspect(accepted.runId, file.id)).integrity).toBe('verified');
        const bytes = await readFile(join(runsRoot, accepted.runId, file.relativePath));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      }
      const report = JSON.parse(await readFile(join(runsRoot, accepted.runId, normalized!.relativePath), 'utf8')) as MutationEvidence;
      expect(JSON.stringify(report)).not.toMatch(/"source"|"replacement"|"statusReason"/u);
      expect(report.score?.denominator).toBeGreaterThan(0);
      outcomes.push(report);
      if (profile === 'strong') {
        expect(report.status).toBe('passed');
        expect(report.counts.Survived).toBe(0);
        expect(report.counts.NoCoverage).toBe(0);
        expect(report.counts.Timeout).toBe(0);
      } else {
        expect(report.status).toBe('failed');
        expect(report.counts.Survived).toBeGreaterThan(0);
        const survivor = report.findings.find((item) => item.status === 'Survived');
        expect(survivor?.file).toBe('권한.mjs');
        const bundle = await call('result', { runId: accepted.runId, section: 'repair-bundle' });
        expect(bundle.items).toHaveLength(1);
        expect(bundle.items[0]).toMatchObject({ testId: 'weak-mutation',
          expected: '모든 권한 함수 변이가 검출되고 생존 변이가 0개다.',
          location: { file: '권한.mjs', line: survivor?.location.start.line },
          codePaths: ['권한.mjs', 'tests/약한.test.mjs', 'tests/검사.mjs'] });
        expect(bundle.items[0].observed).toContain(`Survived ${report.counts.Survived}`);
      }
      expect((await readdir(runtime)).sort()).toEqual(beforeEntries);
    }
    expect(outcomes[0]!.counts.Killed).toBeGreaterThan(outcomes[1]!.counts.Killed);
    expect(outcomes[0]!.score!.percent).toBeGreaterThan(outcomes[1]!.score!.percent);
    expect((await readProjectSource(root)).sourceHash).toBe(before.sourceHash);
    expect(await readFile(join(foreign, '다른작업.txt'), 'utf8')).toBe('유지');
  } finally {
    db.close();
    const marker = join(foreign, '다른작업.txt');
    const info = await lstat(foreign);
    if (dirname(foreign) !== runtime || !info.isDirectory() || info.isSymbolicLink()
      || await readFile(marker, 'utf8') !== '유지') throw new Error('시험 임시 폴더 소유권이 다릅니다.');
    await rm(foreign, { recursive: true });
    await fixture.cleanup();
  }
}, 180_000);
