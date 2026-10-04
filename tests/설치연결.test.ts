// Squirrel 이벤트와 고정 CLI 진입점의 파일 경계를 검증한다.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ensureLauncher, ensureManagedConnection, hasOwnedDataRoot, launcherText, squirrelAction } from '../packages/desktop/src/main/설치연결.js';
import { managedDirectory, managedRootKey, readManagedDescriptor, readManagedTarget, readRegisteredRoots } from '@checkmate/engine/managed-connection';

const copying = vi.hoisted(() => ({ corrupt: false,
  beforeRename: undefined as ((source: string, target: string) => Promise<void>) | undefined,
  afterRename: undefined as ((source: string, target: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await copying.beforeRename?.(String(args[0]), String(args[1]));
    await actual.rename(...args);
    await copying.afterRename?.(String(args[0]), String(args[1]));
  }, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    await actual.copyFile(...args);
    if (copying.corrupt) await actual.writeFile(args[1], '합성 손상 복사');
  } };
});

const temporary: string[] = [];
afterEach(async () => {
  copying.corrupt = false; copying.beforeRename = undefined; copying.afterRename = undefined;
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'CheckMate 설치 시험 ')));
  temporary.push(root);
  return root;
}

test('설치와 갱신은 바로 가기 생성, 제거는 삭제, 구버전은 종료만 선택한다', () => {
  expect(squirrelAction('--squirrel-install')).toBe('--createShortcut');
  expect(squirrelAction('--squirrel-updated')).toBe('--createShortcut');
  expect(squirrelAction('--squirrel-uninstall')).toBe('--removeShortcut');
  expect(squirrelAction('--squirrel-obsolete')).toBe('obsolete');
  expect(squirrelAction('--squirrel-firstrun')).toBeNull();
});

test('경로의 공백과 한글은 보존하고 cmd 확장 문자는 거절한다', () => {
  const root = join(tmpdir(), '자료 폴더');
  const node = join(tmpdir(), '설치 경로 (x86)', 'node.exe');
  const cli = join(tmpdir(), '명령 도구', '명령.js');
  expect(launcherText(root, node, cli)).toContain(`"${node}" "${cli}" --data-dir "${root}" %*`);
  expect(() => launcherText(root, join(tmpdir(), '값%PATH%', 'node.exe'), cli)).toThrow(/cmd/);
  expect(() => launcherText(join(tmpdir(), '자료&실행'), node, cli)).toThrow(/cmd/);
});

test('소유 표시가 없는 폴더와 다른 사용자의 명령 파일은 덮어쓰지 않는다', async () => {
  const base = await fixture();
  const root = join(base, '관리 자료');
  await mkdir(root);
  expect(await hasOwnedDataRoot(root)).toBe(false);
  await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow(/소유 표시/);
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  await mkdir(join(root, 'bin'));
  const other = join(root, 'bin', 'checkmate.cmd');
  await writeFile(other, '@echo off\r\necho 다른 파일\r\n');
  await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow(/CheckMate가 만든/);
  expect(await readFile(other, 'utf8')).toContain('다른 파일');
});

test('자체 명령 파일은 버전별 실행 경로로 원자적으로 갱신한다', async () => {
  const base = await fixture();
  const root = join(base, '관리 자료');
  await mkdir(root);
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  const first = join(base, '버전 첫째', '명령.js');
  const second = join(base, '버전 둘째', '명령.js');
  const target = await ensureLauncher(root, process.execPath, first);
  expect(await readFile(target, 'utf8')).toContain(first);
  expect(await ensureLauncher(root, process.execPath, second)).toBe(target);
  const updated = await readFile(target, 'utf8');
  expect(updated).toContain(second);
  expect(updated).not.toContain(first);
});

test('bin 링크가 외부 폴더를 가리키면 파일을 만들지 않는다', async () => {
  const base = await fixture();
  const root = join(base, '관리 자료');
  const outside = join(base, '외부 폴더');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  await symlink(outside, join(root, 'bin'), 'junction');
  await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow(/링크 경로/);
  await expect(readFile(join(outside, 'checkmate.cmd'))).rejects.toMatchObject({ code: 'ENOENT' });
});

const resources = process.env.CHECKMATE_PACKAGED_RESOURCES;

test.runIf(process.platform === 'win32')('기존 파일과 하드링크 거절은 상위 및 외부 원본 ACL을 바꾸지 않는다', async () => {
  const base = await fixture();
  for (const hardLink of [false, true]) {
    const root = join(base, hardLink ? '연결 자료' : '일반 자료');
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const marker = join(root, '체크메이트자료.json');
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
    const outside = join(base, hardLink ? '외부원본.txt' : '별도원본.txt');
    await writeFile(outside, '기존 사용자 자료');
    const target = join(bin, 'checkmate.cmd');
    if (hardLink) await link(outside, target);
    else await writeFile(target, '기존 사용자 자료');
    const paths = [root, bin, marker, target, outside];
    const inspect = () => {
      const encoded = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
      const script = `$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); @($paths | ForEach-Object { if ([IO.Directory]::Exists($_)) { [IO.Directory]::GetAccessControl($_).Sddl } else { [IO.File]::GetAccessControl($_).Sddl } }) | ConvertTo-Json -Compress`;
      const result = spawnSync(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (result.status !== 0) {
        const diagnostic = { status: result.status, error: result.error?.message,
          stderr: result.stderr?.slice(-4000), stdout: result.stdout?.slice(-4000) };
        throw new Error(`ACL 수집 실패. ${JSON.stringify(diagnostic).replace(/[0-9a-f]{64}/gi, '[비밀 제외]')}`);
      }
      return JSON.parse(result.stdout) as string[];
    };
    const before = inspect();
    await expect(ensureLauncher(root, process.execPath, join(base, '명령.js'))).rejects.toThrow('기존 CLI 진입점');
    expect(inspect()).toEqual(before);
    expect(await readFile(outside, 'utf8')).toBe('기존 사용자 자료');
    expect(await readFile(target, 'utf8')).toBe('기존 사용자 자료');
  }
});

test.skipIf(!resources)('실제 포장 Node와 CLI를 공백과 한글 자료 경로에서 doctor로 호출한다', async () => {
  const base = await fixture();
  const root = join(base, '관리 (자료)', '새 합성 자료');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  const node = join(resources!, 'node', 'node.exe');
  const cli = join(resources!, 'engine', 'packages', 'engine', 'dist', '명령.js');
  const direct = spawnSync(node, [cli, '--data-dir', root, '--json', 'doctor'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(direct.status, JSON.stringify({ stderr: direct.stderr, stdout: direct.stdout, error: direct.error?.message })).toBe(0);
  const launcher = await ensureLauncher(root, node, cli);
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" --json doctor"`], { encoding: 'utf8', windowsHide: true, timeout: 15000, windowsVerbatimArguments: true });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as { ok: boolean; data: { node: string; supportedRuntime: boolean } };
  expect(report.ok).toBe(true);
  expect(report.data.node).toBe('24.18.0');
  expect(report.data.supportedRuntime).toBe(true);
});

async function managedFixture() {
  const base = await fixture(), installation = join(base, '설치 (한글 공백)'), root = join(base, '관리 자료 A');
  await mkdir(installation); await writeFile(join(installation, 'Update.exe'), '합성 설치 표시');
  const register = async (dataRoot: string) => {
    await mkdir(dataRoot);
    await writeFile(join(dataRoot, '체크메이트자료.json'), JSON.stringify({ schemaVersion: 1, kind: 'checkmate-data' }));
  };
  const packageVersion = async (version: string) => {
    const resources = join(installation, `app-${version}`, 'resources');
    const engine = join(resources, 'engine'), node = join(resources, 'node', 'node.exe');
    const cli = join(engine, 'packages', 'engine', 'dist', '명령.js');
    await mkdir(join(resources, 'node'), { recursive: true });
    await mkdir(join(engine, 'packages', 'engine', 'dist', '서비스'), { recursive: true });
    await mkdir(join(engine, 'node_modules', '합성패키지'), { recursive: true });
    await writeFile(node, `합성 Node ${version}`); await writeFile(cli, `// 합성 명령 ${version}`);
    await writeFile(join(engine, 'packages', 'engine', 'dist', '서비스', '상주서비스.js'), '// 합성 서비스');
    await writeFile(join(engine, 'packages', 'engine', 'package.json'), JSON.stringify({ name: '@checkmate/engine', version }));
    await writeFile(join(engine, 'node_modules', '합성패키지', 'index.js'), '// 합성 의존성');
    return { node, cli, resources, version };
  };
  await register(root);
  return { base, installation, root, register, packageVersion, packaged: await packageVersion('0.2.0') };
}

test('한글 공백 경로의 snapshot은 Node와 engine만 복사하고 직접 stdio 인자와 원본 SHA를 보존한다', async () => {
  const f = await managedFixture(), p = f.packaged;
  await writeFile(join(p.resources, '복사제외.txt'), 'GUI 자료');
  const connection = await ensureManagedConnection(f.root, p.node, p.cli, p.version);
  const snapshot = join(f.root, 'bin', '관리런타임', p.version);
  expect(connection).toEqual({ command: join(snapshot, 'node.exe'), args: [join(snapshot, 'engine', 'packages', 'engine', 'dist', '명령.js'),
    '--data-dir', f.root, 'mcp-managed', '--installation-root', f.installation] });
  expect((await readdir(snapshot)).sort()).toEqual(['engine', 'node.exe', '체크메이트런타임.json'].sort());
  for (const [source, destination] of [[p.node, connection.command], [p.cli, connection.args[0]!]] as const)
    expect(createHash('sha256').update(await readFile(destination)).digest('hex')).toBe(createHash('sha256').update(await readFile(source)).digest('hex'));
  expect(await readFile(join(snapshot, 'engine', 'node_modules', '합성패키지', 'index.js'), 'utf8')).toBe('// 합성 의존성');
  expect(await readManagedTarget(f.installation, f.root)).toMatchObject({ nodeExecutable: p.node, version: p.version });
  const descriptorBefore = await readManagedDescriptor(f.installation);
  expect(await ensureManagedConnection(f.root, p.node, p.cli, p.version)).toEqual(connection);
  expect(await readManagedDescriptor(f.installation)).toEqual(descriptorBefore);
}, 30000);

test('두 root의 등록과 기존 snapshot을 보존하며 공통 descriptor 증가만 새 generation을 발행하고 감소는 거절한다', async () => {
  const f = await managedFixture(), p = f.packaged, rootB = join(f.base, '관리 자료 B');
  await f.register(rootB);
  const oldA = await ensureManagedConnection(f.root, p.node, p.cli, p.version);
  const oldDescriptor = await readManagedDescriptor(f.installation);
  const oldB = await ensureManagedConnection(rootB, p.node, p.cli, p.version);
  expect((await readManagedDescriptor(f.installation)).generation).toBe(oldDescriptor.generation);
  const registrationNames = await readdir(join(managedDirectory(f.installation), '자료'));
  const registrationsBefore = await Promise.all(registrationNames.map(name => readFile(join(managedDirectory(f.installation), '자료', name), 'utf8')));
  const next = await f.packageVersion('0.2.1');
  const newA = await ensureManagedConnection(f.root, next.node, next.cli, next.version);
  const upgraded = await readManagedDescriptor(f.installation);
  expect(upgraded).toMatchObject({ version: '0.2.1' }); expect(upgraded.generation).not.toBe(oldDescriptor.generation);
  expect((await readRegisteredRoots(f.installation)).sort()).toEqual([f.root, rootB].sort());
  expect(await readManagedTarget(f.installation, rootB)).toMatchObject({ version: '0.2.1', nodeExecutable: next.node });
  expect(await Promise.all(registrationNames.map(name => readFile(join(managedDirectory(f.installation), '자료', name), 'utf8')))).toEqual(registrationsBefore);
  expect(await readFile(oldA.command, 'utf8')).toBe('합성 Node 0.2.0');
  expect(await readFile(oldB.command, 'utf8')).toBe('합성 Node 0.2.0');
  expect(await readFile(newA.command, 'utf8')).toBe('합성 Node 0.2.1');
  await expect(ensureManagedConnection(rootB, p.node, p.cli, p.version)).rejects.toThrow(/낮출/);
  expect(await readManagedDescriptor(f.installation)).toEqual(upgraded);
}, 60000);

test('snapshot 변조와 표식 없는 기존 버전 폴더를 덮어쓰지 않는다', async () => {
  const f = await managedFixture(), p = f.packaged;
  const connection = await ensureManagedConnection(f.root, p.node, p.cli, p.version);
  await writeFile(connection.command, '변조된 합성 Node');
  const descriptor = await readManagedDescriptor(f.installation);
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/무결성/);
  expect(await readFile(connection.command, 'utf8')).toBe('변조된 합성 Node');
  const next = await f.packageVersion('0.2.1'), snapshot = join(f.root, 'bin', '관리런타임', next.version);
  await mkdir(snapshot); await writeFile(join(snapshot, '사용자.txt'), '보존할 자료');
  await expect(ensureManagedConnection(f.root, next.node, next.cli, next.version)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(snapshot, '사용자.txt'), 'utf8')).toBe('보존할 자료');
  expect(await readManagedDescriptor(f.installation)).toEqual(descriptor);
}, 30000);

test('설치 관리 표식 누락과 외부 CLI 및 잘못된 패키지 버전은 원본을 보존하며 거절한다', async () => {
  const f = await managedFixture(), p = f.packaged;
  await expect(ensureManagedConnection(f.root, process.execPath, p.cli, p.version)).rejects.toThrow(/실제 Squirrel/);
  await expect(ensureManagedConnection(f.root, p.node, join(f.base, '외부명령.js'), p.version)).rejects.toThrow(/정확한 resources/);
  await writeFile(join(p.resources, 'engine', 'packages', 'engine', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/버전/);
  await writeFile(join(p.resources, 'engine', 'packages', 'engine', 'package.json'), JSON.stringify({ version: p.version }));
  await mkdir(managedDirectory(f.installation));
  const original = join(managedDirectory(f.installation), '사용자.txt'); await writeFile(original, '보존');
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/관리 표식/);
  expect(await readFile(original, 'utf8')).toBe('보존');
});

test('원본 하드링크와 자료 링크는 복사하지 않고 외부 원본을 보존한다', async () => {
  const f = await managedFixture(), p = f.packaged;
  const outside = join(f.base, '외부원본.js'); await writeFile(outside, '외부 원본');
  const hardlink = join(p.resources, 'engine', '연결된원본.js'); await link(outside, hardlink);
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/링크/);
  expect(await readFile(outside, 'utf8')).toBe('외부 원본');
  await rm(hardlink);
  const rootB = join(f.base, '링크 자료'); await symlink(f.root, rootB, 'junction');
  await expect(ensureManagedConnection(rootB, p.node, p.cli, p.version)).rejects.toThrow(/링크 경로/);
}, 30000);

test('복사 SHA 불일치는 등록과 descriptor를 발행하지 않고 원본을 보존한다', async () => {
  const f = await managedFixture(), p = f.packaged;
  copying.corrupt = true;
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/복사 SHA256/);
  expect(await readFile(p.node, 'utf8')).toBe('합성 Node 0.2.0');
  await expect(readManagedDescriptor(f.installation)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(join(managedDirectory(f.installation), '자료'))).toEqual([]);
  await expect(readFile(join(f.root, 'bin', '관리런타임', p.version, 'node.exe'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

test('동일 버전 descriptor의 generation 변조와 snapshot 하드링크는 덮어쓰기 없이 거절한다', async () => {
  const f = await managedFixture(), p = f.packaged;
  const connection = await ensureManagedConnection(f.root, p.node, p.cli, p.version);
  const descriptor = await readManagedDescriptor(f.installation), descriptorPath = join(managedDirectory(f.installation), '백엔드.json');
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, generation: randomUUID() }));
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/표식 또는 원본/);
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const outside = join(f.base, 'snapshot 외부원본.exe'); await writeFile(outside, '합성 Node 0.2.0');
  await rm(connection.command); await link(outside, connection.command);
  await expect(ensureManagedConnection(f.root, p.node, p.cli, p.version)).rejects.toThrow(/링크/);
  expect(await readFile(outside, 'utf8')).toBe('합성 Node 0.2.0');
  expect(await readManagedDescriptor(f.installation)).toEqual(descriptor);
}, 30000);

test.each(['rename', 'lock', 'registration', 'descriptor'] as const)('%s 중단 뒤 정상 snapshot과 공유 operation을 다른 root 발행 및 원 root 명시 재확인에 사용한다', async failure => {
  const f = await managedFixture(), p = f.packaged, rootB = join(f.base, '중단 자료 B');
  await f.register(rootB);
  const oldA = await ensureManagedConnection(f.root, p.node, p.cli, p.version);
  const original = await readManagedDescriptor(f.installation);
  const registrationA = join(managedDirectory(f.installation), '자료', `${managedRootKey(f.root)}.json`);
  const originalRegistrationA = await readFile(registrationA, 'utf8');
  const next = await f.packageVersion('0.2.1'), interruptedRoot = failure === 'registration' ? rootB : f.root;
  const publishingRoot = interruptedRoot === f.root ? rootB : f.root;
  const snapshot = join(interruptedRoot, 'bin', '관리런타임', next.version);
  const registration = join(managedDirectory(f.installation), '자료', `${managedRootKey(interruptedRoot)}.json`);
  const descriptorPath = join(managedDirectory(f.installation), '백엔드.json'), lock = join(f.installation, '업데이트잠금.json');
  copying.afterRename = async (_source, target) => {
    if (target !== snapshot) return;
    if (failure === 'rename') throw new Error('합성 rename 이후 중단');
    if (failure === 'lock') await writeFile(lock, JSON.stringify({ id: randomUUID(), pid: process.pid }));
  };
  copying.beforeRename = async (_source, target) => {
    if (failure === 'registration' && target === registration) throw new Error('합성 registration 발행 중단');
    if (failure === 'descriptor' && target === descriptorPath) throw new Error('합성 descriptor 발행 중단');
  };
  await expect(ensureManagedConnection(interruptedRoot, next.node, next.cli, next.version)).rejects.toThrow();
  expect(await readManagedDescriptor(f.installation)).toEqual(original);
  const pendingMarkerPath = join(snapshot, '체크메이트런타임.json'), pendingMarkerText = await readFile(pendingMarkerPath, 'utf8');
  const pendingMarker = JSON.parse(pendingMarkerText) as { generation: string; operationId: string };
  copying.beforeRename = undefined; copying.afterRename = undefined;
  if (failure === 'lock') await rm(lock);
  const otherRoot = await ensureManagedConnection(publishingRoot, next.node, next.cli, next.version);
  const published = await readManagedDescriptor(f.installation);
  expect(published.generation).toBe(pendingMarker.generation); expect(published.generation).not.toBe(original.generation);
  const resumed = await ensureManagedConnection(interruptedRoot, next.node, next.cli, next.version);
  expect(resumed.command).toBe(join(snapshot, 'node.exe'));
  expect(await readFile(pendingMarkerPath, 'utf8')).toBe(pendingMarkerText);
  const otherMarker = JSON.parse(await readFile(join(publishingRoot, 'bin', '관리런타임', next.version, '체크메이트런타임.json'), 'utf8')) as { operationId: string };
  expect(pendingMarker.operationId).toEqual(expect.any(String)); expect(otherMarker.operationId).toBe(pendingMarker.operationId);
  expect(await readFile(oldA.command, 'utf8')).toBe('합성 Node 0.2.0');
  expect(await readFile(otherRoot.command, 'utf8')).toBe('합성 Node 0.2.1');
  expect(await readFile(registrationA, 'utf8')).toBe(originalRegistrationA);
  expect((await readRegisteredRoots(f.installation)).sort()).toEqual([f.root, rootB].sort());
  expect(await readManagedDescriptor(f.installation)).toEqual(published);
}, 60000);

test('중단 발행의 identity, generation, operation 및 복사 지문 변조는 기록을 보존하며 거절한다', async () => {
  const f = await managedFixture(), p = f.packaged;
  const old = await ensureManagedConnection(f.root, p.node, p.cli, p.version), descriptor = await readManagedDescriptor(f.installation);
  const next = await f.packageVersion('0.2.1'), snapshot = join(f.root, 'bin', '관리런타임', next.version);
  copying.beforeRename = async (_source, target) => {
    if (target === join(managedDirectory(f.installation), '백엔드.json')) throw new Error('합성 descriptor 발행 중단');
  };
  await expect(ensureManagedConnection(f.root, next.node, next.cli, next.version)).rejects.toThrow('합성 descriptor');
  copying.beforeRename = undefined;
  const markerPath = join(snapshot, '체크메이트런타임.json'), journalPath = join(managedDirectory(f.installation), `발행준비-${next.version}.json`);
  const originalMarkerText = await readFile(markerPath, 'utf8'), originalJournalText = await readFile(journalPath, 'utf8');
  const marker = JSON.parse(originalMarkerText) as Record<string, unknown>;
  for (const patch of [{ dataRoot: f.base }, { generation: randomUUID() }, { operationId: randomUUID() }]) {
    const changed = JSON.stringify({ ...marker, ...patch }); await writeFile(markerPath, changed);
    await expect(ensureManagedConnection(f.root, next.node, next.cli, next.version)).rejects.toThrow(/표식 또는 원본/);
    expect(await readFile(markerPath, 'utf8')).toBe(changed); expect(await readManagedDescriptor(f.installation)).toEqual(descriptor);
  }
  await writeFile(markerPath, originalMarkerText);
  const copiedNode = join(snapshot, 'node.exe'), originalNode = await readFile(copiedNode);
  await writeFile(copiedNode, '변조된 중단 복사');
  await expect(ensureManagedConnection(f.root, next.node, next.cli, next.version)).rejects.toThrow(/복사 무결성/);
  expect(await readFile(copiedNode, 'utf8')).toBe('변조된 중단 복사'); await writeFile(copiedNode, originalNode);
  const journal = JSON.parse(originalJournalText) as { backend: { generation: string }; files: Record<string, string> };
  const changedJournal = JSON.stringify({ ...journal, backend: { ...journal.backend, generation: randomUUID() } });
  await writeFile(journalPath, changedJournal);
  await expect(ensureManagedConnection(f.root, next.node, next.cli, next.version)).rejects.toThrow(/표식 또는 원본/);
  expect(await readFile(journalPath, 'utf8')).toBe(changedJournal);
  await writeFile(journalPath, JSON.stringify({ ...journal, files: { ...journal.files, 'node.exe': '0'.repeat(64) } }));
  await expect(ensureManagedConnection(f.root, next.node, next.cli, next.version)).rejects.toThrow(/원본 지문/);
  expect(await readManagedDescriptor(f.installation)).toEqual(descriptor);
  await writeFile(journalPath, originalJournalText);
  expect(await ensureManagedConnection(f.root, next.node, next.cli, next.version)).toMatchObject({ command: copiedNode });
  expect((await readManagedDescriptor(f.installation)).generation).toBe(journal.backend.generation);
  expect(await readFile(markerPath, 'utf8')).toBe(originalMarkerText);
  expect(await readFile(old.command, 'utf8')).toBe('합성 Node 0.2.0');
}, 60000);
