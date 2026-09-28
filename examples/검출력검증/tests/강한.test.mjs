// 허용과 거부 조건을 모두 확인해 권한 함수의 변이를 검출한다.
import { it, expect } from 'vitest';
import { mayView } from './권한.mjs';

it('활성 관리자만 열람한다', () => {
  expect(mayView('admin', true)).toBe(true);
  expect(mayView('viewer', true)).toBe(false);
  expect(mayView('admin', false)).toBe(false);
});
