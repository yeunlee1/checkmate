// 설치본 업데이트를 중복 없이 확인하고 같은 설치본의 엔진 종료를 확인한 뒤 적용한다.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireUpdateLock, recoverExitedUpdateLock } from '@checkmate/engine/update-lock';

export const updateFeed = 'https://github.com/yeunlee1/checkmate/releases/latest/download';
export type UpdateState = { state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'blocked' | 'error' | 'applying'; reason: string; availableVersion: string | null; release: string | null; checkedAt: string | null; downloaded: boolean };
export interface Updater {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}
function versionParts(version: string): number[] {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('invalid-release-version');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('invalid-release-version');
  return parts;
}
function releaseVersion(source: string): string {
  const match = source.match(/^([a-fA-F0-9]{40})[ \t]+CheckMate-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-full\.nupkg[ \t]+([1-9]\d*)(?:\r?\n)?$/);
  if (!match || match[0] !== source || !Number.isSafeInteger(Number(match[3]))) throw new Error('invalid-release-metadata');
  versionParts(match[2]!);
  return match[2]!;
}
function newerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate); const previous = versionParts(current);
  const different = next.findIndex((part, index) => part !== previous[index]);
  return different >= 0 && next[different]! > previous[different]!;
}
export async function installationIdle(root: string, timeoutMs = 15000): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('process-observation-unavailable');
  const encoded = Buffer.from(root, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')).TrimEnd('\\')+'\\'; $busy=$false; foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='Update.exe' OR Name='작업보호.exe'")) { if(-not $p.ExecutablePath) { throw 'process-path-unknown' }; if($p.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { $busy=$true } }; if($busy) {'busy'} else {'idle'}`;
  const windows = process.env.SystemRoot;
  if (!windows) throw new Error('process-observation-unavailable');
  const result = await promisify(execFile)(join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, timeout: Math.min(timeoutMs, 15000), maxBuffer: 65536 });
  if (!['idle', 'busy'].includes(result.stdout.trim())) throw new Error('process-observation-unavailable');
  return result.stdout.trim() === 'idle';
}

export class UpdateController {
  private value: Omit<UpdateState, 'downloaded'>;
  private releaseLock: (() => Promise<void>) | null = null;
  private starting = false;
  private downloaded = false;
  private closed = false;
  private acceptingTerminal = false;
  private finishing: Promise<void> | null = null;
  constructor(private readonly updater: Updater, private readonly root: string | null,
    private readonly currentVersion: string, private readonly readMetadata: () => Promise<string>,
    private readonly idle: () => Promise<boolean> = () => installationIdle(root!),
    private readonly lock = () => acquireUpdateLock(root!)) {
    this.value = { state: root ? 'idle' : 'disabled', reason: root ? 'ready-to-check' : 'installed-windows-only', availableVersion: null, release: null, checkedAt: null };
    if (!root) return;
    updater.on('update-available', () => { if (this.acceptingTerminal && this.value.state === 'downloading') this.value.reason = 'downloading'; });
    updater.on('update-not-available', () => { if (this.acceptingTerminal && this.value.state === 'downloading') void this.finish('idle', 'latest-version'); });
    updater.on('update-downloaded', (_event, _notes, name) => {
      if (!this.acceptingTerminal || this.value.state !== 'downloading') return;
      this.acceptingTerminal = false;
      this.downloaded = true;
      this.value.release = typeof name === 'string' ? name.slice(0, 120) : null;
      void this.finish('ready', this.value.release === this.value.availableVersion ? 'restart-to-apply' : 'downloaded-version-changed');
    });
    updater.on('error', () => { if (this.acceptingTerminal && ['downloading', 'applying'].includes(this.value.state)) void this.finish('error', 'update-failed'); });
  }
  status(): UpdateState { return { ...this.value, downloaded: this.downloaded }; }
  async recover(): Promise<void> { if (this.root) await recoverExitedUpdateLock(this.root, this.idle); }
  private finish(state: UpdateState['state'], reason: string): Promise<void> {
    if (this.finishing) return this.finishing;
    this.acceptingTerminal = false;
    const release = this.releaseLock;
    this.releaseLock = null;
    this.finishing = Promise.resolve().then(async () => {
      try { await release?.(); this.value = { ...this.value, state, reason }; }
      catch { this.value = { ...this.value, state: 'error', reason: 'lock-unconfirmed' }; }
      finally { this.starting = false; this.finishing = null; }
    });
    return this.finishing;
  }
  private async stopStarting(): Promise<UpdateState> {
    await this.finish('blocked', 'app-closing');
    return this.status();
  }
  async check(): Promise<UpdateState> {
    if (this.closed || !this.root || this.starting || this.downloaded || this.value.reason === 'lock-unconfirmed' || ['checking', 'downloading', 'applying'].includes(this.value.state)) return this.status();
    this.starting = true;
    this.value = { ...this.value, state: 'checking', reason: 'checking', availableVersion: null, checkedAt: new Date().toISOString() };
    try {
      const source = await this.readMetadata();
      if (this.closed) return await this.stopStarting();
      const version = releaseVersion(source);
      const newer = newerVersion(version, this.currentVersion);
      this.value = { ...this.value, availableVersion: version, state: newer ? 'available' : 'idle', reason: newer ? 'update-available' : 'latest-version' };
    } catch {
      if (this.closed) return await this.stopStarting();
      this.value = { ...this.value, state: 'error', reason: 'check-unavailable', availableVersion: null };
    }
    finally { this.starting = false; }
    return this.status();
  }
  async download(): Promise<UpdateState> {
    if (this.closed || !this.root || this.starting || this.downloaded || this.value.reason === 'lock-unconfirmed' || ['checking', 'downloading', 'applying'].includes(this.value.state)) return this.status();
    this.starting = true;
    this.value = { ...this.value, state: 'checking', reason: 'checking', availableVersion: null, checkedAt: new Date().toISOString() };
    try {
      const source = await this.readMetadata();
      if (this.closed) return this.stopStarting();
      const version = releaseVersion(source);
      this.value.availableVersion = version;
      if (!newerVersion(version, this.currentVersion)) { await this.finish('idle', 'latest-version'); return this.status(); }
      await this.recover();
      if (this.closed) return this.stopStarting();
      this.releaseLock = await this.lock();
      if (this.closed) return this.stopStarting();
      const idle = await this.idle();
      if (this.closed) return this.stopStarting();
      if (!idle) { await this.finish('blocked', 'engine-active'); return this.status(); }
      this.updater.setFeedURL({ url: updateFeed });
      if (this.closed) return this.stopStarting();
      this.value = { ...this.value, state: 'downloading', reason: 'downloading' };
      this.acceptingTerminal = true;
      this.updater.checkForUpdates();
    } catch {
      if (this.closed && !this.acceptingTerminal) return this.stopStarting();
      await this.finish('error', 'check-unavailable');
    }
    return this.status();
  }
  async apply(): Promise<UpdateState> {
    if (this.closed || !this.root || !this.downloaded || this.starting || this.value.reason === 'lock-unconfirmed' || this.value.state === 'applying') return this.status();
    this.starting = true;
    try {
      this.releaseLock = await this.lock();
      if (this.closed) return this.stopStarting();
      const idle = await this.idle();
      if (this.closed) return this.stopStarting();
      if (!idle) { await this.finish('blocked', 'engine-active'); return this.status(); }
      this.value = { ...this.value, state: 'applying', reason: 'restarting' };
      this.acceptingTerminal = true;
      this.updater.quitAndInstall();
    } catch {
      if (this.closed && !this.acceptingTerminal) return this.stopStarting();
      await this.finish('error', 'apply-failed');
    }
    return this.status();
  }
  async close(): Promise<void> {
    this.closed = true;
    // 적용 중인 잠금은 다음 앱에서 이전 PID 종료와 설치 프로세스 부재를 확인한 뒤 회수한다.
  }
}
