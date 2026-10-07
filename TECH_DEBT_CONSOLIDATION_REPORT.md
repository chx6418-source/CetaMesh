# CetaMesh Desktop 技术债收口报告

**生成日期：** 2026-10-08
**Session 3 分支：** `refactor/core-composition-v1`

## Git 基线与最终版本

- **Base HEAD：** `aaff6bf490c95f77e64aed3ebef61f8dbdeb6fba`（本地 `main`，已含 Session 1 与 Session 2）。
- **Final HEAD（RC 源码）：** `dba403d60c92cedf4f8b1cf54bc84f94df31393e`。
- **RC Build ID：** `1.0.0-rc.1+dba403d`，`dirtySourceTree=false`。
- **远端基线检查：** fetch 得到 `origin/main`=`142ebb61024648f948cf6e001cb94b6f77e473f6`，它是本地 `main` 的祖先；本报告提交后按 Owner 已授予的指令快进合并并推送。
- 本报告是 RC 源码提交之后的文档记录；不改变已验收的二进制内容。

## 会话状态

| 会话 | 状态 | 结果 |
|---|---|---|
| Session 1 | **PASS** | D1 Release HTTP、D2 统一测试入口/CI、D10 仓库卫生、D13 静默失败红线已在基线中收口。 |
| Session 2 | **PASS** | D3 Storage Primitive、D7 文档瘦身、D12 State Retention 已在基线中完成。 |
| Session 3 | **PASS** | D4/D5/DSH lifecycle/D6/D9/D11/D14 与最终 RC 均通过；D8 按要求不做。 |

## D1–D14

| 项目 | 状态 | 记录 |
|---|---|---|
| D1 Release HTTP 完整移除 | **PASS** | Release manifest 与 runtime manifest 均为 `legacyHttp=false`、`uiDistribution=native-no-web`；RC worker 启动时 `consolePort` 无 HTTP listener；本机对 `127.0.0.1:3100` 的 TCP 探测不可达。 |
| D2 测试总入口 / CI | **PASS** | `npm test` 运行 73 个 suite；新测试已登记。危险的旧控制台集成测试须显式设置 `WHALEBRIDGE_TEST_LEGACY_BRIDGE=1` 且探测隔离端口。 |
| D3 Storage Primitive | **PASS** | Session 2 交接已完成；存储原语与迁移套件在本轮聚合回归中通过。 |
| D4 Composition Root | **PASS** | `createCetaMeshServices()` 不要求 QQ SDK、OneBot、SnowLuma ready、Social runtime 或 DSH API/ready；构造依赖闭包测试通过。 |
| D5 IPC | **PASS** | UI IPC 构造改为对象参数；dispatch 移到 `src/app/ipc-runtime.js`，保留既有方法族、路由目标、参数、控制面权限和 wire protocol。 |
| D6 废弃插件草稿 | **PASS** | 当前树没有 `plugins/cetamesh-*`、`src/desktop-plugin-host.js`、`src/desktop-plugin-storage.js`、`src/mcp-desktop-utilities.js`；未移动或删除不存在的文件。正式运行时为 `src/extension/`，包与样例在 `extensions/`；保留 `plugins/whale-mode-console`。 |
| D7 文档瘦身 | **PASS** | Session 2 已归档历史上下文并压缩活动状态文档。 |
| D8 品牌内部兼容名 | **NOT_APPLICABLE** | 按 Owner 要求不做。 |
| D9 Rust panic audit | **PASS** | 审计 installer、migrate、install CLI 和用户路径相关代码；匹配到的 `.unwrap()` / `.expect()` 均位于 `#[cfg(test)]` 测试代码，生产用户输入、文件系统、安装/卸载与迁移路径未发现对应 panic 点，因此没有机械删除测试或不相关 invariant。 |
| D10 仓库卫生 | **PASS** | Session 1 已收口生成物忽略规则；本轮未清理或重写用户 refs，未影响历史插件。 |
| D11 Git workflow | **PASS** | 新增 `docs/development/GIT_WORKFLOW.md`，规定 branch → commit → tests → merge → verify → delete branch；`reset` / `reflog` 不作为正常交接手段。 |
| D12 State Retention | **PASS** | Session 2 保留策略与测试在本轮回归中通过。 |
| D13 静默失败红线 | **PASS** | Session 1 静默失败约束保留；`test-error-hygiene` 在本轮通过。 |
| D14 陈旧注释 | **PASS** | 只更新本轮涉及的架构注释；没有做全仓注释美容。 |

## 架构与功能结果

- **Core Service Container：PASS。** 现代服务由 `src/app/service-container.js` 构造；`src/app/bootstrap.js` 组合生命周期；`src/bridge.js` 保留 worker compatibility entry 与 Legacy QQ/Social 策略。
- **Core 无 QQ 构造：PASS。** 新边界测试沿真实 import specifier 检查容器传递依赖，并以无 DSH API 的配置构造服务。
- **IPC：PASS。** 路由保留 `chat.*`、`task.*`、`memory.*`、`continuity.*`、`capability.*`、`workshop.*`、`modelrt.*`、`router.*`、`ext.*`、`mesh.*`、`channel.*`、`agent.*`、`workspace.*`、`providers.*`、`settings.*`、`about.*`、`update.*`。`executeOwner`、`executeMemory`、`executeWorkspace` 及 console fallback 均有测试。
- **DSH lifecycle：PASS。** `unknown/ready/unavailable/recovering/stopped`、`start/stop/refresh/status/subscribe`、单 timer、clear、`unref`、恢复探测均有测试；DSH integration 和 standalone model suite 通过。
- **QQ 边界：PASS。** SnowLuma 客户端连接与基础私聊/群聊发送移动至薄 adapter；Social v2、Slang、Sticker、Cards、Kugou 保留在 bridge 中。
- **运行时 allowlist：PASS。** 审阅发现 config.allow 整体替换后回调会读取旧对象；新增测试先在旧实现失败，修复后通过，后续只读复审通过。
- **Capability 文档：PASS。** Broker 定义为 generic Capability Plane 的权威裁决点；QQ MCP adapter-specific boundary 与 Mesh trust/pairing control plane 被登记为 direct exceptions；新增 generic capability 仍须经 Broker。

## 验证

- `npm test`（最终源码及 Release 产物）：**67 PASS · 0 FAIL · 6 NOT_RUN_ENVIRONMENT**。
- `npm run desktop:check`：PASS（7 个现有未使用字段/方法 warning）。
- `npm run desktop:test`：PASS，**109/109**。
- `npm run build:core`：PASS，资源/凭据/构建机路径/no-web 发行审计通过。
- `npm run desktop:build`：PASS。
- `npm run build:release`：PASS，禁止项/构建机路径/凭据审计通过。
- `npm run test-release-candidate`：PASS。中文与空格安装路径、无系统 Node、只读安装目录、Core IPC、崩溃恢复、单实例、孤儿守卫、卸载并保留用户数据均通过。
- 专项回归：architecture、capability coverage/broker、security negatives、agent test-run security、no-web release、DSH integration/lifecycle、Extension、Workshop、Continuity rollover 均通过。
- `127.0.0.1:3100` 最终只读 TCP 探测结果：**unreachable**。Release manifest 的 `legacyHttp=false`；RC 启动验证确认无 HTTP server。

### NOT_RUN_ENVIRONMENT

六项如实跳过，不计为通过或失败：

1. `test-console`：未显式 opt-in 真实隔离的 legacy bridge。
2. `test-desktop-install`、`test-desktop-shell`：当前 suite 无 `shell-debug` 环境。
3. `test-mcp-exec`、`test-onebot-connection`：未连接真实 gateway。
4. `test-mcp-web-search`：未启用公网网络测试。

发行 manifest 还记录：未签名/未验证签名、未在 Windows 10 x64 验证、未使用真实 QQ/DSH 会话和完整 MCP 环境验证；这些不影响本机 Windows RC 安装、运行、恢复与卸载测试结论。

## RC 身份与 SHA256

- **Build ID：** `1.0.0-rc.1+dba403d`
- **RC 源码 commit：** `dba403d60c92cedf4f8b1cf54bc84f94df31393e`
- **安装器 `WhaleBridge-Setup-x64.exe`：** `78bfab6a2ebaf4c93cf4feab6641543d74ece98418402b1115e7ac2d59bedebd`
- **桌面壳 `WhaleBridge.exe`：** `ade27a8b78859a5694e987832a52d9b5a0d61e1b0b7a375337b27dc3d0be0eca`
- **Core `WhaleBridgeCore.exe`：** `d2a2a5bd449a8a93365a1df26123d594778c95157bd293e913ff2d3f202bc6ab`

SHA256 与 `dist/app/release-manifest.json`、`dist/app/SHA256SUMS.txt` 一致。
