// WorkBuddy 写入验证脚本（一次性验收工具）：
// 用与 jsonfamily 完全相同的外科合并逻辑写入一条 disabled 的无凭据测试条目，
// 并做完整完整性校验。验证通过后由用户在 WorkBuddy UI 里确认加载。
import path from 'node:path';
import fs from 'node:fs';
import { readJsonLoose, atomicWriteJson, isRecord, getAt, ensureAt } from '../src/jsonutil.js';

const home = process.env.USERPROFILE;
const file = path.join(home, '.workbuddy', 'connectors', 'default', 'mcp.json');
const before = fs.readFileSync(file, 'utf8');
const beforeSha = (await import('node:crypto')).createHash('sha256').update(before).digest('hex');

const data = readJsonLoose(file);
if (!isRecord(data)) throw new Error('配置根不是 JSON 对象');
if (!isRecord(getAt(data, ['mcpServers']))) throw new Error('mcpServers 容器缺失或非对象');

const beforeCount = Object.keys(data.mcpServers).length;
if (data.mcpServers['ddswitch-write-test']) throw new Error('测试条目已存在，跳过写入');

const container = ensureAt(data, ['mcpServers']);
container['ddswitch-write-test'] = {
  type: 'stdio',
  command: process.execPath,
  args: ['-e', "process.stdout.write('ddswitch-write-test-ok')"],
  disabled: true, // 即使被加载也不执行任何东西
};
const bak = atomicWriteJson(file, data);

// ── 完整性校验 ──
const afterText = fs.readFileSync(file, 'utf8');
const after = JSON.parse(afterText);
const checks = {
  'JSON 可解析': true,
  '条目数 50→51': beforeCount === 50 && Object.keys(after.mcpServers).length === 51,
  '测试条目存在且 disabled': after.mcpServers['ddswitch-write-test']?.disabled === true,
  '原有 50 条逐条未变': Object.entries(data.mcpServers).every(([k, v]) => k === 'ddswitch-write-test' || JSON.stringify(after.mcpServers[k]) === JSON.stringify(v)),
  '无其他顶层键': Object.keys(after).length === 1 && 'mcpServers' in after,
  '备份已生成': bak !== null && fs.existsSync(file + '.ddswitch.bak'),
  '备份内容等于写入前': fs.readFileSync(file + '.ddswitch.bak', 'utf8') === before,
  '临时文件已清理': !fs.existsSync(file + '.ddswitch.tmp'),
};
const statesFile = path.join(home, '.workbuddy', 'connectors', 'default', 'connector-states.json');
checks['connector-states.json 未动'] = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(statesFile)).digest('hex') === '7e87226f2108070bb1fe547ba151fbe608091c5b9bd37b14fb14949e3d9e68f8';

let pass = true;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? '✓' : '✖'} ${name}`);
  if (!ok) pass = false;
}
console.log(`\n写入前 sha256: ${beforeSha.slice(0, 16)}…`);
console.log(`写入后大小: ${afterText.length} 字节（原 ${before.length}）`);
console.log(pass ? '\n全部通过：等用户启动 WorkBuddy 确认「ddswitch-write-test」出现在 MCP 列表' : '\n存在失败项！');
process.exit(pass ? 0 : 1);
