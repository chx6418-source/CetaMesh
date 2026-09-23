# DSH 端安装说明（另一台设备）

`WhaleBridge` 仓库本身包含桥接、控制台和插件，但 **DSH 端的两个聊天模式（`whale-chat` / `whale-chat-v2`）以及 MCP 挂载** 不在仓库根目录，需要通过本说明安装到目标设备的 DSH 环境中。

## DSH 版本要求（≥ 0.1.5-rc.1，2026-09 起强制）

DSH 0.1.5 对 Web API 做了两次不兼容变更，桥接已适配：

1. **强制鉴权**：所有 `/api/*` 请求（含 WebSocket）必须携带 `dsh web` 签发的浏览器会话 Cookie，回环地址也不例外。
   桥接会自动用本机 `%USERPROFILE%\.dsh\.credentials.yaml`（受 `DSH_HOME` 环境变量影响）里 `client-connection/browser-session` 记录的 secret 离线锻造 Cookie，无需人工干预。
   仅当自动锻造不可用时才需要在 `config.json` 的 `dsh.authCookie` 手动填入完整 Cookie（形如 `dsh-auth-xxx=v1.…`，浏览器 DevTools 里可复制）。
2. **协议更换**：旧的 `POST /api/sessions.create`（点号式）与 `/api/events.mux` 全局事件流已移除，替换为
   `POST /api/<ns/method>`（斜杠式，payload 包一层 `{args}`）+ WebSocket `/api/remote.mux` 多路复用流
   （全局 `$events` 流承接提问/审批瀑布事件；每个会话经 `session/follow` 流收取 turn 事件）。

诊断工具：`node scripts/probe-dsh-api.mjs [baseUrl]` 可一键校验鉴权、unary RPC、事件流与提问瀑布应答闭环；
`node src/self-test.js` 可验证"建会话 → prompt → 收回复"的最小链路。

常见症状：日志每 3 秒刷一条「连接 DSH 事件流…」且无报错 —— 旧版桥接对 401 静默重试的表现（已修复，
现在 `checkDsh` 与事件流中断都会打印具体原因，例如 401/403/连接拒绝）。

## 安装步骤

在目标设备上：

1. **克隆/获取仓库**：

   ```bash
   git clone https://github.com/Derpyu520/WhaleBridge.git
   cd WhaleBridge
   ```

2. **安装依赖**：

   ```bash
   npm install
   ```

   > `postinstall` 会自动修补 `@snowluma/sdk` 的 ESM 打包 bug。

3. **创建配置文件**：

   ```bash
   cp config.example.json config.json
   ```

   > Windows CMD 用户请用：`copy config.example.json config.json`

   然后编辑 `config.json`，填写：

   - `snowluma.wsUrl` / `httpUrl`（例如 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，分别对应 OneBot WebSocket 与 HTTP API 端口）
   - `snowluma.accessToken`
   - `ownerQQ`
   - `allow.private` / `allow.groups`

4. **运行 DSH 端安装脚本**：

   ```bash
   node scripts/setup-dsh.mjs
   ```

   默认安装到 `web` profile；如果 DSH 使用其他 profile，可以传参：

   ```bash
   node scripts/setup-dsh.mjs <profile名>
   ```

   脚本会完成：

   - 安装 agent preset：`~/.dsh/.agent-presets/whale-chat`、`~/.dsh/.agent-presets/whale-chat-v2`
   - 在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载五个统一入口 MCP（`command` 为 `node.exe`，
     `args` 为 `<仓库>/src/core-entry.js --mcp <模式>`）：
     - `mcp-snowluma`（模式 `snowluma`）
     - `mcp-snowluma-host`（模式 `snowluma-host`）
     - `mcp-web-search-safe`（模式 `web-search-safe`）
     - `mcp-qq-file-send`（模式 `qq-file-send`）
     - `mcp-bilibili`（模式 `bilibili`）
   - 在 `~/.dsh/profiles/web/package.json` 注册 `whale-mode-console` 插件
   - 把 `whale-mode-console` 插件的默认模式设为 `reserved2`（二代仿真）
   - 创建本地 `state/mode.json`（`mode: reserved2`）作为 DSH settings 不可用时的兜底
   - 尝试自动执行 `dsh plugin --profile web install`（当 `dsh` CLI 在 PATH 中可用时），注册 `whale-mode-console` 的 bundle 依赖；若 `dsh` 不在 PATH，缺失依赖时 DSH 会提示补跑

   > 脚本可重复运行；重复执行不会产生任何文件改动（幂等）。
   > **它不会覆盖你改过的 preset**：判断依据是 `~/.dsh/.whalebridge-integration.json` 里记录的内容哈希
   > —— 由本应用安装且此后未被改动的 preset 会自动升级；被你改过、或来源不明（与内置不一致且无记录）
   > 的 preset 一律保留并打印提示，确认要覆盖时加 `--force-presets`。
   > 你自己创建的 preset（例如 `liangshen`）、你自己的 MCP 条目、不是链接的插件目录都只会被报告，不会被删除。
   > 已存在的 `WhaleBridge/state/mode.json` 会被保留（不覆盖用户设置）；全新安装才会写入 `mode: reserved2`。
   > 如果之后把 `WhaleBridge` 目录移动/重新 clone 到别的路径，请重新运行一次本脚本，否则 DSH 里的 MCP/插件绝对路径会指向旧位置。
   > 也可用环境变量指定 DSH 根目录：`DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>`。

   常用选项：

   ```bash
   node scripts/setup-dsh.mjs web --dry-run          # 只打印计划，不改任何文件
   node scripts/setup-dsh.mjs web --force-presets    # 连被改过的 preset 一起覆盖
   node scripts/setup-dsh.mjs web --no-plugin-install
   node scripts/setup-dsh.mjs web --json             # 供脚本消费的结构化输出
   ```

   > 用安装包安装的版本没有 `scripts/` 目录，改用同一个入口：
   > `WhaleBridgeCore.exe --setup-dsh web`（支持 `--dry-run` / `--force-presets`）。
   > 它会把 MCP 的 `command` 直接指向 `WhaleBridgeCore.exe`（`args` 只有 `--mcp <模式>`），
   > 目标机器不需要安装 Node.js。

   > 从旧版本升级时，脚本会自动把指向 `src/mcp-*.js` 的旧 MCP 配置就地改成统一入口、
   > 清理 `qq-*` 时代的 preset/插件链接/settings 命名空间；失败时会回滚到执行前状态
   > （备份目录：`~/.dsh/.whalebridge-backup/<时间戳>`，回滚成功则不保留）。

5. **重启 DSH**：

   必须重启 DSH（或让 DSH 重新加载 profile），新 preset 和 MCP 工具才会生效。

   > 默认模式为 **`reserved2`（二代仿真）**，即“文本不自动转发、AI 通过工具自主收发”。如果你想改用 `chat` / `closed-agent` / `reserved`，可在 DSH 设置页的 `whale-mode` 卡片切换，或修改 `state/mode.json` 后重启桥接。

## 验证是否装好

1. **DSH WebUI 设置页**：应能看到 `whale-mode` 配置卡片，可切换 `chat` / `closed-agent` / `reserved` / `reserved2`。
2. **新建会话时**：agent preset 列表中应能看到：
   - `QQ 聊天角色`（`whale-chat`）
   - `QQ 聊天角色（二代仿真）`（`whale-chat-v2`）
3. **工具列表**：QQ 会话中应能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 等工具；不应看到 `dev_*` 等开发工具。

## 常见问题

- **看不到 `whale-mode` 设置卡片**：确认 `setup-dsh.mjs` 已把 `whale-mode-console` 加入 profile 的 `package.json` bundles，并重启 DSH。
- **MCP 工具没有出现**：确认 `cordis.patch.yml` 中三个 MCP 条目的路径指向当前仓库，并重启 DSH。
- **preset 没有出现**：确认 `~/.dsh/.agent-presets/whale-chat` 和 `~/.dsh/.agent-presets/whale-chat-v2` 存在，并重启 DSH。
- **启动 DSH 报 `failed to parse overlay cordis.patch.yml: YAMLException`**：多为历史版脚本残留的空数组 `[]` 引发。重新运行最新版脚本（会自动剥离）即可，或手动删除该文件里独立成行的 `[]` 后重启 DSH。
- **启动 DSH 报 `cannot resolve profile bundle "whale-mode-console"`**：profile 的 bundle 依赖尚未安装。运行 `dsh plugin --profile web install`（`web` 换成你的实际 profile 名）后重启 DSH；新版脚本会尝试自动执行这一步。
- **发送消息报 `unauthorized` / HTTP 401**：`config.json` 的 `snowluma.accessToken` 与 SnowLuma 的 OneBot 实例 token 不一致。将 SnowLuma WebUI 中 HTTP 与 WebSocket 两端的 accessToken 设为相同，再填入 `config.json`，然后重启桥。
- **发送消息报 HTTP 426（Upgrade Required）**：说明 `config.json` 里的 `snowluma.httpUrl` 指向了 **WebSocket 端口**。`httpUrl` 必须是 OneBot 的 **HTTP API 地址**（例如 `http://127.0.0.1:3000`），而 `wsUrl` 才是 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。请在 SnowLuma WebUI 的 OneBot 配置里分别确认 HTTP 和 WebSocket 的端口。也可以运行诊断脚本：
   ```bash
   node scripts/check-onebot-status.mjs
   ```
- **AI 看不到图片（回「一片黑 / 读不出来」或乱猜画面）**：会话模型不支持图像输入。桥接会把 `config.json` 的 `dsh.model` 绑定给每个 QQ 会话；文本模型（`deepseek-v4-flash` / `deepseek-v4-pro`）下 DSH 会把图片换成 `[image unavailable: … does not declare image input]`，图片根本没进入模型视觉上下文（视觉路由插件也救不了：它的工具只认本地路径/附件 id，不认 QQ 的图片 URL）。把 `dsh.model` 改成 `deepseek-flash`（DeepSeek-V41-Flash）或 `deepseek-v4-flash-vision-exp` 后重启桥接即可。桥接日志里出现「⚠️ 会话模型不支持图像输入」就是这个故障；两个自检脚本：
   ```bash
   node scripts/test-vision-media.mjs            # 校验配置模型能读图
   node scripts/probe-model-bind.mjs --image     # 端到端：带图问颜色，应回答「红」
   ```
