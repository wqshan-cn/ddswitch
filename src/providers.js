import fs from 'node:fs';
import path from 'node:path';
import { readJsonLoose, atomicWriteJson, fileExists, isRecord } from './jsonutil.js';
import { providerRegistry } from './provider-adapters.js';

/**
 * Provider SSOT store（借鉴 CC Switch：DB 是 SSOT，live 文件是投影）：
 * ~/.ddswitch/providers.json
 * { "version": 1, "agents": { "claude": { "currentProfileId": "p1",
 *   "profiles": [ { "id", "name", "createdAt", "config", "note?" } ] } } }
 */

export function providersStorePath(env) {
  return path.join(env.home, '.ddswitch', 'providers.json');
}

export function loadStore(env) {
  const p = providersStorePath(env);
  if (!fileExists(p)) return { version: 1, agents: {} };
  const data = readJsonLoose(p);
  if (!isRecord(data) || !isRecord(data.agents)) return { version: 1, agents: {} };
  return data;
}

export function saveStore(env, store) {
  atomicWriteJson(providersStorePath(env), store);
}

function ensureAgent(store, agentId) {
  if (!store.agents[agentId]) store.agents[agentId] = { currentProfileId: null, profiles: [] };
  return store.agents[agentId];
}

function adapterFor(registry, agentId) {
  const a = registry.find((x) => x.id === String(agentId).toLowerCase());
  if (!a) throw new Error(`未知工具 id：${agentId}（provider 支持的：${registry.map((x) => x.id).join(', ')}）`);
  return a;
}

/** 把当前 live 配置捕获为一个 profile（若与已有 profile 内容相同则复用）。 */
export function captureProfile(env, agentId, name) {
  const registry = providerRegistry();
  const adapter = adapterFor(registry, agentId);
  const config = adapter.captureLive(env);
  if (!config) throw new Error(`[${adapter.id}] 当前没有可捕获的供应商配置`);
  const store = loadStore(env);
  const agent = ensureAgent(store, adapter.id);
  const existing = agent.profiles.find((p) => JSON.stringify(p.config) === JSON.stringify(config));
  if (existing) {
    // 捕获的内容按定义就是当前 live：即使复用旧 profile 也要把它标记为当前，
    // 否则后续 switch 的 backfill 会把 live 改动归到错误的 profile（真机验收发现的 bug）。
    agent.currentProfileId = existing.id;
    saveStore(env, store);
    return { store, profile: existing, reused: true };
  }
  const profile = {
    id: `${adapter.id}-${Date.now().toString(36)}`,
    name: name || `${adapter.displayName} 快照 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    createdAt: new Date().toISOString(),
    config,
  };
  agent.profiles.push(profile);
  agent.currentProfileId = profile.id;
  saveStore(env, store);
  return { store, profile, reused: false };
}

/** 切换：backfill 旧 live → 写新 profile。write=false 为 dry-run。 */
export function switchProvider(env, agentId, profileId, { write = false } = {}) {
  const registry = providerRegistry();
  const adapter = adapterFor(registry, agentId);
  if (write && !adapter.caps?.switch) {
    throw new Error(`[${adapter.id}] 供应商切换暂未开放：${adapter.caps?.reason || 'inferred 禁写'}`);
  }
  const store = loadStore(env);
  const agent = ensureAgent(store, adapter.id);
  const profile = agent.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`[${adapter.id}] 未找到供应商配置：${profileId}`);

  const lines = [];
  // backfill：把当前 live 捕获回当前 profile（借鉴 CC Switch 切换前回填）
  if (agent.currentProfileId) {
    const old = agent.profiles.find((p) => p.id === agent.currentProfileId);
    if (old) {
      const live = adapter.captureLive(env);
      if (live && JSON.stringify(live) !== JSON.stringify(old.config)) {
        if (write) {
          old.config = live;
          old.backfilledAt = new Date().toISOString();
          lines.push(`✓ [${adapter.id}] 已回填用户手改到旧配置「${old.name}」`);
        } else {
          lines.push(`· [${adapter.id}] 检测到 live 与旧配置「${old.name}」不同，dry-run 下暂不回填`);
        }
      }
    }
  }
  if (write) {
    adapter.writeLive(env, profile.config);
    agent.currentProfileId = profile.id;
    saveStore(env, store);
    lines.push(`✓ [${adapter.id}] 已切换到「${profile.name}」`);
  } else {
    lines.push(`· [${adapter.id}] 将切换到「${profile.name}」（dry-run；加 --write 生效）`);
  }
  return { lines, profile, write };
}

/** 盘点：store 里的 profiles + 工具本地的 live 供应商清单。 */
export function listProviders(env, agentId = null) {
  const registry = providerRegistry();
  const store = loadStore(env);
  return registry.filter((a) => !agentId || a.id === agentId).map((a) => {
    const agent = store.agents[a.id];
    let live = [];
    try { live = a.listLive(env); } catch { live = []; }
    return {
      id: a.id, name: a.displayName, caps: a.caps,
      currentProfileId: agent?.currentProfileId ?? null,
      profiles: (agent?.profiles ?? []).map(({ id, name, createdAt, note }) => ({ id, name, createdAt, note })),
      live,
    };
  });
}

/** 删除 profile；正在生效的 profile 不允许删（避免失去回滚点）。 */
export function removeProfile(env, agentId, profileId, { write = false } = {}) {
  const store = loadStore(env);
  const agent = store.agents[String(agentId).toLowerCase()];
  if (!agent) throw new Error(`[${agentId}] store 中没有该工具的配置`);
  const idx = agent.profiles.findIndex((p) => p.id === profileId);
  if (idx < 0) throw new Error(`[${agentId}] 未找到供应商配置：${profileId}`);
  if (agent.currentProfileId === profileId) throw new Error('该配置正在生效，先切换到其他配置再删除');
  if (write) {
    agent.profiles.splice(idx, 1);
    saveStore(env, store);
  }
  return agent.profiles[idx];
}

/** 供 doctor/CLI 使用：store 是否存在 */
export function storeExists(env) {
  return fileExists(providersStorePath(env));
}
