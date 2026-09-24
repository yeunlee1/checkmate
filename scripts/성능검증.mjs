// 합성 실행 일만 건과 개별 결과 십만 건을 저장해 로컬 통신 조회의 지연과 요약 크기를 측정한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { dataPaths, prepareDataPaths } from '../packages/engine/dist/연결/개인경로.js';
import { requestLocal } from '../packages/engine/dist/연결/로컬통신.js';
import { connectStore } from '../packages/engine/dist/저장/연결.js';
import { EvidenceStore } from '../packages/engine/dist/저장/증거저장.js';
import { ProductService } from '../packages/engine/dist/서비스/제품서비스.js';
import { startLocalService } from '../packages/engine/dist/서비스/상주서비스.js';

const root = resolve('.runtime/검증/성능', randomUUID());
const project = join(root, '합성 프로젝트');
const paths = dataPaths(join(root, '관리 자료'));
const projectId = randomUUID();
const checks = Array.from({ length: 10 }, (_, index) => ({ id: `check-${index}`, title: `합성 검사 ${index}`,
  requirementId: 'req-1', commandId: 'quick', required: true, kind: 'logic', expected: '합성 기대값', codePaths: ['검사.mjs'] }));
await mkdir(join(project, 'checkmate'), { recursive: true });
await writeFile(join(project, '검사.mjs'), '// 성능 자료에서 실행하지 않는 합성 진입점이다.\n');
await writeFile(join(project, 'checkmate', '프로젝트.json'), JSON.stringify({ schemaVersion: 1, id: projectId,
  name: '성능 측정용 합성 자료', repositoryIdentity: 'synthetic:performance',
  commands: [{ id: 'quick', title: '실행하지 않는 합성 명령', runtime: 'node', entry: '검사.mjs', args: [], env: {},
    writes: [], timeoutMs: 5000, resultFormat: 'ndjson' }], profiles: [{ id: 'quick', title: '합성 자료', checkIds: checks.map(item => item.id) }] }));
await writeFile(join(project, 'checkmate', '요구사항.json'), JSON.stringify([{ id: 'req-1', title: '성능 측정용 요구사항', description: '실제 업무 통과 근거로 사용하지 않는다.' }]));
await writeFile(join(project, 'checkmate', '검사항목.json'), JSON.stringify(checks));
await prepareDataPaths(paths);
const db = connectStore(join(paths.state, 'checkmate.sqlite'));
let latestRunId;
let seedMs;
try {
  const product = new ProductService(db, new EvidenceStore(db, paths.runs), async () => { throw new Error('성능 시험은 명령을 실행하지 않습니다.'); }, paths);
  const call = async (method, input) => {
    const result = await product.handle({ apiVersion: 1, requestId: randomUUID(), method, input }, 'human');
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  };
  await call('register', { path: project });
  const plan = await call('inspect', { projectId, profile: 'quick' });
  const started = performance.now();
  db.transaction(() => {
    for (let index = 0; index < 10000; index++) {
      const runId = randomUUID();
      product.runs.admitRun({ projectId, planId: plan.planId, requestId: randomUUID(), requestHash: 'a'.repeat(64), runId,
        createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString() });
      const running = product.runs.markRunning(runId);
      product.runs.finalizeRun({ ...running, state: 'finished', verdict: 'passed', sourceAfter: running.sourceBefore,
        workerExitCode: 0, environmentVerified: true, evidenceVerified: true, cleanupVerified: true, finalized: true, reasons: [],
        cases: checks.map(item => ({ testId: item.id, requirementId: item.requirementId, status: 'passed', expected: item.expected,
          observed: '조회 성능을 재현하기 위해 생성한 합성 관측입니다.', severity: 'info', location: null, evidenceIds: [] })) });
      latestRunId = runId;
    }
  })();
  seedMs = performance.now() - started;
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 10000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM case_results').get().n, 100000);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
} finally { db.close(); }

const service = await startLocalService(paths.root);
const report = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  synthetic: true, passed: false, runs: 10000, cases: 100000, seedMs,
  environment: { platform: process.platform, release: release(), node: process.versions.node,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: Math.round(totalmem() / 1024 ** 3) },
  scope: '준비된 서비스와 인증된 로컬 통신. 각 실행은 결과 10개, 증거 파일은 없으며 다른 하드웨어 및 GUI 렌더 성능은 포함하지 않는다.', measurements: [] };
try {
  for (const [method, input] of [['history', { projectId, limit: 10 }], ['status', { runId: latestRunId }],
    ['result', { runId: latestRunId, section: 'summary' }]]) {
    const timings = [];
    let maxBytes = 0;
    for (let index = 0; index < 110; index++) {
      const start = performance.now();
      const result = await requestLocal(paths, { apiVersion: 1, requestId: randomUUID(), method, input });
      const ms = performance.now() - start;
      assert.equal(result.ok, true, JSON.stringify(result));
      if (method === 'history') {
        assert.equal(result.data.items.length, 10);
        assert.equal(result.data.items[0].runId, latestRunId);
        assert.ok(result.data.nextCursor);
      } else { assert.equal(result.data.runId, latestRunId); assert.equal(result.data.finalized, true); }
      if (index >= 10) {
        timings.push(ms);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(result), 'utf8'));
      }
    }
    timings.sort((a, b) => a - b);
    const measurement = { method, samples: timings.length, warmup: 10,
      p50Ms: timings[49], p95Ms: timings[94], maxMs: timings.at(-1), maxBytes };
    report.measurements.push(measurement);
    assert.ok(measurement.p95Ms <= 500, `${method} p95가 500ms를 넘었습니다.`);
    if (method !== 'history') assert.ok(maxBytes <= 8192, `${method} 요약이 8KiB를 넘었습니다.`);
  }
  report.passed = true;
} finally {
  await service.close();
  await writeFile(join(root, '성능결과.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(root, '성능결과.json'), ...report }));
}
