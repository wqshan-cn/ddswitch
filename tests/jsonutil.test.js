import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, getAt, ensureAt, readJsonLoose } from '../src/jsonutil.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

test('atomicWriteJson：首写无备份，覆盖有备份且无临时文件残留', () => {
  const dir = tmp();
  const p = path.join(dir, 'a', 'b.json');

  assert.equal(atomicWriteJson(p, { v: 1 }), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { v: 1 });

  const bak = atomicWriteJson(p, { v: 2 });
  assert.equal(bak, p + '.ddswitch.bak');
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, 'utf8')), { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { v: 2 });
  assert.ok(!fs.existsSync(p + '.ddswitch.tmp'));
});

test('readJsonLoose：容忍 BOM 与 JSONC 注释', () => {
  const dir = tmp();
  const p = path.join(dir, 'c.json');
  fs.writeFileSync(p, '\uFEFF{ // comment\n  "a": 1 /* block */\n}');
  assert.deepEqual(readJsonLoose(p), { a: 1 });
});

test('getAt / ensureAt：嵌套路径读写', () => {
  const data = { mcp: { servers: { github: { type: 'stdio' } } } };
  assert.equal(getAt(data, ['mcp', 'servers', 'github']).type, 'stdio');
  assert.equal(getAt(data, ['mcp', 'missing']), undefined);

  const empty = {};
  const container = ensureAt(empty, ['mcp', 'servers']);
  container.kimi = { url: 'x' };
  assert.equal(getAt(empty, ['mcp', 'servers', 'kimi']).url, 'x');
});

test('readJsonLoose：JSONC 状态机保留字符串内 //、块注释样式和 URL，并支持尾逗号', () => {
  const dir = tmp();
  const p = path.join(dir, 'safe.jsonc');
  fs.writeFileSync(p, `{
    // real comment
    "url": "https://example.com/a//b?x=1",
    "pattern": "a//b",
    "text": "/* keep */",
    "quote": "say \\"hi\\"",
    "array": [1, 2,],
  }`);
  const data = readJsonLoose(p);
  assert.equal(data.url, 'https://example.com/a//b?x=1');
  assert.equal(data.pattern, 'a//b');
  assert.equal(data.text, '/* keep */');
  assert.equal(data.quote, 'say "hi"');
  assert.deepEqual(data.array, [1, 2]);
});

test('readJsonLoose：未闭合块注释明确失败', () => {
  const dir = tmp();
  const p = path.join(dir, 'broken.jsonc');
  fs.writeFileSync(p, '{ "a": 1, /* never closes');
  assert.throws(() => readJsonLoose(p), /块注释未闭合/);
});
