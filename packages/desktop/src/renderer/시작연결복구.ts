// 앱 시작의 읽기 연결만 제한적으로 재시도하고 취소와 자료 경로 검증을 적용한다.
export class StartupConnectionFailure extends Error {
  constructor(readonly code: 'startup-cancelled' | 'startup-timeout' | 'connection-root-unconfirmed' | 'connection-root-mismatch') { super(code); }
}

type StartupClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
};
const defaultClock: StartupClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const transient = new Set(['service-unavailable', 'service-disconnected', 'service-start-failed', 'update-in-progress']);

function normalizedRoot(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  const path = value.replaceAll('\\', '/');
  const drive = path.match(/^([a-zA-Z]:)\//);
  const unc = path.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);
  let prefix: string; let tail: string; let windows = false;
  if (drive) { prefix = `${drive[1]!.toLowerCase()}/`; tail = path.slice(3); windows = true; }
  else if (unc && !['?', '.', '..'].includes(unc[1]!) && !['.', '..'].includes(unc[2]!)) {
    prefix = `//${unc[1]!.toLowerCase()}/${unc[2]!.toLowerCase()}/`; tail = path.slice(unc[0].length); windows = true;
  } else if (value.startsWith('/') && !path.startsWith('//')) { prefix = '/'; tail = path.slice(1); }
  else return null;
  if (tail.includes(':')) return null;
  const parts: string[] = [];
  for (const part of tail.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(windows ? part.toLowerCase() : part);
  }
  return prefix + parts.join('/');
}

export async function readStartupConnection<Info extends { dataPath: string }, Projects>(reads: {
  readConnectionInfo(): Promise<Info>;
  readCapabilities(): Promise<unknown>;
  readProjects(): Promise<Projects>;
}, options: { signal: AbortSignal; expectedDataPath?: string; clock?: StartupClock }): Promise<{ connection: Info; capabilities: unknown; projects: Projects }> {
  const { signal } = options; const clock = options.clock ?? defaultClock;
  if (signal.aborted) throw new StartupConnectionFailure('startup-cancelled');
  const deadline = clock.now() + 90000;
  let rejectStopped!: (error: StartupConnectionFailure) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(new StartupConnectionFailure('startup-cancelled'));
  const timeout = clock.setTimeout(() => rejectStopped(new StartupConnectionFailure('startup-timeout')), 90000);
  let backoff: unknown;
  signal.addEventListener('abort', abort, { once: true });
  function assertActive() {
    if (signal.aborted) throw new StartupConnectionFailure('startup-cancelled');
    if (clock.now() >= deadline) throw new StartupConnectionFailure('startup-timeout');
  }
  async function bounded<T>(read: () => Promise<T>): Promise<T> {
    assertActive(); const value = await Promise.race([read(), stopped]); assertActive(); return value;
  }
  let expectedRoot = options.expectedDataPath === undefined ? null : normalizedRoot(options.expectedDataPath);
  try {
    if (options.expectedDataPath !== undefined && expectedRoot === null) throw new StartupConnectionFailure('connection-root-unconfirmed');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const connection = await bounded(reads.readConnectionInfo);
        if (typeof connection === 'object' && connection !== null && 'ok' in connection && connection.ok === false) {
          const error = 'error' in connection ? connection.error : null;
          if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') throw error;
          throw new StartupConnectionFailure('connection-root-unconfirmed');
        }
        const root = normalizedRoot(connection?.dataPath);
        if (!root) throw new StartupConnectionFailure('connection-root-unconfirmed');
        if (expectedRoot !== null && expectedRoot !== root) throw new StartupConnectionFailure('connection-root-mismatch');
        expectedRoot = root;
        const capabilities = await bounded(reads.readCapabilities);
        const actual = typeof capabilities === 'object' && capabilities !== null && 'connection' in capabilities ? capabilities.connection : null;
        const actualRoot = typeof actual === 'object' && actual !== null && 'dataRoot' in actual ? normalizedRoot(actual.dataRoot) : null;
        if (!actualRoot) throw new StartupConnectionFailure('connection-root-unconfirmed');
        if (actualRoot !== root) throw new StartupConnectionFailure('connection-root-mismatch');
        const projects = await bounded(reads.readProjects);
        return { connection, capabilities, projects };
      } catch (error) {
        assertActive();
        if (attempt === 3 || typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string' || !transient.has(error.code)) throw error;
        await bounded(() => new Promise<void>(resolve => { backoff = clock.setTimeout(resolve, attempt === 1 ? 5000 : 15000); }));
        backoff = undefined;
      }
    }
    throw new StartupConnectionFailure('startup-timeout');
  } finally {
    clock.clearTimeout(timeout);
    if (backoff !== undefined) clock.clearTimeout(backoff);
    signal.removeEventListener('abort', abort);
  }
}
