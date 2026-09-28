// Stryker JSON 변이 보고서를 검증하고 안전한 검출력 결과로 정규화한다.

export type MutationStatus = 'Killed' | 'Survived' | 'NoCoverage' | 'Timeout'
  | 'CompileError' | 'RuntimeError' | 'Ignored' | 'Pending';
export type MutationPosition = { line: number; column: number };
export type MutationLocation = { start: MutationPosition; end: MutationPosition };
export type MutationExclusion = {
  file: string;
  id: string;
  kind: 'equivalent' | 'excluded';
  reason: string;
};
export type MutationFinding = {
  file: string;
  id: string;
  mutatorName: string;
  location: MutationLocation;
  status: MutationStatus;
  exclusion: MutationExclusion | null;
};
export type MutationCounts = Record<MutationStatus, number> & { excluded: number };
export type MutationScore = { detected: number; denominator: number; percent: number };
export type MutationResult = {
  status: 'passed' | 'failed' | 'unverified';
  scope: { id: string; files: string[] };
  schemaVersion: string | null;
  findings: MutationFinding[];
  counts: MutationCounts;
  score: MutationScore | null;
  reason: string | null;
};

const statuses: readonly MutationStatus[] = [
  'Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending',
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function position(value: unknown): value is MutationPosition {
  return record(value) && Number.isSafeInteger(value.line) && Number(value.line) >= 1
    && Number.isSafeInteger(value.column) && Number(value.column) >= 1;
}

function location(value: unknown): value is MutationLocation {
  if (!record(value) || !position(value.start) || !position(value.end)) return false;
  return value.end.line > value.start.line
    || (value.end.line === value.start.line && value.end.column >= value.start.column);
}

function safeFile(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.startsWith('/')
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
    && !/^[a-zA-Z]:/.test(value);
}

function emptyCounts(): MutationCounts {
  return { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0,
    RuntimeError: 0, Ignored: 0, Pending: 0, excluded: 0 };
}

function invalid(scope: MutationResult['scope'], reason: string): MutationResult {
  return { status: 'unverified', scope, schemaVersion: null, findings: [], counts: emptyCounts(),
    score: null, reason };
}

/** 정규화 결과만 반환한다. 원본 source, replacement, statusReason은 반환하지 않는다. */
export function adaptStrykerReport(
  report: unknown,
  scope: { id: string; files: readonly string[] },
  exclusions: readonly MutationExclusion[] = [],
): MutationResult {
  const outputScope = { id: scope.id, files: [...scope.files] };
  if (!scope.id.trim() || scope.files.length === 0 || new Set(scope.files).size !== scope.files.length
    || scope.files.some((file) => !safeFile(file))) {
    return invalid(outputScope, '검사 범위가 비어 있거나 올바르지 않습니다.');
  }
  if (!record(report) || typeof report.schemaVersion !== 'string'
    || !/^[12](\.(0|[1-9]\d*)){0,2}$/.test(report.schemaVersion)
    || !record(report.thresholds) || !Number.isInteger(report.thresholds.high)
    || !Number.isInteger(report.thresholds.low)
    || Number(report.thresholds.high) < 0 || Number(report.thresholds.high) > 100
    || Number(report.thresholds.low) < 0 || Number(report.thresholds.low) > 100
    || !record(report.files)) {
    return invalid(outputScope, 'Stryker JSON 보고서의 필수 구조가 올바르지 않습니다.');
  }
  const reportFiles = Object.keys(report.files);
  if (reportFiles.length !== scope.files.length
    || reportFiles.some((file) => !scope.files.includes(file))) {
    return invalid(outputScope, '보고서 파일이 선택한 검사 범위와 일치하지 않습니다.');
  }
  const exclusionMap = new Map<string, MutationExclusion>();
  for (const exclusion of exclusions) {
    const key = `${exclusion.file}\0${exclusion.id}`;
    if (!scope.files.includes(exclusion.file) || !exclusion.id.trim()
      || !['equivalent', 'excluded'].includes(exclusion.kind) || !exclusion.reason.trim()
      || exclusionMap.has(key)) {
      return invalid(outputScope, '수동 제외의 대상 또는 사유가 올바르지 않습니다.');
    }
    exclusionMap.set(key, { ...exclusion, reason: exclusion.reason.trim() });
  }
  const findings: MutationFinding[] = [];
  const usedExclusions = new Set<string>();
  const ids = new Set<string>();
  for (const file of reportFiles) {
    const fileResult = report.files[file];
    if (!record(fileResult) || typeof fileResult.language !== 'string'
      || typeof fileResult.source !== 'string' || !Array.isArray(fileResult.mutants)) {
      return invalid(outputScope, '변이 파일 구조가 올바르지 않습니다.');
    }
    for (const mutant of fileResult.mutants) {
      if (!record(mutant) || typeof mutant.id !== 'string' || !mutant.id.trim()
        || ids.has(mutant.id) || typeof mutant.mutatorName !== 'string'
        || !mutant.mutatorName.trim() || !location(mutant.location)
        || !statuses.includes(mutant.status as MutationStatus)) {
        return invalid(outputScope, '변이 항목의 필수 값 또는 실행 상태가 올바르지 않습니다.');
      }
      ids.add(mutant.id);
      const status = mutant.status as MutationStatus;
      const key = `${file}\0${mutant.id}`;
      const exclusion = exclusionMap.get(key) ?? null;
      if (exclusion && !((exclusion.kind === 'equivalent'
          && (status === 'Survived' || status === 'NoCoverage'))
        || (exclusion.kind === 'excluded' && status === 'Ignored'))) {
        return invalid(outputScope, '수동 제외 종류와 실제 변이 상태가 일치하지 않습니다.');
      }
      if (exclusion) usedExclusions.add(key);
      findings.push({ file, id: mutant.id, mutatorName: mutant.mutatorName,
        location: { start: { line: mutant.location.start.line, column: mutant.location.start.column },
          end: { line: mutant.location.end.line, column: mutant.location.end.column } },
        status, exclusion });
    }
  }
  if (findings.length === 0) return invalid(outputScope, '변이가 없어 검출력을 판정할 수 없습니다.');
  if (usedExclusions.size !== exclusionMap.size) {
    return invalid(outputScope, '수동 제외 대상이 보고서에 없습니다.');
  }
  const counts = emptyCounts();
  for (const finding of findings) {
    counts[finding.status] += 1;
    if (finding.exclusion) counts.excluded += 1;
  }
  const scored = findings.filter((finding) => !finding.exclusion &&
    ['Killed', 'Timeout', 'Survived', 'NoCoverage'].includes(finding.status));
  const detected = scored.filter((finding) => finding.status === 'Killed' || finding.status === 'Timeout').length;
  const score = scored.length > 0
    ? { detected, denominator: scored.length, percent: detected / scored.length * 100 } : null;
  const failed = findings.some((finding) => !finding.exclusion
    && (finding.status === 'Survived' || finding.status === 'NoCoverage'));
  const incomplete = findings.some((finding) => !finding.exclusion
    && ['Timeout', 'CompileError', 'RuntimeError', 'Ignored', 'Pending'].includes(finding.status));
  const status = failed ? 'failed' : incomplete || !score ? 'unverified' : 'passed';
  return { status, scope: outputScope, schemaVersion: report.schemaVersion,
    findings, counts, score, reason: status === 'passed' ? null
      : failed ? '검출되지 않은 변이가 있습니다.' : '시간 초과, 오류, 미실행 또는 미승인 제외가 있습니다.' };
}
