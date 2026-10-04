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

// 알려진 비밀과 출력 제한에서 잘린 접미부 및 기존 인증 키 표현을 로그에서 가린다.
export function hideCommandOutput(value: string, secrets: readonly string[], truncated = false): string {
  let result = hideSecrets(value, secrets);
  if (truncated) for (const secret of secrets.filter(Boolean)) {
    for (const candidate of [secret, JSON.stringify(secret).slice(1, -1)]) {
      for (let size = Math.min(candidate.length - 1, result.length); size > 0; size -= 1) {
        if (result.endsWith(candidate.slice(0, size))) { result = result.slice(0, -size) + '[가림]'; break; }
      }
    }
  }
  return result.replace(/((?:authorization|cookie|bearer|token|password|secret|api[ _-]?key)[\s"']*[:=]?[\s"']*)[^\r\n]*/giu, '$1[가림]');
}
