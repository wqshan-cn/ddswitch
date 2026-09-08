import path from 'node:path';
import os from 'node:os';
import { createJsonFamilyAdapter } from './jsonfamily.js';
import { createZcodeAdapter } from './zcode.js';
import { createClaudeAdapter } from './claude.js';
import { createGeminiAdapter } from './gemini.js';
import { createCodexAdapter } from './codex.js';
import { createWorkbuddyAdapter } from './workbuddy.js';
import { dirExists, safeJoin, safeBaseJoin } from '../jsonutil.js';

/** 运行环境：路径解析统一走 env，方便测试注入临时目录与模拟其他平台。 */
export function defaultEnv() {
  const home = os.homedir();
  return {
    platform: process.platform,
    home,
    appdata: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    localappdata: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
  };
}

/**
 * VS Code 系 fork 工具的用户数据目录候选（按平台惯例展开）：
 * - win32:  %APPDATA%\<name>
 * - darwin: ~/Library/Application Support/<name>
 * - linux:  $XDG_CONFIG_HOME/<name>（缺省 ~/.config/<name>）
 */
/** 用户变体名：只允许常见的产品/平台常量目录，禁止 .config 被当作用户输入。 */
function safeProductSegment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/.test(value)) {
    throw new Error(`非法应用目录名：${String(value)}`);
  }
  return value;
}

/** 平台根目录常量（点开头如 .config 是系统惯例，不是用户输入）。 */
function safeRootSegment(value) {
  const s = String(value);
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error(`非法目录段：${s}`);
  }
  return s;
}

/** VS Code 系工具用户数据目录候选：环境根 + 平台常量 + 产品名，全部白名单拼接。 */
export function appDataDirCandidates(env, names) {
  const platformRoots = env.platform === 'darwin'
    ? [['Library', 'Application Support']]
    : env.platform === 'linux'
      ? [process.env.XDG_CONFIG_HOME ? [process.env.XDG_CONFIG_HOME] : ['.config']]
      : [['AppData', 'Roaming']];
  const start = env.home || '.';
  return platformRoots.flatMap((segments) => names.map((n) => {
    const validatedSegments = segments.map(safeRootSegment);
    return safeJoin(start, ...validatedSegments, safeProductSegment(n));
  }));
}

/**
 * 适配器注册表。产品定位是通用的：任何 AI 编程工具 = 一份 spec。
 * 顺序即 scan 输出顺序，国产生态在前（当前重点补齐），海外主流在后。
 */

/** Qoder：~/.qoder/settings.json 的 mcpServers，与 Claude Desktop 同构（含 qoder_url 等私有字段，原样保留）。 */
function createQoderAdapter() {
  const root = (env) => safeJoin(env.home, '.qoder');
  return createJsonFamilyAdapter({
    id: 'qoder',
    displayName: 'Qoder',
    resolve: (env) => ({
      file: safeJoin(root(env), 'settings.json'),
      containerPath: ['mcpServers'],
      createIfMissing: true,
    }),
    detected: (env) => dirExists(root(env)),
    configRoot: root,
    memoryPaths: (env) => [safeJoin(root(env), 'memory')],
  });
}

/** 生成 VS Code 系工具 User/mcp.json 的完整候选路径（产品根 + User + mcp.json）。 */
function vscodeMcpCandidates(env, names) {
  return appDataDirCandidates(env, names).map((base) => path.join(base, 'User', 'mcp.json'));
}

/** Trae（VS Code fork）：User/mcp.json（官方文档确认）；按平台 × 变体（CN/SOLO CN/国际版）探测。 */
function createTraeAdapter() {
  const variants = ['Trae CN', 'Trae SOLO CN', 'Trae'];
  const config = (env) => {
    const candidates = appDataDirCandidates(env, variants).map((b) => path.join(b, 'User'));
    const base = candidates.find((b) => dirExists(b)) || candidates[0];
    return { base, file: path.join(base, 'mcp.json') };
  };
  return createJsonFamilyAdapter({
    id: 'trae',
    displayName: 'Trae',
    resolve: (env) => {
      const c = config(env);
      return { file: c.file, containerPath: ['mcpServers'], createIfMissing: true, note: `变体目录：${c.base}` };
    },
    detected: (env) => appDataDirCandidates(env, variants).some((d) => dirExists(d)),
    confidence: 'verified', // 官方文档确认 User/mcp.json
    triedPaths: (env) => vscodeMcpCandidates(env, variants),
  });
}

/** CodeBuddy（VS Code fork，腾讯）：实验性——路径按 fork 惯例推断，写入待社区验证后开放。 */
function createCodebuddyAdapter() {
  const variants = ['CodeBuddy', 'CodeBuddy CN'];
  const candidates = (env) => appDataDirCandidates(env, variants);
  const config = (env) => {
    const bases = candidates(env).map((b) => path.join(b, 'User'));
    const base = bases.find((b) => dirExists(b)) || bases[0];
    return { base, file: path.join(base, 'mcp.json') };
  };
  return createJsonFamilyAdapter({
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    resolve: (env) => {
      const c = config(env);
      return { file: c.file, containerPath: ['mcpServers'], createIfMissing: false, note: '实验性（inferred）：路径按 VS Code fork 惯例推断，未经官方确认' };
    },
    detected: (env) => {
      const dot = dirExists(safeJoin(env.home, '.codebuddy'));
      const ext = dirExists(safeJoin(env.localappdata, 'CodeBuddyExtension'));
      return dot || ext || candidates(env).some((d) => dirExists(d));
    },
    configRoot: (env) => {
      const cands = [safeJoin(env.home, '.codebuddy'), ...candidates(env)];
      return cands.find((d) => dirExists(d)) || cands[0];
    },
    confidence: 'inferred',
    capsOverride: { mcpRead: true, mcpWrite: false },
  });
}

/** Kimi CLI：~/.kimi/mcp.json 的 mcpServers（与主流 MCP 客户端兼容）。 */
function createKimiAdapter() {
  const root = (env) => safeJoin(env.home, '.kimi');
  return createJsonFamilyAdapter({
    id: 'kimi',
    displayName: 'Kimi CLI',
    resolve: (env) => ({
      file: path.join(root(env), 'mcp.json'),
      containerPath: ['mcpServers'],
      createIfMissing: true,
    }),
    detected: (env) => dirExists(root(env)),
    configRoot: root,
  });
}

/** OpenCode：~/.config/opencode/opencode.json，容器键为 mcp。 */
function createOpencodeAdapter() {
  const root = (env) => safeJoin(env.home, '.config', 'opencode');
  return createJsonFamilyAdapter({
    id: 'opencode',
    displayName: 'OpenCode',
    resolve: (env) => ({
      file: path.join(root(env), 'opencode.json'),
      containerPath: ['mcp'],
      createIfMissing: true,
    }),
    detected: (env) => dirExists(root(env)),
    configRoot: root,
  });
}

export function registry() {
  return [
    // 国产生态
    createZcodeAdapter(),
    createQoderAdapter(),
    createTraeAdapter(),
    createKimiAdapter(),
    createCodebuddyAdapter(),
    createWorkbuddyAdapter(),
    // 海外主流
    createClaudeAdapter(),
    createCodexAdapter(),
    createGeminiAdapter(),
    createOpencodeAdapter(),
  ];
}
