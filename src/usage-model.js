/** Safe, source-tagged usage records. Unknown numeric values stay null. */

export function nullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return new Date(n < 10_000_000_000 ? n * 1000 : n).toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function effectiveTokens(record) {
  return record.providerTotalTokens ?? record.computedTotalTokens ?? null;
}

export function dedupeRecords(records) {
  const map = new Map();
  for (const record of records) {
    const key = record.requestId
      ? `${record.source}:request:${record.requestId}:${record.attemptIndex ?? 0}`
      : `${record.source}:${record.granularity}:${record.sessionId ?? record.threadId ?? record.startedAt}:${record.modelId ?? ''}`;
    map.set(key, record);
  }
  return [...map.values()];
}

export function aggregateUsage(records) {
  const unique = dedupeRecords(records);
  const successful = unique.filter((r) => r.status === 'completed' || r.status === 'success' || r.status === 'finished');
  const totals = {
    totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    requestCount: successful.length, failureCount: unique.filter((r) => r.status && !['completed', 'success', 'finished'].includes(r.status)).length,
    unknownTokenRecords: 0, totalDurationMs: 0,
  };
  for (const r of successful) {
    const total = effectiveTokens(r);
    if (total === null) totals.unknownTokenRecords++;
    else totals.totalTokens += total;
    for (const [key, target] of [
      ['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['reasoningTokens', 'reasoningTokens'],
      ['cacheCreationInputTokens', 'cacheCreationInputTokens'], ['cacheReadInputTokens', 'cacheReadInputTokens'],
    ]) if (r[key] !== null) totals[target] += r[key];
    if (r.durationMs !== null && r.durationMs !== undefined && Number.isFinite(r.durationMs)) totals.totalDurationMs += r.durationMs;
  }
  totals.averageDurationMs = totals.requestCount ? Math.round(totals.totalDurationMs / totals.requestCount) : null;
  return { records: unique, successful, totals };
}

export function aggregateByDay(records) {
  const out = new Map();
  for (const r of dedupeRecords(records).filter((x) => ['completed', 'success', 'finished'].includes(x.status))) {
    const day = r.startedAt?.slice(0, 10) || 'unknown';
    const row = out.get(day) || { day, totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 };
    row.totalTokens += effectiveTokens(r) ?? 0;
    row.inputTokens += r.inputTokens ?? 0;
    row.outputTokens += r.outputTokens ?? 0;
    row.requestCount++;
    out.set(day, row);
  }
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function aggregateByModel(records) {
  const out = new Map();
  for (const r of records) {
    const key = `${r.source}|${r.providerId ?? 'unknown'}|${r.modelId ?? 'unknown'}`;
    const row = out.get(key) || { source: r.source, granularity: r.granularity, providerId: r.providerId, modelId: r.modelId, totalTokens: 0, requestCount: 0, failureCount: 0 };
    if (['completed', 'success', 'finished'].includes(r.status)) {
      row.totalTokens += effectiveTokens(r) ?? 0;
      row.requestCount++;
    } else row.failureCount++;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
