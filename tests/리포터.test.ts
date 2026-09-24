// 구조화 리포터의 파일 경계와 실제 부모 실행기 연동을 검증한다.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiRequestSchema } from '@checkmate/contracts/api';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { readAdapterEvents } from '../packages/engine/src/이벤트읽기.js';
import { createReporter } from '../packages/engine/src/어댑터/리포터.js';
import { verifyEvidence } from '../packages/engine/src/증거검증.js';
import { readProjectSource } from '../packages/engine/src/프로젝트/원본읽기.js';
import { createProjectExecutor } from '../packages/engine/src/서비스/검사실행기.js';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
import { ProductService } from '../packages/engine/src/서비스/제품서비스.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { EvidenceStore } from '../packages/engine/src/저장/증거저장.js';
import { EventStore } from '../packages/engine/src/저장/이벤트저장.js';
import { createStoreFixture } from './저장시험자료.js';

const caseResult = { testId: 'check-1', status: 'passed' as const, requirementId: 'req-1',
  expected: '정상', observed: '정상', evidenceIds: [], severity: 'info' as const, location: null };

describe('구조화 리포터', () => {
  it('실제 파일의 크기와 해시가 부모 검증에 일치하는 이벤트를 순서대로 쓴다.', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkmate-reporter-'));
    try {
      const runId = randomUUID();
      const lines: string[] = [];
      const reporter = createReporter({ runId, evidenceDir: root, writeLine: line => lines.push(line) });
      const evidence = await reporter.evidence({ relativePath: '근거.json', content: '{"ok":true}', mime: 'application/json' });
      reporter.caseResult({ ...caseResult, evidenceIds: [evidence.id] });
      expect(evidence.sensitivity).toBe('restricted');
      expect(evidence.sha256).toBe(createHash('sha256').update(await readFile(join(root, '근거.json'))).digest('hex'));
      expect(await verifyEvidence(root, { relativePath: evidence.relativePath,
        sha256: evidence.sha256, byteLength: evidence.byteLength })).toEqual({ status: 'verified' });
      async function* chunks() { yield Buffer.from(lines.join(''), 'utf8'); }
      const events = [];
      for await (const event of readAdapterEvents(chunks(), runId)) events.push(event);
      expect(events.map(event => [event.sequence, event.type])).toEqual([[1, 'evidence-created'], [2, 'case-result']]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('상위 링크는 거절하고 Windows 짧은 실제 경로에는 증거를 쓴다.', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkmate-reporter-'));
    try {
      const destination = join(root, '실제');
      await mkdir(join(destination, '내부'), { recursive: true });
      const link = join(root, '링크');
      await symlink(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
      const input = { relativePath: '근거.txt', content: '합성', mime: 'text/plain' as const };
      const linked = createReporter({ runId: randomUUID(), evidenceDir: join(link, '내부'), writeLine: () => {} });
      await expect(linked.evidence(input)).rejects.toThrow('증거 폴더');
      if (process.platform === 'win32') {
        const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("%CHECKMATE_TEST_ROOT%") do @echo %~sI'],
          { env: { ...process.env, CHECKMATE_TEST_ROOT: root }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
        const reporter = createReporter({ runId: randomUUID(), evidenceDir: short, writeLine: () => {} });
        await reporter.evidence(input);
        expect(await readFile(join(root, '근거.txt'), 'utf8')).toBe('합성');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('상대경로 이탈, 덮어쓰기, 과대 출력과 무표시 public 자료를 거부한다.', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkmate-reporter-'));
    try {
      const reporter = createReporter({ runId: randomUUID(), evidenceDir: root, writeLine: () => {} });
      const input = { relativePath: '근거.txt', content: '합성', mime: 'text/plain' as const };
      await expect(reporter.evidence({ ...input, relativePath: '../밖.txt' })).rejects.toThrow();
      await expect(reporter.evidence({ ...input, sensitivity: 'public' })).rejects.toThrow();
      await expect(reporter.evidence({ ...input, content: '가'.repeat(50000) })).rejects.toThrow();
      await reporter.evidence(input);
      await expect(reporter.evidence(input)).rejects.toThrow();
      expect(() => reporter.caseResult({ ...caseResult, observed: '가'.repeat(5000) })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('대표 예제와 부모 검사실행기', () => {
  it('정상과 의도적 결함 프로필의 실제 근거, 위치, 수정 묶음 입력을 보존한다.', async () => {
    const fixture = await createStoreFixture();
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples', '대표검증');
    const runsRoot = join(fixture.directory, '실행');
    await mkdir(runsRoot);
    const snapshot = await readProjectSource(sourceRoot);
    const db = connectStore(fixture.dbPath);
    try {
      const runStore = new SQLiteRunStore(db);
      const evidenceStore = new EvidenceStore(db, runsRoot);
      const eventStore = new EventStore(db);
      const executor = createProjectExecutor({ runsRoot, evidenceStore, eventStore });
      const service = new RunService(runStore, executor);
      const product = new ProductService(db, evidenceStore, executor);
      const workspaceId = randomUUID();
      const catalogId = randomUUID();
      for (const profile of snapshot.source.project.profiles) {
        const plannedChecks = profile.checkIds;
        const plan: PlanRegistration = {
          project: { id: snapshot.source.project.id, name: snapshot.source.project.name,
            repositoryIdentity: snapshot.source.project.repositoryIdentity },
          workspace: { id: workspaceId, realPath: snapshot.realPath,
            pathFingerprint: createHash('sha256').update(snapshot.realPath).digest('hex') },
          catalog: { id: catalogId, contentHash: snapshot.contentHash, source: snapshot.source },
          plan: { id: randomUUID(), fingerprint: createHash('sha256').update(profile.id).digest('hex'),
            sourceHash: snapshot.sourceHash, profile: profile.id, plannedChecks,
            requiredChecks: plannedChecks }, createdAt: new Date().toISOString(),
        };
        runStore.registerPlan(plan);
        const started = service.start({ projectId: plan.project.id, planId: plan.plan.id, requestId: randomUUID() });
        const result = await service.wait(started.runId);
        const evidence = evidenceStore.list(started.runId);
        const events = eventStore.list(started.runId);
        expect(result.environmentVerified).toBe(true);
        expect(result.evidenceVerified).toBe(true);
        expect(result.cleanupVerified).toBe(true);
        expect(result.cases).toHaveLength(5);
        expect(evidence.filter(item => item.relativePath === '화면.png')).toHaveLength(1);
        expect(evidence.filter(item => item.relativePath === '디자인위치.json' && item.sensitivity === 'public')).toHaveLength(1);
        expect(events.filter(item => item.type === 'case-result')).toHaveLength(5);
        for (const item of evidence) expect((await evidenceStore.inspect(started.runId, item.id)).integrity).toBe('verified');
        const design = JSON.parse(await readFile(join(runsRoot, started.runId, '디자인위치.json'), 'utf8')) as {
          kind: string; screenshotEvidenceId: string; viewport: { width: number }; findings: { selector: string; boundingBox: { x: number; width: number } }[] };
        expect(design.kind).toBe('checkmate-design');
        expect(design.screenshotEvidenceId).toBe(evidence.find(item => item.relativePath === '화면.png')?.id);
        expect(design.viewport.width).toBe(400);
        expect(design.findings[0]?.selector).toBe('#decor');
        const response = await product.handle(apiRequestSchema.parse({ apiVersion: 1, requestId: randomUUID(),
          method: 'result', input: { runId: started.runId, section: 'requirements' } }), 'human');
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error(response.error.message);
        const requirements = response.data as { items: { status: string; selectedChecks: string[] }[] };
        expect(requirements.items.filter(item => item.selectedChecks.length > 0)).toHaveLength(5);
        if (profile.id === 'normal') {
          expect(result.verdict).toBe('passed');
          expect(result.cases.every(item => item.status === 'passed')).toBe(true);
          expect(requirements.items.filter(item => item.selectedChecks.length > 0).every(item => item.status === 'passed')).toBe(true);
        } else {
          expect(result.verdict).toBe('failed');
          expect(result.cases.filter(item => item.status === 'failed')).toHaveLength(5);
          expect(design.findings[0]!.boundingBox.x + design.findings[0]!.boundingBox.width).toBeGreaterThan(400);
          const designCase = result.cases.find(item => item.testId === 'defect-design');
          expect(designCase?.location?.file).toBe('가상앱.mjs');
          expect(designCase?.observed).toContain('위치');
          expect(requirements.items.filter(item => item.selectedChecks.length > 0).every(item => item.status === 'failed')).toBe(true);
          const repair = await product.handle(apiRequestSchema.parse({ apiVersion: 1, requestId: randomUUID(),
            method: 'result', input: { runId: started.runId, section: 'repair-bundle' } }), 'human');
          expect(repair.ok).toBe(true);
          if (!repair.ok) throw new Error(repair.error.message);
          const bundle = repair.data as { items: { testId: string; location: { file: string } | null }[] };
          expect(bundle.items.find(item => item.testId === 'defect-design')?.location?.file).toBe('가상앱.mjs');
        }
      }
    } finally { db.close(); await fixture.cleanup(); }
  }, 120_000);
});
