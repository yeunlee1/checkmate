#!/usr/bin/env node
// 사람과 AI가 같은 로컬 서비스의 계획과 실행 및 결과를 사용하게 한다.
import { Command, CommanderError } from 'commander';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { apiRequestSchema, errorResponse, ServiceError } from '@checkmate/contracts/api';
import type { ApiMethod, ApiResponse } from '@checkmate/contracts/api';
import { ReportError, validateReport } from './보고서.js';
import { callService, initializeLocalStore } from './서비스/클라이언트.js';
import { startAgentServer } from './연결/에이아이서버.js';
import { exportRunHtml } from './서비스/보고서내보내기.js';

const program = new Command();
let jsonMode = false;
const write = (data: unknown, message: string) => {
  process.stdout.write(jsonMode ? `${JSON.stringify({ apiVersion: 1, ok: true, data })}\n` : `${message}\n`);
};

program.name('checkmate').description('사람과 AI가 함께 사용하는 로컬 검증 도구').version('0.1.0-alpha.1')
  .option('--json', 'JSON 결과를 출력한다.')
  .option('--data-dir <path>', '체크메이트 전용 자료 폴더를 지정한다.')
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
    stage: 'development',
    capabilities: ['report-validation', 'project-runs', 'database', 'mcp'],
    unavailable: ['installer'],
  }, `체크메이트 개발판. Node ${process.versions.node}. 프로젝트 계획·실행·증거 조회와 MCP를 제공합니다. 설치본은 별도 검증 단계입니다.`);
  process.exitCode = supportedRuntime ? 0 : 3;
});

program.command('report').description('저장된 결과 파일을 검사한다.')
  .command('validate <file>').description('결과의 형식과 판정 조건을 검사한다. 실제 증거의 인증은 아니다.')
  .action(async (file: string) => {
    const result = await validateReport(file);
    write(result, `결과 형식과 판정 조건이 일치합니다. 기록된 판정 ${result.reportedVerdict ?? '진행 중'}. 실제 실행 증거를 인증한 결과는 아닙니다.`);
  });

const clientOptions = () => program.opts().dataDir === undefined ? {} : { dataRoot: String(program.opts().dataDir) };
function exitForError(code: string): number {
  if (['invalid-input', 'invalid-project'].includes(code)) return 2;
  if (['needs-approval', 'needs-initialization', 'human-action-required'].includes(code)) return 3;
  if (['unsupported-version', 'service-update-required'].includes(code)) return 6;
  if (['plan-stale', 'catalog-stale', 'request-conflict', 'workspace-busy', 'project-conflict'].includes(code)) return 7;
  return 5;
}
async function invoke(method: ApiMethod, input: unknown, requestId: string = randomUUID()): Promise<ApiResponse> {
  return callService(apiRequestSchema.parse({ apiVersion: 1, requestId, method, input }), clientOptions());
}
function output(response: ApiResponse): void {
  process.stdout.write(`${JSON.stringify(response, null, jsonMode ? undefined : 2)}\n`);
  if (!response.ok) process.exitCode = exitForError(response.error.code);
}
const optionalPage = (opts: Record<string, unknown>) => ({ ...(opts.cursor === undefined ? {} : { cursor: String(opts.cursor) }), ...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }) });
program.command('setup').description('명시적 동의 후 전용 로컬 저장소를 준비한다.')
  .option('--accept-local-storage', '체크메이트 로컬 저장소 생성과 실행 이력 기록에 동의한다.')
  .action(async (opts: { acceptLocalStorage?: boolean }) => {
    if (!opts.acceptLocalStorage) throw new ServiceError('needs-approval', '로컬 저장소 생성과 기록에 대한 동의가 필요합니다.');
    await initializeLocalStore(clientOptions());
    write({ initialized: true }, '체크메이트 로컬 저장소를 준비했습니다.');
  });
program.command('capabilities').description('연결된 서비스의 자료 폴더와 제공 기능을 확인한다.')
  .action(async () => output(await invoke('capabilities', {})));
program.command('projects').option('--cursor <cursor>').option('--limit <count>').action(async (opts: Record<string, unknown>) => output(await invoke('projects', optionalPage(opts))));
program.command('register <path>').description('선택한 프로젝트의 검사 원본을 등록한다. 실행 승인은 별도다.')
  .option('--trust', '선택한 프로젝트 경로와 원본을 확인했다.')
  .action(async (path: string, opts: { trust?: boolean }) => {
    if (!opts.trust) throw new ServiceError('needs-approval', '선택한 프로젝트의 경로와 원본을 확인한 뒤 --trust로 등록해 주세요.');
    output(await invoke('register', { path }));
  });
program.command('checks').requiredOption('--project <id>').option('--cursor <cursor>').option('--limit <count>')
  .action(async (opts: Record<string, unknown>) => output(await invoke('checks', { projectId: opts.project, ...optionalPage(opts) })));
program.command('inspect').requiredOption('--project <id>').option('--profile <id>', '실행 프로필.', 'quick')
  .action(async (opts: { project: string; profile: string }) => output(await invoke('inspect', { projectId: opts.project, profile: opts.profile })));
program.command('approve').requiredOption('--plan <id>').requiredOption('--fingerprint <hash>').option('--confirm', '계획의 명령과 쓰기 범위를 확인했다.')
  .action(async (opts: { plan: string; fingerprint: string; confirm?: boolean }) => {
    if (!opts.confirm) throw new ServiceError('needs-approval', '계획의 명령과 쓰기 범위를 확인한 뒤 --confirm을 지정해 주세요.');
    output(await invoke('approve', { planId: opts.plan, fingerprint: opts.fingerprint }));
  });
program.command('run').requiredOption('--project <id>').requiredOption('--plan <id>').requiredOption('--request-id <id>').option('--wait', '최종 확정까지 기다린다.')
  .action(async (opts: { project: string; plan: string; requestId: string; wait?: boolean }) => {
    const admitted = await invoke('start', { projectId: opts.project, planId: opts.plan }, opts.requestId);
    if (!admitted.ok || !opts.wait) { output(admitted); return; }
    const { runId } = z.object({ runId: z.uuid() }).parse(admitted.data);
    for (;;) {
      const status = await invoke('status', { runId });
      if (!status.ok) { output(status); return; }
      if (z.object({ finalized: z.boolean() }).parse(status.data).finalized) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const result = await invoke('result', { runId, section: 'summary' });
    output(result);
    if (result.ok) {
      const final = z.object({ state: z.string(), effectiveVerdict: z.string().nullable() }).parse(result.data);
      process.exitCode = final.state === 'cancelled' ? 4 : final.effectiveVerdict === 'passed' ? 0 : final.effectiveVerdict === 'failed' ? 1 : final.effectiveVerdict === 'incomplete' ? 3 : 5;
    }
  });
program.command('status <run>').action(async (run: string) => output(await invoke('status', { runId: run })));
program.command('export <run>').description('확정 결과를 단일 HTML 보고서로 저장한다.')
  .requiredOption('--output <path>', '새 HTML 파일 경로. 기존 파일은 덮어쓰지 않는다.')
  .action(async (run: string, opts: { output: string }) => {
    const html = await exportRunHtml(invoke, run);
    const path = resolve(opts.output);
    await writeFile(path, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    write({ path, byteLength: Buffer.byteLength(html, 'utf8') }, `보고서를 저장했습니다. ${path}`);
  });
program.command('backup').description('현재 유휴 저장소와 증거를 함께 백업한다.').action(async () => output(await invoke('backup', {})));
program.command('restore <backup>').description('검증된 백업을 새 빈 폴더로 복구한다. 현재 자료는 유지한다.')
  .requiredOption('--target <path>', '새 빈 자료 폴더의 절대 경로.').option('--confirm', '복구 대상과 자료 생성을 확인한다.')
  .action(async (backup: string, opts: { target: string; confirm?: boolean }) => {
    if (!opts.confirm) throw new ServiceError('needs-approval', '복구 경로를 확인한 뒤 --confirm을 지정해 주세요.');
    output(await invoke('restore', { backupDirectory: backup, targetRoot: opts.target, confirm: true }));
  });
program.command('import-history <path>').description('아틀리에 과거 보고서의 안전 요약을 미확인 이력으로 가져온다.')
  .requiredOption('--project <id>').action(async (path: string, opts: { project: string }) => output(await invoke('import-history', { projectId: opts.project, path })));
program.command('result <run>').option('--section <name>', 'summary/cases/requirements/gaps/repair-bundle/imported.', 'summary').option('--cursor <cursor>').option('--limit <count>')
  .action(async (run: string, opts: Record<string, unknown>) => output(await invoke('result', { runId: run, section: opts.section, ...optionalPage(opts) })));
program.command('evidence-image <run> <evidence>').description('공개 PNG 증거를 검증한 뒤 제한된 base64 구간으로 조회한다.').option('--cursor <cursor>')
  .action(async (run: string, evidence: string, opts: { cursor?: string }) => output(await invoke('evidence-image', {
    runId: run, evidenceId: evidence, ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
  })));
program.command('evidence <run> <evidence>').option('--content', '허용된 본문을 조회한다.').option('--cursor <cursor>').option('--limit <bytes>')
  .action(async (run: string, evidence: string, opts: Record<string, unknown>) => output(await invoke('evidence', { runId: run, evidenceId: evidence, content: opts.content === true, ...optionalPage(opts) })));
program.command('cancel <run>').action(async (run: string) => output(await invoke('cancel', { runId: run })));
program.command('resources <run>').description('이 실행이 소유한 시험 DB와 정리 상태를 조회한다.').option('--cursor <cursor>').option('--limit <count>')
  .action(async (run: string, opts: Record<string, unknown>) => output(await invoke('resources', { runId: run, ...optionalPage(opts) })));
program.command('cleanup-resources <run>').description('중단된 실행의 소유권이 확인된 시험 DB만 제거한다. 과거 판정은 유지한다.')
  .option('--confirm', '선택한 실행의 시험 DB 제거를 확인했다.')
  .action(async (run: string, opts: { confirm?: boolean }) => {
    if (!opts.confirm) throw new ServiceError('needs-approval', 'resources로 대상 실행을 확인한 뒤 --confirm을 지정해 주세요.');
    output(await invoke('cleanup-resources', { runId: run, confirm: true }));
  });
program.command('acknowledge-cleanup <run>').description('사람이 실행 자원 정리를 확인한 기록을 남긴다. 과거 판정은 유지한다.')
  .requiredOption('--note <text>', '직접 확인한 정리 내용. 8자 이상 500자 이하.').option('--confirm', '해당 실행의 프로세스와 자료 정리를 직접 확인했다.')
  .action(async (run: string, opts: { note: string; confirm?: boolean }) => {
    if (!opts.confirm) throw new ServiceError('needs-approval', '실행 자원 정리를 확인한 뒤 --confirm을 지정해 주세요.');
    output(await invoke('acknowledge-cleanup', { runId: run, confirm: true, note: opts.note }));
  });
for (const method of ['history', 'gaps'] as const) program.command(method).requiredOption('--project <id>').option('--cursor <cursor>').option('--limit <count>')
  .action(async (opts: Record<string, unknown>) => output(await invoke(method, { projectId: opts.project, ...optionalPage(opts) })));
const catalog = program.command('catalog');
catalog.command('sync').requiredOption('--project <id>').action(async (opts: { project: string }) => output(await invoke('sync', { projectId: opts.project })));
catalog.command('activate').requiredOption('--project <id>').requiredOption('--hash <hash>').option('--confirm', '변경 비교와 기준 활성화를 확인했다.')
  .action(async (opts: { project: string; hash: string; confirm?: boolean }) => {
    if (!opts.confirm) throw new ServiceError('needs-approval');
    output(await invoke('activate', { projectId: opts.project, contentHash: opts.hash }));
  });
program.command('mcp').description('기존 구독 AI가 사용하는 stdio 서버를 시작한다.')
  .action(async () => { await startAgentServer((request) => callService(request, clientOptions(), 'agent')); });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const known = error instanceof ReportError || error instanceof ServiceError;
    const code = known ? error.code : error instanceof CommanderError || error instanceof z.ZodError ? 'invalid-input' : 'internal-error';
    const message = known ? error.message : code === 'invalid-input' ? '명령과 인자를 확인해 주세요.' : '명령을 처리하지 못했습니다.';
    process.exitCode = error instanceof ReportError ? error.exitCode : exitForError(code);
    jsonMode = jsonMode || process.argv.includes('--json');
    const response = errorResponse(randomUUID(), new ServiceError(code, message));
    if (jsonMode) process.stdout.write(`${JSON.stringify(response)}\n`);
    else process.stderr.write(`${message}\n`);
  }
}
