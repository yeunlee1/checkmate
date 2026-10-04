// 등록된 모든 관리형 연결의 자료를 확인하고 설치 엔진의 자연 종료를 기다린다.
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readManagedDescriptor, readManagedTarget, readRegisteredRoots, managedDirectory, sameManagedPath } from '@checkmate/engine/managed-connection';
import { installationIdle } from './업데이트.js';

const execute = promisify(execFile);
export async function waitForManagedIdle(root: string): Promise<boolean> {
  const deadline = Date.now() + 75000;
  const expired = new Error('managed-idle-timeout');
  const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw expired; return value; };
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    const budget = remaining(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(expired), budget); })]);
      remaining(); return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  try {
    try { await bounded(() => lstat(managedDirectory(root))); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return await bounded(() => installationIdle(root, Math.min(15000, remaining())));
      throw error;
    }
    const descriptor = await bounded(() => readManagedDescriptor(root));
    const roots = (await bounded(() => readRegisteredRoots(root))).sort();
    const inspect = async () => {
      for (const dataRoot of roots) {
        const target = await bounded(() => readManagedTarget(root, dataRoot));
        if (target.generation !== descriptor.generation) return false;
        const cli = join(root, `app-${target.version}`, 'resources', 'engine', 'packages', 'engine', 'dist', '명령.js');
        const result = await bounded(() => execute(target.nodeExecutable, [cli, '--data-dir', dataRoot, '--json', 'update-readiness'],
          { windowsHide: true, shell: false, timeout: Math.min(35000, remaining()), maxBuffer: 16384 }));
        const response = JSON.parse(result.stdout);
        if (response.ok !== true || response.data?.ready !== true || response.data.version !== target.version
          || typeof response.data.dataRoot !== 'string' || !sameManagedPath(response.data.dataRoot, dataRoot)
          || typeof response.data.installationRoot !== 'string' || !sameManagedPath(response.data.installationRoot, root)) return false;
      }
      return true;
    };
    if (!await inspect()) return false;
    while (!await bounded(() => installationIdle(root, Math.min(15000, remaining())))) {
      await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(1500, remaining()))));
    }
    // 관측 사이에 등록이나 세대가 바뀌면 처음의 안전 확인을 재사용하지 않는다.
    if ((await bounded(() => readManagedDescriptor(root))).generation !== descriptor.generation
      || JSON.stringify((await bounded(() => readRegisteredRoots(root))).sort()) !== JSON.stringify(roots)) return false;
    return await inspect() && await bounded(() => installationIdle(root, Math.min(15000, remaining())));
  } catch (error) { if (error === expired) return false; throw error; }
}
