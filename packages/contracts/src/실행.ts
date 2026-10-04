// 등록된 검사 계획과 실행 저장소의 내부 연결 계약을 정의한다.
import { z } from 'zod';
import type { RunResult } from './결과.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(160);
const storagePath = z.string().min(1).max(4096).refine(value => /^(?:[A-Za-z]:[\\/]|\/)/u.test(value)
  && !/[\x00-\x1f\x7f]/u.test(value), '검사 자료의 절대 저장 경로가 필요합니다.');
export const outputStorageSchema = z.strictObject({
  layoutVersion: z.literal(1), configuredRoot: storagePath.nullable(), runsRoot: storagePath,
  namespaceId: z.uuid().nullable(), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine(value => value.configuredRoot === null || (value.namespaceId !== null && value.revision > 0),
  '사용자 지정 저장 위치의 이름 공간과 개정이 필요합니다.');
export type OutputStorageSnapshot = z.infer<typeof outputStorageSchema>;
export const planRegistrationSchema = z.strictObject({
  project: z.strictObject({ id: z.uuid(), name: identifier, repositoryIdentity: z.string().min(1).max(2048) }),
  workspace: z.strictObject({ id: z.uuid(), realPath: z.string().min(1).max(4096), pathFingerprint: hash }),
  catalog: z.strictObject({ id: z.uuid(), contentHash: hash, source: z.record(z.string(), z.json()) }),
  plan: z.strictObject({
    id: z.uuid(), fingerprint: hash, sourceHash: hash, profile: identifier,
    plannedChecks: z.array(identifier).max(100000), requiredChecks: z.array(identifier).max(100000),
    outputStorage: outputStorageSchema.optional(),
    nativeResourceRoot: z.string().min(1).max(4096).refine(value => /^(?:[A-Za-z]:[\\/]|\/)/u.test(value)
      && !/[\x00-\x1f\x7f]/u.test(value), '네이티브 자원의 절대 전용 폴더가 필요합니다.').optional(),
  }),
  createdAt: z.iso.datetime(),
}).superRefine((value, context) => {
  const planned = new Set(value.plan.plannedChecks);
  if (planned.size !== value.plan.plannedChecks.length
    || new Set(value.plan.requiredChecks).size !== value.plan.requiredChecks.length
    || value.plan.requiredChecks.some((id) => !planned.has(id))) {
    context.addIssue({ code: 'custom', message: '검사 계획의 ID가 중복되거나 필수 검사가 계획에 없습니다.' });
  }
});

export type PlanRegistration = z.infer<typeof planRegistrationSchema>;
export type Admission = {
  projectId: string; planId: string; requestId: string; requestHash: string; runId: string; createdAt: string;
  owner?: ControlOwner;
  lease?: Record<string, unknown>;
};
export type ControlOwner = { ownerId: string; ownerHash: string; serviceEpoch: string };
export type RunControl = ControlOwner & { revision: number };
export type RunMetadata = { workspaceId: string; planId: string; ownerId: string | null; ownershipRevision: number | null };
export type AdmissionResult = { runId: string; reused: boolean };
export type RunPage = { runs: RunResult[]; nextCursor: string | null };
export type RunProgress = {
  runId: string;
  state: RunResult['state'];
  finalized: boolean;
  available: boolean;
  phase: 'queued' | 'preparing' | 'running' | 'verifying' | 'cleaning' | 'finished' | 'unavailable';
  currentCommand: { id: string; title: string } | null;
  completedCommands: number;
  totalCommands: number;
  updatedAt: string | null;
};
export type RunStoreErrorCode = 'invalid-input' | 'project-not-found' | 'plan-stale' | 'request-conflict'
  | 'workspace-busy' | 'storage-busy' | 'storage-error' | 'run-not-found' | 'invalid-state' | 'run-owner-mismatch';

export class RunStoreError extends Error {
  constructor(readonly code: RunStoreErrorCode) {
    super('실행 저장 작업을 처리할 수 없습니다.');
  }
}

// 등록과 실행 호출은 향후 승인된 서비스 경계에서만 허용하며 공개 MCP 입력이 아니다.
export interface RunStore {
  registerPlan(input: PlanRegistration): void;
  getPlan(planId: string): PlanRegistration | null;
  admitRun(input: Admission, guard?: () => void): AdmissionResult;
  markRunning(runId: string): RunResult;
  finalizeRun(result: RunResult): RunResult;
  getRun(runId: string): RunResult | null;
  listRuns(projectId: string, limit?: number, cursor?: string): RunPage;
}
