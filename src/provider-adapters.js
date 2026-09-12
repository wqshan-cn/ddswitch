import path from 'node:path';
import { readJsonLoose, fileExists, dirExists, atomicWriteJson, atomicWriteText, readText } from './jsonutil.js';
import { readNamedTable, readTopLevelKey, upsertNamedSegment, upsertTopLevelKey } from './toml-lite.js';

/**
 * ProviderAdapter：把「一个供应商配置」投影到工具的 live 文件。
 *
 * 借鉴 CC Switch 的 provider 架构：
 * - SSOT 是 ddswitch 的 providers store，live 文件是投影；
 * - 切换前必须 captureLive（backfill），把用户手改回填到旧 profile；
 * - 只写本 adapter 管理的键，其他键外科保留。
 *
 * 每个 adapter 实现：
 *   id / displayName
 *   caps: { switch: boolean, reason?: string }   // inferred 工具禁写
 *   listLive(env)  → [{id, name, kind, raw}]     // 工具本地的供应商清单（盘点）
 *   captureLive(env) → config | null             // 当前生效供应商的完整快照
 *   writeLive(env, config) → void                // 投影 profile 到 live
 */

const CLAUDE_MANAGED_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'];

/** Claude Code：~/.claude/settings.json 的 env 键（官方登录时 env 为空）。 */
export function createClaudeProviderAdapter() {
  const file = (env) => path.join(env.home, '.claude', 'settings.json');
  return {
    id: 'claude',
    displayName: 'Claude Code',
    caps: { switch: true },
    listLive(env) {
      if (!fileExists(file(env))) return [];
      const settings = readJsonLoose(file(env));
      const envCfg = settings.env || {};
      if (!envCfg.ANTHROPIC_BASE_URL && !envCfg.ANTHROPIC_AUTH_TOKEN && !envCfg.ANTHROPIC_API_KEY) {
        return [{ id: 'official', name: '官方登录（OAuth）', kind: 'official', raw: {} }];
      }
      return [{ id: 'custom-env', name: envCfg.ANTHROPIC_BASE_URL || '自定义环境', kind: 'api', raw: {} }];
    },
    captureLive(env) {
      if (!fileExists(file(env))) return null;
      const settings = readJsonLoose(file(env));
      const envCfg = settings.env || {};
      const managed = {};
      for (const key of CLAUDE_MANAGED_ENV_KEYS) {
        if (envCfg[key] !== undefined) managed[key] = envCfg[key];
      }
      return { kind: Object.keys(managed).length ? 'api' : 'official', env: managed };
    },
    writeLive(env, config) {
      const p = file(env);
      const settings = fileExists(p) ? readJsonLoose(p) : {};
      if (!settings.env || typeof settings.env !== 'object') settings.env = {};
      const next = config.env || {};
      for (const key of CLAUDE_MANAGED_ENV_KEYS) {
        if (next[key] !== undefined) settings.env[key] = next[key];
        else delete settings.env[key]; // 切到官方登录等无 token 配置时清掉受管键
      }
      atomicWriteJson(p, settings);
    },
  };
}

/** Codex：config.toml 的 model_provider 指针 + [model_providers.<name>] 段 + 顶层 model。 */
export function createCodexProviderAdapter() {
  const file = (env) => path.join(env.home, '.codex', 'config.toml');
  const read = (env) => {
    const p = file(env);
    if (!fileExists(p)) return null;
    const text = readText(p);
    const current = readTopLevelKey(text, 'model_provider');
    const model = readTopLevelKey(text, 'model');
    const providers = readNamedTable(text, 'model_providers');
    const section = current ? providers.find((x) => x.name === current) : null;
    return { current, model, section: section ? section.raw : null, text };
  };
  return {
    id: 'codex',
    displayName: 'Codex',
    caps: { switch: true },
    listLive(env) {
      const snapshot = read(env);
      if (!snapshot) return [];
      return readNamedTable(snapshot.text, 'model_providers').map((x) => ({
        id: x.name, name: x.name, kind: x.raw.wire_api || 'responses', raw: {},
      }));
    },
    captureLive(env) {
      const snapshot = read(env);
      if (!snapshot || !snapshot.current) return null;
      return {
        kind: 'codex',
        modelProvider: snapshot.current,
        model: snapshot.model ?? null,
        section: snapshot.section ?? {},
      };
    },
    writeLive(env, config) {
      const p = file(env);
      let text = fileExists(p) ? readText(p) : '# Codex CLI 配置\n\n';
      if (config.section && typeof config.section === 'object') {
        text = upsertNamedSegment(text, 'model_providers', config.modelProvider, config.section, 'env').text;
      }
      text = upsertTopLevelKey(text, 'model_provider', config.modelProvider).text;
      if (config.model !== null && config.model !== undefined) {
        text = upsertTopLevelKey(text, 'model', config.model).text;
      }
      atomicWriteText(p, text);
    },
  };
}

/**
 * ZCode：v2/config.json 的 provider map（name/kind/options{apiKey,baseURL}/models/enabled），
 * 激活语义含 family/mode（setting.json 的 modelProviderFamilySelectedKeys 带
 * "coding-plan:" 前缀），静态推断会写坏用户的激活状态 → v1 只读盘点 + 捕获，
 * 禁写；等一次「UI 切换前后 diff」观察确认激活语义后再开放。
 */
export function createZcodeProviderAdapter() {
  const file = (env) => path.join(env.home, '.zcode', 'v2', 'config.json');
  return {
    id: 'zcode',
    displayName: 'ZCode',
    caps: { switch: false, reason: '激活语义含 family/mode（modelProviderFamilySelectedKeys 带 coding-plan: 前缀），需 UI 切换观察确认后开放' },
    listLive(env) {
      if (!fileExists(file(env))) return [];
      const config = readJsonLoose(file(env));
      const map = config.provider || {};
      return Object.entries(map).map(([id, v]) => ({
        id, name: String(v.name ?? id), kind: v.kind ?? 'unknown',
        enabled: v.enabled === true, isBuiltin: id.startsWith('builtin:'), raw: {},
      }));
    },
    captureLive(env) {
      if (!fileExists(file(env))) return null;
      const config = readJsonLoose(file(env));
      const map = config.provider || {};
      const enabled = Object.entries(map).filter(([, v]) => v.enabled === true);
      return { enabledEntries: enabled.map(([id, v]) => ({ id, entry: v })), note: '快照（含完整 provider 条目）' };
    },
    writeLive() {
      throw new Error('[zcode] 供应商写入暂未开放：激活语义未确认（inferred 禁写）');
    },
  };
}

export function providerRegistry() {
  return [createClaudeProviderAdapter(), createCodexProviderAdapter(), createZcodeProviderAdapter()];
}

/** 读取 Codex settings.json 等辅助导出（供测试/CLI 使用）。 */
export const __internals = { fileExists, dirExists };
