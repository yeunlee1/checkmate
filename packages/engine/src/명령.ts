#!/usr/bin/env node
// 체크메이트의 환경 진단과 읽기 전용 결과 파일 검사를 제공한다.
import { Command, CommanderError } from 'commander';
import { ReportError, validateReport } from './보고서.js';

const program = new Command();
let jsonMode = false;
const write = (data: unknown, message: string) => {
  process.stdout.write(jsonMode ? `${JSON.stringify({ apiVersion: 1, ok: true, data })}\n` : `${message}\n`);
};

program.name('checkmate').description('체크메이트 검증 도구의 초기 개발판').version('0.1.0-alpha.1')
  .option('--json', 'JSON 결과를 출력한다.')
  .exitOverride()
  .configureOutput({ writeErr: () => {} });
program.hook('preAction', () => { jsonMode = program.opts().json === true; });

program.command('doctor').description('현재 실행 환경과 구현 범위를 확인한다.').action(() => {
  const supportedRuntime = Number(process.versions.node.split('.')[0]) === 24;
  write({
    version: program.version(),
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    supportedRuntime,
    stage: 'foundation',
    capabilities: ['report-validation'],
    unavailable: ['project-runs', 'database', 'mcp', 'desktop', 'installer'],
  }, `체크메이트 초기 개발판. Node ${process.versions.node}. 결과 파일 검사 가능. 프로젝트 실행·DB·MCP·화면·설치본은 아직 제공하지 않습니다.`);
  process.exitCode = supportedRuntime ? 0 : 3;
});

program.command('report').description('저장된 결과 파일을 검사한다.')
  .command('validate <file>').description('결과의 형식과 판정 조건을 검사한다. 실제 증거의 인증은 아니다.')
  .action(async (file: string) => {
    const result = await validateReport(file);
    write(result, `결과 형식과 판정 조건이 일치합니다. 기록된 판정 ${result.reportedVerdict ?? '진행 중'}. 실제 실행 증거를 인증한 결과는 아닙니다.`);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const known = error instanceof ReportError;
    const code = known ? error.code : error instanceof CommanderError ? 'invalid-input' : 'internal-error';
    const message = known ? error.message : error instanceof CommanderError ? '명령과 인자를 확인해 주세요.' : '명령을 처리하지 못했습니다.';
    process.exitCode = known ? error.exitCode : error instanceof CommanderError ? 2 : 5;
    jsonMode = jsonMode || process.argv.includes('--json');
    const response = { apiVersion: 1, ok: false, error: { code, message, retryable: false, nextAction: '입력과 사용법을 확인해 주세요.' } };
    if (jsonMode) process.stdout.write(`${JSON.stringify(response)}\n`);
    else process.stderr.write(`${message}\n`);
  }
}
