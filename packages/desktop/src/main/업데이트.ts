// 설치본 업데이트를 중복 없이 확인하고 같은 설치본의 엔진 종료를 확인한 뒤 적용한다.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireUpdateLock, recoverExitedUpdateLock } from '@checkmate/engine/update-lock';

export const updateFeed = 'https://github.com/yeunlee1/checkmate/releases/latest/download';
export type UpdateState = { state: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'blocked' | 'error' | 'applying'; reason: string; release: string | null; checkedAt: string | null; downloaded: boolean };
export interface Updater {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}
export async function installationIdle(root: string): Promise<boolean> {
  const encoded = Buffer.from(root, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')).TrimEnd('\\')+'\\'; $busy=$false; foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='Update.exe' OR Name='작업보호.exe'")) { if(-not $p.ExecutablePath) { throw 'process-path-unknown' }; if($p.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { $busy=$true } }; if($busy) {'busy'} else {'idle'}`;
  const windows = process.env.SystemRoot;
  if (!windows) throw new Error('process-observation-unavailable');
  const result = await promisify(execFile)(join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 65536 });
  if (!['idle', 'busy'].includes(result.stdout.trim())) throw new Error('process-observation-unavailable');
  return result.stdout.trim() === 'idle';
}

export class UpdateController {
  private value: Omit<UpdateState, 'downloaded'>;
  private releaseLock: (() => Promise<void>) | null = null;
  private starting = false;
  private downloaded = false;
  constructor(private readonly updater: Updater, private readonly root: string | null,
    private readonly idle: () => Promise<boolean> = () => installationIdle(root!),
    private readonly lock = () => acquireUpdateLock(root!)) {
    this.value = { state: root ? 'idle' : 'disabled', reason: root ? 'ready-to-check' : 'installed-windows-only', release: null, checkedAt: null };
    if (!root) return;
    updater.setFeedURL({ url: updateFeed });
    updater.on('update-available', () => { this.value = { ...this.value, state: 'downloading', reason: 'downloading' }; });
    updater.on('update-not-available', () => { void this.finish('idle', 'latest-version'); });
    updater.on('update-downloaded', (_event, _notes, name) => {
      this.downloaded = true;
      this.value.release = typeof name === 'string' ? name.slice(0, 120) : null;
      void this.finish('ready', 'restart-to-apply');
    });
    updater.on('error', () => { void this.finish('error', 'update-failed'); });
  }
  status(): UpdateState { return { ...this.value, downloaded: this.downloaded }; }
  async recover(): Promise<void> { if (this.root) await recoverExitedUpdateLock(this.root, this.idle); }
  private async finish(state: UpdateState['state'], reason: string): Promise<void> {
    const release = this.releaseLock;
    this.releaseLock = null;
    try { await release?.(); this.value = { ...this.value, state, reason }; }
    catch { this.value = { ...this.value, state: 'error', reason: 'lock-unconfirmed' }; }
    finally { this.starting = false; }
  }
  async check(): Promise<UpdateState> {
    if (!this.root || this.starting || this.downloaded || ['checking', 'downloading', 'applying'].includes(this.value.state)) return this.status();
    this.starting = true;
    try {
      await this.recover();
      this.releaseLock = await this.lock();
      if (!await this.idle()) { await this.finish('blocked', 'engine-active'); return this.status(); }
      this.value = { ...this.value, state: 'checking', reason: 'checking', checkedAt: new Date().toISOString() };
      this.updater.checkForUpdates();
    } catch { await this.finish('error', 'check-unavailable'); }
    return this.status();
  }
  async apply(): Promise<UpdateState> {
    if (!this.root || !this.downloaded || this.starting || this.value.state === 'applying') return this.status();
    this.starting = true;
    try {
      this.releaseLock = await this.lock();
      if (!await this.idle()) { await this.finish('blocked', 'engine-active'); return this.status(); }
      this.value = { ...this.value, state: 'applying', reason: 'restarting' };
      this.updater.quitAndInstall();
    } catch { await this.finish('error', 'apply-failed'); }
    return this.status();
  }
  async close(): Promise<void> {
    // 적용 중인 잠금은 다음 앱에서 이전 PID 종료와 설치 프로세스 부재를 확인한 뒤 회수한다.
    if (!this.starting && !['checking', 'downloading', 'applying'].includes(this.value.state)) await this.finish(this.value.state, this.value.reason);
  }
}
