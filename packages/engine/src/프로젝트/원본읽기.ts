// 프로젝트의 세 JSON 원본을 검증하고 카탈로그와 소스 지문을 묶는다.
import { createHash } from 'node:crypto';
import { projectSourceSchema, type ProjectSnapshot, type ProjectSource } from '@checkmate/contracts/project';
import { checkedProjectRoot, fingerprintSource, ProjectSourceError, readCheckedFile } from './소스지문.js';

const catalogNames = ['프로젝트.json', '요구사항.json', '검사항목.json'] as const;
const catalogLimit = 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const values = value as Record<string, unknown>;
    return `{${Object.keys(values).sort().map((key) => `${JSON.stringify(key)}:${canonical(values[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readCatalog(root: string): Promise<{ source: ProjectSource; contentHash: string }> {
  const values: unknown[] = [];
  for (const name of catalogNames) {
    let text: string;
    const bytes = await readCheckedFile(root, ['checkmate', name], catalogLimit);
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ProjectSourceError('invalid-project', '프로젝트 원본 인코딩이 올바르지 않습니다.'); }
    try { values.push(JSON.parse(text) as unknown); }
    catch { throw new ProjectSourceError('invalid-project', '프로젝트 원본 JSON이 올바르지 않습니다.'); }
  }
  const parsed = projectSourceSchema.safeParse({ project: values[0], requirements: values[1], checks: values[2] });
  if (!parsed.success) throw new ProjectSourceError('invalid-project', '프로젝트 원본 계약이 올바르지 않습니다.');
  const source = parsed.data;
  return { source, contentHash: createHash('sha256').update(canonical(source)).digest('hex') };
}

export async function readProjectSource(root: string): Promise<ProjectSnapshot> {
  const realPath = await checkedProjectRoot(root);
  const before = await readCatalog(realPath);
  const sourceHash = await fingerprintSource(realPath);
  const after = await readCatalog(realPath);
  if (before.contentHash !== after.contentHash) {
    throw new ProjectSourceError('source-changed', '프로젝트 원본이 읽는 동안 변경되었습니다.');
  }
  return { realPath, source: before.source, contentHash: before.contentHash, sourceHash };
}

export { ProjectSourceError, fingerprintSource } from './소스지문.js';
