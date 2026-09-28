// 검증된 정식 버전을 초안에 모두 업로드한 뒤 최신 공개 릴리스로 게시한다.
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function newerVersion(tag, previous) {
  const parse = value => {
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) throw new Error('정식 버전 태그가 아닙니다.');
    return value.slice(1).split('.').map(BigInt);
  };
  const next = parse(tag); if (previous === null) return true;
  const old = parse(previous);
  for (let i = 0; i < next.length; i++) { if (next[i] !== old[i]) return next[i] > old[i]; }
  return false;
}
export function releaseNotes(allowUnsigned) {
  return allowUnsigned === 'true'
    ? '코드 서명되지 않은 Windows x64 설치본입니다. Windows 보안 경고가 표시되거나 조직 정책에 따라 실행이 차단될 수 있습니다. 자동 업데이트 확인과 다운로드·재시작 적용 기능을 포함하며 기존 자료 폴더는 유지됩니다. 설치본과 업데이트 패키지의 지문은 SHA256SUMS.txt에서 확인할 수 있습니다. 이번 첫 공개 버전은 공개 버전 간 업데이트 수용을 아직 검증하지 않았습니다. 자동 업데이트가 없는 이전 개발 설치본은 이번 설치본을 직접 설치해야 합니다.'
    : '서명과 타임스탬프를 검증한 Windows x64 업데이트입니다. 기존 자료 폴더는 유지됩니다.';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, directory] = process.argv.slice(2);
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF_TYPE !== 'tag' || tag !== process.env.GITHUB_REF_NAME || process.env.GH_REPO !== 'yeunlee1/checkmate' || !process.env.GH_TOKEN) throw new Error('승인한 저장소의 태그 배포에서만 게시합니다.');
  const response = await fetch('https://api.github.com/repos/yeunlee1/checkmate/releases/latest', {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 404 && !response.ok) throw new Error(`최신 릴리스 조회 실패. HTTP ${response.status}`);
  const previous = response.status === 404 ? null : (await response.json()).tag_name;
  if (!newerVersion(tag, previous)) throw new Error('현재 최신 버전보다 높은 버전만 게시합니다.');
  const files = (await readdir(directory)).sort();
  if (files.length !== 4 || !files.includes('RELEASES') || !files.includes('SHA256SUMS.txt') || !files.includes('CheckMate-개발설치.exe') || !files.some(file => /^[A-Za-z0-9_.-]+-full\.nupkg$/.test(file))) throw new Error('검증된 네 산출물만 게시합니다.');
  const gh = args => execFileSync('gh', args, { stdio: 'inherit', shell: false, windowsHide: true });
  gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', `체크메이트 ${tag}`, '--notes', releaseNotes(process.env.CHECKMATE_ALLOW_UNSIGNED_RELEASE)]);
  gh(['release', 'upload', tag, ...files.map(file => resolve(directory, file))]);
  gh(['release', 'edit', tag, '--draft=false', '--latest']);
}
