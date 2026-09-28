// 허용 사례만 확인해 누락된 거부 조건의 생존 변이를 드러낸다.
import { it, expect } from 'vitest';
import { mayView } from './권한.mjs';

it('활성 관리자는 열람한다', () => {
  expect(mayView('admin', true)).toBe(true);
});
