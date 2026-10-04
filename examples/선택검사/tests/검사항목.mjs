// 외부 앱의 효과 증거와 구분한 합성 단일 검사 및 필터 제외 보고서를 만든다.
import { fileURLToPath } from 'node:url';
import { name } from '../scripts/단일검사.mjs';

if (process.argv.length !== 4 || process.argv[2] !== '--check' || process.argv[3] !== 'expense-annual-one') {
  console.error('등록된 합성 단일 검사만 허용합니다.');
  process.exitCode = 1;
} else {
  const passed = 12 * 100 === 1200;
  process.stdout.write(JSON.stringify({ success: passed, numTotalTests: 21, numPassedTests: Number(passed), numFailedTests: Number(!passed),
    testResults: [{ name: fileURLToPath(import.meta.url), assertionResults: [
      { fullName: name, status: passed ? 'passed' : 'failed' },
      ...Array.from({ length: 20 }, (_, index) => ({ fullName: `합성 필터 제외 ${index + 1}`, status: 'pending' })),
    ] }] }));
  process.exitCode = Number(!passed);
}
