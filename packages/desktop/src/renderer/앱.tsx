// 프로젝트 등록부터 실행 결과와 증거 조회까지 사람의 확인 흐름을 제공한다.
import { useEffect, useRef, useState } from 'react';
import type { ApiMethod, ApiResponse } from '@checkmate/contracts/api';
import type { RunProgress } from '@checkmate/contracts/runs';
import { VisualEvidence, parseDesignEvidence } from './증거시각화.js';
import type { DesignEvidence, VisualEvidenceProps } from './증거시각화.js';
import { Help } from './도움말.js';
import { TestResources } from './시험자원.js';
import { useLanguage, text } from './언어.js';

type Bridge = {
  request(method: ApiMethod, input: Record<string, unknown>, requestId?: string): Promise<ApiResponse>;
  chooseDirectory(purpose?: 'backup' | 'restore'): Promise<string | null>;
  chooseReport(): Promise<string | null>;
  connectionInfo(): Promise<{ version: string; dataPath: string; mcpCommand: { command: string; args: string[] } }>;
  initializeLocalStore(): Promise<void>;
  exportReport(runId: string): Promise<ApiResponse>;
};
declare global { interface Window { checkmate?: Bridge } }

type PageName = 'projects' | 'checks' | 'history' | 'gaps' | 'settings' | 'help';
type ResultTab = 'summary' | 'cases' | 'requirements' | 'gaps' | 'repair-bundle' | 'imported';
type Page<T> = { items: T[]; nextCursor: string | null; total: number };
type ProjectInfo = { id: string; name: string; repositoryIdentity: string; workspaceId: string;
  realPath: string; activeCatalogHash: string; profiles: { id: string; title: string }[] };
type CheckInfo = { id: string; title: string; requirementId: string; required: boolean; kind: string; expected: string; codePaths: string[] };
type Command = { id: string; title: string; runtime: string; entry: string; args: string[]; timeoutMs: number;
  env: Record<string, string>; writes: string[]; resultFormat: string; resources?: string[] };
type PlanReview = { planId: string; projectId: string; profile: string; fingerprint: string; sourceHash: string;
  checks: { id: string; title: string; required: boolean }[]; commands: Command[]; writes: string[]; resourceEffects: string[]; needsApproval: boolean };
type CatalogChange = { projectId: string; contentHash: string; active: boolean; added: string[]; removed: string[];
  changed: string[]; weakened: string[] };
type CaseInfo = { testId: string; status: string; requirementId: string | null; expected: string | null;
  observed: string | null; evidenceIds: string[]; severity: string; location: { file: string; line: number } | null; truncated?: boolean };
type RequirementInfo = { requirementId: string; title: string; status: string; checks: string[]; selectedChecks: string[];
  outsideChecks: string[]; missingChecks: string[]; evidenceIds: string[]; codePaths: string[]; reasons: string[] };
type Summary = { runId: string; projectId: string; profile: string; origin: 'live' | 'imported'; state: string; verdict: string | null;
  effectiveVerdict: string | null; finalized: boolean; integrity: 'verified' | 'degraded' | 'pending';
  reusablePassed: boolean; planned: number; required: number; counts: Record<string, number>; reasons: string[];
  failures: CaseInfo[]; workerExitCode: number | null; environmentVerified: boolean | null;
  evidenceVerified: boolean | null; cleanupVerified: boolean | null };
type HistoryItem = { runId: string; profile: string; state: string; verdict: string | null; finalized: boolean };
type Gap = { id?: string; testId?: string; requirementId: string | null; kind: string; state?: string; status?: string;
  openedRunId?: string; resolvedRunId?: string | null; detail?: unknown };
type RepairItem = CaseInfo & { instruction: string };
type EvidenceDescriptor = { id: string; runId: string; relativePath: string; sha256: string; byteLength: number;
  mime: string; sensitivity: 'public' | 'restricted'; state: string };
type EvidenceInspection = { evidence: EvidenceDescriptor; integrity: 'verified' | 'degraded'; reason: string | null };
type EvidenceText = { text: string; nextCursor: string | null; integrity: 'verified' };
type ConnectionInfo = Awaited<ReturnType<Bridge['connectionInfo']>>;

const navigation: { id: PageName; korean: string; english: string; mark: string }[] = [
  { id: 'projects', korean: '프로젝트', english: 'Projects', mark: '' },
  { id: 'checks', korean: '검사 항목', english: 'Checks', mark: '' },
  { id: 'history', korean: '진행과 결과', english: 'Progress & results', mark: '' },
  { id: 'gaps', korean: '확인이 필요한 항목', english: 'Needs review', mark: '' },
  { id: 'settings', korean: '설정', english: 'Settings', mark: '⚙' },
  { id: 'help', korean: '도움말', english: 'Help', mark: '?' },
];
type Translations = Record<string, [string, string]>;
const stateLabels: Translations = { queued: ['대기 중', 'Queued'], running: ['실행 중', 'Running'], finished: ['종료', 'Finished'],
  blocked: ['차단됨', 'Blocked'], cancelled: ['취소됨', 'Cancelled'], unverifiable: ['확인 불가', 'Unverifiable'] };
const verdictLabels: Translations = { passed: ['통과', 'Passed'], failed: ['실패', 'Failed'], incomplete: ['미완료', 'Incomplete'],
  unknown: ['미확인', 'Unconfirmed'], 'out-of-scope': ['이번 범위 밖', 'Out of scope'] };
const caseLabels: Translations = { passed: ['통과', 'Passed'], failed: ['실패', 'Failed'], 'not-run': ['미실행', 'Not run'],
  skipped: ['건너뜀', 'Skipped'], 'timed-out': ['시간 초과', 'Timed out'], interrupted: ['중단', 'Interrupted'], unknown: ['미확인', 'Unconfirmed'] };
const reasonLabels: Translations = { 'run-not-finished': ['실행 종료가 확인되지 않았습니다.', 'The run has not been confirmed finished.'],
  'check-failed': ['실패한 검사가 있습니다.', 'One or more checks failed.'], 'worker-failed': ['작업 프로세스가 정상 종료하지 않았습니다.', 'The worker did not exit successfully.'],
  'result-not-finalized': ['결과 저장이 확정되지 않았습니다.', 'The result has not been finalized.'], 'required-checks-empty': ['필수 검사가 없습니다.', 'No required checks were selected.'],
  'required-checks-incomplete': ['필수 검사 일부가 통과하지 못했습니다.', 'Some required checks did not pass.'], 'exit-unconfirmed': ['종료 코드가 확인되지 않았습니다.', 'The exit code is unconfirmed.'],
  'plan-unconfirmed': ['계획 지문이 확인되지 않았습니다.', 'The plan fingerprint is unconfirmed.'], 'source-unconfirmed': ['소스 상태가 확인되지 않았습니다.', 'The source state is unconfirmed.'],
  'source-changed': ['검사 중 소스가 변경되었습니다.', 'The source changed during the run.'], 'environment-unconfirmed': ['실행 환경이 확인되지 않았습니다.', 'The run environment is unconfirmed.'],
  'evidence-unconfirmed': ['필수 증거가 확인되지 않았습니다.', 'Required evidence is unconfirmed.'], 'cleanup-unconfirmed': ['사용 자원 정리가 확인되지 않았습니다.', 'Resource cleanup is unconfirmed.'],
  'imported-evidence': ['가져온 결과의 원본 증거는 확인되지 않았습니다.', 'Original evidence for the imported result is unconfirmed.'] };
const gapLabels: Translations = { 'missing-test': ['필수 검사 기록 없음', 'Required check has no result'], 'missing-evidence': ['필수 증거 부족', 'Required evidence missing'],
  'environment-blocked': ['검사 완료 조건 미충족', 'Run conditions unmet'] };
const evidenceReasonLabels: Translations = { missing: ['파일 없음', 'File missing'], 'hash-mismatch': ['파일 내용 변경', 'File contents changed'],
  'size-mismatch': ['파일 크기 변경', 'File size changed'], 'changed-during-read': ['확인 중 파일 변경', 'File changed while reading'],
  'unsafe-path': ['안전하지 않은 경로', 'Unsafe path'], 'not-file': ['일반 파일 아님', 'Not a regular file'],
  'io-error': ['파일 읽기 실패', 'File read failed'], quarantined: ['격리 상태', 'Quarantined'], staged: ['등록 대기 상태', 'Staged'] };
const errorLabels: Translations = { 'needs-approval': ['실행 전에 계획 범위를 승인해야 합니다.', 'Approve the plan scope before running.'],
  'source-unreadable': ['프로젝트 검사 파일이 없거나 읽을 수 없습니다.', 'Project check files are missing or unreadable.'],
  'plan-stale': ['계획 이후 원본이 바뀌었습니다. 계획을 다시 확인해 주세요.', 'The source changed after planning. Review the plan again.'],
  'catalog-stale': ['프로젝트 원본이 활성 기준과 다릅니다. 변경 내용을 확인해 주세요.', 'The source differs from the active catalog. Review the changes.'],
  'storage-busy': ['저장 작업이 진행 중입니다. 잠시 뒤 다시 시도해 주세요.', 'Storage is busy. Try again shortly.'],
  'evidence-restricted': ['이 증거의 본문은 화면에서 열 수 없습니다.', 'This evidence content cannot be opened here.'],
  'evidence-degraded': ['현재 증거 파일의 무결성을 확인할 수 없습니다.', 'The evidence file integrity cannot be verified.'],
  'evidence-missing': ['증거 파일이 없어 본문을 열 수 없습니다.', 'The evidence file is missing.'] };
const errorActions: Translations = { 'needs-approval': ['계획을 확인하고 승인해 주세요.', 'Review and approve the plan.'],
  'source-unreadable': ['선택한 폴더의 checkmate 폴더에 프로젝트.json, 요구사항.json, 검사항목.json을 준비한 뒤 다시 추가해 주세요.', 'In the selected folder, add checkmate/프로젝트.json, checkmate/요구사항.json, and checkmate/검사항목.json, then add the project again.'],
  'plan-stale': ['계획을 다시 확인해 주세요.', 'Review a new plan.'], 'catalog-stale': ['원본 변경 내용을 확인해 주세요.', 'Review source changes.'],
  'storage-busy': ['잠시 뒤 다시 시도해 주세요.', 'Try again shortly.'], 'evidence-restricted': ['증거의 메타데이터를 확인해 주세요.', 'Review the evidence metadata.'],
  'evidence-degraded': ['증거 파일 상태를 확인해 주세요.', 'Check the evidence file.'], 'evidence-missing': ['증거 파일 경로를 확인해 주세요.', 'Check the evidence file path.'] };
function label(map: Translations, key: string | null | undefined, fallback?: string): string {
  return key && map[key] ? text(...map[key]) : fallback ?? key ?? text('미확인', 'Unconfirmed');
}

class RequestFailure extends Error {
  constructor(readonly code: string, message: string, readonly nextAction: string) { super(message); }
}

async function request<T>(method: ApiMethod, input: Record<string, unknown> = {}, requestId?: string): Promise<T> {
  if (!window.checkmate) throw new RequestFailure('bridge-unavailable', text('데스크톱 연결이 준비되지 않았습니다.', 'Desktop connection is unavailable.'), text('앱에서 다시 열어 주세요.', 'Open the desktop app again.'));
  const response = await window.checkmate.request(method, input, requestId);
  if (!response.ok) throw new RequestFailure(response.error.code,
    label(errorLabels, response.error.code, response.error.message), response.error.nextAction);
  return response.data as T;
}

function errorText(error: unknown): string {
  if (error instanceof RequestFailure) return `${label(errorLabels, error.code, text(error.message, 'The request could not be completed.'))} ${label(errorActions, error.code, text(error.nextAction, 'Review the run state and try again.'))}`.trim();
  return text('연결을 확인할 수 없습니다. 서비스를 확인한 뒤 다시 시도해 주세요.', 'Connection could not be verified. Check the service and try again.');
}

function short(value: string, length = 15): string { return value.length <= length ? value : `${value.slice(0, length)}…`; }
function classFor(value: string | null): string {
  if (value === 'passed' || value === 'verified') return 'good';
  if (value === 'failed' || value === 'degraded') return 'bad';
  if (value === 'unknown' || value === 'incomplete' || value === 'blocked' || value === 'unverifiable') return 'warn';
  return 'neutral';
}
function reasonText(reason: string): string {
  if (reasonLabels[reason]) return label(reasonLabels, reason);
  if (reason.startsWith('run-')) return text(`실행 상태가 ${label(stateLabels, reason.slice(4), '확인 필요')}입니다.`, `Run state: ${label(stateLabels, reason.slice(4), 'Needs review')}.`);
  return text('추가 확인이 필요한 조건이 있습니다.', 'Additional conditions need review.');
}

function Mark() {
  return <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
    <rect x="1" y="1" width="38" height="38" rx="10" fill="#2d74f5" />
    <path d="M11 28h18M14 24h12l-2-7 4-4-5 1-3-5-3 5-5-1 4 4-2 7Z" fill="none" stroke="white" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx="20" cy="18" r="1.4" fill="white" />
  </svg>;
}

function Badge({ value, label }: { value: string | null; label?: string }) {
  return <span className={`badge ${classFor(value)}`}>{label ?? (value === null ? text('판정 전', 'Pending verdict') : labelForStatus(value))}</span>;
}
function labelForStatus(value: string): string { return label(verdictLabels, value, label(stateLabels, value, label(caseLabels, value, value))); }
function repairInstruction(value: string): string {
  return value === '기대값과 실제 관측 및 필요한 증거를 확인하고 테스트를 약화하지 않은 채 수정해 주세요.'
    ? text(value, 'Compare expected and observed results and review the required evidence. Fix the issue without weakening the test.') : value;
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="empty"><div className="empty-symbol" aria-hidden="true">◇</div><strong>{title}</strong><p>{body}</p></div>;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }
  return <span className="copy-value"><code title={value}>{short(value, 30)}</code><button className="text-button" type="button" onClick={() => void copy()} aria-label={text(`${label} 복사`, `Copy ${label}`)}>{copied ? text('복사됨', 'Copied') : text('복사', 'Copy')}</button></span>;
}

function CaseCard({ item, onEvidence, checkName }: { item: CaseInfo; onEvidence: (id: string) => void; checkName?: string | undefined }) {
  return <article className="case-card">
    <div className="case-head"><div><strong>{checkName ?? item.testId}</strong>{checkName && <span className="muted">{text('현재 등록된 검사명', 'Name in current catalog')}</span>}
      <details className="technical-detail"><summary>{text('검사 식별자와 위치', 'Check ID and location')}</summary><code>{item.testId}</code>{item.location && <p className="path-line">{item.location.file}:{item.location.line}</p>}</details>
      <span className="muted">{item.requirementId ?? text('연결된 요구사항 없음', 'No linked requirement')}</span></div><Badge value={item.status} /></div>
    <div className="compare"><div><span className="field-label">{text('기대', 'Expected')}</span><p>{item.expected ?? text('기록 없음', 'No record')}</p></div>
      <div><span className="field-label">{text('관측', 'Observed')}</span><p>{item.observed ?? text('기록 없음', 'No record')}</p></div></div>
    {item.status !== 'passed' && <p className="next-action">{text('다음 행동', 'Next step')} · {item.status === 'failed' ? text('관측 내용과 기대 결과를 비교하고 연결된 증거를 확인하세요.', 'Compare observed and expected results, then review linked evidence.') : text('실행 상태와 연결된 증거를 확인한 뒤 다시 판단하세요.', 'Review the run state and linked evidence before deciding.')}</p>}
    {item.truncated && <p className="muted">{text('긴 관측 내용과 증거 목록의 일부만 표시했습니다. 연결된 원본 증거를 확인해 주세요.', 'Only part of the observation and evidence list is shown. Review the original evidence.')}</p>}
    <div className="evidence-links"><span className="field-label">{text('증거', 'Evidence')}</span>{item.evidenceIds.length === 0 ? <span className="muted">{text('연결된 증거 없음', 'No linked evidence')}</span>
      : item.evidenceIds.map((id) => <button key={id} type="button" className="link-button" onClick={() => onEvidence(id)}>{short(id, 14)}</button>)}</div>
  </article>;
}

function RecordedProfile({ id, project }: { id: string; project: ProjectInfo | null }) {
  const current = project?.profiles.find((profile) => profile.id === id);
  return <span className="recorded-profile"><span>{current?.title ?? id}</span>{current && <small>{text('현재 이름 · 기록 ID', 'Current name · Recorded ID')} <code>{id}</code></small>}</span>;
}

function resourceEffectText(effect: string): string {
  const effects: Translations = {
    '새 일회용 PostgreSQL 컨테이너를 만들고 이 컴퓨터의 동적 포트로 연결합니다.': ['새 일회용 PostgreSQL 컨테이너를 만들고 이 컴퓨터의 동적 포트로 연결합니다.', 'Creates a new disposable PostgreSQL container and connects through a dynamic port on this computer.'],
    '컨테이너 안의 합성 DB 전체에 마이그레이션·쓰기·삭제를 허용하며, 실행 종료 시 컨테이너와 자료를 제거합니다. 기존 DB와 볼륨은 연결하지 않습니다.': ['컨테이너 안의 합성 DB 전체에 마이그레이션·쓰기·삭제를 허용하며, 실행 종료 시 컨테이너와 자료를 제거합니다. 기존 DB와 볼륨은 연결하지 않습니다.', 'Allows migrations, writes, and deletion throughout the synthetic database in the container. Removes the container and its data when the run ends. Existing databases and volumes are not connected.'],
  };
  const translation = effects[effect];
  return translation ? text(...translation) : effect;
}

export function App() {
  const { language, setLanguage } = useLanguage();
  const connected = typeof window.checkmate !== 'undefined';
  const [page, setPage] = useState<PageName>('projects');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [projectTotal, setProjectTotal] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [plan, setPlan] = useState<PlanReview | null>(null);
  const [consent, setConsent] = useState(false);
  const [catalogChange, setCatalogChange] = useState<CatalogChange | null>(null);
  const [activateConsent, setActivateConsent] = useState(false);
  const [checks, setChecks] = useState<CheckInfo[]>([]);
  const [checksCursor, setChecksCursor] = useState<string | null>(null);
  const [checksTotal, setChecksTotal] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [gapsCursor, setGapsCursor] = useState<string | null>(null);
  const [gapsTotal, setGapsTotal] = useState(0);
  const [runId, setRunId] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>('summary');
  const [cases, setCases] = useState<CaseInfo[]>([]);
  const [casesCursor, setCasesCursor] = useState<string | null>(null);
  const [casesTotal, setCasesTotal] = useState(0);
  const [requirements, setRequirements] = useState<RequirementInfo[]>([]);
  const [requirementsCursor, setRequirementsCursor] = useState<string | null>(null);
  const [requirementsTotal, setRequirementsTotal] = useState(0);
  const [runGaps, setRunGaps] = useState<Gap[]>([]);
  const [runGapsCursor, setRunGapsCursor] = useState<string | null>(null);
  const [runGapsTotal, setRunGapsTotal] = useState(0);
  const [repairItems, setRepairItems] = useState<RepairItem[]>([]);
  const [repairCursor, setRepairCursor] = useState<string | null>(null);
  const [repairTotal, setRepairTotal] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceInspection | null>(null);
  const [evidenceText, setEvidenceText] = useState('');
  const [evidenceImage, setEvidenceImage] = useState<VisualEvidenceProps | null>(null);
  const [importedReport, setImportedReport] = useState<Record<string, unknown> | null>(null);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [backupDirectory, setBackupDirectory] = useState('');
  const [backupHash, setBackupHash] = useState('');
  const [restoreTarget, setRestoreTarget] = useState('');
  const [restoreConsent, setRestoreConsent] = useState(false);
  const [cleanupConsent, setCleanupConsent] = useState(false);
  const [cleanupNote, setCleanupNote] = useState('');
  const [cleanupAcknowledged, setCleanupAcknowledged] = useState('');
  useEffect(() => { setCleanupConsent(false); setCleanupNote(''); setCleanupAcknowledged(''); }, [runId]);
  const [needsInitialization, setNeedsInitialization] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNoticeValue] = useState<[string, string] | null>(null);
  const [noticeError, setNoticeError] = useState<unknown>(null);
  const startRequestId = useRef<string | null>(null);
  const selectedProjectRef = useRef('');
  const selectedRunRef = useRef('');
  const busyRef = useRef(false);
  const project = projects.find((item) => item.id === projectId) ?? null;
  function setNotice(korean: string, english = korean) { setNoticeError(null); setNoticeValue(korean ? [korean, english] : null); }
  function showError(error: unknown) { setNoticeValue(null); setNoticeError(error); }
  const phaseLabels: Translations = { queued: ['대기 중', 'Queued'], preparing: ['실행 준비 중', 'Preparing'], running: ['검사 실행 중', 'Running checks'],
    verifying: ['결과 확인 중', 'Verifying results'], cleaning: ['자원 정리 중', 'Cleaning up'], finished: ['실행 종료', 'Finished'], unavailable: ['진행 진단 미확인', 'Progress diagnostics unavailable'] };

  async function loadProjects(cursor?: string) {
    const result = await request<Page<ProjectInfo>>('projects', cursor ? { cursor } : {});
    setProjects((previous) => cursor ? [...previous, ...result.items] : result.items);
    setProjectCursor(result.nextCursor);
    setProjectTotal(result.total);
  }
  async function loadChecks(id: string, cursor?: string) {
    const result = await request<Page<CheckInfo>>('checks', { projectId: id, ...(cursor ? { cursor } : {}) });
    if (selectedProjectRef.current !== id) return;
    setChecks((previous) => cursor ? [...previous, ...result.items] : result.items);
    setChecksCursor(result.nextCursor); setChecksTotal(result.total);
  }
  async function loadHistory(id: string, cursor?: string) {
    if (!cursor) setHistoryLoading(true);
    try {
      const result = await request<{ items: HistoryItem[]; nextCursor: string | null }>('history', { projectId: id, ...(cursor ? { cursor } : {}) });
      if (selectedProjectRef.current !== id) return;
      setHistory((previous) => cursor ? [...previous, ...result.items] : result.items);
      setHistoryCursor(result.nextCursor);
    } finally { if (selectedProjectRef.current === id) setHistoryLoading(false); }
  }
  async function loadProjectGaps(id: string, cursor?: string) {
    const result = await request<Page<Gap>>('gaps', { projectId: id, ...(cursor ? { cursor } : {}) });
    if (selectedProjectRef.current !== id) return;
    setGaps((previous) => cursor ? [...previous, ...result.items] : result.items);
    setGapsCursor(result.nextCursor); setGapsTotal(result.total);
  }
  async function loadSummary(id: string) {
    const result = await request<Summary>('result', { runId: id, section: 'summary' });
    if (selectedRunRef.current === id && selectedProjectRef.current === result.projectId) setSummary(result);
    return result;
  }
  async function action(label: string, work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label); setNotice('');
    try { await work(); } catch (error) { showError(error); }
    finally { busyRef.current = false; setBusy(''); }
  }

  useEffect(() => {
    if (!connected) { setLoading(false); return; }
    let active = true;
    void (async () => {
      try {
        await request('capabilities');
        const info = await window.checkmate!.connectionInfo();
        if (active) setConnection(info);
        const result = await request<Page<ProjectInfo>>('projects');
        if (active) { setProjects(result.items); setProjectCursor(result.nextCursor); setProjectTotal(result.total); }
        if (active) setServiceReady(true);
      } catch (error) {
        if (active) {
          setServiceReady(false);
          if (error instanceof RequestFailure && error.code === 'needs-initialization') setNeedsInitialization(true);
          else showError(error);
        }
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [connected]);

  useEffect(() => {
    if (!connected || page !== 'history' || !runId) return;
    let active = true;
    let timer: number | undefined;
    async function tick() {
      try {
        const result = await request<Summary>('result', { runId, section: 'summary' });
        if (!active || selectedRunRef.current !== runId || selectedProjectRef.current !== result.projectId) return;
        setSummary(result);
        try {
          const current = await request<RunProgress>('progress', { runId });
          if (active && selectedRunRef.current === runId) setProgress(current);
        } catch {
          if (active && selectedRunRef.current === runId) setProgress(null);
        }
        if (result.finalized) {
          if (projectId) void loadHistory(projectId).catch((error: unknown) => { if (active) showError(error); });
        } else timer = window.setTimeout(() => void tick(), 2500);
      } catch (error) {
        if (!active) return;
        showError(error);
        timer = window.setTimeout(() => void tick(), 5000);
      }
    }
    void tick();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [connected, page, runId, projectId]);

  function selectProject(id: string) {
    selectedProjectRef.current = id;
    selectedRunRef.current = '';
    setProjectId(id); setProfileId(''); setPlan(null); setConsent(false); setCatalogChange(null);
    setChecks([]); setHistory([]); setGaps([]); setRunId(''); setSummary(null); setProgress(null);
    setCases([]); setRequirements([]); setRunGaps([]); setRepairItems([]); setImportedReport(null);
    setEvidence(null); setEvidenceText(''); setEvidenceImage(null); setNotice('');
    setChecksCursor(null); setHistoryCursor(null); setGapsCursor(null);
    startRequestId.current = null;
    if (!id) return;
    void loadHistory(id).catch((error: unknown) => { if (selectedProjectRef.current === id) showError(error); });
    void loadChecks(id).catch((error: unknown) => { if (selectedProjectRef.current === id) showError(error); });
  }
  function navigate(next: PageName) {
    setPage(next); setNotice('');
    if (!projectId) return;
    if (next === 'checks') void loadChecks(projectId).catch((error: unknown) => { if (selectedProjectRef.current === projectId) showError(error); });
    if (next === 'history') void loadHistory(projectId).catch((error: unknown) => { if (selectedProjectRef.current === projectId) showError(error); });
    if (next === 'gaps') void loadProjectGaps(projectId).catch((error: unknown) => { if (selectedProjectRef.current === projectId) showError(error); });
  }
  async function addProject() {
    await action('register', async () => {
      const path = await window.checkmate!.chooseDirectory();
      if (!path) return;
      const added = await request<ProjectInfo>('register', { path });
      await loadProjects(); selectProject(added.id);
       setNotice('프로젝트를 등록했습니다. 실행 전 계획과 명령 범위를 확인해 주세요.', 'Project added. Review the plan and command scope before running.');
    });
  }
  async function initialize() {
    await action('initialize', async () => {
      await window.checkmate!.initializeLocalStore();
      await request('capabilities');
      setConnection(await window.checkmate!.connectionInfo());
      await loadProjects();
      setNeedsInitialization(false); setServiceReady(true);
       setNotice('로컬 저장소가 준비되었습니다. 프로젝트를 선택해 등록할 수 있습니다.', 'Local storage is ready. You can now add a project.');
    });
  }
  async function retryConnection() {
    await action('connection-retry', async () => {
      try { await request('capabilities'); }
      catch (error) {
        if (error instanceof RequestFailure && error.code === 'needs-initialization') setNeedsInitialization(true);
        throw error;
      }
      setConnection(await window.checkmate!.connectionInfo());
      await loadProjects(); setServiceReady(true);
       setNotice('로컬 서비스에 연결했습니다.', 'Connected to the local service.');
    });
  }
  async function backup() {
    await action('backup', async () => {
      const result = await request<{ backupDirectory: string; manifestHash: string }>('backup');
      setBackupDirectory(result.backupDirectory); setBackupHash(result.manifestHash); setRestoreConsent(false);
       setNotice('관리 이력과 증거의 백업을 검증했습니다. 연결 비밀은 포함하지 않습니다.', 'History and evidence backup verified. Connection secrets were excluded.');
    });
  }
  async function chooseBackupPath(purpose: 'backup' | 'restore') {
    await action('choose-backup', async () => {
      const path = await window.checkmate!.chooseDirectory(purpose);
      if (!path) return;
      if (purpose === 'backup') { setBackupDirectory(path); setBackupHash(''); } else setRestoreTarget(path);
      setRestoreConsent(false);
    });
  }
  async function restore() {
    if (!restoreConsent || !backupDirectory || !restoreTarget) return;
    await action('restore', async () => {
      const result = await request<{ dataRoot: string; nextAction: string }>('restore', { backupDirectory, targetRoot: restoreTarget, confirm: true });
       setRestoreConsent(false); setNotice(`복구한 자료 위치 ${result.dataRoot}. ${result.nextAction}`, `Restored data location: ${result.dataRoot}. Review the restored folder before using it.`);
    });
  }
  async function inspect() {
    if (!project || !profileId) return;
    const inspectedProjectId = project.id;
    const inspectedProfileId = profileId;
    await action('inspect', async () => {
      const result = await request<PlanReview>('inspect', { projectId: inspectedProjectId, profile: inspectedProfileId });
      if (selectedProjectRef.current !== inspectedProjectId || result.projectId !== inspectedProjectId) return;
      setPlan(result); setConsent(false); startRequestId.current = null;
    });
  }
  async function approve() {
    if (!plan || !consent) return;
    const reviewedPlan = plan;
    await action('approve', async () => {
      await request<{ approvalId: string }>('approve', { planId: reviewedPlan.planId, fingerprint: reviewedPlan.fingerprint });
      if (selectedProjectRef.current !== reviewedPlan.projectId) return;
      setPlan((current) => current?.planId === reviewedPlan.planId ? { ...current, needsApproval: false } : current);
       setNotice('이 계획의 명령과 쓰기 범위를 승인했습니다. 실행은 별도로 시작해야 합니다.', 'Command and write scopes approved. Start the run separately.');
    });
  }
  async function start() {
    if (!project || !plan || plan.needsApproval || !consent) return;
    const startedProjectId = project.id;
    const startedPlanId = plan.planId;
    await action('start', async () => {
      startRequestId.current ??= crypto.randomUUID();
      const accepted = await request<{ runId: string; reused: boolean }>('start',
        { projectId: startedProjectId, planId: startedPlanId }, startRequestId.current);
      startRequestId.current = null;
      if (selectedProjectRef.current !== startedProjectId) return;
      selectedRunRef.current = accepted.runId;
      setRunId(accepted.runId); setSummary(null); setProgress(null); setCancelRequested(false); setResultTab('summary');
      setEvidence(null); setEvidenceText(''); setEvidenceCursor(null); setEvidenceImage(null);
      setCases([]); setRequirements([]); setRunGaps([]); setRepairItems([]); setImportedReport(null);
      setCasesCursor(null); setRequirementsCursor(null); setRunGapsCursor(null); setRepairCursor(null);
      setCleanupNote(''); setCleanupConsent(false);
      setPage('history');
      await loadHistory(startedProjectId);
    });
  }
  async function sync() {
    if (!project) return;
    await action('sync', async () => { const change = await request<CatalogChange>('sync', { projectId: project.id });
      setCatalogChange(change); setActivateConsent(false); });
  }
  async function activate() {
    if (!project || !catalogChange || !activateConsent || catalogChange.active) return;
    await action('activate', async () => {
      await request<CatalogChange>('activate', { projectId: project.id, contentHash: catalogChange.contentHash });
      setCatalogChange(null); setActivateConsent(false); setPlan(null); setConsent(false); startRequestId.current = null;
       await loadProjects(); setNotice('변경된 카탈로그를 활성화했습니다. 새 계획을 확인해 주세요.', 'Changed catalog activated. Review a new plan.');
    });
  }
  async function openRun(id: string) {
    selectedRunRef.current = id;
    setRunId(id); setSummary(null); setProgress(null); setResultTab('summary'); setEvidence(null); setCancelRequested(false);
    setCases([]); setRequirements([]); setRunGaps([]); setRepairItems([]); setImportedReport(null);
    setPage('history');
    // 같은 실행을 다시 열면 effect 의존성이 그대로이므로 요약을 직접 새로 읽는다.
    try { await loadSummary(id); }
    catch (error) { if (selectedRunRef.current === id) showError(error); }
  }
  async function cancel() {
    if (!runId || summary?.finalized) return;
    await action('cancel', async () => { await request<Summary>('cancel', { runId }); setCancelRequested(true);
      await loadSummary(runId); });
  }
  async function selectResultTab(next: ResultTab) {
    setResultTab(next); setEvidence(null);
    if (!runId || next === 'summary') return;
    await action(`result-${next}`, async () => {
      if (next === 'imported') { const result = await request<Record<string, unknown>>('result', { runId, section: next }); if (selectedRunRef.current === runId) setImportedReport(result); }
      if (next === 'cases') { const result = await request<Page<CaseInfo>>('result', { runId, section: next });
        if (selectedRunRef.current === runId) { setCases(result.items); setCasesCursor(result.nextCursor); setCasesTotal(result.total); } }
      if (next === 'requirements') { const result = await request<Page<RequirementInfo>>('result', { runId, section: next });
        if (selectedRunRef.current === runId) { setRequirements(result.items); setRequirementsCursor(result.nextCursor); setRequirementsTotal(result.total); } }
      if (next === 'gaps') { const result = await request<Page<Gap>>('result', { runId, section: next });
        if (selectedRunRef.current === runId) { setRunGaps(result.items); setRunGapsCursor(result.nextCursor); setRunGapsTotal(result.total); } }
      if (next === 'repair-bundle') { const result = await request<Page<RepairItem>>('result', { runId, section: next });
        if (selectedRunRef.current === runId) { setRepairItems(result.items); setRepairCursor(result.nextCursor); setRepairTotal(result.total); } }
    });
  }
  async function moreResults() {
    if (!runId) return;
    await action('more-results', async () => {
      if (resultTab === 'cases' && casesCursor) { const result = await request<Page<CaseInfo>>('result',
        { runId, section: 'cases', cursor: casesCursor }); if (selectedRunRef.current === runId) { setCases([...cases, ...result.items]); setCasesCursor(result.nextCursor); } }
      if (resultTab === 'requirements' && requirementsCursor) { const result = await request<Page<RequirementInfo>>('result',
        { runId, section: 'requirements', cursor: requirementsCursor }); if (selectedRunRef.current === runId) { setRequirements([...requirements, ...result.items]); setRequirementsCursor(result.nextCursor); } }
      if (resultTab === 'gaps' && runGapsCursor) { const result = await request<Page<Gap>>('result',
        { runId, section: 'gaps', cursor: runGapsCursor }); if (selectedRunRef.current === runId) { setRunGaps([...runGaps, ...result.items]); setRunGapsCursor(result.nextCursor); } }
      if (resultTab === 'repair-bundle' && repairCursor) { const result = await request<Page<RepairItem>>('result',
        { runId, section: 'repair-bundle', cursor: repairCursor, limit: 5 }); if (selectedRunRef.current === runId) { setRepairItems([...repairItems, ...result.items]); setRepairCursor(result.nextCursor); } }
    });
  }
  async function showEvidence(id: string) {
    if (!runId) return;
    await action('evidence', async () => {
      const inspected = await request<EvidenceInspection>('evidence', { runId, evidenceId: id });
      if (selectedRunRef.current !== runId) return;
      setEvidence(inspected); setEvidenceText(''); setEvidenceCursor(null); setEvidenceImage(null);
    });
  }
  async function readEvidence(cursor?: string) {
    if (!runId || !evidence) return;
    await action('evidence-text', async () => {
      const result = await request<EvidenceText>('evidence', { runId, evidenceId: evidence.evidence.id,
        content: true, limit: 8192, ...(cursor ? { cursor } : {}) });
      if (selectedRunRef.current !== runId) return;
      setEvidenceText((old) => cursor ? old + result.text : result.text); setEvidenceCursor(result.nextCursor);
    });
  }
  async function readImage(evidenceId: string, design?: DesignEvidence) {
    if (!runId) return;
    await action('image', async () => {
      const inspected = await request<EvidenceInspection>('evidence', { runId, evidenceId });
       if (inspected.integrity !== 'verified' || inspected.evidence.sensitivity !== 'public' || inspected.evidence.mime !== 'image/png'
         || inspected.evidence.byteLength > 8 * 1024 * 1024) throw new Error(text('공개 PNG 증거의 무결성을 확인할 수 없습니다.', 'Public PNG evidence could not be verified.'));
      const chunks: string[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let width = 0; let height = 0; let byteLength = 0;
      do {
        const part = await request<{ base64: string; nextCursor: string | null; width: number; height: number; sha256: string }>('evidence-image', { runId, evidenceId, ...(cursor ? { cursor } : {}) });
         if (part.sha256 !== inspected.evidence.sha256 || (width && (width !== part.width || height !== part.height))) throw new Error(text('읽는 동안 이미지가 바뀌었습니다.', 'The image changed while reading.'));
        width = part.width; height = part.height;
        const decoded = atob(part.base64); byteLength += decoded.length;
         if (byteLength > inspected.evidence.byteLength || (part.nextCursor && seen.has(part.nextCursor))) throw new Error(text('이미지 구간을 확인할 수 없습니다.', 'An image segment could not be verified.'));
        chunks.push(decoded);
        if (part.nextCursor) seen.add(part.nextCursor);
        cursor = part.nextCursor ?? undefined;
      } while (cursor);
       if (byteLength !== inspected.evidence.byteLength) throw new Error(text('이미지 크기가 일치하지 않습니다.', 'Image size does not match.'));
      const binary = chunks.join('');
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
       if (sha256 !== inspected.evidence.sha256) throw new Error(text('이미지 해시가 일치하지 않습니다.', 'Image hash does not match.'));
      if (selectedRunRef.current !== runId) return;
      setEvidenceImage({ imageDataUrl: `data:image/png;base64,${btoa(binary)}`, imageWidth: width, imageHeight: height,
        screenshotEvidenceId: evidenceId, ...(design ? { designEvidence: design } : {}) });
    });
  }
  async function copyText(value: string) {
     try { await navigator.clipboard.writeText(value); setNotice('클립보드에 복사했습니다.', 'Copied to clipboard.'); }
     catch { setNotice('복사할 수 없습니다. 내용을 선택해 직접 복사해 주세요.', 'Copy failed. Select the content and copy it manually.'); }
  }

  const selectedNavigation = navigation.find((item) => item.id === page);
  const title = selectedNavigation ? text(selectedNavigation.korean, selectedNavigation.english) : text('프로젝트', 'Projects');
  const resultNext = resultTab === 'cases' ? casesCursor : resultTab === 'requirements' ? requirementsCursor : resultTab === 'gaps' ? runGapsCursor : repairCursor;
  const recentActive = history.find((item) => !item.finalized && ['queued', 'running'].includes(item.state));
  const recentFinal = history.find((item) => item.finalized);
  const activeStep = runId ? 4 : plan ? 3 : project ? 2 : 1;
  const resultPassed = !!summary?.finalized && summary.effectiveVerdict === 'passed' && summary.integrity === 'verified';
  const resultFailed = !!summary?.finalized && summary.effectiveVerdict === 'failed';
  return <div className="app-shell">
    <a className="skip-link" href="#main">{text('본문으로 건너뛰기', 'Skip to content')}</a>
    <aside className="sidebar" aria-label={text('주 메뉴', 'Main menu')}>
      <div className="brand"><Mark /><span><strong>CheckMate</strong><small>{text('검사 결과와 근거', 'Checks and evidence')}</small></span></div>
      <nav className="side-nav" aria-label={text('화면 이동', 'Navigation')}>{navigation.map((item) =>
        <button key={item.id} type="button" data-testid={['projects', 'history', 'settings', 'help'].includes(item.id) ? `nav-${item.id}` : undefined} className={page === item.id ? 'nav-item current' : 'nav-item'}
          onClick={() => navigate(item.id)} disabled={!serviceReady && item.id !== 'help'} aria-current={page === item.id ? 'page' : undefined} title={text(item.korean, item.english)}>
          <span className="nav-mark" aria-hidden="true">{item.mark}</span>{text(item.korean, item.english)}</button>)}</nav>
      <div className="sidebar-foot"><span className={serviceReady ? 'connection-dot online' : 'connection-dot'} />
        {serviceReady ? text('로컬 서비스 연결', 'Local service connected') : connected ? text('서비스 확인 필요', 'Check service') : text('개발 미리보기', 'Development preview')}<small>{connection?.version ?? text('서비스 확인 전', 'Service unchecked')}</small></div>
    </aside>
    <main id="main" className="main-content" tabIndex={-1}>
      <header className="topbar"><div><p className="eyebrow">CHECKMATE</p><h1>{title}</h1></div>
        <div className="top-actions"><label className="top-control">{text('언어', 'Language')}<select data-testid="language-select" aria-label={text('화면 언어', 'Display language')} value={language} onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'ko')}><option value="ko">한국어</option><option value="en">English</option></select></label>
          {serviceReady && <label className="top-control project-switch">{text('선택 프로젝트', 'Selected project')}<select data-testid="project-select" aria-label={text('프로젝트 선택', 'Choose project')} value={projectId} onChange={(event) => selectProject(event.target.value)} disabled={!!busy}><option value="">{text('프로젝트 선택', 'Choose a project')}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          {page === 'projects' && serviceReady && <button data-testid="add-project" className="primary" type="button" onClick={() => void addProject()} disabled={!!busy}>{text('+ 프로젝트 추가', '+ Add project')}</button>}</div></header>
      <div className="content-wrap">
        {serviceReady && <ol className="workflow" aria-label={text('검사 진행 단계', 'Check workflow')}>
          <li className={activeStep === 1 ? 'active' : 'done'}><span>1</span>{text('프로젝트 선택', 'Choose project')}</li>
          <li className={activeStep === 2 ? 'active' : plan ? 'done' : ''}><span>2</span>{text('검사 묶음과 계획', 'Check set and plan')}</li>
          <li className={activeStep === 3 ? 'active' : runId && plan ? 'done' : ''}><span>3</span>{text('계획 승인 후 실행', 'Approve, then run')}</li>
          <li className={activeStep === 4 ? 'active' : ''}><span>4</span>{text('진행과 결과', 'Progress and results')}</li>
        </ol>}
        {page === 'help' && <Help />}
        {!connected && page !== 'help' && <section className="panel preview" aria-live="polite"><div className="preview-icon"><Mark /></div>
          <h2>{text('데스크톱 연결이 필요합니다', 'Desktop connection required')}</h2><p>{text('이 화면은 개발 미리보기입니다. 프로젝트 등록과 검사 실행은 CheckMate 앱에서 연결된 뒤 사용할 수 있습니다.', 'This is a development preview. Add projects and run checks in the connected CheckMate desktop app.')}</p>
          <p className="muted">{text('실행 결과나 예시 데이터는 표시하지 않습니다.', 'No run results or sample data are shown.')}</p></section>}
        {connected && page !== 'help' && <>
          {loading && <p className="loading" role="status">{text('로컬 서비스와 프로젝트를 확인하는 중입니다…', 'Checking the local service and projects…')}</p>}
          {(notice || noticeError) && <div className="notice" role="status" aria-live="polite">{noticeError ? errorText(noticeError) : notice ? text(...notice) : null}</div>}
          {!loading && needsInitialization && <section className="panel setup-panel" aria-live="polite"><p className="eyebrow">LOCAL SETUP</p>
            <h2>{text('로컬 저장소 준비가 필요합니다', 'Local storage setup required')}</h2><p>{text('CheckMate가 이 컴퓨터에 전용 저장소를 만들고 프로젝트 및 검사 이력을 기록합니다. 준비 후 프로젝트 등록과 실행 계획 확인을 시작할 수 있습니다.', 'CheckMate creates dedicated local storage for projects and check history. After setup, you can add a project and review a run plan.')}</p>
            <button type="button" className="primary" onClick={() => void initialize()} disabled={!!busy}>{busy === 'initialize' ? text('준비 중…', 'Setting up…') : text('로컬 저장소 준비', 'Set up local storage')}</button></section>}
          {!loading && !needsInitialization && !serviceReady && <section className="panel setup-panel" aria-live="polite"><p className="eyebrow">CONNECTION</p>
            <h2>{text('로컬 서비스에 연결할 수 없습니다', 'Cannot connect to the local service')}</h2><p>{text('검사 결과와 프로젝트 목록을 읽지 못했습니다. 서비스를 확인한 뒤 다시 연결해 주세요.', 'Projects and check results could not be loaded. Check the service and reconnect.')}</p>
            <button type="button" className="secondary" onClick={() => void retryConnection()} disabled={!!busy}>{text('다시 연결', 'Reconnect')}</button></section>}
          {!loading && serviceReady && page === 'projects' && <>
            {!project && <>
             <section className="section-head"><div><p className="eyebrow">STEP 1</p><h2>{text('검사할 프로젝트를 선택하세요', 'Choose a project to check')}</h2><p>{text('목록에서 프로젝트를 고르거나 새 프로젝트 폴더를 추가하세요.', 'Select a project below or add a new project folder.')}</p></div>
               <button type="button" className="secondary" onClick={() => void action('refresh', () => loadProjects())} disabled={!!busy}>{text('새로 고침', 'Refresh')}</button></section>
             {projects.length === 0 ? <Empty title={text('등록된 프로젝트가 없습니다', 'No projects yet')} body={text('프로젝트 폴더를 선택해 검사 원본을 등록하세요. 등록만으로 명령이 실행되지는 않습니다.', 'Add a project folder to load its checks. Adding it does not run commands.')} />
               : <><div className="project-grid">{projects.map((item) => <button className={item.id === projectId ? 'project-tile selected' : 'project-tile'}
                 type="button" key={item.id} onClick={() => selectProject(item.id)} aria-pressed={item.id === projectId} disabled={!!busy}>
                 <span className="tile-kicker">{text('프로젝트', 'PROJECT')}</span><strong>{item.name}</strong><span className="tile-path">{item.realPath}</span>
                 <span className="tile-bottom">{text(`검사 묶음 ${item.profiles.length}개`, `${item.profiles.length} check sets`)} <span aria-hidden="true">↗</span></span></button>)}</div>
                 <p className="page-count">{projects.length} / {projectTotal}</p>{projectCursor && <button type="button" className="secondary" onClick={() => void action('more-projects', () => loadProjects(projectCursor))} disabled={!!busy}>{text('프로젝트 더 보기', 'Show more projects')}</button>}</>}
            </>}
            {project && <section className="section-head"><div><p className="eyebrow">{text('선택한 프로젝트', 'SELECTED PROJECT')}</p><h2>{project.name}</h2><p>{text('아래에서 실행할 검사를 선택하세요.', 'Choose which checks to run below.')}</p></div>
              <button type="button" className="secondary" onClick={() => selectProject('')} disabled={!!busy}>{text('다른 프로젝트 선택', 'Choose another project')}</button></section>}
             {project && <section className="panel plan-panel"><div className="panel-heading"><div><p className="eyebrow">STEP 2 → 3</p><h2>{text('검사 묶음과 실행 계획', 'Check set and run plan')}</h2><p>{text('검사 묶음은 함께 실행할 검사 목록입니다. 계획을 먼저 확인해야 승인할 수 있습니다.', 'A check set is a group of checks. Review the plan before approval.')}</p></div></div>
               <div className="form-row"><label htmlFor="profile">{text('어떤 검사를 할까요?', 'Which checks should run?')}</label><select id="profile" data-testid="profile-select" value={profileId} disabled={!!busy} onChange={(event) => { setProfileId(event.target.value); setPlan(null); setConsent(false); startRequestId.current = null; }}>
                 <option value="">{text('검사 묶음 선택', 'Choose a check set')}</option>{project.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.title}</option>)}</select>
                 <button data-testid="inspect-plan" className="primary" type="button" onClick={() => void inspect()} disabled={!profileId || !!busy}>{text('계획 미리보기', 'Preview plan')}</button></div>
               {!plan && <p className="next-action">{text('다음 행동 · 검사 묶음을 선택하고 계획 미리보기를 여세요.', 'Next step · Choose a check set and preview its plan.')}</p>}
               {plan && <div className="plan-review"><div className="review-top"><div><h3>{text('이번에 확인할 내용', 'What this run will check')}</h3><p>{text('검사 이름과 실행 범위를 살펴보고 승인해 주세요.', 'Review the checks and execution scope before approving.')}</p></div><Badge value={plan.needsApproval ? 'unknown' : 'verified'} label={plan.needsApproval ? text('승인 필요', 'Approval needed') : text('승인됨', 'Approved')} /></div>
                 <div className="metrics"><div><strong>{plan.checks.length}</strong><span>{text('선택 검사', 'Selected checks')}</span></div><div><strong>{plan.checks.filter((item) => item.required).length}</strong><span>{text('필수 검사', 'Required checks')}</span></div><div><strong>{plan.commands.length}</strong><span>{text('실행 명령', 'Commands')}</span></div></div>
                 <div className="subsection"><h4>{text('선택한 검사', 'Selected checks')}</h4><ul className="compact-list">{plan.checks.map((item) => <li key={item.id}><span><strong>{item.title}</strong>{checks.find((check) => check.id === item.id)?.expected && <small className="check-purpose">{text('확인 기준', 'Expected result')} · {checks.find((check) => check.id === item.id)?.expected}</small>}<details className="technical-detail"><summary>{text('검사 ID', 'Check ID')}</summary><code>{item.id}</code></details></span>{item.required && <span className="small-tag">{text('필수', 'Required')}</span>}</li>)}</ul></div>
                 <div className="approval-scope"><h4>{text('승인할 실행 범위', 'Execution scope to approve')}</h4><p>{text('명령, 환경 값, 파일 쓰기, 시험 자원을 확인한 뒤 체크하세요.', 'Review commands, environment values, file writes, and test resources before checking the box.')}</p>
                   <div className="subsection"><h4>{text('실행 명령과 환경', 'Commands and environment')}</h4>{plan.commands.map((command) => <div className="command-card" key={command.id}><strong>{command.title}</strong>
                   <details className="technical-detail" open={plan.needsApproval}><summary>{text('정확한 명령과 환경 값 보기', 'Show exact command and environment')}</summary><p><code>{command.runtime} {command.entry} {command.args.join(' ')}</code></p><p className="muted">{text('시간 제한', 'Timeout')} {Math.round(command.timeoutMs / 1000)}{text('초', 's')} · {text('결과 형식', 'Result format')} {command.resultFormat}</p>
                   <div className="env-list">{Object.entries(command.env).length === 0 ? text('추가 환경 값 없음', 'No extra environment values') : Object.entries(command.env).map(([key, value]) => <code key={key}>{key}={value}</code>)}</div></details></div>)}</div>
                   <div className="subsection"><h4>{text('허용된 쓰기 경로', 'Allowed write paths')}</h4>{plan.writes.length === 0 ? <p className="muted">{text('선언된 쓰기 경로가 없습니다.', 'No write paths declared.')}</p> : <ul className="compact-list">{plan.writes.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}</div>
                   {plan.resourceEffects?.length > 0 && <div className="subsection"><h4>{text('시험 자원 생성과 제거', 'Test resource creation and removal')}</h4>{plan.resourceEffects.map(effect => <p key={effect}>{resourceEffectText(effect)}</p>)}</div>}
                   <details className="technical-detail"><summary>{text('계획 지문 보기', 'Show plan fingerprint')}</summary><CopyValue value={plan.fingerprint} label={text('계획 지문', 'Plan fingerprint')} /></details></div>
                 <label className="checkline"><input data-testid="plan-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{text('위 명령, 환경 값, 쓰기 범위와 시험 자원을 확인했습니다.', 'I reviewed the commands, environment values, write paths, and test resources above.')}</label>
                 <div className="plan-actions">{plan.needsApproval && <button data-testid="approve-plan" type="button" className="secondary" onClick={() => void approve()} disabled={!consent || !!busy}>{text('이 계획 승인', 'Approve this plan')}</button>}
                   <button data-testid="start-run" type="button" className="primary" onClick={() => void start()} disabled={!consent || plan.needsApproval || !!busy}>{text('검사 실행', 'Start checks')}</button></div>
                 <p className="muted">{plan.needsApproval ? text('승인 후에도 실행 버튼을 따로 눌러야 검사가 시작됩니다.', 'After approval, press Start checks to begin.') : text('계획이 승인됐습니다. 실행 버튼을 누르면 검사가 시작됩니다.', 'Plan approved. Press Start checks to begin.')}</p>
               </div>}</section>}
            {project && (historyLoading || recentActive || recentFinal) && <section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">{text('이 프로젝트', 'THIS PROJECT')}</p><h2>{text('최근 실행', 'Recent runs')}</h2></div></div>
              {historyLoading ? <p className="loading" role="status">{text('최근 실행을 읽는 중입니다…', 'Loading recent runs…')}</p> : !recentActive && !recentFinal
                ? <Empty title={text('최근 실행이 없습니다', 'No recent runs')} body={text('계획을 확인하고 실행하면 이 프로젝트의 최신 상태가 표시됩니다.', 'Review a plan and start checks to see this project’s latest state.')} />
                : <div className="recent-list">{recentActive && <button type="button" className="recent-item" onClick={() => void openRun(recentActive.runId)}>
                  <span><small>{text('계속 진행 중', 'In progress')}</small><strong>{<RecordedProfile id={recentActive.profile} project={project} />}</strong></span>
                  <Badge value={recentActive.state} label={label(stateLabels, recentActive.state, text('진행 중', 'In progress'))} /></button>}
                  {recentFinal && <button type="button" className="recent-item" onClick={() => void openRun(recentFinal.runId)}>
                    <span><small>{text('마지막 확정 결과', 'Last finalized result')}</small><strong>{<RecordedProfile id={recentFinal.profile} project={project} />}</strong></span>
                    <Badge value={recentFinal.verdict} /></button>}</div>}</section>}
             {project && <details className="panel project-detail"><summary>{text('프로젝트 정보와 검사 원본 관리', 'Project details and check catalog')}</summary><div className="panel-heading"><div><p className="eyebrow">{text('선택한 프로젝트', 'SELECTED PROJECT')}</p><h2>{project.name}</h2></div><Badge value="verified" label={text('등록됨', 'Registered')} /></div>
               <p className="muted">{text('프로젝트 경로를 확인하고 검사 원본의 변경을 관리합니다.', 'Review project paths and manage changes to the check catalog.')}</p>
               <details className="technical-detail"><summary>{text('프로젝트 경로와 식별 정보', 'Project path and identifiers')}</summary><dl className="detail-grid"><div><dt>{text('작업 폴더', 'Working folder')}</dt><dd className="path-line">{project.realPath}</dd></div>
                 <div><dt>{text('프로젝트 ID', 'Project ID')}</dt><dd><CopyValue value={project.id} label={text('프로젝트 ID', 'Project ID')} /></dd></div>
                 <div><dt>{text('활성 검사 원본', 'Active check catalog')}</dt><dd><CopyValue value={project.activeCatalogHash} label={text('원본 지문', 'Catalog hash')} /></dd></div>
                 <div><dt>{text('저장소 식별자', 'Repository identity')}</dt><dd className="path-line">{project.repositoryIdentity}</dd></div></dl></details>
               <div className="detail-actions"><button type="button" className="secondary" onClick={() => void sync()} disabled={!!busy}>{text('원본 변경 확인', 'Check source changes')}</button></div>
              {catalogChange && <div className="change-review"><div className="panel-heading"><h3>{text('원본 변경 비교', 'Compare source changes')}</h3><Badge value={catalogChange.active ? 'verified' : 'unknown'} label={catalogChange.active ? text('현재 활성', 'Active now') : text('활성 전 후보', 'Pending activation')} /></div>
                <details className="technical-detail"><summary>{text('새 원본 지문', 'New catalog hash')}</summary><CopyValue value={catalogChange.contentHash} label={text('새 원본 지문', 'New catalog hash')} /></details>
                <div className="change-list"><span>{text(`추가 ${catalogChange.added.length}개`, `${catalogChange.added.length} added`)}</span><span>{text(`제거 ${catalogChange.removed.length}개`, `${catalogChange.removed.length} removed`)}</span><span>{text(`변경 ${catalogChange.changed.length}개`, `${catalogChange.changed.length} changed`)}</span><span className="warn-text">{text(`약화 가능 ${catalogChange.weakened.length}개`, `${catalogChange.weakened.length} may be weakened`)}</span></div>
                {catalogChange.added.length > 0 && <p className="path-line">{text('추가된 검사', 'Added checks')} {catalogChange.added.join(', ')}</p>}
                {catalogChange.removed.length > 0 && <p className="path-line">{text('제거된 검사', 'Removed checks')} {catalogChange.removed.join(', ')}</p>}
                {catalogChange.changed.length > 0 && <p className="path-line">{text('변경된 검사', 'Changed checks')} {catalogChange.changed.join(', ')}</p>}
                {catalogChange.weakened.length > 0 && <p className="path-line">{text('확인 필요', 'Needs review')} {catalogChange.weakened.join(', ')}</p>}
                <p className="muted change-limit">{text('검사 ID 비교에 표시되지 않는 명령과 요구사항 변경도 원본 지문에 포함됩니다. 활성화 후 새 계획에서 실행 명령을 다시 확인해야 합니다.', 'The catalog hash also covers commands and requirement changes not shown by check ID comparison. Review commands in a new plan after activation.')}</p>
                {!catalogChange.active && <><label className="checkline"><input type="checkbox" checked={activateConsent} onChange={(event) => setActivateConsent(event.target.checked)} />{text('변경 목록을 확인했고 활성 기준을 바꾸겠습니다.', 'I reviewed the changes and will activate the new catalog.')}</label>
                  <button type="button" className="secondary" onClick={() => void activate()} disabled={!activateConsent || !!busy}>{text('새 기준 활성화', 'Activate new catalog')}</button></>}</div>}
            </details>}
          </>}
          {!loading && serviceReady && page === 'checks' && <section className="panel"><div className="panel-heading"><div><h2>{text('검사 항목', 'Checks')}</h2><p>{text('선택한 프로젝트의 현재 검사 원본에 등록된 항목입니다.', 'Checks in the selected project’s current catalog.')}</p></div><span className="count-label">{text(`전체 ${checksTotal}개`, `${checksTotal} total`)}</span></div>
            {!project ? <Empty title={text('프로젝트를 선택하세요', 'Choose a project')} body={text('위쪽 선택기에서 검사할 프로젝트를 고르세요.', 'Choose a project from the selector above.')} /> : checks.length === 0 ? <Empty title={text('검사 항목이 없습니다', 'No checks')} body={text('활성 원본과 연결 상태를 확인하세요.', 'Check the active catalog and connection.')} />
              : <><div className="table-scroll"><table><thead><tr><th scope="col">{text('검사', 'Check')}</th><th scope="col">{text('요구사항', 'Requirement')}</th><th scope="col">{text('분류', 'Type')}</th><th scope="col">{text('필수', 'Required')}</th><th scope="col">{text('코드 위치', 'Code location')}</th></tr></thead>
                <tbody>{checks.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><details className="technical-detail"><summary>{text('검사 ID', 'Check ID')}</summary><code>{item.id}</code></details></td><td>{item.requirementId}</td><td>{item.kind}</td><td>{item.required ? text('필수', 'Required') : text('선택', 'Optional')}</td><td className="path-line">{item.codePaths.join(', ') || text('기록 없음', 'No record')}</td></tr>)}</tbody></table></div>
                <p className="page-count">{checks.length} / {checksTotal}</p>{checksCursor && <button type="button" className="secondary" onClick={() => void action('more-checks', () => loadChecks(project.id, checksCursor))} disabled={!!busy}>{text('검사 항목 더 보기', 'Show more checks')}</button>}</>}
          </section>}
          {!loading && serviceReady && page === 'history' && <>
          {runId && <section className="panel run-panel"><div className="panel-heading"><div><p className="eyebrow">STEP 4</p><h2>{text('현재 진행과 결과', 'Current progress and result')}</h2><p>{text('선택 프로젝트', 'Selected project')} · {project?.name} · {text('검사 묶음', 'Check set')} · {summary ? <RecordedProfile id={summary.profile} project={project} /> : text('읽는 중', 'Loading')}</p><details className="technical-detail"><summary>{text('실행 ID', 'Run ID')}</summary><CopyValue value={runId} label={text('실행 ID', 'Run ID')} /></details></div>
            {summary && <Badge value={summary.effectiveVerdict} label={summary.finalized ? label(verdictLabels, summary.effectiveVerdict, text('확인 불가', 'Unverifiable')) : label(stateLabels, summary.state)} />}</div>
            {!summary ? <p className="loading" role="status">{text('실행 상태를 읽는 중입니다…', 'Loading run state…')}</p> : <><div className="run-state" aria-live="polite"><div><strong>{label(stateLabels, summary.state)}</strong><span>{summary.finalized ? text('최종 결과가 저장되었습니다.', 'Final result saved.') : text('실행 중입니다. 종료 확인 후 판정이 확정됩니다.', 'The run is in progress. The verdict is confirmed after it ends.')}</span></div>
              {summary.finalized ? <button type="button" className="secondary" disabled={!!busy} onClick={() => void action('export', async () => {
                const response = await window.checkmate!.exportReport(runId);
                if (!response.ok) throw new Error(response.error.message);
                const saved = response.data as { path?: string };
                if (saved.path) setNotice(`보고서를 저장했습니다. ${saved.path}`, `Report saved to ${saved.path}`);
              })}>{text('HTML 보고서 저장', 'Save HTML report')}</button> : <button type="button" className="danger-button" onClick={() => void cancel()} disabled={!!busy || cancelRequested}>{cancelRequested ? text('취소 요청됨 · 종료 확인 중', 'Cancellation requested · Waiting for exit') : text('실행 취소 요청', 'Request cancellation')}</button>}</div>
              {!summary.finalized && <div className="progress-summary" data-testid="run-progress" role="status"><strong>{progress ? label(phaseLabels, progress.phase) : text('진행 상태 확인 중', 'Checking progress')}</strong>
                <p>{text('검사 묶음', 'Check set')} · {<RecordedProfile id={summary.profile} project={project} />}</p>
                {progress?.available && progress.totalCommands > 0 && <p>{text(`명령 작업 ${progress.completedCommands} / ${progress.totalCommands}개 완료`, `${progress.completedCommands} of ${progress.totalCommands} command tasks complete`)}</p>}
                <p data-testid="active-command">{progress?.available && progress.currentCommand ? text('현재 명령', 'Current command') + ' · ' + progress.currentCommand.title : progress?.available ? text('현재 명령이 확인되지 않았습니다.', 'No current command is confirmed.') : text('현재 명령 진단이 확인되지 않았습니다.', 'Current command diagnostics are unavailable.')}</p>
                <p className="muted">{text(`저장된 검사 결과 ${Object.values(summary.counts).reduce((sum, count) => sum + count, 0)}건 / 계획 검사 ${summary.planned}건`, `${Object.values(summary.counts).reduce((sum, count) => sum + count, 0)} saved check results / ${summary.planned} planned checks`)}</p></div>}
              {summary.origin === 'imported' && <p className="instruction">{text('가져온 과거 이력입니다. 현재 실행과 요구사항의 통과 근거로 사용하지 않습니다.', 'This is imported history. It does not prove current checks or requirements passed.')}</p>}
              {summary.origin === 'live' && summary.finalized && <TestResources key={runId} runId={runId} request={request} disabled={!!busy}
                canCleanup={['blocked', 'unverifiable', 'cancelled'].includes(summary.state) && summary.cleanupVerified !== true} />}
              {summary.origin === 'live' && summary.finalized && ['blocked', 'unverifiable', 'cancelled'].includes(summary.state) && summary.cleanupVerified !== true && <div className="plan-review">
                <h3>{text('실행 자원 정리 확인', 'Confirm run resource cleanup')}</h3><p>{text('이 실행의 종료와 정리를 자동 확인하지 못해 같은 프로젝트의 새 검사를 보류합니다. 해당 실행이 만든 프로세스와 임시 자료를 직접 확인한 뒤 기록해 주세요. 과거 실행의 미확인 판정은 유지됩니다.', 'The app could not verify that this run exited and cleaned up its resources, so new checks for this project are paused. Inspect its processes and temporary files, then record your review. The earlier unconfirmed verdict remains unchanged.')}</p>
                {cleanupAcknowledged === runId ? <p role="status">{text('사람의 정리 확인을 기록했습니다. 새 계획으로 검사할 수 있습니다.', 'Manual cleanup confirmation recorded. You can review a new plan.')}</p> : <>
                  <label className="field">{text('확인한 정리 내용', 'Cleanup details reviewed')}<textarea value={cleanupNote} minLength={8} maxLength={500} onChange={event => setCleanupNote(event.target.value)} disabled={!!busy} /></label>
                  <label className="checkline"><input type="checkbox" checked={cleanupConsent} onChange={event => setCleanupConsent(event.target.checked)} disabled={!!busy} />{text('이 실행의 프로세스와 임시 자료 정리를 직접 확인했습니다.', 'I personally verified the run processes and temporary files were cleaned up.')}</label>
                  <button type="button" className="secondary" disabled={!!busy || !cleanupConsent || cleanupNote.trim().length < 8} onClick={() => void action('acknowledge-cleanup', async () => {
                    await request('acknowledge-cleanup', { runId, confirm: true, note: cleanupNote }); setCleanupAcknowledged(runId);
                  })}>{text('정리 확인 기록', 'Record cleanup confirmation')}</button></>}
              </div>}
              <div className="result-tabs" role="tablist" aria-label={text('결과 보기', 'Result views')}>{([{ id: 'summary', label: text('요약', 'Summary') }, { id: 'cases', label: text('검사 결과', 'Check results') }, { id: 'requirements', label: text('요구사항 근거', 'Requirement evidence') },
                { id: 'gaps', label: text('확인 필요', 'Needs review') }, { id: 'repair-bundle', label: text('AI 수정 자료', 'AI repair data') }] as { id: ResultTab; label: string }[]).map((tab) =>
                <button type="button" role="tab" aria-selected={resultTab === tab.id} className={resultTab === tab.id ? 'result-tab active' : 'result-tab'} key={tab.id}
                  onClick={() => void selectResultTab(tab.id)}>{tab.label}</button>)}
                {summary.origin === 'imported' && <button type="button" role="tab" aria-selected={resultTab === 'imported'} className={resultTab === 'imported' ? 'result-tab active' : 'result-tab'} onClick={() => void selectResultTab('imported')}>{text('가져온 원래 기록', 'Imported original')}</button>}</div>
              {resultTab === 'imported' && importedReport && <div className="result-body"><p>{text('원래 보고 상태', 'Original reported state')} · {String(importedReport.reportedStatus)} · {text('현재 판정은 미확인입니다.', 'Current verdict is unconfirmed.')}</p><pre className="evidence-text">{JSON.stringify(importedReport, null, 2)}</pre>
                {typeof importedReport.nextCursor === 'string' && <button type="button" className="secondary" disabled={!!busy} onClick={() => void action('imported-next', async () => { const result = await request<Record<string, unknown>>('result', { runId, section: 'imported', cursor: importedReport.nextCursor }); if (selectedRunRef.current === runId) setImportedReport(result); })}>{text('원래 단계 다음 구간', 'Next imported segment')}</button>}</div>}
              {resultTab === 'summary' && <div className="result-body">
                <section className={`result-decision ${resultPassed ? 'good' : resultFailed ? 'bad' : 'warn'}`} aria-live="polite">
                  <p className="eyebrow">{text('지금 알아야 할 결과', 'RESULT AT A GLANCE')}</p>
                  <h3>{!summary.finalized ? text('검사 진행 중', 'Checks in progress') : resultPassed ? text('통과', 'Passed') : resultFailed ? text('실패', 'Failed') : summary.effectiveVerdict === 'incomplete' ? text('미완료', 'Incomplete') : text('미확인', 'Unconfirmed')}</h3>
                  <p>{!summary.finalized ? text('실행이 끝나고 근거가 확인되어야 최종 판정이 나옵니다.', 'A final verdict requires the run to finish and its evidence to be checked.') : resultPassed ? text('선택한 검사와 필요한 근거가 확인되었습니다.', 'The selected checks and required evidence were verified.') : resultFailed ? text('실패한 검사 또는 실행 오류가 기록되었습니다.', 'A failed check or run error was recorded.') : text('완료 또는 통과를 확인할 조건이 남아 있습니다.', 'Some conditions for a complete or passing result remain unconfirmed.')}</p>
                  <p className="decision-next"><strong>{text('다음 행동', 'Next step')}</strong> · {!summary.finalized ? text('현재 진행을 지켜보고 종료 후 결과를 다시 확인하세요.', 'Watch the current progress and review the result after the run ends.') : resultPassed ? text('검사 결과를 확인하거나 HTML 보고서를 저장하세요.', 'Review the check results or save the HTML report.') : summary.origin === 'imported' ? text('원래 기록을 확인하되 현재 통과 근거로 사용하지 마세요.', 'Review the original record, but do not use it as proof of a current pass.') : resultFailed ? text('아래 실패와 미완료 이유를 확인하고 원본을 보완한 뒤 새 계획으로 다시 실행하세요.', 'Review the failures and reasons below, fix the source, then run a new plan.') : text('아래 확인 필요 사유를 해결한 뒤 새 계획이나 결과를 다시 확인하세요.', 'Resolve the reasons below, then review a new plan or result.')}</p>
                </section>
                {summary.integrity === 'degraded' && <p className="alert-text">{text('현재 증거를 확인할 수 없어 이전 통과 결과를 재사용할 수 없습니다.', 'Current evidence cannot be verified, so earlier passing results cannot be reused.')}</p>}
                {summary.origin === 'live' && summary.finalized && summary.cleanupVerified !== true && <p className="alert-text">{text('이 실행의 자원 정리가 확인되지 않았습니다. 프로세스와 임시 자료 상태를 확인하세요.', 'Resource cleanup for this run is unconfirmed. Check its processes and temporary files.')}</p>}
                {summary.finalized && !resultPassed && summary.reasons.length > 0 && <ul className="decision-reasons">{summary.reasons.slice(0, 2).map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul>}
                {summary.failures.length > 0 && <div className="subsection"><div className="section-inline"><h3>{text(`확인이 필요한 검사 ${summary.failures.length}개`, `${summary.failures.length} checks needing review`)}</h3><span className="muted">{text('전체 목록은 검사 결과 탭에서 확인하세요.', 'See the full list in Check results.')}</span></div>
                  {summary.failures.map((item) => <CaseCard key={item.testId} item={item} checkName={checks.find((check) => check.id === item.testId)?.title} onEvidence={(id) => void showEvidence(id)} />)}</div>}
                <details className="technical-detail result-diagnostics"><summary>{text('검사 수와 진단 정보 보기', 'Show counts and diagnostics')}</summary>
                  <div className="metrics"><div><strong>{summary.planned}</strong><span>{text('계획 검사', 'Planned checks')}</span></div><div><strong>{summary.required}</strong><span>{text('필수 검사', 'Required checks')}</span></div>
                    <div><strong>{Object.values(summary.counts).reduce((sum, count) => sum + count, 0)}</strong><span>{text('기록된 결과', 'Recorded results')}</span></div></div>
                  <div className="count-strip">{Object.entries(summary.counts).map(([status, count]) => <span key={status}>{label(caseLabels, status, text('기타', 'Other'))} {text(`${count}건`, `${count}`)}</span>)}</div>
                  <div className="verdict-grid"><div><span className="field-label">{text('실행 당시 판정', 'Recorded verdict')}</span><Badge value={summary.finalized ? summary.verdict : null} /></div>
                    <div><span className="field-label">{text('현재 사용 가능 판정', 'Current usable verdict')}</span><Badge value={summary.effectiveVerdict} /></div>
                    <div><span className="field-label">{text('근거 상태', 'Evidence integrity')}</span><Badge value={summary.integrity} label={summary.integrity === 'verified' ? text('확인됨', 'Verified') : summary.integrity === 'degraded' ? text('손상 또는 부족', 'Damaged or missing') : text('확인 중', 'Pending')} /></div></div>
                  <div className="subsection"><h4>{text('확인 조건', 'Verification conditions')}</h4><div className="condition-list"><span>{text('종료 코드', 'Exit code')} {summary.workerExitCode ?? text('미확인', 'Unconfirmed')}</span>
                    <span>{text('환경', 'Environment')} {summary.environmentVerified === true ? text('확인됨', 'Verified') : text('미확인', 'Unconfirmed')}</span><span>{text('증거', 'Evidence')} {summary.evidenceVerified === true ? text('확인됨', 'Verified') : text('미확인', 'Unconfirmed')}</span>
                    <span>{text('정리', 'Cleanup')} {summary.cleanupVerified === true ? text('확인됨', 'Verified') : text('미확인', 'Unconfirmed')}</span></div></div>
                  {summary.reasons.length > 0 && <div className="subsection"><h4>{text('모든 미완료 및 미확인 이유', 'All incomplete and unconfirmed reasons')}</h4><ul className="compact-list">{summary.reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul></div>}
                </details></div>}
              {resultTab === 'cases' && <div className="result-body"><p className="page-count">{text(`전체 ${casesTotal}건 · 표시 ${cases.length}건`, `${cases.length} shown of ${casesTotal}`)}</p>
                {cases.length ? cases.map((item) => <CaseCard key={item.testId} item={item} checkName={checks.find((check) => check.id === item.testId)?.title} onEvidence={(id) => void showEvidence(id)} />)
                  : <Empty title={text('검사 결과가 없습니다', 'No check results yet')} body={text('실행 상태와 계획 범위를 확인하세요.', 'Review the run state and plan scope.')} />}</div>}
              {resultTab === 'requirements' && <div className="result-body"><p className="page-count">{text(`요구사항 ${requirementsTotal}건 · 표시 ${requirements.length}건`, `${requirements.length} of ${requirementsTotal} requirements shown`)}</p>
                <p className="muted">{text('실행 당시 등록한 필수 검사와 근거를 기준으로 표시합니다. 이번 검사 묶음 밖의 필수 검사가 남으면 완료로 표시하지 않습니다.', 'This uses required checks and evidence recorded for the run. Requirements with required checks outside this check set are not marked complete.')}</p>
                {requirements.map(item => <article className="case-card" key={item.requirementId}>
                  <div className="case-head"><div><strong>{item.title}</strong><span className="muted">{item.requirementId}</span></div><Badge value={item.status} /></div>
                  <p>{text(`등록 검사 ${item.checks.length}개 · 이번 범위 ${item.selectedChecks.length}개 · 범위 밖 ${item.outsideChecks.length}개`, `${item.checks.length} registered · ${item.selectedChecks.length} in this scope · ${item.outsideChecks.length} outside`)}</p>
                  {item.missingChecks.length > 0 && <p className="alert-text">{text('완료 근거가 부족한 검사', 'Checks without sufficient completion evidence')} {item.missingChecks.join(', ')}</p>}
                  {item.checks.length === 0 && <p className="alert-text">{text('연결된 검사가 없습니다.', 'No linked checks.')}</p>}
                  {item.codePaths.length > 0 && <details className="technical-detail"><summary>{text('코드 위치', 'Code locations')}</summary><p className="path-line">{item.codePaths.join(', ')}</p></details>}
                  <div className="evidence-links">{item.evidenceIds.map(id => <button key={id} type="button" className="link-button" onClick={() => void showEvidence(id)}>{short(id, 14)}</button>)}</div>
                </article>)}
              </div>}
              {resultTab === 'gaps' && <div className="result-body"><p className="page-count">{text(`전체 ${runGapsTotal}건 · 표시 ${runGaps.length}건`, `${runGaps.length} shown of ${runGapsTotal}`)}</p>
                {runGaps.length ? <ul className="gap-list">{runGaps.map((gap, index) => <li key={gap.testId ?? index}><span><strong>{checks.find((check) => check.id === gap.testId)?.title ?? gap.testId ?? text('검사 미확인', 'Check unconfirmed')}</strong>{checks.some((check) => check.id === gap.testId) && <small className="check-purpose">{text('현재 등록된 검사명 · 기록 ID', 'Name in current catalog · Recorded ID')} <code>{gap.testId}</code></small>}</span><span>{label(gapLabels, gap.kind, text('확인 필요', 'Needs review'))}</span><Badge value={gap.status ?? 'unknown'} /></li>)}</ul>
                  : <Empty title={text('확인이 필요한 기록이 없습니다', 'No recorded review items')} body={text('현재 실행의 필수 검사에서 추가 항목이 기록되지 않았습니다.', 'No additional items were recorded for required checks in this run.')} />}</div>}
              {resultTab === 'repair-bundle' && <div className="result-body"><div className="section-inline"><p className="page-count">{text(`전체 ${repairTotal}건 · 표시 ${repairItems.length}건`, `${repairItems.length} shown of ${repairTotal}`)}</p>
                <button type="button" className="secondary" onClick={() => void copyText(JSON.stringify({ runId, items: repairItems, displayed: repairItems.length, total: repairTotal }, null, 2))} disabled={repairItems.length === 0}>{text('현재 표시 자료 복사', 'Copy visible data')}</button></div>
                {repairItems.length ? repairItems.map((item) => <div key={item.testId}><CaseCard item={item} checkName={checks.find((check) => check.id === item.testId)?.title} onEvidence={(id) => void showEvidence(id)} /><p className="instruction">{repairInstruction(item.instruction)}</p></div>)
                  : <Empty title={text('전달할 실패 자료가 없습니다', 'No repair data to share')} body={text('실패나 미확인 결과가 저장되면 여기에 표시됩니다.', 'Failed or unconfirmed results appear here when saved.')} />}</div>}
              {resultTab !== 'summary' && resultTab !== 'imported' && resultNext && <button type="button" className="secondary load-more" onClick={() => void moreResults()} disabled={!!busy}>{text('상세 항목 더 보기', 'Show more details')}</button>}
              {evidence && <aside className="evidence-panel" aria-label={text('증거 상세', 'Evidence details')}><div className="panel-heading"><h3>{text('증거 확인', 'Review evidence')}</h3><button className="text-button" type="button" onClick={() => { setEvidence(null); setEvidenceImage(null); }}>{text('닫기', 'Close')}</button></div>
                <dl className="detail-grid"><div><dt>{text('파일', 'File')}</dt><dd className="path-line">{evidence.evidence.relativePath}</dd></div><div><dt>{text('형식', 'Format')}</dt><dd>{evidence.evidence.mime}</dd></div>
                  <div><dt>{text('무결성', 'Integrity')}</dt><dd><Badge value={evidence.integrity} label={evidence.integrity === 'verified' ? text('확인됨', 'Verified') : text('손상 또는 부족', 'Damaged or missing')} /></dd></div>
                  <div><dt>{text('크기', 'Size')}</dt><dd>{evidence.evidence.byteLength.toLocaleString()} {text('바이트', 'bytes')}</dd></div></dl>
                {evidence.reason && <p className="alert-text">{text('현재 확인 결과', 'Current inspection')} {label(evidenceReasonLabels, evidence.reason, text('증거를 확인할 수 없음', 'Evidence could not be verified'))}</p>}
                {evidence.integrity === 'verified' && evidence.evidence.sensitivity === 'public' && evidence.evidence.mime === 'image/png' && <button type="button" className="secondary" disabled={!!busy} onClick={() => void readImage(evidence.evidence.id)}>{text('캡처 보기', 'View capture')}</button>}
                {!evidenceCursor && parseDesignEvidence(evidenceText) && <button type="button" className="secondary" disabled={!!busy} onClick={() => {
                  const design = parseDesignEvidence(evidenceText); if (design) void readImage(design.screenshotEvidenceId, design);
                }}>{text('캡처에서 위반 위치 보기', 'Show issue in capture')}</button>}
                {evidenceImage && (evidenceImage.screenshotEvidenceId === evidence.evidence.id || parseDesignEvidence(evidenceText)?.screenshotEvidenceId === evidenceImage.screenshotEvidenceId) && <VisualEvidence key={evidenceImage.screenshotEvidenceId} {...evidenceImage} />}
                {evidence.integrity === 'verified' && evidence.evidence.sensitivity === 'public' && ['text/plain', 'application/json', 'text/html'].includes(evidence.evidence.mime)
                  ? <><button type="button" className="secondary" onClick={() => void readEvidence()} disabled={!!busy}>{text('안전한 텍스트 보기', 'View safe text')}</button>
                    {evidenceText && <pre className="evidence-text">{evidenceText}</pre>}{evidenceCursor && <button type="button" className="secondary" onClick={() => void readEvidence(evidenceCursor)} disabled={!!busy}>{text('본문 더 보기', 'Show more content')}</button>}</>
                  : evidence.evidence.mime !== 'image/png' || evidence.evidence.sensitivity !== 'public' ? <p className="muted">{text('이 증거는 화면에서 본문을 열 수 없습니다. 메타데이터만 확인할 수 있습니다.', 'This evidence content cannot be opened here. Only metadata is available.')}</p> : null}</aside>}
            </>}</section>}
<section className="panel"><div className="panel-heading"><div><h2>{text('진행과 결과', 'Progress and results')}</h2><p>{text('실행 중인 검사와 확정된 결과를 구분해 보여줍니다.', 'Running checks and finalized results are shown separately.')}</p></div>
            {project && <div className="detail-actions"><button type="button" className="secondary" onClick={() => void action('import', async () => {
              const path = await window.checkmate!.chooseReport();
              if (!path) return;
              const saved = await request<{ runId: string }>('import-history', { projectId: project.id, path });
              await loadHistory(project.id); await openRun(saved.runId);
              setNotice('과거 보고서를 가져왔습니다. 원래 상태는 보존하며 현재 판정은 미확인입니다.', 'Past report imported. Its original state is preserved; the current verdict remains unconfirmed.');
            })} disabled={!!busy}>{text('과거 보고서 가져오기', 'Import past report')}</button><button type="button" className="secondary" onClick={() => void action('refresh-history', () => loadHistory(project.id))} disabled={!!busy}>{text('새로 고침', 'Refresh')}</button></div>}</div>
            {!project ? <Empty title={text('프로젝트를 선택하세요', 'Choose a project')} body={text('위쪽 선택기에서 결과를 볼 프로젝트를 고르세요.', 'Choose a project from the selector above.')} /> : history.length === 0 ? <Empty title={text('실행 기록이 없습니다', 'No runs yet')} body={text('프로젝트 화면에서 계획을 확인하고 검사를 실행하세요.', 'Review a plan on the Projects page and start checks.')} />
              : <><div className="history-list">{history.map((item) => <div className={runId === item.runId ? 'history-row active' : 'history-row'} key={item.runId}>
                <button type="button" className="history-open" onClick={() => void openRun(item.runId)}><strong>{<RecordedProfile id={item.profile} project={project} />}</strong><span>{text('결과 열기', 'Open result')}</span></button>
                <span>{label(stateLabels, item.state)}</span><Badge value={item.verdict} />
                <details className="technical-detail history-id"><summary>{text('실행 ID', 'Run ID')}</summary><code>{item.runId}</code></details></div>)}</div>
                {historyCursor && <button type="button" className="secondary" onClick={() => void action('more-history', () => loadHistory(project.id, historyCursor))} disabled={!!busy}>{text('실행 기록 더 보기', 'Show more runs')}</button>}</>}
          </section>
          </>}
          {!loading && serviceReady && page === 'gaps' && <section className="panel"><div className="panel-heading"><div><h2>{text('확인이 필요한 항목', 'Items needing review')}</h2><p>{text('필수 검사에서 아직 확인되지 않은 근거를 추적합니다.', 'Track evidence still unconfirmed for required checks.')}</p></div><span className="count-label">{text(`전체 ${gapsTotal}개`, `${gapsTotal} total`)}</span></div>
            {!project ? <Empty title={text('프로젝트를 선택하세요', 'Choose a project')} body={text('위쪽 선택기에서 프로젝트를 고르세요.', 'Choose a project from the selector above.')} /> : gaps.length === 0 ? <Empty title={text('기록된 확인 필요 항목이 없습니다', 'No review items recorded')} body={text('검사 실행과 결과 확정 후 다시 확인하세요.', 'Check again after a run has been finalized.')} />
              : <><div className="table-scroll"><table><thead><tr><th scope="col">{text('종류', 'Type')}</th><th scope="col">{text('요구사항', 'Requirement')}</th><th scope="col">{text('처음 발견한 실행', 'First found in run')}</th><th scope="col">{text('보완한 실행', 'Resolved in run')}</th><th scope="col">{text('상태', 'State')}</th></tr></thead>
                <tbody>{gaps.map((gap, index) => <tr key={gap.id ?? index}><td>{label(gapLabels, gap.kind, text('확인 필요', 'Needs review'))}</td><td>{gap.requirementId ?? text('없음', 'None')}</td>
                  <td>{gap.openedRunId ? <button type="button" className="link-button" onClick={() => void openRun(gap.openedRunId!)}>{short(gap.openedRunId, 18)}</button> : text('기록 없음', 'No record')}</td>
                  <td>{gap.resolvedRunId ? <button type="button" className="link-button" onClick={() => void openRun(gap.resolvedRunId!)}>{short(gap.resolvedRunId, 18)}</button> : text('아직 없음', 'Not yet')}</td>
                  <td>{gap.state === 'resolved' ? text('보완됨', 'Resolved') : gap.state === 'open' ? text('보완 필요', 'Needs action') : gap.status ? label(caseLabels, gap.status) : text('미확인', 'Unconfirmed')}</td></tr>)}</tbody></table></div>
                <p className="page-count">{gaps.length} / {gapsTotal}</p>{gapsCursor && <button type="button" className="secondary" onClick={() => void action('more-gaps', () => loadProjectGaps(project.id, gapsCursor))} disabled={!!busy}>{text('항목 더 보기', 'Show more items')}</button>}</>}
          </section>}
          {!loading && serviceReady && page === 'settings' && <section className="panel"><div className="panel-heading"><div><h2>{text('로컬 연결', 'Local connection')}</h2><p>{text('이 앱과 AI 도구가 같은 검사 이력을 읽습니다.', 'This app and AI tools read the same check history.')}</p></div></div>
            {connection ? <dl className="detail-grid settings-grid"><div><dt>{text('버전', 'Version')}</dt><dd>{connection.version}</dd></div><div><dt>{text('데이터 위치', 'Data location')}</dt><dd className="path-line">{connection.dataPath}</dd></div>
              <div><dt>{text('MCP 실행 정보', 'MCP launch details')}</dt><dd className="path-line"><details className="technical-detail"><summary>{text('명령과 인자 보기', 'Show command and arguments')}</summary><code>{text('명령', 'Command')} {connection.mcpCommand.command}</code><br />
                <code>{text('인자', 'Arguments')} {JSON.stringify(connection.mcpCommand.args)}</code><br />
                <button type="button" className="text-button" onClick={() => void copyText(JSON.stringify(connection.mcpCommand, null, 2))}>{text('설정 값 복사', 'Copy settings')}</button></details></dd></div></dl>
              : <Empty title={text('연결 정보를 읽지 못했습니다', 'Connection details unavailable')} body={text('로컬 서비스 상태를 확인한 뒤 앱을 다시 열어 주세요.', 'Check the local service, then reopen the app.')} />}
            <div className="plan-review"><h3>{text('백업과 복구', 'Backup and restore')}</h3><p>{text('실행 중인 검사가 없을 때 이력과 증거를 함께 백업합니다. 복구는 새 빈 폴더에 자료를 만들며 현재 저장소는 유지합니다.', 'Back up history and evidence when no checks are running. Restore creates data in a new empty folder and leaves current storage intact.')}</p>
              <div className="detail-actions"><button type="button" className="primary" onClick={() => void backup()} disabled={!!busy}>{text('현재 자료 백업', 'Back up current data')}</button>
                <button type="button" className="secondary" onClick={() => void chooseBackupPath('backup')} disabled={!!busy}>{text('기존 백업 선택', 'Choose backup')}</button>
                <button type="button" className="secondary" onClick={() => void chooseBackupPath('restore')} disabled={!!busy}>{text('복구할 빈 폴더 선택', 'Choose empty restore folder')}</button></div>
              <p className="path-line">{text('백업 위치', 'Backup location')} {backupDirectory || text('미선택', 'Not selected')}</p>
              {backupHash && <details className="technical-detail"><summary>{text('백업 지문', 'Backup hash')}</summary><CopyValue value={backupHash} label={text('백업 지문', 'Backup hash')} /></details>}
              <p className="path-line">{text('새 자료 위치', 'New data location')} {restoreTarget || text('미선택', 'Not selected')}</p>
              <label className="checkline"><input type="checkbox" checked={restoreConsent} onChange={event => setRestoreConsent(event.target.checked)} disabled={!backupDirectory || !restoreTarget || !!busy} />{text('선택한 백업을 새 빈 폴더에 복구하겠습니다.', 'I will restore this backup into the selected new empty folder.')}</label>
              <button type="button" className="secondary" onClick={() => void restore()} disabled={!restoreConsent || !!busy}>{text('새 폴더로 복구', 'Restore to new folder')}</button>
            </div>
          </section>}
        </>}
      </div>
    </main>
  </div>;
}
