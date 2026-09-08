/**
 * 面向 Codex config.toml 的 [mcp_servers.*] 极简段级读写。
 *
 * 设计约束：只做「段级 splice」——绝不整体重排文件，用户手写的注释、
 * 空行、其他段（[projects.*]、[plugins.*]、[model_providers.*] 等）逐字保留。
 * Codex 禁止用 TOML 库整体反序列化再序列化（会丢注释、重排键序）。
 *
 * 支持的语法子集（实测 Codex config.toml 覆盖）：
 * - 段头 key：bare（node_repl）、basic "…"、literal '…'（含 Windows 路径/中文）
 * - [mcp_servers.<name>] 的 command/args/url/enabled/... 键值对
 * - [mcp_servers.<name>.env] 子表（Codex 自己的写法）
 * - 单行与跨行的数组、inline table；basic/literal 字符串；bool；数字
 */

/** 解析段头为 key 路径，如 '[mcp_servers."my.server"]' -> ['mcp_servers', 'my.server'] */
export function splitTomlKeyPath(header) {
  let inner = header.trim();
  if (inner.startsWith('[[')) inner = inner.slice(2);
  else if (inner.startsWith('[')) inner = inner.slice(1);
  if (inner.endsWith(']]')) inner = inner.slice(0, -2);
  else if (inner.endsWith(']')) inner = inner.slice(0, -1);

  const keys = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const ch = inner[i];
    let key = '';
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < inner.length && inner[i] !== quote) {
        if (quote === '"' && inner[i] === '\\') {
          const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
          key += map[inner[i + 1]] ?? inner[i + 1];
          i += 2;
        } else {
          key += inner[i];
          i++;
        }
      }
      i++; // 结尾引号
    } else {
      while (i < inner.length && /[A-Za-z0-9_-]/.test(inner[i])) {
        key += inner[i];
        i++;
      }
    }
    keys.push(key);
    while (i < inner.length && (inner[i] === '.' || /\s/.test(inner[i]))) i++;
  }
  return keys;
}

/** 去掉行尾注释（# 在引号外才算注释）。 */
function stripTrailingComment(line) {
  let inBasic = false, inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === '\\') i++;
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** 引号外的 ( { [ 开放深度。 */
function openDepth(s) {
  let inBasic = false, inLiteral = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inBasic) {
      if (ch === '\\') i++;
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth;
}

/** 引号与深度感知的顶层逗号切分（用于数组/inline table）。 */
function splitTopLevel(s) {
  const parts = [];
  let cur = '', depth = 0, inBasic = false, inLiteral = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inBasic) {
      cur += ch;
      if (ch === '\\') { cur += s[++i] ?? ''; }
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      cur += ch;
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') { inBasic = true; cur += ch; }
    else if (ch === "'") { inLiteral = true; cur += ch; }
    else if (ch === '[' || ch === '{') { depth++; cur += ch; }
    else if (ch === ']' || ch === '}') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function unquoteKey(k) {
  const t = k.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseTomlValue(s) {
  const t = s.trim();
  if (!t) return undefined;
  if (t.startsWith('"')) {
    if (t.length < 2 || !t.endsWith('"') || t.endsWith('\\"')) {
      throw new Error('Codex TOML basic 字符串未闭合');
    }
    try { return JSON.parse(t); } catch { throw new Error('Codex TOML basic 字符串无效'); }
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) throw new Error('Codex TOML literal 字符串未闭合');
    return unquoteKey(t);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.startsWith('[')) return splitTopLevel(t.slice(1, -1)).map(parseTomlValue);
  if (t.startsWith('{')) {
    const obj = {};
    for (const part of splitTopLevel(t.slice(1, -1))) {
      const kv = part.match(/^([^=]+)=( [\s\S]*)$/) || part.match(/^([^=]+)=(.*)$/);
      if (kv) obj[unquoteKey(kv[1])] = parseTomlValue(kv[2]);
    }
    return obj;
  }
  if (/^[\d_+-]+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t.replace(/_/g, ''));
  return t; // 无法识别 → 原样保留（保真优先）
}

/** 解析段 body 行（不含段头）为 key = value 对。 */
function parseKeyValues(lines) {
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = stripTrailingComment(lines[i]).replace(/\r$/, '');
    if (!line.trim()) { i++; continue; }
    const m = line.match(/^\s*("[^"]*"|'[^']*'|[^=#\s]+)\s*=\s*([\s\S]*)$/);
    if (!m) { i++; continue; }
    const key = unquoteKey(m[1]);
    let valueStr = m[2].trim();
    // 跨行累积（多行数组 / inline table）
    let j = i;
    while (openDepth(valueStr) > 0 && j + 1 < lines.length) {
      j++;
      valueStr = (valueStr + ' ' + stripTrailingComment(lines[j]).replace(/\r$/, '').trim()).trim();
    }
    if (openDepth(valueStr) !== 0) throw new Error(`Codex TOML 字段 ${key} 的数组/表未闭合`);
    if ((valueStr.startsWith('[') && !valueStr.endsWith(']')) || (valueStr.startsWith('{') && !valueStr.endsWith('}'))) {
      throw new Error(`Codex TOML 字段 ${key} 的值未闭合`);
    }
    out[key] = parseTomlValue(valueStr);
    i = j + 1;
  }
  return out;
}

/** 扫描所有段：返回 { lines, segments: [{namePath, start, end}] }，end 为Exclusive行号。 */
export function scanSegments(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const heads = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (/^\s*\[\[?\s*[^\]]+\s*\]\]?\s*(#.*)?$/.test(lines[idx])) {
      heads.push({ line: lines[idx], idx });
    }
  }
  const segments = heads.map((h, i) => ({
    namePath: splitTomlKeyPath(h.line),
    start: h.idx,
    end: i + 1 < heads.length ? heads[i + 1].idx : lines.length,
  }));
  return { lines, segments, eol };
}

/** 读取 [mcp_servers.*]：返回 [{name, raw}]（env 子表合并进 raw.env）。 */
export function readMcpServers(text) {
  const { lines, segments } = scanSegments(text);
  const order = [];
  const servers = new Map();
  for (const seg of segments) {
    const p = seg.namePath;
    if (p[0] !== 'mcp_servers' || p.length < 2) continue;
    const name = p[1];
    if (!servers.has(name)) { servers.set(name, {}); order.push(name); }
    const raw = servers.get(name);
    const body = lines.slice(seg.start + 1, seg.end);
    if (p.length === 2) Object.assign(raw, parseKeyValues(body));
    else if (p.length === 3 && p[2] === 'env') raw.env = { ...(raw.env || {}), ...parseKeyValues(body) };
    // 更深的路径（不认识的子表）忽略
  }
  return order.map((name) => ({ name, raw: servers.get(name) }));
}

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** TOML basic string 与 JSON 双引号字符串转义规则兼容。 */
function tomlString(s) {
  return JSON.stringify(String(s));
}

function encodeValue(v, fieldPath) {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) {
    return `[${v.map((x, i) => encodeValue(x, `${fieldPath}[${i}]`)).join(', ')}]`;
  }
  if (v && typeof v === 'object') {
    return `{ ${Object.entries(v).map(([k, value]) => `${tomlKey(k)} = ${encodeValue(value, `${fieldPath}.${k}`)}`).join(', ')} }`;
  }
  throw new Error(`Codex TOML 无法编码字段 ${fieldPath}（类型 ${v === null ? 'null' : typeof v}）`);
}

/** 生成一个 server 的段行（含可能的 [....env] 子表段），学 Codex 自己的排版。 */
export function renderServerSegments(name, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Codex MCP ${name} 的定义必须是对象`);
  }
  const key = tomlKey(name);
  const lines = [`[mcp_servers.${key}]`];
  const rest = { ...raw };
  if ('command' in rest) {
    if (typeof rest.command !== 'string') throw new Error(`Codex TOML 字段 ${name}.command 必须是字符串`);
    lines.push(`command = ${tomlString(rest.command)}`);
    delete rest.command;
  }
  if ('args' in rest) {
    if (!Array.isArray(rest.args) || !rest.args.every((x) => typeof x === 'string')) {
      throw new Error(`Codex TOML 字段 ${name}.args 必须是字符串数组`);
    }
    lines.push(`args = ${encodeValue(rest.args, `${name}.args`)}`);
    delete rest.args;
  }
  if ('url' in rest) {
    if (typeof rest.url !== 'string') throw new Error(`Codex TOML 字段 ${name}.url 必须是字符串`);
    lines.push(`url = ${tomlString(rest.url)}`);
    delete rest.url;
  }
  let env = null;
  if ('env' in rest) {
    if (!rest.env || typeof rest.env !== 'object' || Array.isArray(rest.env)) {
      throw new Error(`Codex TOML 字段 ${name}.env 必须是对象`);
    }
    env = rest.env;
    delete rest.env;
  }
  for (const [k, v] of Object.entries(rest)) {
    lines.push(`${tomlKey(k)} = ${encodeValue(v, `${name}.${k}`)}`);
  }
  if (env) {
    lines.push('');
    lines.push(`[mcp_servers.${key}.env]`);
    for (const [k, v] of Object.entries(env)) {
      if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) {
        throw new Error(`Codex TOML 字段 ${name}.env.${k} 必须是字符串、数字或布尔值`);
      }
      lines.push(`${tomlKey(k)} = ${encodeValue(v, `${name}.env.${k}`)}`);
    }
  }
  return lines;
}

/**
 * 段级 upsert/删除：
 * - raw 为对象：替换该 server 的所有段（含 .env 子表）为新生成的段；不存在则追加到文件末尾
 * - raw 为 null：删除该 server 的所有段
 * 返回 { text, changed }。
 */
export function upsertServerSegment(text, name, raw) {
  const { lines, segments, eol } = scanSegments(text);
  const owned = segments.filter((s) => s.namePath[0] === 'mcp_servers' && s.namePath[1] === name);

  if (!owned.length) {
    if (raw === null) return { text, changed: false };
    const newLines = renderServerSegments(name, raw);
    const base = lines.slice();
    if (base.length && base[base.length - 1].trim() !== '') base.push('');
    return { text: base.concat(newLines).join(eol), changed: true };
  }

  // 在原始坐标上逐段处理：保留同名 base/env 段之间夹着的所有无关 TOML 段。
  // 更新时只在 base 段（没有 base 则第一个 owned 段）位置插入一次新定义。
  const insertAt = (owned.find((s) => s.namePath.length === 2) || owned[0]).start;
  const replacement = raw === null ? [] : renderServerSegments(name, raw);
  const ordered = [...owned].sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const seg of ordered) {
    out.push(...lines.slice(cursor, seg.start));
    if (seg.start === insertAt) out.push(...replacement);
    cursor = seg.end;
  }
  out.push(...lines.slice(cursor));
  return { text: out.join(eol), changed: true };
}
