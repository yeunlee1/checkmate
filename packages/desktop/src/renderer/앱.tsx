// 프로젝트 등록부터 실행 결과와 증거 조회까지 사람의 확인 흐름을 제공한다.
import { useEffect, useRef, useState } from 'react';
import type { ApiMethod, ApiResponse } from '@checkmate/contracts/api';

type Bridge = {
  request(method: ApiMethod, input: Record<string, unknown>, requestId?: string): Promise<ApiResponse>;
  chooseDirectory(): Promise<string | null>;
  connectionInfo(): Promise<{ version: string; dataPath: string; mcpCommand: { command: string; args: string[] } }>;
  initializeLocalStore(): Promise<void>;
};
declare global { interface Window { checkmate?: Bridge } }

type PageName = 'projects' | 'checks' | 'history' | 'gaps' | 'settings';
type ResultTab = 'summary' | 'cases' | 'gaps' | 'repair-bundle';
type Page<T> = { items: T[]; nextCursor: string | null; total: number };
type ProjectInfo = { id: string; name: string; repositoryIdentity: string; workspaceId: string;
  realPath: string; activeCatalogHash: string; profiles: { id: string; title: string }[] };
type CheckInfo = { id: string; title: string; requirementId: string; required: boolean; kind: string; expected: string; codePaths: string[] };
type Command = { id: string; title: string; runtime: string; entry: string; args: string[]; timeoutMs: number;
  env: Record<string, string>; writes: string[]; resultFormat: string };
type PlanReview = { planId: string; projectId: string; profile: string; fingerprint: string; sourceHash: string;
  checks: { id: string; title: string; required: boolean }[]; commands: Command[]; writes: string[]; needsApproval: boolean };
type CatalogChange = { projectId: string; contentHash: string; active: boolean; added: string[]; removed: string[];
  changed: string[]; weakened: string[] };
type CaseInfo = { testId: string; status: string; requirementId: string | null; expected: string | null;
  observed: string | null; evidenceIds: string[]; severity: string; location: { file: string; line: number } | null };
type Summary = { runId: string; projectId: string; profile: string; state: string; verdict: string | null;
  effectiveVerdict: string | null; finalized: boolean; integrity: 'verified' | 'degraded' | 'pending';
  reusablePassed: boolean; planned: number; required: number; counts: Record<string, number>; reasons: string[];
  failures: CaseInfo[]; workerExitCode: number | null; environmentVerified: boolean | null;
  evidenceVerified: boolean | null; cleanupVerified: boolean | null };
type HistoryItem = { runId: string; profile: string; state: string; verdict: string | null; finalized: boolean };
type Gap = { id?: string; testId?: string; requirementId: string | null; kind: string; state?: string; status?: string;
  openedRunId?: string; detail?: unknown };
type RepairItem = CaseInfo & { instruction: string };
type EvidenceDescriptor = { id: string; runId: string; relativePath: string; sha256: string; byteLength: number;
  mime: string; sensitivity: 'public' | 'restricted'; state: string };
type EvidenceInspection = { evidence: EvidenceDescriptor; integrity: 'verified' | 'degraded'; reason: string | null };
type EvidenceText = { text: string; nextCursor: string | null; integrity: 'verified' };
type ConnectionInfo = Awaited<ReturnType<Bridge['connectionInfo']>>;

const navigation: { id: PageName; label: string; mark: string }[] = [
  { id: 'projects', label: '프로젝트', mark: '▣' }, { id: 'checks', label: '검사항목', mark: '☷' },
  { id: 'history', label: '실행이력', mark: '◷' }, { id: 'gaps', label: '미검증', mark: '◇' },
  { id: 'settings', label: '설정', mark: '⚙' },
];
const stateLabels: Record<string, string> = { queued: '대기 중', running: '실행 중', finished: '종료',
  blocked: '차단됨', cancelled: '취소됨', unverifiable: '확인 불가' };
const verdictLabels: Record<string, string> = { passed: '통과', failed: '실패', incomplete: '미완료', unknown: '확인 불가' };
const caseLabels: Record<string, string> = { passed: '통과', failed: '실패', 'not-run': '미실행', skipped: '건너뜀',
  'timed-out': '시간 초과', interrupted: '중단', unknown: '확인 불가' };
const reasonLabels: Record<string, string> = { 'run-not-finished': '실행 종료가 확인되지 않았습니다.',
  'check-failed': '실패한 검사가 있습니다.', 'worker-failed': '작업 프로세스가 정상 종료하지 않았습니다.',
  'result-not-finalized': '결과 저장이 확정되지 않았습니다.', 'required-checks-empty': '필수 검사가 없습니다.',
  'required-checks-incomplete': '필수 검사 일부가 통과하지 못했습니다.', 'exit-unconfirmed': '종료 코드가 확인되지 않았습니다.',
  'plan-unconfirmed': '계획 지문이 확인되지 않았습니다.', 'source-unconfirmed': '소스 상태가 확인되지 않았습니다.',
  'source-changed': '검사 중 소스가 변경되었습니다.', 'environment-unconfirmed': '실행 환경이 확인되지 않았습니다.',
  'evidence-unconfirmed': '필수 증거가 확인되지 않았습니다.', 'cleanup-unconfirmed': '사용 자원 정리가 확인되지 않았습니다.',
  'imported-evidence': '가져온 결과의 원본 증거는 확인되지 않았습니다.' };
const gapLabels: Record<string, string> = { 'missing-test': '필수 검사 기록 없음', 'missing-evidence': '필수 증거 부족',
  'environment-blocked': '검사 완료 조건 미충족' };
const evidenceReasonLabels: Record<string, string> = { missing: '파일 없음', 'hash-mismatch': '파일 내용 변경',
  'size-mismatch': '파일 크기 변경', 'changed-during-read': '확인 중 파일 변경', 'unsafe-path': '안전하지 않은 경로',
  'not-file': '일반 파일 아님', 'io-error': '파일 읽기 실패', quarantined: '격리 상태', staged: '등록 대기 상태' };
const errorLabels: Record<string, string> = { 'needs-approval': '실행 전에 계획 범위를 승인해야 합니다.',
  'plan-stale': '계획 이후 원본이 바뀌었습니다. 계획을 다시 확인해 주세요.',
  'catalog-stale': '프로젝트 원본이 활성 기준과 다릅니다. 변경 내용을 확인해 주세요.',
  'storage-busy': '저장 작업이 진행 중입니다. 잠시 뒤 다시 시도해 주세요.',
  'evidence-restricted': '이 증거의 본문은 화면에서 열 수 없습니다.',
  'evidence-degraded': '현재 증거 파일의 무결성을 확인할 수 없습니다.',
  'evidence-missing': '증거 파일이 없어 본문을 열 수 없습니다.' };

class RequestFailure extends Error {
  constructor(readonly code: string, message: string, readonly nextAction: string) { super(message); }
}

async function request<T>(method: ApiMethod, input: Record<string, unknown> = {}, requestId?: string): Promise<T> {
  if (!window.checkmate) throw new RequestFailure('bridge-unavailable', '데스크톱 연결이 준비되지 않았습니다.', '앱에서 다시 열어 주세요.');
  const response = await window.checkmate.request(method, input, requestId);
  if (!response.ok) throw new RequestFailure(response.error.code,
    errorLabels[response.error.code] ?? response.error.message, response.error.nextAction);
  return response.data as T;
}

function errorText(error: unknown): string {
  if (error instanceof RequestFailure) return `${error.message} ${error.nextAction}`.trim();
  return '연결을 확인할 수 없습니다. 서비스를 확인한 뒤 다시 시도해 주세요.';
}

function short(value: string, length = 15): string { return value.length <= length ? value : `${value.slice(0, length)}…`; }
function classFor(value: string | null): string {
  if (value === 'passed' || value === 'verified') return 'good';
  if (value === 'failed' || value === 'degraded') return 'bad';
  if (value === 'unknown' || value === 'incomplete' || value === 'blocked' || value === 'unverifiable') return 'warn';
  return 'neutral';
}
function reasonText(reason: string): string {
  if (reasonLabels[reason]) return reasonLabels[reason];
  if (reason.startsWith('run-')) return `실행 상태가 ${stateLabels[reason.slice(4)] ?? '확인 필요'}입니다.`;
  return '추가 확인이 필요한 조건이 있습니다.';
}

function Mark() {
  return <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
    <rect x="1" y="1" width="38" height="38" rx="10" fill="#2d74f5" />
    <path d="M11 28h18M14 24h12l-2-7 4-4-5 1-3-5-3 5-5-1 4 4-2 7Z" fill="none" stroke="white" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx="20" cy="18" r="1.4" fill="white" />
  </svg>;
}

function Badge({ value, label }: { value: string | null; label?: string }) {
  return <span className={`badge ${classFor(value)}`}>{label ?? (value === null ? '판정 전' : verdictLabels[value] ?? stateLabels[value] ?? caseLabels[value] ?? value)}</span>;
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
  return <span className="copy-value"><code title={value}>{short(value, 30)}</code><button className="text-button" type="button" onClick={() => void copy()} aria-label={`${label} 복사`}>{copied ? '복사됨' : '복사'}</button></span>;
}

function CaseCard({ item, onEvidence }: { item: CaseInfo; onEvidence: (id: string) => void }) {
  return <article className="case-card">
    <div className="case-head"><div><strong>{item.testId}</strong><span className="muted">{item.requirementId ?? '요구사항 없음'}</span></div><Badge value={item.status} /></div>
    <div className="compare"><div><span className="field-label">기대</span><p>{item.expected ?? '기록 없음'}</p></div>
      <div><span className="field-label">관측</span><p>{item.observed ?? '기록 없음'}</p></div></div>
    {item.location && <p className="muted path-line">위치 {item.location.file}:{item.location.line}</p>}
    <div className="evidence-links"><span className="field-label">증거</span>{item.evidenceIds.length === 0 ? <span className="muted">연결된 증거 없음</span>
      : item.evidenceIds.map((id) => <button key={id} type="button" className="link-button" onClick={() => onEvidence(id)}>{short(id, 14)}</button>)}</div>
  </article>;
}

export function App() {
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
  const [resultTab, setResultTab] = useState<ResultTab>('summary');
  const [cases, setCases] = useState<CaseInfo[]>([]);
  const [casesCursor, setCasesCursor] = useState<string | null>(null);
  const [casesTotal, setCasesTotal] = useState(0);
  const [runGaps, setRunGaps] = useState<Gap[]>([]);
  const [runGapsCursor, setRunGapsCursor] = useState<string | null>(null);
  const [runGapsTotal, setRunGapsTotal] = useState(0);
  const [repairItems, setRepairItems] = useState<RepairItem[]>([]);
  const [repairCursor, setRepairCursor] = useState<string | null>(null);
  const [repairTotal, setRepairTotal] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceInspection | null>(null);
  const [evidenceText, setEvidenceText] = useState('');
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [needsInitialization, setNeedsInitialization] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const startRequestId = useRef<string | null>(null);
  const selectedProjectRef = useRef('');
  const busyRef = useRef(false);
  const project = projects.find((item) => item.id === projectId) ?? null;

  async function loadProjects(cursor?: string) {
    const result = await request<Page<ProjectInfo>>('projects', cursor ? { cursor } : {});
    setProjects((previous) => cursor ? [...previous, ...result.items] : result.items);
    setProjectCursor(result.nextCursor);
    setProjectTotal(result.total);
  }
  async function loadChecks(id: string, cursor?: string) {
    const result = await request<Page<CheckInfo>>('checks', { projectId: id, ...(cursor ? { cursor } : {}) });
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
    setGaps((previous) => cursor ? [...previous, ...result.items] : result.items);
    setGapsCursor(result.nextCursor); setGapsTotal(result.total);
  }
  async function loadSummary(id: string) {
    const result = await request<Summary>('result', { runId: id, section: 'summary' });
    setSummary(result);
    return result;
  }
  async function action(label: string, work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label); setNotice('');
    try { await work(); } catch (error) { setNotice(errorText(error)); }
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
          else setNotice(errorText(error));
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
        if (!active) return;
        setSummary(result);
        if (result.finalized) {
          if (projectId) void loadHistory(projectId).catch((error: unknown) => { if (active) setNotice(errorText(error)); });
        } else timer = window.setTimeout(() => void tick(), 2500);
      } catch (error) {
        if (!active) return;
        setNotice(errorText(error));
        timer = window.setTimeout(() => void tick(), 5000);
      }
    }
    void tick();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [connected, page, runId, projectId]);

  function selectProject(id: string) {
    selectedProjectRef.current = id;
    setProjectId(id); setProfileId(''); setPlan(null); setConsent(false); setCatalogChange(null);
    setChecks([]); setHistory([]); setGaps([]); setRunId(''); setSummary(null);
    startRequestId.current = null;
    void loadHistory(id).catch((error: unknown) => { if (selectedProjectRef.current === id) setNotice(errorText(error)); });
  }
  function navigate(next: PageName) {
    setPage(next); setNotice('');
    if (!projectId) return;
    if (next === 'checks') void loadChecks(projectId).catch((error: unknown) => setNotice(errorText(error)));
    if (next === 'history') void loadHistory(projectId).catch((error: unknown) => setNotice(errorText(error)));
    if (next === 'gaps') void loadProjectGaps(projectId).catch((error: unknown) => setNotice(errorText(error)));
  }
  async function addProject() {
    await action('register', async () => {
      const path = await window.checkmate!.chooseDirectory();
      if (!path) return;
      const added = await request<ProjectInfo>('register', { path });
      await loadProjects(); selectProject(added.id);
      setNotice('프로젝트를 등록했습니다. 실행 전 계획과 명령 범위를 확인해 주세요.');
    });
  }
  async function initialize() {
    await action('initialize', async () => {
      await window.checkmate!.initializeLocalStore();
      await request('capabilities');
      setConnection(await window.checkmate!.connectionInfo());
      await loadProjects();
      setNeedsInitialization(false); setServiceReady(true);
      setNotice('로컬 저장소가 준비되었습니다. 프로젝트를 선택해 등록할 수 있습니다.');
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
      setNotice('로컬 서비스에 연결했습니다.');
    });
  }
  async function inspect() {
    if (!project || !profileId) return;
    await action('inspect', async () => {
      const result = await request<PlanReview>('inspect', { projectId: project.id, profile: profileId });
      setPlan(result); setConsent(false); startRequestId.current = null;
    });
  }
  async function approve() {
    if (!plan || !consent) return;
    await action('approve', async () => {
      await request<{ approvalId: string }>('approve', { planId: plan.planId, fingerprint: plan.fingerprint });
      setPlan({ ...plan, needsApproval: false });
      setNotice('이 계획의 명령과 쓰기 범위를 승인했습니다. 실행은 별도로 시작해야 합니다.');
    });
  }
  async function start() {
    if (!project || !plan || plan.needsApproval || !consent) return;
    await action('start', async () => {
      startRequestId.current ??= crypto.randomUUID();
      const accepted = await request<{ runId: string; reused: boolean }>('start',
        { projectId: project.id, planId: plan.planId }, startRequestId.current);
      startRequestId.current = null;
      setRunId(accepted.runId); setSummary(null); setCancelRequested(false); setResultTab('summary');
      setPage('history');
      await loadHistory(project.id);
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
      await loadProjects(); setNotice('변경된 카탈로그를 활성화했습니다. 새 계획을 확인해 주세요.');
    });
  }
  async function openRun(id: string) {
    setRunId(id); setSummary(null); setResultTab('summary'); setEvidence(null); setCancelRequested(false);
    setPage('history');
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
      if (next === 'cases') { const result = await request<Page<CaseInfo>>('result', { runId, section: next });
        setCases(result.items); setCasesCursor(result.nextCursor); setCasesTotal(result.total); }
      if (next === 'gaps') { const result = await request<Page<Gap>>('result', { runId, section: next });
        setRunGaps(result.items); setRunGapsCursor(result.nextCursor); setRunGapsTotal(result.total); }
      if (next === 'repair-bundle') { const result = await request<Page<RepairItem>>('result', { runId, section: next });
        setRepairItems(result.items); setRepairCursor(result.nextCursor); setRepairTotal(result.total); }
    });
  }
  async function moreResults() {
    if (!runId) return;
    await action('more-results', async () => {
      if (resultTab === 'cases' && casesCursor) { const result = await request<Page<CaseInfo>>('result',
        { runId, section: 'cases', cursor: casesCursor }); setCases([...cases, ...result.items]); setCasesCursor(result.nextCursor); }
      if (resultTab === 'gaps' && runGapsCursor) { const result = await request<Page<Gap>>('result',
        { runId, section: 'gaps', cursor: runGapsCursor }); setRunGaps([...runGaps, ...result.items]); setRunGapsCursor(result.nextCursor); }
      if (resultTab === 'repair-bundle' && repairCursor) { const result = await request<Page<RepairItem>>('result',
        { runId, section: 'repair-bundle', cursor: repairCursor, limit: 5 }); setRepairItems([...repairItems, ...result.items]); setRepairCursor(result.nextCursor); }
    });
  }
  async function showEvidence(id: string) {
    if (!runId) return;
    await action('evidence', async () => {
      const inspected = await request<EvidenceInspection>('evidence', { runId, evidenceId: id });
      setEvidence(inspected); setEvidenceText(''); setEvidenceCursor(null);
    });
  }
  async function readEvidence(cursor?: string) {
    if (!runId || !evidence) return;
    await action('evidence-text', async () => {
      const result = await request<EvidenceText>('evidence', { runId, evidenceId: evidence.evidence.id,
        content: true, limit: 8192, ...(cursor ? { cursor } : {}) });
      setEvidenceText((old) => cursor ? old + result.text : result.text); setEvidenceCursor(result.nextCursor);
    });
  }
  async function copyText(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('클립보드에 복사했습니다.'); }
    catch { setNotice('복사할 수 없습니다. 내용을 선택해 직접 복사해 주세요.'); }
  }

  const title = navigation.find((item) => item.id === page)?.label ?? '프로젝트';
  const resultNext = resultTab === 'cases' ? casesCursor : resultTab === 'gaps' ? runGapsCursor : repairCursor;
  const recentActive = history.find((item) => !item.finalized && ['queued', 'running'].includes(item.state));
  const recentFinal = history.find((item) => item.finalized);
  return <div className="app-shell">
    <a className="skip-link" href="#main">본문으로 건너뛰기</a>
    <aside className="sidebar" aria-label="주 메뉴">
      <div className="brand"><Mark /><span><strong>CheckMate</strong><small>검사 결과와 근거</small></span></div>
      <nav className="side-nav" aria-label="화면 이동">{navigation.map((item) =>
        <button key={item.id} type="button" className={page === item.id ? 'nav-item current' : 'nav-item'}
          onClick={() => navigate(item.id)} disabled={!serviceReady} aria-current={page === item.id ? 'page' : undefined} title={item.label}>
          <span className="nav-mark" aria-hidden="true">{item.mark}</span>{item.label}</button>)}</nav>
      <div className="sidebar-foot"><span className={serviceReady ? 'connection-dot online' : 'connection-dot'} />
        {serviceReady ? '로컬 서비스 연결' : connected ? '서비스 확인 필요' : '개발 미리보기'}<small>{connection?.version ?? '서비스 확인 전'}</small></div>
    </aside>
    <main id="main" className="main-content" tabIndex={-1}>
      <header className="topbar"><div><p className="eyebrow">DESKTOP WORKSPACE</p><h1>{title}</h1></div>
        {serviceReady && <div className="top-actions"><span className="top-project">{project?.name ?? '프로젝트 미선택'}</span>
          {page === 'projects' && serviceReady && <button className="primary" type="button" onClick={() => void addProject()} disabled={!!busy}>+ 프로젝트 추가</button>}</div>}</header>
      <div className="content-wrap">
        {!connected && <section className="panel preview" aria-live="polite"><div className="preview-icon"><Mark /></div>
          <h2>데스크톱 연결이 필요합니다</h2><p>이 화면은 개발 미리보기입니다. 프로젝트 등록과 검사 실행은 CheckMate 앱에서 연결된 뒤 사용할 수 있습니다.</p>
          <p className="muted">실행 결과나 예시 데이터는 표시하지 않습니다.</p></section>}
        {connected && <>
          {loading && <p className="loading" role="status">로컬 서비스와 프로젝트를 확인하는 중입니다…</p>}
          {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}
          {!loading && needsInitialization && <section className="panel setup-panel" aria-live="polite"><p className="eyebrow">LOCAL SETUP</p>
            <h2>로컬 저장소 준비가 필요합니다</h2><p>CheckMate가 이 컴퓨터에 전용 저장소를 만들고 프로젝트 및 검사 이력을 기록합니다. 준비 후 프로젝트 등록과 실행 계획 확인을 시작할 수 있습니다.</p>
            <button type="button" className="primary" onClick={() => void initialize()} disabled={!!busy}>{busy === 'initialize' ? '준비 중…' : '로컬 저장소 준비'}</button></section>}
          {!loading && !needsInitialization && !serviceReady && <section className="panel setup-panel" aria-live="polite"><p className="eyebrow">CONNECTION</p>
            <h2>로컬 서비스에 연결할 수 없습니다</h2><p>검사 결과와 프로젝트 목록을 읽지 못했습니다. 서비스를 확인한 뒤 다시 연결해 주세요.</p>
            <button type="button" className="secondary" onClick={() => void retryConnection()} disabled={!!busy}>다시 연결</button></section>}
          {!loading && serviceReady && page === 'projects' && <>
            <section className="section-head"><div><h2>등록된 프로젝트</h2><p>프로젝트를 선택해 검사 범위와 실행 계획을 확인하세요.</p></div>
              <button type="button" className="secondary" onClick={() => void action('refresh', () => loadProjects())} disabled={!!busy}>새로 고침</button></section>
            {projects.length === 0 ? <Empty title="등록된 프로젝트가 없습니다" body="프로젝트 폴더를 선택해 검사 원본을 등록하세요. 등록만으로 명령이 실행되지는 않습니다." />
              : <><div className="project-grid">{projects.map((item) => <button className={item.id === projectId ? 'project-tile selected' : 'project-tile'}
                type="button" key={item.id} onClick={() => selectProject(item.id)} aria-pressed={item.id === projectId}>
                <span className="tile-kicker">프로젝트</span><strong>{item.name}</strong><span className="tile-path">{item.realPath}</span>
                <span className="tile-bottom">프로필 {item.profiles.length}개 <span aria-hidden="true">↗</span></span></button>)}</div>
                <p className="page-count">{projects.length} / {projectTotal}개</p>{projectCursor && <button type="button" className="secondary" onClick={() => void action('more-projects', () => loadProjects(projectCursor))} disabled={!!busy}>프로젝트 더 보기</button>}</>}
            {project && <section className="panel project-detail"><div className="panel-heading"><div><p className="eyebrow">SELECTED PROJECT</p><h2>{project.name}</h2></div><Badge value="verified" label="등록됨" /></div>
              <dl className="detail-grid"><div><dt>작업 폴더</dt><dd className="path-line">{project.realPath}</dd></div>
                <div><dt>프로젝트 ID</dt><dd><CopyValue value={project.id} label="프로젝트 ID" /></dd></div>
                <div><dt>활성 카탈로그</dt><dd><CopyValue value={project.activeCatalogHash} label="카탈로그 해시" /></dd></div>
                <div><dt>저장소 식별자</dt><dd className="path-line">{project.repositoryIdentity}</dd></div></dl>
              <div className="detail-actions"><button type="button" className="secondary" onClick={() => void sync()} disabled={!!busy}>원본 변경 확인</button></div>
              {catalogChange && <div className="change-review"><div className="panel-heading"><h3>원본 변경 비교</h3><Badge value={catalogChange.active ? 'verified' : 'unknown'} label={catalogChange.active ? '현재 활성' : '활성 전 후보'} /></div>
                <p className="muted">새 원본 해시 <CopyValue value={catalogChange.contentHash} label="새 원본 해시" /></p>
                <div className="change-list"><span>추가 {catalogChange.added.length}개</span><span>제거 {catalogChange.removed.length}개</span><span>변경 {catalogChange.changed.length}개</span><span className="warn-text">약화 가능 {catalogChange.weakened.length}개</span></div>
                {catalogChange.added.length > 0 && <p className="path-line">추가된 검사 {catalogChange.added.join(', ')}</p>}
                {catalogChange.removed.length > 0 && <p className="path-line">제거된 검사 {catalogChange.removed.join(', ')}</p>}
                {catalogChange.changed.length > 0 && <p className="path-line">변경된 검사 {catalogChange.changed.join(', ')}</p>}
                {catalogChange.weakened.length > 0 && <p className="path-line">확인 필요 {catalogChange.weakened.join(', ')}</p>}
                <p className="muted change-limit">검사 ID 비교에 표시되지 않는 명령과 요구사항 변경도 원본 해시에 포함됩니다. 활성화 후 새 계획에서 실행 명령을 다시 확인해야 합니다.</p>
                {!catalogChange.active && <><label className="checkline"><input type="checkbox" checked={activateConsent} onChange={(event) => setActivateConsent(event.target.checked)} />변경 목록을 확인했고 활성 기준을 바꾸겠습니다.</label>
                  <button type="button" className="secondary" onClick={() => void activate()} disabled={!activateConsent || !!busy}>새 기준 활성화</button></>}</div>}
            </section>}
            {project && <section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>최근 실행</h2></div></div>
              {historyLoading ? <p className="loading" role="status">최근 실행을 읽는 중입니다…</p> : !recentActive && !recentFinal
                ? <Empty title="최근 실행이 없습니다" body="계획을 확인하고 실행하면 이 프로젝트의 최신 상태가 표시됩니다." />
                : <div className="recent-list">{recentActive && <button type="button" className="recent-item" onClick={() => void openRun(recentActive.runId)}>
                  <span><small>계속 진행 중</small><strong>{recentActive.profile}</strong><code>{short(recentActive.runId, 20)}</code></span>
                  <Badge value={recentActive.state} label={stateLabels[recentActive.state] ?? '진행 중'} /></button>}
                  {recentFinal && <button type="button" className="recent-item" onClick={() => void openRun(recentFinal.runId)}>
                    <span><small>마지막 확정 결과</small><strong>{recentFinal.profile}</strong><code>{short(recentFinal.runId, 20)}</code></span>
                    <Badge value={recentFinal.verdict} /></button>}</div>}</section>}
            {project && <section className="panel plan-panel"><div className="panel-heading"><div><p className="eyebrow">RUN PREPARATION</p><h2>실행 계획</h2></div><span className="step-count">01 / 03</span></div>
              <div className="form-row"><label htmlFor="profile">검사 프로필</label><select id="profile" value={profileId} onChange={(event) => { setProfileId(event.target.value); setPlan(null); setConsent(false); startRequestId.current = null; }}>
                <option value="">프로필 선택</option>{project.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.title} · {profile.id}</option>)}</select>
                <button className="primary" type="button" onClick={() => void inspect()} disabled={!profileId || !!busy}>계획 확인</button></div>
              {plan && <div className="plan-review"><div className="review-top"><div><h3>계획 범위</h3><p>필수 검사와 실행 명령, 쓰기 경로를 확인하세요.</p></div><Badge value={plan.needsApproval ? 'unknown' : 'verified'} label={plan.needsApproval ? '승인 필요' : '승인됨'} /></div>
                <div className="metrics"><div><strong>{plan.checks.length}</strong><span>선택 검사</span></div><div><strong>{plan.checks.filter((item) => item.required).length}</strong><span>필수 검사</span></div><div><strong>{plan.commands.length}</strong><span>실행 명령</span></div></div>
                <div className="subsection"><h4>선택 검사</h4><ul className="compact-list">{plan.checks.map((item) => <li key={item.id}><span>{item.title} <code>{item.id}</code></span>{item.required && <span className="small-tag">필수</span>}</li>)}</ul></div>
                <div className="subsection"><h4>실행 명령과 환경</h4>{plan.commands.map((command) => <div className="command-card" key={command.id}><strong>{command.title}</strong>
                  <p><code>{command.runtime} {command.entry} {command.args.join(' ')}</code></p><p className="muted">시간 제한 {Math.round(command.timeoutMs / 1000)}초 · 결과 형식 {command.resultFormat}</p>
                  <div className="env-list">{Object.entries(command.env).length === 0 ? '추가 환경 값 없음' : Object.entries(command.env).map(([key, value]) => <code key={key}>{key}={value}</code>)}</div></div>)}</div>
                <div className="subsection"><h4>허용된 쓰기 경로</h4>{plan.writes.length === 0 ? <p className="muted">선언된 쓰기 경로가 없습니다.</p> : <ul className="compact-list">{plan.writes.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}</div>
                <p className="muted">계획 지문 <CopyValue value={plan.fingerprint} label="계획 지문" /></p>
                <label className="checkline"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />위 명령, 환경 값, 쓰기 범위를 확인했습니다.</label>
                <div className="plan-actions">{plan.needsApproval && <button type="button" className="secondary" onClick={() => void approve()} disabled={!consent || !!busy}>이 계획 승인</button>}
                  <button type="button" className="primary" onClick={() => void start()} disabled={!consent || plan.needsApproval || !!busy}>검사 실행</button></div>
              </div>}</section>}
          </>}
          {!loading && serviceReady && page === 'checks' && <section className="panel"><div className="panel-heading"><div><h2>검사항목</h2><p>현재 활성 원본에 등록된 검사입니다.</p></div><span className="count-label">총 {checksTotal}개</span></div>
            {!project ? <Empty title="프로젝트를 선택하세요" body="프로젝트 화면에서 검사할 대상을 먼저 선택하세요." /> : checks.length === 0 ? <Empty title="검사항목이 없습니다" body="활성 원본과 연결 상태를 확인하세요." />
              : <><div className="table-scroll"><table><thead><tr><th scope="col">검사</th><th scope="col">요구사항</th><th scope="col">분류</th><th scope="col">필수</th><th scope="col">코드 위치</th></tr></thead>
                <tbody>{checks.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><code className="block-code">{item.id}</code></td><td>{item.requirementId}</td><td>{item.kind}</td><td>{item.required ? '필수' : '선택'}</td><td className="path-line">{item.codePaths.join(', ') || '기록 없음'}</td></tr>)}</tbody></table></div>
                <p className="page-count">{checks.length} / {checksTotal}개</p>{checksCursor && <button type="button" className="secondary" onClick={() => void action('more-checks', () => loadChecks(project.id, checksCursor))} disabled={!!busy}>검사항목 더 보기</button>}</>}
          </section>}
          {!loading && serviceReady && page === 'history' && <><section className="panel"><div className="panel-heading"><div><h2>실행이력</h2><p>접수와 최종 판정을 구분해 확인하세요.</p></div>
            {project && <button type="button" className="secondary" onClick={() => void action('refresh-history', () => loadHistory(project.id))} disabled={!!busy}>새로 고침</button>}</div>
            {!project ? <Empty title="프로젝트를 선택하세요" body="프로젝트를 선택하면 해당 실행이력이 표시됩니다." /> : history.length === 0 ? <Empty title="실행이력이 없습니다" body="프로젝트에서 계획을 확인하고 검사를 실행하세요." />
              : <><div className="history-list">{history.map((item) => <button type="button" className={runId === item.runId ? 'history-row active' : 'history-row'} key={item.runId} onClick={() => void openRun(item.runId)}>
                <span><strong>{item.profile}</strong><code>{short(item.runId, 21)}</code></span><span>{stateLabels[item.state] ?? item.state}</span><Badge value={item.verdict} /></button>)}</div>
                {historyCursor && <button type="button" className="secondary" onClick={() => void action('more-history', () => loadHistory(project.id, historyCursor))} disabled={!!busy}>이력 더 보기</button>}</>}
          </section>
          {runId && <section className="panel run-panel"><div className="panel-heading"><div><p className="eyebrow">RUN DETAIL</p><h2>실행 결과</h2><CopyValue value={runId} label="실행 ID" /></div>
            {summary && <Badge value={summary.effectiveVerdict} label={summary.finalized ? verdictLabels[summary.effectiveVerdict ?? ''] ?? '확인 불가' : stateLabels[summary.state] ?? summary.state} />}</div>
            {!summary ? <p className="loading" role="status">실행 상태를 읽는 중입니다…</p> : <><div className="run-state" aria-live="polite"><div><strong>{stateLabels[summary.state] ?? summary.state}</strong><span>{summary.finalized ? '최종 결과가 저장되었습니다.' : '실행 중입니다. 종료 확인 후 판정이 확정됩니다.'}</span></div>
              {!summary.finalized && <button type="button" className="danger-button" onClick={() => void cancel()} disabled={!!busy || cancelRequested}>{cancelRequested ? '취소 요청됨 · 종료 확인 중' : '실행 취소 요청'}</button>}</div>
              <div className="result-tabs" role="tablist" aria-label="결과 보기">{([{ id: 'summary', label: '요약' }, { id: 'cases', label: '검사 결과' },
                { id: 'gaps', label: '미검증' }, { id: 'repair-bundle', label: 'AI 수정 자료 묶음' }] as { id: ResultTab; label: string }[]).map((tab) =>
                <button type="button" role="tab" aria-selected={resultTab === tab.id} className={resultTab === tab.id ? 'result-tab active' : 'result-tab'} key={tab.id}
                  onClick={() => void selectResultTab(tab.id)}>{tab.label}</button>)}</div>
              {resultTab === 'summary' && <div className="result-body"><div className="metrics"><div><strong>{summary.planned}</strong><span>계획 검사</span></div><div><strong>{summary.required}</strong><span>필수 검사</span></div>
                <div><strong>{Object.values(summary.counts).reduce((sum, count) => sum + count, 0)}</strong><span>기록된 결과</span></div></div>
                <div className="count-strip">{Object.entries(summary.counts).map(([status, count]) => <span key={status}>{caseLabels[status] ?? '기타'} {count}건</span>)}</div>
                <div className="verdict-grid"><div><span className="field-label">최종 판정</span><Badge value={summary.verdict} /></div>
                  <div><span className="field-label">현재 사용 가능 판정</span><Badge value={summary.effectiveVerdict} /></div>
                  <div><span className="field-label">근거 무결성</span><Badge value={summary.integrity} label={{ verified: '확인됨', degraded: '손상 또는 부족', pending: '확인 중' }[summary.integrity]} /></div></div>
                {summary.integrity === 'degraded' && <p className="alert-text">현재 증거를 확인할 수 없어 이전 통과 결과를 재사용할 수 없습니다.</p>}
                <div className="subsection"><h3>확인 조건</h3><div className="condition-list"><span>종료코드 {summary.workerExitCode ?? '미확인'}</span>
                  <span>환경 {summary.environmentVerified === true ? '확인됨' : '미확인'}</span><span>증거 {summary.evidenceVerified === true ? '확인됨' : '미확인'}</span>
                  <span>정리 {summary.cleanupVerified === true ? '확인됨' : '미확인'}</span></div></div>
                <div className="subsection"><h3>미완료 이유</h3>{summary.reasons.length ? <ul className="compact-list">{summary.reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul>
                  : <p className="muted">기록된 미완료 이유가 없습니다.</p>}</div>
                <div className="subsection"><div className="section-inline"><h3>상위 실패 {summary.failures.length}개</h3><span className="muted">전체 검사 결과는 상세 탭에서 확인</span></div>
                  {summary.failures.length ? summary.failures.map((item) => <CaseCard key={item.testId} item={item} onEvidence={(id) => void showEvidence(id)} />)
                    : <p className="muted">요약에 표시할 실패 기록이 없습니다.</p>}</div></div>}
              {resultTab === 'cases' && <div className="result-body"><p className="page-count">전체 {casesTotal}건 · 표시 {cases.length}건</p>
                {cases.length ? cases.map((item) => <CaseCard key={item.testId} item={item} onEvidence={(id) => void showEvidence(id)} />)
                  : <Empty title="검사 결과가 없습니다" body="실행 상태와 계획 범위를 확인하세요." />}</div>}
              {resultTab === 'gaps' && <div className="result-body"><p className="page-count">전체 {runGapsTotal}건 · 표시 {runGaps.length}건</p>
                {runGaps.length ? <ul className="gap-list">{runGaps.map((gap, index) => <li key={gap.testId ?? index}><strong>{gap.testId ?? '검사 미확인'}</strong><span>{gapLabels[gap.kind] ?? '확인 필요'}</span><Badge value={gap.status ?? 'unknown'} /></li>)}</ul>
                  : <Empty title="미검증 기록이 없습니다" body="현재 실행의 필수 검사에서 추가 미검증 항목이 기록되지 않았습니다." />}</div>}
              {resultTab === 'repair-bundle' && <div className="result-body"><div className="section-inline"><p className="page-count">전체 {repairTotal}건 · 표시 {repairItems.length}건</p>
                <button type="button" className="secondary" onClick={() => void copyText(JSON.stringify({ runId, items: repairItems, displayed: repairItems.length, total: repairTotal }, null, 2))} disabled={repairItems.length === 0}>현재 표시 자료 복사</button></div>
                {repairItems.length ? repairItems.map((item) => <div key={item.testId}><CaseCard item={item} onEvidence={(id) => void showEvidence(id)} /><p className="instruction">{item.instruction}</p></div>)
                  : <Empty title="전달할 실패 자료가 없습니다" body="실패나 미검증 결과가 저장되면 여기에 표시됩니다." />}</div>}
              {resultTab !== 'summary' && resultNext && <button type="button" className="secondary load-more" onClick={() => void moreResults()} disabled={!!busy}>상세 항목 더 보기</button>}
              {evidence && <aside className="evidence-panel" aria-label="증거 상세"><div className="panel-heading"><h3>증거 확인</h3><button className="text-button" type="button" onClick={() => setEvidence(null)}>닫기</button></div>
                <dl className="detail-grid"><div><dt>파일</dt><dd className="path-line">{evidence.evidence.relativePath}</dd></div><div><dt>형식</dt><dd>{evidence.evidence.mime}</dd></div>
                  <div><dt>무결성</dt><dd><Badge value={evidence.integrity} label={evidence.integrity === 'verified' ? '확인됨' : '손상 또는 부족'} /></dd></div>
                  <div><dt>크기</dt><dd>{evidence.evidence.byteLength.toLocaleString()}바이트</dd></div></dl>
                {evidence.reason && <p className="alert-text">현재 확인 결과 {evidenceReasonLabels[evidence.reason] ?? '증거를 확인할 수 없음'}</p>}
                {evidence.integrity === 'verified' && evidence.evidence.sensitivity === 'public' && ['text/plain', 'application/json', 'text/html'].includes(evidence.evidence.mime)
                  ? <><button type="button" className="secondary" onClick={() => void readEvidence()} disabled={!!busy}>안전한 텍스트 보기</button>
                    {evidenceText && <pre className="evidence-text">{evidenceText}</pre>}{evidenceCursor && <button type="button" className="secondary" onClick={() => void readEvidence(evidenceCursor)} disabled={!!busy}>본문 더 보기</button>}</>
                  : <p className="muted">이 증거는 화면에서 본문을 열 수 없습니다. 메타데이터만 확인할 수 있습니다.</p>}</aside>}
            </>}</section>}</>}
          {!loading && serviceReady && page === 'gaps' && <section className="panel"><div className="panel-heading"><div><h2>미검증 항목</h2><p>필수 검사에서 확인되지 않은 근거를 추적합니다.</p></div><span className="count-label">총 {gapsTotal}개</span></div>
            {!project ? <Empty title="프로젝트를 선택하세요" body="프로젝트를 선택하면 미검증 이력이 표시됩니다." /> : gaps.length === 0 ? <Empty title="기록된 미검증 항목이 없습니다" body="검사 실행과 결과 확정 후 다시 확인하세요." />
              : <><div className="table-scroll"><table><thead><tr><th scope="col">종류</th><th scope="col">요구사항</th><th scope="col">실행</th><th scope="col">상태</th></tr></thead>
                <tbody>{gaps.map((gap, index) => <tr key={gap.id ?? index}><td>{gapLabels[gap.kind] ?? '확인 필요'}</td><td>{gap.requirementId ?? '없음'}</td>
                  <td>{gap.openedRunId ? <button type="button" className="link-button" onClick={() => void openRun(gap.openedRunId!)}>{short(gap.openedRunId, 18)}</button> : '기록 없음'}</td><td>{gap.state ?? gap.status ?? '미확인'}</td></tr>)}</tbody></table></div>
                <p className="page-count">{gaps.length} / {gapsTotal}개</p>{gapsCursor && <button type="button" className="secondary" onClick={() => void action('more-gaps', () => loadProjectGaps(project.id, gapsCursor))} disabled={!!busy}>미검증 항목 더 보기</button>}</>}
          </section>}
          {!loading && serviceReady && page === 'settings' && <section className="panel"><div className="panel-heading"><div><h2>로컬 연결</h2><p>이 앱과 AI 도구가 같은 검사 이력을 읽습니다.</p></div></div>
            {connection ? <dl className="detail-grid settings-grid"><div><dt>버전</dt><dd>{connection.version}</dd></div><div><dt>데이터 위치</dt><dd className="path-line">{connection.dataPath}</dd></div>
              <div><dt>MCP 실행 정보</dt><dd className="path-line"><code>명령 {connection.mcpCommand.command}</code><br />
                <code>인자 {JSON.stringify(connection.mcpCommand.args)}</code><br />
                <button type="button" className="text-button" onClick={() => void copyText(JSON.stringify(connection.mcpCommand, null, 2))}>설정 값 복사</button></dd></div></dl>
              : <Empty title="연결 정보를 읽지 못했습니다" body="로컬 서비스 상태를 확인한 뒤 앱을 다시 열어 주세요." />}
          </section>}
        </>}
      </div>
    </main>
  </div>;
}
