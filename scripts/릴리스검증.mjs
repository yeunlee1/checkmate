// 공개 업데이트의 소스 버전과 main 계보 및 설치 산출물 지문을 검증한다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseVersion(manifests, tag) {
  const version = manifests[0]?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/.test(version) || manifests.some(item => item.version !== version)) throw new Error('패키지 버전이 일치하지 않습니다.');
  for (const manifest of manifests) {
    if (Object.entries(manifest.dependencies ?? {}).some(([name, required]) => name.startsWith('@checkmate/') && required !== version)) throw new Error('내부 패키지 의존성 버전이 일치하지 않습니다.');
  }
  if (tag && (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || tag !== `v${version}`)) throw new Error('정식 버전 태그와 소스 버전이 일치해야 합니다.');
  return version;
}
export function requiresSignature(refType, allowUnsigned) {
  return refType === 'tag' && allowUnsigned !== 'true';
}
const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function digest(file, algorithm) {
  const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function source(tag) {
  const files = ['package.json', 'packages/contracts/package.json', 'packages/engine/package.json', 'packages/desktop/package.json'];
  const manifests = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const locked = ['', 'packages/contracts', 'packages/engine', 'packages/desktop'].map(name => lock.packages[name]);
  const version = releaseVersion([...manifests, ...locked, { version: lock.version }], tag);
  if (git(['status', '--porcelain'])) throw new Error('깨끗한 소스로 제작해야 합니다.');
  if (tag) {
    git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
    if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', `${tag}^{commit}`])) throw new Error('태그가 현재 소스가 아닙니다.');
  }
  return { version, commit: git(['rev-parse', 'HEAD']) };
}
export async function verifyArtifacts(report, identity) {
  if (identity.requireSigned && report.signed !== true) throw new Error('정식 배포에는 유효한 서명과 타임스탬프가 필요합니다.');
  if (report.status !== 'passed' || report.source?.dirtyAtStart !== false || report.source?.dirtyAtEnd !== false || report.source?.commit !== identity.commit || report.version !== identity.version) throw new Error('제작 소스와 결과가 일치하지 않습니다.');
  if (!Array.isArray(report.artifacts) || report.artifacts.length !== 3) throw new Error('설치 산출물 세 개가 필요합니다.');
  const entries = report.artifacts;
  const release = entries.find(item => basename(item.path) === 'RELEASES');
  const installer = entries.find(item => basename(item.path) === 'CheckMate-개발설치.exe');
  const packageFile = entries.find(item => /^[A-Za-z0-9_.-]+-full\.nupkg$/.test(basename(item.path)));
  if (!release || !installer || !packageFile) throw new Error('설치본·전체 패키지·RELEASES가 필요합니다.');
  const folder = dirname(resolve(release.path));
  const lines = [];
  for (const item of entries) {
    const stat = await lstat(item.path);
    if (dirname(resolve(item.path)) !== folder || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || await digest(item.path, 'sha256') !== item.sha256) throw new Error('산출물 지문이나 경로가 다릅니다.');
    lines.push(`${item.sha256}  ${basename(item.path)}`);
  }
  const feed = (await readFile(release.path, 'utf8')).trim().split(/\r?\n/);
  if (feed.length !== 1) throw new Error('전체 패키지 하나의 업데이트 목록이 필요합니다.');
  const match = feed[0].match(/^([a-f0-9]{40})\s+([^\s/\\]+)\s+(\d+)$/i);
  if (!match || match[2] !== basename(packageFile.path) || match[1].toLowerCase() !== await digest(packageFile.path, 'sha1') || Number(match[3]) !== (await lstat(packageFile.path)).size) throw new Error('RELEASES 지문·파일명·크기가 다릅니다.');
  return { folder, checksums: lines.join('\n') + '\n' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, argument] = process.argv.slice(2);
  if (mode === 'source') console.log(JSON.stringify(await source(argument)));
  else if (mode === 'artifacts' && argument) {
    const checked = await verifyArtifacts(JSON.parse(await readFile(argument, 'utf8')), { ...await source(), requireSigned: requiresSignature(process.env.GITHUB_REF_TYPE, process.env.CHECKMATE_ALLOW_UNSIGNED_RELEASE) });
    await writeFile(resolve(checked.folder, 'SHA256SUMS.txt'), checked.checksums, { flag: 'wx' });
    console.log(JSON.stringify({ verified: true, folder: checked.folder }));
  } else throw new Error('source [태그] 또는 artifacts <제작보고서>를 지정해 주세요.');
}
