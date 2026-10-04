// 합성 연간 검사 한 개만 실행하고 동결한 단일 검사 결과의 선택 계약을 검증한다.
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from '@checkmate/engine/reporter';

export const checkId = 'expense-annual-one';
export const file = 'tests/unit/고정지출.test.ts';
export const name = '고정지출 연간 예상액 월말 회차를 재사용해 첫 납부일부터 다음해 같은 날짜 직전까지 계산한다';

function validateSelected(report, exitCode, expectedFile) {
  if (!report || typeof report.success !== 'boolean' || report.testResults?.length !== 1) throw new Error('시험 파일 수 또는 보고서 형식 불일치');
  const item = report.testResults[0];
  if (resolve(item.name) !== expectedFile || !Array.isArray(item.assertionResults)) throw new Error('시험 파일 신원 불일치');
  const selected = item.assertionResults.filter(value => value.fullName === name);
  if (selected.length !== 1 || !['passed', 'failed'].includes(selected[0].status)) throw new Error('선택 시험 중복 또는 미실행');
  if (item.assertionResults.length !== 21 || item.assertionResults.some(value => value.fullName !== name && !['skipped', 'pending', 'todo'].includes(value.status)))
    throw new Error('계획 밖 시험 실행 또는 필터 제외 수 불일치');
  const passed = selected[0].status === 'passed';
  if (report.numTotalTests !== 21 || report.numPassedTests !== Number(passed) || report.numFailedTests !== Number(!passed)
    || report.success !== passed || exitCode !== Number(!passed)) throw new Error('시험 결과와 프로세스 종료 불일치');
  return { status: selected[0].status, selected: 1, excluded: 20 };
}

// 외부의 기존 결과만 읽는 함수이며 외부 시험을 실행하지 않는다.
export function selectedResult(report, exitCode, root) { return validateSelected(report, exitCode, resolve(root, file)); }

export function runSelected(id, spawn = spawnSync) {
  if (id !== checkId) throw new Error('등록된 단일 검사 ID가 아닙니다.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entry = resolve(root, 'tests/검사항목.mjs');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const result = spawn(process.execPath, [entry, '--check', checkId], { cwd: root, env, windowsHide: true,
    encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 });
  if (result.error || result.signal || result.status === null) throw new Error('합성 선택 검사 종료 미확인');
  const report = JSON.parse(result.stdout);
  return { ...validateSelected(report, result.status, entry), exitCode: result.status };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--check' || args[1] !== checkId)) throw new Error('등록된 단일 검사 인자만 허용합니다.');
  const reporter = createReporter();
  try {
    const selected = runSelected(checkId);
    reporter.caseResult({ testId: checkId, requirementId: 'req-expense-annual-one', status: selected.status,
      expected: '합성 단일 선택 계약의 1개 실행과 20개 필터 제외',
      observed: `합성 선택 ${selected.selected}개 ${selected.status}; 필터 제외 ${selected.excluded}개`,
      evidenceIds: [], severity: selected.status === 'passed' ? 'info' : 'error', location: null });
    process.exitCode = selected.exitCode;
  } catch {
    reporter.caseResult({ testId: checkId, requirementId: 'req-expense-annual-one', status: 'unknown',
      expected: '합성 단일 선택 결과와 종료 일치', observed: '선택 결과 또는 프로세스 종료를 확인하지 못했습니다.',
      evidenceIds: [], severity: 'error', location: null });
    process.exitCode = 1;
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
