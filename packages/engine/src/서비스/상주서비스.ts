// 사용자별 단일 SQLite 쓰기 연결을 소유하고 앱 종료 뒤에도 검사를 유지한다.
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';
import { assessResult } from '@checkmate/contracts';
import { dataPaths, prepareDataPaths, rejectLinks } from '../연결/개인경로.js';
import type { DataPaths } from '../연결/개인경로.js';
import { serveLocal } from '../연결/로컬통신.js';
import { connectStore } from '../저장/연결.js';
import { EvidenceStore } from '../저장/증거저장.js';
import { EventStore } from '../저장/이벤트저장.js';
import { createProjectExecutor } from './검사실행기.js';
import { ProductService } from './제품서비스.js';

const ownerSchema = z.strictObject({ id: z.uuid(), pid: z.number().int().positive(), startedAt: z.iso.datetime() });
async function acquire(paths: DataPaths): Promise<() => Promise<void>> {
  const lock = join(paths.runtime, '서비스소유.json');
  await rejectLinks(lock);
  const readOwner = async () => {
    let contents: string;
    try { contents = await readFile(lock, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new ServiceError('ownership-unknown', '서비스 소유 표식을 확인할 수 없습니다.');
    }
    try { return ownerSchema.parse(JSON.parse(contents)); }
    catch { throw new ServiceError('ownership-unknown', '서비스 소유 표식이 손상됐습니다.'); }
  };
  const previous = await readOwner();
  if (previous) {
    let exited = false;
    try { process.kill(previous.pid, 0); }
    catch (error) { exited = error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
    if (!exited) throw new ServiceError('service-already-running', '기존 서비스 소유권이 아직 유지되고 있습니다.', true);
    const current = await readOwner();
    if (!current || current.id !== previous.id || current.pid !== previous.pid || current.startedAt !== previous.startedAt)
      throw new ServiceError('ownership-unknown', '서비스 소유 표식이 변경됐습니다.');
    await unlink(lock);
    if (process.platform !== 'win32') {
      try { if ((await lstat(paths.endpoint)).isSocket()) await unlink(paths.endpoint); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  const owner = { id: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
  const file = await open(lock, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(owner)); await file.sync(); } finally { await file.close(); }
  return async () => {
    const current = await readOwner();
    if (!current || current.id !== owner.id || current.pid !== owner.pid) throw new ServiceError('ownership-unknown');
    await unlink(lock);
  };
}

export async function startLocalService(root?: string, idleMs = 60000): Promise<{ close: () => Promise<void>; product: ProductService; paths: DataPaths }> {
  const paths = dataPaths(root);
  await prepareDataPaths(paths);
  const release = await acquire(paths);
  let db;
  try {
    db = connectStore(join(paths.state, 'checkmate.sqlite'));
    const evidence = new EvidenceStore(db, paths.runs);
    const events = new EventStore(db);
    const product = new ProductService(db, evidence, createProjectExecutor({ runsRoot: paths.runs, evidenceStore: evidence, eventStore: events }));
    for (const row of db.prepare("SELECT id FROM runs WHERE state IN ('queued','running')").all() as { id: string }[]) {
      const old = product.runs.getRun(row.id)!;
      const queued = old.state === 'queued';
      const recovered = { ...old, state: queued ? 'blocked' as const : 'unverifiable' as const, workerExitCode: null,
        environmentVerified: null, cleanupVerified: queued ? true : null, finalized: true };
      const assessment = assessResult(recovered);
      product.runs.finalizeRun({ ...recovered, ...assessment });
      db.prepare('INSERT INTO audit_events (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json) VALUES (?,?,?,?,NULL,NULL,NULL,?,?)')
        .run(randomUUID(), queued ? 'run-recovery-blocked' : 'run-recovery-unverifiable', 'service', old.runId, new Date().toISOString(),
          JSON.stringify({ previousState: old.state, reason: 'service-restarted', recovery: queued ? '작업 시작 전 중단돼 정리할 실행 자원이 없습니다.' : '종료와 정리를 직접 확인하지 못했습니다.' }));
    }
    let touched = Date.now();
    const endpoint = await serveLocal(paths, async (request, role) => { touched = Date.now(); return product.handle(request, role); });
    let closing: Promise<void> | undefined;
    const database = db;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closing = (async () => { clearInterval(timer); await endpoint.close(); database.close(); await release(); })();
      return closing;
    };
    const timer = setInterval(() => { if (!product.active && endpoint.connections() === 0 && Date.now() - touched >= idleMs) void close().catch(() => { process.exitCode = 5; }); }, 1000);
    return { close, product, paths };
  } catch (error) { db?.close(); await release(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await startLocalService();
  } catch (error) {
    const paths = dataPaths();
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'service-start-failed';
    try { await writeFile(join(paths.runtime, '시작오류.json'), JSON.stringify({ code, at: new Date().toISOString() }), { mode: 0o600 }); } catch { /* 진단 기록 실패가 원래 오류를 숨기지 않게 한다. */ }
    process.exitCode = 5;
  }
}
