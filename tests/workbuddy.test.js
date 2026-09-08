import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbuddyAdapter, workbuddyRootCandidates } from '../src/adapters/workbuddy.js';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-workbuddy-')); }
function env(platform, home) {
  return { platform, home, appdata: path.join(home, 'AppData', 'Roaming'), localappdata: path.join(home, 'AppData', 'Local') };
}
function fixture(platform = 'win32') {
  const home = tmpHome();
  const e = env(platform, home);
  const root = path.join(home, '.workbuddy');
  const cfg = path.join(root, 'connectors', 'default', 'mcp.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'connector:github': { url: 'https://example.com/mcp?token=secret', headers: { Authorization: 'Bearer secret' } } } }));
  return { home, e, root, cfg };
}

test('WorkBuddy：检测 default connector profile、skills、memory 且只读', () => {
  const { e, root } = fixture();
  const a = createWorkbuddyAdapter();
  assert.equal(a.detect(e).confidence, 'verified');
  assert.deepEqual(a.caps, { mcpRead: true, mcpWrite: false, mcpPreviewWrite: true, skillsWrite: false });
  assert.equal(a.listMcp(e)[0].name, 'connector:github');
  assert.equal(a.diagnose(e).count, 1);
  assert.equal(a.skillsDir(e), path.join(root, 'skills'));
  assert.ok(a.memoryPaths(e).includes(path.join(root, 'memory')));
  assert.throws(() => a.upsertMcp(e, [{ name: 'x', raw: { url: 'https://x' } }], { write: true }), /写入被禁用/);
  const dry = a.upsertMcp(e, [{ name: 'x', raw: { url: 'https://x' } }], { write: false });
  assert.equal(dry.added, 1);
});

test('WorkBuddy：三平台根候选与缺失配置 diagnose', () => {
  const home = tmpHome();
  assert.ok(workbuddyRootCandidates(env('win32', home)).some((p) => p.endsWith('.workbuddy')));
  assert.ok(workbuddyRootCandidates(env('darwin', home)).some((p) => p.includes(path.join('Library', 'Application Support', 'WorkBuddy'))));
  assert.ok(workbuddyRootCandidates(env('linux', home)).some((p) => p.includes(path.join('.config', 'workbuddy'))));

  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
  const a = createWorkbuddyAdapter();
  const d = a.diagnose(env('linux', home));
  assert.equal(d.exists, false);
  assert.ok(d.tried.length >= 2);
});
