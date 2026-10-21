# CetaMesh Desktop 阶段 5：External Connectivity + MCP / Plugins / QQ

日期：2026-10-17

工作分支：`codex/phase5-connectivity`
基线：阶段 4 最终提交 `d68c6efcfef9e3faed83f1f7b0b71251ff2d5f5c`。阶段 1 `599b7e1`、阶段 2 `23fd72f`、阶段 3 `261be6d` 均经 `git merge-base --is-ancestor` 确认为其祖先；基线工作树无未提交改动。没有合并 main、push 或发布 Stable。

## 状态口径

- `FIXED_CODE`：已在产品代码修复，并由新增的失败回归与修复后回归验证。
- `VERIFIED_FIXTURE`：实际 Core、stdio/IPC、Worker 或本机安装沙箱运行通过；不代表连接真实 QQ、DSH 或线上目录。
- `NOT_RUN_ENVIRONMENT`：外部依赖不具备，或安全边界拒绝，未伪报通过。
- `PARTIAL`：本地代码或夹具已验证，但问题要求的真实外部链、发布者签名或人工安装版验收尚未完成。

| ID | 处理状态 | 根因、准确修改点位与验证 | 修复 Commit |
| --- | --- | --- | --- |
| MCP-01 | FIXED_CODE · VERIFIED_FIXTURE | `src/integrations/registry.js:114-185` 过去将声明工具与运行可调用混用；`service.js:174-188` 禁用顺序和 `mcp-runtime.js:244-306` 启停竞态可留下过期连接。现分别公开 enabled/running/callable/实际发现数，禁用先持久化，启动代次使迟到连接失效。先在 `test-mcp-registry.mjs` 复现空发现、禁用竞态、停止中的启动，再验证；Harbor 投影回归在 `test-service-container.mjs`。 | `774e324`、`6bf810b` |
| MCP-02 | PARTIAL · VERIFIED_FIXTURE | 原风险是 SEA 的 executable/entry/cwd、资源和 stdio 协议未被安装路径证明。`test-mcp-registry.mjs` 现用真实子进程对五个内置入口逐个完成 initialize、tools/list、低风险或拒绝式 tools/call 与热切换；`test-core-dist.mjs` 在无系统 Node 的复制安装目录验证同一协议。`src/integrations/mcp-runtime.js:45-181` 与 `scripts/build-core.mjs:113` 的发行路径经过构建审计。真实 SnowLuma/DSH 工具调用仍缺外部环境。 | `774e324`、`ec20749` |
| MCP-03 | FIXED_CODE · VERIFIED_FIXTURE | 桌面 Registry 开关与独立 DSH stdio、Legacy Bridge 社交配置原为不同事实源。`src/integrations/tool-policy.js:10-36` 每次执行热读同一持久化开关；五个 `src/mcp-*.js` 回调、`src/channel/qq/tool-policy.js:1-51`、`src/bridge.js:1592,2180` 接入，并继续叠加原社交白名单与审批，不用托管 Runtime 的进程状态代替外部 DSH 权限。`test-qq-runtime.mjs` 验证真实 stdio 与 Core named-pipe 禁用后拒绝；`test-mcp-registry.mjs` 验证五入口热切换。真实 QQ 发送未运行。 | `774e324`、`775befc` |
| MCP-04 | FIXED_CODE · VERIFIED_FIXTURE | `src/integrations/registry.js:114-185` 过去把静态 Schema 当可发现工具；`service.js:454-463` 的工具详情又只返回原始 Runtime 条目，丢失 enabled/callable。`tools.list` 现在使用实际发现的 inputSchema，未知或未发现条目不可调用；详情合并实时策略。生产装配 `test-service-container.mjs` 真正启动 web-search-safe、发现 Schema 并调用一个本地拒绝请求；`test-mcp-registry.mjs` 覆盖空/错发现。 | `774e324`、`6bf810b` |
| QQ-01 | FIXED_CODE · VERIFIED_FIXTURE | `src/bridge.js:1592,2180` 原仅按社交配置判断，MCP 子进程不读取插件中心开关。现在 39 个 SnowLuma MCP 回调、Bridge 数据路由与 prompt 工具展示按持久策略及原安全配置共同判断；卡片最终执行时重查。 `test-qq-runtime.mjs` 的隔离 stdio 与 Core IPC 验证关闭单工具/父工具包后返回 403 或 `TOOL_DISABLED`；`test-integration-tool-registry.mjs` 保持 53 项登记：46 restored、5 partial、2 unsupported。真实仿生群聊仍未验收。 | `774e324`、`775befc` |
| QQ-02 | NOT_RUN_ENVIRONMENT | 群/私聊连续收发、OneBot 去重、官方卡片与真实 SnowLuma 链要求授权账号和网关；本机 `test-onebot-connection` 因 gateway 缺失而跳过。已有 `test-qq-runtime`、`test-card`、`test-bridge-privilege` 的隔离白名单、卡片和开关回归通过，但不能替代真实账号 E2E。本次没有向真实用户群或私聊发测试消息。 | `775befc`（策略回归；真实 E2E 未完成） |
| EXT-01 | FIXED_CODE · VERIFIED_FIXTURE | 旧 Review 没有把 ProcessHost/VM 与 OS 沙箱区分。`src/extension/review.js:96` 现以 `executionBoundary.osSandbox=false` 和人工审查说明明确风险；Broker、危险权限默认拒绝仍保留。`test-extension-runtime.mjs`、`test-process-extension-host.mjs`、`test-process-extension-sea.mjs` 验证进程可靠性；**没有**宣称 AppContainer/Windows Sandbox。 | `775befc` |
| PLUGIN-01 | PARTIAL · VERIFIED_FIXTURE | `src/plugin-center/catalog.js:108-109` 曾把目录自身的 `verified:true` 当成发布者验证。`service.js:368,434-435` 现在明确只有 SHA256 完整性、`verifiedPublisher=false`、`publisherSignature=not-implemented`；旧缓存也不能恢复伪验证。Harbor 审查徽章不再以“无需 Review”涂成已签名。篡改/缓存夹具在 `test-plugin-center.mjs` 通过。正式可信发布者签名链未实现，不能判签名验证通过。 | `775befc`、`6bf810b` |
| PLUGIN-02 | PARTIAL · VERIFIED_FIXTURE | `src/plugin-center/service.js:434-492,674` 原本地压缩包取消 Review 留下 staging，已启用扩展更新后回报 `enabled:false`。`test-plugin-center.mjs` 先复现后以真实 loopback Catalog、Extension Store/Runtime/Worker 验证下载哈希、安装、授权、调用、更新、回滚、禁用、卸载与清理。`release-config.json` 未配置正式在线 Plugin Service，线上 HTTPS Catalog/签名及安装版服务连接未运行。 | `775befc` |
| INSTALL-02 | FIXED_CODE · VERIFIED_FIXTURE | `src/agent/cli-agent-process.js:120-149,202-225` 原在 SEA 中可能把 `WhaleBridgeCore.exe` 当作 npm `.cmd` 的 Node；Windows `where` 还可能先选无扩展名 shell shim。现优先原生 exe/com，独立 Node 才可执行 npm JS shim，缺 Node 明确 `NODE_RUNTIME_UNAVAILABLE`；JSONL 流增量 UTF-8 解码。`test-agent-provider-expansion.mjs` 先 RED 后 GREEN，覆盖空格路径、SEA 假 Core、无 Node、中文分块。真实 Codex Task 受 Windows 沙箱拒绝，见下文。 | `ec20749` |
| INSTALL-03 | FIXED_CODE · VERIFIED_FIXTURE | `src/agent/codex-agent-provider.js:167-196,619-634` 原用 CLI 兼容性代替已安装状态，且未认证时假可用。`src/agent/service.js:40-115` 现区分 installed/compatible/authenticated/available/taskEligible，并刷新版本、原因和 CODEX_HOME 认证目录；不兼容显示“不支持”而非“未安装”。`test-agent-provider-expansion.mjs` 覆盖上述回归；本机真实 Codex 版本和登录状态已识别。 | `ec20749`、`6bf810b` |
| UI-02 | FIXED_CODE · VERIFIED_FIXTURE | `src/desktop/ui-service.js:189-228,273-294,1054-1055` 原将 Agent 健康失败推为“未安装”、MCP Running 推为 Callable、插件目录 SHA 推为可信。`desktop-ui/src/app/HarborApp.tsx:1111,1377,1404,1455-1457` 现显示工具真实发现/可调用数、Agent 安装与认证分层、未签名审查提示。`test-service-container.mjs` 经生产装配复现并修复；`build:ui` 与 `test-desktop-shell` 通过。原生人工视觉点击验收仍未执行。 | `6bf810b` |

## MCP 与生产装配实测

- `createCetaMeshServices()` 装配下，web-search-safe 真实 stdio 子进程：`mcp.start` → UI `mcp.list` 得到 running/callable/实际发现数 → `mcp.tools` 标记 `web_fetch` 为 discovered/callable → 经 Broker `tools.invoke` 提交 `file:///phase5-denied`，子进程安全拒绝 `isError=true` → `mcp.stop`。没有真实联网。
- 源入口与 Node SEA 发行入口：snowluma、snowluma-host、web-search-safe、qq-file-send、bilibili 五个模式均完成 `initialize`、`tools/list`、安全 `tools/call`；宿主低风险 `snowluma_status` 返回 `reachable:false`，其余按本地未授权/非法协议拒绝。默认高风险工具没有被开启。
- 已在同一存活子进程里测试单工具禁用即返回 `TOOL_DISABLED`，进程崩溃、重启、停止中的启动与迟到关闭不会造成假 Running。`test-core-dist` 验证复制安装目录、PATH 中无系统 Node。

## 外部 Agent、QQ 和插件环境

- Codex：本机 `codex-cli 0.163.0-alpha.10.2`，`codex login status` 显示 ChatGPT 已登录。真实 `ui.task.create` 在一次性 TypeScript Workspace 运行时，Windows strict split-filesystem sandbox 拒绝；Task 正确进入 `blocked / CODEX_SANDBOX_UNAVAILABLE`，样例文件保持原文。该真实 Task 是 `NOT_RUN_ENVIRONMENT`，没有关闭沙箱，也没有称其执行成功。
- DSH：Desktop `0.2.0-rc.2` 已安装但未运行；CLI `0.1.5-rc.1` 可探测；无凭据的 loopback API 连接 `ECONNREFUSED`。真实鉴权、创建 Session、Follow、取消和 Task 接续 `NOT_RUN_ENVIRONMENT`。没有读取 Desktop Cookie 或使用未经支持的私有 IPC。
- QQ / OneBot / SnowLuma：授权网关未就绪；真实群聊、私聊、官方卡片点击、连续去重 `NOT_RUN_ENVIRONMENT`。本地白名单/审批、卡片安全与 53 项目录状态由夹具验证；“restored”只是登记状态，不等于真实可调用。
- Plugin：本机 loopback Catalog + 真实 Extension Worker 生命周期通过。正式线上 Catalog 地址与 Publisher Signature 未配置/未实现；`verified` 不再宣称作者身份，ProcessHost 也不宣称 OS 沙箱。

## 自动化与发行门槛

| 检查 | 当前证据 |
| --- | --- |
| `npm test` | 第二轮 104 suites：**96 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT**。其中缺真实 legacy bridge、gateway、network、真实 Codex opt-in、RC artifact，以及未启用的两个 Cargo 聚合套件；Cargo 已单独运行。首轮旧错误文本断言导致 1 FAIL，已修并重新跑全量。 |
| `npm run build:ui` | PASS；TypeScript 与 Vite 1792 模块。 |
| `npm run build:core` | PASS；Node 24 SEA `WhaleBridgeCore.exe` 93.6 MB，bundle 39 第三方包、17 资源，产物审计通过。`node:sea` 是 Node 内置模块，打包审计白名单已补。 |
| `npm run desktop:check` | PASS；Rust 非阻断 dead-code 警告。 |
| `npm run desktop:test` | **197 PASS / 0 FAIL**。 |
| `npm run desktop:build`、`desktop:build:debug` | PASS，分别生成 release/debug 原生壳。 |
| Windows 安装版内部检查 | `test-desktop-install`、`test-installer-productization`、`test-desktop-shell`、`test-core-dist`、`test-process-extension-sea` 均 PASS；前四者使用隔离安装/临时数据目录，未触碰用户实际安装。真实 UI 人工点击未运行。 |
| 正式 `build:release` / RC verification | 必须在本报告提交后从干净最终 HEAD 运行；发行物 `sourceCommit` 应等于该 HEAD。最终结果记录于 canonical `artifacts/rc/1.0.0-rc.2/build-1068/` 的 manifest 和本阶段交付回复。不得在提交前把结果填为 PASS。 |

本阶段将 Build Number 从 1067 增至 **1068**，未更改 `1.0.0-rc.2` 产品版本或 channel。正式 RC 构建使用 `npm run build:release -- --use-current-build-number`，避免构建脚本再修改版本文件，从而保持干净 HEAD 与发行 `sourceCommit` 一致。

## 剩余阻塞与阶段结论

内部代码与夹具回归为 0 FAIL；真实 QQ、DSH、Codex Windows 沙箱 Task、正式在线 Plugin Catalog 与 Publisher Signature、人工安装版视觉操作仍不能标记通过。特别是 `PLUGIN-01/02` 和 `QQ-02` 保持 PARTIAL / NOT_RUN_ENVIRONMENT，阶段 5 的**完整真实外部验收尚未达成**。不在本阶段扩展 QQ-03 能力或降低任何安全边界。
