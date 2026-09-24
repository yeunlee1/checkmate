// 포장 원본과 실제 설치 파일의 이름 및 바이트 해시를 대조한다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.argv.length !== 4) throw new Error('포장 앱 폴더와 설치된 앱 버전 폴더를 지정해 주세요.');
const packaged = resolve(process.argv[2]);
const installed = resolve(process.argv[3]);
assert.notEqual(packaged, installed, '서로 다른 원본과 설치 폴더가 필요합니다.');
const results = [];
const missing = [];
async function hash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
async function visit(relative = '') {
  for (const entry of await readdir(join(packaged, relative), { withFileTypes: true })) {
    const child = join(relative, entry.name);
    assert.equal(entry.isSymbolicLink(), false, '포장 원본의 링크는 허용하지 않습니다.');
    if (entry.isDirectory()) await visit(child);
    else {
      assert.equal(entry.isFile(), true);
      const before = await hash(join(packaged, child));
      let after;
      try { after = await hash(join(installed, child)); }
      catch (error) { if (error.code === 'ENOENT') { missing.push(child); continue; } throw error; }
      results.push({ path: child, sourceSha256: before, installedSha256: after, matched: after === before });
    }
  }
}
await visit();
const summary = { passed: missing.length === 0 && results.every(row => row.matched), packaged, installed,
  files: results.length, missing, mismatched: results.filter(row => !row.matched).map(row => row.path),
  koreanPaths: results.filter(row => /[가-힣]/u.test(row.path)).length };
const reportRoot = resolve('.runtime/검증/설치파일', randomUUID());
await mkdir(reportRoot, { recursive: true });
await writeFile(join(reportRoot, '검증결과.json'), JSON.stringify({ ...summary, results }, null, 2));
console.log(JSON.stringify({ ...summary, report: join(reportRoot, '검증결과.json') }));
assert.equal(summary.passed, true, '설치 파일이 포장 원본과 다릅니다.');
