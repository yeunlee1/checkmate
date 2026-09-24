// 실행별 증거의 실제 파일과 SQLite 목록을 연결하고 안전한 텍스트 조회를 제공한다.
import { constants, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { verifyEvidence } from '../증거검증.js';

const uuid = z.uuid();
const inputSchema = z.strictObject({
  id: uuid, relativePath: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: z.enum(['text/plain', 'application/json', 'text/html', 'image/png', 'image/jpeg', 'application/zip']),
  sensitivity: z.enum(['public', 'restricted']),
});
const descriptorSchema = inputSchema.extend({ runId: uuid, state: z.enum(['staged', 'ready', 'missing', 'quarantined']) });
const cursorSchema = z.strictObject({ runId: uuid, evidenceId: uuid,
  sha256: inputSchema.shape.sha256, offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });

export type EvidenceDescriptor = z.infer<typeof descriptorSchema>;
export type EvidenceInput = z.infer<typeof inputSchema>;
type Row = { id: string; run_id: string; relative_path: string; sha256: string;
  byte_length: number; mime: string; sensitivity: string; state: string };

export class EvidenceStoreError extends Error {
  constructor(public readonly code: string, message = '증거를 저장하거나 조회할 수 없습니다.') { super(message); }
}

function failure(error: unknown): never {
  if (error instanceof EvidenceStoreError) throw error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) throw new EvidenceStoreError('storage-busy');
  throw new EvidenceStoreError('storage-error');
}

function descriptor(row: Row): EvidenceDescriptor {
  const parsed = descriptorSchema.safeParse({ id: row.id, runId: row.run_id, relativePath: row.relative_path,
    sha256: row.sha256, byteLength: row.byte_length, mime: row.mime, sensitivity: row.sensitivity, state: row.state });
  if (!parsed.success) throw new EvidenceStoreError('storage-error');
  return parsed.data;
}

function manifest(evidence: EvidenceDescriptor | EvidenceInput) {
  return { relativePath: evidence.relativePath, sha256: evidence.sha256, byteLength: evidence.byteLength };
}

function sameFile(a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  b: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export class EvidenceStore {
  private readonly runsRoot: string;

  constructor(private readonly db: Database.Database, runsRoot: string) {
    if (typeof runsRoot !== 'string' || !isAbsolute(runsRoot)) throw new EvidenceStoreError('invalid-input');
    try {
      const root = resolve(runsRoot);
      const actual = realpathSync.native(root);
      if (!isDeepStrictEqual(process.platform === 'win32' ? root.toLowerCase() : root,
        process.platform === 'win32' ? actual.toLowerCase() : actual)) throw new Error('linked-root');
      this.runsRoot = root;
    } catch { throw new EvidenceStoreError('invalid-input'); }
  }

  private root(runId: string): string {
    if (!uuid.safeParse(runId).success) throw new EvidenceStoreError('invalid-input');
    return join(this.runsRoot, runId);
  }

  private get(runId: string, evidenceId: string): EvidenceDescriptor {
    this.root(runId);
    if (!uuid.safeParse(evidenceId).success) throw new EvidenceStoreError('invalid-input');
    try {
      const row = this.db.prepare('SELECT * FROM evidence WHERE run_id = ? AND id = ?')
        .get(runId, evidenceId) as Row | undefined;
      if (!row) throw new EvidenceStoreError('evidence-not-found');
      return descriptor(row);
    } catch (error) { failure(error); }
  }

  async register(runId: string, input: EvidenceInput): Promise<EvidenceDescriptor> {
    const root = this.root(runId);
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new EvidenceStoreError('invalid-input');
    const candidate: EvidenceDescriptor = { ...parsed.data, runId, state: 'ready' };
    try {
      if (!this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) throw new EvidenceStoreError('run-not-found');
      const existing = this.db.prepare('SELECT * FROM evidence WHERE id = ? OR (run_id = ? AND relative_path = ?)')
        .all(parsed.data.id, runId, parsed.data.relativePath) as Row[];
      if (existing.length > 0 && (existing.length !== 1 || !isDeepStrictEqual(descriptor(existing[0]!), candidate)))
        throw new EvidenceStoreError('evidence-conflict');
    } catch (error) { failure(error); }
    const checked = await verifyEvidence(root, manifest(parsed.data));
    if (checked.status === 'invalid-manifest' || checked.status === 'unsafe-path') throw new EvidenceStoreError('invalid-input');
    if (checked.status === 'missing') throw new EvidenceStoreError('evidence-missing');
    if (checked.status !== 'verified') throw new EvidenceStoreError('evidence-degraded');
    try {
      return this.db.transaction(() => {
        if (!this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) throw new EvidenceStoreError('run-not-found');
        const old = this.db.prepare('SELECT * FROM evidence WHERE id = ? OR (run_id = ? AND relative_path = ?)')
          .all(parsed.data.id, runId, parsed.data.relativePath) as Row[];
        if (old.length > 0) {
          if (old.length !== 1 || !isDeepStrictEqual(descriptor(old[0]!), candidate))
            throw new EvidenceStoreError('evidence-conflict');
          return candidate;
        }
        this.db.prepare(`INSERT INTO evidence (id,run_id,relative_path,sha256,byte_length,mime,sensitivity,state)
          VALUES (?,?,?,?,?,?,?,'ready')`).run(parsed.data.id, runId, parsed.data.relativePath, parsed.data.sha256,
          parsed.data.byteLength, parsed.data.mime, parsed.data.sensitivity);
        return candidate;
      })();
    } catch (error) { failure(error); }
  }

  list(runId: string): EvidenceDescriptor[] {
    this.root(runId);
    try {
      return (this.db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map(descriptor);
    } catch (error) { failure(error); }
  }

  async inspect(runId: string, evidenceId: string): Promise<{
    evidence: EvidenceDescriptor; integrity: 'verified' | 'degraded'; reason: string | null }> {
    const evidence = this.get(runId, evidenceId);
    const checked = await verifyEvidence(this.root(runId), manifest(evidence));
    return { evidence, integrity: checked.status === 'verified' && evidence.state === 'ready' ? 'verified' : 'degraded',
      reason: checked.status !== 'verified' ? checked.status : evidence.state === 'ready' ? null : evidence.state };
  }

  async readText(runId: string, evidenceId: string, options: { cursor?: string; limit?: number } = {}): Promise<{
    text: string; nextCursor: string | null; integrity: 'verified' }> {
    const evidence = this.get(runId, evidenceId);
    if (evidence.sensitivity !== 'public' || !['text/plain', 'application/json', 'text/html'].includes(evidence.mime))
      throw new EvidenceStoreError('evidence-restricted');
    if (typeof options !== 'object' || options === null || Array.isArray(options)
      || Object.keys(options).some((key) => key !== 'cursor' && key !== 'limit')) throw new EvidenceStoreError('invalid-input');
    const limit = options.limit ?? 8 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024) throw new EvidenceStoreError('invalid-input');
    let offset = 0;
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 1024) throw new Error('cursor');
        const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        const parsed = cursorSchema.safeParse(decoded);
        if (!parsed.success || Buffer.from(JSON.stringify(parsed.data)).toString('base64url') !== options.cursor
          || parsed.data.runId !== runId || parsed.data.evidenceId !== evidenceId
          || parsed.data.sha256 !== evidence.sha256 || parsed.data.offset >= evidence.byteLength) throw new Error('cursor');
        offset = parsed.data.offset;
      } catch { throw new EvidenceStoreError('invalid-input'); }
    }
    const first = await this.inspect(runId, evidenceId);
    if (first.integrity !== 'verified') throw new EvidenceStoreError(first.reason === 'missing' ? 'evidence-missing' : 'evidence-degraded');
    const path = join(this.root(runId), ...evidence.relativePath.split('/'));
    let bytes: Buffer;
    try {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size !== BigInt(evidence.byteLength)) throw new EvidenceStoreError('evidence-degraded');
        const buffer = Buffer.alloc(Math.min(evidence.byteLength - offset, limit + 4));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
          if (part.bytesRead === 0) break;
          bytesRead += part.bytesRead;
        }
        if (bytesRead !== buffer.length) throw new EvidenceStoreError('evidence-degraded');
        bytes = buffer;
        const after = await handle.stat({ bigint: true });
        const pathInfo = await lstat(path, { bigint: true });
        if (!sameFile(before, after) || !sameFile(after, pathInfo) || pathInfo.isSymbolicLink())
          throw new EvidenceStoreError('evidence-degraded');
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      throw new EvidenceStoreError((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'evidence-missing' : 'evidence-degraded');
    }
    const second = await this.inspect(runId, evidenceId);
    if (second.integrity !== 'verified') throw new EvidenceStoreError(second.reason === 'missing' ? 'evidence-missing' : 'evidence-degraded');
    let decoded: string | undefined;
    let validBytes = bytes.length;
    while (validBytes >= 0) {
      try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, validBytes)); break; }
      catch { validBytes -= 1; if (bytes.length - validBytes > 3) throw new EvidenceStoreError('evidence-degraded'); }
    }
    if (decoded === undefined) throw new EvidenceStoreError('evidence-degraded');
    if (validBytes < bytes.length && offset + bytes.length === evidence.byteLength)
      throw new EvidenceStoreError('evidence-degraded');
    const chars = Array.from(decoded);
    const prefix: number[] = [0];
    for (const char of chars) prefix.push(prefix[prefix.length - 1]! + Buffer.byteLength(char));
    const resultAt = (count: number) => {
      const position = offset + prefix[count]!;
      return { text: chars.slice(0, count).join(''), nextCursor: position < evidence.byteLength
        ? Buffer.from(JSON.stringify({ runId, evidenceId, sha256: evidence.sha256, offset: position })).toString('base64url') : null,
      integrity: 'verified' as const };
    };
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(resultAt(middle))) <= limit) low = middle;
      else high = middle - 1;
    }
    const result = resultAt(low);
    if (Buffer.byteLength(JSON.stringify(result)) > limit || (low === 0 && offset < evidence.byteLength))
      throw new EvidenceStoreError('invalid-input');
    return result;
  }
}
