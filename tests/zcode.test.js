import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZcodeAdapter } from '../src/adapters/zcode.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

function makeZcodeHome(home) {
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({
    plugins: { enabledPlugins: { 'github@zcode-plugins-official': true } },
    mcp: {
      servers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', 'x'], timeoutMs: 60000, enabled: true },
      },
    },
  }, null, 2));
  return cfg;
}

const ENV = (home) => ({ home, appdata: home, localappdata: home });

test('zcode：detect 与 listMcp', () => {
  const home = tmpHome();
  makeZcodeHome(home);
  const a = createZcodeAdapter();
  const env = ENV(home);

  assert.ok(a.detect(env));
  assert.ok(!a.detect(ENV(tmpHome()))); // 空目录未安装
  const entries = a.listMcp(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'github');
});

test('zcode：同步写入用小写键名，且不影响已有服务器与 plugins 键', () => {
  const home = tmpHome();
  const cfg = makeZcodeHome(home);
  const a = createZcodeAdapter();
  const env = ENV(home);

  const rep = a.upsertMcp(env, [
    { name: 'Context7', raw: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  ], { write: true });

  assert.equal(rep.added, 1);
  const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(data.mcp.servers.context7.url, 'https://mcp.context7.com/mcp'); // 小写规范
  assert.equal(data.mcp.servers.github.command, 'npx'); // 已有服务器不动
  assert.equal(data.plugins.enabledPlugins['github@zcode-plugins-official'], true); // 其他键保留
});

test('zcode：同名冲突（大小写不敏感）默认跳过', () => {
  const home = tmpHome();
  makeZcodeHome(home);
  const a = createZcodeAdapter();
  const env = ENV(home);

  const rep = a.upsertMcp(env, [
    { name: 'GitHub', raw: { url: 'https://new' } },
  ], { write: true });
  assert.equal(rep.skipped, 1);
  assert.equal(rep.added, 0);
});

test('zcode：skills 与记忆路径盘点', () => {
  const home = tmpHome();
  makeZcodeHome(home);
  fs.mkdirSync(path.join(home, '.zcode', 'skills', 'my-skill'), { recursive: true });
  fs.mkdirSync(path.join(home, '.zcode', 'cli', 'memories'), { recursive: true });

  const a = createZcodeAdapter();
  const env = ENV(home);
  const count = fs.readdirSync(a.skillsDir(env)).length;
  assert.equal(count, 1);
  assert.deepEqual(a.memoryPaths(env), [path.join(home, '.zcode', 'cli', 'memories')]);
});
