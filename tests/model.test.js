import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, redactMcpDefinition } from '../src/model.js';

test('summarize：隐藏命令参数与 URL 查询串', () => {
  const stdio = summarize({ command: 'node', args: ['--token', 'secret'] });
  assert.ok(stdio.includes('2 个参数'));
  assert.ok(!stdio.includes('secret'));
  const http = summarize({ url: 'https://user:pass@example.com/mcp?token=secret#x', type: 'http' });
  assert.ok(http.includes('https://example.com/mcp'));
  assert.ok(!http.includes('secret'));
  assert.ok(!http.includes('pass'));
});

test('redactMcpDefinition：脱敏 env/headers/敏感键/URL/命令参数', () => {
  const raw = {
    url: 'https://example.com/mcp?token=abc',
    env: { API_KEY: 'abc', NORMAL: 'visible' },
    headers: { Authorization: 'Bearer abc', Accept: 'json' },
    args: ['--token', 'abc', '--api-key=xyz', 'visible'],
    nested: { password: 'p', safe: 'ok' },
  };
  const redacted = redactMcpDefinition(raw);
  const text = JSON.stringify(redacted);
  assert.ok(!text.includes('Bearer abc'));
  assert.ok(!text.includes('"API_KEY":"abc"'));
  assert.ok(!text.includes('"password":"p"'));
  assert.ok(!text.includes('token=abc'));
  assert.ok(!text.includes('api-key=xyz'));
  assert.ok(text.includes('visible'));
  assert.equal(raw.env.API_KEY, 'abc', '不得修改源对象');
});

test('redactMcpDefinition：非法 URL 也不能原样泄露', () => {
  const redacted = redactMcpDefinition({ url: 'https://user:pass@example.com/mcp?token=TOPSECRET%ZZ#frag' });
  assert.ok(!JSON.stringify(redacted).includes('TOPSECRET'));
  assert.ok(!JSON.stringify(redacted).includes('user:pass'));
});
