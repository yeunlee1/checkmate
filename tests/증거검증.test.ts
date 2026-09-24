// 합성 파일로 증거 경로와 크기 및 해시 검증 경계를 확인한다.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyEvidence, type EvidenceManifestEntry } from '../packages/engine/src/증거검증.js';

const tempBase = resolve(tmpdir());
let root: string;
let outside: string;

function entry(relativePath: string, bytes: Buffer): EvidenceManifestEntry {
  return {
    relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  };
}

function assertOwned(path: string): void {
  const absolute = resolve(path);
  const remainder = relative(tempBase, absolute);
  if (!isAbsolute(path) || isAbsolute(remainder) || remainder.startsWith('..')
    || (absolute !== root && absolute !== outside)) {
    throw new Error('시험에서 생성한 폴더만 정리할 수 있습니다.');
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tempBase, 'checkmate-evidence-root-'));
  outside = await mkdtemp(join(tempBase, 'checkmate-evidence-outside-'));
});

afterAll(async () => {
  for (const path of [root, outside]) {
    if (!path) continue;
    assertOwned(path);
    await rm(path, { recursive: true, force: true });
  }
});

describe('증거 파일 검증', () => {
  it('정상 파일과 빈 파일을 읽기 전용으로 검증한다.', async () => {
    const content = Buffer.from('실제 증거\n', 'utf8');
    await writeFile(join(root, '정상.txt'), content);
    await writeFile(join(root, '빈파일.txt'), Buffer.alloc(0));
    expect(await verifyEvidence(root, entry('정상.txt', content))).toEqual({ status: 'verified' });
    expect(await verifyEvidence(root, entry('빈파일.txt', Buffer.alloc(0)))).toEqual({ status: 'verified' });
  });

  it('한글과 공백이 있는 하위 경로를 검증한다.', async () => {
    const content = Buffer.from('한글 경로');
    await mkdir(join(root, '증거 폴더'));
    await writeFile(join(root, '증거 폴더', '실행 결과.txt'), content);
    expect(await verifyEvidence(root, entry('증거 폴더/실행 결과.txt', content))).toEqual({ status: 'verified' });
  });

  it('누락과 디렉터리 및 일반 파일이 아닌 경로를 구분한다.', async () => {
    const empty = entry('없음.txt', Buffer.alloc(0));
    expect(await verifyEvidence(root, empty)).toEqual({ status: 'missing' });
    expect(await verifyEvidence(root, { ...empty, relativePath: '증거 폴더' })).toEqual({ status: 'not-file' });
    expect(await verifyEvidence(root, { ...empty, relativePath: '정상.txt/하위' })).toEqual({ status: 'not-file' });
  });

  it('크기와 해시 불일치를 구분한다.', async () => {
    const content = Buffer.from('실제 증거\n');
    const manifest = entry('정상.txt', content);
    expect(await verifyEvidence(root, { ...manifest, byteLength: content.length - 1 })).toEqual({ status: 'size-mismatch' });
    expect(await verifyEvidence(root, { ...manifest, sha256: '0'.repeat(64) })).toEqual({ status: 'hash-mismatch' });
  });

  it('잘못된 manifest 필드를 거절한다.', async () => {
    const manifest = entry('정상.txt', Buffer.from('실제 증거\n'));
    expect(await verifyEvidence(root, { ...manifest, byteLength: -1 })).toEqual({ status: 'invalid-manifest' });
    expect(await verifyEvidence(root, { ...manifest, sha256: 'INVALID' })).toEqual({ status: 'invalid-manifest' });
    expect(await verifyEvidence(root, { ...manifest, extra: true })).toEqual({ status: 'invalid-manifest' });
    expect(await verifyEvidence(root, new Proxy({}, { ownKeys: () => { throw new Error('비밀 내용'); } })))
      .toEqual({ status: 'invalid-manifest' });
  });

  it.each([
    '../밖.txt', '증거 폴더/../정상.txt', './정상.txt', '증거 폴더//실행 결과.txt',
    '/절대.txt', 'C:/절대.txt', 'C:상대.txt', '\\\\server\\share\\증거.txt',
    '증거 폴더\\실행 결과.txt', '정상.txt:stream', 'CON.txt', '끝공백 ', '끝점.',
  ])('이탈 또는 Windows 혼동 경로 %s를 거절한다.', async (relativePath) => {
    const manifest = entry(relativePath, Buffer.alloc(0));
    expect(await verifyEvidence(root, manifest)).toEqual({ status: 'unsafe-path' });
  });

  it('링크가 실행별 폴더 밖을 가리키면 거절한다.', async () => {
    const content = Buffer.from('외부 파일');
    await writeFile(join(outside, '외부.txt'), content);
    const link = join(root, '외부링크');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(await verifyEvidence(root, entry('외부링크/외부.txt', content))).toEqual({ status: 'unsafe-path' });
      expect(await verifyEvidence(link, entry('외부.txt', content))).toEqual({ status: 'unsafe-path' });
    } finally {
      const remainder = relative(root, link);
      if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) throw new Error('링크 정리 범위를 벗어났습니다.');
      await unlink(link);
    }
  });
});
