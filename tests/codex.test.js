import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMcpServers, upsertServerSegment, renderServerSegments } from '../src/toml-lite.js';
import { createCodexAdapter } from '../src/adapters/codex.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

const SAMPLE = `# 用户手写的顶部注释，必须逐字保留
model = "gpt-5"
disable_response_storage = true

[model_providers.custom]
base_url = "https://example.com/v1"

[mcp_servers]
[mcp_servers.node_repl]
command = "node"
args = ["repl.js", "--port", "8080"]
enabled = true

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = "D:/node/node.exe"

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"

[projects.'c:\\users\\x\\desktop\\生信']
trust_level = "trusted"
`;

const ENV = (home) => ({ home, appdata: home, localappdata: home });

test('toml-lite：读取 mcp_servers（含 .env 子表与其他段隔离）', () => {
  const servers = readMcpServers(SAMPLE);
  assert.deepEqual(servers.map((s) => s.name), ['node_repl', 'github']);

  const nodeRepl = servers[0].raw;
  assert.equal(nodeRepl.command, 'node');
  assert.deepEqual(nodeRepl.args, ['repl.js', '--port', '8080']);
  assert.equal(nodeRepl.enabled, true);
  assert.equal(nodeRepl.env.NODE_REPL_NODE_PATH, 'D:/node/node.exe');

  assert.equal(servers[1].raw.url, 'https://api.githubcopilot.com/mcp/');
});

test('toml-lite：新增段 append 到末尾且其他内容逐字保留', () => {
  const { text, changed } = upsertServerSegment(SAMPLE, 'Context7', {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
  });
  assert.ok(changed);
  assert.ok(text.startsWith(SAMPLE.split('\n')[0])); // 顶部注释原样
  assert.ok(text.includes("[projects.'c:\\users\\x\\desktop\\生信']")); // 其他段原样
  assert.ok(text.includes('# 用户手写的顶部注释'));
  const parsed = readMcpServers(text);
  assert.ok(parsed.find((s) => s.name === 'Context7'));
});

test('toml-lite：更新段原地替换（含 .env 子表重建），projects 段保留', () => {
  const { text } = upsertServerSegment(SAMPLE, 'node_repl', {
    command: 'npx',
    args: ['-y', 'new-repl'],
    env: { NEW_KEY: 'v1', NODE_REPL_NODE_PATH: 'D:/other/node.exe' },
  });
  const parsed = readMcpServers(text);
  const nr = parsed.find((s) => s.name === 'node_repl');
  assert.equal(nr.raw.command, 'npx');
  assert.deepEqual(nr.raw.args, ['-y', 'new-repl']);
  assert.equal(nr.raw.env.NEW_KEY, 'v1');
  assert.equal(nr.raw.env.NODE_REPL_NODE_PATH, 'D:/other/node.exe');
  assert.equal(parsed.find((s) => s.name === 'github').raw.url, 'https://api.githubcopilot.com/mcp/');
  assert.ok(text.includes("[projects.'c:\\users\\x\\desktop\\生信']"));
  assert.ok(!text.includes('repl.js')); // 旧 args 已被替换
});

test('toml-lite：删除段连同 .env 子表，其他段不动', () => {
  const { text, changed } = upsertServerSegment(SAMPLE, 'node_repl', null);
  assert.ok(changed);
  const parsed = readMcpServers(text);
  assert.ok(!parsed.find((s) => s.name === 'node_repl'));
  assert.ok(parsed.find((s) => s.name === 'github'));
  assert.ok(text.includes('# 用户手写的顶部注释'));
  assert.ok(text.includes('trust_level = "trusted"'));
  assert.ok(!text.includes('NODE_REPL_NODE_PATH'));
});

test('toml-lite：CRLF 文件正确处理', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const { text } = upsertServerSegment(crlf, 'newone', { url: 'https://x' });
  const parsed = readMcpServers(text);
  assert.ok(parsed.find((s) => s.name === 'newone'));
  assert.ok(parsed.find((s) => s.name === 'github'));
});

test('codex 适配器：listMcp / upsert / remove 全流程（写入临时 HOME）', () => {
  const home = tmpHome();
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, SAMPLE);

  const a = createCodexAdapter();
  const env = ENV(home);
  assert.ok(a.detect(env));
  assert.equal(a.listMcp(env).length, 2);

  // dry-run 新增
  const dry = a.upsertMcp(env, [{ name: 'pubmed', raw: { command: 'node', args: ['p.js'] } }], { write: false });
  assert.equal(dry.added, 1);
  assert.ok(!fs.readFileSync(cfg, 'utf8').includes('pubmed')); // 未写盘

  // 写入新增
  const rep = a.upsertMcp(env, [{ name: 'pubmed', raw: { command: 'node', args: ['p.js'], env: { K: 'V' } } }], { write: true });
  assert.equal(rep.added, 1);
  const parsed = readMcpServers(fs.readFileSync(cfg, 'utf8'));
  assert.equal(parsed.find((s) => s.name === 'pubmed').raw.env.K, 'V');
  assert.ok(fs.existsSync(cfg + '.ddswitch.bak'));

  // 同名冲突跳过
  const skip = a.upsertMcp(env, [{ name: 'Pubmed', raw: { url: 'https://new' } }], { write: true });
  assert.equal(skip.skipped, 1);

  // 删除（dry-run 再 real）
  const rmDry = a.removeMcp(env, ['pubmed'], { write: false });
  assert.equal(rmDry.removed, 1);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('pubmed'));
  const rm = a.removeMcp(env, ['pubmed'], { write: true });
  assert.equal(rm.removed, 1);
  assert.ok(!readMcpServers(fs.readFileSync(cfg, 'utf8')).find((s) => s.name === 'pubmed'));
});

test('codex 适配器：未安装时 detect 为空，首写可创建带头的 config.toml', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const a = createCodexAdapter();
  const env = ENV(home);
  const rep = a.upsertMcp(env, [{ name: 'x', raw: { url: 'https://x' } }], { write: true });
  assert.equal(rep.added, 1);
  const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(text.includes('# [mcp_servers.*] 段由 ddswitch 管理'));
  assert.ok(text.includes('[mcp_servers.x]'));
});

test('toml-lite：renderServerSegments 输出可被自身解析（roundtrip）', () => {
  const lines = renderServerSegments('My.Server', {
    command: 'npx',
    args: ['-y', 'a b'],
    enabled: true,
    env: { 'A-B': 'x', TOKEN: 'secret value' },
  });
  const parsed = readMcpServers(lines.join('\n'));
  assert.equal(parsed[0].name, 'My.Server');
  assert.deepEqual(parsed[0].raw.args, ['-y', 'a b']);
  assert.equal(parsed[0].raw.env['A-B'], 'x');
  assert.equal(parsed[0].raw.env.TOKEN, 'secret value');
});

test('toml-lite：同一 MCP 的 base/env 非连续时不吞中间无关段', () => {
  const sample = `[mcp_servers.foo]
command = "old"

[projects.middle]
trust_level = "trusted"

[mcp_servers.foo.env]
TOKEN = "old-secret"
`;
  const updated = upsertServerSegment(sample, 'foo', { command: 'new', env: { TOKEN: 'new-secret' } }).text;
  assert.ok(updated.includes('[projects.middle]'));
  assert.ok(updated.includes('trust_level = "trusted"'));
  assert.equal(readMcpServers(updated).find((s) => s.name === 'foo').raw.command, 'new');

  const removed = upsertServerSegment(sample, 'foo', null).text;
  assert.ok(removed.includes('[projects.middle]'));
  assert.ok(removed.includes('trust_level = "trusted"'));
  assert.ok(!readMcpServers(removed).find((s) => s.name === 'foo'));
});

test('toml-lite：无法编码的 null/非法 args/env 值必须阻止写入', () => {
  assert.throws(() => renderServerSegments('x', { metadata: null }), /无法编码字段 x.metadata/);
  assert.throws(() => renderServerSegments('x', { args: ['a', 1] }), /args 必须是字符串数组/);
  assert.throws(() => renderServerSegments('x', { env: { TOKEN: ['x'] } }), /env.TOKEN 必须是字符串、数字或布尔值/);
});

test('codex 适配器：编码失败时原文件逐字节不变', () => {
  const home = tmpHome();
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, SAMPLE);
  const before = fs.readFileSync(cfg, 'utf8');
  const a = createCodexAdapter();
  assert.throws(() => a.upsertMcp(ENV(home), [{ name: 'bad', raw: { metadata: null } }], { write: true }), /无法编码字段/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
});

test('toml-lite：更新 CRLF 文件保留 CRLF 风格', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const text = upsertServerSegment(crlf, 'node_repl', { command: 'new' }).text;
  assert.ok(text.includes('\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(text));
});

test('toml-lite：未闭合 basic/literal 字符串拒绝读取', () => {
  assert.throws(() => readMcpServers('[mcp_servers.x]\ncommand = "abc\n'), /字符串未闭合/);
  assert.throws(() => readMcpServers("[mcp_servers.x]\ncommand = 'abc\n"), /字符串未闭合/);
});
