// 실행이 소유한 시험 DB를 보여주고 중단된 실행의 선택적 정리를 제공한다.
import { useEffect, useState } from 'react';
import type { ApiMethod } from '@checkmate/contracts/api';
import { useLanguage, text } from './언어.js';

type Resource = { id: string; state: string; descriptor: { name: string; containerId?: string; hostPort?: number };
  cleanup: { verified: boolean; reason: string } | null };
type Props = { runId: string; canCleanup: boolean; disabled: boolean;
  request: <T>(method: ApiMethod, input: Record<string, unknown>) => Promise<T> };
type Message = 'cleaned' | 'cleanup-unverified' | { code: string; operation: 'read' | 'cleanup' } | null;

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}

function messageText(message: Message): string {
  if (message === 'cleaned') return text('시험 DB 제거를 확인했습니다. 명령 프로세스 종료도 확인한 뒤 아래에 정리 확인을 기록해 주세요.',
    'Test database removal was verified. Check that the command process has ended, then record cleanup confirmation below.');
  if (message === 'cleanup-unverified') return text('일부 시험 DB의 소유권 또는 제거를 확인하지 못했습니다. 기록된 상태를 확인해 주세요.',
    'Ownership or removal of some test databases could not be verified. Review the recorded state.');
  if (message && typeof message === 'object') {
    switch (message.code) {
      case 'bridge-unavailable': return text('데스크톱 연결이 준비되지 않았습니다. 앱에서 다시 열어 주세요.',
        'The desktop connection is unavailable. Reopen the app and try again.');
      case 'not-found': return text('이 실행의 시험 DB 기록을 찾지 못했습니다. 실행 결과를 다시 열어 주세요.',
        'The test database record for this run was not found. Reopen the run result.');
      case 'invalid-state': return text('이 실행은 수동 정리를 허용하는 상태가 아닙니다. 실행 결과를 다시 확인해 주세요.',
        'This run is not eligible for manual cleanup. Review its run result.');
      case 'workspace-busy': return text('같은 작업 폴더의 실행이 끝난 뒤 다시 시도해 주세요.',
        'Wait for the run in the same workspace to finish, then try again.');
      case 'needs-approval': return text('이 실행의 시험 DB와 확인 항목을 살펴본 뒤 다시 승인해 주세요.',
        'Review this run\'s test databases and confirmation box, then approve again.');
      case 'storage-busy': return text('저장 작업이 진행 중입니다. 잠시 뒤 다시 시도해 주세요.',
        'Storage is busy. Try again shortly.');
      case 'unsupported-operation': return text('이 설치에서는 시험 DB 정리를 사용할 수 없습니다.',
        'Test database cleanup is unavailable in this installation.');
    }
    if (message.operation === 'read') return text('시험 DB 기록을 읽지 못했습니다. 실행 결과를 다시 열어 주세요.',
      'Could not load the test database record. Reopen the run result.');
    return text('시험 DB 정리를 확인하지 못했습니다. 실행 결과를 다시 확인해 주세요.',
      'Could not verify test database cleanup. Review the run result.');
  }
  return '';
}

export function TestResources({ runId, canCleanup, disabled, request }: Props) {
  useLanguage();
  const [data, setData] = useState<{ runId: string; items: Resource[] } | null>(null);
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => {
    let current = true;
    setData(null); setConsent(false); setMessage(null);
    void request<{ items: Resource[] }>('resources', { runId }).then(result => {
      if (current) setData({ runId, items: result.items });
    }, (error) => { if (current) setMessage({ code: errorCode(error), operation: 'read' }); });
    return () => { current = false; };
  }, [runId]);
  const items = data?.runId === runId ? data.items : [];
  const remaining = items.filter(item => item.state !== 'cleaned');
  async function cleanup() {
    setWorking(true); setMessage(null);
    try {
      const result = await request<{ verified: boolean; resources: Resource[] }>('cleanup-resources', { runId, confirm: true });
      setData({ runId, items: result.resources }); setConsent(false);
      setMessage(result.verified ? 'cleaned' : 'cleanup-unverified');
    } catch (error) { setMessage({ code: errorCode(error), operation: 'cleanup' }); }
    finally { setWorking(false); }
  }
  if (items.length === 0 && !message) return null;
  const labels: Record<string, string> = {
    intent: text('생성 의도 저장', 'Creation planned'), creating: text('생성 요청', 'Creation requested'),
    created: text('생성 확인', 'Created'), ready: text('사용 준비', 'Ready for use'),
    uncertain: text('확인 필요', 'Needs review'), cleaned: text('제거 확인', 'Removal verified'),
  };
  return <section className="subsection" aria-label={text('시험 DB 자원', 'Test database resources')}>
    <h3>{text('시험 DB', 'Test databases')}</h3>
    <p>{text('이 실행이 만든 임시 PostgreSQL 데이터베이스와 정리 상태입니다.',
      'Temporary PostgreSQL databases created by this run and their cleanup status.')}</p>
    {items.map(item => <div className="command-card" key={item.id}><strong>PostgreSQL · {labels[item.state] ?? item.state}</strong>
      <p><code>{item.descriptor.name}</code></p>{item.descriptor.containerId && <p className="path-line">{text('컨테이너', 'Container')} <code>{item.descriptor.containerId}</code></p>}
      {item.descriptor.hostPort && <p className="muted">{text('이 컴퓨터의 시험 포트', 'Local test port')} {item.descriptor.hostPort}</p>}
      {item.cleanup?.reason && <p>{item.cleanup.reason}</p>}</div>)}
    {canCleanup && remaining.length > 0 && <><p>{text('이 실행이 만든 시험 DB의 소유권을 다시 확인한 뒤 제거합니다. 안에 있는 합성 자료도 함께 삭제됩니다.',
      'Check ownership again before removing only the test databases made by this run. Their synthetic test data will also be deleted.')}</p>
      <label className="checkline"><input type="checkbox" checked={consent} disabled={disabled || working} onChange={event => setConsent(event.target.checked)} />
        {text(`이 실행의 시험 DB ${remaining.length}개 제거를 확인했습니다.`, `I confirm removal of ${remaining.length} test database(s) from this run.`)}</label>
      <button type="button" className="secondary" style={{ maxWidth: '100%', whiteSpace: 'normal', textAlign: 'center' }}
        disabled={disabled || working || !consent} onClick={() => void cleanup()}>{working
          ? text('소유권과 제거 확인 중', 'Checking ownership and removal')
          : text('이 실행의 시험 DB 정리', 'Clean up this run\'s test databases')}</button></>}
    {message && <p role="status">{messageText(message)}</p>}
  </section>;
}
