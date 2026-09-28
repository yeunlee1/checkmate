// 외부 서비스 없이 저장과 역할 노출 및 화면 결함을 재현하는 가상 앱이다.
import { createServer } from 'node:http';

export function createFixtureApp(mode) {
  let saved = '';
  const flawed = mode === 'defect';
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    if (url.pathname === '/api/item' && request.method === 'GET') {
      send(200, 'application/json', JSON.stringify({ value: saved }));
      return;
    }
    if (url.pathname === '/api/item' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body).value;
      saved = flawed ? `${value} 오류` : value;
      send(200, 'application/json', JSON.stringify({ value: saved }));
      return;
    }
    if (url.pathname === '/api/role') {
      send(200, 'application/json', JSON.stringify({ role: 'viewer',
        marker: flawed ? 'SYNTHETIC_ADMIN_ONLY' : 'SYNTHETIC_VIEWER_ONLY' }));
      return;
    }
    if (url.pathname === '/api/total') {
      send(200, 'application/json', JSON.stringify({ total: flawed ? 13 : 12 }));
      return;
    }
    if (url.pathname !== '/') { send(404, 'text/plain', '없음'); return; }
    const image = flawed ? '<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs">'
      : '<img alt="상품 이미지" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs">';
    send(200, 'text/html; charset=utf-8', `<!doctype html><html lang="ko"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>합성 주문</title><style>body{font:16px sans-serif;margin:20px}#decor{position:fixed;left:${flawed ? 390 : 0}px;top:170px}</style>
      <main><h1>합성 주문</h1><label for="item">항목</label><input id="item">
      <button id="save">저장</button><p id="saved" role="status"></p>${image}<span id="decor">합성 표시</span></main>
      <script>
        fetch('/api/item').then(r=>r.json()).then(data=>{document.querySelector('#saved').textContent=data.value});
        document.querySelector('#save').addEventListener('click',async()=>{
          const value=document.querySelector('#item').value;
          const data=await fetch('/api/item',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value})}).then(r=>r.json());
          document.querySelector('#saved').textContent=data.value;
        });
      </script></html>`);
  });
}
