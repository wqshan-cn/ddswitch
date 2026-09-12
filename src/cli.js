import fs from 'node:fs';
import path from 'node:path';
import { registry, defaultEnv } from './adapters/index.js';
import { entryId, summarize, redactMcpDefinition } from './model.js';
import { dirExists, fileExists, readJsonLoose, atomicWriteJson, isRecord } from './jsonutil.js';
import { listSkillsDir, deploySkills } from './skills.js';
import { readUsage } from './usage-readers.js';

const HELP = `ddswitch — AI 编程工具统一管理器（通用，国产与海外主流通吃）

用法：
  ddswitch scan
      扫描本机已装工具，盘点 MCP / Skills / 记忆资产
  ddswitch doctor
      深度自诊断：平台 / 候选路径 / 配置可解析性，排查"为什么没检测到"
  ddswitch mcp list [--agent <id>]
      列出各工具（或指定工具）的 MCP 服务器
  ddswitch mcp show <id> <name> [--include-secrets]
      查看某工具某 MCP 服务器定义（默认脱敏）
  ddswitch mcp sync --from <id|文件> --to <id[,id...]> [--server <name[,name...]>]
                    [--on-conflict skip|update] [--write]
      跨工具同步 MCP。--from 可以是工具 id，也可以是导出文件（.json）。
      默认 dry-run 只打印计划，加 --write 才写盘；同名冲突默认跳过。
  ddswitch mcp remove <id> <name[,name...]> [--write]
      从某工具删除 MCP 服务器（默认 dry-run）
  ddswitch mcp export [--agent <id>] [--out <file>] [--include-secrets]
      导出 MCP 为统一 JSON（默认脱敏；显式开关才包含密钥）
  ddswitch skills list [--agent <id>]
      列出各工具的已装技能（含 symlink 指向与 SKILL.md 元信息）
  ddswitch skills deploy --from <id> --to <id[,id...]> [--name <n[,n...]>]
                        [--mode auto|symlink|copy] [--write]
      跨工具部署技能（默认 auto：Windows junction / 其他平台 symlink，失败降级 copy）
  ddswitch usage summary|breakdown|export [--range 24h|7d|30d] [--out <file>]
      读取本地结构化 usage（ZCode request-level / Codex thread-level）

工具 id：zcode qoder trae kimi codebuddy workbuddy claude codex gemini opencode
（国产生态在前、海外主流在后；同一套命令跨任何工具工作）

示例：
  ddswitch mcp sync --from qoder --to zcode,claude
  ddswitch mcp sync --from qoder-export.json --to kimi --write
  ddswitch skills deploy --from zcode --to claude --write
`;

export async function runAsync(argv, runtimeEnv = defaultEnv()) {
  if (argv[0] === 'usage') return cmdUsage(runtimeEnv, argv.slice(1));
  return run(argv, runtimeEnv);
}

export function run(argv, runtimeEnv = defaultEnv()) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  const env = runtimeEnv;
  const adapters = registry();
  const byId = new Map(adapters.map((a) => [a.id, a]));

  if (cmd === 'scan') return cmdScan(env, adapters);
  if (cmd === 'doctor') return cmdDoctor(env, adapters);
  if (cmd === 'skills') {
    if (sub === 'list') return cmdSkillsList(env, adapters, rest);
    if (sub === 'deploy') return cmdSkillsDeploy(env, byId, rest);
    console.error(`未知子命令：skills ${sub ?? '(空)'}\n\n${HELP}`);
    return 1;
  }
  if (cmd === 'mcp') {
    if (sub === 'list') return cmdList(env, adapters, rest);
    if (sub === 'show') return cmdShow(env, byId, rest);
    if (sub === 'sync') return cmdSync(env, byId, rest);
    if (sub === 'remove') return cmdRemove(env, byId, rest);
    if (sub === 'export') return cmdExport(env, adapters, rest);
    console.error(`未知子命令：mcp ${sub ?? '(空)'}\n\n${HELP}`);
    return 1;
  }
  console.error(`未知命令：${cmd}\n\n${HELP}`);
  return 1;
}

function parseFlags(rest) {
  const out = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function cmdUsage(env, rest) {
  const [sub = 'summary', ...args] = rest;
  const flags = parseFlags(args);
  const range = String(flags.range || '7d');
  if (!['24h', '7d', '30d'].includes(range)) {
    console.error('usage range 必须是 24h、7d 或 30d');
    return 1;
  }
  const now = Date.now();
  const days = range === '24h' ? 1 / 24 : range === '30d' ? 30 : 7;
  const result = await readUsage(env, { start: new Date(now - days * 86400000).toISOString(), end: new Date(now + 1000).toISOString() });
  const payload = sub === 'breakdown' ? { range, sources: result.sources, breakdown: result.breakdown } : sub === 'export' ? { range, exportedAt: new Date().toISOString(), sources: result.sources, records: result.records } : { range, sources: result.sources, totals: result.totals, timeseries: result.timeseries, breakdown: result.breakdown };
  if (sub === 'export' && flags.out) {
    atomicWriteJson(String(flags.out), payload);
    console.log(`usage 已导出到 ${flags.out}`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  return 0;
}

function cmdScan(env, adapters) {
  console.log(`ddswitch 全机扫描（${env.platform} | Node ${process.version} | HOME ${env.home}）\n`);
  for (const a of adapters) {
    const info = a.detect(env);
    const label = `${a.id.padEnd(11)}${a.displayName.padEnd(13)}`;
    if (!info) {
      console.log(`✖ ${label}未检测到`);
      continue;
    }
    const conf = info.confidence === 'inferred' ? '（推断）' : '';
    let mcpPart = 'MCP (待实现)';
    if (a.caps?.mcpRead) {
      try { mcpPart = `MCP ${a.listMcp(env).length}`; } catch { mcpPart = 'MCP ?'; }
    }
    const sd = a.skillsDir ? a.skillsDir(env) : null;
    const skillsPart = sd && dirExists(sd) ? `skills ${listSkillsDir(sd).length}` : 'skills -';
    const mps = (a.memoryPaths ? a.memoryPaths(env) : []).filter((p) => fileExists(p) || dirExists(p));
    const memPart = mps.length ? `memory ✔` : 'memory -';
    console.log(`✔ ${label}${mcpPart}  ${skillsPart}  ${memPart}${conf}`);
    console.log(`    ${info.configRoot}`);
    if (info.note) console.log(`    备注: ${info.note}`);
  }
  return 0;
}

/** 深度自诊断：别的用户跑不通时，这条命令的输出就是排查依据。 */
function cmdDoctor(env, adapters) {
  console.log(`ddswitch doctor`);
  console.log(`平台 ${env.platform} | Node ${process.version} | HOME ${env.home} | APPDATA ${env.appdata}\n`);
  let ok = 0, empty = 0, missing = 0, warn = 0;
  for (const a of adapters) {
    const info = a.detect(env);
    if (!info) {
      missing++;
      console.log(`✖ ${a.id}（${a.displayName}）：未检测到`);
      if (a.diagnose) {
        const d = a.diagnose(env);
        const tried = d.tried || [];
        if (d.file) tried.unshift(d.file);
        for (const p of [...new Set(tried)].slice(0, 6)) console.log(`    已尝试：${p}`);
      }
      console.log('');
      continue;
    }
    const inferred = info.confidence === 'inferred';
    if (inferred) warn++;
    let line = `✔ ${a.id}（${a.displayName}）${inferred ? '【推断，未实测】' : ''}`;
    try {
      if (a.caps?.mcpRead) {
        const n = a.listMcp(env).length;
        line += ` MCP ${n}`;
        if (n === 0) empty++;
        else ok++;
      } else {
        line += ' MCP 读取待实现';
      }
    } catch (e) {
      line += ` MCP 读取出错：${e.message}`;
      warn++;
    }
    console.log(line);
    console.log(`    根目录: ${info.configRoot}`);
    if (info.note) console.log(`    备注: ${info.note}`);
    if (a.diagnose) {
      const d = a.diagnose(env);
      if (d.file) {
        if (!d.exists) console.log(`    配置: ${d.file} — 不存在（首次 sync --write 会按需创建）`);
        else if (d.parse === 'ok') console.log(`    配置: ${d.file} — 可解析，${d.count} 个 MCP`);
        else console.log(`    配置: ${d.file} — ⚠ 解析失败：${d.error}`);
      }
    }
    const sd = a.skillsDir ? a.skillsDir(env) : null;
    if (sd) console.log(`    skills: ${sd}${dirExists(sd) ? '' : '（目录不存在）'}`);
    for (const extra of a.extraSkillDirs ? a.extraSkillDirs(env) : []) {
      console.log(`    skills(辅助): ${extra}${dirExists(extra) ? '' : '（目录不存在）'}`);
    }
    console.log('');
  }
  console.log(`汇总：${ok} 个有配置，${empty} 个已装未配置，${missing} 个未安装，${warn} 个需留意。`);
  console.log('如果某个工具的路径不对，请把本命令完整输出贴到项目 issue，适配器按真实布局扩展。');
  return 0;
}

function cmdList(env, adapters, rest) {
  const flags = parseFlags(rest);
  const only = flags.agent ? String(flags.agent).toLowerCase() : null;
  let printed = 0, failed = 0, matched = 0;
  for (const a of adapters) {
    if (only && a.id !== only) continue;
    if (!a.detect(env) || !a.caps?.mcpRead) continue;
    matched++;
    let entries;
    try {
      entries = a.listMcp(env);
    } catch (e) {
      console.error(`✖ [${a.id}] MCP 配置读取失败：${e.message}`);
      failed++;
      continue;
    }
    console.log(`== ${a.id}（${a.displayName}）— ${entries.length} 个服务器`);
    if (!entries.length) {
      console.log('   （无）');
      printed++;
      continue;
    }
    for (const e of entries) console.log(`   ${e.name.padEnd(24)}${summarize(e.raw)}`);
    console.log(`   来源: ${entries[0].source}`);
    printed++;
  }
  if (!matched && only) {
    console.error(`未找到已安装且可读取 MCP 的工具：${only}`);
    return 1;
  }
  return failed ? 1 : 0;
}

function cmdShow(env, byId, rest) {
  const [id, name, ...restFlags] = rest;
  const flags = parseFlags(restFlags);
  if (!id || !name) {
    console.error('用法：ddswitch mcp show <id> <name>');
    return 1;
  }
  const adapterId = id.toLowerCase();
  const a = byId.get(adapterId);
  if (!a) { console.error(`未知工具 id：${id}`); return 1; }
  if (!a.caps?.mcpRead) { console.error(`[${adapterId}] MCP 读取暂未实现`); return 1; }
  let entries;
  try {
    entries = a.listMcp(env);
  } catch (e) {
    console.error(`[${adapterId}] MCP 配置读取失败：${e.message}`);
    return 1;
  }
  const hit = entries.find((e) => entryId(e.name) === entryId(name));
  if (!hit) { console.error(`[${id}] 未找到 MCP 服务器：${name}（可用：${entries.map((e) => e.name).join(', ') || '无'}）`); return 1; }
  const shown = flags['include-secrets'] === true ? hit.raw : redactMcpDefinition(hit.raw);
  console.log(JSON.stringify(shown, null, 2));
  if (flags['include-secrets'] !== true) console.error('# 已脱敏；加 --include-secrets 才显示原始敏感值。');
  return 0;
}

/** --from 可以是工具 id，也可以是导出文件（.json）。文件路径必须保持原始大小写。 */
function loadEntriesFromSource(env, fromArg, byId) {
  const adapterId = fromArg.toLowerCase();
  const asFile = fileExists(fromArg) || /\.json$/i.test(fromArg);
  if (asFile) {
    if (!fileExists(fromArg)) throw new Error(`导出文件不存在：${fromArg}`);
    const data = readJsonLoose(fromArg);
    if (isRecord(data) && data.secretsIncluded === false) {
      throw new Error(`导出文件已脱敏，不能直接同步：${fromArg}。请用 --include-secrets 重新导出迁移包。`);
    }
    if (Array.isArray(data)) {
      return { label: fromArg, entries: data.filter((e) => e && typeof e.name === 'string' && isRecord(e.raw)) };
    }
    if (isRecord(data)) {
      // ddswitch 导出格式：servers 为 [{adapter, name, raw}] 数组
      if (Array.isArray(data.servers)) {
        return {
          label: fromArg,
          entries: data.servers.filter((e) => e && typeof e.name === 'string' && isRecord(e.raw)),
        };
      }
      // 兼容映射格式：{servers: {name: raw}} / {mcpServers: {...}} / 直接 {name: raw}
      const map = data.servers || data.mcpServers || data;
      if (!isRecord(map)) throw new Error(`导出文件中的 servers/mcpServers 必须是对象：${fromArg}`);
      const entries = Object.entries(map)
        .filter(([, raw]) => isRecord(raw))
        .map(([name, raw]) => ({ name, raw }));
      return { label: fromArg, entries };
    }
    throw new Error(`无法识别的导出文件结构：${fromArg}`);
  }
  const a = byId.get(adapterId);
  if (!a) throw new Error(`未知工具 id 或文件：${fromArg}`);
  if (!a.detect(env)) throw new Error(`源 ${adapterId} 未检测到安装`);
  return { label: adapterId, entries: a.listMcp(env) };
}

function cmdSync(env, byId, rest) {
  const flags = parseFlags(rest);
  const fromId = flags.from ? String(flags.from) : null;
  const toIds = flags.to ? String(flags.to).toLowerCase().split(',').filter(Boolean) : [];
  if (!fromId || !toIds.length) {
    console.error('用法：ddswitch mcp sync --from <id|文件> --to <id[,id...]> [--server <name,...>] [--on-conflict skip|update] [--write]');
    return 1;
  }
  const write = flags.write === true;
  const conflict = flags['on-conflict'] === 'update' ? 'update' : 'skip';

  let label, entries;
  try {
    ({ label, entries } = loadEntriesFromSource(env, fromId, byId));
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (flags.server) {
    const wanted = new Set(String(flags.server).toLowerCase().split(','));
    entries = entries.filter((e) => wanted.has(entryId(e.name)));
  }
  if (!entries.length) {
    console.log('源没有可同步的 MCP 服务器（或被 --server 过滤为空）');
    return 0;
  }

  console.log(`从 ${label} 读取到 ${entries.length} 个 MCP 服务器：`);
  for (const e of entries) console.log(`  ${e.name}（${summarize(e.raw)}）`);
  console.log(`模式：${write ? '写入（覆盖前自动 .ddswitch.bak 备份）' : 'dry-run 预览'}\n`);

  let added = 0, updated = 0, skipped = 0, failed = 0;
  for (const tid of toIds) {
    const t = byId.get(tid);
    if (!t) { console.log(`✖ 目标 ${tid} 不存在（可用：${[...byId.keys()].join(', ')}）`); failed++; continue; }
    if (!t.detect(env)) { console.log(`✖ [${tid}] 未检测到安装，跳过`); failed++; continue; }
    if (write && !t.caps?.mcpWrite) { console.log(`✖ [${tid}] 暂不支持 MCP 真实写入，跳过`); failed++; continue; }
    if (!write && !t.caps?.mcpWrite && !t.caps?.mcpPreviewWrite) { console.log(`✖ [${tid}] 暂不支持 MCP 写入预览，跳过`); failed++; continue; }
    try {
      const rep = t.upsertMcp(env, entries, { conflict, write });
      rep.lines.forEach((l) => console.log(l));
      added += rep.added; updated += rep.updated; skipped += rep.skipped;
    } catch (e) {
      console.log(`✖ [${tid}] ${e.message}`);
      failed++;
    }
    console.log('');
  }
  console.log(`完成（${write ? '已写入' : 'dry-run'}）：新增 ${added}，更新 ${updated}，跳过 ${skipped}${failed ? `，未处理目标 ${failed}` : ''}`);
  return failed ? 1 : 0;
}

function cmdRemove(env, byId, rest) {
  const [id, namesArg, ...restFlags] = rest;
  const flags = parseFlags(restFlags);
  if (!id || !namesArg) {
    console.error('用法：ddswitch mcp remove <id> <name[,name...]> [--write]');
    return 1;
  }
  const adapterId = id.toLowerCase();
  const a = byId.get(adapterId);
  if (!a) { console.error(`未知工具 id：${id}`); return 1; }
  if (!a.detect(env)) { console.error(`[${adapterId}] 未检测到安装`); return 1; }
  const write = flags.write === true;
  if (write && !a.caps?.mcpWrite) { console.error(`[${adapterId}] 暂不支持 MCP 真实写入`); return 1; }
  if (!write && !a.caps?.mcpWrite && !a.caps?.mcpPreviewWrite) { console.error(`[${adapterId}] 暂不支持 MCP 删除预览`); return 1; }
  const names = namesArg.split(',').filter(Boolean);
  try {
    const rep = a.removeMcp(env, names, { write });
    rep.lines.forEach((l) => console.log(l));
    console.log(`\n完成（${write ? '已写入' : 'dry-run'}）：删除 ${rep.removed}，跳过 ${rep.skipped}`);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  return 0;
}

function cmdExport(env, adapters, rest) {
  const flags = parseFlags(rest);
  const only = flags.agent ? String(flags.agent).toLowerCase() : null;
  const includeSecrets = flags['include-secrets'] === true;
  const collected = [];
  let matched = 0, failed = 0;
  for (const a of adapters) {
    if (only && a.id !== only) continue;
    if (!a.detect(env) || !a.caps?.mcpRead) continue;
    matched++;
    try {
      for (const e of a.listMcp(env)) {
        collected.push({ adapter: a.id, name: e.name, raw: includeSecrets ? e.raw : redactMcpDefinition(e.raw) });
      }
    } catch (e) {
      console.error(`✖ [${a.id}] 导出失败：${e.message}`);
      failed++;
    }
  }
  if (only && !matched) {
    console.error(`未找到已安装且可读取 MCP 的工具：${only}`);
    return 1;
  }
  const doc = {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: only || 'all',
    secretsIncluded: includeSecrets,
    servers: collected,
  };
  if (flags.out) {
    atomicWriteJson(String(flags.out), doc);
    console.log(`已导出 ${collected.length} 个 MCP 服务器到 ${flags.out}`);
  } else {
    console.log(JSON.stringify(doc, null, 2));
  }
  console.error(includeSecrets
    ? '# 警告：导出内容包含原始敏感值，请妥善保管。'
    : '# 已默认脱敏；需要原始凭据时显式加 --include-secrets。');
  return failed ? 1 : 0;
}

function cmdSkillsList(env, adapters, rest) {
  const flags = parseFlags(rest);
  const only = flags.agent ? String(flags.agent).toLowerCase() : null;
  let printed = 0;
  for (const a of adapters) {
    if (only && a.id !== only) continue;
    if (!a.detect(env)) continue;
    const sd = a.skillsDir ? a.skillsDir(env) : null;
    if (!sd || !dirExists(sd)) continue;
    const skills = listSkillsDir(sd);
    console.log(`== ${a.id}（${a.displayName}）— ${skills.length} 个技能 — ${sd}`);
    for (const s of skills) {
      const linkNote = s.link ? ` (link → ${s.link})` : '';
      const meta = s.meta ? `  ${s.meta.name}${s.meta.description ? ' — ' + s.meta.description.slice(0, 60) : ''}` : '';
      const issue = s.error || s.meta?.parseError;
      console.log(`   ${s.name.padEnd(36)}${linkNote}${meta}${issue ? `  ⚠ ${issue}` : ''}`);
    }
    printed++;
  }
  if (!printed) console.log('没有发现可盘点的 skills 目录');
  return 0;
}

function cmdSkillsDeploy(env, byId, rest) {
  const flags = parseFlags(rest);
  const fromId = flags.from ? String(flags.from).toLowerCase() : null;
  const toIds = flags.to ? String(flags.to).toLowerCase().split(',').filter(Boolean) : [];
  if (!fromId || !toIds.length) {
    console.error('用法：ddswitch skills deploy --from <id> --to <id[,id...]> [--name <n,...>] [--mode auto|symlink|copy] [--write]');
    return 1;
  }
  const write = flags.write === true;
  const mode = ['auto', 'symlink', 'copy'].includes(String(flags.mode)) ? String(flags.mode) : 'auto';
  const names = flags.name ? String(flags.name).split(',').filter(Boolean) : null;

  const src = byId.get(fromId);
  if (!src) { console.error(`未知工具 id：${fromId}`); return 1; }
  if (!src.detect(env)) { console.error(`源 ${fromId} 未检测到安装`); return 1; }
  const fromDir = src.skillsDir ? src.skillsDir(env) : null;
  if (!fromDir || !dirExists(fromDir)) { console.error(`[${fromId}] 没有 skills 目录`); return 1; }

  let added = 0, skipped = 0, failed = 0;
  console.log(`从 ${fromId}（${fromDir}）部署技能，模式 ${mode}，${write ? '写入' : 'dry-run'}\n`);
  for (const tid of toIds) {
    const t = byId.get(tid);
    if (!t) { console.log(`✖ 目标 ${tid} 不存在`); failed++; continue; }
    if (!t.detect(env)) { console.log(`✖ [${tid}] 未检测到安装，跳过`); failed++; continue; }
    if (write && t.caps?.skillsWrite === false) { console.log(`✖ [${tid}] 暂不支持 Skills 真实写入，跳过`); failed++; continue; }
    const toDir = t.skillsDir ? t.skillsDir(env) : null;
    if (!toDir) { console.log(`✖ [${tid}] 不支持 skills 目录，跳过`); failed++; continue; }
    const rep = deploySkills(fromDir, toDir, names, { mode, write });
    rep.lines.forEach((l) => console.log(l));
    added += rep.added; skipped += rep.skipped; failed += rep.failed;
    console.log('');
  }
  console.log(`完成（${write ? '已写入' : 'dry-run'}）：部署 ${added}，跳过 ${skipped}${failed ? `，失败 ${failed}` : ''}`);
  return failed ? 1 : 0;
}
