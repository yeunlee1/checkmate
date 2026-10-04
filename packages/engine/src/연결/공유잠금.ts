// 같은 사용자 공통 폴더의 배타 파일로 실행 전체 자원을 함께 잠그고 불명 상태를 보존한다.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';
import { makePrivate, rejectLinks } from './개인경로.js';

const leaseSchema = z.strictObject({ version: z.literal(1), generation: z.uuid(), runId: z.uuid(), ownerId: z.uuid().nullable(),
  dataRootHash: z.string().regex(/^[a-f0-9]{64}$/u), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  keys: z.array(z.string().min(1).max(8192)).min(1).max(1000), phase: z.enum(['intent', 'admitted']) });
export type Lease = Omit<z.infer<typeof leaseSchema>, 'phase'>;
const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function defaultSharedLockRoot(): string {
  return process.env.CHECKMATE_LOCK_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'CheckMateLocks');
}
function links(path: string): void {
  for (let current = resolve(path); current !== dirname(current); current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new ServiceError('unsafe-path'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
}
function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return !rest || rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
function realLocation(path: string): string {
  links(path);
  try {
    const info = lstatSync(path);
    if (info.isFile() && info.nlink !== 1) throw new ServiceError('unsafe-path');
    return normalized(realpathSync.native(path));
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const parent = dirname(path);
    if (parent === path) throw new ServiceError('unsafe-path');
    return join(realLocation(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}
export function executionLockKeys(workspacePath: string, writes: string[], exclusiveResources: string[] = [], outputPaths: string[] = []): string[] {
  const root = realLocation(workspacePath);
  const keys = [`workspace:${root}`];
  for (const path of writes) {
    const actual = realLocation(resolve(root, path));
    if (!within(root, actual)) throw new ServiceError('unsafe-path');
    keys.push(`path:${actual}`);
  }
  for (const key of exclusiveResources) keys.push(`named:${key.trim().toLowerCase()}`);
  for (const path of outputPaths) keys.push(`path:${realLocation(path)}`);
  return [...new Set(keys)].sort();
}
function conflicts(a: string, b: string): boolean {
  if (a === b) return true;
  const pathA = /^(?:path|workspace):(.*)$/u.exec(a)?.[1];
  const pathB = /^(?:path|workspace):(.*)$/u.exec(b)?.[1];
  return pathA !== undefined && pathB !== undefined && (within(pathA, pathB) || within(pathB, pathA));
}

export class SharedLocks {
  readonly root: string;
  private prepared: Promise<void> | undefined;
  constructor(root: string, private readonly dataRoot: string) {
    if (!isAbsolute(root) || resolve(root) === parse(root).root) throw new ServiceError('unsafe-path');
    this.root = resolve(root);
  }
  async prepare(): Promise<void> {
    if (!this.prepared) this.prepared = (async () => {
      await rejectLinks(this.root);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await rejectLinks(this.root);
      if (!lstatSync(this.root).isDirectory()) throw new ServiceError('unsafe-path');
      await makePrivate(this.root);
    })();
    await this.prepared;
    links(this.root);
  }
  private path(lease: Lease): string { return join(this.root, `${lease.runId}-${lease.generation}.json`); }
  private read(path: string): z.infer<typeof leaseSchema> {
    links(path);
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) throw new ServiceError('lock-ownership-unknown');
    try { return leaseSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { throw new ServiceError('lock-ownership-unknown'); }
  }
  private registry<T>(work: () => T): T {
    links(this.root);
    const path = join(this.root, '조정잠금');
    const generation = randomUUID();
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch { throw new ServiceError('lock-coordination-unknown', '공통 잠금 조정 상태를 확인할 수 없습니다. 기존 표식은 보존됩니다.'); }
    const identity = fstatSync(fd);
    try { writeFileSync(fd, generation); fsyncSync(fd); }
    catch (error) { closeSync(fd); throw error; }
    closeSync(fd);
    try { return work(); }
    finally {
      links(path);
      const current = lstatSync(path);
      if (current.ino !== identity.ino || current.dev !== identity.dev || current.nlink !== 1 || readFileSync(path, 'utf8') !== generation)
        throw new ServiceError('lock-ownership-unknown');
      unlinkSync(path);
    }
  }
  acquire(runId: string, ownerId: string | null, requestHash: string, keys: string[]): Lease {
    return this.registry(() => {
      const entries = readdirSync(this.root).filter(name => name.endsWith('.json'));
      for (const name of entries) {
        const other = this.read(join(this.root, name));
        if (other.keys.some(a => keys.some(b => conflicts(a, b)))) throw new ServiceError('shared-resource-busy', '다른 실행이 같은 작업 폴더 또는 선언된 공유 자원을 보유하고 있습니다.');
      }
      const full = leaseSchema.parse({ version: 1, generation: randomUUID(), runId, ownerId,
        dataRootHash: digest(normalized(resolve(this.dataRoot))), requestHash, keys: [...new Set(keys)].sort(), phase: 'intent' });
      const { phase: _phase, ...lease } = full;
      const fd = openSync(this.path(lease), 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(full)); fsyncSync(fd); } finally { closeSync(fd); }
      return lease;
    });
  }
  private owned(lease: Lease): z.infer<typeof leaseSchema> {
    const full = this.read(this.path(lease));
    const { phase: _phase, ...identity } = full;
    if (!isDeepStrictEqual(identity, lease) || lease.dataRootHash !== digest(normalized(resolve(this.dataRoot)))) throw new ServiceError('lock-ownership-unknown');
    return full;
  }
  admit(lease: Lease): void {
    this.registry(() => {
      this.owned(lease);
      const path = this.path(lease);
      const before = lstatSync(path);
      const fd = openSync(path, 'r+');
      try {
        const opened = fstatSync(fd);
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new ServiceError('lock-ownership-unknown');
        ftruncateSync(fd, 0); writeFileSync(fd, JSON.stringify({ ...lease, phase: 'admitted' })); fsyncSync(fd);
      } finally { closeSync(fd); }
    });
  }
  assert(lease: Lease, keys: string[]): void {
    this.registry(() => {
      if (this.owned(lease).phase !== 'admitted' || !isDeepStrictEqual(lease.keys, keys)) throw new ServiceError('lock-ownership-unknown');
    });
  }
  release(lease: Lease): void { this.registry(() => { this.owned(lease); unlinkSync(this.path(lease)); }); }
}
