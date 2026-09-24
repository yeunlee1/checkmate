// 합성 한글 ZIP으로 Squirrel 압축 실행기와 .NET Packaging의 이름 해석을 검증한다.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, '.runtime', '검증', '설치압축', randomUUID());
const vendor = join(testRoot, 'vendor');
const native = join(vendor, '7z-x64.exe');
const launcher = join(vendor, '7z.exe');
const input = join(testRoot, '입력');
const expected = [
  'lib/net45/resources/engine/가.js',
  'lib/net45/resources/engine/나.js',
  'lib/net45/resources/engine/서비스/상주서비스.js',
  'lib/net45/resources/engine/혼합A(1).js',
  'lib/net45/resources/engine/길이가다른파일이름.js',
  'lib/net45/resources/engine/ascii.js',
];

function run(executable, args, cwd = root, acceptFailure = false) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || (!acceptFailure && result.status !== 0)) {
    throw new Error(`${executable} 실패. ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function zipNames(bytes) {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  assert(end >= 0, 'ZIP 끝 레코드가 없습니다.');
  let at = bytes.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert(bytes.readUInt32LE(at) === 0x02014b50, 'ZIP 중앙 항목이 잘못됐습니다.');
    const flag = bytes.readUInt16LE(at + 8);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const raw = bytes.subarray(at + 46, at + 46 + nameLength);
    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    let original = null;
    for (let cursor = 0; cursor < extra.length;) {
      const kind = extra.readUInt16LE(cursor);
      const length = extra.readUInt16LE(cursor + 2);
      assert(cursor + 4 + length <= extra.length, 'ZIP 추가 영역 길이가 잘못됐습니다.');
      if (kind === 0x7075) original = extra.subarray(cursor + 9, cursor + 4 + length).toString('utf8');
      cursor += 4 + length;
    }
    names.push({ raw: raw.toString((flag & 0x800) ? 'utf8' : 'latin1'), flag, original });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows에서만 검증할 수 있습니다.');
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const compilers = windowsRoot ? [
    join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ] : [];
  const compiler = compilers.find(existsSync);
  if (!compiler) throw new Error('.NET Framework C# 컴파일러가 없습니다.');
  await mkdir(join(input, 'lib', 'net45', 'resources', 'engine'), { recursive: true });
  await mkdir(vendor);
  for (let i = 0; i < expected.length; i++) {
    await mkdir(dirname(join(input, expected[i])), { recursive: true });
    await writeFile(join(input, expected[i]), `자료 ${i} ${expected[i]}`, 'utf8');
  }
  await writeFile(join(input, '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="js" ContentType="application/javascript"/></Types>', 'utf8');
  const originalVendor = join(root, 'node_modules', 'electron-winstaller', 'vendor');
  await copyFile(join(originalVendor, '7z-x64.exe'), native);
  await copyFile(join(originalVendor, '7z-x64.dll'), join(vendor, '7z.dll'));
  run(compiler, ['/nologo', '/target:exe', `/out:${launcher}`, join(root, 'scripts', '압축실행기.cs')]);
  const probeSource = join(testRoot, '패키지검증.cs');
  const probe = join(testRoot, '패키지검증.exe');
  await writeFile(probeSource, `// ZIP 항목을 .NET Framework Packaging으로 읽는다.\nusing System;\nusing System.IO;\nusing System.IO.Packaging;\nclass Probe { static int Main(string[] args) { try { using (Package p = Package.Open(args[0], FileMode.Open, FileAccess.Read)) { foreach (PackagePart part in p.GetParts()) Console.WriteLine(part.Uri.OriginalString); } return 0; } catch (Exception e) { Console.Error.WriteLine(e); return 1; } } }\n`, 'utf8');
  const windowsBase = join(windowsRoot, 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'WindowsBase', 'v4.0_4.0.0.0__31bf3856ad364e35', 'WindowsBase.dll');
  run(compiler, ['/nologo', '/target:exe', `/out:${probe}`, `/r:${windowsBase}`, probeSource]);

  const plain = join(testRoot, '기본.zip');
  const utf8 = join(testRoot, 'UTF8만.zip');
  const fixed = join(testRoot, '수정 경로 (공백).zip');
  for (const [exe, file, extra] of [[native, plain, []], [native, utf8, ['-mcu=on']], [launcher, fixed, []]]) {
    run(exe, ['a', file, '-tzip', '-aoa', '-y', '-mmt', 'on', '*', ...extra], input);
  }
  const basic = run(probe, [plain], root, true);
  const utf8Only = run(probe, [utf8], root, true);
  const corrected = run(probe, [fixed]);
  assert(basic.status !== 0 && basic.stderr.includes('ArgumentException'), '기본 ZIP의 .NET 중복 오류가 재현되지 않았습니다.');
  assert(utf8Only.status !== 0 && utf8Only.stderr.includes('ArgumentException'), 'UTF-8 옵션만으로는 남는 .NET 중복 오류가 재현되지 않았습니다.');
  const entries = zipNames(await readFile(fixed));
  for (const name of expected) {
    const nonAscii = /[^\x00-\x7f]/.test(name);
    const entry = entries.find(item => (nonAscii ? item.original : item.raw) === name);
    assert(entry && entry.flag === 0 && /^[\x00-\x7f]+$/.test(entry.raw), `ZIP 이름이 잘못됐습니다. ${name}`);
    assert(corrected.stdout.includes(encodeURI(`/${name}`)), `.NET Packaging이 항목을 읽지 못했습니다. ${name}`);
  }
  const extracted = join(testRoot, '추출');
  run(native, ['x', fixed, '-tzip', '-aoa', '-y', `-o${extracted}`, '*']);
  const hashes = [];
  for (const name of expected) {
    const sourceHash = sha256(await readFile(join(input, name)));
    const extractedHash = sha256(await readFile(join(extracted, name)));
    assert(sourceHash === extractedHash, `압축 해제 후 원본 SHA256이 다릅니다. ${name}`);
    hashes.push({ name, sourceSha256: sourceHash, extractedSha256: extractedHash });
  }
  const collisionInput = join(testRoot, '충돌입력');
  const collisionName = 'lib/net45/resources/engine/%EA%B0%80.js';
  await mkdir(dirname(join(collisionInput, collisionName)), { recursive: true });
  await writeFile(join(collisionInput, expected[0]), '가', 'utf8');
  await writeFile(join(collisionInput, collisionName), 'alias', 'utf8');
  await writeFile(join(collisionInput, '[Content_Types].xml'), await readFile(join(input, '[Content_Types].xml')));
  const collision = run(launcher, ['a', join(testRoot, '충돌.zip'), '-tzip', '-aoa', '-y', '-mmt', 'on', '*'], collisionInput, true);
  assert(collision.status === 1 && collision.stderr.includes('System.IO.InvalidDataException'), '대체 이름 충돌을 오류로 차단하지 못했습니다.');
  const defaultFlag = zipNames(await readFile(plain)).find(item => item.raw.endsWith('.js') && /[^\x00-\x7f]/.test(item.raw))?.flag;
  const utf8OnlyFlag = zipNames(await readFile(utf8)).find(item => item.raw === expected[0])?.flag;
  assert(defaultFlag === 0 && utf8OnlyFlag === 0x800, '기본 ZIP과 UTF-8 옵션 ZIP의 이름 표시가 예상과 다릅니다.');
  console.log(JSON.stringify({ status: 'passed', testRoot, defaultFlag, utf8OnlyFlag, corrected: entries.filter(item => item.original).map(item => ({ alias: item.raw, original: item.original, flag: item.flag })), packaging: corrected.stdout.trim().split(/\r?\n/), hashes, collisionRejected: true }, null, 2));
}

main().catch(error => { console.error(error); console.error(`검증 폴더: ${testRoot}`); process.exitCode = 1; });
