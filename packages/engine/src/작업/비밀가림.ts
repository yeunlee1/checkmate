// 동적 자원 비밀을 출력과 이벤트에서 안전한 문자열로 바꾼다.
export function hideSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, '[가림]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) result = result.replaceAll(escaped, '[가림]');
  }
  return result;
}

export function hideSecretsInValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return hideSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => hideSecretsInValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [hideSecrets(key, secrets), hideSecretsInValue(item, secrets)]));
  return value;
}

export function hideSecretsInNdjson(stdout: string, secrets: readonly string[]): string {
  return stdout.split('\n').map((line) => {
    if (!line) return line;
    try { return JSON.stringify(hideSecretsInValue(JSON.parse(line), secrets)); }
    catch { return hideSecrets(line, secrets); }
  }).join('\n');
}
