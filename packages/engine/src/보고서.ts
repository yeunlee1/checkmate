// 로컬 결과 파일을 제한된 크기로 읽고 계약과 판정의 일관성을 검사한다.
import { open } from 'node:fs/promises';
import { assessResult, runResultSchema } from '@checkmate/contracts';

const maxReportBytes = 16 * 1024 * 1024;

export class ReportError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitCode = 2) {
    super(message);
  }
}

export async function validateReport(path: string) {
  const file = await open(path, 'r').catch(() => {
    throw new ReportError('report-unreadable', '결과 파일을 읽을 수 없습니다.');
  });
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxReportBytes) {
      throw new ReportError('report-size', '일반 파일만 검사하며 최대 크기는 16MiB입니다.');
    }
    const buffer = Buffer.alloc(maxReportBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = await file.read(buffer, total, buffer.length - total, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total > maxReportBytes) throw new ReportError('report-size', '결과 파일의 크기 제한을 초과했습니다.');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      throw new ReportError('report-encoding', '결과 파일은 올바른 UTF-8이어야 합니다.');
    }
  } finally {
    await file.close();
  }
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new ReportError('report-json', '결과 파일의 JSON 형식이 올바르지 않습니다.'); }
  if (typeof input === 'object' && input !== null && 'schemaVersion' in input && input.schemaVersion !== 1) {
    throw new ReportError('unsupported-version', '지원하지 않는 결과 계약 버전입니다.', 6);
  }
  const parsed = runResultSchema.safeParse(input);
  if (!parsed.success) {
    // 원본 값과 파일 경로를 오류 응답에 포함하지 않는다.
    throw new ReportError('invalid-report', '결과 형식 또는 판정 조건이 맞지 않습니다.');
  }
  const result = parsed.data;
  return {
    validation: 'consistent' as const,
    evidenceAuthenticated: false as const,
    runId: result.runId,
    state: result.state,
    reportedVerdict: result.verdict,
    assessment: assessResult(result),
    caseCount: result.cases.length,
    requiredCount: result.requiredChecks.length,
  };
}
