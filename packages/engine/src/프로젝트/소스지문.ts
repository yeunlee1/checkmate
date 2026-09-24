// 프로젝트 파일을 읽기 전용으로 순회하고 바이트 기준 소스 지문을 만든다.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export type ProjectSourceErrorCode = 'invalid-input' | 'invalid-project' | 'source-unreadable'
  | 'source-too-large' | 'source-changed';

export class ProjectSourceError extends Error {
  constructor(public readonly code: ProjectSourceErrorCode, message: string) {
    super(message);
    this.name = 'ProjectSourceError';
  }
}

const excludedDirectories = ['.git', 'node_modules', '.runtime', 'dist', 'out', 'coverage', '.vite'];
const exclusionRules = { version: 1, directories: excludedDirectories, files: ['.env', '.env.*', '*.pem', '*.key'] };

export function assertIncludedEntry(parts: string[]): void {
  if (parts.slice(0, -1).some((part) => excludedDirectories.includes(part.toLowerCase()))) {
    throw new ProjectSourceError('invalid-project', '명령 진입점은 소스 지문에 포함되는 경로에 두어야 합니다. tests/검사.mjs 같은 Node 파일을 사용해 주세요.');
  }
}
const maxSourceFiles = 10_000;
const maxSourceBytes = 256 * 1024 * 1024;

type FileInfo = Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function safeName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\x00-\x1f\x7f<>:"|?*\\/]/u.test(name)
    && !/[. ]$/u.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}

function excludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.pem') || lower.endsWith('.key');
}

function ioError(error: unknown): ProjectSourceError {
  if (error instanceof ProjectSourceError) return error;
  return new ProjectSourceError('source-unreadable', '프로젝트 원본 파일을 읽을 수 없습니다.');
}

export async function checkedProjectRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) {
    throw new ProjectSourceError('invalid-input', '프로젝트 경로가 올바르지 않습니다.');
  }
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ProjectSourceError('invalid-project', '프로젝트 폴더가 올바르지 않습니다.');
    }
    return await realpath(root);
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw new ProjectSourceError('invalid-project', '프로젝트 폴더를 확인할 수 없습니다.');
  }
}

export async function readCheckedFile(root: string, parts: string[], maxBytes: number): Promise<Buffer>;
export async function readCheckedFile(root: string, parts: string[], maxBytes?: number): Promise<string>;
export async function readCheckedFile(root: string, parts: string[], maxBytes: number, hashOnly: true): Promise<string>;
export async function readCheckedFile(root: string, parts: string[], maxBytes?: number, hashOnly = false): Promise<Buffer | string> {
  if (parts.length === 0 || parts.some((part) => !safeName(part))) {
    throw new ProjectSourceError('invalid-project', '원본 파일 경로가 올바르지 않습니다.');
  }
  let path = root;
  try {
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      if (!within(root, path)) throw new ProjectSourceError('invalid-project', '원본 경로가 프로젝트 밖입니다.');
      const info = await lstat(path);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())
        || (index === parts.length - 1 && !info.isFile()) || !within(root, await realpath(path))) {
        throw new ProjectSourceError('invalid-project', '원본 파일 형식 또는 경로가 올바르지 않습니다.');
      }
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true }) as FileInfo;
      const pathBefore = await lstat(path, { bigint: true }) as FileInfo;
      if (!before.isFile() || pathBefore.isSymbolicLink() || !sameFile(before, pathBefore)
        || !within(root, await realpath(path))) {
        throw new ProjectSourceError('source-changed', '원본 파일이 읽는 동안 변경되었습니다.');
      }
      if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
        throw new ProjectSourceError('source-too-large', '원본 파일 크기 제한을 넘었습니다.');
      }
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (maxBytes !== undefined && total > maxBytes) {
          throw new ProjectSourceError('source-too-large', '원본 파일 크기 제한을 넘었습니다.');
        }
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        if (maxBytes !== undefined && !hashOnly) chunks.push(Buffer.from(bytes));
      }
      const after = await handle.stat({ bigint: true }) as FileInfo;
      const pathAfter = await lstat(path, { bigint: true }) as FileInfo;
      if (!sameFile(before, after) || !sameFile(after, pathAfter) || pathAfter.isSymbolicLink()
        || !within(root, await realpath(path)) || BigInt(total) !== after.size) {
        throw new ProjectSourceError('source-changed', '원본 파일이 읽는 동안 변경되었습니다.');
      }
      return maxBytes === undefined || hashOnly ? hash.digest('hex') : Buffer.concat(chunks);
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw ioError(error);
  }
}

export async function fingerprintSource(root: string): Promise<string> {
  const realRoot = await checkedProjectRoot(root);
  const paths: string[][] = [];
  let directoryCount = 0;
  async function visit(parts: string[]): Promise<void> {
    const directory = join(realRoot, ...parts);
    directoryCount += 1;
    if (directoryCount > maxSourceFiles) throw new ProjectSourceError('source-too-large', '소스 폴더 수 제한을 넘었습니다.');
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || !within(realRoot, await realpath(directory))) {
        throw new ProjectSourceError('invalid-project', '소스 폴더 경로가 올바르지 않습니다.');
      }
    } catch (error) { throw ioError(error); }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { throw ioError(error); }
    for (const entry of entries) {
      if (!safeName(entry.name)) throw new ProjectSourceError('invalid-project', '소스 경로가 올바르지 않습니다.');
      if (entry.isDirectory() && excludedDirectories.includes(entry.name.toLowerCase())) continue;
      if (!entry.isDirectory() && excludedFile(entry.name)) continue;
      const next = [...parts, entry.name];
      const path = join(realRoot, ...next);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !within(realRoot, await realpath(path))) {
          throw new ProjectSourceError('invalid-project', '소스 링크 또는 외부 경로를 허용하지 않습니다.');
        }
        if (info.isDirectory()) await visit(next);
        else if (info.isFile()) {
          paths.push(next);
          if (paths.length > maxSourceFiles) throw new ProjectSourceError('source-too-large', '소스 파일 수 제한을 넘었습니다.');
        } else throw new ProjectSourceError('invalid-project', '지원하지 않는 소스 파일 형식입니다.');
      } catch (error) { throw ioError(error); }
    }
  }
  await visit([]);
  paths.sort((a, b) => a.join('/') < b.join('/') ? -1 : a.join('/') > b.join('/') ? 1 : 0);
  const digest = createHash('sha256');
  digest.update(JSON.stringify({ format: 1, node: process.version, exclusions: exclusionRules }));
  let totalBytes = 0;
  for (const parts of paths) {
    const path = join(realRoot, ...parts);
    let info: FileInfo;
    try { info = await lstat(path, { bigint: true }) as FileInfo; }
    catch (error) { throw ioError(error); }
    if (!info.isFile() || info.isSymbolicLink()) throw new ProjectSourceError('source-changed', '소스 파일이 변경되었습니다.');
    totalBytes += Number(info.size);
    if (totalBytes > maxSourceBytes) throw new ProjectSourceError('source-too-large', '소스 전체 크기 제한을 넘었습니다.');
    const name = parts.join('/');
    const byteHash = await readCheckedFile(realRoot, parts, maxSourceBytes - totalBytes + Number(info.size), true);
    digest.update(`\n${Buffer.byteLength(name)}:${name}:${byteHash}`);
  }
  return digest.digest('hex');
}
