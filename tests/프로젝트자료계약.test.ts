// 자료 이전 요청의 사람 확인과 동결된 저장 위치 계약을 검증한다.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiInputs, humanMethods } from '../packages/contracts/src/연결.js';
import { outputStorageSchema } from '../packages/contracts/src/실행.js';

describe('프로젝트 자료 이전 계약', () => {
  const projectId = randomUUID();

  it('실제 이전은 확인한 미리보기와 개정 및 사람 확인이 모두 필요하다.', () => {
    const input = { projectId, previewId: randomUUID(), expectedRevision: 2, fingerprint: 'a'.repeat(64), confirm: true };
    expect(apiInputs['apply-project-storage'].safeParse(input).success).toBe(true);
    for (const field of ['previewId', 'fingerprint', 'expectedRevision', 'confirm']) {
      const incomplete: Record<string, unknown> = { ...input };
      delete incomplete[field];
      expect(apiInputs['apply-project-storage'].safeParse(incomplete).success).toBe(false);
    }
    expect(apiInputs['apply-project-storage'].safeParse({ ...input, confirm: false }).success).toBe(false);
    expect(apiInputs['apply-project-storage'].safeParse({ ...input, root: '/different' }).success).toBe(false);
    expect(humanMethods.has('preview-project-storage')).toBe(true);
    expect(humanMethods.has('apply-project-storage')).toBe(true);
  });

  it('미리보기는 제어 문자가 있는 경로와 잘못된 개정을 거절한다.', () => {
    const input = { projectId, root: '/synthetic/output', expectedRevision: 0 };
    expect(apiInputs['preview-project-storage'].safeParse(input).success).toBe(true);
    expect(apiInputs['preview-project-storage'].safeParse({ ...input, root: null }).success).toBe(true);
    expect(apiInputs['preview-project-storage'].safeParse({ ...input, root: '/synthetic/\nother' }).success).toBe(false);
    expect(apiInputs['preview-project-storage'].safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
    expect(apiInputs['preview-project-storage'].safeParse({ ...input, expectedRevision: 0.5 }).success).toBe(false);
  });

  it('다른 프로젝트의 이전 상태를 실행 식별자 하나만으로 조회하지 않는다.', () => {
    const operationId = randomUUID();
    expect(apiInputs['project-storage-operation'].safeParse({ projectId, operationId }).success).toBe(true);
    expect(apiInputs['project-storage-operation'].safeParse({ operationId }).success).toBe(false);
  });

  it('사용자 지정 계획에는 절대 경로와 저장 이름 공간 및 개정이 필요하다.', () => {
    const custom = { layoutVersion: 1, configuredRoot: '/synthetic/output', runsRoot: '/synthetic/output/CheckMate/runs',
      namespaceId: randomUUID(), revision: 1 };
    expect(outputStorageSchema.safeParse(custom).success).toBe(true);
    expect(outputStorageSchema.safeParse({ ...custom, namespaceId: null }).success).toBe(false);
    expect(outputStorageSchema.safeParse({ ...custom, revision: 0 }).success).toBe(false);
    expect(outputStorageSchema.safeParse({ ...custom, runsRoot: 'relative/runs' }).success).toBe(false);
    expect(outputStorageSchema.safeParse({ ...custom, layoutVersion: 2 }).success).toBe(false);
    expect(outputStorageSchema.safeParse({ layoutVersion: 1, configuredRoot: null, runsRoot: '/synthetic/default/runs',
      namespaceId: null, revision: 0 }).success).toBe(true);
  });
});
