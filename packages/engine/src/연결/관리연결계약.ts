// 설치 버전과 자료 폴더가 고정된 관리형 AI 연결의 파일 계약을 검증한다.
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { ServiceError } from '@checkmate/contracts/api';
import { rejectLinks } from './개인경로.js';

export const managedVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u);
const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value)
  && resolve(value) !== parse(value).root && !/[\x00-\x1f\x7f]/u.test(value));
export const managedBackendSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('checkmate-managed-backend'),
  installationRoot: absolutePath, version: managedVersion, generation: z.uuid() });
export const managedRegistrationSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('checkmate-managed-root'),
  installationRoot: absolutePath, dataRoot: absolutePath });
export type ManagedBackend = z.infer<typeof managedBackendSchema>;
export type ManagedTarget = ManagedBackend & { dataRoot: string; nodeExecutable: string; serviceEntry: string };

export function sameManagedPath(left: string, right: string): boolean {
  const key = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return key(left) === key(right);
}
export function compareManagedVersions(left: string, right: string): number {
  const a = managedVersion.parse(left).split('.').map(Number);
  const b = managedVersion.parse(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
export function managedDirectory(installationRoot: string): string { return join(absolutePath.parse(installationRoot), '관리형연결'); }
export function managedRootKey(dataRoot: string): string {
  const path = resolve(absolutePath.parse(dataRoot));
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
export async function readManagedJson(path: string): Promise<unknown> {
  await rejectLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new ServiceError('managed-connection-invalid');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    const sameFile = (value: typeof info) => value.isFile() && value.nlink === 1 && value.dev === info.dev
      && value.ino === info.ino && value.size === info.size && value.mtimeMs === info.mtimeMs && value.ctimeMs === info.ctimeMs;
    if (!sameFile(opened)) throw new ServiceError('managed-connection-invalid');
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    await rejectLinks(path);
    if (length > 16384 || length !== opened.size || !sameFile(await handle.stat()) || !sameFile(await lstat(path)))
      throw new ServiceError('managed-connection-invalid');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await handle.close(); }
}
export async function readManagedDescriptor(installationRoot: string): Promise<ManagedBackend> {
  const descriptor = managedBackendSchema.parse(await readManagedJson(join(managedDirectory(installationRoot), '백엔드.json')));
  if (!sameManagedPath(descriptor.installationRoot, installationRoot)) throw new ServiceError('managed-installation-mismatch');
  await rejectLinks(installationRoot);
  if (!sameManagedPath(await realpath(installationRoot), installationRoot)) throw new ServiceError('managed-installation-mismatch');
  return descriptor;
}
export async function readRegisteredRoots(installationRoot: string): Promise<string[]> {
  const directory = join(managedDirectory(installationRoot), '자료');
  await rejectLinks(directory);
  const names = await readdir(directory);
  if (names.length === 0 || names.length > 256) throw new ServiceError('managed-roots-unknown');
  const roots: string[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw new ServiceError('managed-roots-unknown');
    const entry = managedRegistrationSchema.parse(await readManagedJson(join(directory, name)));
    if (!sameManagedPath(entry.installationRoot, installationRoot) || name !== `${managedRootKey(entry.dataRoot)}.json`)
      throw new ServiceError('managed-roots-unknown');
    await rejectLinks(entry.dataRoot);
    if (!sameManagedPath(await realpath(entry.dataRoot), entry.dataRoot)) throw new ServiceError('managed-root-mismatch');
    const marker = await readManagedJson(join(entry.dataRoot, '체크메이트자료.json'));
    if (JSON.stringify(marker) !== JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' })) throw new ServiceError('managed-root-mismatch');
    roots.push(entry.dataRoot);
  }
  return roots;
}
export async function readManagedTarget(installationRoot: string, dataRoot: string): Promise<ManagedTarget> {
  const descriptor = await readManagedDescriptor(installationRoot);
  const registration = managedRegistrationSchema.parse(await readManagedJson(join(managedDirectory(installationRoot), '자료', `${managedRootKey(dataRoot)}.json`)));
  if (!sameManagedPath(registration.dataRoot, dataRoot) || !sameManagedPath(registration.installationRoot, installationRoot))
    throw new ServiceError('managed-root-mismatch');
  const resources = join(installationRoot, `app-${descriptor.version}`, 'resources');
  const nodeExecutable = join(resources, 'node', 'node.exe');
  const serviceEntry = join(resources, 'engine', 'packages', 'engine', 'dist', '서비스', '상주서비스.js');
  for (const path of [nodeExecutable, serviceEntry]) {
    await rejectLinks(path);
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) throw new ServiceError('managed-backend-invalid');
  }
  const manifest = await readManagedJson(join(resources, 'engine', 'packages', 'engine', 'package.json'));
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== descriptor.version)
    throw new ServiceError('managed-backend-version-mismatch');
  return { ...descriptor, dataRoot: resolve(dataRoot), nodeExecutable, serviceEntry };
}
