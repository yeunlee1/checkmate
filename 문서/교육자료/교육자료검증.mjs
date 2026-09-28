// 교육 화면의 코드 근거와 판정 모형 및 접근성과 오프라인 동작을 검증한다.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { assessResult } from '@checkmate/contracts';

const folder=dirname(fileURLToPath(import.meta.url));
const root=resolve(folder,'../..');
const output=resolve(root,'.runtime/검증/교육자료');
await mkdir(output,{recursive:true});
const proof=JSON.parse(await readFile(resolve(folder,'학습근거.json'),'utf8'));
const graphBytes=(await readFile(resolve(root,'.ua/knowledge-graph.json'),'utf8')).replace(/\r\n/g,'\n');
const graph=JSON.parse(graphBytes);
const digest=value=>createHash('sha256').update(value).digest('hex');
assert.equal(proof.graphSha256,digest(graphBytes));
const nodes=new Set(graph.nodes.map(n=>n.id));
for(const item of proof.evidence){
  const text=(await readFile(resolve(root,item.file),'utf8')).replace(/\r\n/g,'\n');
  assert.equal(digest(text),item.sha256,item.file);
  assert.equal(text.split('\n').slice(item.line-1,item.endLine).join('\n'),item.code,item.file);
  assert.ok(nodes.has(item.nodeId),item.nodeId);
  assert.ok(item.url.includes(proof.commit));
}
const html=await readFile(resolve(folder,'체크메이트이해하기.html'),'utf8');
assert.equal(/[\u3040-\u30ff\u3400-\u9fff]/u.test(html),false,'한글과 영어만 사용한다.');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({offline:true});
const page=await context.newPage();
const errors=[],requests=[],viewports=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
try{
  await page.goto(pathToFileURL(resolve(folder,'체크메이트이해하기.html')).href);
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.locator('.lesson').count(),6);
  assert.equal(await page.locator('details.source').count(),proof.evidence.length);
  assert.equal(await page.locator('.lesson').evaluateAll(items=>items.every(el=>el.parentElement.tagName==='MAIN')),true);
  const anchors=await page.locator('a[href^="#"]').evaluateAll(items=>items.filter(a=>!document.getElementById(decodeURIComponent(a.hash.slice(1)))).map(a=>a.href));
  assert.deepEqual(anchors,[]);
  for(const width of [1440,1180,768,390,320]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`화면 넘침 ${width}`);
    const result=await new AxeBuilder({page}).analyze();
    assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`접근성 ${width}`);
    await page.screenshot({path:resolve(output,`첫화면-${width}.png`)});
    viewports.push({width,overflow:false,accessibilityViolations:0});
  }
  await page.setViewportSize({width:1440,height:1000});
  for(const id of ['roles','doors','plan','journey','verdict','repair']){
    await page.locator(`#${id}`).evaluate(element=>element.scrollIntoView({behavior:'instant',block:'start'}));
    await page.waitForFunction(id=>document.querySelector(`[data-nav="${id}"]`).getAttribute('aria-current')==='true',id);
  }
  for(const door of ['mcp','cli','desktop']){
    await page.locator(`[data-door="${door}"]`).click();
    assert.equal(await page.locator(`[data-door="${door}"]`).getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('#door-route').innerText(),/ProductService.handle/);
  }
  for(let i=0;i<6;i++){
    await page.locator(`[data-step="${i}"]`).click();
    assert.equal(await page.locator('#journey-number').innerText(),String(i+1).padStart(2,'0'));
  }
  await page.locator('#journey-next').click();
  assert.equal(await page.locator('#journey-number').innerText(),'01');
  for(const [preset,label] of [['pass','통과'],['missing','미완료'],['evidence','미확인'],['source','미완료'],['mixed','실패'],['imported','미확인']]){
    await page.locator(`[data-preset="${preset}"]`).click();
    assert.equal(await page.locator('#verdict-label').innerText(),label,preset);
  }
  await page.locator('[data-preset="pass"]').click();
  await page.locator('#run-state').selectOption('running');
  assert.equal(await page.locator('#verdict-label').innerText(),'아직 판정 없음');
  await page.locator('#run-state').selectOption('cancelled');
  assert.equal(await page.locator('#verdict-label').innerText(),'미완료');
  await page.locator('[data-preset="pass"]').click();
  const baseline=await page.evaluate(()=>simulation().input);
  const inputs=[];
  for(const state of ['queued','running','finished','blocked','cancelled','unverifiable']){
    for(const status of ['passed','failed','not-run','skipped','timed-out','interrupted','unknown']){
      for(const patch of [{},{workerExitCode:null},{workerExitCode:1},{sourceAfter:'c'.repeat(64)},{evidenceVerified:false},{cleanupVerified:false},{environmentVerified:false},{finalized:false},{origin:'imported'},{planHash:null},{sourceBefore:null},{requiredChecks:[]}]){
        inputs.push({...baseline,state,finalized:!['queued','running'].includes(state),cases:[{...baseline.cases[0],status}],...patch});
      }
    }
  }
  const expected=inputs.map(input=>assessResult(input));
  const actual=await page.evaluate(values=>values.map(value=>assessResult(value)),inputs);
  assert.deepEqual(actual,expected,'원본 함수와 교육 모형의 판정이 같아야 한다.');
  for(const quiz of await page.locator('.quiz').all()){
    await quiz.locator('button').click();
    assert.match(await quiz.locator('.quiz-feedback').innerText(),/선택/);
    const correct=await quiz.getAttribute('data-answer');
    await quiz.locator(`input[value="${correct}"]`).check();
    await quiz.locator('button').click();
    assert.match(await quiz.locator('.quiz-feedback').innerText(),/맞았습니다/);
  }
  const firstSource=page.locator('details.source').first();
  await firstSource.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await firstSource.evaluate(el=>el.open),true);
  await page.keyboard.press('Space');
  assert.equal(await firstSource.evaluate(el=>el.open),false);
  await page.locator('#file-query').fill('실행서비스.ts');
  assert.ok(await page.locator('#file-list li').count()>0);
  const related=page.locator('#file-list details').first();
  await related.locator('summary').click();
  await related.locator('button').first().click();
  assert.ok((await page.locator('#file-query').inputValue()).length>0);
  await page.locator('#file-query').fill('존재하지않는학습검색어');
  assert.equal(await page.locator('#file-list li').count(),0);
  await page.locator('#file-query').fill('');
  const before=await page.locator('#file-list li').count();
  await page.locator('#file-more').click();
  assert.ok(await page.locator('#file-list li').count()>before);
  await page.locator('#verdict').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,'판정실험.png')});
  await page.emulateMedia({media:'print'});
  await page.evaluate(()=>dispatchEvent(new Event('beforeprint')));
  assert.equal(await page.locator('.rail').isVisible(),false);
  assert.equal(await page.locator('details.source:not([open])').count(),0);
  await page.evaluate(()=>dispatchEvent(new Event('afterprint')));
  assert.equal(await firstSource.evaluate(el=>el.open),false);
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests,[]);
  const noScript=await browser.newContext({javaScriptEnabled:false,offline:true,viewport:{width:390,height:900}});
  try{
    const fallback=await noScript.newPage();
    await fallback.goto(pathToFileURL(resolve(folder,'체크메이트이해하기.html')).href);
    assert.equal(await fallback.locator('.lesson').count(),6);
    await fallback.locator('details.source').first().locator('summary').click();
    assert.equal(await fallback.locator('details.source').first().evaluate(el=>el.open),true);
  }finally{await noScript.close();}
  const result={status:'passed',viewports,sources:proof.evidence.length,verdictComparisons:inputs.length,lessons:6,offline:true,keyboard:true,quiz:true,fileSearch:true,noScriptReadable:true,printMode:true,pageErrors:errors,externalRequests:requests};
  await writeFile(resolve(output,'검증결과.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await context.close();await browser.close();}
