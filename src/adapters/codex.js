import path from 'node:path';
import { dirExists, fileExists, readText, atomicWriteText } from '../jsonutil.js';
import { readMcpServers, upsertServerSegment } from '../toml-lite.js';
import { entryId, summarize, createReport } from '../model.js';

/**
 * Codex 适配器（海外）。
 *
 * MCP 配置在 ~/.codex/config.toml 的 [mcp_servers.<name>] 段（env 走
 * [mcp_servers.<name>.env] 子表）。该文件同时承载 model_providers、
 * projects、plugins 等段且含用户手写注释，因此采用 toml-lite 的
 * 「段级 splice」：只增删改 mcp_servers 段，其余逐字保留。
 */
export function createCodexAdapter() {
  const root = (env) => path.join(env.home, '.codex');
  const file = (env) => path.join(root(env), 'config.toml');

  return {
    id: 'codex',
    displayName: 'Codex',
    detect(env) {
      return dirExists(root(env)) ? { configRoot: root(env) } : null;
    },
    caps: { mcpRead: true, mcpWrite: true },

    listMcp(env) {
      if (!fileExists(file(env))) return [];
      return readMcpServers(readText(file(env))).map(({ name, raw }) => ({
        adapter: 'codex',
        name,
        raw,
        source: file(env),
      }));
    },

    upsertMcp(env, entries, { conflict = 'skip', write = false } = {}) {
      const p = file(env);
      const report = createReport();
      const existed = fileExists(p);
      let text = existed ? readText(p) : '';

      for (const e of entries) {
        const id = entryId(e.name);
        const existing = readMcpServers(text).find((s) => entryId(s.name) === id);
        if (existing) {
          if (conflict === 'update') {
            const r = upsertServerSegment(text, existing.name, e.raw);
            text = r.text;
            report.updated++;
            report.lines.push(`${write ? '✓' : '·'} [codex] 更新 ${existing.name}（${summarize(e.raw)}）`);
          } else {
            report.skipped++;
            report.lines.push(`- [codex] ${existing.name} 已存在，跳过（--on-conflict update 可覆盖）`);
          }
        } else {
          const r = upsertServerSegment(text, e.name, e.raw);
          text = r.text;
          report.added++;
          report.lines.push(`${write ? '✓' : '·'} [codex] 新增 ${e.name}（${summarize(e.raw)}）`);
        }
      }

      report.changed = report.added + report.updated > 0;
      if (report.changed) {
        if (write) {
          const header = existed ? '' : '# Codex CLI 配置\n# [mcp_servers.*] 段由 ddswitch 管理，其余内容不受影响。\n\n';
          const bak = atomicWriteText(p, header + text);
          report.lines.push(`  已写入 ${p}${bak ? `（已备份到 ${bak}）` : ''}`);
        } else {
          report.lines.push('  （dry-run 未写入；加 --write 生效）');
        }
      }
      return report;
    },

    removeMcp(env, names, { write = false } = {}) {      const p = file(env);
      const report = createReport();
      if (!fileExists(p)) {
        report.lines.push(`[!] [codex] 配置文件不存在：${p}`);
        return report;
      }
      let text = readText(p);
      for (const n of names) {
        const id = entryId(n);
        const existing = readMcpServers(text).find((s) => entryId(s.name) === id);
        if (!existing) {
          report.skipped++;
          report.lines.push(`- [codex] ${n} 未找到，跳过`);
          continue;
        }
        const r = upsertServerSegment(text, existing.name, null);
        text = r.text;
        report.removed++;
        report.lines.push(`${write ? '✓' : '·'} [codex] 已删除 ${existing.name}（含其 .env 子表）`);
      }
      report.changed = report.removed > 0;
      if (report.changed && write) {
        const bak = atomicWriteText(p, text);
        report.lines.push(`  已写入 ${p}${bak ? `（已备份到 ${bak}）` : ''}`);
      } else if (report.changed) {
        report.lines.push('  （dry-run 未写入；加 --write 生效）');
      }
      return report;
    },

    /** doctor 用：config.toml 健康状态。 */
    diagnose(env) {
      const p = file(env);
      const d = {
        file: p,
        exists: fileExists(p),
        parse: null,
        count: null,
        error: null,
        tried: [p],
      };
      if (d.exists) {
        try {
          d.count = readMcpServers(readText(p)).length;
          d.parse = 'ok';
        } catch (e) {
          d.parse = 'error';
          d.error = e.message;
        }
      }
      return d;
    },

    skillsDir: (env) => path.join(root(env), 'skills'), // 实测存在（ZCode 的 bioskills 链接指向这里）
    memoryPaths: (env) => [path.join(root(env), 'AGENTS.md')],
  };
}
