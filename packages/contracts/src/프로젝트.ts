// 프로젝트 원본의 명령과 요구사항 및 검사항목을 엄격하게 검증한다.
import { z } from 'zod';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const title = z.string().trim().min(1).max(200);
const prose = z.string().trim().min(1).max(4096);
const relativePath = z.string().min(1).max(1024).superRefine((value, context) => {
  if (value.startsWith('/') || value.includes('\\') || value.includes(':')
    || /[\x00-\x1f\x7f<>"|?*]/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..'
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    context.addIssue({ code: 'custom', message: '안전한 프로젝트 상대 경로가 아닙니다.' });
  }
});

export const projectRelativePathSchema = relativePath;

const commandSchema = z.strictObject({
  id: identifier,
  title,
  runtime: z.literal('node'),
  entry: relativePath.refine((value) => /\.(?:js|mjs|cjs)$/iu.test(value), 'Node 실행 파일 경로가 아닙니다.'),
  args: z.array(z.string().max(2048)).max(100),
  timeoutMs: z.number().int().positive().max(3_600_000),
  env: z.record(z.string(), z.string().max(4096)).superRefine((values, context) => {
    if (Object.keys(values).length > 100) context.addIssue({ code: 'custom', message: '환경 변수 수가 많습니다.' });
    for (const key of Object.keys(values)) {
      if ((key !== 'NODE_ENV' && !/^CHECKMATE_[A-Z0-9_]+$/u.test(key))
        || /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH|COOKIE)/iu.test(key)) {
        context.addIssue({ code: 'custom', path: [key], message: '허용되지 않은 환경 변수 이름입니다.' });
      }
    }
  }),
  writes: z.array(relativePath).max(100),
  resultFormat: z.enum(['ndjson', 'exit-code']),
});

const profileSchema = z.strictObject({
  id: identifier,
  title,
  checkIds: z.array(identifier).min(1).max(1000),
});

export const projectDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  name: title,
  repositoryIdentity: z.string().trim().min(1).max(1024),
  commands: z.array(commandSchema).max(1000),
  profiles: z.array(profileSchema).max(1000),
});

const requirementSchema = z.strictObject({
  id: identifier,
  title,
  description: prose,
});

const checkSchema = z.strictObject({
  id: identifier,
  title,
  requirementId: identifier,
  commandId: identifier,
  required: z.boolean(),
  kind: z.enum(['logic', 'security', 'design', 'accessibility', 'detection']),
  expected: prose,
  codePaths: z.array(relativePath).max(100),
});

export const requirementsSchema = z.array(requirementSchema).max(1000);
export const checksSchema = z.array(checkSchema).max(1000);

export const projectSourceSchema = z.strictObject({
  project: projectDefinitionSchema,
  requirements: requirementsSchema,
  checks: checksSchema,
}).superRefine((source, context) => {
  for (const [key, values] of [
    ['commands', source.project.commands],
    ['profiles', source.project.profiles],
    ['requirements', source.requirements],
    ['checks', source.checks],
  ] as const) {
    const ids = values.map((value) => value.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: [key], message: 'ID가 중복되었습니다.' });
    }
  }
  const commands = new Set(source.project.commands.map((item) => item.id));
  const requirements = new Set(source.requirements.map((item) => item.id));
  const checks = new Map(source.checks.map((item) => [item.id, item]));
  for (const [index, item] of source.checks.entries()) {
    if (!commands.has(item.commandId) || !requirements.has(item.requirementId)) {
      context.addIssue({ code: 'custom', path: ['checks', index], message: '없는 명령 또는 요구사항을 참조합니다.' });
    }
  }
  for (const [index, profile] of source.project.profiles.entries()) {
    if (new Set(profile.checkIds).size !== profile.checkIds.length
      || profile.checkIds.some((id) => !checks.has(id))
      || !profile.checkIds.some((id) => checks.get(id)?.required)) {
      context.addIssue({ code: 'custom', path: ['project', 'profiles', index], message: '프로필 검사 참조 또는 필수 검사가 잘못되었습니다.' });
    }
  }
});

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;
export type RequirementDefinition = z.infer<typeof requirementSchema>;
export type CheckDefinition = z.infer<typeof checkSchema>;
export type ProjectSource = { project: ProjectDefinition; requirements: RequirementDefinition[]; checks: CheckDefinition[] };
export type ProjectSnapshot = { realPath: string; source: ProjectSource; contentHash: string; sourceHash: string };
