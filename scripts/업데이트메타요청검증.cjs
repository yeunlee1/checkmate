// 실제 Electron 요청과 격리 로컬 서버로 업데이트 목록의 응답 완료 및 중단 경계를 검증한다.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const repository = resolve(__dirname, '..');

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const root = join(repository, '.runtime', '검증', '업데이트메타요청', randomUUID());
  mkdirSync(root, { recursive: true });
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  let failure;
  try {
    execFileSync(require('electron'), [__filename, root], { cwd: repository, env, windowsHide: true, timeout: 45000, stdio: 'pipe' });
  } catch (error) { failure = error; }
  const report = JSON.parse(readFileSync(join(root, '검증결과.json'), 'utf8'));
  console.log(JSON.stringify({ report: join(root, '검증결과.json'), ...report }, null, 2));
  assert.equal(report.passed, true);
  if (failure) throw failure;
} else {
  const { app, net } = require('electron');
  const { createServer } = require('node:http');
  const root = process.argv[2];
  app.setPath('userData', join(root, '격리 화면 자료'));
  app.whenReady().then(async () => {
    const modulePath = join(repository, 'packages', 'desktop', 'dist', 'main', '업데이트메타.js');
    const { readUpdateMetadata } = require(modulePath);
    const source = 'a'.repeat(40) + ' CheckMate-1.0.1-full.nupkg 123';
    const report = { passed: false, evidenceKind: 'actual-electron-loopback', externalNetwork: false, electron: process.versions.electron,
      moduleSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'), cases: [], cleanupVerified: false };
    const server = createServer((request, response) => {
      if (request.url === '/never') return;
      if (request.url === '/partial') {
        response.writeHead(200, { 'Content-Length': '1000' }); response.write(source);
        setTimeout(() => response.destroy(), 40); return;
      }
      setTimeout(() => {
        response.writeHead(200);
        if (request.url === '/bom') response.write(Buffer.from([239]));
        response.end(request.url === '/bom' ? Buffer.concat([Buffer.from([187, 191]), Buffer.from(source)]) : source);
      }, 40);
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      for (const mode of ['normal', 'bom', 'partial', 'never']) {
        const events = []; const started = performance.now(); let aborts = 0;
        const mark = event => events.push({ event, elapsedMs: Math.round(performance.now() - started) });
        const result = readUpdateMetadata(options => {
          assert.equal(options.url, 'https://github.com/yeunlee1/checkmate/releases/latest/download/RELEASES');
          assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit'); assert.equal(options.useSessionCookies, false);
          // 시험 factory에서만 목적지를 바꾸며 제품의 공개 주소와 리디렉션 검사는 변경하지 않는다.
          const request = net.request({ ...options, url: `http://127.0.0.1:${server.address().port}/${mode}` });
          for (const event of ['finish', 'close', 'abort', 'error']) request.on(event, () => mark(`request-${event}`));
          request.on('response', response => {
            mark('response');
            for (const event of ['end', 'aborted', 'error', 'close']) response.on(event, () => mark(`response-${event}`));
          });
          const abort = request.abort.bind(request);
          request.abort = () => { aborts++; mark('abort-called'); return abort(); };
          return request;
        });
        const entry = { mode, passed: false, events };
        report.cases.push(entry);
        if (mode === 'normal' || mode === 'bom') {
          assert.equal(await result, source); assert.equal(aborts, 0);
          assert.ok(events.some(item => item.event === 'response-end'));
          const closedAt = events.findIndex(item => item.event === 'request-close');
          entry.requestClosedBeforeResponse = closedAt >= 0 && closedAt < events.findIndex(item => item.event === 'response');
          assert.equal(entry.requestClosedBeforeResponse, true, '실제 요청의 조기 close 반례를 관측해야 한다.');
        } else {
          await assert.rejects(result, /update-metadata-unavailable/);
          assert.equal(aborts, 1);
          if (mode === 'never') assert.ok(performance.now() - started >= 14900, '조기 close 뒤에도 전체 응답 제한을 기다려야 한다.');
        }
        entry.passed = true; entry.elapsedMs = Math.round(performance.now() - started);
      }
      report.passed = true;
    } catch (error) { report.error = error.message; }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      report.cleanupVerified = true;
      writeFileSync(join(root, '검증결과.json'), JSON.stringify(report, null, 2));
      app.exit(report.passed ? 0 : 1);
    }
  });
}
