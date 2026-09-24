// 일반 Node 검사의 결과와 실제 증거 파일을 기존 NDJSON 작업 프로토콜로 기록한다.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { adapterEventSchema } from '@checkmate/contracts/events';
import { resultInputSchema } from '@checkmate/contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeName = /^(?!\.{1,2}$)(?!.*[. ]$)(?!^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[^\\/:\x00-\x1f\x7f<>"|?*]+$/iu;
const maxLineBytes = 64 * 1024;
const maxTextBytes = 128 * 1024;
const maxImageBytes = 5 * 1024 * 1024;
type Case = (typeof resultInputSchema.shape.cases.element)['_output'];
type Mime = 'text/plain' | 'application/json' | 'text/html' | 'image/png' | 'image/jpeg';
type Evidence = { id: string; relativePath: string; sha256: string; byteLength: number;
  mime: Mime; sensitivity: 'public' | 'restricted' };

export type Reporter = {
  caseResult(input: Case): void;
  evidence(input: { relativePath: string; content: string | Buffer; mime: Mime;
    sensitivity?: 'public' | 'restricted'; synthetic?: boolean }): Promise<Evidence>;
};

export function createReporter(options: { runId?: string; evidenceDir?: string;
  writeLine?: (line: string) => void } = {}): Reporter {
  const runId = options.runId ?? process.env.CHECKMATE_RUN_ID;
  const evidenceDir = options.evidenceDir ?? process.env.CHECKMATE_EVIDENCE_DIR;
  if (!runId || !uuid.test(runId) || !evidenceDir || !isAbsolute(evidenceDir) || evidenceDir.includes('\0')) {
    throw new Error('CHECKMATE_RUN_ID 또는 CHECKMATE_EVIDENCE_DIR이 올바르지 않습니다.');
  }
  let sequence = 0;
  const writeLine = options.writeLine ?? ((line: string) => { process.stdout.write(line); });
  function emit(type: 'case-result' | 'evidence-created', payload: Record<string, unknown>): void {
    const event = adapterEventSchema.parse({ protocolVersion: 1, runId, sequence: sequence + 1,
      type, time: new Date().toISOString(), payload });
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) throw new Error('NDJSON 한 줄 제한을 넘었습니다.');
    writeLine(line);
    sequence += 1;
  }
  return {
    caseResult(input) {
      const parsed = resultInputSchema.shape.cases.element.parse(input);
      emit('case-result', parsed);
    },
    async evidence(input) {
      if (!safeName.test(input.relativePath) || input.relativePath.length > 1024) {
        throw new Error('증거 파일 이름이 안전하지 않습니다.');
      }
      if (input.sensitivity === 'public' && input.synthetic !== true) {
        throw new Error('public 증거는 합성 자료임을 명시해야 합니다.');
      }
      if (input.mime === 'image/png' && !Buffer.isBuffer(input.content)) {
        throw new Error('PNG 증거는 Buffer여야 합니다.');
      }
      const bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
      if (bytes.length > (input.mime.startsWith('image/') ? maxImageBytes : maxTextBytes)) {
        throw new Error('증거 파일 크기 제한을 넘었습니다.');
      }
      const root = resolve(evidenceDir);
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
        throw new Error('증거 폴더의 실제 경로가 다릅니다.');
      }
      const path = join(root, input.relativePath);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      const evidence: Evidence = { id: randomUUID(), relativePath: input.relativePath,
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
        mime: input.mime, sensitivity: input.sensitivity ?? 'restricted' };
      emit('evidence-created', evidence);
      return evidence;
    },
  };
}
