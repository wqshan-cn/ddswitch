import path from 'node:path';
import { createJsonFamilyAdapter } from './jsonfamily.js';
import { dirExists } from '../jsonutil.js';

/**
 * Gemini CLI 适配器（海外）。
 *
 * MCP 配置在 ~/.gemini/settings.json 的 mcpServers（未安装时 detect 为空，
 * 适配器仍然可用——装了就能管）。
 */
export function createGeminiAdapter() {
  const root = (env) => path.join(env.home, '.gemini');
  return createJsonFamilyAdapter({
    id: 'gemini',
    displayName: 'Gemini CLI',
    resolve: (env) => ({
      file: path.join(root(env), 'settings.json'),
      containerPath: ['mcpServers'],
      createIfMissing: true,
    }),
    detected: (env) => dirExists(root(env)),
    configRoot: root,
  });
}
