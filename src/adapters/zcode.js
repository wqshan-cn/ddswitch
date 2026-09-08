import path from 'node:path';
import { createJsonFamilyAdapter } from './jsonfamily.js';
import { dirExists } from '../jsonutil.js';

/**
 * ZCode 适配器。
 *
 * 实测（2026-09，本机 Windows）：
 * - MCP 权威配置在 ~/.zcode/cli/config.json 的 $.mcp.servers.<name>
 * - 服务器字段：type("stdio") / command / args / env / timeoutMs / enabled
 * - ~/.zcode/mcp/<name>/ 是各服务器的运行工作区（node_modules 等），不是配置，不要动
 * - ~/.zcode/skills/ 内为 symlink 部署的技能目录
 * - ~/.zcode/cli/config.json 同时承载 plugins.enabledPlugins 等其他键，合并时必须保留
 */
export function createZcodeAdapter() {
  return createJsonFamilyAdapter({
    id: 'zcode',
    displayName: 'ZCode',
    resolve: (env) => ({
      file: path.join(env.home, '.zcode', 'cli', 'config.json'),
      containerPath: ['mcp', 'servers'],
      createIfMissing: true,
    }),
    detected: (env) => dirExists(path.join(env.home, '.zcode')),
    configRoot: (env) => path.join(env.home, '.zcode'),
    normalizeKey: (name) => name.toLowerCase(),
    skillsDir: (env) => path.join(env.home, '.zcode', 'skills'),
    memoryPaths: (env) => [path.join(env.home, '.zcode', 'cli', 'memories')],
  });
}
