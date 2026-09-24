// 실제 자식 실행과 이벤트 및 증거 검증을 SQLite 최종 결과까지 연결한다.
import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assessResult, resultInputSchema, type RunResult } from '@checkmate/contracts';
import type { PlanRegistration } from '@checkmate/contracts/runs';
import { readAdapterEvents } from '../packages/engine/src/이벤트읽기.js';
import { verifyEvidence } from '../packages/engine/src/증거검증.js';
import { runRegisteredCommand } from '../packages/engine/src/작업실행.js';
import { connectStore } from '../packages/engine/src/저장/연결.js';
import { SQLiteRunStore } from '../packages/engine/src/저장/실행저장.js';
import { RunService } from '../packages/engine/src/서비스/실행서비스.js';
import { createStoreFixture } from './저장시험자료.js';

const script = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const [root, runId, exitCode] = process.argv.slice(1);
const content = Buffer.from(String(2 + 2));
fs.writeFileSync(path.join(root, '계산결과.txt'), content);
const event = (sequence, type, payload) => JSON.stringify({
  protocolVersion: 1, runId, sequence, type, time: new Date().toISOString(), payload
});
fs.writeFileSync(path.join(root, '이벤트.ndjson'), [
  event(1, 'case-result', {
    testId: 'addition', status: content.toString() === '4' ? 'passed' : 'failed',
    requirementId: null, expected: '4', observed: content.toString(),
    evidenceIds: ['calculation'], severity: 'error', location: null
  }),
  event(2, 'evidence-created', {
    relativePath: '계산결과.txt', sha256: crypto.createHash('sha256').update(content).digest('hex'),
    byteLength: content.length
  }),
  event(3, 'worker-finished', { exitCode: 0, nodeVersion: process.version })
].join('\n') + '\n');
process.exit(Number(exitCode));
`;

const fingerprint = createHash('sha256').update(script).digest('hex');

async function scenario(exitCode: number, tamper: boolean) {
  const fixture = await createStoreFixture();
  const root = join(dirname(fixture.dbPath), '증거');
  await mkdir(root);
  let db = connectStore(fixture.dbPath);
  try {
    const store = new SQLiteRunStore(db);
    const registration: PlanRegistration = {
      project: { id: randomUUID(), name: '통합 시험', repositoryIdentity: 'synthetic:integration' },
      workspace: { id: randomUUID(), realPath: dirname(fixture.dbPath), pathFingerprint: fingerprint },
      catalog: { id: randomUUID(), contentHash: fingerprint, source: { fixture: 'addition' } },
      plan: {
        id: randomUUID(), fingerprint, sourceHash: fingerprint, profile: 'quick',
        plannedChecks: ['addition'], requiredChecks: ['addition'],
      },
      createdAt: new Date().toISOString(),
    };
    store.registerPlan(registration);
    let executions = 0;
    let executorError: unknown;
    const executor = async (_plan: PlanRegistration, initial: RunResult, signal: AbortSignal) => {
      executions += 1;
      const processResult = await runRegisteredCommand(new Map([['fixture', {
        executable: process.execPath, args: ['-e', script, root, initial.runId, String(exitCode)],
        cwd: root, env: {},
      }]]), 'fixture', { timeoutMs: 5000, signal });
      expect(processResult).toMatchObject({ status: 'exited', exitCode, terminationConfirmed: true });
      if (tamper) await writeFile(join(root, '계산결과.txt'), '5');
      const cases: RunResult['cases'] = [];
      let evidenceVerified = false;
      let environmentVerified = false;
      for await (const event of readAdapterEvents(createReadStream(join(root, '이벤트.ndjson')), initial.runId)) {
        if (event.type === 'case-result') cases.push(resultInputSchema.shape.cases.element.parse(event.payload));
        if (event.type === 'evidence-created') {
          evidenceVerified = (await verifyEvidence(root, event.payload)).status === 'verified';
        }
        if (event.type === 'worker-finished') environmentVerified = event.payload.nodeVersion === process.version;
      }
      const result: RunResult = {
        ...initial, state: processResult.status === 'exited' ? 'finished' : 'unverifiable',
        workerExitCode: processResult.exitCode, sourceAfter: fingerprint,
        environmentVerified, evidenceVerified, cleanupVerified: processResult.terminationConfirmed,
        cases, finalized: false,
      };
      return { ...result, ...assessResult(result) };
    };
    const service = new RunService(store, (...args) => executor(...args).catch((error: unknown) => {
      executorError = error;
      throw error;
    }));
    const request = { projectId: registration.project.id, planId: registration.plan.id, requestId: randomUUID() };
    const accepted = await service.start(request);
    const repeated = await service.start(request);
    expect(repeated.runId).toBe(accepted.runId);
    const result = await service.wait(accepted.runId);
    expect(executorError).toBeUndefined();
    expect(executions).toBe(1);
    expect(result.finalized).toBe(true);
    expect(store.getRun(accepted.runId)).toEqual(result);
    db.close();
    db = connectStore(fixture.dbPath);
    expect(new SQLiteRunStore(db).getRun(accepted.runId)).toEqual(result);
    return result;
  } finally {
    db.close();
    await fixture.cleanup();
  }
}

describe('실제 실행에서 저장까지의 연결', () => {
  it('직접 관측한 성공과 검증한 증거를 확정하고 재개방 후에도 보존한다.', async () => {
    expect(await scenario(0, false)).toMatchObject({ verdict: 'passed', workerExitCode: 0, evidenceVerified: true });
  });

  it('성공 이벤트가 있어도 실제 자식 종료코드가 실패이면 실패를 저장한다.', async () => {
    expect(await scenario(9, false)).toMatchObject({ verdict: 'failed', workerExitCode: 9 });
  });

  it('자식 종료 후 증거 바이트가 달라지면 통과로 저장하지 않는다.', async () => {
    expect(await scenario(0, true)).toMatchObject({ verdict: 'unknown', evidenceVerified: false });
  });
});
