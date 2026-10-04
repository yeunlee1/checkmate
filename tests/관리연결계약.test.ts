// 관리형 연결이 다른 설치본과 자료 경로 또는 변조된 파일로 바뀌지 않는지 검증한다.
import { randomUUID } from 'node:crypto';
import { link, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStoreFixture } from './저장시험자료.js';
import { compareManagedVersions, managedDirectory, managedRootKey, readManagedDescriptor, readManagedJson,
  readManagedTarget, readRegisteredRoots } from '../packages/engine/src/연결/관리연결계약.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await createStoreFixture(); cleanups.push(f.cleanup);
  const root = join(f.directory, '한글 설치'); const dataRoot = join(f.directory, '관리 자료');
  const directory = managedDirectory(root);
  await mkdir(join(directory, '자료'), { recursive: true }); await mkdir(dataRoot);
  await writeFile(join(dataRoot, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  const descriptor = { schemaVersion: 1, kind: 'checkmate-managed-backend', installationRoot: root, version: '1.0.0', generation: randomUUID() };
  await writeFile(join(directory, '백엔드.json'), JSON.stringify(descriptor));
  const registration = join(directory, '자료', `${managedRootKey(dataRoot)}.json`);
  await writeFile(registration, JSON.stringify({ schemaVersion: 1, kind: 'checkmate-managed-root', installationRoot: root, dataRoot }));
  const resources = join(root, 'app-1.0.0', 'resources');
  const node = join(resources, 'node', 'node.exe');
  const service = join(resources, 'engine', 'packages', 'engine', 'dist', '서비스', '상주서비스.js');
  const manifest = join(resources, 'engine', 'packages', 'engine', 'package.json');
  await mkdir(dirname(node), { recursive: true }); await mkdir(dirname(service), { recursive: true });
  await writeFile(node, '합성 실행하지 않는 파일'); await writeFile(service, '// 합성 서비스 경로 표식');
  await writeFile(manifest, JSON.stringify({ version: '1.0.0' }));
  return { f, root, dataRoot, directory, descriptor, registration, node, service, manifest };
}

it('한글 공백 자료 루트와 정확한 버전 경로를 고정한다', async () => {
  const f = await fixture();
  expect(await readRegisteredRoots(f.root)).toEqual([f.dataRoot]);
  expect(await readManagedTarget(f.root, f.dataRoot)).toMatchObject({ dataRoot: f.dataRoot, nodeExecutable: f.node, serviceEntry: f.service, generation: f.descriptor.generation });
});
it('등록되지 않은 root와 다른 설치본 descriptor를 거절한다', async () => {
  const f = await fixture();
  await expect(readManagedTarget(f.root, join(f.f.directory, '다른 자료'))).rejects.toThrow();
  await writeFile(join(f.directory, '백엔드.json'), JSON.stringify({ ...f.descriptor, installationRoot: f.dataRoot }));
  await expect(readManagedDescriptor(f.root)).rejects.toMatchObject({ code: 'managed-installation-mismatch' });
});
it('파일 이름과 등록 root가 다르거나 알 수 없는 명부 파일이 있으면 전체 관측을 거절한다', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, '자료', `${'a'.repeat(64)}.json`), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-managed-root', installationRoot: f.root, dataRoot: f.dataRoot }));
  await expect(readRegisteredRoots(f.root)).rejects.toMatchObject({ code: 'managed-roots-unknown' });
});
it('백엔드 manifest의 다른 버전은 최신 연결로 간주하지 않는다', async () => {
  const f = await fixture(); await writeFile(f.manifest, JSON.stringify({ version: '0.9.0' }));
  await expect(readManagedTarget(f.root, f.dataRoot)).rejects.toMatchObject({ code: 'managed-backend-version-mismatch' });
});
it('하드링크와 잘못된 UTF8 및 과대한 JSON은 거절한다', async () => {
  const f = await fixture(); const path = join(f.f.directory, '합성.json');
  await writeFile(path, '{}'); await link(path, join(f.f.directory, '별칭.json'));
  await expect(readManagedJson(path)).rejects.toMatchObject({ code: 'managed-connection-invalid' });
  const invalid = join(f.f.directory, '손상.json'); await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await expect(readManagedJson(invalid)).rejects.toThrow();
  await writeFile(invalid, ' '.repeat(16385)); await expect(readManagedJson(invalid)).rejects.toMatchObject({ code: 'managed-connection-invalid' });
});
it('버전을 숫자로 비교하고 임의 경로와 사전 공개 버전은 거절한다', () => {
  expect(compareManagedVersions('0.2.10', '0.2.9')).toBe(1);
  expect(compareManagedVersions('0.2.9', '0.2.10')).toBe(-1);
  expect(compareManagedVersions('0.2.9', '0.2.9')).toBe(0);
  for (const version of ['01.2.3', '../1.2.3', '0.2.1-alpha', '1.2.9999999999']) expect(() => compareManagedVersions(version, '0.2.9')).toThrow();
});
