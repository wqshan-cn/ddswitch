import fs from 'node:fs';
import path from 'node:path';
import { fileExists, safeJoin } from './jsonutil.js';

/**
 * 模型价格表（借鉴 CC Switch model-pricing.json 的做法）：
 * ~/.ddswitch/model-pricing.json
 * {
 *   "version": 1,
 *   "models": [
 *     { "modelId": "glm-5.3-flash", "inputCostPerMillion": "0.5",
 *       "outputCostPerMillion": "2", "cacheReadCostPerMillion": "0.1",
 *       "cacheCreationCostPerMillion": "0" }
 *   ]
 * }
 * 金额单位为美元/百万 token。默认不内置任何价格（中转价与官方价差异大，
 * 猜测会产生误导性账单），由用户按自己的供应商价格配置。
 */

export function pricingPath(env) {
  return safeJoin(env.home, '.ddswitch', 'model-pricing.json');
}

export function loadPricing(env) {
  const file = pricingPath(env);
  if (!fileExists(file)) return { file, models: [], exists: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.models)) return { file, models: [], exists: true, error: 'models 字段缺失' };
    return { file, models: data.models.filter((m) => m && typeof m.modelId === 'string'), exists: true };
  } catch (e) {
    return { file, models: [], exists: true, error: e.message };
  }
}

function priceFor(pricing, modelId) {
  if (!modelId) return null;
  const key = String(modelId).toLowerCase();
  return pricing.models.find((m) => m.modelId.toLowerCase() === key) || null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 给单条记录附加 estimatedCostUsd；fresh 优先，OpenAI 语义回退时扣 cache。 */
export function estimateRecordCost(record, pricing) {
  const price = priceFor(pricing, record.modelId);
  if (!price) return null;
  const input = num(price.inputCostPerMillion);
  const output = num(price.outputCostPerMillion);
  const cacheRead = num(price.cacheReadCostPerMillion);
  const cacheCreation = num(price.cacheCreationCostPerMillion);
  if ([input, output, cacheRead, cacheCreation].some((v) => v === null)) return null;
  let fresh = record.freshInputTokens;
  if (fresh === null || fresh === undefined) {
    if (record.inputSemantics === 'total' && record.inputTokens !== null) {
      fresh = Math.max(0, record.inputTokens - (record.cacheReadInputTokens ?? 0) - (record.cacheCreationInputTokens ?? 0));
    } else {
      fresh = record.inputTokens; // 语义未知时按原值估算并在 UI 标注不确定性
    }
  }
  if (fresh === null || fresh === undefined) return null;
  const cost = (fresh * input + (record.outputTokens ?? 0) * output
    + (record.cacheReadInputTokens ?? 0) * cacheRead
    + (record.cacheCreationInputTokens ?? 0) * cacheCreation) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export function attachCosts(records, pricing) {
  let priced = 0;
  let totalCost = 0;
  for (const r of records) {
    const cost = estimateRecordCost(r, pricing);
    if (cost === null) continue;
    r.estimatedCostUsd = cost;
    if (['completed', 'success', 'finished'].includes(r.status)) {
      priced++;
      totalCost += cost;
    }
  }
  return { pricedRequests: priced, unpricedRequests: records.length - priced, totalEstimatedCostUsd: Math.round(totalCost * 1e6) / 1e6 };
}

/** 汇总语义告警：跨 provider 的 input_tokens 语义不一致（Anthropic fresh vs OpenAI total）。 */
export function semanticsWarning(records) {
  const semantics = new Set(records.filter((r) => ['completed', 'success', 'finished'].includes(r.status)).map((r) => r.inputSemantics || 'unknown'));
  if (semantics.has('unknown')) return '部分来源的 input_tokens 语义未知（fresh/total 不确定），跨模型直接对比可能有偏差';
  if (semantics.size > 1) return '来源混合了 fresh 与 total 两种 input 语义，汇总值已按各自语义标注';
  return null;
}
