// Skills 悬空链接修复脚本（一次性验收工具，受 Codex 搬家启发）：
// 1. 扫描指定 skills 目录的悬空 symlink
// 2. 若同名技能存在于候选 SSOT 目录（~/.agents/skills 优先），重指过去
// 3. 目标处处不存在的链接：仅报告（不擅自删除）
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.USERPROFILE;
const EXECUTE = process.argv.includes('--write');
const candidateRoots = [
  path.join(home, '.agents', 'skills'),
  path.join(home, '.codex', 'skills'),
  path.join(home, '.claude', 'skills'),
];

function resolveReal(dir) {
  try { return fs.realpathSync(dir); } catch { return null; }
}

function scanDangling(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      try { fs.statSync(full); } catch { out.push({ name: e.name, link: full, oldTarget: fs.readlinkSync(full) }); }
    }
  }
  return out;
}

function findNewTarget(name, excludeDir) {
  for (const root of candidateRoots) {
    if (path.resolve(root) === path.resolve(excludeDir)) continue;
    const candidate = path.join(root, name);
    const real = resolveReal(candidate);
    if (real && fs.existsSync(path.join(real, 'SKILL.md'))) return { candidate, real };
  }
  return null;
}

let fixed = 0, unfixable = 0;
for (const [label, dir] of [
  ['zcode', path.join(home, '.zcode', 'skills')],
  ['claude', path.join(home, '.claude', 'skills')],
]) {
  const dangling = scanDangling(dir);
  if (!dangling.length) { console.log(`✔ ${label}: 无悬空链接`); continue; }
  console.log(`${label}: ${dangling.length} 个悬空链接`);
  for (const d of dangling) {
    const found = findNewTarget(d.name, dir);
    if (!found) {
      unfixable++;
      console.log(`  ✖ ${d.name}：所有候选位置均无此技能（真被删除）→ 建议手动删除该链接${EXECUTE ? '' : '（本次未动）'}`);
      continue;
    }
    if (!EXECUTE) {
      console.log(`  · ${d.name}: ${d.oldTarget} → ${found.candidate}（解析到 ${found.real}）`);
      continue;
    }
    fs.rmSync(d.link); // 只删链接本身，不动任何技能数据
    fs.symlinkSync(found.real, d.link, process.platform === 'win32' ? 'junction' : 'dir');
    // 验证重指后可解析且含 SKILL.md
    const ok = fs.existsSync(d.link) && fs.existsSync(path.join(d.link, 'SKILL.md'));
    console.log(`  ${ok ? '✓' : '✖'} ${d.name}: → ${found.candidate}`);
    if (ok) fixed++; else unfixable++;
  }
}
console.log(`\n模式: ${EXECUTE ? '已执行' : 'dry-run（加 --write 执行）'} | 修复 ${fixed}，无法修复 ${unfixable}`);
