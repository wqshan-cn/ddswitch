import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkillsDir, readSkillMeta, deploySkills } from '../src/skills.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-'));
}

/** Mimosa 要求：目录名走白名单 + 根目录边界校验后再 join。 */
function safeJoin(root, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`非法目录名：${name}`);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径越界');
  return target;
}

function makeSkill(base, name, description) {
  const dir = safeJoin(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'data');
  return dir;
}

test('readSkillMeta：解析 frontmatter，无 frontmatter 时降级', () => {
  const base = tmp();
  const withFm = makeSkill(base, 'alpha', '做 alpha 的事');
  assert.equal(readSkillMeta(withFm).name, 'alpha');
  assert.equal(readSkillMeta(withFm).description, '做 alpha 的事');

  const noFm = path.join(base, 'beta');
  fs.mkdirSync(noFm, { recursive: true });
  fs.writeFileSync(path.join(noFm, 'SKILL.md'), '# no frontmatter\n');
  assert.equal(readSkillMeta(noFm).name, 'beta');

  const empty = path.join(base, 'gamma');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(readSkillMeta(empty).parseError, '缺少 SKILL.md');
});

test('listSkillsDir：列出目录与 symlink，过滤文件', () => {
  const base = tmp();
  makeSkill(base, 'alpha', 'a');
  makeSkill(base, 'beta', 'b');
  fs.writeFileSync(path.join(base, 'not-a-skill.txt'), 'x');

  const skills = listSkillsDir(base);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['alpha', 'beta']);
  assert.ok(skills.every((s) => s.link === null));
});

test('deploySkills：dry-run 不落盘；写入时建立链接且同名跳过', () => {
  const from = tmp();
  makeSkill(from, 'alpha', 'a');
  makeSkill(from, 'beta', 'b');

  const to = path.join(tmp(), 'claude-skills');
  const names = null;

  const dry = deploySkills(from, to, names, { write: false });
  assert.equal(dry.added, 2);
  assert.ok(!fs.existsSync(to));

  const rep = deploySkills(from, to, names, { write: true });
  assert.equal(rep.added, 2);
  assert.equal(listSkillsDir(to).length, 2);
  // 部署结果可用：meta 能读出来（symlink/junction 透传读取）
  const deployed = listSkillsDir(to).find((s) => s.name === 'alpha');
  assert.equal(readSkillMeta(deployed.path).description, 'a');

  // 重复部署：全部跳过
  const again = deploySkills(from, to, names, { write: true });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
});

test('deploySkills：--name 过滤与 copy 模式', () => {
  const from = tmp();
  makeSkill(from, 'alpha', 'a');
  makeSkill(from, 'beta', 'b');

  const to = path.join(tmp(), 'skills2');
  const rep = deploySkills(from, to, ['ALPHA'], { mode: 'copy', write: true });
  assert.equal(rep.added, 1);
  assert.equal(listSkillsDir(to).map((s) => s.name)[0], 'alpha');
  // copy 模式是实体目录，不是链接
  const stat = fs.lstatSync(path.join(to, 'alpha'));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
});

test('deploySkills：来源目录不存在时报错行', () => {
  const rep = deploySkills(path.join(tmp(), 'nope'), path.join(tmp(), 'to'), null, { write: true });
  assert.equal(rep.added, 0);
  assert.equal(rep.failed, 1);
  assert.ok(rep.lines[0].includes('不存在'));
});

test('deploySkills：copy 模式解引用外部 symlink 为独立实体目录', () => {
  const realRoot = tmp();
  const real = makeSkill(realRoot, 'real-skill', 'real');
  const from = tmp();
  const link = path.join(from, 'linked-skill');
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const to = path.join(tmp(), 'to');
  const rep = deploySkills(from, to, null, { mode: 'copy', write: true });
  assert.equal(rep.added, 1);
  const copied = path.join(to, 'linked-skill');
  assert.ok(fs.lstatSync(copied).isDirectory());
  assert.ok(!fs.lstatSync(copied).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(copied, 'extra.txt'), 'utf8'), 'data');
});

test('deploySkills：悬空链接与缺失 SKILL.md 的目录拒绝部署', () => {
  const from = tmp();
  fs.symlinkSync(path.join(from, 'missing-target'), path.join(from, 'broken'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(from, 'no-manifest'), { recursive: true });
  const rep = deploySkills(from, path.join(tmp(), 'to'), null, { write: false });
  assert.equal(rep.added, 0);
  assert.equal(rep.failed, 2);
});

test('deploySkills：目标根目录是外部 symlink 时拒绝写入', () => {
  const from = tmp();
  makeSkill(from, 'alpha', 'a');
  const external = tmp();
  const target = path.join(tmp(), 'target-link');
  fs.symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir');
  const rep = deploySkills(from, target, null, { write: true });
  assert.equal(rep.added, 0);
  assert.equal(rep.failed, 1);
  assert.equal(fs.readdirSync(external).length, 0);
});
