// 업데이트 확인과 다운로드 상태 및 검사 종료 뒤 재시작 동작을 표시한다.
import { useEffect, useState } from 'react';
import type { UpdateState } from '../main/업데이트.js';
import { text, useLanguage } from './언어.js';

const messages: Record<string, [string, string]> = {
  'installed-windows-only': ['자동 업데이트는 Windows 설치본에서 사용할 수 있습니다.', 'Automatic updates are available in the installed Windows app.'],
  'ready-to-check': ['새 버전을 자동으로 확인합니다.', 'New versions are checked automatically.'],
  'latest-version': ['현재 최신 버전입니다.', 'You are up to date.'],
  'update-available': ['새 버전이 있습니다. 관리형 AI 연결은 유지할 수 있습니다. 검사와 정리가 끝난 뒤 내려받기를 시작하세요.', 'A new version is available. Managed AI connections can stay open. Download after checks and cleanup finish.'],
  checking: ['새 버전을 확인하고 있습니다.', 'Checking for updates.'],
  downloading: ['업데이트를 내려받고 있습니다.', 'Downloading the update.'],
  'restart-to-apply': ['업데이트가 준비됐습니다. 재시작하면 적용됩니다.', 'The update is ready. Restart to apply it.'],
  'downloaded-version-changed': ['확인한 버전과 실제 내려받은 버전이 다릅니다. 준비된 버전을 확인한 뒤 재시작하세요.', 'The downloaded version differs from the checked version. Review the ready version before restarting.'],
  'engine-active': ['이 설치본의 검사나 서비스가 아직 사용 중입니다. 검사와 정리 및 서비스의 자연 종료를 기다리세요. 기존 AI 연결은 필요하면 정상 종료하세요.', 'This installation has active checks or services. Wait for checks, cleanup and services to end naturally. Close legacy AI connections normally when needed.'],
  restarting: ['업데이트를 적용하기 위해 다시 시작합니다.', 'Restarting to apply the update.'],
  'update-failed': ['업데이트를 완료하지 못했습니다. 네트워크와 공개 릴리스를 확인한 뒤 다시 시도하세요.', 'Update failed. Check the network and published release, then retry.'],
  'check-unavailable': ['업데이트 목록을 확인하지 못했습니다. 네트워크와 공개 릴리스를 확인한 뒤 다시 시도하세요.', 'Could not verify the update list. Check the network and published release, then retry.'],
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
  async function action(kind: 'check' | 'download' | 'apply') {
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
    {state?.availableVersion && <p>{text('확인한 버전', 'Checked version')} {state.availableVersion}</p>}
    {state?.release && <p>{text('준비된 버전', 'Ready version')} {state.release}</p>}
    <div className="detail-actions">
      <button type="button" className="secondary" onClick={() => void action('check')} disabled={working || state?.state === 'disabled' || state?.downloaded}>{text('업데이트 확인', 'Check for updates')}</button>
      <button type="button" className="secondary" onClick={() => void action('download')} disabled={working || state?.downloaded || !state?.availableVersion || !['available', 'blocked'].includes(state.state)}>{text('업데이트 내려받기', 'Download update')}</button>
      <button type="button" className="primary" onClick={() => void action('apply')} disabled={working || !state?.downloaded}>{text('재시작하여 업데이트', 'Restart and update')}</button>
    </div>
    <p>{text('업데이트 확인은 AI 연결 중에도 가능합니다. 관리형 연결은 유지하고 검사와 정리 및 서비스의 자연 종료를 기다립니다. 기존 연결은 필요한 경우 정상 종료하세요. 다른 작업을 강제로 종료하지 않습니다.', 'You can check for updates during AI connections. Keep managed connections open while checks, cleanup and services end naturally. Close legacy connections normally when needed. Other work is never forcibly stopped.')}</p>
    <p>{text('관리형 연결은 업데이트 후 새 AI 연결 세션으로 자동 연결됩니다. 이전 검사 제어권은 넘기지 않습니다. 기존 MCP 연결은 관리형 연결로 최초 전환이 필요합니다.', 'Managed connections reconnect automatically with a new AI session after updates. Control of previous checks is not transferred. Existing MCP connections need an initial switch to managed connections.')}</p>
  </section>;
}
