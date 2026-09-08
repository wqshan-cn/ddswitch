import fs from 'node:fs';
import path from 'node:path';

export function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 校验单个路径片段必须是纯 basename，阻止 ../ 或绝对路径。 */
export function isSafeSegment(segment) {
  return typeof segment === 'string' && segment !== '.' && segment !== '..' && segment === path.basename(segment);
}

/** 在受信根目录（home/appdata/localappdata 之一）逐片段拼接并阻止穿越。 */
export function safeJoin(root, ...segments) {
  const base = path.resolve(root);
  let target = base;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      throw new Error(`非法路径片段：${String(segment)}`);
    }
    target = path.resolve(target, segment);
  }
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`路径越界：${target}`);
  return target;
}

/** 从 env 的可信根开始拼接，片段全部白名单校验。用于适配器根目录候选。 */
export function safeBaseJoin(env, ...segments) {
  const start = env
    ? path.resolve(env.home || env.appdata || env.localappdata || '.')
    : '.';
  return safeJoin(start, ...segments);
}

/** 非 null、非数组对象。配置根与 MCP 容器必须满足这个约束。 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 字符串感知的 JSONC 清理：只在字符串外移除注释和尾逗号。
 * 未闭合块注释直接报错，绝不静默吞掉文件尾部。
 */
function sanitizeJsonc(text) {
  let out = '';
  let state = 'normal';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'string') {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n' || ch === '\r') {
        out += ch;
        state = 'normal';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        out += ch; // 保留行号，错误信息更可定位
      }
      continue;
    }
    if (ch === '"') {
      state = 'string';
      out += ch;
    } else if (ch === '/' && next === '/') {
      state = 'line-comment';
      i++;
    } else if (ch === '/' && next === '*') {
      state = 'block-comment';
      i++;
    } else {
      out += ch;
    }
  }
  if (state === 'block-comment') throw new Error('JSONC 块注释未闭合');

  // 第二遍在字符串外删除紧邻 } 或 ] 的尾逗号。
  let clean = '';
  state = 'normal';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (state === 'string') {
      clean += ch;
      if (ch === '\\') clean += out[++i] ?? '';
      else if (ch === '"') state = 'normal';
      continue;
    }
    if (ch === '"') {
      state = 'string';
      clean += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    clean += ch;
  }
  return clean;
}

/** 读 JSON：容忍 UTF-8 BOM；严格解析失败时按安全 JSONC 子集重试。 */
export function readJsonLoose(p) {
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (strictError) {
    try {
      return JSON.parse(sanitizeJsonc(text));
    } catch (jsoncError) {
      throw new Error(`解析 JSON 失败：${p}（${jsoncError.message || strictError.message}）`);
    }
  }
}

/**
 * 原子写 JSON（借鉴 CC Switch 的 atomic write 思路）：
 * 1. 覆盖已有文件前，先备份到 <file>.ddswitch.bak
 * 2. 写同目录临时文件后 rename 替换，避免写一半崩溃导致配置损坏
 * 返回备份路径；没有覆盖旧文件时返回 null。
 */
export function atomicWriteJson(p, obj) {
  let data = JSON.stringify(obj, null, 2);
  // 跟随原文件的行尾习惯：原文件末尾无换行则保持无换行，避免无谓 diff
  if (!fileExists(p) || readText(p).endsWith('\n')) data += '\n';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let bak = null;
  if (fileExists(p)) {
    bak = p + '.ddswitch.bak';
    fs.copyFileSync(p, bak);
  }
  const tmp = p + '.ddswitch.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    try {
      fs.renameSync(tmp, p);
    } catch (err) {
      // 某些 Windows 文件系统/杀毒软件短暂占用目标文件；保留备份后重试替换。
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
      fs.rmSync(p, { force: true });
      try {
        fs.renameSync(tmp, p);
      } catch (replaceError) {
        if (bak) {
          try { fs.copyFileSync(bak, p); } catch { /* 保留原始替换错误 */ }
        }
        throw replaceError;
      }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 保留原错误 */ }
    throw err;
  }
  return bak;
}

/** 读文本文件（UTF-8，容忍 BOM）。 */
export function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

/** 写入前严格读取 JSON；JSONC/尾逗号配置拒绝重写，避免丢失注释和未管理文本。 */
export function readStrictJson(p) {
  const text = readText(p);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`配置包含 JSONC/非标准 JSON，拒绝破坏性重写：${p}`);
  }
}

/**
 * 原子写文本：逻辑同 atomicWriteJson，但内容原样写入（用于 TOML 等非 JSON 格式）。
 * 返回备份路径；没有覆盖旧文件时返回 null。
 */
export function atomicWriteText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let bak = null;
  if (fileExists(p)) {
    bak = p + '.ddswitch.bak';
    fs.copyFileSync(p, bak);
  }
  const tmp = p + '.ddswitch.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, p);
    } catch (err) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
      fs.rmSync(p, { force: true });
      try {
        fs.renameSync(tmp, p);
      } catch (replaceError) {
        if (bak) {
          try { fs.copyFileSync(bak, p); } catch { /* 保留原始替换错误 */ }
        }
        throw replaceError;
      }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 保留原错误 */ }
    throw err;
  }
  return bak;
}

/** 按 key 路径取嵌套值（如 ['mcp', 'servers']），缺失返回 undefined。 */
export function getAt(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 按 key 路径确保嵌套对象存在并返回（就地修改）。 */
export function ensureAt(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

/**
 * 自底向上清理空容器：若容器为空则删除该键，父级空了继续删，
 * 直到遇到非空对象为止。用于 remove 后不留 `mcp: {}` 之类的残迹。
 */
export function pruneEmptyAt(obj, keys) {
  const trail = [];
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return;
    trail.push({ parent: cur, key: k });
    cur = cur[k];
  }
  for (let i = trail.length - 1; i >= 0; i--) {
    const { parent, key } = trail[i];
    const v = parent[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
}
