import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZcodeUsage, readCodexUsage } from '../src/usage-readers.js';
import { aggregateUsage, aggregateByDay } from '../src/usage-model.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddswitch-usage-'));
}

test('usage：空记录和缺失数据库安全返回不可用', async () => {
  const home = tempHome();
  const zcode = await readZcodeUsage({ home }, {});
  const codex = await readCodexUsage({ home }, {});
  assert.equal(zcode.available, false);
  assert.equal(codex.available, false);
  assert.deepEqual(zcode.records, []);
  assert.deepEqual(codex.records, []);
});

test('usage：provider total 优先、缺失值保持 null、按日聚合', () => {
  const records = [
    { source: 'zcode', granularity: 'request', requestId: 'r1', attemptIndex: 0, status: 'completed', startedAt: '2026-09-06T10:00:00.000Z', providerTotalTokens: 18, computedTotalTokens: 20, inputTokens: 10, outputTokens: 5, reasoningTokens: null, durationMs: 100 },
    { source: 'zcode', granularity: 'request', requestId: 'r1', attemptIndex: 0, status: 'completed', startedAt: '2026-09-06T10:00:00.000Z', providerTotalTokens: 18, computedTotalTokens: 20, inputTokens: 10, outputTokens: 5, reasoningTokens: null, durationMs: 100 },
    { source: 'zcode', granularity: 'request', requestId: 'r2', attemptIndex: 0, status: 'error', startedAt: '2026-09-06T11:00:00.000Z', providerTotalTokens: null, computedTotalTokens: 20, inputTokens: null, outputTokens: null, reasoningTokens: null, durationMs: null },
  ];
  const aggregate = aggregateUsage(records);
  assert.equal(aggregate.totals.totalTokens, 18);
  assert.equal(aggregate.totals.requestCount, 1);
  assert.equal(aggregate.totals.failureCount, 1);
  assert.deepEqual(aggregateByDay(records).map((x) => x.totalTokens), [18]);
});
