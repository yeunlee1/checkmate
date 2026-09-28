// 아틀리에 보고서의 안전 요약만 등록된 프로젝트의 과거 실행으로 저장한다.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assessResult, runResultSchema, type RunResult } from '@checkmate/contracts';
import { planRegistrationSchema, type PlanRegistration } from '@checkmate/contracts/runs';
import { importAtelierReport, type AtelierImportedReport } from '../어댑터/아틀리에이력.js';

const maxBytes = 1024 * 1024;
const uuid = z.uuid();
type FileInfo = Awaited<ReturnType<typeof lstat>> & {
  dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint;
};
type Context = { project_id: string; name: string; repository_identity: string; active_catalog_id: string | null;
  workspace_id: string; real_path: string; path_fingerprint: string; content_hash: string; source_json: string };
type HistoryRow = { origin: string; detail_json: string };

export type ImportHistoryResult = { runId: string; reused: boolean; report: AtelierImportedReport };
export type ImportHistoryErrorCode = 'invalid-input' | 'invalid-file' | 'file-too-large' | 'file-changed'
  | 'invalid-report' | 'project-not-found' | 'storage-busy' | 'storage-error';

export class ImportHistoryError extends Error {
  constructor(public readonly code: ImportHistoryErrorCode, message: string) {
    super(message);
    this.name = 'ImportHistoryError';
  }
}

function fail(error: unknown): never {
  if (error instanceof ImportHistoryError) throw error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code))
    throw new ImportHistoryError('storage-busy', '저장소가 사용 중입니다. 잠시 뒤 다시 시도해 주세요.');
  throw new ImportHistoryError('storage-error', '가져온 이력을 저장하거나 조회할 수 없습니다.');
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

function samePath(a: string, b: string): boolean {
  const canonical = (value: string) => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
  return canonical(a) === canonical(b);
}

async function pathInfo(path: string): Promise<FileInfo> {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true }) as FileInfo;
    if (info.isSymbolicLink() || (current !== path && !info.isDirectory()))
      throw new ImportHistoryError('invalid-file', '일반 파일의 직접 경로만 가져올 수 있습니다.');
  }
  const info = await lstat(path, { bigint: true }) as FileInfo;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || !samePath(await realpath(path), path))
    throw new ImportHistoryError('invalid-file', '일반 파일의 직접 경로만 가져올 수 있습니다.');
  return info;
}

async function readReport(path: string): Promise<AtelierImportedReport> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')
    || relative(parse(path).root, path).includes(':') || !samePath(normalize(path), path))
    throw new ImportHistoryError('invalid-input', '보고서에는 절대 파일 경로가 필요합니다.');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await pathInfo(path);
    if (before.size > BigInt(maxBytes))
      throw new ImportHistoryError('file-too-large', '보고서는 1MiB 이하여야 합니다.');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true }) as FileInfo;
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened))
      throw new ImportHistoryError('file-changed', '보고서가 읽는 동안 변경됐습니다.');
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new ImportHistoryError('file-too-large', '보고서는 1MiB 이하여야 합니다.');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true }) as FileInfo;
    if (!sameFile(before, after) || !sameFile(after, await pathInfo(path)) || BigInt(total) !== after.size)
      throw new ImportHistoryError('file-changed', '보고서가 읽는 동안 변경됐습니다.');
    const parsed = importAtelierReport(Buffer.concat(chunks));
    if (!parsed.ok) throw new ImportHistoryError('invalid-report', '보고서 형식이나 인코딩이 올바르지 않습니다.');
    return parsed.report;
  } catch (error) {
    if (error instanceof ImportHistoryError) throw error;
    throw new ImportHistoryError('invalid-file', '보고서 파일을 안전하게 읽을 수 없습니다.');
  } finally {
    await handle?.close();
  }
}

function context(db: Database.Database, projectId: string): Context {
  const rows = db.prepare(`SELECT p.id AS project_id, p.name, p.repository_identity, p.active_catalog_id,
    w.id AS workspace_id, w.real_path, w.path_fingerprint, c.content_hash, c.source_json
    FROM projects p JOIN workspaces w ON w.project_id = p.id
    LEFT JOIN catalogs c ON c.id = p.active_catalog_id WHERE p.id = ?`).all(projectId) as Context[];
  if (rows.length === 0) throw new ImportHistoryError('project-not-found', '등록된 프로젝트를 찾을 수 없습니다.');
  if (rows.length !== 1 || !rows[0]!.active_catalog_id || !rows[0]!.content_hash)
    throw new ImportHistoryError('storage-error', '프로젝트의 활성 원본을 확인할 수 없습니다.');
  return rows[0]!;
}

function storedReport(row: HistoryRow, originalSha256?: string): AtelierImportedReport {
  try {
    const detail = JSON.parse(row.detail_json) as { report?: AtelierImportedReport };
    const report = detail.report;
    if (row.origin === 'imported' && report?.origin === 'imported'
      && report.effectiveVerdict === 'unknown' && report.reusablePassed === false
      && /^[a-f0-9]{64}$/u.test(report.originalSha256)
      && (originalSha256 === undefined || report.originalSha256 === originalSha256)) return report;
  } catch { /* 손상된 안전 요약은 저장 오류로 처리한다. */ }
  throw new ImportHistoryError('storage-error', '가져온 이력의 요약을 확인할 수 없습니다.');
}

export async function importHistory(db: Database.Database, projectId: string, reportPath: string): Promise<ImportHistoryResult> {
  if (!uuid.safeParse(projectId).success)
    throw new ImportHistoryError('invalid-input', '프로젝트 ID가 올바르지 않습니다.');
  try { context(db, projectId); } catch (error) { fail(error); }
  const report = await readReport(reportPath);
  try {
    return db.transaction(() => {
      const current = context(db, projectId);
      const previous = db.prepare(`SELECT r.id AS run_id, r.origin, a.detail_json FROM audit_events a
        JOIN runs r ON r.id = a.entity_id JOIN workspaces w ON w.id = r.workspace_id
        WHERE w.project_id = ? AND a.action = 'history-imported' AND a.after_hash = ?
        ORDER BY a.recorded_at, a.id LIMIT 1`).get(projectId, report.originalSha256) as
        (HistoryRow & { run_id: string }) | undefined;
      if (previous) return { runId: previous.run_id, reused: true, report: storedReport(previous, report.originalSha256) };

      const now = new Date().toISOString();
      const runId = randomUUID();
      const planId = randomUUID();
      const fingerprint = createHash('sha256').update(JSON.stringify({ kind: 'imported-atelier', version: 1,
        projectId, workspaceId: current.workspace_id, catalogId: current.active_catalog_id,
        catalogHash: current.content_hash, originalSha256: report.originalSha256,
        reportedStatus: report.reportedStatus, mode: report.mode, source: report.source })).digest('hex');
      const registration: PlanRegistration = {
        project: { id: projectId, name: current.name, repositoryIdentity: current.repository_identity },
        workspace: { id: current.workspace_id, realPath: current.real_path, pathFingerprint: current.path_fingerprint },
        catalog: { id: current.active_catalog_id!, contentHash: current.content_hash, source: JSON.parse(current.source_json) },
        plan: { id: planId, fingerprint, sourceHash: report.source.beforeFingerprint, profile: 'imported-atelier',
          plannedChecks: [], requiredChecks: [] },
        createdAt: now,
      };
      if (!planRegistrationSchema.safeParse(registration).success)
        throw new ImportHistoryError('storage-error', '가져오기 계획을 확인할 수 없습니다.');
      const base: RunResult = {
        schemaVersion: 1, runId, projectId, profile: 'imported-atelier', origin: 'imported',
        state: 'unverifiable', verdict: 'unknown', planHash: fingerprint,
        sourceBefore: report.source.beforeFingerprint, sourceAfter: report.source.afterFingerprint,
        workerExitCode: null, environmentVerified: null, evidenceVerified: null, cleanupVerified: null,
        finalized: true, plannedChecks: [], requiredChecks: [], cases: [], reasons: [],
      };
      base.reasons = assessResult(base).reasons;
      if (!runResultSchema.safeParse(base).success)
        throw new ImportHistoryError('storage-error', '가져오기 결과를 확인할 수 없습니다.');
      db.prepare(`INSERT INTO plans (id,workspace_id,catalog_id,fingerprint,plan_json,source_hash,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(planId, current.workspace_id, current.active_catalog_id, fingerprint,
          JSON.stringify(registration), registration.plan.sourceHash, now);
      db.prepare(`INSERT INTO runs (id,workspace_id,plan_id,origin,state,verdict,phase,worker_exit_code,
        started_at,finished_at,finalized_at,summary_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, current.workspace_id, planId, 'imported', 'unverifiable', 'unknown', 'imported', null,
          now, now, now, JSON.stringify(base));
      db.prepare(`INSERT INTO audit_events
        (id,action,actor_kind,entity_id,before_hash,after_hash,approval_id,recorded_at,detail_json)
        VALUES (?,?,?,?,NULL,?,NULL,?,?)`).run(randomUUID(), 'history-imported', 'human', runId,
          report.originalSha256, now, JSON.stringify({ report }));
      return { runId, reused: false, report };
    }).immediate();
  } catch (error) { fail(error); }
}

export function getImportedHistory(db: Database.Database, runId: string): AtelierImportedReport | null {
  if (!uuid.safeParse(runId).success)
    throw new ImportHistoryError('invalid-input', '실행 ID가 올바르지 않습니다.');
  try {
    const row = db.prepare(`SELECT r.origin, a.detail_json FROM runs r JOIN audit_events a ON a.entity_id = r.id
      WHERE r.id = ? AND r.origin = 'imported' AND a.action = 'history-imported'
      ORDER BY a.recorded_at, a.id LIMIT 1`).get(runId) as HistoryRow | undefined;
    return row ? storedReport(row) : null;
  } catch (error) { fail(error); }
}
