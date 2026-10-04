// 공식 업데이트 목록을 제한된 HTTPS 요청으로 읽고 리디렉션과 응답 무결성을 확인한다.
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { TextDecoder } from 'node:util';

const metadataUrl = 'https://github.com/yeunlee1/checkmate/releases/latest/download/RELEASES';
const maxBytes = 64 * 1024;
const timeoutMs = 15000;
const maxRedirects = 5;

export function readUpdateMetadata(requestFactory: (options: ClientRequestConstructorOptions) => ClientRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let settled = false;
    let redirects = 0;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(), timeoutMs);
    function fail() {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error('update-metadata-unavailable'));
      try { request?.abort(); } catch { /* 요청 취소 실패도 조회 실패로 유지한다. */ }
    }
    try {
      request = requestFactory({ url: metadataUrl, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
      request.on('redirect', (status, method, destination) => {
        if (settled) return;
        try {
          const url = new URL(destination);
          if (++redirects > maxRedirects || ![301, 302, 303, 307, 308].includes(status) || method !== 'GET' || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !['github.com', 'release-assets.githubusercontent.com'].includes(url.hostname)) return fail();
          request!.followRedirect();
        } catch { fail(); }
      });
      request.on('error', fail);
      request.on('abort', fail);
      request.on('close', fail);
      request.on('login', (_auth, callback) => { callback(); fail(); });
      request.on('response', response => {
        response.on('error', fail);
        response.on('aborted', fail);
        response.on('end', () => {
          if (settled) return;
          try {
            if (bytes === 0) return fail();
            const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks, bytes));
            settled = true; clearTimeout(timer); resolve(source);
          } catch { fail(); }
        });
        if (settled || response.statusCode !== 200) return fail();
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk) || bytes + chunk.length > maxBytes) return fail();
          bytes += chunk.length; chunks.push(chunk);
        });
      });
      request.end();
    } catch { fail(); }
  });
}
