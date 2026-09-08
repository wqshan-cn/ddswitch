import path from 'node:path';
import { dirExists } from '../jsonutil.js';

/**
 * 仅探测/盘点的 stub 适配器（当前仅剩 CodeBuddy 之外的兜底场景备用）。
 * detectFn(env) 返回已安装时的根目录路径，未安装返回 null。
 */
export function createStub({ id, displayName, detectFn, note, skillsDir, memoryPaths }) {
  return {
    id,
    displayName,
    detect(env) {
      const root = detectFn(env);
      return root ? { configRoot: root, note, confidence: 'inferred' } : null;
    },
    caps: { mcpRead: false, mcpWrite: false },
    listMcp() { throw new Error(`[${id}] MCP 读取暂未实现：${note}`); },
    upsertMcp() { throw new Error(`[${id}] MCP 写入暂未实现：${note}`); },
    removeMcp() { throw new Error(`[${id}] MCP 删除暂未实现：${note}`); },
    diagnose() { return { file: null, note }; },
    skillsDir(env) { return skillsDir ? skillsDir(env) : null; },
    memoryPaths(env) { return memoryPaths ? memoryPaths(env) : []; },
  };
}
