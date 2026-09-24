// 합성 역할과 활성 상태에 따라 열람 권한을 판정한다.
export function mayView(role, enabled) {
  return role === 'admin' && enabled === true;
}
