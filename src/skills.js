import fs from 'node:fs';
import path from 'node:path';
import { dirExists, fileExists } from './jsonutil.js';

/** Skills 跨工具盘点与部署。 */

function resolveWithin(root, name) {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
    throw new Error(`非法技能目录名：${name}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, name);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`技能路径越界：${name}`);
  return target;
}

/** 读 SKILL.md frontmatter 的稳定子集；无法解析时返回 parseError。 */
export function readSkillMeta(dir) {
  const p = path.join(dir, 'SKILL.md');
  if (!fileExists(p)) return { name: path.basename(dir), description: '', parseError: '缺少 SKILL.md' };
  try {
    const text = fs.readFileSync(p, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { name: path.basename(dir), description: '', parseError: '缺少 YAML frontmatter' };
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      let value = kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      fm[kv[1].trim()] = value;
    }
    return { name: fm.name || path.basename(dir), description: fm.description || '', parseError: null };
  } catch (e) {
    return { name: path.basename(dir), description: '', parseError: e.message };
  }
}

/** 列出目录或 symlink；悬空链接会保留并标记 error。 */
export function listSkillsDir(dir) {
  if (!dirExists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => {
      const full = resolveWithin(dir, d.name);
      let link = null, realPath = null, error = null;
      try {
        if (d.isSymbolicLink()) link = fs.readlinkSync(full);
        realPath = fs.realpathSync(full);
      } catch (e) {
        error = `悬空或不可访问链接：${e.message}`;
      }
      return { name: d.name, path: full, realPath, link, error, meta: error ? null : readSkillMeta(full) };
    });
}

/** 工具对工具部署；dry-run 也执行完整的安全校验。 */
export function deploySkills(fromDir, toDir, names, { mode = 'auto', write = false } = {}) {
  const report = { lines: [], added: 0, skipped: 0, failed: 0 };
  if (!dirExists(fromDir)) {
    report.lines.push(`[!] 来源 skills 目录不存在：${fromDir}`);
    report.failed++;
    return report;
  }
  const available = listSkillsDir(fromDir);
  const wanted = names && names.length ? new Set(names.map((n) => n.toLowerCase())) : null;
  const selected = wanted ? available.filter((s) => wanted.has(s.name.toLowerCase())) : available;
  if (!selected.length) {
    report.lines.push('[!] 来源没有匹配的技能');
    report.failed++;
    return report;
  }
  const targetRoot = path.resolve(toDir);
  if (write) {
    if (fs.existsSync(targetRoot) && fs.lstatSync(targetRoot).isSymbolicLink()) {
      report.failed++;
      report.lines.push(`✖ 目标 skills 根目录是 symlink/junction，拒绝写入：${toDir}`);
      return report;
    }
    fs.mkdirSync(targetRoot, { recursive: true });
    const resolvedTargetRoot = fs.realpathSync(targetRoot);
    if (resolvedTargetRoot !== targetRoot) {
      report.failed++;
      report.lines.push(`✖ 目标 skills 根目录 realpath 越界，拒绝写入：${resolvedTargetRoot}`);
      return report;
    }
  }

  for (const s of selected) {
    if (s.error || !s.realPath) {
      report.failed++;
      report.lines.push(`✖ ${s.name}：${s.error || '源技能不可访问'}`);
      continue;
    }
    if (!fileExists(path.join(s.realPath, 'SKILL.md'))) {
      report.failed++;
      report.lines.push(`✖ ${s.name}：真实目录缺少 SKILL.md，拒绝部署`);
      continue;
    }
    let dest;
    try {
      dest = resolveWithin(targetRoot, s.name);
    } catch (e) {
      report.failed++;
      report.lines.push(`✖ ${e.message}`);
      continue;
    }
    if (fs.existsSync(dest)) {
      report.skipped++;
      report.lines.push(`- ${s.name} 在目标已存在，跳过`);
      continue;
    }
    const kind = mode === 'copy' ? 'copy' : 'symlink';
    if (!write) {
      report.added++;
      report.lines.push(`· 将部署 ${s.name} → ${dest}（${kind}${s.link ? '，源链接会先解析' : ''}）`);
      continue;
    }
    const copyResolved = () => fs.cpSync(s.realPath, dest, { recursive: true, dereference: true });
    try {
      if (kind === 'copy') {
        copyResolved();
        report.added++;
        report.lines.push(`✓ 部署 ${s.name} → ${dest}（copy，已解引用）`);
      } else {
        fs.symlinkSync(s.realPath, dest, process.platform === 'win32' ? 'junction' : 'dir');
        report.added++;
        report.lines.push(`✓ 部署 ${s.name} → ${dest}（symlink）`);
      }
    } catch (e) {
      if (kind === 'symlink') {
        try {
          copyResolved();
          report.added++;
          report.lines.push(`✓ 部署 ${s.name} → ${dest}（symlink 失败，已降级解引用 copy）`);
          continue;
        } catch { /* 落入 failed */ }
      }
      report.failed++;
      report.lines.push(`✖ 部署 ${s.name} 失败：${e.message}`);
    }
  }
  return report;
}
