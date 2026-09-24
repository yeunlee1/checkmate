// 실행이 소유한 시험 DB를 보여주고 중단된 실행의 선택적 정리를 제공한다.
import { useEffect, useState } from 'react';
import type { ApiMethod } from '@checkmate/contracts/api';

type Resource = { id: string; state: string; descriptor: { name: string; containerId?: string; hostPort?: number };
  cleanup: { verified: boolean; reason: string } | null };
type Props = { runId: string; canCleanup: boolean; disabled: boolean;
  request: <T>(method: ApiMethod, input: Record<string, unknown>) => Promise<T> };
const labels: Record<string, string> = { intent: '생성 의도 저장', creating: '생성 요청', created: '생성 확인', ready: '사용 준비', uncertain: '확인 필요', cleaned: '제거 확인' };

export function TestResources({ runId, canCleanup, disabled, request }: Props) {
  const [data, setData] = useState<{ runId: string; items: Resource[] } | null>(null);
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let current = true;
    setData(null); setConsent(false); setMessage('');
    void request<{ items: Resource[] }>('resources', { runId }).then(result => {
      if (current) setData({ runId, items: result.items });
    }, () => { if (current) setMessage('시험 DB 기록을 읽지 못했습니다. 실행 결과를 다시 열어 주세요.'); });
    return () => { current = false; };
  }, [runId]);
  const items = data?.runId === runId ? data.items : [];
  const remaining = items.filter(item => item.state !== 'cleaned');
  async function cleanup() {
    setWorking(true); setMessage('');
    try {
      const result = await request<{ verified: boolean; resources: Resource[] }>('cleanup-resources', { runId, confirm: true });
      setData({ runId, items: result.resources }); setConsent(false);
      setMessage(result.verified ? '시험 DB 제거를 확인했습니다. 명령 프로세스 종료도 확인한 뒤 아래에 정리 확인을 기록해 주세요.'
        : '일부 시험 DB의 소유권 또는 제거를 확인하지 못했습니다. 기록된 상태를 확인해 주세요.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '시험 DB 정리를 확인하지 못했습니다.'); }
    finally { setWorking(false); }
  }
  if (items.length === 0 && !message) return null;
  return <section className="subsection" aria-label="시험 DB 자원"><h3>시험 DB</h3>
    {items.map(item => <div className="command-card" key={item.id}><strong>PostgreSQL · {labels[item.state] ?? item.state}</strong>
      <p><code>{item.descriptor.name}</code></p>{item.descriptor.containerId && <p className="path-line">컨테이너 <code>{item.descriptor.containerId}</code></p>}
      {item.descriptor.hostPort && <p className="muted">이 컴퓨터의 시험 포트 {item.descriptor.hostPort}</p>}
      {item.cleanup?.reason && <p>{item.cleanup.reason}</p>}</div>)}
    {canCleanup && remaining.length > 0 && <><p>위 실행이 만든 시험 DB의 소유권을 다시 확인한 뒤 제거합니다. 안에 있는 합성 자료도 함께 삭제됩니다.</p>
      <label className="checkline"><input type="checkbox" checked={consent} disabled={disabled || working} onChange={event => setConsent(event.target.checked)} />이 실행의 시험 DB {remaining.length}개 제거를 확인했습니다.</label>
      <button type="button" className="secondary" disabled={disabled || working || !consent} onClick={() => void cleanup()}>{working ? '소유권과 제거 확인 중' : '이 실행의 시험 DB 정리'}</button></>}
    {message && <p role="status">{message}</p>}
  </section>;
}
