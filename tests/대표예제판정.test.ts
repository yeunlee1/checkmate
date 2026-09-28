// 대표 예제의 실제 브라우저 관측 실패가 결과와 최종 판정에 전파되는지 확인한다.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assessResult, type RunResult } from '@checkmate/contracts';
import { completeResult } from './결과자료.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples', '대표검증');

describe('대표 예제 판정', () => {
  it('브라우저 관측 실패를 unknown으로 남기고 필수 검사를 통과시키지 않는다.', async () => {
    const evidenceDir = await mkdtemp(join(tmpdir(), 'checkmate-example-'));
    try {
      const output = spawnSync(process.execPath, [join(sourceRoot, 'tests', '검사.mjs'), 'normal'], {
        cwd: sourceRoot, encoding: 'utf8', timeout: 40_000,
        env: { ...process.env, CHECKMATE_RUN_ID: randomUUID(), CHECKMATE_EVIDENCE_DIR: evidenceDir,
          CHECKMATE_TEST_OBSERVATION_FAILURE: '1' },
      });
      expect(output.status, output.stderr || String(output.error)).toBe(0);
      const events = output.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line) as {
        type: string; payload: RunResult['cases'][number];
      });
      const cases = events.filter(event => event.type === 'case-result').map(event => event.payload);
      expect(cases).toHaveLength(5);
      expect(cases.find(item => item.testId === 'normal-workflow')?.status).toBe('passed');
      expect(cases.find(item => item.testId === 'normal-detection')?.status).toBe('passed');
      for (const kind of ['exposure', 'design']) {
        const item = cases.find(entry => entry.testId === `normal-${kind}`);
        expect(item).toMatchObject({ status: 'unknown', location: null });
        expect(item?.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(JSON.parse(await readFile(join(evidenceDir, '역할노출.json'), 'utf8')).status).toBe('unverified');
      expect(JSON.parse(await readFile(join(evidenceDir, '디자인위치.json'), 'utf8')).status).toBe('unverified');
      const assessed = assessResult(completeResult({
        plannedChecks: cases.map(item => item.testId), requiredChecks: cases.map(item => item.testId), cases,
      }));
      expect(assessed.verdict).toBe('unknown');
      expect(assessed.reasons).toContain('required-checks-incomplete');
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
    }
  }, 45_000);
});
