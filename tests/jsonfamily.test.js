import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonFamilyAdapter } from '../src/adapters/jsonfamily.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

function makeQoderLike(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    enabledPlugins: { 'qoder-context@qoderapp-bundler': true },
    mcpServers: { GitHub: { url: 'https://api.example.com/mcp/', type: 'http', qoder_url: 'https://mcp.example/private' } },
  }, null, 2));
}

const ENV = { home: 'H', appdata: 'A', localappdata: 'L' };

test('upsert：新增服务器且保留其他顶层键与原有键序（写入模式）', () => {
  const file = path.join(tmp(), '.qoder', 'settings.json');
  makeQoderLike(file);
  const a = createJsonFamilyAdapter({
    id: 'qoder', displayName: 'Qoder',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: true }),
    detected: () => true,
  });

  const rep = a.upsertMcp(ENV, [
    { name: 'pubmed', raw: { type: 'stdio', command: 'node', args: ['server.js'] } },
  ], { write: true });

  assert.equal(rep.added, 1);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(data), ['enabledPlugins', 'mcpServers']); // 键序保留
  assert.equal(data.mcpServers.pubmed.command, 'node');
  assert.equal(data.mcpServers.GitHub.qoder_url, 'https://mcp.example/private'); // 私有字段不丢
  assert.ok(fs.existsSync(file + '.ddswitch.bak'));
  assert.ok(!fs.existsSync(file + '.ddswitch.tmp'));
});

test('upsert：dry-run 不写盘', () => {
  const file = path.join(tmp(), '.qoder', 'settings.json');
  makeQoderLike(file);
  const before = fs.readFileSync(file, 'utf8');
  const a = createJsonFamilyAdapter({
    id: 'qoder', displayName: 'Qoder',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: true }),
    detected: () => true,
  });

  const rep = a.upsertMcp(ENV, [{ name: 'x', raw: { url: 'https://x' } }], { write: false });
  assert.equal(rep.added, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before); // 文件未变
});

test('upsert：同名冲突默认跳过，update 模式覆盖', () => {
  const file = path.join(tmp(), '.qoder', 'settings.json');
  makeQoderLike(file);
  const a = createJsonFamilyAdapter({
    id: 'qoder', displayName: 'Qoder',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: true }),
    detected: () => true,
  });

  const skipRep = a.upsertMcp(ENV, [{ name: 'github', raw: { url: 'https://new' } }], { write: true });
  assert.equal(skipRep.skipped, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.GitHub.url, 'https://api.example.com/mcp/');

  const updRep = a.upsertMcp(ENV, [{ name: 'github', raw: { url: 'https://new' } }], { conflict: 'update', write: true });
  assert.equal(updRep.updated, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.GitHub.url, 'https://new');
});

test('upsert：文件不存在且允许创建时直接新建', () => {
  const dir = tmp();
  const file = path.join(dir, '.kimi', 'mcp.json');
  const a = createJsonFamilyAdapter({
    id: 'kimi', displayName: 'Kimi CLI',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: true }),
    detected: () => true,
  });

  const rep = a.upsertMcp(ENV, [{ name: 'Context7', raw: { url: 'https://mcp.context7.com/mcp' } }], { write: true });
  assert.equal(rep.added, 1);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.mcpServers.Context7.url, 'https://mcp.context7.com/mcp');
});

test('upsert：嵌套容器路径（ZCode 的 mcp.servers）与 normalizeKey', () => {
  const file = path.join(tmp(), '.zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ plugins: { enabledPlugins: {} }, mcp: { servers: {} } }, null, 2));
  const a = createJsonFamilyAdapter({
    id: 'zcode', displayName: 'ZCode',
    resolve: () => ({ file, containerPath: ['mcp', 'servers'], createIfMissing: true }),
    detected: () => true,
    normalizeKey: (name) => name.toLowerCase(),
  });

  a.upsertMcp(ENV, [{ name: 'Context7', raw: { url: 'https://c7' } }], { write: true });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(data.mcp.servers.context7); // 全小写规范
  assert.deepEqual(Object.keys(data.plugins.enabledPlugins), []); // 其他键保留
});

test('listMcp：过滤非对象条目并携带来源路径', () => {
  const file = path.join(tmp(), 's.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { A: { url: 'https://a' }, B: 'broken' } }));
  const a = createJsonFamilyAdapter({
    id: 't', displayName: 'T',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: false }),
  });
  const entries = a.listMcp(ENV);
  assert.deepEqual(entries.map((e) => e.name), ['A']);
  assert.equal(entries[0].source, file);
});

test('upsert：数组/标量根配置必须拒绝且原文件不变', () => {
  for (const bad of ['[]', 'null', '"text"']) {
    const file = path.join(tmp(), `bad-${Buffer.from(bad).toString('hex')}.json`);
    fs.writeFileSync(file, bad);
    const a = createJsonFamilyAdapter({
      id: 'bad', displayName: 'Bad',
      resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: false }),
    });
    assert.throws(() => a.upsertMcp(ENV, [{ name: 'x', raw: { url: 'https://x' } }], { write: true }), /配置根必须是 JSON 对象/);
    assert.equal(fs.readFileSync(file, 'utf8'), bad);
  }
});

test('list/diagnose/upsert：数组 MCP 容器不得当作映射处理', () => {
  const file = path.join(tmp(), 'array-container.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: [{ url: 'https://x' }] }));
  const a = createJsonFamilyAdapter({
    id: 'bad', displayName: 'Bad',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: false }),
  });
  assert.throws(() => a.listMcp(ENV), /MCP 容器必须是 JSON 对象/);
  assert.equal(a.diagnose(ENV).parse, 'error');
  assert.throws(() => a.upsertMcp(ENV, [{ name: 'x', raw: { url: 'https://x' } }], { write: true }), /MCP 容器必须是 JSON 对象/);
});

test('upsert：JSONC/尾逗号文件拒绝破坏性重写', () => {
  const file = path.join(tmp(), 'jsonc.json');
  const original = '{\n  "mcpServers": {"x": {"url": "https://x"}},\n}\n';
  fs.writeFileSync(file, original);
  const a = createJsonFamilyAdapter({
    id: 'jsonc', displayName: 'JSONC',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: false }),
  });
  assert.throws(() => a.upsertMcp(ENV, [{ name: 'y', raw: { url: 'https://y' } }], { write: true }), /拒绝破坏性重写/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('upsert：raw 为数组或 null 时拒绝', () => {
  const file = path.join(tmp(), 'valid.json');
  fs.writeFileSync(file, '{}');
  const a = createJsonFamilyAdapter({
    id: 'bad', displayName: 'Bad',
    resolve: () => ({ file, containerPath: ['mcpServers'], createIfMissing: true }),
  });
  assert.throws(() => a.upsertMcp(ENV, [{ name: 'x', raw: [] }], { write: true }), /非数组对象 raw/);
  assert.throws(() => a.upsertMcp(ENV, [{ name: 'x', raw: null }], { write: true }), /非数组对象 raw/);
});
