import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDataDirCandidates } from '../src/adapters/index.js';
import { createJsonFamilyAdapter } from '../src/adapters/jsonfamily.js';
import { createCodexAdapter } from '../src/adapters/codex.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

/** 构造模拟某平台的 fake env。 */
function fakeEnv(platform, home) {
  return {
    platform,
    home,
    appdata: path.join(home, 'AppData', 'Roaming'),
    localappdata: path.join(home, 'AppData', 'Local'),
  };
}

test('appDataDirCandidates：三平台按各自惯例展开', () => {
  const home = tmpHome();
  const win = appDataDirCandidates(fakeEnv('win32', home), ['Trae CN', 'Trae']);
  assert.deepEqual(win, [
    path.join(home, 'AppData', 'Roaming', 'Trae CN'),
    path.join(home, 'AppData', 'Roaming', 'Trae'),
  ]);

  const mac = appDataDirCandidates(fakeEnv('darwin', home), ['Trae CN']);
  assert.deepEqual(mac, [path.join(home, 'Library', 'Application Support', 'Trae CN')]);

  const linuxEnv = fakeEnv('linux', home);
  const linux = appDataDirCandidates(linuxEnv, ['Trae']);
  assert.deepEqual(linux, [path.join(home, '.config', 'Trae')]);

  // XDG_CONFIG_HOME 优先
  const xdg = tmpHome();
  const linuxXdg = appDataDirCandidates(
    { ...fakeEnv('linux', xdg), platform: 'linux' },
    ['Trae']
  );
  assert.equal(linuxXdg[0], path.join(xdg, '.config', 'Trae'));
});

test('Trae 适配器：darwin 平台上探测 ~/Library/Application Support 下的变体', async () => {
  const { registry } = await import('../src/adapters/index.js');
  const home = tmpHome();
  const env = fakeEnv('darwin', home);
  // 模拟 mac 上装了国际版 Trae
  const base = path.join(home, 'Library', 'Application Support', 'Trae', 'User');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'mcp.json'), JSON.stringify({ mcpServers: { A: { url: 'https://a' } } }));

  const trae = registry().find((a) => a.id === 'trae');
  assert.ok(trae.detect(env), 'darwin 下的 Trae 应被检测到');
  assert.equal(trae.detect(env).confidence, 'verified');
  const entries = trae.listMcp(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'A');
});

test('Trae 适配器：linux 平台探测 ~/.config 下变体', async () => {
  const { registry } = await import('../src/adapters/index.js');
  const home = tmpHome();
  const env = fakeEnv('linux', home);
  const base = path.join(home, '.config', 'Trae CN', 'User');
  fs.mkdirSync(base, { recursive: true });

  const trae = registry().find((a) => a.id === 'trae');
  assert.ok(trae.detect(env));
  // 未配置过 MCP：listMcp 为空，doctor 诊断显示"不存在，首写会创建"
  assert.deepEqual(trae.listMcp(env), []);
  const d = trae.diagnose(env);
  assert.equal(d.exists, false);
  assert.ok(d.tried.some((p) => p.includes(path.join('.config', 'Trae CN', 'User', 'mcp.json'))));
});

test('CodeBuddy 适配器：inferred 置信度 + 只读能力（未实测不写盘）', async () => {
  const { registry } = await import('../src/adapters/index.js');
  const home = tmpHome();
  const env = fakeEnv('win32', home);
  const base = path.join(home, 'AppData', 'Roaming', 'CodeBuddy', 'User');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'mcp.json'), JSON.stringify({ mcpServers: { B: { url: 'https://b' } } }));

  const cb = registry().find((a) => a.id === 'codebuddy');
  assert.ok(cb.detect(env));
  assert.equal(cb.detect(env).confidence, 'inferred');
  assert.deepEqual(cb.caps, { mcpRead: true, mcpWrite: false });

  const entries = cb.listMcp(env);
  assert.equal(entries[0].name, 'B');

  // 写入被拒绝
  assert.throws(() => cb.upsertMcp(env, [{ name: 'x', raw: { url: 'https://x' } }], { write: true }));
});

test('置信度默认值：同构家族默认 verified，可解析性 diagnose 全覆盖', async () => {
  const { registry } = await import('../src/adapters/index.js');
  const home = tmpHome();
  const env = fakeEnv('win32', home);
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { a: { command: 'x' } } } }));

  const reg = registry();
  const zcode = reg.find((a) => a.id === 'zcode');
  assert.equal(zcode.detect(env).confidence, 'verified');

  const d = zcode.diagnose(env);
  assert.equal(d.parse, 'ok');
  assert.equal(d.count, 1);

  // 损坏的配置文件：parse=error 而不是崩溃
  fs.writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), '{ broken json !!');
  const d2 = zcode.diagnose(env);
  assert.equal(d2.parse, 'error');
  assert.ok(d2.error);

  const codex = reg.find((a) => a.id === 'codex');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand = "n"\n');
  assert.equal(codex.diagnose(env).count, 1);
});
