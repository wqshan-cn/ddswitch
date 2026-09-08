import path from 'node:path';
import { createJsonFamilyAdapter } from './jsonfamily.js';
import { dirExists, fileExists } from '../jsonutil.js';

/**
 * Claude Code 适配器（海外）。
 *
 * 用户级（user scope）MCP 配置在 ~/.claude.json 顶层的 mcpServers
 * （即 `claude mcp add` 写入的位置）。该文件同时承载账户与状态等
 * 大量其他键，合并时必须原样保留；项目级 .mcp.json 暂不管理。
 */
export function createClaudeAdapter() {
  const root = (env) => path.join(env.home, '.claude');
  return createJsonFamilyAdapter({
    id: 'claude',
    displayName: 'Claude Code',
    resolve: (env) => ({
      file: path.join(env.home, '.claude.json'),
      containerPath: ['mcpServers'],
      createIfMissing: true,
    }),
    detected: (env) => dirExists(root(env)) || fileExists(path.join(env.home, '.claude.json')),
    configRoot: root,
    skillsDir: (env) => path.join(root(env), 'skills'),
    memoryPaths: (env) => [path.join(root(env), 'CLAUDE.md')],
  });
}
