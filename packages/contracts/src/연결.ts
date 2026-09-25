// 사람과 AI가 같은 로컬 서비스에 요청하는 공개 연결 계약을 정의한다.
import { z } from 'zod';

const uuid = z.uuid();
const id = z.string().min(1).max(160);
const pagination = { cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional() };
export const apiInputs = {
  capabilities: z.strictObject({}),
  projects: z.strictObject({ ...pagination }),
  register: z.strictObject({ path: z.string().min(1).max(4096) }),
  checks: z.strictObject({ projectId: uuid, ...pagination }),
  inspect: z.strictObject({ projectId: uuid, profile: id }),
  approve: z.strictObject({ planId: uuid, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  start: z.strictObject({ projectId: uuid, planId: uuid }),
  status: z.strictObject({ runId: uuid }),
  progress: z.strictObject({ runId: uuid }),
  result: z.strictObject({ runId: uuid, section: z.enum(['summary', 'cases', 'requirements', 'gaps', 'repair-bundle', 'imported']).default('summary'), ...pagination }),
  evidence: z.strictObject({ runId: uuid, evidenceId: uuid, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1024).max(32768).optional(), content: z.boolean().default(false) }),
  'evidence-image': z.strictObject({ runId: uuid, evidenceId: uuid, cursor: z.string().max(4096).optional() }),
  cancel: z.strictObject({ runId: uuid }),
  resources: z.strictObject({ runId: uuid, ...pagination }),
  'cleanup-resources': z.strictObject({ runId: uuid, confirm: z.literal(true) }),
  'acknowledge-cleanup': z.strictObject({ runId: uuid, confirm: z.literal(true), note: z.string().trim().min(8).max(500) }),
  history: z.strictObject({ projectId: uuid, ...pagination }),
  'import-history': z.strictObject({ projectId: uuid, path: z.string().min(1).max(4096) }),
  gaps: z.strictObject({ projectId: uuid, ...pagination }),
  sync: z.strictObject({ projectId: uuid }),
  activate: z.strictObject({ projectId: uuid, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  backup: z.strictObject({}),
  restore: z.strictObject({ backupDirectory: z.string().min(1).max(4096), targetRoot: z.string().min(1).max(4096), confirm: z.literal(true) }),
} as const;

export const apiMethodSchema = z.enum(Object.keys(apiInputs) as [keyof typeof apiInputs, ...(keyof typeof apiInputs)[]]);
export type ApiMethod = keyof typeof apiInputs;
export const apiRequestSchema = z.strictObject({
  apiVersion: z.literal(1), requestId: uuid, method: apiMethodSchema, input: z.record(z.string(), z.json()),
});
export type ApiRequest = z.infer<typeof apiRequestSchema>;
export const apiErrorSchema = z.strictObject({ code: z.string().max(160), message: z.string().max(512), retryable: z.boolean(), nextAction: z.string().max(512) });
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiResponse = { apiVersion: 1; requestId: string; ok: true; data: unknown }
  | { apiVersion: 1; requestId: string; ok: false; error: ApiError };
export const apiResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ apiVersion: z.literal(1), requestId: uuid, ok: z.literal(true), data: z.json() }),
  z.strictObject({ apiVersion: z.literal(1), requestId: uuid, ok: z.literal(false), error: apiErrorSchema }),
]);
export const humanMethods = new Set<ApiMethod>(['register', 'approve', 'activate', 'backup', 'restore', 'import-history', 'evidence-image', 'acknowledge-cleanup', 'cleanup-resources']);

export class ServiceError extends Error {
  constructor(readonly code: string, message = '요청을 처리할 수 없습니다.', readonly retryable = false, readonly nextAction = '입력과 현재 상태를 확인해 주세요.') {
    super(message);
  }
}

export function errorResponse(requestId: string, error: unknown): ApiResponse {
  if (error instanceof z.ZodError) return { apiVersion: 1, requestId, ok: false, error: { code: 'invalid-input', message: '입력 형식과 필수 항목을 확인해 주세요.', retryable: false, nextAction: '도구의 입력 계약에 맞게 요청해 주세요.' } };
  if (error instanceof ServiceError) return { apiVersion: 1, requestId, ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, nextAction: error.nextAction } };
  const known = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'internal-error';
  const allowed = new Set(['invalid-input', 'invalid-project', 'source-unreadable', 'source-too-large', 'source-changed', 'project-not-found', 'plan-stale', 'request-conflict', 'workspace-busy', 'storage-busy', 'storage-error', 'run-not-found', 'invalid-state', 'evidence-not-found', 'evidence-conflict', 'evidence-missing', 'evidence-degraded', 'evidence-restricted', 'unsupported-version', 'schema-mismatch', 'storage-corrupt']);
  return { apiVersion: 1, requestId, ok: false, error: { code: allowed.has(known) ? known : 'internal-error', message: '요청 처리 중 확인이 필요한 문제가 발생했습니다.', retryable: known === 'storage-busy', nextAction: '입력과 서비스 진단 결과를 확인해 주세요.' } };
}
