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
 *
 * 写入验证结论（2026-09-12，受控实验 + 用户 UI 确认）：
 * - 退出状态写入 disabled 无凭据测试条目 → 文件完整保留（9 项校验通过）；
 * - 启动后 WorkBuddy 读取并重新序列化该文件（sha 变化、条目保留）——它是活跃注册表；
 * - 但连接器 UI（应用市场视图）不展示外部条目（用户搜索确认），条目的展示/生效路径未证实；
 * - 因此该文件对 WorkBuddy 是「容忍外部内容但不保证生效」的内部注册表 → 维持禁写；
 *   自定义 MCP 的正确入口是 UI 的「自定义连接器」，其存储位置待确认。
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
