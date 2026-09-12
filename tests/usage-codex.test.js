import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexUsage } from '../src/usage-readers.js';
import { attachCosts, semanticsWarning, loadPricing } from '../src/usage-pricing.js';
import { aggregateUsage } from '../src/usage-model.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddswitch-codex-'));
}

function writeSession(home, day, name, lines) {
  const dir = path.join(home, '.codex', 'sessions', ...day.split('-'), '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('Codex JSONL：last_token_usage 逐事件解析、fresh 扣除缓存、模型跟随 turn_context', async () => {
  const home = tempHome();
  const day = '2026-09-10';
  writeSession(home, day, 'rollout-test.jsonl', [
    { timestamp: '2026-09-10T10:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1' } },
    { timestamp: '2026-09-10T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-x' } },
    { timestamp: '2026-09-10T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1160 } } } },
    { timestamp: '2026-09-10T10:01:05.000Z', type: 'turn_context', payload: { model: 'gpt-y' } },
    { timestamp: '2026-09-10T10:01:10.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 800, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 835 } } } },
    { timestamp: '2026-09-10T10:02:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'should not be read as usage' } },
  ]);
  const result = await readCodexUsage({ home }, {});
  assert.equal(result.mode, 'jsonl-request-level');
  assert.equal(result.records.length, 2);
  const [first, second] = result.records;
  assert.equal(first.sessionId, 'thread-1');
  assert.equal(first.modelId, 'gpt-x');
  assert.equal(first.inputTokens, 1000);
  assert.equal(first.cacheReadInputTokens, 600);
  assert.equal(first.cacheCreationInputTokens, 100);
  assert.equal(first.freshInputTokens, 300);
  assert.equal(first.inputSemantics, 'total');
  assert.equal(first.providerTotalTokens, 1160);
  assert.equal(second.modelId, 'gpt-y');
  assert.equal(second.requestId.includes('rollout-test.jsonl#'), true);
});

test('Codex JSONL：mtime 早于窗口起点整文件跳过', async () => {
  const home = tempHome();
  const day = '2026-09-01';
  writeSession(home, day, 'rollout-old.jsonl', [
    { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 't' } },
    { timestamp: '2026-09-01T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } } },
  ]);
  const old = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(path.join(home, '.codex', 'sessions', '2026', '09', '01', 'rollout-old.jsonl'), old, old);
  const start = new Date(Date.now() - 86400000).toISOString(); // 只看最近一天
  const result = await readCodexUsage({ home }, { start, end: new Date(Date.now() + 1000).toISOString() });
  assert.equal(result.records.length, 0);
});

test('成本估算：价格表缺失不报错，配置后按 fresh 计价', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.ddswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ddswitch', 'model-pricing.json'), JSON.stringify({
    version: 1,
    models: [{ modelId: 'gpt-x', inputCostPerMillion: '1', outputCostPerMillion: '2', cacheReadCostPerMillion: '0.1', cacheCreationCostPerMillion: '0' }],
  }));
  const pricing = loadPricing({ home });
  assert.equal(pricing.models.length, 1);
  const records = [
    { source: 'codex', status: 'completed', modelId: 'GPT-X', freshInputTokens: 300, outputTokens: 50, cacheReadInputTokens: 600, cacheCreationInputTokens: 100, inputSemantics: 'total', inputTokens: 1000 },
    { source: 'zcode', status: 'completed', modelId: 'unknown-model', inputTokens: 1000, inputSemantics: 'unknown' },
  ];
  const info = attachCosts(records, pricing);
  assert.equal(info.pricedRequests, 1);
  assert.equal(info.unpricedRequests, 1);
  assert.equal(Math.round(records[0].estimatedCostUsd * 1e6) / 1e6, 0.00046);
  assert.ok(semanticsWarning(records).includes('语义未知'));
});
