// 검증된 화면 PNG와 디자인 검사 위치를 안전하게 비교 표시한다.
import { useState } from 'react';
import './증거시각화.css';
import { useLanguage, text } from './언어.js';

type Viewport = { width: number; height: number };
type Box = { x: number; y: number; width: number; height: number };
type Status = 'passed' | 'failed' | 'unverified';
type Finding = { ruleId: string; selector: string; status: Status;
  expected: { count: number; visible?: boolean; allowedStyles?: Record<string, string[]>; fitViewport?: boolean };
  observed: { count: number; visible: boolean | null; styles: Record<string, string>;
    overflowsViewport: boolean | null }; boundingBox: Box | null; viewport: Viewport | null; reason: string | null };
export type DesignEvidence = { kind: 'checkmate-design'; schemaVersion: 1; screenshotEvidenceId: string;
  viewport: Viewport; status: Status; findings: Finding[] };
export type VisualEvidenceProps = { imageDataUrl: string; imageWidth: number; imageHeight: number;
  screenshotEvidenceId: string; designEvidence?: unknown };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses: Status[] = ['passed', 'failed', 'unverified'];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function shortText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length <= max;
}
function positiveInt(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
}
function viewport(value: unknown): value is Viewport {
  return object(value) && keys(value, ['width', 'height'])
    && positiveInt(value.width, 8192) && positiveInt(value.height, 8192)
    && value.width * value.height <= 16 * 1024 * 1024;
}
function box(value: unknown): value is Box {
  return object(value) && keys(value, ['x', 'y', 'width', 'height'])
    && [value.x, value.y, value.width, value.height].every((number) => typeof number === 'number'
      && Number.isFinite(number) && Math.abs(number) <= 32768)
    && (value.width as number) >= 0 && (value.height as number) >= 0;
}
function stringMap(value: unknown): value is Record<string, string> {
  return object(value) && Object.keys(value).length <= 32
    && Object.entries(value).every(([key, entry]) => key.length <= 100 && shortText(entry, 256));
}
function allowedStyles(value: unknown): value is Record<string, string[]> {
  return object(value) && Object.keys(value).length <= 32
    && Object.entries(value).every(([key, entry]) => key.length <= 100 && Array.isArray(entry)
      && entry.length <= 16 && entry.every((item) => shortText(item, 256)));
}
function finding(value: unknown, expectedViewport: Viewport): value is Finding {
  if (!object(value) || !keys(value, ['ruleId', 'selector', 'status', 'expected', 'observed',
    'boundingBox', 'viewport', 'reason']) || !shortText(value.ruleId, 160) || !value.ruleId
    || !shortText(value.selector) || !statuses.includes(value.status as Status)
    || !object(value.expected) || !keys(value.expected, ['count', 'visible', 'allowedStyles', 'fitViewport'])
    || !Number.isSafeInteger(value.expected.count) || (value.expected.count as number) < 0
    || (value.expected.count as number) > 10000
    || (value.expected.visible !== undefined && typeof value.expected.visible !== 'boolean')
    || (value.expected.fitViewport !== undefined && typeof value.expected.fitViewport !== 'boolean')
    || (value.expected.allowedStyles !== undefined && !allowedStyles(value.expected.allowedStyles))
    || !object(value.observed) || !keys(value.observed, ['count', 'visible', 'styles', 'overflowsViewport'])
    || !Number.isSafeInteger(value.observed.count) || (value.observed.count as number) < 0
    || (value.observed.count as number) > 10000
    || (value.observed.visible !== null && typeof value.observed.visible !== 'boolean')
    || !stringMap(value.observed.styles)
    || (value.observed.overflowsViewport !== null && typeof value.observed.overflowsViewport !== 'boolean')
    || (value.boundingBox !== null && !box(value.boundingBox))
    || (value.viewport !== null && (!viewport(value.viewport)
      || value.viewport.width !== expectedViewport.width || value.viewport.height !== expectedViewport.height))
    || (value.reason !== null && !shortText(value.reason, 2000))) return false;
  return true;
}

export function parseDesignEvidence(raw: unknown): DesignEvidence | null {
  try {
    if (typeof raw === 'string' && new TextEncoder().encode(raw).byteLength > 128 * 1024) return null;
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024
      || !keys(value, ['kind', 'schemaVersion', 'screenshotEvidenceId', 'viewport', 'status', 'findings'])
      || value.kind !== 'checkmate-design' || value.schemaVersion !== 1
      || typeof value.screenshotEvidenceId !== 'string' || !uuid.test(value.screenshotEvidenceId)
      || !viewport(value.viewport) || !statuses.includes(value.status as Status)
      || !Array.isArray(value.findings) || value.findings.length > 100
      || !value.findings.every((item) => finding(item, value.viewport as Viewport))) return null;
    return value as DesignEvidence;
  } catch { return null; }
}

function pngDimensions(url: string): Viewport | null {
  const prefix = 'data:image/png;base64,';
  if (!url.startsWith(prefix)) return null;
  const payload = url.slice(prefix.length);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  if (payload.length < 44 || payload.length % 4 !== 0
    || payload.length / 4 * 3 - padding > 8 * 1024 * 1024) return null;
  for (let index = 0; index < payload.length - padding; index++) {
    const char = payload.charCodeAt(index);
    if (!((char >= 65 && char <= 90) || (char >= 97 && char <= 122)
      || (char >= 48 && char <= 57) || char === 43 || char === 47)) return null;
  }
  try {
    const header = atob(payload.slice(0, 44));
    if (header.length < 29 || header.slice(0, 8) !== '\x89PNG\r\n\x1a\n'
      || header.slice(8, 16) !== '\x00\x00\x00\x0dIHDR') return null;
    const number = (offset: number) => ((header.charCodeAt(offset) * 0x1000000)
      + (header.charCodeAt(offset + 1) << 16) + (header.charCodeAt(offset + 2) << 8)
      + header.charCodeAt(offset + 3));
    const result = { width: number(16), height: number(20) };
    return viewport(result) ? result : null;
  } catch { return null; }
}

function details(value: Finding['expected'] | Finding['observed']): string {
  return JSON.stringify(value, null, 2);
}

export function VisualEvidence({ imageDataUrl, imageWidth, imageHeight, screenshotEvidenceId,
  designEvidence }: VisualEvidenceProps) {
  useLanguage();
  const [selected, setSelected] = useState<number | null>(null);
  const labels: Record<Status, string> = {
    passed: text('정상', 'Passed'), failed: text('실패', 'Failed'),
    unverified: text('확인 필요', 'Needs review'),
  };
  const image = pngDimensions(imageDataUrl);
  const report = designEvidence === undefined ? null : parseDesignEvidence(designEvidence);
  const imageValid = image && image.width === imageWidth && image.height === imageHeight && uuid.test(screenshotEvidenceId);
  const reportValid = !report || (report.screenshotEvidenceId === screenshotEvidenceId
    && report.viewport.width === imageWidth && report.viewport.height === imageHeight);
  if (!imageValid || !reportValid || (designEvidence !== undefined && !report)) {
    return <section className="visual-evidence" aria-label={text('화면 증거', 'Screen evidence')}>
      <p className="visual-evidence__notice">{text('캡처와 디자인 증거를 안전하게 연결할 수 없습니다. 일반 텍스트 증거 조회에서 원본을 확인해 주세요.',
        'The screenshot and design evidence could not be linked safely. Review the original in the text evidence view.')}</p>
    </section>;
  }
  const activeIndex = report && selected !== null && selected < report.findings.length ? selected
    : report?.findings.findIndex((item) => item.status === 'failed') ?? -1;
  const active = report?.findings[activeIndex] ?? null;
  const boxValue = active?.status === 'failed' ? active.boundingBox : null;
  const visibleBox = boxValue && boxValue.width > 0 && boxValue.height > 0
    && boxValue.x < imageWidth && boxValue.y < imageHeight
    && boxValue.x + boxValue.width > 0 && boxValue.y + boxValue.height > 0;
  return <section className="visual-evidence" aria-label={text('화면 증거', 'Screen evidence')}>
    <div className="visual-evidence__heading">
      <div><h3>{text('화면 증거', 'Screen evidence')}</h3><p>{text('검증된 PNG', 'Verified PNG')} · {imageWidth} × {imageHeight}</p></div>
      {report && <span className={`visual-evidence__status visual-evidence__status--${report.status}`}>
        {text('전체', 'Overall')} {labels[report.status]}</span>}
    </div>
    <div className="visual-evidence__layout">
      <figure className="visual-evidence__figure">
        <div className="visual-evidence__image" style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}>
          <img src={imageDataUrl} width={imageWidth} height={imageHeight} alt={text('검사 당시 화면 캡처', 'Screenshot captured during the check')} />
          {visibleBox && <span className="visual-evidence__box" aria-hidden="true" style={{
            left: `${100 * boxValue.x / imageWidth}%`, top: `${100 * boxValue.y / imageHeight}%`,
            width: `${100 * boxValue.width / imageWidth}%`, height: `${100 * boxValue.height / imageHeight}%`,
          }} />}
        </div>
        <figcaption>{visibleBox ? `${text('선택한 실패 위치', 'Selected failure location')} · ${active?.ruleId}`
          : active?.status === 'failed' ? text('위치를 확인할 수 없거나 화면 밖에 있습니다.', 'The location is unverified or outside the screenshot.')
            : text('선택한 실패 위치가 없습니다.', 'No failure location is selected.')}</figcaption>
      </figure>
      {report && <div className="visual-evidence__findings">
        <h4>{text(`디자인 검사 ${report.findings.length}개`, `${report.findings.length} design check(s)`)}</h4>
        <p className="visual-evidence__hint">{text('검사 항목을 고르면 캡처의 실패 위치와 기록된 값을 볼 수 있습니다.',
          'Select a check to see its failure location and recorded values.')}</p>
        {report.findings.length === 0 && <p>{text('표시할 검사 결과가 없습니다.', 'There are no check results to show.')}</p>}
        <div className="visual-evidence__list" aria-label={text('디자인 검사 목록', 'Design check list')}>
          {report.findings.map((item, index) => <button key={`${item.ruleId}-${index}`} type="button"
            className="visual-evidence__choice" aria-pressed={activeIndex === index}
            onClick={() => setSelected(index)}>
            <strong>{item.ruleId}</strong><span>{labels[item.status]}</span>
          </button>)}
        </div>
        {active && <div className="visual-evidence__detail" aria-live="polite">
          <p><b>{text('상태', 'Status')}</b> {labels[active.status]}</p>
          <p><b>{text('선택자', 'Selector')}</b> <code>{active.selector}</code></p>
          <p className="visual-evidence__hint">{text('선택자는 화면에서 검사한 요소를 찾는 규칙입니다.',
            'A selector identifies the screen element that was checked.')}</p>
          <p><b>{text('이유', 'Reason')}</b> {active.reason ?? text('기록 없음', 'Not recorded')}</p>
          <p><b>{text('위치', 'Location')}</b> {active.boundingBox ? visibleBox
            ? text('캡처에 표시됨', 'Shown on the screenshot')
            : text('위치 미확인 또는 화면 밖', 'Location unverified or outside the screenshot')
            : text('위치 미확인', 'Location unverified')}</p>
          <div><b>{text('기대', 'Expected')}</b><pre>{details(active.expected)}</pre></div>
          <div><b>{text('관측', 'Observed')}</b><pre>{details(active.observed)}</pre></div>
          <p className="visual-evidence__hint">{text('기대는 검사 기준이고 관측은 실제로 기록된 값입니다. 원본 값은 그대로 표시합니다.',
            'Expected is the check criterion; observed is the recorded value. Original values are shown as recorded.')}</p>
        </div>}
      </div>}
    </div>
  </section>;
}
