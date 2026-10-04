// 프로젝트 검사 자료의 이전 미리보기와 확정 및 미확인 작업 조회를 제공한다.
import { useEffect, useRef, useState } from 'react';
import type { ApiMethod, ApiResponse, ProjectStorageApplied, ProjectStorageOperation, ProjectStoragePreview, ProjectStorageSettings } from '@checkmate/contracts/api';
import { text, useLanguage } from './언어.js';

type StorageBridge = {
  request(method: ApiMethod, input: Record<string, unknown>, requestId?: string): Promise<ApiResponse>;
  chooseDirectory(purpose: 'project-storage'): Promise<string | null>;
};
type Scope = { projectId: string; connectionKey: string; generation: number; bridge: StorageBridge };
type FrozenOperation = {
  projectId: string; connectionKey: string; generation: number; operationId: string;
  input: { projectId: string; previewId: string; expectedRevision: number; fingerprint: string; confirm: true };
  state: ProjectStorageOperation['state']; result?: ProjectStorageApplied; error?: string;
};
type Problem = { code: string; message?: string; nextAction?: string };
type View = { scope: Scope; settings: ProjectStorageSettings | null; preview: ProjectStoragePreview | null; problem: Problem | null };
type Props = {
  projectId: string; projectName: string; connectionKey: string; generation: number; supported: boolean; available: boolean;
  disabled: boolean; acquire: () => boolean; release: () => void;
  onApplied: (projectId: string, connectionKey: string) => void;
};
const pendingKey = 'checkmate.project-storage.operations.v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const operationKey = (connectionKey: string, projectId: string) => JSON.stringify([connectionKey, projectId]);
const unresolved = (operation: FrozenOperation | undefined) => !!operation && operation.state !== 'completed' && operation.state !== 'failed';
function readPending(): { operations: Record<string, FrozenOperation>; corrupt: boolean } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const operations: Record<string, FrozenOperation> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      const value = raw as FrozenOperation;
      if (!value || typeof value !== 'object' || typeof value.projectId !== 'string' || !uuid.test(value.projectId)
        || typeof value.operationId !== 'string' || !uuid.test(value.operationId) || typeof value.connectionKey !== 'string'
        || !value.connectionKey || value.connectionKey.length > 16384 || !Number.isSafeInteger(value.generation) || value.generation < 0
        || key !== operationKey(value.connectionKey, value.projectId) || !value.input || value.input.projectId !== value.projectId
        || typeof value.input.previewId !== 'string' || !uuid.test(value.input.previewId) || value.input.confirm !== true
        || typeof value.input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.input.fingerprint)
        || !Number.isSafeInteger(value.input.expectedRevision) || value.input.expectedRevision < 0) throw new Error();
      operations[key] = { projectId: value.projectId, connectionKey: value.connectionKey, generation: value.generation,
        operationId: value.operationId, input: Object.freeze({ projectId: value.projectId, previewId: value.input.previewId,
          expectedRevision: value.input.expectedRevision, fingerprint: value.input.fingerprint, confirm: true }), state: 'unknown' };
    }
    return { operations, corrupt: false };
  } catch { return { operations: {}, corrupt: true }; }
}
function writePending(operations: Record<string, FrozenOperation>) {
  const durable = Object.fromEntries(Object.entries(operations).filter(([, value]) => unresolved(value)).map(([key, value]) =>
    [key, { projectId: value.projectId, connectionKey: value.connectionKey, generation: value.generation, operationId: value.operationId, input: value.input }]));
  localStorage.setItem(pendingKey, JSON.stringify(durable));
}
function problem(error: unknown): Problem {
  return error && typeof error === 'object' && 'code' in error ? error as Problem : { code: 'connection-unconfirmed' };
}
function problemText(value: Problem): string {
  const labels: Record<string, [string, string]> = {
    'connection-unconfirmed': ['응답을 확인하지 못했습니다. 같은 작업 ID의 상태만 확인해 주세요.', 'The response is unconfirmed. Check only the same operation ID.'],
    'storage-busy': ['실행 중인 검사 또는 정리가 확인되지 않은 자료가 있어 이전할 수 없습니다.', 'Active checks or unconfirmed cleanup prevent migration.'],
    'storage-operation-unknown': ['이전 작업 상태가 미확인입니다. 같은 작업 ID로 조회해 주세요.', 'Migration state is unknown. Look up the same operation ID.'],
    'storage-conflict': ['대상 파일 또는 폴더가 충돌합니다. 원본과 대상 자료를 보존하고 확인해 주세요.', 'Destination files or folders conflict. Preserve and review both locations.'],
    'evidence-conflict': ['대상 증거 파일이 충돌합니다. 자료를 덮어쓰지 않고 확인해 주세요.', 'Destination evidence conflicts. Review without overwriting files.'],
    'storage-ownership-unknown': ['대상 폴더의 소유권을 확인하지 못했습니다.', 'Destination ownership is unconfirmed.'],
    'plan-stale': ['설정 개정이 달라졌습니다. 현재 설정을 조회하고 새 미리보기를 확인해 주세요.', 'The settings revision changed. Reload settings and review a new preview.'],
    'source-changed': ['미리보기 이후 자료가 바뀌었습니다. 새 미리보기를 확인해 주세요.', 'Materials changed after preview. Review a new preview.'],
    'invalid-storage-response': ['응답의 프로젝트, 개정 또는 원본 보존을 확인하지 못했습니다.', 'The response project, revision, or original preservation is unconfirmed.'],
    'pending-save-failed': ['작업 ID를 보존하지 못해 이전을 시작하지 않았습니다.', 'Migration was not started because the operation ID could not be retained.'],
    'pending-record-invalid': ['보존된 작업 ID 기록을 검증하지 못했습니다. 기록을 유지하고 자료 이전을 제한합니다.', 'The retained operation record could not be validated. It is preserved and migration is restricted.'],
  };
  const translated = labels[value.code];
  return `${value.code} · ${translated ? text(...translated) : text(value.message ?? '자료 이전을 완료하지 못했습니다.', 'Material migration could not be completed.')}${value.nextAction ? ` ${text(value.nextAction, 'Review the service diagnostic and preserve existing files.')}` : ''}`;
}
async function request<T>(scope: Scope, method: ApiMethod, input: Record<string, unknown>, requestId?: string): Promise<T> {
  const response = await scope.bridge.request(method, input, requestId);
  if (!response.ok) throw response.error;
  if (requestId && response.requestId !== requestId) throw { code: 'invalid-storage-response' };
  return response.data as T;
}
function sameScope(left: Scope | null, right: Scope): boolean {
  return !!left && left.projectId === right.projectId && left.connectionKey === right.connectionKey
    && left.generation === right.generation && left.bridge === right.bridge;
}

export function ProjectStorageFolder(props: Props) {
  useLanguage();
  const bridge = window.checkmate;
  const scope: Scope | null = props.available && props.supported && props.projectId && bridge
    ? { projectId: props.projectId, connectionKey: props.connectionKey, generation: props.generation, bridge } : null;
  const current = useRef<Scope | null>(scope); current.current = scope;
  const callbacks = useRef(props); callbacks.current = props;
  const [retained] = useState(readPending);
  const pending = useRef(retained.operations);
  const localBusy = useRef(false);
  const loadSequence = useRef(0);
  const [phase, setPhase] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [, redraw] = useState(0);
  const visible = scope && view && sameScope(scope, view.scope) ? view : null;
  const key = operationKey(props.connectionKey, props.projectId);
  const operation = pending.current[key];
  const blocked = retained.corrupt || unresolved(operation);
  const disabled = props.disabled || !!phase || blocked;

  function save(value: FrozenOperation) {
    const updated = { ...pending.current, [operationKey(value.connectionKey, value.projectId)]: value };
    writePending(updated);
    pending.current = updated; redraw(count => count + 1);
  }
  function updateOperation(value: FrozenOperation) {
    pending.current = { ...pending.current, [operationKey(value.connectionKey, value.projectId)]: value };
    try { writePending(pending.current); } catch { /* 시작 전에 보존한 작업 ID와 메모리를 유지한다. */ }
    redraw(count => count + 1);
  }
  function showProblem(captured: Scope, error: unknown) {
    if (!sameScope(current.current, captured)) return;
    setView(previous => ({ scope: captured, settings: previous && sameScope(previous.scope, captured) ? previous.settings : null,
      preview: null, problem: problem(error) })); setConfirmed(false);
  }
  async function load(captured: Scope) {
    const sequence = ++loadSequence.current;
    try {
      const settings = await request<ProjectStorageSettings>(captured, 'project-storage', { projectId: captured.projectId });
      if (!sameScope(current.current, captured) || sequence !== loadSequence.current) return;
      if (settings.projectId !== captured.projectId) throw { code: 'invalid-storage-response' };
      setView({ scope: captured, settings, preview: null, problem: null });
    } catch (error) { if (sequence === loadSequence.current) showProblem(captured, error); }
  }
  useEffect(() => {
    setConfirmed(false); setView(null);
    if (scope) void load(scope);
  }, [props.projectId, props.connectionKey, props.generation, props.available, props.supported, bridge]);

  async function preview(defaultRoot: boolean) {
    if (!scope || !visible?.settings || disabled || localBusy.current) return;
    const captured = scope, settings = visible.settings;
    ++loadSequence.current; localBusy.current = true; setPhase('preview'); setConfirmed(false);
    setView({ scope: captured, settings, preview: null, problem: null });
    try {
      const root = defaultRoot ? null : await captured.bridge.chooseDirectory('project-storage');
      if (!sameScope(current.current, captured) || (!defaultRoot && root === null)) return;
      const value = await request<ProjectStoragePreview>(captured, 'preview-project-storage',
        { projectId: captured.projectId, root, expectedRevision: settings.revision });
      if (!sameScope(current.current, captured)) return;
      if (value.projectId !== captured.projectId || value.expectedRevision !== settings.revision
        || value.currentRoot !== settings.configuredRoot || value.targetRoot !== root || value.originalsPreserved !== true) throw { code: 'invalid-storage-response' };
      setView({ scope: captured, settings, preview: value, problem: null });
    } catch (error) { showProblem(captured, error); }
    finally { localBusy.current = false; setPhase(''); }
  }
  function complete(captured: Scope, frozen: FrozenOperation, value: ProjectStorageApplied) {
    if (value.operationId !== frozen.operationId || value.settings.projectId !== frozen.projectId
      || value.settings.revision !== frozen.input.expectedRevision + 1 || value.originalsPreserved !== true) throw { code: 'invalid-storage-response' };
    const { error: previousError, ...retained } = frozen;
    void previousError;
    updateOperation({ ...retained, state: 'completed', result: value });
    if (!sameScope(current.current, captured)) return;
    setView({ scope: captured, settings: value.settings, preview: null, problem: null }); setConfirmed(false);
    callbacks.current.onApplied(captured.projectId, captured.connectionKey);
  }
  async function apply() {
    if (!scope || !visible?.preview || !confirmed || disabled || localBusy.current) return;
    const captured = scope, reviewed = visible.preview;
    const frozen: FrozenOperation = { projectId: captured.projectId, connectionKey: captured.connectionKey, generation: captured.generation,
      operationId: crypto.randomUUID(), state: 'unknown', input: Object.freeze({ projectId: captured.projectId, previewId: reviewed.previewId,
        expectedRevision: reviewed.expectedRevision, fingerprint: reviewed.fingerprint, confirm: true as const }) };
    if (!callbacks.current.acquire()) return;
    ++loadSequence.current; localBusy.current = true; setPhase('apply');
    try {
      try { save(frozen); } catch { throw { code: 'pending-save-failed' }; }
      setConfirmed(false); setView({ ...visible, preview: null, problem: null });
      const result = await request<ProjectStorageApplied>(captured, 'apply-project-storage', frozen.input, frozen.operationId);
      complete(captured, frozen, result);
    } catch (error) {
      if (pending.current[operationKey(frozen.connectionKey, frozen.projectId)]?.operationId === frozen.operationId) {
        updateOperation({ ...frozen, state: 'unknown', error: problem(error).code });
      }
      showProblem(captured, error);
    } finally { localBusy.current = false; setPhase(''); callbacks.current.release(); }
  }
  async function checkOperation() {
    if (!scope || !operation || localBusy.current || props.disabled) return;
    const captured = scope, frozen = operation;
    localBusy.current = true; setPhase('status');
    try {
      const value = await request<ProjectStorageOperation>(captured, 'project-storage-operation',
        { projectId: frozen.projectId, operationId: frozen.operationId });
      if (value.projectId !== frozen.projectId || value.operationId !== frozen.operationId
        || !['not-found', 'copying', 'completed', 'failed', 'unknown'].includes(value.state)) throw { code: 'invalid-storage-response' };
      if (value.state === 'completed') {
        if (!value.result) throw { code: 'invalid-storage-response' };
        complete(captured, frozen, value.result);
      } else {
        updateOperation({ ...frozen, state: value.state, ...(value.error ? { error: value.error } : {}) });
        if (value.state === 'failed') showProblem(captured, { code: value.error ?? 'storage-error' });
      }
    } catch (error) { showProblem(captured, error); }
    finally { localBusy.current = false; setPhase(''); }
  }
  const operationLabels: Record<ProjectStorageOperation['state'], [string, string]> = {
    'not-found': ['기록 미확인', 'Record unconfirmed'], copying: ['복사 중', 'Copying'], completed: ['이전 완료', 'Migration completed'],
    failed: ['이전 실패', 'Migration failed'], unknown: ['상태 미확인', 'State unknown'],
  };
  const settings = visible?.settings;
  return <section className="panel project-storage-panel" data-testid="project-storage-panel">
    <div className="panel-heading"><div><h2>{text('프로젝트 검사 자료 폴더', 'Project check materials folder')}</h2>
      <p>{text('선택 프로젝트의 모든 작업 폴더에 적용됩니다. 기존 검사 자료도 미리보기 확인 후 함께 이전합니다.', 'Applies to every worktree of the selected project. Existing check materials migrate after preview and confirmation.')}</p></div></div>
    {!props.projectId ? <p>{text('위쪽 선택기에서 프로젝트를 선택해 주세요.', 'Choose a project from the selector above.')}</p>
      : !props.supported ? <p data-testid="project-storage-unavailable" className="next-action">{text('연결된 서비스가 프로젝트 자료 폴더 변경을 지원하지 않습니다. 기존 기능은 계속 사용할 수 있습니다.', 'The connected service does not support changing project materials folders. Existing features remain available.')}</p>
      : <><p><strong>{props.projectName}</strong></p>
        {settings && <dl className="detail-grid storage-details">
          <div><dt>{text('현재 출력 폴더', 'Current output folder')}</dt><dd className="path-line" data-testid="storage-current">{settings.configuredRoot ?? settings.defaultRunsRoot}</dd></div>
          <div><dt>{text('기본 출력 폴더', 'Default output folder')}</dt><dd className="path-line" data-testid="storage-default">{settings.defaultRunsRoot}</dd></div>
          <div><dt>{text('개정', 'Revision')}</dt><dd data-testid="storage-revision">{settings.revision}</dd></div>
          <div><dt>{text('이름 공간', 'Namespace')}</dt><dd className="path-line">{settings.namespaceId ?? text('기본 저장 위치', 'Default storage location')}</dd></div>
        </dl>}
        {!settings && !visible?.problem && <p role="status">{text('현재 설정을 조회하는 중입니다.', 'Loading current settings.')}</p>}
        <div className="detail-actions"><button type="button" className="secondary" data-testid="storage-choose" disabled={disabled || !settings} onClick={() => void preview(false)}>{text('폴더 선택과 이전 미리보기', 'Choose folder and preview migration')}</button>
          <button type="button" className="secondary" data-testid="storage-reset" disabled={disabled || !settings || settings.configuredRoot === null} onClick={() => void preview(true)}>{text('기본 폴더 복귀 미리보기', 'Preview return to default folder')}</button>
          <button type="button" className="text-button" data-testid="storage-refresh" disabled={disabled || !scope} onClick={() => { if (scope) { setConfirmed(false); void load(scope); } }}>{text('현재 설정 조회', 'Reload current settings')}</button></div>
        {visible?.preview && <div className="approval-scope" data-testid="storage-preview">
          <h3>{text('기존 자료와 함께 이전', 'Migrate existing materials together')}</h3>
          <dl className="detail-grid storage-details"><div><dt>{text('대상 위치', 'Destination')}</dt><dd className="path-line" data-testid="storage-destination">{visible.preview.destinationRoot}</dd></div>
            <div><dt>{text('대상 실행', 'Runs')}</dt><dd>{visible.preview.runCount}</dd></div><div><dt>{text('대상 파일', 'Files')}</dt><dd>{visible.preview.fileCount}</dd></div>
            <div><dt>{text('자료 크기', 'Size')}</dt><dd>{visible.preview.byteLength.toLocaleString()} byte</dd></div></dl>
          <p>{text('이전은 자료를 복사하며 원본을 보존합니다. 충돌하거나 실행·정리가 확인되지 않으면 중단하며 자동으로 반복하지 않습니다.', 'Migration copies materials and preserves originals. Conflicts or unconfirmed run and cleanup states stop migration without automatic retries.')}</p>
          <details className="technical-detail"><summary>{text('이전 지문과 미리보기 ID', 'Migration fingerprint and preview ID')}</summary>
            <p className="path-line"><code>{visible.preview.fingerprint}</code></p><p className="path-line"><code>{visible.preview.previewId}</code></p></details>
          <label className="checkline"><input type="checkbox" data-testid="storage-confirm" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />{text('위 위치와 자료 범위, 원본 보존 및 모든 작업 폴더에 적용됨을 확인했습니다.', 'I reviewed the destination, material scope, original preservation, and application to all worktrees.')}</label>
          <div className="detail-actions"><button className="primary" type="button" data-testid="storage-apply" disabled={!confirmed || disabled} onClick={() => void apply()}>{text('자료 이전과 폴더 변경 확정', 'Confirm migration and folder change')}</button>
            <button type="button" className="secondary" data-testid="storage-cancel" disabled={!!phase} onClick={() => { setConfirmed(false); setView({ ...visible, preview: null }); }}>{text('미리보기 취소', 'Cancel preview')}</button></div>
        </div>}
        {phase && <p role="status">{phase === 'apply' ? text('자료 이전을 확정하는 중입니다. 입력과 프로젝트 변경을 잠시 제한합니다.', 'Confirming migration. Inputs and project changes are temporarily locked.') : text('요청 결과를 확인하는 중입니다.', 'Checking the request result.')}</p>}
        {visible?.problem && <p className="notice" role="alert" data-testid="storage-error">{problemText(visible.problem)}</p>}
        {retained.corrupt && <p className="notice" role="alert" data-testid="storage-pending-invalid">{problemText({ code: 'pending-record-invalid' })}</p>}
        {operation && <div className="storage-operation" data-testid="storage-operation" role="status">
          <p><strong>{text(...operationLabels[operation.state])}</strong> · <code data-testid="storage-operation-id">{operation.operationId}</code></p>
          {operation.error && <p>{problemText({ code: operation.error })}</p>}
          {operation.state === 'completed' ? <p data-testid="storage-success">{text('원본은 보존됐습니다. 기존 계획은 무효이므로 새 계획을 확인하고 다시 승인해 주세요.', 'Originals were preserved. Existing plans are invalid; review and approve a new plan.')}</p>
            : <><p>{text('동일 작업 ID의 읽기 전용 상태 조회만 제공합니다. 프로젝트나 연결을 바꿔도 ID를 보존하며 자동 재복사하지 않습니다.', 'Only a read-only lookup of this operation ID is offered. The ID survives project and connection changes; copying is never retried automatically.')}</p>
              <button type="button" className="secondary" data-testid="storage-check-operation" disabled={!!phase || props.disabled || !scope} onClick={() => void checkOperation()}>{text('동일 작업 상태 확인', 'Check the same operation')}</button></>}
        </div>}
      </>}
  </section>;
}
