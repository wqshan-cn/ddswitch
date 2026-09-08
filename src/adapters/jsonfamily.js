import path from 'node:path';
import { readJsonLoose, readStrictJson, atomicWriteJson, fileExists, dirExists, getAt, ensureAt, pruneEmptyAt, isRecord } from '../jsonutil.js';
import { entryId, summarize, createReport } from '../model.js';

/**
 * 同构 JSON 家族适配器工厂。
 *
 * Qoder / Trae / Kimi / OpenCode（以及 ZCode）的 MCP 配置都是
 * { "<容器键>": { "<服务器名>": {定义...} } } 结构，只是文件路径和容器键不同：
 *   - Qoder/Trae/Kimi:  mcpServers（与 Claude Desktop 同构）
 *   - OpenCode:         mcp
 *   - ZCode:            mcp.servers（嵌套两层）
 *
 * 写入采用「外科手术式」合并：只动容器键下的内容，其余顶层键
 * （如 Qoder 的 enabledPlugins）原样保留；JSON.parse/stringify 保证
 * 原有键序不变；覆盖前自动 .ddswitch.bak 备份。
 *
 * spec:
 *   id / displayName
 *   resolve(env) -> { file, containerPath: string[], createIfMissing, note? }
 *   detected?(env) -> bool           // 缺省按配置文件或其父目录是否存在判断
 *   configRoot?(env) -> string       // detect 展示用的根目录（缺省为配置文件所在目录）
 *   skillsDir?(env) / memoryPaths?(env)
 *   normalizeKey?(name) -> string    // 写入时的键名规范（如 ZCode 全小写）
 *   confidence?: 'verified'|'inferred'  // 检测置信度：verified=官方文档/实测，inferred=惯例推断
 *   capsOverride?: {mcpRead, mcpWrite}  // 覆盖默认能力（如实验性工具只读）
 *   triedPaths?(env) -> string[]     // doctor 未检测到时列出的已尝试路径
 */
export function createJsonFamilyAdapter(spec) {
  const caps = spec.capsOverride || { mcpRead: true, mcpWrite: true, mcpPreviewWrite: true, skillsWrite: true };
  const writeGuard = (write) => {
    if (write && !caps.mcpWrite) throw new Error(`[${spec.id}] 暂不支持 MCP 写入（实验性/未实测，写入被禁用）`);
    if (!write && !caps.mcpWrite && !caps.mcpPreviewWrite) throw new Error(`[${spec.id}] 暂不支持 MCP 写入预览`);
  };
  return {
    id: spec.id,
    displayName: spec.displayName,

    detect(env) {
      const r = spec.resolve(env);
      const found = spec.detected
        ? spec.detected(env)
        : fileExists(r.file) || dirExists(path.dirname(r.file));
      if (!found) return null;
      const configRoot = spec.configRoot ? spec.configRoot(env) : path.dirname(r.file);
      return { configRoot, note: r.note, confidence: spec.confidence || 'verified' };
    },

    caps: spec.capsOverride || { mcpRead: true, mcpWrite: true },
    listMcp(env) {
      const r = spec.resolve(env);
      if (!fileExists(r.file)) return [];
      const data = readJsonLoose(r.file);
      if (!isRecord(data)) throw new Error(`[${spec.id}] 配置根必须是 JSON 对象：${r.file}`);
      const container = getAt(data, r.containerPath);
      if (container === undefined) return [];
      if (!isRecord(container)) throw new Error(`[${spec.id}] MCP 容器必须是 JSON 对象：${r.file}`);
      return Object.entries(container)
        .filter(([, raw]) => raw && typeof raw === 'object' && !Array.isArray(raw))
        .map(([name, raw]) => ({ adapter: spec.id, name, raw, source: r.file }));
    },

    /**
     * 把 entries 合并进该工具的 MCP 配置。
     * @param {Array<{name: string, raw: object}>} entries
     * @param {{conflict?: 'skip'|'update', write?: boolean}} opts
     *   write=false 时为 dry-run：只生成计划，不落盘。
     */
    upsertMcp(env, entries, { conflict = 'skip', write = false } = {}) {
      writeGuard(write);
      const r = spec.resolve(env);
      const report = createReport();

      let data = {};
      const existed = fileExists(r.file);
      if (existed) data = readStrictJson(r.file);
      else if (!r.createIfMissing) {
        report.lines.push(`[!] [${spec.id}] 配置文件不存在：${r.file}`);
        return report;
      }
      if (!isRecord(data)) throw new Error(`[${spec.id}] 配置根必须是 JSON 对象，拒绝写入：${r.file}`);
      for (const e of entries) {
        if (!e || typeof e.name !== 'string' || !isRecord(e.raw)) {
          throw new Error(`[${spec.id}] MCP 条目必须包含 name 和非数组对象 raw，拒绝写入`);
        }
      }

      const existingContainer = getAt(data, r.containerPath);
      if (existingContainer !== undefined && !isRecord(existingContainer)) {
        throw new Error(`[${spec.id}] MCP 容器必须是 JSON 对象，拒绝写入：${r.file}`);
      }
      const container = ensureAt(data, r.containerPath);
      const existingIds = new Map(Object.keys(container).map((k) => [entryId(k), k]));

      for (const e of entries) {
        const id = entryId(e.name);
        const hit = existingIds.get(id);
        if (hit) {
          if (conflict === 'update') {
            container[hit] = e.raw;
            report.updated++;
            report.lines.push(`${write ? '✓' : '·'} [${spec.id}] 更新 ${hit}（${summarize(e.raw)}）`);
          } else {
            report.skipped++;
            report.lines.push(`- [${spec.id}] ${hit} 已存在，跳过（--on-conflict update 可覆盖）`);
          }
        } else {
          const key = spec.normalizeKey ? spec.normalizeKey(e.name) : e.name;
          container[key] = e.raw;
          existingIds.set(entryId(key), key);
          report.added++;
          report.lines.push(`${write ? '✓' : '·'} [${spec.id}] 新增 ${key}（${summarize(e.raw)}）`);
        }
      }

      report.changed = report.added + report.updated > 0;
      if (report.changed) {
        if (write) {
          const bak = atomicWriteJson(r.file, data);
          report.lines.push(`  已写入 ${r.file}${bak ? `（已备份到 ${bak}）` : ''}`);
        } else {
          report.lines.push('  （dry-run 未写入；加 --write 生效）');
        }
      }
      return report;
    },

    removeMcp(env, names, { write = false } = {}) {
      writeGuard(write);
      const r = spec.resolve(env);
      const report = createReport();
      if (!fileExists(r.file)) {
        report.lines.push(`[!] [${spec.id}] 配置文件不存在：${r.file}`);
        return report;
      }
      const data = readStrictJson(r.file);
      if (!isRecord(data)) throw new Error(`[${spec.id}] 配置根必须是 JSON 对象，拒绝写入：${r.file}`);
      const container = getAt(data, r.containerPath);
      if (container === undefined) return report;
      if (!isRecord(container)) throw new Error(`[${spec.id}] MCP 容器必须是 JSON 对象，拒绝写入：${r.file}`);

      for (const n of names) {
        const id = entryId(n);
        const hit = Object.keys(container).find((k) => entryId(k) === id);
        if (hit) {
          delete container[hit];
          report.removed++;
          report.lines.push(`${write ? '✓' : '·'} [${spec.id}] 已删除 ${hit}`);
        } else {
          report.skipped++;
          report.lines.push(`- [${spec.id}] ${n} 未找到，跳过`);
        }
      }
      report.changed = report.removed > 0;
      if (report.changed) {
        // 容器删空时：文件还有其他顶层键 → 连空容器键一起清掉（不留 `mcp: {}` 残迹）；
        // 容器是唯一顶层键（专用 MCP 文件如 mcp.json）→ 保留空容器，避免产生空文件。
        if (!Object.keys(container).length && Object.keys(data).length > 1) {
          pruneEmptyAt(data, r.containerPath);
        }
        if (write) {
          const bak = atomicWriteJson(r.file, data);
          report.lines.push(`  已写入 ${r.file}${bak ? `（已备份到 ${bak}）` : ''}`);
        } else {
          report.lines.push('  （dry-run 未写入；加 --write 生效）');
        }
      }
      return report;
    },

    /** doctor 用：配置文件健康状态 + 未检测到时的候选路径清单。 */
    diagnose(env) {
      const r = spec.resolve(env);
      const d = {
        file: r.file,
        exists: fileExists(r.file),
        parse: null,
        count: null,
        error: null,
        tried: spec.triedPaths ? spec.triedPaths(env) : [r.file],
      };
      if (d.exists) {
        try {
          const data = readJsonLoose(r.file);
          if (!isRecord(data)) throw new Error('配置根不是 JSON 对象');
          const c = getAt(data, r.containerPath);
          if (c !== undefined && !isRecord(c)) throw new Error('MCP 容器不是 JSON 对象');
          d.count = c ? Object.keys(c).length : 0;
          d.parse = 'ok';
        } catch (e) {
          d.parse = 'error';
          d.error = e.message;
        }
      }
      return d;
    },

    skillsDir(env) { return spec.skillsDir ? spec.skillsDir(env) : null; },
    extraSkillDirs(env) { return spec.extraSkillDirs ? spec.extraSkillDirs(env) : []; },
    memoryPaths(env) { return spec.memoryPaths ? spec.memoryPaths(env) : []; },
  };
}
