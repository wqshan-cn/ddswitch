import path from 'node:path';
import { readJsonLoose, fileExists, dirExists, atomicWriteJson, atomicWriteText, readText } from './jsonutil.js';
import { readNamedTable, readTopLevelKey, upsertNamedSegment, upsertTopLevelKey } from './toml-lite.js';
import { redactMcpDefinition } from './model.js';

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
 * ZCode：v2/config.json 的 provider map（name/kind/options{apiKey,baseURL}/models/enabled）。
 *
 * 实测结论（2026-09-12，通过「用户在 UI 里切换到 deepseek」前后对比确认）：
 * - 供应商**定义与凭据**在 `~/.zcode/v2/config.json`（可写）；
 * - 供应商**当前选中状态不在任何配置文件里**：config.json 无 active/default/current 标记
 *   （mtime 停在更早日期）、setting.json 无目标 provider 引用、`local_setting` 表只有
 *   namespace=model 的 reasoningLevel、session 表无模型列；
 * - 切换动作实际写入的是 Electron 渲染进程 localStorage
 *   （`%APPDATA%/ZCode/session/Local Storage/leveldb/*.log` 内含目标模型串）。
 *
 * 因为渲染层 LevelDB 是 App 托管状态，外部写入会与运行中的 App 抢状态并可能损坏 UI 存储，
 * 所以 v1 只做盘点 + 凭据快照（备份），切换必须在 ZCode UI 内完成。
 */
export function createZcodeProviderAdapter() {
  const file = (env) => path.join(env.home, '.zcode', 'v2', 'config.json');
  return {
    id: 'zcode',
    displayName: 'ZCode',
    caps: {
      switch: false,
      reason: '当前选中状态在 ZCode 的 Electron localStorage（LevelDB）里，属 App 托管状态、无受支持的写入路径；config.json 只存供应商定义与凭据。v1 仅盘点与快照备份，切换请在 ZCode UI 内完成',
    },
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
      // ZCode 无法由外部切换，快照只作盘点留档：脱敏凭据，避免把 apiKey/oauth token
      // 复制到第二个位置（与项目「默认脱敏」纪律一致；要备份凭据请直接备份 config.json）。
      const safeMap = {};
      for (const [id, entry] of Object.entries(map)) {
        safeMap[id] = {
          name: entry.name ?? null,
          kind: entry.kind ?? null,
          source: entry.source ?? null,
          enabled: entry.enabled === true,
          options: redactMcpDefinition(entry.options || {}),
        };
      }
      return {
        kind: 'zcode-provider-inventory',
        providers: safeMap,
        enabledEntries: Object.entries(map).filter(([, v]) => v.enabled === true).map(([id]) => id),
        note: 'ZCode 供应商清单快照（凭据已脱敏）；当前选中状态在 App 的 localStorage，无法由此切换',
      };
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
