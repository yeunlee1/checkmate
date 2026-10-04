// 합성 bridge와 Chromium으로 프로젝트 자료 폴더 화면의 이전 경계와 복구 흐름을 검증한다.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(repository, '.runtime', '프로젝트저장폴더', '화면구현');
const runRoot = join(artifacts, randomUUID());
const renderer = join(repository, 'packages', 'desktop', 'dist', 'renderer');
const previewMode = process.argv.includes('--preview');
const projectA = '00000000-0000-4000-8000-000000000001';
const projectB = '00000000-0000-4000-8000-000000000002';
const workspaceA = '00000000-0000-4000-8000-000000000011';
const workspaceB = '00000000-0000-4000-8000-000000000012';
const report = { evidenceKind: 'synthetic-bridge-chromium', actualEngine: false, osPicker: false, actualService: false,
  actualDatabase: false, actualMcp: false, installation: false, startedAt: new Date().toISOString(), cases: [], errors: [], files: {} };
let browser;
let server;
await mkdir(runRoot, { recursive: true });

function syntheticBridge({ projectA, projectB, workspaceA, workspaceB, supported }) {
  const fixture = { calls: [], directories: ['/synthetic/materials'], held: {}, delays: {}, previewError: null,
    applyError: null, applyLost: false, queryState: 'completed', invalidResult: false,
    settings: {}, previews: {}, operations: {} };
  for (const projectId of [projectA, projectB]) fixture.settings[projectId] = { projectId, configuredRoot: null, namespaceId: null,
    revision: 0, defaultRunsRoot: `/synthetic/default/${projectId}/runs`, layoutVersion: 1 };
  window.syntheticStorage = fixture;
  const wait = (method, value) => {
    if (!fixture.delays[method]) return Promise.resolve(value);
    fixture.delays[method] = false;
    return new Promise(resolve => { fixture.held[method] = () => { delete fixture.held[method]; resolve(value); }; });
  };
  window.checkmate = {
    chooseDirectory: async purpose => {
      fixture.calls.push({ method: 'choose-directory', purpose });
      return wait('choose-directory', fixture.directories.shift() ?? null);
    },
    connectionInfo: async () => ({ version: 'synthetic', dataPath: '/synthetic/data', mcpCommand: { command: 'synthetic-node', args: [] } }),
    update: async () => ({ status: 'unsupported', currentVersion: 'synthetic' }),
    request: async (method, input = {}, requestId = crypto.randomUUID()) => {
      fixture.calls.push({ method, input: structuredClone(input), requestId });
      const ok = data => ({ apiVersion: 1, requestId, ok: true, data });
      const error = code => ({ apiVersion: 1, requestId, ok: false, error: { code, message: '합성 이전 오류', retryable: false, nextAction: '원본과 대상을 확인해 주세요.' } });
      if (method === 'capabilities') return ok({ capabilities: ['multi-workspace', ...(supported ? ['project-storage'] : [])], connection: { dataRoot: '/synthetic/data' } });
      if (method === 'projects') return ok({ items: [
        { id: projectA, workspaceId: workspaceA, name: '합성 프로젝트 A', realPath: '/synthetic/a', repositoryIdentity: 'synthetic:a', activeCatalogHash: 'd'.repeat(64), profiles: [{ id: 'quick', title: '합성 검사' }] },
        { id: projectB, workspaceId: workspaceB, name: '합성 프로젝트 B', realPath: '/synthetic/b', repositoryIdentity: 'synthetic:b', activeCatalogHash: 'd'.repeat(64), profiles: [{ id: 'quick', title: '합성 검사' }] },
        { id: projectA, workspaceId: '00000000-0000-4000-8000-000000000013', name: '합성 프로젝트 A 다른 작업 폴더', realPath: '/synthetic/a-worktree', repositoryIdentity: 'synthetic:a', activeCatalogHash: 'd'.repeat(64), profiles: [{ id: 'quick', title: '합성 검사' }] },
      ], nextCursor: null, total: 3 });
      if (['checks', 'history', 'gaps'].includes(method)) return ok({ items: [], nextCursor: null, total: 0 });
      if (method === 'project-storage') return wait(method, ok(structuredClone(fixture.settings[input.projectId])));
      if (method === 'preview-project-storage') {
        if (fixture.previewError) return wait(method, error(fixture.previewError));
        const settings = fixture.settings[input.projectId];
        const preview = { projectId: input.projectId, previewId: crypto.randomUUID(), expectedRevision: input.expectedRevision,
          currentRoot: settings.configuredRoot, targetRoot: input.root, destinationRoot: input.root === null ? settings.defaultRunsRoot : `${input.root}/CheckMate/${input.projectId}/synthetic-namespace`,
          fingerprint: 'a'.repeat(64), runCount: 2, fileCount: 7, byteLength: 12345, originalsPreserved: true };
        fixture.previews[preview.previewId] = preview;
        return wait(method, ok(preview));
      }
      if (method === 'apply-project-storage') {
        if (fixture.applyError) return wait(method, error(fixture.applyError));
        const preview = fixture.previews[input.previewId];
        const settings = { ...fixture.settings[input.projectId], configuredRoot: preview.targetRoot,
          namespaceId: preview.targetRoot === null ? null : '00000000-0000-4000-8000-000000000031', revision: input.expectedRevision + 1 };
        fixture.settings[input.projectId] = settings;
        const result = { settings, operationId: fixture.invalidResult ? crypto.randomUUID() : requestId,
          movedRunCount: preview.runCount, fileCount: preview.fileCount, byteLength: preview.byteLength, originalsPreserved: true };
        fixture.operations[requestId] = result;
        await wait(method, null);
        if (fixture.applyLost) throw new Error('synthetic response loss');
        return ok(result);
      }
      if (method === 'project-storage-operation') return wait(method, ok({ projectId: input.projectId, operationId: input.operationId,
        state: fixture.queryState, ...(fixture.queryState === 'completed' ? { result: fixture.operations[input.operationId] } : {}),
        ...(fixture.queryState === 'failed' ? { error: 'storage-conflict' } : {}) }));
      if (method === 'inspect') return ok({ planId: crypto.randomUUID(), projectId: input.projectId, workspaceId: input.workspaceId,
        profile: input.profile, fingerprint: 'b'.repeat(64), sourceHash: 'c'.repeat(64), checks: [], commands: [], writes: [], resourceEffects: [], needsApproval: true,
        outputStorage: { ...fixture.settings[input.projectId], runsRoot: '/synthetic/plan/runs' } });
      if (method === 'approve') return ok({ approvalId: crypto.randomUUID() });
      throw new Error(`Unexpected synthetic method: ${method}`);
    },
  };
}

async function record(name, work) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push({ case: name, message: error.message }));
  await page.addInitScript(syntheticBridge, { projectA, projectB, workspaceA, workspaceB, supported: name !== '구 서비스 기능 제한' });
  try { await work(page, context); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: error.stack ?? String(error) }); throw error; }
  finally { await context.close(); }
}
async function open(page, project = workspaceA) {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByTestId('project-select').selectOption(project);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('storage-current')).toBeVisible();
}
async function preview(page) {
  await page.getByTestId('storage-choose').click();
  await expect(page.getByTestId('storage-preview')).toBeVisible();
}
async function apply(page) {
  await page.getByTestId('storage-confirm').check();
  await page.getByTestId('storage-apply').click();
}
async function calls(page, method) { return page.evaluate(method => window.syntheticStorage.calls.filter(call => call.method === method), method); }
async function held(page, method) { await expect.poll(() => page.evaluate(method => !!window.syntheticStorage.held[method], method)).toBe(true); }
async function release(page, method) { await page.evaluate(method => window.syntheticStorage.held[method](), method); }

try {
  const harness = await build({ stdin: { contents: `// 합성 연결 경계의 실제 화면 컴포넌트를 제어한다.
import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
import { ProjectStorageFolder } from './packages/desktop/src/renderer/프로젝트자료폴더.tsx';
function Harness() { const [scope, change] = useState({ projectId: '${projectA}', connectionKey: 'synthetic-connection-a', generation: 1 });
 const [busy, setBusy] = useState(false); window.syntheticScope = change;
 return <ProjectStorageFolder {...scope} projectName="합성 프로젝트" supported available disabled={busy}
 acquire={() => { setBusy(true); return true; }} release={() => setBusy(false)} onApplied={() => { window.syntheticApplied = (window.syntheticApplied ?? 0) + 1; }} />; }
createRoot(document.getElementById('root')).render(<Harness />);`, resolveDir: repository, loader: 'tsx' },
    bundle: true, write: false, format: 'esm', platform: 'browser' });
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (previewMode && path === '/synthetic-bridge.js') { response.setHeader('Content-Type', 'text/javascript');
        response.end(`(${syntheticBridge.toString()})(${JSON.stringify({ projectA, projectB, workspaceA, workspaceB, supported: true })});`); return; }
      if (path === '/synthetic-harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(harness.outputFiles[0].contents); return; }
      if (path === '/synthetic-harness') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>합성 화면 경계 검사</title><div id="root"></div><script type="module" src="/synthetic-harness.js"></script></html>'); return; }
      const file = resolve(renderer, path === '/' ? 'index.html' : path.slice(1));
      const within = relative(renderer, file);
      assert.ok(within !== '..' && !within.startsWith(`..${sep}`));
      response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream');
      const content = await readFile(file);
      response.end(previewMode && path === '/' ? content.toString('utf8').replace('<head>', '<head><script src="/synthetic-bridge.js"></script>')
        .replace('<body>', '<body><p style="margin:0;padding:8px;background:#fff3cd">합성 bridge 미리보기. 실제 엔진과 OS 폴더 선택은 연결하지 않습니다.</p>') : content);
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  if (previewMode) {
    console.log(JSON.stringify({ evidenceKind: report.evidenceKind, previewUrl: `http://127.0.0.1:${server.address().port}/`, actualService: false }));
    await new Promise(() => {});
  }
  browser = await chromium.launch({ headless: true });
  await record('선택 취소와 미리보기 취소', async page => {
    await open(page); await page.evaluate(() => { window.syntheticStorage.directories = [null, '/synthetic/materials']; });
    await page.getByTestId('storage-choose').click();
    assert.equal((await calls(page, 'preview-project-storage')).length, 0);
    await preview(page); await page.getByTestId('storage-cancel').click();
    await expect(page.getByTestId('storage-preview')).toHaveCount(0);
    assert.equal((await calls(page, 'apply-project-storage')).length, 0);
  });
  await record('정상 확인과 기본 복귀 및 언어와 창 너비', async page => {
    await open(page); await preview(page); await expect(page.getByTestId('storage-apply')).toBeDisabled();
    await expect(page.getByTestId('storage-preview')).toContainText('12,345 byte');
    await page.screenshot({ path: join(runRoot, '한국어이전미리보기.png'), fullPage: true });
    for (const language of ['en', 'ko']) {
      await page.getByTestId('language-select').selectOption(language);
      for (const width of [390, 800, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const overflow = await page.getByTestId('project-storage-panel').evaluate(element => {
          const panel = element.getBoundingClientRect();
          return { overflow: element.scrollWidth > element.clientWidth + 1, elements: [...element.querySelectorAll('*')]
            .filter(item => item.getBoundingClientRect().right > panel.right + 1).map(item => ({ tag: item.tagName, className: item.className, text: item.textContent.slice(0, 120) })) };
        });
        assert.equal(overflow.overflow, false, `${language} ${width} panel overflow ${JSON.stringify(overflow.elements)}`);
        if (width === 390 || width === 800) await page.screenshot({ path: join(runRoot, `${language === 'ko' ? '한국어' : '영어'}${width}미리보기.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await apply(page); await expect(page.getByTestId('storage-success')).toBeVisible();
    await expect(page.getByTestId('storage-current')).toHaveText('/synthetic/materials');
    const [write] = await calls(page, 'apply-project-storage'), [review] = await calls(page, 'preview-project-storage');
    assert.notEqual(write.requestId, write.input.previewId); assert.equal(write.input.previewId, review ? await page.evaluate(() => Object.values(window.syntheticStorage.previews)[0].previewId) : 'missing');
    assert.equal(write.input.confirm, true); assert.equal(write.input.fingerprint, 'a'.repeat(64));
    assert.deepEqual(Object.keys(write.input).sort(), ['confirm', 'expectedRevision', 'fingerprint', 'previewId', 'projectId']);
    await page.getByTestId('storage-reset').click(); await expect(page.getByTestId('storage-preview')).toBeVisible();
    await expect(page.getByTestId('storage-confirm')).not.toBeChecked();
    assert.equal((await calls(page, 'apply-project-storage')).length, 1);
    assert.equal((await calls(page, 'preview-project-storage')).at(-1).input.root, null);
    await apply(page); await expect(page.getByTestId('storage-current')).toHaveText(`/synthetic/default/${projectA}/runs`);
    await expect(page.getByTestId('storage-revision')).toHaveText('2');
  });
  await record('프로젝트 전환 뒤 지연된 미리보기 격리', async page => {
    await open(page); await page.evaluate(() => { window.syntheticStorage.delays['preview-project-storage'] = true; });
    await page.getByTestId('storage-choose').click(); await held(page, 'preview-project-storage');
    await page.getByTestId('project-select').selectOption(workspaceB);
    await expect(page.getByTestId('storage-current')).toHaveText(`/synthetic/default/${projectB}/runs`);
    await release(page, 'preview-project-storage'); await expect(page.getByTestId('storage-preview')).toHaveCount(0);
    assert.equal((await calls(page, 'apply-project-storage')).length, 0);
  });
  await record('프로젝트 전환 중 폴더 선택 응답 격리', async page => {
    await open(page); await page.evaluate(() => { window.syntheticStorage.delays['choose-directory'] = true; });
    await page.getByTestId('storage-choose').click(); await held(page, 'choose-directory');
    await page.getByTestId('project-select').selectOption(workspaceB); await release(page, 'choose-directory');
    await expect(page.getByTestId('storage-current')).toHaveText(`/synthetic/default/${projectB}/runs`);
    assert.equal((await calls(page, 'preview-project-storage')).length, 0);
  });
  await record('확정 이중 클릭과 프로젝트 전환 잠금', async page => {
    await open(page); await preview(page); await page.getByTestId('storage-confirm').check();
    await page.evaluate(() => { window.syntheticStorage.delays['apply-project-storage'] = true;
      const button = document.querySelector('[data-testid="storage-apply"]'); button.click(); button.click(); });
    await held(page, 'apply-project-storage');
    await expect(page.getByTestId('project-select')).toBeDisabled(); await expect(page.getByTestId('storage-choose')).toBeDisabled();
    assert.equal((await calls(page, 'apply-project-storage')).length, 1);
    await release(page, 'apply-project-storage'); await expect(page.getByTestId('storage-success')).toBeVisible();
  });
  await record('응답 유실과 프로젝트 복귀 및 앱 재기동 뒤 동일 작업 조회', async (page, context) => {
    await open(page); await preview(page); await page.evaluate(() => { window.syntheticStorage.applyLost = true; });
    await apply(page); await expect(page.getByTestId('storage-error')).toBeVisible();
    const [write] = await calls(page, 'apply-project-storage');
    await expect(page.getByTestId('storage-choose')).toBeDisabled();
    await page.getByTestId('project-select').selectOption(workspaceB); await expect(page.getByTestId('storage-operation')).toHaveCount(0);
    await page.getByTestId('project-select').selectOption(workspaceA); await expect(page.getByTestId('storage-operation-id')).toHaveText(write.requestId);
    assert.equal((await calls(page, 'apply-project-storage')).length, 1);
    const committed = await page.evaluate(() => ({ operations: window.syntheticStorage.operations, settings: window.syntheticStorage.settings }));
    await page.close();
    const restarted = await context.newPage();
    await restarted.addInitScript(syntheticBridge, { projectA, projectB, workspaceA, workspaceB, supported: true });
    await open(restarted);
    await restarted.evaluate(value => { Object.assign(window.syntheticStorage, value); }, committed);
    await expect(restarted.getByTestId('storage-operation-id')).toHaveText(write.requestId);
    await expect(restarted.getByTestId('storage-choose')).toBeDisabled();
    assert.equal((await calls(restarted, 'apply-project-storage')).length, 0);
    await restarted.getByTestId('storage-check-operation').click(); await expect(restarted.getByTestId('storage-success')).toBeVisible();
    assert.equal((await calls(restarted, 'project-storage-operation'))[0].input.operationId, write.requestId);
    assert.equal((await calls(restarted, 'apply-project-storage')).length, 0);
  });
  await record('미확인과 기록 없음은 자동 재복사하지 않음', async page => {
    await open(page); await preview(page); await page.evaluate(() => { window.syntheticStorage.applyLost = true; });
    await apply(page); await expect(page.getByTestId('storage-error')).toBeVisible();
    const [write] = await calls(page, 'apply-project-storage');
    for (const state of ['unknown', 'not-found', 'copying']) {
      await page.evaluate(state => { window.syntheticStorage.queryState = state; }, state);
      await page.getByTestId('storage-check-operation').click(); await expect(page.getByTestId('storage-check-operation')).toBeEnabled();
      await expect(page.getByTestId('storage-choose')).toBeDisabled();
    }
    assert.equal((await calls(page, 'apply-project-storage')).length, 1);
    assert.ok((await calls(page, 'project-storage-operation')).every(call => call.input.operationId === write.requestId));
  });
  await record('구 서비스 기능 제한', async page => {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByTestId('project-select').selectOption(workspaceA); await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('project-storage-unavailable')).toBeVisible();
    assert.equal((await calls(page, 'project-storage')).length, 0);
    await page.getByTestId('nav-projects').click(); await expect(page.getByTestId('profile-select')).toBeEnabled();
  });
  await record('충돌과 실행 및 정리 미확인 오류 표시', async page => {
    await open(page);
    for (const code of ['storage-conflict', 'storage-busy', 'storage-ownership-unknown', 'storage-operation-unknown', 'plan-stale']) {
      await page.evaluate(code => { window.syntheticStorage.directories.push('/synthetic/materials'); window.syntheticStorage.previewError = code; }, code);
      await page.getByTestId('storage-choose').click(); await expect(page.getByTestId('storage-error')).toContainText(code);
      await expect(page.getByTestId('storage-preview')).toHaveCount(0);
    }
    assert.equal((await calls(page, 'apply-project-storage')).length, 0);
    await page.screenshot({ path: join(runRoot, '이전오류.png'), fullPage: true });
  });
  await record('확정 실패 뒤 읽기 전용 조회', async page => {
    await open(page); await preview(page); await page.evaluate(() => { window.syntheticStorage.applyError = 'storage-conflict'; });
    await apply(page); await expect(page.getByTestId('storage-error')).toContainText('storage-conflict');
    await expect(page.getByTestId('storage-choose')).toBeDisabled();
    await page.evaluate(() => { window.syntheticStorage.queryState = 'failed'; });
    await page.getByTestId('storage-check-operation').click(); await expect(page.getByTestId('storage-operation')).toContainText('이전 실패');
    assert.equal((await calls(page, 'apply-project-storage')).length, 1);
  });
  await record('성공 이후 계획 무효화와 출력 저장 스냅샷 표시', async page => {
    await open(page); await page.getByTestId('nav-projects').click();
    await page.getByTestId('profile-select').selectOption('quick'); await page.getByTestId('inspect-plan').click();
    await expect(page.getByTestId('plan-storage-root')).toHaveText('/synthetic/plan/runs');
    await page.getByTestId('nav-settings').click(); await preview(page); await apply(page); await expect(page.getByTestId('storage-success')).toBeVisible();
    await page.getByTestId('nav-projects').click(); await expect(page.getByTestId('plan-storage-root')).toHaveCount(0);
    await expect(page.getByTestId('start-run')).toHaveCount(0);
  });
  await record('다른 연결과 연결 세대의 지연 확정 격리', async page => {
    await page.goto(`http://127.0.0.1:${server.address().port}/synthetic-harness`);
    await expect(page.getByTestId('storage-current')).toBeVisible(); await preview(page);
    await page.evaluate(() => { window.syntheticStorage.delays['apply-project-storage'] = true; });
    await apply(page); await held(page, 'apply-project-storage');
    await page.evaluate(projectId => { window.syntheticScope({ projectId, connectionKey: 'synthetic-connection-b', generation: 2 }); }, projectB);
    await expect(page.getByTestId('storage-current')).toHaveText(`/synthetic/default/${projectB}/runs`);
    await release(page, 'apply-project-storage'); await expect(page.getByTestId('storage-operation')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.syntheticApplied ?? 0), 0);
    await page.evaluate(projectId => { window.syntheticScope({ projectId, connectionKey: 'synthetic-connection-a', generation: 3 }); }, projectA);
    await expect(page.getByTestId('storage-success')).toBeVisible();
    assert.equal((await calls(page, 'apply-project-storage')).length, 1);
  });
  await record('같은 프로젝트의 연결 세대 변경 뒤 늦은 미리보기 격리', async page => {
    await page.goto(`http://127.0.0.1:${server.address().port}/synthetic-harness`);
    await expect(page.getByTestId('storage-current')).toBeVisible();
    await page.evaluate(() => { window.syntheticStorage.delays['preview-project-storage'] = true; });
    await page.getByTestId('storage-choose').click(); await held(page, 'preview-project-storage');
    await page.evaluate(projectId => { window.syntheticScope({ projectId, connectionKey: 'synthetic-connection-a', generation: 2 }); }, projectA);
    await release(page, 'preview-project-storage'); await expect(page.getByTestId('storage-choose')).toBeEnabled();
    await expect(page.getByTestId('storage-preview')).toHaveCount(0);
  });
  await record('손상된 보존 기록은 버리지 않고 이전 제한', async page => {
    await open(page);
    const key = 'checkmate.project-storage.operations.v1';
    for (const raw of ['null', '[]', '{', JSON.stringify({ invalid: { projectId: projectA, operationId: 'invalid' } })]) {
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
      await page.reload(); await page.getByTestId('project-select').selectOption(workspaceA); await page.getByTestId('nav-settings').click();
      await expect(page.getByTestId('storage-pending-invalid')).toBeVisible(); await expect(page.getByTestId('storage-choose')).toBeDisabled();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), raw);
      assert.equal((await calls(page, 'apply-project-storage')).length, 0);
    }
  });
  await record('사전 보존 실패는 확정 요청을 보내지 않음', async page => {
    await open(page); await preview(page);
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'checkmate.project-storage.operations.v1') throw new Error('synthetic storage unavailable');
        return set.call(this, key, value);
      };
    });
    await apply(page); await expect(page.getByTestId('storage-error')).toContainText('pending-save-failed');
    assert.equal((await calls(page, 'apply-project-storage')).length, 0);
  });
  await record('지연된 설정 조회가 다른 프로젝트에 표시되지 않음', async page => {
    await open(page);
    await page.evaluate(() => { window.syntheticStorage.delays['project-storage'] = true; });
    await page.getByTestId('storage-refresh').click(); await held(page, 'project-storage');
    await page.getByTestId('project-select').selectOption(workspaceB); await release(page, 'project-storage');
    await expect(page.getByTestId('storage-current')).toHaveText(`/synthetic/default/${projectB}/runs`);
  });
  await record('불일치한 확정 operationId를 성공으로 표시하지 않음', async page => {
    await open(page); await preview(page); await page.evaluate(() => { window.syntheticStorage.invalidResult = true; });
    await apply(page); await expect(page.getByTestId('storage-error')).toContainText('invalid-storage-response');
    await expect(page.getByTestId('storage-success')).toHaveCount(0); await expect(page.getByTestId('storage-choose')).toBeDisabled();
  });
  await record('보존 기록의 UUID 지문 개정 확인과 bucket 경계 검사', async page => {
    await open(page); await preview(page); await page.evaluate(() => { window.syntheticStorage.applyLost = true; });
    await apply(page); await expect(page.getByTestId('storage-error')).toBeVisible();
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem('checkmate.project-storage.operations.v1')));
    const [key] = Object.keys(original);
    for (const field of ['operationId', 'projectId', 'previewId', 'fingerprint', 'expectedRevision', 'confirm', 'bucket']) {
      const changed = structuredClone(original);
      if (field === 'bucket') { changed.invalid = changed[key]; delete changed[key]; }
      else if (field === 'expectedRevision') changed[key].input.expectedRevision = -1;
      else if (field === 'confirm') changed[key].input.confirm = false;
      else if (field === 'operationId' || field === 'projectId') changed[key][field] = 'invalid';
      else changed[key].input[field] = 'invalid';
      await page.evaluate(value => localStorage.setItem('checkmate.project-storage.operations.v1', JSON.stringify(value)), changed);
      await page.reload(); await page.getByTestId('project-select').selectOption(workspaceA); await page.getByTestId('nav-settings').click();
      await expect(page.getByTestId('storage-pending-invalid')).toBeVisible(); await expect(page.getByTestId('storage-choose')).toBeDisabled();
      assert.equal((await calls(page, 'apply-project-storage')).length, 0);
    }
  });
  await record('보존한 다른 dataRoot와 프로젝트 작업은 현재 범위에 섞이지 않음', async page => {
    await page.goto(`http://127.0.0.1:${server.address().port}/synthetic-harness`);
    await expect(page.getByTestId('storage-current')).toBeVisible(); await preview(page);
    await page.evaluate(() => { window.syntheticStorage.applyLost = true; }); await apply(page);
    await expect(page.getByTestId('storage-error')).toBeVisible();
    const operationId = await page.getByTestId('storage-operation-id').textContent();
    await page.reload();
    await page.evaluate(projectId => { window.syntheticScope({ projectId, connectionKey: 'synthetic-connection-b', generation: 1 }); }, projectA);
    await expect(page.getByTestId('storage-operation')).toHaveCount(0); await expect(page.getByTestId('storage-choose')).toBeEnabled();
    await page.evaluate(projectId => { window.syntheticScope({ projectId, connectionKey: 'synthetic-connection-a', generation: 1 }); }, projectB);
    await expect(page.getByTestId('storage-operation')).toHaveCount(0);
    await page.evaluate(projectId => { window.syntheticScope({ projectId, connectionKey: 'synthetic-connection-a', generation: 5 }); }, projectA);
    await expect(page.getByTestId('storage-operation-id')).toHaveText(operationId); await expect(page.getByTestId('storage-choose')).toBeDisabled();
    assert.equal((await calls(page, 'apply-project-storage')).length, 0);
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack ?? String(error); process.exitCode = 1;
  try { await writeFile(join(artifacts, '최초실패.json'), JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' }); }
  catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const file of ['packages/desktop/src/renderer/프로젝트자료폴더.tsx', 'packages/desktop/src/renderer/앱.tsx', 'packages/desktop/src/renderer/화면.css',
    'packages/desktop/src/main/메인.ts', 'packages/desktop/src/preload/연결.cts', 'scripts/프로젝트자료폴더화면검증.mjs']) {
    report.files[file] = createHash('sha256').update(await readFile(join(repository, file))).digest('hex');
  }
  report.finishedAt = new Date().toISOString();
  const reportPath = join(runRoot, '합성화면검증.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ evidenceKind: report.evidenceKind, passed: report.passed, cases: report.cases.length, reportPath, failure: report.failure ?? null }));
}
