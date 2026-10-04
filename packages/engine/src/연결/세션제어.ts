// 서비스가 발급한 비밀 자격을 검증하고 실행 제어 주체를 메모리에 유지한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ServiceError } from '@checkmate/contracts/api';
import type { ControlOwner } from '@checkmate/contracts/runs';

export type CallerContext = Readonly<ControlOwner>;
export class SessionControl {
  readonly epoch = randomUUID();
  private readonly credentials = new Map<string, CallerContext>();
  private readonly contexts = new Set<CallerContext>();
  open(): { credential: string; ownerId: string; serviceEpoch: string } {
    const credential = randomBytes(32).toString('hex');
    const owner = Object.freeze({ ownerId: randomUUID(), ownerHash: this.hash(credential), serviceEpoch: this.epoch });
    this.credentials.set(owner.ownerHash, owner);
    this.contexts.add(owner);
    return { credential, ownerId: owner.ownerId, serviceEpoch: owner.serviceEpoch };
  }
  private hash(credential: string): string { return createHash('sha256').update(credential).digest('hex'); }
  verify(credential: string): CallerContext {
    if (!/^[a-f0-9]{64}$/u.test(credential)) throw new ServiceError('agent-control-required');
    const context = this.credentials.get(this.hash(credential));
    if (!context) throw new ServiceError('agent-control-required', '현재 서비스에서 확인한 실행 제어 자격이 필요합니다.');
    return context;
  }
  assert(context?: CallerContext): CallerContext {
    if (!context || !this.contexts.has(context)) throw new ServiceError('agent-control-required');
    return context;
  }
  find(ownerId: string): CallerContext {
    const context = [...this.contexts].find(item => item.ownerId === ownerId);
    if (!context) throw new ServiceError('owner-not-found', '현재 서비스에 연결된 대상 제어 주체를 확인해 주세요.');
    return context;
  }
  list(): { ownerId: string }[] { return [...this.contexts].map(({ ownerId }) => ({ ownerId })); }
}
