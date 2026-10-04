// 설치 세대를 검증하며 살아 있는 stdio 연결의 요청과 실행 제어 자격을 보존한다.
import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { errorResponse, ServiceError } from '@checkmate/contracts/api';
import type { AgentInvoker } from './에이아이서버.js';
import { connectService, createAgentInvoker } from '../서비스/클라이언트.js';
import { rejectLinks } from './개인경로.js';
import { compareManagedVersions, managedVersion, readManagedTarget, sameManagedPath } from './관리연결계약.js';
import type { ManagedTarget } from './관리연결계약.js';
import { assertInstallationAvailable, installationRoot as findInstallationRoot } from './업데이트잠금.js';

const capabilitiesSchema = z.object({ version: managedVersion, apiVersion: z.literal(1), serviceEpoch: z.uuid(),
  connection: z.object({ dataRoot: z.string().refine(isAbsolute) }),
  capabilities: z.array(z.string()).refine(values => values.includes('agent-run-control') && values.includes('mcp')) });
const boundCapabilitiesSchema = capabilitiesSchema.extend({ agentSession: z.object({ ownerId: z.uuid(), serviceEpoch: z.uuid() }) });

function sameTarget(left: ManagedTarget, right: ManagedTarget): boolean {
  return left.version === right.version && left.generation === right.generation
    && sameManagedPath(left.installationRoot, right.installationRoot) && sameManagedPath(left.dataRoot, right.dataRoot)
    && sameManagedPath(left.nodeExecutable, right.nodeExecutable) && sameManagedPath(left.serviceEntry, right.serviceEntry);
}

export function createManagedInvoker(installationRoot: string, dataRoot: string): AgentInvoker {
  if (!isAbsolute(installationRoot) || !isAbsolute(dataRoot)) throw new ServiceError('invalid-path');
  const installation = resolve(installationRoot), root = resolve(dataRoot);
  let current: { target: ManagedTarget; epoch: string; invoke: AgentInvoker } | undefined;
  let candidate: { target: ManagedTarget; epoch: string; invoke: AgentInvoker } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return request => {
    // 요청 전체를 직렬화하여 구세대의 응답 유실까지 확정한 뒤에만 새세대로 전환한다.
    const work = queue.then(async () => {
      try {
        await rejectLinks(root);
        if (!sameManagedPath(await realpath(root), root)) throw new ServiceError('managed-root-mismatch');
        // descriptor의 원본 파일이 교체 중이어도 설치본 공통 잠금을 먼저 확인한다.
        const installationNode = current?.target.nodeExecutable ?? join(installation, 'app-0.0.0', 'resources', 'node', 'node.exe');
        const update = join(installation, 'Update.exe');
        await rejectLinks(update);
        const updateInfo = await lstat(update), actualInstallation = await findInstallationRoot(installationNode);
        if (!updateInfo.isFile() || updateInfo.nlink !== 1 || !actualInstallation || !sameManagedPath(actualInstallation, installation))
          throw new ServiceError('managed-installation-mismatch');
        await assertInstallationAvailable(installationNode);
        const target = await readManagedTarget(installation, root);
        await assertInstallationAvailable(target.nodeExecutable);
        if (!sameManagedPath(target.installationRoot, installation) || !sameManagedPath(target.dataRoot, root))
          throw new ServiceError('managed-root-mismatch');
        let upgrading = false;
        if (current) {
          const comparison = compareManagedVersions(target.version, current.target.version);
          if (comparison < 0) throw new ServiceError('managed-version-downgrade');
          if (comparison === 0 && !sameTarget(target, current.target)) throw new ServiceError('managed-generation-mismatch');
          if (comparison > 0 && target.generation === current.target.generation) throw new ServiceError('managed-generation-mismatch');
          upgrading = comparison > 0;
        }
        const options = { dataRoot: root, nodeExecutable: target.nodeExecutable, serviceEntry: target.serviceEntry };
        const probe = await connectService(options);
        if (!probe.ok) return { ...probe, requestId: request.requestId };
        const capabilities = capabilitiesSchema.safeParse(probe.data);
        if (probe.apiVersion !== 1 || !capabilities.success) throw new ServiceError('managed-service-incompatible');
        if (!sameManagedPath(capabilities.data.connection.dataRoot, root)) throw new ServiceError('managed-root-mismatch');
        if (capabilities.data.version !== target.version) throw new ServiceError('managed-service-version-mismatch');
        if (upgrading && current?.epoch === capabilities.data.serviceEpoch) throw new ServiceError('managed-service-epoch-mismatch');
        // 조회 중 descriptor 또는 설치 잠금이 변했으면 원 요청을 보내지 않는다.
        if (!sameTarget(target, await readManagedTarget(installation, root))) throw new ServiceError('managed-target-changed');
        await assertInstallationAvailable(target.nodeExecutable);
        if (!current || upgrading) {
          if (!candidate || !sameTarget(candidate.target, target))
            candidate = { target, epoch: capabilities.data.serviceEpoch, invoke: createAgentInvoker(options) };
          if (candidate.epoch !== capabilities.data.serviceEpoch) throw new ServiceError('managed-service-epoch-mismatch');
          // lazy 세션을 readonly 요청으로 먼저 열고 자격이 바인딩된 응답만 채택한다.
          const boundProbe = await candidate.invoke({ apiVersion: 1, requestId: randomUUID(), method: 'capabilities', input: {} });
          if (!boundProbe.ok) return { ...boundProbe, requestId: request.requestId };
          const bound = boundCapabilitiesSchema.safeParse(boundProbe.data);
          if (boundProbe.apiVersion !== 1 || !bound.success) throw new ServiceError('managed-service-incompatible');
          if (!sameManagedPath(bound.data.connection.dataRoot, root)) throw new ServiceError('managed-root-mismatch');
          if (bound.data.version !== target.version) throw new ServiceError('managed-service-version-mismatch');
          if (bound.data.serviceEpoch !== candidate.epoch || bound.data.agentSession.serviceEpoch !== candidate.epoch)
            throw new ServiceError('managed-service-epoch-mismatch');
          if (!sameTarget(target, await readManagedTarget(installation, root))) throw new ServiceError('managed-target-changed');
          await assertInstallationAvailable(target.nodeExecutable);
          current = candidate;
          candidate = undefined;
        }
        if (['start', 'cancel'].includes(request.method) && current.epoch !== capabilities.data.serviceEpoch)
          throw new ServiceError('agent-control-required', '서비스가 다시 시작되어 이전 실행 제어 자격을 사용할 수 없습니다.',
            false, '조회로 상태를 확인하고 기존 실행의 제어권은 사람이 명시적으로 처리해 주세요.');
        // 명시적 같은 요청의 재확인은 서버의 본문과 원 owner 검증에 맡긴다.
        return await current.invoke(request);
      } catch (error) { return errorResponse(request.requestId, error); }
    });
    queue = work.catch(() => {});
    return work;
  };
}
