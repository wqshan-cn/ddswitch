import path from 'node:path';
import { createJsonFamilyAdapter } from './jsonfamily.js';
import { dirExists, fileExists, safeJoin } from '../jsonutil.js';

/** WorkBuddy 数据根候选：优先跨平台一致的 ~/.workbuddy。所有片段走 safeJoin 防穿越。 */
export function workbuddyRootCandidates(env) {
  const roots = [safeJoin(env.home, '.workbuddy')];
  if (env.platform === 'win32') {
    roots.push(safeJoin(env.appdata, 'WorkBuddy'), safeJoin(env.localappdata, 'WorkBuddy'));
  } else if (env.platform === 'darwin') {
    roots.push(safeJoin(env.home, 'Library', 'Application Support', 'WorkBuddy'));
  } else {
    roots.push(safeJoin(env.home, '.config', 'workbuddy'));
  }
  return [...new Set(roots)];
}

/**
 * WorkBuddy default connector profile 适配器。
 *
 * 本机验证的配置主体：<root>/connectors/default/mcp.json -> mcpServers。
 * connector-states.json 还承载启用/覆盖状态，因此当前只读；在应用重启加载
 * 行为被验证前，不把该文件宣称为唯一全局权威配置，也不允许写入。
 */
export function createWorkbuddyAdapter() {
  const roots = (env) => workbuddyRootCandidates(env);
  const pickRoot = (env) => {
    const candidates = roots(env);
    return candidates.find((r) => fileExists(safeJoin(r, 'connectors', 'default', 'mcp.json')))
      || candidates.find((r) => dirExists(r))
      || candidates[0];
  };
  return createJsonFamilyAdapter({
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    resolve: (env) => {
      const root = pickRoot(env);
      return {
        file: safeJoin(root, 'connectors', 'default', 'mcp.json'),
        containerPath: ['mcpServers'],
        createIfMissing: false,
        note: 'default connector profile（格式已实测；connector-states 覆盖层未纳入，当前只读）',
      };
    },
    detected: (env) => roots(env).some((r) => dirExists(r)),
    configRoot: pickRoot,
    confidence: 'verified',
    capsOverride: { mcpRead: true, mcpWrite: false, mcpPreviewWrite: true, skillsWrite: false },
    triedPaths: (env) => roots(env).map((r) => safeJoin(r, 'connectors', 'default', 'mcp.json')),
    skillsDir: (env) => safeJoin(pickRoot(env), 'skills'),
    extraSkillDirs: (env) => [safeJoin(pickRoot(env), 'connectors', 'skills')],
    memoryPaths: (env) => {
      const root = pickRoot(env);
      return [
        safeJoin(root, 'memory'),
        safeJoin(root, 'IDENTITY.md'),
        safeJoin(root, 'SOUL.md'),
        safeJoin(root, 'USER.md'),
      ];
    },
  });
}
