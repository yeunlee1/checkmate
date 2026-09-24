// 사용자 전용 소켓에서 양방향 인증 후 한 요청과 응답을 교환한다.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { z } from 'zod';
import { apiRequestSchema, apiResponseSchema, errorResponse, humanMethods, ServiceError } from '@checkmate/contracts/api';
import type { ApiRequest, ApiResponse } from '@checkmate/contracts/api';
import { JsonFrames } from './프레임.js';
import { readConnectionSecret } from './개인경로.js';
import type { DataPaths } from './개인경로.js';

export type ClientRole = 'human' | 'agent';
export type RequestHandler = (request: ApiRequest, role: ClientRole) => Promise<ApiResponse>;
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const hello = z.strictObject({ apiVersion: z.literal(1), nonce: hex });
const proofSchema = z.strictObject({ nonce: hex, role: z.enum(['human', 'agent']), proof: hex });
const accepted = z.strictObject({ proof: hex });

function proof(secret: Buffer, direction: string, serverNonce: string, clientNonce: string, role: ClientRole): string {
  return createHmac('sha256', secret).update(JSON.stringify([1, direction, serverNonce, clientNonce, role])).digest('hex');
}
function matches(actual: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export async function serveLocal(paths: DataPaths, handler: RequestHandler): Promise<{ server: Server; close: () => Promise<void>; connections: () => number }> {
  const secret = await readConnectionSecret(paths);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const frames = new JsonFrames(socket);
    void (async () => {
      const nonce = randomBytes(32).toString('hex');
      await frames.write({ apiVersion: 1, nonce });
      const auth = proofSchema.parse(await frames.read());
      if (!matches(auth.proof, proof(secret, 'client', nonce, auth.nonce, auth.role))) throw new ServiceError('authentication-failed');
      await frames.write({ proof: proof(secret, 'server', nonce, auth.nonce, auth.role) });
      const raw = await frames.read();
      const request = apiRequestSchema.parse(raw);
      let response: ApiResponse;
      if (auth.role === 'agent' && humanMethods.has(request.method)) response = errorResponse(request.requestId, new ServiceError('human-action-required', '이 작업은 사람용 설정 화면이나 CLI에서 확인해야 합니다.'));
      else {
        try { response = await handler(request, auth.role); }
        catch (error) { response = errorResponse(request.requestId, error); }
      }
      await frames.write(apiResponseSchema.parse(response));
      socket.end();
    })().catch(() => socket.destroy());
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new ServiceError('service-already-running', '서비스 연결 경로가 이미 사용 중입니다.', true));
    server.once('error', onError);
    server.listen({ path: paths.endpoint, readableAll: false, writableAll: false, exclusive: true }, () => { server.off('error', onError); resolve(); });
  });
  return { server, connections: () => sockets.size, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    secret.fill(0);
  } };
}

export async function requestLocal(paths: DataPaths, request: ApiRequest, role: ClientRole = 'human'): Promise<ApiResponse> {
  const parsed = apiRequestSchema.parse(request);
  const secret = await readConnectionSecret(paths);
  const socket = createConnection({ path: paths.endpoint });
  const frames = new JsonFrames(socket);
  try {
    const challenge = hello.parse(await frames.read());
    const nonce = randomBytes(32).toString('hex');
    await frames.write({ nonce, role, proof: proof(secret, 'client', challenge.nonce, nonce, role) });
    const confirmation = accepted.parse(await frames.read());
    if (!matches(confirmation.proof, proof(secret, 'server', challenge.nonce, nonce, role))) throw new ServiceError('authentication-failed', '서비스 인증에 실패했습니다.');
    await frames.write(parsed);
    const response = apiResponseSchema.parse(await frames.read(30000));
    if (response.requestId !== parsed.requestId) throw new ServiceError('response-mismatch');
    return response;
  } finally { socket.destroy(); secret.fill(0); }
}
