// 합성 세션 자격의 위조와 재시작 및 공개 도구 노출 경계를 검증한다.
import { expect, it } from 'vitest';
import { SessionControl } from '../packages/engine/src/연결/세션제어.js';

it('비밀로 검증한 문맥만 인정하고 공개 ownerId와 복제 객체를 거절한다.', () => {
  const sessions = new SessionControl();
  const a = sessions.open();
  const b = sessions.open();
  const context = sessions.verify(a.credential);
  expect(sessions.assert(context).ownerId).toBe(a.ownerId);
  expect(sessions.verify(a.credential)).toBe(context);
  expect(() => sessions.verify(a.ownerId)).toThrowError(expect.objectContaining({ code: 'agent-control-required' }));
  expect(() => sessions.assert({ ...context })).toThrowError(expect.objectContaining({ code: 'agent-control-required' }));
  expect(sessions.verify(b.credential).ownerId).not.toBe(context.ownerId);
  expect(sessions.list()).toEqual([{ ownerId: a.ownerId }, { ownerId: b.ownerId }]);
  expect(JSON.stringify(sessions.list())).not.toContain(a.credential);
  expect(() => new SessionControl().verify(a.credential)).toThrowError(expect.objectContaining({ code: 'agent-control-required' }));
});
