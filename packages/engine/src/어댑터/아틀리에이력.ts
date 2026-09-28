// 아틀리에의 과거 검증 보고서를 읽기 전용 안전 요약으로 변환한다.
import { createHash } from 'node:crypto';

type ReportStatus = 'running' | 'checks-passed' | 'passed' | 'failed' | 'source-changed';
type StepStatus = 'not-run' | 'running' | 'passed' | 'failed' | 'timed-out' | 'interrupted';
type EnvironmentKind = 'D1' | 'PostgreSQL' | 'mock-api' | 'unknown';
type ErrorCode = 'invalid-json' | 'too-large' | 'invalid-report' | 'invalid-step' | 'duplicate-step' | 'invalid-fingerprint';

export type AtelierImportError = { code: ErrorCode; path: string };
export type AtelierImportedReport = {
  origin: 'imported';
  reportedStatus: ReportStatus;
  mode: 'quick' | 'full' | 'e2e';
  environment: { kind: EnvironmentKind; verified: false; basis: 'source-contract' | 'none' };
  steps: { id: string; status: StepStatus; exitCode: number | null; environment: EnvironmentKind }[];
  omissions: { notRunStepIds: string[]; declaredCount: number };
  source: { beforeFingerprint: string; afterFingerprint: string | null };
  originalSha256: string;
  reusablePassed: false;
  effectiveVerdict: 'unknown';
  summary: { passed: number; failed: number; notRun: number; other: number; total: number };
};
export type AtelierImportResult = { ok: true; report: AtelierImportedReport }
  | { ok: false; errors: AtelierImportError[] };

const maxBytes = 1024 * 1024;
const maxSteps = 64;
const maxOmissions = 32;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const statuses = new Set<ReportStatus>(['running', 'checks-passed', 'passed', 'failed', 'source-changed']);
const stepStatuses = new Set<StepStatus>(['not-run', 'running', 'passed', 'failed', 'timed-out', 'interrupted']);
const d1Steps = new Set(['customers', 'quotes', 'products', 'bundles']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fingerprint(value: unknown): string | null {
  return record(value) && typeof value.fingerprint === 'string' && hashPattern.test(value.fingerprint)
    ? value.fingerprint : null;
}

function stepEnvironment(id: string): EnvironmentKind {
  if (d1Steps.has(id)) return 'D1';
  if (id === 'staff-ui') return 'mock-api';
  return 'unknown';
}

export function importAtelierReport(input: unknown): AtelierImportResult {
  let bytes: Buffer;
  let value: unknown;
  try {
    if (Buffer.isBuffer(input)) {
      bytes = input;
      if (bytes.length > maxBytes) return { ok: false, errors: [{ code: 'too-large', path: '$' }] };
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else if (typeof input === 'string') {
      bytes = Buffer.from(input, 'utf8');
      if (bytes.length > maxBytes) return { ok: false, errors: [{ code: 'too-large', path: '$' }] };
      value = JSON.parse(input);
    } else {
      bytes = Buffer.from(JSON.stringify(input), 'utf8');
      if (bytes.length > maxBytes) return { ok: false, errors: [{ code: 'too-large', path: '$' }] };
      value = input;
    }
  } catch {
    return { ok: false, errors: [{ code: 'invalid-json', path: '$' }] };
  }
  if (!record(value) || typeof value.mode !== 'string' || !['quick', 'full', 'e2e'].includes(value.mode)
    || !statuses.has(value.status as ReportStatus) || !Array.isArray(value.steps)
    || value.steps.length === 0 || value.steps.length > maxSteps) {
    return { ok: false, errors: [{ code: 'invalid-report', path: '$' }] };
  }
  const beforeFingerprint = fingerprint(value.source);
  const afterFingerprint = value.sourceAfter === undefined ? null : fingerprint(value.sourceAfter);
  if (!beforeFingerprint || (value.sourceAfter !== undefined && !afterFingerprint)) {
    return { ok: false, errors: [{ code: 'invalid-fingerprint', path: '$.source' }] };
  }
  if (value.omitted !== undefined && (!Array.isArray(value.omitted)
    || value.omitted.length > maxOmissions || value.omitted.some((item: unknown) => typeof item !== 'string' || item.length > 256))) {
    return { ok: false, errors: [{ code: 'invalid-report', path: '$.omitted' }] };
  }
  const steps: AtelierImportedReport['steps'] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.steps.entries()) {
    const path = `$.steps[${index}]`;
    if (!record(item) || typeof item.id !== 'string' || !idPattern.test(item.id)
      || !stepStatuses.has(item.status as StepStatus)
      || (item.exitCode !== undefined && item.exitCode !== null
        && (typeof item.exitCode !== 'number' || !Number.isSafeInteger(item.exitCode) || item.exitCode < 0))
      || (item.status === 'passed' && item.exitCode !== 0)
      || (item.status === 'not-run' && item.exitCode !== undefined)) {
      return { ok: false, errors: [{ code: 'invalid-step', path }] };
    }
    if (seen.has(item.id)) return { ok: false, errors: [{ code: 'duplicate-step', path }] };
    seen.add(item.id);
    steps.push({ id: item.id, status: item.status as StepStatus,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      environment: stepEnvironment(item.id) });
  }
  const counts = { passed: 0, failed: 0, notRun: 0, other: 0, total: steps.length };
  for (const step of steps) {
    if (step.status === 'passed') counts.passed++;
    else if (step.status === 'failed' || step.status === 'timed-out' || step.status === 'interrupted') counts.failed++;
    else if (step.status === 'not-run') counts.notRun++;
    else counts.other++;
  }
  if (value.status === 'passed' && (!afterFingerprint || beforeFingerprint !== afterFingerprint
    || counts.passed !== steps.length)) {
    return { ok: false, errors: [{ code: 'invalid-report', path: '$.status' }] };
  }
  const classified = new Set(steps.map((step) => step.environment).filter((kind) => kind !== 'unknown'));
  const environment: AtelierImportedReport['environment'] = classified.size === 1
    ? { kind: [...classified][0]!, verified: false, basis: 'source-contract' }
    : { kind: 'unknown', verified: false, basis: 'none' };
  return { ok: true, report: {
    origin: 'imported', reportedStatus: value.status as ReportStatus,
    mode: value.mode as AtelierImportedReport['mode'], environment, steps,
    omissions: { notRunStepIds: steps.filter((step) => step.status === 'not-run').map((step) => step.id),
      declaredCount: Array.isArray(value.omitted) ? value.omitted.length : 0 },
    source: { beforeFingerprint, afterFingerprint },
    originalSha256: createHash('sha256').update(bytes).digest('hex'),
    reusablePassed: false, effectiveVerdict: 'unknown', summary: counts,
  } };
}
