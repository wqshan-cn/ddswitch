import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { createGeminiAdapter } from '../src/adapters/gemini.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

const ENV = (home) => ({ home, appdata: home, localappdata: home });

test('claude：~/.claude.json 带其他状态键时外科合并', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const cfg = path.join(home, '.claude.json');
  fs.writeFileSync(cfg, JSON.stringify({
    numStartups: 42,
    oauthAccount: { emailAddress: 'x@example.com' },
    projects: { 'C:/some/repo': { allowedTools: [] } },
    mcpServers: { old: { url: 'https://old' } },
  }, null, 2));

  const a = createClaudeAdapter();
  const env = ENV(home);
  assert.ok(a.detect(env));

  const rep = a.upsertMcp(env, [{ name: 'GitHub', raw: { url: 'https://gh' } }], { write: true });
  assert.equal(rep.added, 1);
  const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(data.numStartups, 42);                       // 状态键不动
  assert.deepEqual(data.oauthAccount, { emailAddress: 'x@example.com' });
  assert.deepEqual(Object.keys(data.projects['C:/some/repo']), ['allowedTools']);
  assert.equal(data.mcpServers.old.url, 'https://old');     // 已有 MCP 不动
  assert.equal(data.mcpServers.GitHub.url, 'https://gh');
});

test('claude：~/.claude.json 不存在但已安装时，detect 通过且写入可创建', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const a = createClaudeAdapter();
  const env = ENV(home);

  assert.ok(a.detect(env));
  const rep = a.upsertMcp(env, [{ name: 'x', raw: { url: 'https://x' } }], { write: true });
  assert.equal(rep.added, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers.x.url, 'https://x');
  assert.equal(fs.readdirSync(a.skillsDir(env)).length, 0); // skills 盘点可用
});

test('claude：两者都不存在时未检测到', () => {
  const a = createClaudeAdapter();
  assert.equal(a.detect(ENV(tmpHome())), null);
});

test('gemini：~/.gemini/settings.json 的 mcpServers', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const a = createGeminiAdapter();
  const env = ENV(home);

  assert.ok(a.detect(env));
  const rep = a.upsertMcp(env, [{ name: 'Context7', raw: { url: 'https://c7' } }], { write: true });
  assert.equal(rep.added, 1);
  const data = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(data.mcpServers.Context7.url, 'https://c7');
});
