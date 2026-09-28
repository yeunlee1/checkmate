// 실행 이벤트의 바이트 경계와 계약 오류를 검증한다.
import { describe, expect, it } from 'vitest';
import { readAdapterEvents } from '../packages/engine/src/이벤트읽기.js';

const runId = '98ae3e34-d715-43fd-bfbb-e3a880bb0cd5';
const encode = (value: string) => new TextEncoder().encode(value);

function event(sequence = 1, changes: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    runId,
    sequence,
    type: 'step-started',
    time: '2026-09-25T02:03:04.123Z',
    payload: { note: '한글' },
    ...changes,
  };
}

async function collect(...chunks: Uint8Array[]) {
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  const result = [];
  for await (const item of readAdapterEvents(source(), runId)) result.push(item);
  return result;
}

function encodedEvent(sequence = 1, changes: Record<string, unknown> = {}) {
  return encode(JSON.stringify(event(sequence, changes)));
}

describe('실행 이벤트 읽기', () => {
  it('청크와 한글 UTF-8 문자 경계를 넘어 여러 이벤트를 읽는다.', async () => {
    const first = encodedEvent();
    const korean = first.indexOf(0xed);
    const second = encodedEvent(3, { type: 'worker-finished' });
    const bytes = encode(`${new TextDecoder().decode(first)}\r\n${new TextDecoder().decode(second)}\n`);
    const result = await collect(bytes.subarray(0, korean + 1), bytes.subarray(korean + 1, first.length + 1), bytes.subarray(first.length + 1));
    expect(result.map((item) => [item.sequence, item.type])).toEqual([[1, 'step-started'], [3, 'worker-finished']]);
    expect(result[0]?.payload).toEqual({ note: '한글' });
  });

  it('64KiB 본문과 CRLF를 수용하고 바로 넘는 줄은 거절한다.', async () => {
    const base = event(1, { payload: { note: '' } });
    const emptyLength = encodedEvent(1, { payload: { note: '' } }).length;
    const exact = encode(JSON.stringify({ ...base, payload: { note: 'x'.repeat(65536 - emptyLength) } }));
    expect(exact.length).toBe(65536);
    expect((await collect(exact.subarray(0, 40000), exact.subarray(40000), encode('\r'), encode('\n')))[0]?.sequence).toBe(1);
    await expect(collect(encode(JSON.stringify({ ...base, payload: { note: 'x'.repeat(65537 - emptyLength) } })))).rejects.toMatchObject({ code: 'adapter-protocol-error' });
  });

  it('합계가 큰 청크의 짧은 여러 줄은 수용한다.', async () => {
    const lines = Array.from({ length: 700 }, (_, index) => JSON.stringify(event(index + 1)));
    const chunk = encode(`${lines.join('\n')}\n`);
    expect(chunk.length).toBeGreaterThan(65536);
    expect((await collect(chunk)).length).toBe(700);
  });

  it('마지막 줄에 개행이 없어도 완전한 JSON을 읽는다.', async () => {
    expect((await collect(encodedEvent()))[0]?.sequence).toBe(1);
  });

  it.each([
    ['빈 줄', '\n'],
    ['잘못된 JSON', '{\n'],
    ['최상위 추가 키', `${JSON.stringify(event(1, { secret: '숨김값' }))}\n`],
    ['계약 버전', `${JSON.stringify(event(1, { protocolVersion: 2 }))}\n`],
    ['잘못된 runId', `${JSON.stringify(event(1, { runId: 'wrong' }))}\n`],
    ['다른 runId', `${JSON.stringify(event(1, { runId: '551a863f-c78b-419b-bf84-57411470587f' }))}\n`],
    ['0번 순서', `${JSON.stringify(event(0))}\n`],
    ['안전하지 않은 순서', `${JSON.stringify(event(Number.MAX_SAFE_INTEGER + 1))}\n`],
    ['알 수 없는 유형', `${JSON.stringify(event(1, { type: 'other' }))}\n`],
    ['지역 시간', `${JSON.stringify(event(1, { time: '2026-09-25T02:03:04+09:00' }))}\n`],
    ['불가능한 날짜', `${JSON.stringify(event(1, { time: '2026-02-30T02:03:04Z' }))}\n`],
    ['배열 payload', `${JSON.stringify(event(1, { payload: [] }))}\n`],
    ['null payload', `${JSON.stringify(event(1, { payload: null }))}\n`],
  ])('%s를 계약 오류로 중단하고 입력을 노출하지 않는다.', async (_name, line) => {
    try {
      await collect(encode(line));
      throw new Error('예상한 계약 오류가 발생하지 않았습니다.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'adapter-protocol-error' });
      expect(String(error)).not.toContain('숨김값');
      expect(String(error)).not.toContain('한글');
    }
  });

  it('잘못된 UTF-8 바이트를 거절한다.', async () => {
    const line = encodedEvent();
    line[line.indexOf(0xed)] = 0xff;
    await expect(collect(line)).rejects.toMatchObject({ code: 'adapter-protocol-error' });
  });

  it.each([[1, 1], [2, 1]])('중복 또는 역전된 순서 %i 다음 %i를 거절한다.', async (first, second) => {
    await expect(collect(encode(`${JSON.stringify(event(first))}\n${JSON.stringify(event(second))}\n`)))
      .rejects.toMatchObject({ code: 'adapter-protocol-error' });
  });

  it('끝의 불완전한 JSON과 BOM을 거절한다.', async () => {
    await expect(collect(encode('{'))).rejects.toMatchObject({ code: 'adapter-protocol-error' });
    await expect(collect(encode(`${JSON.stringify(event())}\r`))).rejects.toMatchObject({ code: 'adapter-protocol-error' });
    await expect(collect(new Uint8Array([0xef, 0xbb, 0xbf, ...encodedEvent()]))).rejects.toMatchObject({ code: 'adapter-protocol-error' });
  });
});
