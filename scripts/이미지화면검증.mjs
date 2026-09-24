// 합성 대형 PNG를 실제 Chromium 화면에 표시하고 잘못된 base64를 거절하는지 검증한다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.runtime', '검증', `큰이미지-${randomUUID()}`);
const side = 1024;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function syntheticPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  let seed = 0x12345678;
  for (let row = 0; row < height; row++) {
    const start = row * (1 + width * 4);
    for (let index = start + 1; index < start + 1 + width * 4; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(output, { recursive: true });
const png = syntheticPng(side, side);
assert.ok(png.length > 4 * 1024 * 1024 && png.length <= 8 * 1024 * 1024);
const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
const props = { imageDataUrl, imageWidth: side, imageHeight: side,
  screenshotEvidenceId: '12345678-1234-4234-8234-123456789abc' };
await writeFile(join(output, '합성화면.png'), png);
await writeFile(join(output, '화면검증.html'), '<!-- 합성 PNG 화면 검증 페이지. -->\n<!doctype html><html lang="ko"><meta charset="utf-8"><div id="root"></div><script type="module" src="/화면검증.tsx"></script></html>');
const componentPath = relative(output, join(root, 'packages/desktop/src/renderer/증거시각화.tsx')).replaceAll('\\', '/');
await writeFile(join(output, '화면검증.tsx'), `// 실제 증거 화면 컴포넌트를 Chromium에 마운트한다.\nimport { flushSync } from 'react-dom';\nimport { createRoot } from 'react-dom/client';\nimport { VisualEvidence } from './${componentPath}';\nconst root = createRoot(document.getElementById('root')!);\nwindow.testRender = props => flushSync(() => root.render(<VisualEvidence {...props} />));\n`);

const server = await createServer({ configFile: false, root: output, cacheDir: join(output, '화면캐시'),
  oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } });
let browser;
const result = { pngBytes: png.length, sha256: createHash('sha256').update(png).digest('hex'),
  output, checks: [], pageErrors: [] };
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => result.pageErrors.push(`${error.name}: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/화면검증.html`);
  await page.waitForFunction(() => typeof window.testRender === 'function');
  await page.evaluate(value => window.testRender(value), props);
  const image = page.getByRole('img', { name: '검사 당시 화면 캡처' });
  await image.waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('.visual-evidence img');
    return element?.complete && element.naturalWidth === 1024 && element.naturalHeight === 1024;
  });
  assert.equal(await page.locator('#root > *').count(), 1);
  assert.equal(result.pageErrors.length, 0, JSON.stringify(result.pageErrors));
  await page.screenshot({ path: join(output, '큰PNG-정상표시.png'), fullPage: true });
  result.checks.push({ name: '큰 PNG 렌더', passed: true, naturalWidth: 1024, naturalHeight: 1024 });

  const prefix = 'data:image/png;base64,';
  const base64 = imageDataUrl.slice(prefix.length);
  const invalid = [
    ['잘못된 padding', prefix + base64.slice(0, -4) + 'A==='],
    ['중간 padding', prefix + base64.slice(0, -8) + '=AAA' + base64.slice(-4)],
    ['잘못된 문자', prefix + base64.slice(0, -8) + '#AAA' + base64.slice(-4)],
    ['크기 불일치', imageDataUrl, side + 1],
    ['8MiB 초과', prefix + base64.slice(0, 44) + 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4 - 44)],
  ];
  for (const [name, url, width = side] of invalid) {
    await page.evaluate(value => window.testRender(value), { ...props, imageDataUrl: url, imageWidth: width });
    await page.getByText('캡처와 디자인 증거를 안전하게 연결할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(await page.locator('.visual-evidence img').count(), 0, name);
    assert.equal(await page.locator('#root > *').count(), 1, name);
    assert.equal(result.pageErrors.length, 0, JSON.stringify(result.pageErrors));
    result.checks.push({ name, passed: true });
  }
  await writeFile(join(output, '결과.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await server.close();
}
