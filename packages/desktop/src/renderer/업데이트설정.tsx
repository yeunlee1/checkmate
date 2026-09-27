// 업데이트 확인과 다운로드 상태 및 검사 종료 뒤 재시작 동작을 표시한다.
import { useEffect, useState } from 'react';
import type { UpdateState } from '../main/업데이트.js';
import { text, useLanguage } from './언어.js';

const messages: Record<string, [string, string]> = {
  'installed-windows-only': ['자동 업데이트는 Windows 설치본에서 사용할 수 있습니다.', 'Automatic updates are available in the installed Windows app.'],
  'ready-to-check': ['새 버전을 자동으로 확인합니다.', 'New versions are checked automatically.'],
  'latest-version': ['현재 최신 버전입니다.', 'You are up to date.'],
  checking: ['새 버전을 확인하고 있습니다.', 'Checking for updates.'],
  downloading: ['업데이트를 내려받고 있습니다.', 'Downloading the update.'],
  'restart-to-apply': ['업데이트가 준비됐습니다. 재시작하면 적용됩니다.', 'The update is ready. Restart to apply it.'],
  'engine-active': ['이 설치본을 사용하는 검사나 AI 연결이 있습니다. 작업과 연결이 정상 종료된 뒤 다시 시도하세요.', 'This installation has an active engine or AI connection. Retry after its work and connections end normally.'],
  restarting: ['업데이트를 적용하기 위해 다시 시작합니다.', 'Restarting to apply the update.'],
  'update-failed': ['업데이트를 완료하지 못했습니다. 네트워크와 공개 릴리스를 확인한 뒤 다시 시도하세요.', 'Update failed. Check the network and published release, then retry.'],
  'check-unavailable': ['업데이트 확인을 시작하지 못했습니다. 다른 업데이트와 연결 상태를 확인하세요.', 'Could not check for updates. Check other update activity and connections.'],
  'apply-failed': ['업데이트 적용을 시작하지 못했습니다. 잠시 뒤 다시 시도하세요.', 'Could not apply the update. Try again later.'],
  'lock-unconfirmed': ['업데이트 소유 상태를 확인하지 못했습니다. 진행 중인 설치를 확인하고 앱을 다시 여세요.', 'Update ownership is unconfirmed. Check ongoing installation activity and reopen the app.'],
};
export function UpdateSettings() {
  useLanguage();
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stopped = false;
    const read = async () => { try { const next = await window.checkmate?.update('status'); if (!stopped && next) { setState(next); setError(false); } }
      catch { if (!stopped) setError(true); } };
    void read(); const timer = setInterval(() => { void read(); }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  async function action(kind: 'check' | 'apply') {
    setBusy(true); setError(false);
    try { const next = await window.checkmate?.update(kind); if (next) setState(next); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  const working = busy || !state || ['checking', 'downloading', 'applying'].includes(state.state);
  const message = messages[state?.reason ?? ''];
  return <section className="panel" aria-labelledby="update-heading">
    <h2 id="update-heading">{text('앱 업데이트', 'App updates')}</h2>
    <p role="status">{message ? text(...message) : text('업데이트 상태를 확인하고 있습니다.', 'Reading update status.')}</p>
    {error && <p role="alert">{text('업데이트 상태를 읽지 못했습니다. 다시 시도하세요.', 'Could not read update status. Try again.')}</p>}
    {state?.release && <p>{text('준비된 버전', 'Ready version')} {state.release}</p>}
    <div className="detail-actions">
      <button type="button" className="secondary" onClick={() => void action('check')} disabled={working || state?.state === 'disabled' || state?.downloaded}>{text('업데이트 확인', 'Check for updates')}</button>
      <button type="button" className="primary" onClick={() => void action('apply')} disabled={working || !state?.downloaded}>{text('재시작하여 업데이트', 'Restart and update')}</button>
    </div>
    <p>{text('검사와 자료를 보존하기 위해 엔진이 사용 중이면 업데이트를 미룹니다. 다른 작업을 강제로 종료하지 않습니다.', 'Updates wait while the engine is in use to preserve checks and data. Other work is never forcibly stopped.')}</p>
  </section>;
}
