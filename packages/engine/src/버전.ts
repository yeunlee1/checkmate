// 설치된 엔진의 패키지 버전을 명령과 MCP 및 저장 기록에 일관되게 제공한다.
import { readFileSync } from 'node:fs';
export const engineVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
