// UTF-8 NDJSON 실행 이벤트를 줄 단위로 제한하고 순서대로 읽는다.
import { adapterEventSchema, type AdapterEvent } from '@checkmate/contracts/events';

const maxLineBytes = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class AdapterProtocolError extends Error {
  readonly code = 'adapter-protocol-error';

  constructor() {
    super('어댑터 이벤트 형식이 올바르지 않습니다.');
  }
}

function parseLine(bytes: Uint8Array, expectedRunId: string, previousSequence: number, terminated: boolean): AdapterEvent {
  if (!terminated && bytes.at(-1) === 13) throw new AdapterProtocolError();
  const line = terminated && bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
  if (line.length === 0 || line.length > maxLineBytes) throw new AdapterProtocolError();

  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(line));
  } catch {
    throw new AdapterProtocolError();
  }

  const parsed = adapterEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.runId !== expectedRunId || parsed.data.sequence <= previousSequence) {
    throw new AdapterProtocolError();
  }
  return parsed.data;
}

function appendLine(first: Uint8Array, second: Uint8Array): Uint8Array {
  const length = first.length + second.length;
  const lastByte = second.length > 0 ? second.at(-1) : first.at(-1);
  if (length > maxLineBytes + 1 || (length > maxLineBytes && lastByte !== 13)) {
    throw new AdapterProtocolError();
  }
  const result = new Uint8Array(length);
  result.set(first);
  result.set(second, first.length);
  return result;
}

export async function* readAdapterEvents(
  chunks: AsyncIterable<Uint8Array>,
  expectedRunId: string,
): AsyncGenerator<AdapterEvent> {
  let pending: Uint8Array = new Uint8Array(0);
  let previousSequence = 0;

  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new AdapterProtocolError();
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue;
      const line = appendLine(pending, chunk.subarray(start, index));
      const event = parseLine(line, expectedRunId, previousSequence, true);
      previousSequence = event.sequence;
      yield event;
      pending = new Uint8Array(0);
      start = index + 1;
    }
    if (start < chunk.length) pending = appendLine(pending, chunk.subarray(start));
  }

  if (pending.length > 0) yield parseLine(pending, expectedRunId, previousSequence, false);
}
