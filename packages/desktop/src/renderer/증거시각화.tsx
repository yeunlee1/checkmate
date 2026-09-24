// 검증된 화면 PNG와 디자인 검사 위치를 안전하게 비교 표시한다.
import { useState } from 'react';
import './증거시각화.css';

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
const labels: Record<Status, string> = { passed: '정상', failed: '실패', unverified: '미확인' };
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
  if (payload.length < 44 || payload.length > Math.ceil(8 * 1024 * 1024 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) return null;
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
  const [selected, setSelected] = useState<number | null>(null);
  const image = pngDimensions(imageDataUrl);
  const report = designEvidence === undefined ? null : parseDesignEvidence(designEvidence);
  const imageValid = image && image.width === imageWidth && image.height === imageHeight && uuid.test(screenshotEvidenceId);
  const reportValid = !report || (report.screenshotEvidenceId === screenshotEvidenceId
    && report.viewport.width === imageWidth && report.viewport.height === imageHeight);
  if (!imageValid || !reportValid || (designEvidence !== undefined && !report)) {
    return <section className="visual-evidence" aria-label="디자인 증거">
      <p className="visual-evidence__notice">캡처와 디자인 증거를 안전하게 연결할 수 없습니다. 일반 텍스트 증거 조회에서 원본을 확인해 주세요.</p>
    </section>;
  }
  const activeIndex = report && selected !== null && selected < report.findings.length ? selected
    : report?.findings.findIndex((item) => item.status === 'failed') ?? -1;
  const active = report?.findings[activeIndex] ?? null;
  const boxValue = active?.status === 'failed' ? active.boundingBox : null;
  const visibleBox = boxValue && boxValue.width > 0 && boxValue.height > 0
    && boxValue.x < imageWidth && boxValue.y < imageHeight
    && boxValue.x + boxValue.width > 0 && boxValue.y + boxValue.height > 0;
  return <section className="visual-evidence" aria-label="디자인 증거">
    <div className="visual-evidence__heading">
      <div><h3>화면 증거</h3><p>검증된 PNG · {imageWidth} × {imageHeight}</p></div>
      {report && <span className={`visual-evidence__status visual-evidence__status--${report.status}`}>
        전체 {labels[report.status]}</span>}
    </div>
    <div className="visual-evidence__layout">
      <figure className="visual-evidence__figure">
        <div className="visual-evidence__image" style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}>
          <img src={imageDataUrl} width={imageWidth} height={imageHeight} alt="검사 당시 화면 캡처" />
          {visibleBox && <span className="visual-evidence__box" aria-hidden="true" style={{
            left: `${100 * boxValue.x / imageWidth}%`, top: `${100 * boxValue.y / imageHeight}%`,
            width: `${100 * boxValue.width / imageWidth}%`, height: `${100 * boxValue.height / imageHeight}%`,
          }} />}
        </div>
        <figcaption>{visibleBox ? `선택한 실패 위치 · ${active?.ruleId}`
          : active?.status === 'failed' ? '위치 미확인 또는 화면 밖' : '선택한 실패 위치가 없습니다.'}</figcaption>
      </figure>
      {report && <div className="visual-evidence__findings">
        <h4>디자인 검사 {report.findings.length}개</h4>
        {report.findings.length === 0 && <p>표시할 검사 결과가 없습니다.</p>}
        <div className="visual-evidence__list" aria-label="디자인 검사 목록">
          {report.findings.map((item, index) => <button key={`${item.ruleId}-${index}`} type="button"
            className="visual-evidence__choice" aria-pressed={activeIndex === index}
            onClick={() => setSelected(index)}>
            <strong>{item.ruleId}</strong><span>{labels[item.status]}</span>
          </button>)}
        </div>
        {active && <div className="visual-evidence__detail" aria-live="polite">
          <p><b>상태</b> {labels[active.status]}</p>
          <p><b>선택자</b> <code>{active.selector}</code></p>
          <p><b>이유</b> {active.reason ?? '기록 없음'}</p>
          <p><b>위치</b> {active.boundingBox ? visibleBox ? '캡처에 표시됨' : '위치 미확인 또는 화면 밖' : '위치 미확인'}</p>
          <div><b>기대</b><pre>{details(active.expected)}</pre></div>
          <div><b>관측</b><pre>{details(active.observed)}</pre></div>
        </div>}
      </div>}
    </div>
  </section>;
}
