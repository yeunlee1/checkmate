// 실행별 증거 파일의 경로와 실제 바이트를 읽기 전용으로 검증한다.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';

export type EvidenceManifestEntry = {
  relativePath: string;
  sha256: string;
  byteLength: number;
};

export type EvidenceVerification = {
  status: 'verified' | 'invalid-manifest' | 'unsafe-path' | 'missing' | 'not-file'
    | 'size-mismatch' | 'hash-mismatch' | 'changed-during-read' | 'io-error';
};

function failure(status: EvidenceVerification['status']): EvidenceVerification {
  return { status };
}

function fileError(error: unknown): EvidenceVerification {
  const code = (error as NodeJS.ErrnoException)?.code;
  return failure(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'io-error');
}

function within(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${posix.sep}`)
    && !remainder.startsWith('..\\') && !isAbsolute(remainder));
}

function safeParts(value: string): string[] | null {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes(':')
    || /[\x00-\x1f\x7f<>"|?*]/u.test(value) || posix.normalize(value) !== value) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) return null;
  return parts;
}

function unchanged(before: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  after: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

export async function verifyEvidence(root: string, manifestEntry: unknown): Promise<EvidenceVerification> {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')
    || typeof manifestEntry !== 'object' || manifestEntry === null || Array.isArray(manifestEntry)) {
    return failure('invalid-manifest');
  }
  let fields: PropertyDescriptorMap;
  try { fields = Object.getOwnPropertyDescriptors(manifestEntry); }
  catch { return failure('invalid-manifest'); }
  if (Reflect.ownKeys(fields).length !== 3 || !('relativePath' in fields) || !('sha256' in fields)
    || !('byteLength' in fields) || !('value' in fields.relativePath!)
    || !('value' in fields.sha256!) || !('value' in fields.byteLength!)) {
    return failure('invalid-manifest');
  }
  const relativePath: unknown = fields.relativePath!.value;
  const sha256: unknown = fields.sha256!.value;
  const byteLength: unknown = fields.byteLength!.value;
  if (typeof relativePath !== 'string' || typeof sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(sha256) || typeof byteLength !== 'number'
    || !Number.isSafeInteger(byteLength) || byteLength < 0) return failure('invalid-manifest');
  const parts = safeParts(relativePath);
  if (!parts) return failure('unsafe-path');

  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return failure('unsafe-path');
    const realRoot = await realpath(root);
    let path = resolve(root);
    for (let index = 0; index < parts.length; index += 1) {
      path = join(path, parts[index]!);
      if (!within(root, path)) return failure('unsafe-path');
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) return failure('unsafe-path');
      if (index < parts.length - 1 && !info.isDirectory()) return failure('not-file');
      if (!within(realRoot, await realpath(path))) return failure('unsafe-path');
      if (index === parts.length - 1 && !info.isFile()) return failure('not-file');
    }

    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return failure('not-file');
      const pathInfo = await lstat(path, { bigint: true });
      if (pathInfo.isSymbolicLink() || !within(realRoot, await realpath(path))) return failure('unsafe-path');
      if (before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) return failure('changed-during-read');
      if (before.size !== BigInt(byteLength)) return failure('size-mismatch');

      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      while (total <= byteLength) {
        const limit = Math.min(buffer.length, byteLength - total + 1);
        const { bytesRead } = await handle.read(buffer, 0, limit, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > byteLength) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      if (!unchanged(before, after)) return failure('changed-during-read');
      const finalPathInfo = await lstat(path, { bigint: true });
      if (finalPathInfo.isSymbolicLink() || !within(realRoot, await realpath(path))
        || after.dev !== finalPathInfo.dev || after.ino !== finalPathInfo.ino) {
        return failure('changed-during-read');
      }
      if (total !== byteLength) return failure('changed-during-read');
      return failure(hash.digest('hex') === sha256 ? 'verified' : 'hash-mismatch');
    } finally {
      await handle.close();
    }
  } catch (error) {
    return fileError(error);
  }
}
