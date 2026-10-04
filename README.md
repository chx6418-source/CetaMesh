# 鲸桥 WhaleBridge — QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 📘 详细内外核说明书见 **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**（架构、数据流、配置全解、调试与改进指南）。
> 🖥️ 桌面版（独立应用、安装/迁移/卸载、构建发布、故障排查、决策记录）见 **[docs/DESKTOP_APP.md](docs/DESKTOP_APP.md)**；
> ✅ 需要人工完成的验收项见 **[docs/DESKTOP_ACCEPTANCE.md](docs/DESKTOP_ACCEPTANCE.md)**。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

> **桌面 UI 迁移状态（2026-09-23）**：默认发行构建已改为不打包 WhaleBridge 产品网页，桌面窗口/安装向导已切到 Rust 原生 UI，
> 控制管理走本机 IPC；最新 no-web release candidate 已在仓库外隔离目录通过自动化安装/恢复验收。旧控制台的完整功能仍在迁移，现有 `dist/app` 是历史产物、不是新原生发行包；详见
> [原生迁移状态](docs/DESKTOP_APP.md#13-去网页化迁移当前状态)。不要按下文旧控制台截图/流程推断当前原生界面已具备相同功能。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](assets/project-intro.mp4)

> 视频文件位于 `assets/project-intro.mp4`，可直接下载观看。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：复用官方 `@deepseek-ai/dsh-host-apiproxy` 的 `AbstractApiClient` 与 zod schema，桥接进程实现 Node 传输层（fetch unary + WebSocket 下行事件流）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：`snowluma_status`（默认只读探活）；`start_snowluma` / `stop_snowluma` 需显式开启 `snowluma.allowProcessControl: true` 且仅在 `closed-agent` 模式可用
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`。会话创建后桥接会立即 `selectModel` 绑定 `dsh.model`（默认 DeepSeek-V41-Flash），因此新建会话无需手动切模型（该调用同时会把模型写进 DSH 的 `agent-default-model` 设置）
- **性格定制**：QQ 会话默认使用 `whale-chat` agent preset（`~/.dsh/.agent-presets/whale-chat/agent.cordis.yml`），`reserved2` 使用 `whale-chat-v2`（`~/.dsh/.agent-presets/whale-chat-v2/agent.cordis.yml`）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **命令行实时状态面板**：在交互式命令提示符里运行时，日志下方常驻一块状态区（1 秒刷新）：模式、DSH 连接状态、每个会话的实时状态（回合中 / 待回答 / 沉睡至几点 / 长潜 / 未读数 / 最后来讯时间等）；日志从面板上方滚动，互不干扰。输出被重定向到文件时面板自动关闭（设 `NO_STATUS_PANEL=1` 也可强制关闭）
- **本机管理界面（迁移中）**：桌面版使用 Rust/egui 原生窗口与命名管道，不依赖 WhaleBridge 网页；当前覆盖概览/重启、角色、安全通知、全局模式与 Owner/allow-deny、本地 SnowLuma/DSH 服务发现/选择/安装/启停、模型目录与默认模型、Preset 列表/绑定、审批/提问与风险卡片审批、黑话配置、会话状态、活动/日志只读查看和白名单诊断。发送参数、实时事件订阅、记忆、贴纸、文件/音频/Kugou 及其它旧控制台功能仍待迁移，不能通过新桌面版 HTTP console token 代替。
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → whale-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ router-standard 完整工具，可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `whale-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - **QQ 官方机器人卡片查看与按钮交互**（二代/reserved2）：QQ 官方机器人卡片主要有两类——**Markdown 卡片**（`markdown` + `inline_keyboard` 段：随机图／今日梦境／今日运势这类互动卡，正文会渲染成可读文本、按钮显示为 `[按钮:💖喜欢/💔不喜欢/🔄再来一张]`，卡片插图进入图片管线，用 `qq_get_message_images` 就能看图）与**图文/活动类卡片**（`json` / `ark`，正文折叠为 `[卡片消息]` / `[活动卡片]`）。AI 可用只读的 `qq_get_card_msg`（参数 `key` / `messageId` / `token`，可选 `index`）读取完整原文和结构化字段；返回值会给每张卡片/按钮标注 `cardIndex`、`buttonIndex`、`clickable`、`riskLevel`、`requiresApproval` 与 `riskReasons`，随后可用 `qq_click_card_button` 按索引点击群聊 Markdown 卡片的回调/指令按钮。风险分级采用“明确低风险白名单 + 高风险信号 + 未知用途默认审批”：支付/交易、账号授权、订阅报名、签到、抽奖领奖、隐私外发、删除或管理操作等内容只会生成 10 分钟有效的待审批请求，管理员可在控制台或通过 QQ 命令逐次批准/拒绝，批准前不会点击；Agent 可用 `qq_get_card_button_approval` 查询结果，只有 `completed` 才表示已执行。批准时桥接会重新回源消息并核对按钮指纹，点击工具也不会接受 Agent 自填的 `bot_appid`、按钮 ID 或回调载荷；链接按钮和私聊卡片保持只读。卡片缓存按会话隔离并单独落盘（`state/social-v2-cards.json`，有界），缓存未命中时用 OneBot `get_msg` 按需回源。`qq_click_card_button` 属于高风险写操作，控制台有醒目警示与启用确认，配置项 `socialV2.tools.clickCardButton` **严格默认关闭**，且每次调用必须显式传 `confirm=true`；开关即时生效、无需重启。
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`；未运行时桥接会保留消息队列并继续提供控制台）
2. Node.js ≥ 22.13
3. SnowLuma 为可选本地子服务：已安装时桥接启动会优先尝试启动；未安装或启动失败不会阻塞 WhaleBridge 主程序

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；默认 `deepseek-flash`（DeepSeek-V41-Flash，声明了图像输入）。**该模型必须支持图像输入**：桥接给每个会话都 `selectModel` 绑定它，文本模型（如 `deepseek-v4-flash`）会让 QQ 图片被 DSH 替换成 `[image unavailable]`，表现为「图片识别失效」。若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录；控制台会优先使用这两个字段，缺省时检测 WhaleBridge 根目录下的 `SnowLuma` 文件夹 |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `whale-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `whale-chat-v2` |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### SnowLuma / DSH 外部服务

SnowLuma、DSH 仍作为外部服务运行，WhaleBridge 保留 OneBot、DSH RPC/WebSocket 和 MCP 接入，不把第三方服务页面嵌入 WhaleBridge。
原生版本已迁移 SnowLuma/DSH 的发现、安装、启停与路径选择基础操作；首次第三方服务同意、QQ 注入和完整配置向导仍需按各自受支持的方式完成，
并在 WhaleBridge `config.json` 中设置 OneBot URL、token、DSH URL 与外部服务路径。不要把旧 Web 控制台/终端能力当成当前原生界面功能。

### DSH 端安装（另一台设备 / 新环境）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`whale-chat` / `whale-chat-v2`）并挂载 MCP：

```bash
node scripts/setup-dsh.mjs
```

默认安装到 `web` profile，可用 `node scripts/setup-dsh.mjs <profile>` 指定；
`--dry-run` 只打印计划不改文件，`--force-presets` 连被改过的 preset 一起覆盖。

脚本是**幂等**的，重复运行不产生改动。升级时只更新"由本应用安装且此后未被你改动"的 preset
（依据 `~/.dsh/.whalebridge-integration.json` 记录的内容哈希），你改过的或来源不明的 preset 一律
保留并提示；你自己创建的 preset、你自己的 MCP 条目都不会被删除；失败会自动回滚到执行前状态。
旧的 `src/mcp-*.js` 配置会被就地迁移为统一入口。

> 安装包安装的版本没有 `scripts/` 目录，用同一个入口：`WhaleBridgeCore.exe --setup-dsh web`。
> 它把 MCP 的 command 直接指向 `WhaleBridgeCore.exe`，目标机器不需要安装 Node.js。

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `whale-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖，可手动在 DSH 设置页的 `whale-mode` 卡片切换。

详细步骤见 **[docs/DSH_SETUP.md](docs/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

旧版发行流程曾提供控制台引导；当前原生迁移尚未包含第三方服务安装配置向导。请先分别准备好 DSH 与 SnowLuma，再核对 WhaleBridge 配置：

1. **DSH**（可选自动启动）
   安装 DSH 并按 DSH 自身说明启动其本地 API；WhaleBridge 目前不提供 DSH Web 管理界面的替代物。

2. **SnowLuma（可选手动准备）**
   - 控制台会从 <https://github.com/SnowLuma/SnowLuma/releases/latest> 自动安装到仓库根目录的 SnowLuma 文件夹；也可以手动解压后在 config.json 填写 snowluma.homeDir / launcherPath。
   - 完整版自带 Node 运行时；Lite 版需本机 Node 22.13+。

3. **SnowLuma 首次配置（第三方服务自身）**
   - WhaleBridge 不再打开或自动化 SnowLuma 页面。若 SnowLuma 当前版本要求图形化同意/QQ 注入/OneBot 配置，请按其自身受支持的管理方式完成；这仍是鲸桥原生化未完成项。
   - 配置 OneBot WebSocket / HTTP API 地址与 accessToken 后，填入下方 WhaleBridge `config.json`。

4. **填写桥接配置**（`config.json`）
   ```json
   "snowluma": {
     "wsUrl": "ws://127.0.0.1:3001",
     "httpUrl": "http://127.0.0.1:3000",
     "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
   }
   ```
   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。
   建议顺手把 `allow.private` / `allow.groups` 白名单填上。

5. **启动桥接**
   ```bash
   cd WhaleBridge
   npm start          # 或双击 start.bat
   ```
    在本次原生迁移完成前，旧 VBS/网页启动流程与原生桌面壳功能并不等价。开发运行仍可 `npm start`；新原生窗口用桌面壳构建启动，服务管理与模型/Preset 基础页已接入，但审批、记忆和多媒体等旧控制台功能仍在迁移。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 不需要动桥接**：桥接会自动检测 DSH 恢复（每 5 秒探活），DSH 重启期间收到的 QQ 消息会**入队缓存**（最多 50 条/会话），恢复后自动补投，不会丢
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `~/.dsh/.agent-presets/whale-chat*/` 或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```
```

## 自测（不需要 SnowLuma / QQ）

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 统一 Core 入口与独立 EXE

源码模式下 worker、五个 MCP 和自测共用同一个入口，原脚本直接运行方式继续保留：

```bash
node src/core-entry.js --worker
node src/core-entry.js --mcp snowluma          # 另有 snowluma-host / web-search-safe / qq-file-send / bilibili
node src/core-entry.js --setup-dsh web         # 安装/修复/迁移 DSH 集成
node src/core-entry.js --self-test [DSH_BASE_URL] [PROMPT]
node src/core-entry.js --help
```

`src/app-paths.js` 把只读资源与可写数据分开：未设置环境变量时两者都是仓库根（源码模式布局不变），
`WHALEBRIDGE_RESOURCE_DIR` 指定 `public/`、`assets/`、内置角色等只读资源，
`WHALEBRIDGE_DATA_DIR`（或 `--data-dir <目录>`）指定 `config.json`、`state/`、用户角色等可写数据。

打包成不依赖系统 Node.js 的独立核心（Windows x64）：

```bash
npm run build:core        # 生成 dist/core/WhaleBridgeCore.exe 与 dist/core/resources/
npm run test-core-dist    # 发行产物烟测：隔离 PATH / 临时数据目录 / 临时端口
```

产物布局：

```
dist/core/
  WhaleBridgeCore.exe    # 独立核心：--worker、五个 --mcp 模式、--setup-dsh、--self-test、--help
  resources/             # 只读资源（public/ roles/ assets/ dsh/ plugins/ config.example.json product.json）
  runtime-manifest.json  # 版本、工具链、体积与 sha256
```

打包运行时：资源默认取 exe 同目录 `resources/`（无需设置 `WHALEBRIDGE_RESOURCE_DIR`），
可写数据默认 `%LOCALAPPDATA%\WhaleBridge`（exe 同目录放一个空的 `portable.flag` 即切换为
exe 同目录 `data/` 的便携模式）。安装目录始终只读。

## Windows 桌面壳（原生迁移中）

`desktop-shell/` 的正式 Cargo target 现为 Rust + eframe/egui 原生桌面壳，负责拉起并监管 Core；桌面管理使用命名管道 IPC，发行构建默认剔除产品 HTML：

```bash
npm run desktop:build:debug       # 调试版（保留控制台，自检模式需要它）
npm run desktop:test              # Rust 单元测试（退出码策略/退避/健康探针/路径解析）
npm run test-desktop-supervisor   # 托管 worker 契约（孤儿守卫、退出码）
npm run test-desktop-shell        # 端到端：拉起→健康→重启→端口冲突→窗口→强杀不留孤儿
```

- 数据目录优先级与 Core 一致：`--data-dir` > `WHALEBRIDGE_DATA_DIR` > `portable.flag` >
  `%LOCALAPPDATA%\WhaleBridge`；壳会把它注入 worker 环境，避免两处指向不同目录。
- 退出码契约：0=正常结束（不重启）、2=已有实例/端口占用（不重启）、10=请求重启（立即重启）、
  其它=异常退出（按 5/10/20/30 秒退避重启，连续 5 次后放弃）。`start.bat` 的守护循环除 2
  之外都重启，因此 `--restart` 改成 10 对它完全透明。
- 由桌面壳拉起的 worker 会带 `WHALEBRIDGE_SUPERVISED=1`：此时「关闭主程序」只退出本进程，
  不再扫描并杀掉机器上其它 `start.bat` 守护循环；壳被强杀时 worker 也会因 stdin 关闭自行退出。
- 当前关闭原生窗口会结束桌面壳并有界停止其 Core；系统托盘尚未迁移。
- 诊断：`whalebridge-desktop.exe --print-core-command`（选路与端口）、
  `--smoke-test`（无窗口跑一遍拉起→就绪→优雅停止）。日志在 `<数据目录>\logs\`。

> 原生 GUI 仍需人工验收（DPI、中文输入法、键盘/复制粘贴、管道 ACL）；C4 图标已接入应用 EXE、单文件安装器、窗口和安装向导。

## 安装与卸载（同一个 exe）

桌面壳自身就是安装器与卸载器，全部根目录都可用参数覆盖（因此可以装到任意目录）：

```bash
WhaleBridge.exe --install                 # 安装；已安装则升级（不覆盖 config.json 与数据）
WhaleBridge.exe --install --dry-run       # 只打印计划，不写任何文件
WhaleBridge.exe --repair                  # 修复：补齐缺失/被改动的程序文件，保留数据与配置
WhaleBridge.exe --migrate --from <旧目录>  # 迁移旧数据（默认不覆盖已存在的目标文件）
WhaleBridge.exe --uninstall               # 卸载：默认保留用户数据
WhaleBridge.exe --uninstall --remove-data --remove-dsh-integration   # 彻底卸载
WhaleBridge.exe --help                    # 全部参数
```

- 安装布局：`%ProgramFiles%\WhaleBridge\{WhaleBridge.exe, WhaleBridgeCore.exe, resources\, runtime-manifest.json, install-manifest.json}`；
  payload 来自安装包解压出的 `payload\`（即 `dist/core` 的内容）。
- 卸载只删除 `install-manifest.json` 记录且**内容未被你改过**的文件；你自己放进安装目录的东西、
  你改过的 preset/MCP 配置一律保留并提示。
- 默认保留 `%LOCALAPPDATA%\WhaleBridge`（配置、state、日志、令牌）；`--remove-data` 才会删除，
  且删除前会再警告一次。
- 迁移会先校验 JSON、畸形文件跳过、外部工具路径（ffmpeg/DSH/SnowLuma）不存在时只告警不改写，
  真实令牌不会出现在输出里，旧目录始终保留。
- 构建产物会做发行审计：混入 `config.json`、`state/`、日志、`.node`/`.dll`、SnowLuma 文件或
  访问令牌时直接构建失败。

## 发布候选（RC）

```bash
npm run build:core             # 1) 打包 Core（Node SEA）
npm run desktop:build          # 2) 编译 release 桌面壳
npm run build:release          # 3) 组装 dist/app 发布候选 + SBOM/许可证/哈希 + 发行审计
npm run test-release-candidate # 4) 用发行包在沙箱里跑真实配置（无 Node、中文+空格路径）
```

普通用户双击 `WhaleBridge-Setup-x64.exe`，点击“立即安装”即可；首次安装默认到当前用户的
`%LOCALAPPDATA%\Programs\WhaleBridge`，不需要管理员权限。检测到已有鲸桥时会沿用原安装位置升级。`dist/app/` 同时保留高级用法需要的文件：

```
WhaleBridge-Setup-x64.exe  单文件安装器（鲸桥风格的安装向导）
WhaleBridge.exe             release 桌面壳（安装器/卸载器同体）
payload/                    Core（WhaleBridgeCore.exe + resources/）
INSTALL.txt                 安装/卸载/迁移说明
licenses/THIRD-PARTY.md     第三方组件清单（含"再分发前必须补齐"）
SHA256SUMS.txt              全部产物的 sha256
sbom.json                   CycloneDX SBOM
release-manifest.json       版本/体积/哈希/审计结论/已知偏差/未验证项
```

`npm run test-installer-package` 用临时夹具验证单文件安装器能由 Windows IExpress 构建。
`npm run test-release-candidate` 验证的是**真实发行配置**：桌面壳拉起的是
`WhaleBridgeCore.exe`（不是 node），全程 PATH 里没有 node.exe，安装路径含中文与空格，
运行期安装目录保持只读，强杀 Core 会在退避后自动拉起，第二次启动只留单实例，
强杀壳后 Core 自行退出，卸载保留用户数据。

> 尚未完成（需要你的环境）：真实安装到本机、Windows 10、真实 QQ/DSH 会话下的四种模式与全部
> MCP 工具、DSH/SnowLuma 重启恢复、托盘菜单点击与 WebView2 交互、代码签名。
> 这些项已逐条记录在 `DESKTOP_APP_WORKPLAN.tmp.md` 的 §11.2 与 `dist/app/release-manifest.json`
> 的 `notVerified` 中。

## 目录结构

```
WhaleBridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  docs/
    PROJECT_GUIDE.md    # 公开版项目说明书
  dsh/agent-presets/    # whale-chat / whale-chat-v2 的 DSH agent preset 模板
  plugins/whale-mode-console  # DSH 设置页 whale-mode 卡片插件
  src/
    bridge.js           # 主程序
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
  dist/core/            # 打包产物：WhaleBridgeCore.exe + resources/（不入库，npm run build:core 生成）
  desktop-shell/        # Windows 桌面外壳（Rust/Tauri，见 desktop-shell/README.md）
```

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 4000 字自动分段
- QQ 图片/语音/视频会转成 `[图片]` 等占位文本给 agent
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
