const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

let core;
async function loadCore() {
  if (!core) {
    const adapters = await import('../src/adapters/index.js');
    const jsonutil = await import('../src/jsonutil.js');
    const model = await import('../src/model.js');
    const skills = await import('../src/skills.js');
    const usage = await import('../src/usage-readers.js');
    core = { ...adapters, ...jsonutil, ...model, ...skills, ...usage };
  }
  return core;
}

function makeEnv(c) { return c.defaultEnv(); }
function getAdapters(c) { return c.registry(); }
function getAdapter(c, id) {
  const found = getAdapters(c).find((a) => a.id === String(id).toLowerCase());
  if (!found) throw new Error(`未知工具 id：${id}`);
  return found;
}

async function snapshot() {
  const c = await loadCore();
  const env = makeEnv(c);
  return getAdapters(c).map((a) => {
    const info = a.detect(env);
    let mcp = null;
    if (info && a.caps?.mcpRead) {
      try { mcp = a.listMcp(env).map((e) => ({ name: e.name, summary: c.summarize(e.raw), source: e.source })); }
      catch (e) { mcp = { error: e.message }; }
    }
    const skillsDir = a.skillsDir?.(env) || null;
    return { id: a.id, name: a.displayName, info, caps: a.caps, mcp, skillsDir };
  });
}

async function doctor() {
  const c = await loadCore();
  const env = makeEnv(c);
  return { platform: env.platform, node: process.version, home: env.home, adapters: getAdapters(c).map((a) => ({ id: a.id, name: a.displayName, detected: a.detect(env), diagnosis: a.diagnose?.(env) || null, caps: a.caps })) };
}

async function mcpList(id) {
  const c = await loadCore();
  const a = getAdapter(c, id); const env = makeEnv(c);
  if (!a.caps?.mcpRead) return { id: a.id, entries: [], error: '该工具暂不支持 MCP 读取' };
  try { return { id: a.id, entries: a.listMcp(env).map((e) => ({ name: e.name, raw: c.redactMcpDefinition(e.raw), source: e.source })) }; }
  catch (e) { return { id: a.id, entries: [], error: e.message }; }
}

async function mcpSync({ from, targets, server, write = false }) {
  const c = await loadCore(); const env = makeEnv(c); const source = getAdapter(c, from);
  if (!source.detect(env)) throw new Error(`源 ${from} 未检测到安装`);
  let entries = source.listMcp(env);
  if (server) { const wanted = new Set(String(server).toLowerCase().split(',')); entries = entries.filter((e) => wanted.has(c.entryId(e.name))); }
  const results = [];
  for (const id of String(targets).toLowerCase().split(',').filter(Boolean)) {
    const target = getAdapter(c, id); const info = target.detect(env);
    if (!info) { results.push({ id, failed: true, lines: ['未检测到安装'] }); continue; }
    if (write && !target.caps?.mcpWrite) { results.push({ id, failed: true, lines: ['该工具禁止真实写入'] }); continue; }
    if (!write && !target.caps?.mcpWrite && !target.caps?.mcpPreviewWrite) { results.push({ id, failed: true, lines: ['该工具不支持写入预览'] }); continue; }
    try { const report = target.upsertMcp(env, entries, { write }); results.push({ id, ...report }); }
    catch (e) { results.push({ id, failed: true, lines: [e.message] }); }
  }
  return { write, count: entries.length, results };
}

async function mcpRemove({ id, names, write = false }) {
  const c = await loadCore(); const env = makeEnv(c); const a = getAdapter(c, id);
  if (write && !a.caps?.mcpWrite) throw new Error(`${id} 禁止真实写入`);
  if (!write && !a.caps?.mcpWrite && !a.caps?.mcpPreviewWrite) throw new Error(`${id} 不支持删除预览`);
  return a.removeMcp(env, String(names).split(',').filter(Boolean), { write });
}

async function skillsList(id) {
  const c = await loadCore(); const env = makeEnv(c);
  return getAdapters(c).filter((a) => !id || a.id === String(id).toLowerCase()).map((a) => {
    const dir = a.skillsDir?.(env); return { id: a.id, name: a.displayName, dir, skills: dir && c.dirExists(dir) ? c.listSkillsDir(dir) : [] };
  });
}

async function skillsDeploy({ from, targets, names, mode = 'auto', write = false }) {
  const c = await loadCore(); const env = makeEnv(c); const source = getAdapter(c, from); const fromDir = source.skillsDir?.(env);
  if (!fromDir) throw new Error(`${from} 没有 skills 目录`);
  const results = [];
  for (const id of String(targets).toLowerCase().split(',').filter(Boolean)) {
    const a = getAdapter(c, id); const toDir = a.skillsDir?.(env);
    if (!toDir) { results.push({ id, failed: true, lines: ['目标没有 skills 目录'] }); continue; }
    if (write && a.caps?.skillsWrite === false) { results.push({ id, failed: true, lines: ['该工具禁止 Skills 真实写入'] }); continue; }
    results.push({ id, ...c.deploySkills(fromDir, toDir, names, { mode, write }) });
  }
  return { write, results };
}

async function usageData({ range = '7d' } = {}) {
  const c = await loadCore();
  const env = makeEnv(c);
  const now = Date.now();
  const days = range === '24h' ? 1 / 24 : range === '30d' ? 30 : 7;
  return c.readUsage(env, { start: new Date(now - days * 86400000).toISOString(), end: new Date(now + 1000).toISOString() });
}

async function createWindow() {
  const win = new BrowserWindow({ width: 1180, height: 760, minWidth: 900, minHeight: 600, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  win.setTitle('ddswitch');
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.error(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
}

function register(channel, fn) { ipcMain.handle(channel, async (_event, payload) => fn(payload)); }
app.whenReady().then(async () => {
  register('snapshot', snapshot);
  register('doctor', doctor);
  register('mcp-list', ({ id }) => mcpList(id));
  register('mcp-sync', mcpSync);
  register('mcp-remove', mcpRemove);
  register('skills-list', ({ id } = {}) => skillsList(id));
  register('skills-deploy', skillsDeploy);
  register('usage-data', usageData);
  register('open-path', ({ value }) => shell.openPath(value));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
