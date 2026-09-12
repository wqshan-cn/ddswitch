import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProfile, switchProvider, listProviders, removeProfile } from '../src/providers.js';
import { readTopLevelKey } from '../src/toml-lite.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddswitch-provider-'));
}
const ENV = (home) => ({ platform: 'win32', home, appdata: path.join(home, 'AppData', 'Roaming'), localappdata: path.join(home, 'AppData', 'Local') });

test('provider：Claude 捕获官方登录 → 切到自定义 → 回切逐字节恢复', () => {
  const home = tempHome();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = '{\n  "env": {}\n}';
  fs.writeFileSync(settingsPath, original);

  // 捕获当前（官方登录）
  const official = captureProfile(ENV(home), 'claude', '官方登录');
  assert.equal(official.profile.config.kind, 'official');

  // 添加一个自定义 profile 并切换（真实写入）
  const store = JSON.parse(fs.readFileSync(path.join(home, '.ddswitch', 'providers.json'), 'utf8'));
  const agent = store.agents.claude;
  agent.profiles.push({
    id: 'claude-test', name: '中转站', createdAt: new Date().toISOString(),
    config: { kind: 'api', env: { ANTHROPIC_BASE_URL: 'https://relay.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-test-123' } },
  });
  fs.writeFileSync(path.join(home, '.ddswitch', 'providers.json'), JSON.stringify(store, null, 2) + '\n');

  const sw = switchProvider(ENV(home), 'claude', 'claude-test', { write: true });
  assert.ok(sw.lines.some((l) => l.includes('已切换')));
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://relay.example.com');
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-123');

  // 用户手改 live → 切回官方时自动回填到自定义 profile
  const modified = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  modified.env.ANTHROPIC_MODEL = 'claude-x';
  fs.writeFileSync(settingsPath, JSON.stringify(modified, null, 2) + '\n');
  switchProvider(ENV(home), 'claude', official.profile.id, { write: true });
  const storeAfter = JSON.parse(fs.readFileSync(path.join(home, '.ddswitch', 'providers.json'), 'utf8'));
  const testProfile = storeAfter.agents.claude.profiles.find((p) => p.id === 'claude-test');
  assert.equal(testProfile.config.env.ANTHROPIC_MODEL, 'claude-x', '用户手改应被回填');
  const restored = fs.readFileSync(settingsPath, 'utf8');
  assert.equal(JSON.parse(restored).env.ANTHROPIC_BASE_URL, undefined, '切回官方后受管键被清除');
});

test('provider：Codex TOML 指针+段切换，无关段保留', () => {
  const home = tempHome();
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, `model = "gpt-5"
model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://a.example.com/v1"
wire_api = "responses"
experimental_bearer_token = "token-a"

[mcp_servers.tool]
command = "node"
`);

  const cap = captureProfile(ENV(home), 'codex', '中转A');
  assert.equal(cap.profile.config.modelProvider, 'custom');
  assert.equal(cap.profile.config.section.base_url, 'https://a.example.com/v1');

  const store = JSON.parse(fs.readFileSync(path.join(home, '.ddswitch', 'providers.json'), 'utf8'));
  store.agents.codex.profiles.push({
    id: 'codex-b', name: '中转B', createdAt: new Date().toISOString(),
    config: { kind: 'codex', modelProvider: 'relay-b', model: 'gpt-6', section: { name: 'Relay B', base_url: 'https://b.example.com/v1', wire_api: 'responses', experimental_bearer_token: 'token-b' } },
  });
  fs.writeFileSync(path.join(home, '.ddswitch', 'providers.json'), JSON.stringify(store, null, 2) + '\n');

  switchProvider(ENV(home), 'codex', 'codex-b', { write: true });
  const text = fs.readFileSync(cfg, 'utf8');
  assert.equal(readTopLevelKey(text, 'model_provider'), 'relay-b');
  assert.equal(readTopLevelKey(text, 'model'), 'gpt-6');
  assert.ok(text.includes('https://b.example.com/v1'));
  assert.ok(text.includes('token-b'));
  assert.ok(text.includes('[mcp_servers.tool]'), 'MCP 段不受 provider 切换影响');
  assert.ok(text.includes('command = "node"'));
});

test('provider：ZCode 盘点可用但切换被禁写', () => {
  const home = tempHome();
  const cfg = path.join(home, '.zcode', 'v2', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ provider: {
    'builtin:bigmodel-start-plan': { name: 'BigModel Plan', kind: 'anthropic', options: { apiKey: 'x', baseURL: 'https://x' }, enabled: true },
    'uuid-1': { name: '中转', kind: 'openai-compatible', options: { apiKey: 'y', baseURL: 'https://y' }, models: [] },
  } }));
  const rows = listProviders(ENV(home), 'zcode');
  assert.equal(rows[0].caps.switch, false);
  assert.equal(rows[0].live.length, 2);
  assert.equal(rows[0].live.find((l) => l.id === 'builtin:bigmodel-start-plan').enabled, true);

  fs.mkdirSync(path.join(home, '.ddswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ddswitch', 'providers.json'), JSON.stringify({ version: 1, agents: { zcode: { currentProfileId: null, profiles: [{ id: 'z1', name: 'x', createdAt: '', config: {} }] } } }));
  assert.throws(() => switchProvider(ENV(home), 'zcode', 'z1', { write: true }), /暂未开放/);
});

test('provider：生效中的 profile 不可删除', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "env": {} }');
  const { profile } = captureProfile(ENV(home), 'claude', '当前');
  // 生效中的 profile：dry-run 与真实删除都必须拒绝
  assert.throws(() => removeProfile(ENV(home), 'claude', profile.id, { write: false }), /正在生效/);
  assert.throws(() => removeProfile(ENV(home), 'claude', profile.id, { write: true }), /正在生效/);
  // 非生效 profile：dry-run 通过，真实删除成功
  const store = JSON.parse(fs.readFileSync(path.join(home, '.ddswitch', 'providers.json'), 'utf8'));
  store.agents.claude.profiles.push({ id: 'p2', name: '备用', createdAt: '', config: { kind: 'official', env: {} } });
  fs.writeFileSync(path.join(home, '.ddswitch', 'providers.json'), JSON.stringify(store, null, 2) + '\n');
  const dry = removeProfile(ENV(home), 'claude', 'p2', { write: false });
  assert.ok(fs.existsSync(path.join(home, '.ddswitch', 'providers.json')));
  assert.equal(dry.id, 'p2');
  removeProfile(ENV(home), 'claude', 'p2', { write: true });
  const storeAfter = JSON.parse(fs.readFileSync(path.join(home, '.ddswitch', 'providers.json'), 'utf8'));
  assert.equal(storeAfter.agents.claude.profiles.find((p) => p.id === 'p2'), undefined);
});
