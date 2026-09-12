import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { dirExists, fileExists, safeJoin, isSafeSegment } from './jsonutil.js';
import { normalizeTimestamp, nullableInt, aggregateUsage, aggregateByDay, aggregateByModel } from './usage-model.js';
import { loadPricing, attachCosts, semanticsWarning } from './usage-pricing.js';

let sqliteModule;
async function getSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try { sqliteModule = await import('node:sqlite'); }
  catch { sqliteModule = null; }
  return sqliteModule;
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name))); }
  catch { return new Set(); }
}
function safeField(columns, name, alias = name) { return columns.has(name) ? `${name} AS ${alias}` : `NULL AS ${alias}`; }
function withinRange(value, start, end) {
  if (!value) return true;
  const t = Date.parse(value);
  const startMs = start ? (typeof start === 'number' ? start : Date.parse(start)) : null;
  const endMs = end ? (typeof end === 'number' ? end : Date.parse(end)) : null;
  return (!startMs || t >= startMs) && (!endMs || t < endMs);
}
function openReadonly(DatabaseSync, file) { return new DatabaseSync(file, { readOnly: true }); }

export async function readZcodeUsage(env, { start = null, end = null } = {}) {
  const file = path.join(env.home, '.zcode', 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(file)) return { source: 'zcode', available: false, records: [], error: 'ZCode usage database not found' };
  const sqlite = await getSqlite();
  if (!sqlite?.DatabaseSync) return { source: 'zcode', available: false, records: [], error: 'This Node runtime has no node:sqlite support' };
  let db;
  try {
    db = openReadonly(sqlite.DatabaseSync, file);
    const columns = tableColumns(db, 'model_usage');
    if (!columns.size) return { source: 'zcode', available: false, records: [], error: 'model_usage table not found' };
    const fields = [
      ['provider_id', 'providerId'], ['model_id', 'modelId'], ['variant', 'variant'], ['session_id', 'sessionId'], ['turn_id', 'turnId'],
      ['logical_request_id', 'requestId'], ['attempt_index', 'attemptIndex'], ['status', 'status'], ['started_at', 'startedAt'], ['completed_at', 'completedAt'],
      ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['reasoning_tokens', 'reasoningTokens'], ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
      ['cache_read_input_tokens', 'cacheReadInputTokens'], ['provider_total_tokens', 'providerTotalTokens'], ['computed_total_tokens', 'computedTotalTokens'],
      ['retry_count', 'retryCount'], ['tool_call_count', 'toolCallCount'], ['duration_ms', 'durationMs'], ['error_type', 'errorType'],
    ];
    const sql = `SELECT ${fields.map(([n, a]) => safeField(columns, n, a)).join(', ')} FROM model_usage`;
    const rows = db.prepare(sql).all();
    const numeric = new Set(['attemptIndex', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'providerTotalTokens', 'computedTotalTokens', 'retryCount', 'toolCallCount', 'durationMs']);
    const records = rows.map((r) => {
      const record = { source: 'zcode', granularity: 'request', inputSemantics: 'unknown', ...r };
      record.startedAt = normalizeTimestamp(r.startedAt);
      record.completedAt = normalizeTimestamp(r.completedAt);
      for (const key of numeric) record[key] = nullableInt(r[key]);
      record.freshInputTokens = null; // ZCode 各 provider 中转语义不一，无法确定 fresh/total，保持未知
      return record;
    }).filter((r) => withinRange(r.startedAt, start, end));
    return { source: 'zcode', available: true, records, file };
  } catch (e) { return { source: 'zcode', available: false, records: [], error: e.message, file }; }
  finally { try { db?.close(); } catch {} }
}

/**
 * Codex JSONL 请求级解析（对标 CC Switch session_usage_codex 的思路）：
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * - session_meta.payload.id → threadId
 * - turn_context.payload.model → 当前模型（可能随 turn 变化）
 * - event_msg(type=token_count).payload.info.last_token_usage → 单次调用精确用量
 *   （OpenAI 语义：input_tokens 含 cached/cache_write，因此 fresh 需扣除）
 * 事件没有 requestId，用「文件相对路径#行号」做稳定去重键。
 */
async function readCodexJsonlUsage(env, { start = null, end = null } = {}) {
  const sessionsDir = safeJoin(env.home, '.codex', 'sessions');
  if (!dirExists(sessionsDir)) return { records: [], scanned: 0, note: 'no sessions dir' };
  const startMs = start ? Date.parse(start) : null;
  const files = [];
  (function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // readdir 只返回 basename，仍显式校验后再 safeJoin，保证全链路防穿越
      if (!isSafeSegment(e.name)) continue;
      const full = safeJoin(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          // 会话文件只追加：mtime 早于窗口起点则整文件跳过
          if (startMs && st.mtimeMs < startMs) return;
          files.push({ full, rel: path.relative(sessionsDir, full) });
        } catch { /* 跳过不可访问文件 */ }
      }
    }
  })(sessionsDir, 0);

  const records = [];
  for (const { full, rel } of files) {
    if (!fileExists(full)) continue;
    let rl;
    try {
      rl = readline.createInterface({ input: fs.createReadStream(full, 'utf8'), crlfDelay: Infinity });
      let lineNo = 0;
      let threadId = null;
      let model = null;
      for await (const line of rl) {
        lineNo++;
        // 快速预筛（借鉴 CC Switch：字符串包含判断先于 JSON.parse）
        if (!line.includes('token_count') && !line.includes('turn_context') && !line.includes('session_meta')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const type = event?.type;
        if (type === 'session_meta') { threadId = event.payload?.id ?? null; continue; }
        if (type === 'turn_context') { model = typeof event.payload?.model === 'string' ? event.payload.model : model; continue; }
        if (type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
        const usage = event.payload?.info?.last_token_usage ?? {};
        const input = nullableInt(usage.input_tokens);
        const cached = nullableInt(usage.cached_input_tokens);
        const cacheWrite = nullableInt(usage.cache_write_input_tokens);
        const fresh = input !== null ? Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)) : null;
        records.push({
          source: 'codex', granularity: 'request',
          providerId: null, modelId: model, variant: null,
          sessionId: threadId, turnId: null,
          requestId: `${rel}#${lineNo}`, attemptIndex: 0,
          startedAt: normalizeTimestamp(event.timestamp), completedAt: null,
          status: 'completed',
          inputTokens: input, outputTokens: nullableInt(usage.output_tokens),
          reasoningTokens: nullableInt(usage.reasoning_output_tokens),
          cacheCreationInputTokens: cacheWrite, cacheReadInputTokens: cached,
          freshInputTokens: fresh,
          providerTotalTokens: nullableInt(usage.total_tokens), computedTotalTokens: null,
          retryCount: null, toolCallCount: null, durationMs: null, errorType: null,
          inputSemantics: 'total',
        });
      }
    } catch (e) { /* 单文件损坏不影响整体 */ }
    finally { try { rl?.close(); } catch { /* ignore */ } }
  }
  return { records, scanned: files.length };
}

export async function readCodexUsage(env, range = {}) {
  // 优先 JSONL 请求级精确数据；不可用/无数据时回退 threads 表 thread 级估算
  const jsonl = await readCodexJsonlUsage(env, range);
  if (jsonl.records.length > 0) {
    return { source: 'codex', available: true, records: jsonl.records, mode: 'jsonl-request-level', note: `从 ${jsonl.scanned} 个会话文件解析` };
  }
  const fallback = await readCodexThreadsUsage(env, range);
  return { ...fallback, mode: 'threads-estimate', note: 'JSONL 无 token_count 事件，回退 thread 级估算' };
}

async function readCodexThreadsUsage(env, { start = null, end = null } = {}) {
  const file = path.join(env.home, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(file)) return { source: 'codex', available: false, records: [], error: 'Codex state database not found' };
  const sqlite = await getSqlite();
  if (!sqlite?.DatabaseSync) return { source: 'codex', available: false, records: [], error: 'This Node runtime has no node:sqlite support' };
  let db;
  try {
    db = openReadonly(sqlite.DatabaseSync, file);
    const columns = tableColumns(db, 'threads');
    if (!columns.size) return { source: 'codex', available: false, records: [], error: 'threads table not found' };
    const fields = [
      ['id', 'threadId'], ['model_provider', 'providerId'], ['tokens_used', 'providerTotalTokens'],
      ['created_at', 'createdAt'], ['updated_at', 'completedAt'], ['source', 'threadSource'],
    ];
    const rows = db.prepare(`SELECT ${fields.map(([n, a]) => safeField(columns, n, a)).join(', ')} FROM threads`).all();
    const records = rows.map((r) => ({ source: 'codex', granularity: 'thread', requestId: null, sessionId: r.threadId, ...r, modelId: null, status: 'completed', startedAt: normalizeTimestamp(r.completedAt ?? r.createdAt), completedAt: normalizeTimestamp(r.completedAt), providerTotalTokens: nullableInt(r.providerTotalTokens), computedTotalTokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, freshInputTokens: null, retryCount: null, toolCallCount: null, durationMs: null, errorType: null, inputSemantics: 'total' })).filter((r) => withinRange(r.startedAt, start, end));
    return { source: 'codex', available: true, records, file };
  } catch (e) { return { source: 'codex', available: false, records: [], error: e.message, file }; }
  finally { try { db?.close(); } catch {} }
}

export async function readUsage(env, range = {}) {
  const results = await Promise.all([readZcodeUsage(env, range), readCodexUsage(env, range)]);
  const records = results.flatMap((r) => r.records);
  const pricing = loadPricing(env);
  const costInfo = attachCosts(records, pricing);
  const aggregate = aggregateUsage(records);
  return {
    ...aggregate,
    totals: { ...aggregate.totals, estimatedCostUsd: costInfo.totalEstimatedCostUsd || null, pricedRequests: costInfo.pricedRequests, unpricedRequests: costInfo.unpricedRequests, pricingConfigured: pricing.models.length > 0, pricingError: pricing.error || null },
    semanticsWarning: semanticsWarning(records),
    sources: results.map(({ source, available, error, file, mode, note }) => ({ source, available, error, file, mode, note })),
    timeseries: aggregateByDay(aggregate.records),
    breakdown: aggregateByModel(aggregate.records),
  };
}
