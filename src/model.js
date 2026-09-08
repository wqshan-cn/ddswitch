/** MCP 条目与 apply 报告的通用模型。 */

/** 规范 id：各工具对服务器名的大小写习惯不同，统一按小写判重。 */
export function entryId(name) {
  return String(name).toLowerCase();
}

function safeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // 解析失败也不能把可能含凭据的 URL 原样输出；保留 scheme/host 之外不确定的内容全部隐藏。
    const value = String(rawUrl);
    const scheme = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//)?.[0] || '';
    return `${scheme}***REDACTED_URL***`;
  }
}

/**
 * 安全摘要：普通 list/sync 输出不能泄露 URL 查询参数、命令参数或 env。
 * 完整定义只在显式 `mcp show` 中展示。
 */
export function summarize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '(非对象定义)';
  if (typeof raw.command === 'string') {
    const n = Array.isArray(raw.args) ? raw.args.length : 0;
    return `stdio: ${raw.command}${n ? `（${n} 个参数，内容已隐藏）` : ''}`.slice(0, 120);
  }
  if (typeof raw.url === 'string') {
    const type = typeof raw.type === 'string' ? raw.type : 'http';
    return `${type}: ${safeUrl(raw.url)}`.slice(0, 120);
  }
  return '(未识别的传输类型)';
}

const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie)/i;
const SENSITIVE_CONTAINER = /^(?:headers?|staticHeaders)$/i;

function redactUrl(value) {
  try {
    const u = new URL(value);
    if (u.username) u.username = 'REDACTED';
    if (u.password) u.password = 'REDACTED';
    for (const key of u.searchParams.keys()) u.searchParams.set(key, 'REDACTED');
    return u.toString();
  } catch {
    return value;
  }
}

/** 深度复制 MCP 定义并脱敏；不会修改源对象。 */
export function redactMcpDefinition(value, redactAll = false) {
  if (Array.isArray(value)) return value.map((item) => redactMcpDefinition(item, redactAll));
  if (!value || typeof value !== 'object') return redactAll ? '***REDACTED***' : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const sensitive = redactAll || SENSITIVE_KEY.test(key) || SENSITIVE_CONTAINER.test(key);
    if (sensitive) {
      out[key] = item && typeof item === 'object'
        ? redactMcpDefinition(item, true)
        : '***REDACTED***';
    } else if (/url$/i.test(key) && typeof item === 'string') {
      out[key] = redactUrl(item);
    } else if (/args/i.test(key) && Array.isArray(item)) {
      let redactNext = false;
      out[key] = item.map((arg) => {
        if (redactNext) {
          redactNext = false;
          return '***REDACTED***';
        }
        if (typeof arg !== 'string') return redactMcpDefinition(arg, false);
        if (/^--?(?:token|secret|password|api[_-]?key|authorization)$/i.test(arg)) {
          redactNext = true;
          return arg;
        }
        if (/^--?(?:token|secret|password|api[_-]?key|authorization)=/i.test(arg)) {
          return `${arg.split('=')[0]}=***REDACTED***`;
        }
        return arg;
      });
    } else {
      out[key] = redactMcpDefinition(item, false);
    }
  }
  return out;
}

export function createReport() {
  return { lines: [], added: 0, updated: 0, removed: 0, skipped: 0, changed: false };
}
