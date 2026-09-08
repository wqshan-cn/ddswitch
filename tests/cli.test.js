import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'AgentHub-CLI-')); }
function fakeEnv(home) {
  return { platform: process.platform, home, appdata: path.join(home, 'AppData', 'Roaming'), localappdata: path.join(home, 'AppData', 'Local') };
}
function capture(home, args) {
  const stdout = [], stderr = [];
  const oldLog = console.log, oldError = console.error;
  console.log = (...items) => stdout.push(items.join(' '));
  console.error = (...items) => stderr.push(items.join(' '));
  try {
    return { status: run(args, fakeEnv(home)), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

test('CLI：--from 保留大写文件名，合法 dry-run 返回 0', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), '{}');
  const exportFile = path.join(home, 'MixedCaseExport.JSON');
  fs.writeFileSync(exportFile, JSON.stringify({ servers: { GitHub: { url: 'https://example.com/mcp' } } }));
  const r = capture(home, ['mcp', 'sync', '--from', exportFile, '--to', 'opencode']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(exportFile));
  assert.ok(r.stdout.includes('GitHub'));
});

test('CLI：sync/skills deploy 目标失败返回非零', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), '{}');
  const exportFile = path.join(home, 'export.json');
  fs.writeFileSync(exportFile, JSON.stringify({ servers: { x: { url: 'https://x' } } }));
  const sync = capture(home, ['mcp', 'sync', '--from', exportFile, '--to', 'opencode,nosuch']);
  assert.equal(sync.status, 1, sync.stderr + sync.stdout);
  assert.ok(sync.stdout.includes('未处理目标 1'));

  fs.mkdirSync(path.join(home, '.zcode', 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
  fs.writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), '{"mcp":{"servers":{}}}');
  const skills = capture(home, ['skills', 'deploy', '--from', 'zcode', '--to', 'nosuch']);
  assert.equal(skills.status, 1, skills.stderr + skills.stdout);
});

test('CLI：脱敏导出不能直接回灌，include-secrets 导出可回灌', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.qoder'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.qoder', 'settings.json'), JSON.stringify({
    mcpServers: { secret: { url: 'https://example.com/mcp?token=abc', headers: { Authorization: 'Bearer abc' }, env: { API_KEY: 'abc' } } },
  }));
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), '{}');

  const safeFile = path.join(home, 'safe.json');
  assert.equal(capture(home, ['mcp', 'export', '--agent', 'qoder', '--out', safeFile]).status, 0);
  const safeText = fs.readFileSync(safeFile, 'utf8');
  assert.ok(!safeText.includes('Bearer abc'));
  assert.ok(!safeText.includes('"API_KEY": "abc"'));
  assert.equal(capture(home, ['mcp', 'sync', '--from', safeFile, '--to', 'opencode']).status, 1);

  const rawFile = path.join(home, 'raw.json');
  assert.equal(capture(home, ['mcp', 'export', '--agent', 'qoder', '--out', rawFile, '--include-secrets']).status, 0);
  assert.ok(fs.readFileSync(rawFile, 'utf8').includes('Bearer abc'));
  assert.equal(capture(home, ['mcp', 'sync', '--from', rawFile, '--to', 'opencode']).status, 0);
});

test('CLI：WorkBuddy list 不泄露 URL 查询参数或 headers', () => {
  const home = tmpHome();
  const cfg = path.join(home, '.workbuddy', 'connectors', 'default', 'mcp.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: { wb: { url: 'https://example.com/mcp?token=TOPSECRET', headers: { Authorization: 'Bearer TOPSECRET' } } },
  }));
  const r = capture(home, ['mcp', 'list', '--agent', 'workbuddy']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes('https://example.com/mcp'));
  assert.ok(!r.stdout.includes('TOPSECRET'));
});
