// 실제 브라우저의 명시적 화면 규칙과 접근성 위반 위치를 검사한다.
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';

export type CheckStatus = 'passed' | 'failed' | 'unverified';
export type BrowserBox = { x: number; y: number; width: number; height: number };
export type BrowserViewport = { width: number; height: number };

export type DesignRule = {
  id: string;
  selector: string;
  expectedCount?: number;
  visible?: boolean;
  allowedStyles?: Record<string, readonly string[]>;
  fitViewport?: boolean;
};

export type DesignFinding = {
  ruleId: string;
  selector: string;
  status: CheckStatus;
  expected: { count: number; visible?: boolean; allowedStyles?: Record<string, readonly string[]>; fitViewport?: boolean };
  observed: { count: number; visible: boolean | null; styles: Record<string, string>; overflowsViewport: boolean | null };
  boundingBox: BrowserBox | null;
  viewport: BrowserViewport | null;
  reason: string | null;
};

export type DesignResult = { status: CheckStatus; findings: DesignFinding[] };

export async function checkBrowserDesign(page: Page, rules: readonly DesignRule[]): Promise<DesignResult> {
  if (rules.length === 0) return { status: 'unverified', findings: [] };
  const findings: DesignFinding[] = [];
  for (const rule of rules) {
    const expected = {
      count: rule.expectedCount ?? 1,
      ...(rule.visible === undefined ? {} : { visible: rule.visible }),
      ...(rule.allowedStyles === undefined ? {} : { allowedStyles: rule.allowedStyles }),
      ...(rule.fitViewport === undefined ? {} : { fitViewport: rule.fitViewport }),
    };
    const observed: DesignFinding['observed'] = { count: 0, visible: null, styles: {}, overflowsViewport: null };
    const finding: DesignFinding = {
      ruleId: rule.id, selector: rule.selector, status: 'unverified', expected, observed,
      boundingBox: null, viewport: null, reason: null,
    };
    findings.push(finding);
    try {
      const locator = page.locator(rule.selector);
      observed.count = await locator.count();
      finding.viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (observed.count !== expected.count || observed.count !== 1) {
        finding.status = 'failed';
        finding.reason = observed.count === 0 ? '선택자 누락' : '선택자 개수 불일치 또는 중복';
        continue;
      }
      observed.visible = await locator.isVisible();
      finding.boundingBox = await locator.boundingBox();
      if (rule.allowedStyles) {
        const properties = Object.keys(rule.allowedStyles);
        observed.styles = await locator.evaluate((element, names) => {
          const style = getComputedStyle(element);
          return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
        }, properties);
      }
      if (rule.fitViewport) {
        const box = finding.boundingBox;
        const viewport = finding.viewport;
        observed.overflowsViewport = box && viewport
          ? box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height
          : null;
      }
      const visibilityFailed = rule.visible !== undefined && observed.visible !== rule.visible;
      const styleFailed = Object.entries(rule.allowedStyles ?? {}).some(([name, allowed]) =>
        !allowed.includes(observed.styles[name] ?? ''));
      const overflowFailed = rule.fitViewport === true && observed.overflowsViewport !== false;
      finding.status = visibilityFailed || styleFailed || overflowFailed ? 'failed' : 'passed';
      if (visibilityFailed) finding.reason = '보임 여부 불일치';
      else if (styleFailed) finding.reason = '허용 스타일 불일치';
      else if (overflowFailed) finding.reason = '뷰포트 경계 초과 또는 위치 확인 불가';
    } catch (error) {
      finding.status = 'unverified';
      finding.reason = error instanceof Error ? error.message : '브라우저 검사 실패';
    }
  }
  return { status: findings.some((item) => item.status === 'failed') ? 'failed'
    : findings.some((item) => item.status === 'unverified') ? 'unverified' : 'passed', findings };
}

export type AccessibilityFinding = {
  ruleId: string;
  impact: string | null;
  target: string[];
  boundingBox: BrowserBox | null;
  locationReason: string | null;
};
export type AccessibilityResult = {
  status: CheckStatus;
  violations: AccessibilityFinding[];
  incompleteRuleIds: string[];
  reason: string | null;
};

export async function checkAccessibility(page: Page): Promise<AccessibilityResult> {
  try {
    const report = await new AxeBuilder({ page }).analyze();
    const violations: AccessibilityFinding[] = [];
    for (const violation of report.violations) {
      for (const node of violation.nodes) {
        const target = node.target.map(String);
        let boundingBox: BrowserBox | null = null;
        let locationReason: string | null = null;
        if (target.length !== 1) {
          locationReason = 'iframe 또는 중첩 대상 위치 확인 불가';
        } else {
          try {
            const locator = page.locator(target[0]!);
            if (await locator.count() === 1) boundingBox = await locator.boundingBox();
            if (!boundingBox) locationReason = '대상이 숨겨졌거나 위치를 확인할 수 없음';
          } catch {
            locationReason = '지원되지 않는 대상 선택자';
          }
        }
        violations.push({ ruleId: violation.id, impact: node.impact ?? violation.impact ?? null,
          target, boundingBox, locationReason });
      }
    }
    const incompleteRuleIds = report.incomplete.map((item) => item.id);
    return { status: violations.length ? 'failed' : incompleteRuleIds.length ? 'unverified' : 'passed',
      violations, incompleteRuleIds, reason: incompleteRuleIds.length ? '자동 판정할 수 없는 접근성 항목이 있음' : null };
  } catch (error) {
    return { status: 'unverified', violations: [], incompleteRuleIds: [],
      reason: error instanceof Error ? error.message : '접근성 검사 실패' };
  }
}
