import path from 'node:path';
import fs from 'node:fs';
import { normalizeTimestamp, nullableInt, aggregateUsage, aggregateByDay, aggregateByModel } from './usage-model.js';

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
      const record = { source: 'zcode', granularity: 'request', ...r };
      record.startedAt = normalizeTimestamp(r.startedAt);
      record.completedAt = normalizeTimestamp(r.completedAt);
      for (const key of numeric) record[key] = nullableInt(r[key]);
      return record;
    }).filter((r) => withinRange(r.startedAt, start, end));
    return { source: 'zcode', available: true, records, file };
  } catch (e) { return { source: 'zcode', available: false, records: [], error: e.message, file }; }
  finally { try { db?.close(); } catch {} }
}

export async function readCodexUsage(env, { start = null, end = null } = {}) {
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
    const records = rows.map((r) => ({ source: 'codex', granularity: 'thread', requestId: null, sessionId: r.threadId, ...r, modelId: null, status: 'completed', startedAt: normalizeTimestamp(r.completedAt ?? r.createdAt), completedAt: normalizeTimestamp(r.completedAt), providerTotalTokens: nullableInt(r.providerTotalTokens), computedTotalTokens: null, inputTokens: null, outputTokens: null, reasoningTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, retryCount: null, toolCallCount: null, durationMs: null, errorType: null })).filter((r) => withinRange(r.startedAt, start, end));
    return { source: 'codex', available: true, records, file };
  } catch (e) { return { source: 'codex', available: false, records: [], error: e.message, file }; }
  finally { try { db?.close(); } catch {} }
}

export async function readUsage(env, range = {}) {
  const results = await Promise.all([readZcodeUsage(env, range), readCodexUsage(env, range)]);
  const records = results.flatMap((r) => r.records);
  const aggregate = aggregateUsage(records);
  return { ...aggregate, sources: results.map(({ source, available, error, file }) => ({ source, available, error, file })), timeseries: aggregateByDay(aggregate.records), breakdown: aggregateByModel(aggregate.records) };
}
