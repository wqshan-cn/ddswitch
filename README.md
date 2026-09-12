# ddswitch

**ddswitch：AI 编程工具统一管理器**（通用于国产与海外主流工具）：**全机扫描盘点 + MCP 跨工具同步 + Skills/记忆资产盘点**。

一个命令扫描出电脑上装了哪些 AI 编程工具、各自有哪些 MCP 服务器/Skills/记忆；一条命令把任意工具的 MCP 配置同步到任意其他工具；还可以读取本地结构化 usage 做 Token 趋势和模型分组统计。解决的核心痛点：每家工具配置格式和路径都不同，配一遍 MCP 要在 N 个工具里重复 N 次。

## 与 CC Switch 的关系

**ddswitch 明确借鉴了 [CC Switch](https://github.com/farion1231/cc-switch) 的架构经验和开源实现思路，并在项目中保留致谢。** CC Switch 是独立项目，ddswitch 与其没有官方隶属、赞助或品牌关联；ddswitch 不是 CC Switch 的官方版本或分支。

借鉴内容包括：统一 MCP 中间模型、原子写 + 备份、外科手术式合并、未管理资产扫描、Skills 的 symlink/copy 部署、适配器分层和跨客户端同步思路。ddswitch 的改进方向是：用**注册表模式**替代硬编码的 `AppType`/`McpApps` bool 字段；优先补齐国产工具、WorkBuddy；加入全机诊断、记忆资产盘点和 Windows 桌面安装器。

本项目在 MIT 许可范围内使用和改造相关思路；请同时遵守 CC Switch 原项目的许可证和归属要求。

## 项目定位

ddswitch 是通用 AI 编程工具管理器，支持国产与海外主流工具，并不隶属于 CC Switch。

原有架构与经验深度借鉴 CC Switch。两处关键改进：用**注册表模式**替代其硬编码的 `AppType`/`McpApps` bool 字段（新增工具零侵入）；**国产生态优先补齐**（ZCode/Qoder/Trae/Kimi/CodeBuddy 在现有开源工具中无人支持，是空白点）。

零依赖，纯 Node.js ESM（**>=18，三大平台 Windows / macOS / Linux**）。

## Windows 桌面版

项目同时提供类似 CC Switch 的 Windows 安装包：

- `DDSwitch-0.1.0-Setup-x64.exe`：NSIS 安装器，可选择安装目录并创建桌面/开始菜单快捷方式。
- `DDSwitch-0.1.0-Portable-x64.exe`：便携版，解压或直接运行，不需要安装 Node.js。

桌面版启动后提供：工具总览、MCP 列表、Skills 盘点、doctor 诊断；所有真实写入仍遵循 dry-run/明确写入策略，WorkBuddy 保持只读。

开发环境运行：

```bash
npm install
npm run desktop
```

构建 Windows 安装包：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

国内网络建议加镜像，避免 electron-builder 下载资源超时：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win
```

本地构建产物位于 `dist-desktop/`。当前包使用 Electron 默认图标和未配置发布证书，正式发布前应补自有图标和代码签名证书；同时建议在安装器首次启动时提供数据目录备份提示。

## 快速开始

```bash
npm test
node bin/ddswitch.js scan                                        # 全机扫描
node bin/ddswitch.js doctor                                      # 自诊断（路径不对时先跑这个）
node bin/ddswitch.js mcp list                                    # 列出各工具的 MCP
node bin/ddswitch.js mcp sync --from qoder --to zcode,claude     # 默认 dry-run
node bin/ddswitch.js mcp list --agent workbuddy                   # 查看 WorkBuddy default profile
node bin/ddswitch.js mcp sync --from qoder --to kimi --server GitHub --write  # 真正写入
node bin/ddswitch.js mcp sync --from 导出.json --to gemini --write             # 从导出文件同步
node bin/ddswitch.js mcp remove qoder GitHub --write             # 删除某工具的 MCP
node bin/ddswitch.js mcp export --agent zcode --out mcp.json     # 导出为统一 JSON
node bin/ddswitch.js skills list                                 # 技能盘点（含链接拓扑）
node bin/ddswitch.js skills deploy --from zcode --to claude --write  # 跨工具部署技能
ddswitch usage summary --range 7d                         # Token 汇总
ddswitch usage breakdown --range 30d                      # 按来源/模型分组
ddswitch usage export --range 30d --out usage.json       # 安全字段导出
```

同步是**跨阵营**的：Qoder → ZCode、Qoder → Claude、Claude → Kimi……任意方向组合都走同一条命令。

## Token 用量统计

`ddswitch` 的 Token 统计只读取本地结构化数据库，不读取 prompt、会话正文、凭据、headers 或 raw usage JSON。

| 来源 | 粒度 | 数据源 | 状态 |
|---|---|---|---|
| ZCode | request-level | `~/.zcode/cli/db/db.sqlite` 的 `model_usage` | 支持输入/输出/reasoning/cache、模型、provider、耗时、失败数 |
| Codex | request-level（JSONL） | `~/.codex/sessions/**/rollout-*.jsonl` 的 `token_count` 事件（`last_token_usage` 增量） | 无 JSONL 数据时回退 `state_5.sqlite` threads 的 thread 级估算 |
| Claude Code | - | 暂无可靠结构化 usage 源 | 不猜测、不读取 `.claude/profiles/.history` |
| WorkBuddy | - | 不读取 SQLite/connector 状态层 | 保持只读 |

**Input 语义**（借鉴 CC Switch 的 SSOT 归一）：Anthropic 系上报的 input 不含缓存（fresh），OpenAI/Gemini 系包含（total）。Codex JSONL 记录标注 `total` 并同时计算 fresh 值；ZCode 背后既有 GLM 又有 OpenAI 系中转，标注 `unknown`，UI 显示语义警告，跨模型直接对比需注意。

**成本估算**（借鉴 CC Switch `model-pricing.json`）：默认不内置价格（中转价与官方价差异大，猜测会产生误导性账单）。在 `~/.ddswitch/model-pricing.json` 配置每百万 token 单价后，summary/页面会显示估算成本：

```json
{ "version": 1, "models": [ { "modelId": "glm-5.3-flash",
  "inputCostPerMillion": "0.5", "outputCostPerMillion": "2",
  "cacheReadCostPerMillion": "0.1", "cacheCreationCostPerMillion": "0" } ] }
```

聚合规则：成功请求计入消耗；`provider_total_tokens` 优先于 `computed_total_tokens`，不会相加；重复的 `logical_request_id + attempt_index` 去重；缺失值保持未知，不强制变成 0。统计不是官方账单。

Electron 桌面版的“Token 用量”页面提供总量卡片、按日趋势、来源/模型分组；CLI 提供 `usage summary`、`usage breakdown` 和安全字段 `usage export`。

## 平台支持与检测置信度

- **Windows**：全量实测（所有格式的 ground truth 来自实机）。
- **macOS / Linux**：CLI 系工具（`~/.zcode`、`~/.claude`、`~/.codex`、`~/.gemini`、`~/.kimi`、`~/.config/opencode`、`~/.qoder`）路径与平台无关，天然支持；VS Code 系 fork（Trae、CodeBuddy）按各平台数据目录惯例展开：win `%APPDATA%\<名>` / mac `~/Library/Application Support/<名>` / linux `$XDG_CONFIG_HOME/<名>`，并有单测覆盖三平台 fixture。
- **JSONC 边界**：JSONC/尾逗号配置可以读取和诊断，但为了不丢注释与未管理文本，真实写入会拒绝，需先转换为标准 JSON。
- **检测置信度分级**（scan/doctor 中可见）：
  - `verified`：官方文档确认或实机实测（Claude 的 `~/.claude.json`、Trae 的 `User/mcp.json` 等）；
  - `inferred`【推断】：按生态惯例推断、未经官方确认（CodeBuddy）。inferred 工具**默认禁止写盘**（只读），避免写坏未确认的格式——社区验证后升级。
- **你的机器上路径不对？** 跑 `node bin/ddswitch.js doctor`，把完整输出贴到 issue——doctor 列出每个工具尝试过的所有候选路径和配置解析结果，是适配新环境的唯一需要的现场信息。
- **分发前提**：需要 Node ≥ 18（`npx` 方式或克隆运行）。单文件二进制分发（`bun compile` / `pkg`）在路线图中，目标是让无 Node 环境的用户也能直接用。

## 支持矩阵

| 工具 | 阵营 | MCP 读写 | 配置位置（实测/官方） | Skills / 记忆盘点 |
|---|---|---|---|---|
| ZCode | 国产 | ✔ / ✔ | `~/.zcode/cli/config.json` → `mcp.servers` | `skills/`（symlink）、`cli/memories/` |
| Qoder | 国产 | ✔ / ✔ | `~/.qoder/settings.json` → `mcpServers` | `memory/` |
| Trae（CN/SOLO CN/国际版） | 国产 | ✔ / ✔ | `%APPDATA%\<变体>\User\mcp.json` | - |
| Kimi CLI | 国产 | ✔ / ✔ | `~/.kimi/mcp.json` | - |
| CodeBuddy | 国产 | ✔ / 禁写 | VS Code fork 惯例路径（inferred，待社区验证后开放写入） | - |
| WorkBuddy | 国产 | ✔ / 禁写 | `~/.workbuddy/connectors/default/mcp.json` → `mcpServers`（default connector profile；`connector-states.json` 不纳入） | `skills/`、`memory/`、`IDENTITY.md`/`SOUL.md`/`USER.md` |
| Claude Code | 海外 | ✔ / ✔ | `~/.claude.json` → `mcpServers`（user scope） | `skills/`、`CLAUDE.md` |
| Codex | 海外 | ✔ / ✔ | `~/.codex/config.toml` → `[mcp_servers.*]`（toml-lite 段级 splice，注释与其他段逐字保留） | `skills/`、`AGENTS.md` |
| Gemini CLI | 海外 | ✔ / ✔ | `~/.gemini/settings.json` → `mcpServers` | - |
| OpenCode | 海外 | ✔ / ✔ | `~/.config/opencode/opencode.json` → `mcp` | - |

注意：`~/.zcode/mcp/<name>/` 是各 MCP 服务器的**运行工作区**（node_modules 等），不是配置，适配器不会触碰。

## 设计原则

1. **Dry-run 默认**：所有写操作默认只打印计划，`--write` 才落盘。
2. **原子写 + 备份**（借鉴 CC Switch）：覆盖前先备份 `<file>.ddswitch.bak`，写临时文件后 rename 替换。
3. **外科手术式合并**：只动 MCP 容器键，其他顶层键（Qoder 的 `enabledPlugins`、ZCode 的 `plugins`、Claude 的 `oauthAccount`/`projects` 等状态键）与键序原样保留。
4. **大小写不敏感判重**：Qoder 的 `GitHub` 与 ZCode 的 `github` 视为同一服务器；写入 ZCode 时键名自动转小写。
5. **raw 透传**：服务器定义按原生 JSON 保存，私有字段（如 Qoder 的 `qoder_url`）不丢失、不猜测语义。
6. **默认不泄露凭据**：普通 list/scan/show/export 默认脱敏 env、headers、URL 查询串和敏感命令参数；只有显式 `--include-secrets` 才导出原始敏感值。`credentials.json` 等独立凭据文件仍不读取。

## 架构

```
bin/ddswitch.js          CLI 入口
src/cli.js               scan / mcp / skills 命令实现
src/model.js             McpEntry 摘要、报告模型、大小写规范 id
src/jsonutil.js          原子写（JSON/文本）+ 备份、嵌套路径 get/ensure、JSONC 兜底解析
src/toml-lite.js         Codex TOML 段级解析与 splice（绝不整体重排，保注释）
src/skills.js            Skills 盘点与跨工具部署（junction/symlink/copy，失败降级）
src/usage-model.js       UsageRecord、token 聚合、按日/模型统计
src/usage-readers.js     ZCode request-level / Codex thread-level 只读 reader
src/adapters/
  index.js               注册表（10 个适配器）+ defaultEnv 路径解析
  jsonfamily.js          同构 JSON 家族工厂（新增同构工具 ≈ 20 行 spec）
  zcode.js               ZCode（mcp.servers 嵌套 + 小写规范）
  codex.js               Codex（TOML 段级 upsert/remove）
  claude.js / gemini.js  Claude Code / Gemini CLI
  workbuddy.js           WorkBuddy default connector profile（只读）
  stubs.js               CodeBuddy 探测适配器
tests/                   node --test 单元测试（58 个，含三平台 fixture）
```

**加新工具只需一份 spec**（同构 JSON 家族约 20 行）：

```js
createJsonFamilyAdapter({
  id: 'xxx', displayName: 'XXX',
  resolve: (env) => ({ file: path.join(env.home, '.xxx', 'mcp.json'),
                       containerPath: ['mcpServers'], createIfMissing: true }),
  detected: (env) => dirExists(path.join(env.home, '.xxx')),
  confidence: 'verified',   // 或 'inferred'（未实测，默认禁写）
})
```

**适配新环境/新工具的流程**：拿到用户 `doctor` 输出 → 在对应适配器里加候选路径或新 spec → 用 `tests/platform.test.js` 的 fake env 模式补三平台 fixture → `verified` 后开放写入。

## 路线图

- **近期**：WorkBuddy 重启加载行为验证后决定是否开放写入；CodeBuddy 数据目录确认与适配；Skills SSOT 中心仓库（`~/.ddswitch/skills/`，学 CC Switch SkillStore，收编/更新检测/内容哈希）。
- **中期**：记忆资产管理（浏览/备份/去重 `cli/memories/`、`memory/`、`CLAUDE.md`/`AGENTS.md`）——现有开源工具的空白点；GUI（Tauri 2 或 Web）。
- **远期**：备份/恢复与云同步（学 CC Switch `webdav_sync`）；更多工具按同构 spec 陆续接入（Cursor/Cline/Windsurf 等配置在 IDE 内部的工具需逐家确认存储格式）。

## 致谢

- [CC Switch](https://github.com/farion1231/cc-switch)：统一 MCP 模型（v3.7 `McpServer{server, apps}`）、原子写、备份轮换、未管理资产扫描等设计均受其启发。
- [microsoft/apm](https://github.com/microsoft/apm)："detected clients" 自动检测思路。

License: MIT
