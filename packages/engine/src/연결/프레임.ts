// 로컬 소켓의 메시지를 바이트 상한과 읽기 시간 제한 안에서 교환한다.
import type { Socket } from 'node:net';
import { ServiceError } from '@checkmate/contracts/api';

export const frameLimit = 256 * 1024;
export class JsonFrames {
  private buffer: Buffer = Buffer.alloc(0);
  private values: unknown[] = [];
  private waiter: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  private failure: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      try {
        if (this.buffer.length + chunk.length > frameLimit) throw new ServiceError('message-too-large');
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (let end = this.buffer.indexOf(10); end >= 0; end = this.buffer.indexOf(10)) {
          const line = this.buffer.subarray(0, end);
          this.buffer = this.buffer.subarray(end + 1);
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
          if (this.waiter) {
            const waiter = this.waiter; this.waiter = undefined; clearTimeout(waiter.timer); waiter.resolve(value);
          } else {
            if (this.values.length >= 4) throw new ServiceError('too-many-messages');
            this.values.push(value);
          }
        }
      } catch { this.fail(new ServiceError('invalid-frame', '서비스 메시지 형식이나 크기를 확인해 주세요.')); socket.destroy(); }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => this.fail(new ServiceError(
      error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'service-unavailable' : 'service-disconnected', '로컬 서비스에 연결할 수 없습니다.', true)));
    socket.on('close', () => this.fail(new ServiceError('service-disconnected', '로컬 서비스 연결이 종료됐습니다.', true)));
  }

  read(timeoutMs = 10000): Promise<unknown> {
    if (this.values.length > 0) return Promise.resolve(this.values.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new ServiceError('concurrent-read'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(new ServiceError('service-timeout', '서비스 응답 시간이 초과됐습니다.', true)); this.socket.destroy(); }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  async write(value: unknown): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    if (bytes.length > frameLimit) throw new ServiceError('message-too-large');
    await new Promise<void>((resolve, reject) => this.socket.write(bytes, (error) => error ? reject(new ServiceError('service-disconnected')) : resolve()));
  }

  private fail(error: Error): void {
    this.failure = error;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; clearTimeout(waiter.timer); waiter.reject(error); }
  }
}
