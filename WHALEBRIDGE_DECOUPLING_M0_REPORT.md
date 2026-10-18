# WhaleBridge 独立化：M0 库存与 M1 契约验收

审查日期：2026-10-18。审查起点 HEAD：`f6586c323b41bb55872fac1d96e2a783ceeb7592`，分支 `codex/whalebridge-decoupling-m0-m1`，独立工作树 `D:\GIT- CetaMesh\audit-critical-repair`。六阶段集成 `7559ba6`、AUD 修复 `a41e6c5`、失联 Task 单写者修复 `52f54af`、363 行方法台账 `575d4cf` 均为祖先。交付提交见 `git log -1`；本报告的起点 HEAD 不随交付提交改写。原主工作树未改动。**RELEASE_BLOCKED。**

## 证据方法与覆盖

按 `RULES.md`、`PROJECT_STATE.md`、`docs/desktop/ARCHITECTURE.md` 读取现行边界；桌面文档 03、02 和既有修复报告作为待核对输入。以本地源码、Git 祖先、统一测试的新鲜结果为事实。文档 03 的 `dc038da` 是旧审计基线，不作当前代码事实。M0 对指定范围的 103 个跟踪文件做了路径/静态和动态加载/环境变量/写入/进程启动扫描，其中 `src/bridge.js`、`core-dispatch.js`、Core 装配、IPC、Agent/QQ/DSH/Extension 入口、Rust 启动与打包脚本做了调用链阅读；其余文件仅标记“清单扫描”，不冒充逐方法语义审计。完整方法级接口复用 [AGENT_INTERFACE_METHOD_LEDGER.csv](AGENT_INTERFACE_METHOD_LEDGER.csv) 的 363 行；字段仍标有 `FIELD_REVIEW_REQUIRED` / `NATIVE_SCHEMA_UNVERIFIED`，不能据此宣称全部协议认证。

| 范围 | 跟踪文件数 | 本轮核验深度 |
| --- | ---: | --- |
| `src/core-dispatch.js`、`src/bridge.js`、`scripts/build-release.mjs` | 3 | 入口、初始化、写入、发布调用链阅读 |
| `src/app/` | 5 | 服务装配、Owner IPC、单写者与生命周期阅读 |
| `src/agent/` | 11 | Provider/Broker/原生进程与 Follow 入口扫描；关键实现和测试复核 |
| `src/channel/`、`src/integrations/` | 15 | QQ SDK/Channel、DSH/MCP 与插件状态边界扫描；入口阅读 |
| `src/extension/`、`dsh/agent-presets/` | 25 | 宿主、存储、预设路径扫描；关键模块阅读；预设内容/真实 DSH 配置未逐项验证 |
| `desktop-shell/` | 44 | 全路径扫描；`core_launch.rs`、`supervisor.rs`、`installer.rs` 关键启动/安装点阅读；其余 Rust 文件仅清单扫描 |

| M0 检查面 | 当前结论与入口 | 覆盖边界 |
| --- | --- | --- |
| 1. Core 启动依赖 | `core-dispatch --worker → runBridge → bootstrapCetaMesh`；旧 Bridge 仍是组合根 owner | 关键链 `CONFIRMED` |
| 2. 静态/动态 Import | `core-dispatch`、`bridge`、`service-container` 的静态闭包与指定目录的 `import()` / `require()` 全文扫描 | 静态边 `CONFIRMED`；全仓运行时动态加载 `SCAN_ONLY` |
| 3. 服务装配/进程所有权 | Bridge 本机服务/QQ、Rust Core worker、Core 领域与 Agent/MCP/Extension 子进程各有 owner | 入口 `CONFIRMED`；异常进程树真实场景未跑 |
| 4. IPC/兼容接口 | Owner UI pipe + data IPC + Bridge 旧 fallback；363 行方法台账复用 | 方法枚举已有；逐方法 native schema 多数 `UNVERIFIED` |
| 5. QQ/DSH/Bionic 入口 | QQ Runtime/transport、DSH Client/desktop/setup、Bridge socialV2/插件目录 | 调用链 `CONFIRMED`；真实网关和 preset 未跑 |
| 6. 配置/环境 | `app-paths` 优先级、`config.json`、Rust 注入的 `WHALEBRIDGE_*` 与 Codex home | 源码 `CONFIRMED`；多安装形态待 E2E |
| 7. 数据写入者 | Core Task/Memory/Workspace/Continuity/插件状态与 Bridge 社交/旧映射分列 | 见数据所有权表；无真实迁移 |
| 8. 用户数据/安装资产 | `%LOCALAPPDATA%\WhaleBridge` 或显式 DataDir；SEA `resources/` 与 DSH 模板 | 源码 `CONFIRMED`；真实安装包未读取 |
| 9. SEA/子进程 | `build-core` bundle/SEA 与 `build-release` 清单、Rust launch、Agent/MCP/Extension spawn | 构建脚本阅读；本轮未重新打包 |
| 10. 旧功能禁用影响 | 无 DSH/QQ 的 worker，坏社交/插件状态的服务装配、旧 HTTP 关闭 | `VERIFIED_FIXTURE`，正式安装版 `NOT_RUN_ENVIRONMENT` |

## M0：当前依赖方向与运行边界

确认的反向依赖：`src/core-dispatch.js:7-15,128` 静态引入旧 Bridge 及 QQ/SnowLuma/DSH/MCP 入口，`--worker` 调用 `runBridge()`；`src/bridge.js:585-605,1983-2005,9737-9778` 先创建旧锁、本地服务与 QQ 运行时，再由 Bridge 调用 `bootstrapCetaMesh`、建立 Owner IPC 和数据 IPC，随后后台启动 SnowLuma 并连接 QQ。旧 Bridge 当前仍**拥有 Core 的正式启动与进程生命周期**。静态 import 与后台启动尝试并不证明无网关时 Core 会启动失败；隔离 worker 测试已证明可降级上线。

可独立装配的服务：`src/app/service-container.js:49-100,200-337` 在 `api=null` 时注册 unavailable DSH Provider，仍构建 Chat、Model Runtime、Managed Agent、Task、Memory、Workspace、Capability、Continuity、Plugins、Device Mesh；`src/app/bootstrap.js` 管理 `.core-owner.lock` 和关闭顺序。`test-composition-boundary` 验证 service-container 的 import 闭包不直接包含 QQ Runtime/SnowLuma SDK；但装配层仍静态引用 DSH Desktop、Agent、MCP 搜索等可选实现，故不能宣称纯 Core 的构建依赖已独立。

运行与分发：`src/app-paths.js:55-119` 将只读资源与可写数据分开，`--data-dir` 优先于 `WHALEBRIDGE_DATA_DIR`、portable 标志和 `%LOCALAPPDATA%\WhaleBridge`。`desktop-shell/src/core_launch.rs` 与 `supervisor.rs:760-772` 仍启动 `WhaleBridgeCore.exe --worker`，注入数据目录、监督标记与 Owner UI pipe/token。`scripts/build-core.mjs` 从 `core-dispatch` 打 SEA，复制 `public/roles/assets/dsh/plugins` 资源；`scripts/build-release.mjs:150-175,429-489` 强制旧 exe 名、资源清单、`legacyHttp:false`。旧名和路径目前是兼容资产，不能全局改名或直接删。旧 HTTP Console 只在源码显式 legacy policy 下启动，发行清单要求禁用。

配置与进程：Bridge 的 `config.json` 必须可解析，`src/bridge.js:585-600` 在错误时退出；SnowLuma 和 DSH 由 `local-services.js` 检测/启动，QQ SDK 由 `src/channel/qq/runtime.js` 接入，MCP 有独立子进程入口，Extension Worker 有独立受限宿主。`src/agent/cli-agent-process.js` 管理原生 CLI 子进程；`src/integrations/dsh-desktop.js` 按需发现本机应用。M2 需要区分“Core 必需配置错误”和“可选 Connector 配置错误”，并明确谁创建/停止各进程。

数据与安装资产详见 [WHALEBRIDGE_DATA_OWNERSHIP.md](WHALEBRIDGE_DATA_OWNERSHIP.md)。旧功能禁用的实测范围仅限隔离夹具：关闭旧 HTTP、不连接真实网关、DSH 不注入、损坏社交/插件状态后 Core 的 Workspace/Task/Memory 可用。真实 QQ 会话、DSH preset、安装版升级和卸载不在本轮执行。

## M1：现有契约沿用与缺口

| 契约 | 当前实现/测试证据 | 判定 |
| --- | --- | --- |
| AUD-001 多消费者 | `src/agent/codex-agent-provider.js` 的 session 内 `seq/eventId` 与各 Follow `sinceSequence`；`test-new-audit-critical`、`test-agent-provider-expansion` 的双/三订阅、晚订阅、重放、取消、gap | `FIXED_CODE`、`VERIFIED_FIXTURE`；进程重启后 replay 仍缺持久 journal |
| AUD-002 unsupported Follow | `src/agent/agent-provider.js` 返回拒绝式 AsyncGenerator；`test-new-audit-critical` | `FIXED_CODE`、`VERIFIED_FIXTURE` |
| AUD-003 Chat 提交通知 | `src/desktop/chat-service.js` 正式消息写入后发 `chat.updated`，Harbor 按 requestId 保留临时正文；`test-desktop-chat-product`、`test-desktop-chat-virtualization` | `FIXED_CODE`、`VERIFIED_FIXTURE`；真实 WebView 10 秒观察未跑 |
| Core Event 与原生事件 | Chat UI 用 `uiEventBus`，Codex 用原生 Follow log，经 Broker/Chat 投影；未建立第二总线 | 分层已存在；统一身份、持久 Core Event 仍是协议缺口 |
| Chat/Task/Continuity cursor | Codex Follow 各自 cursor；Task/Chat 可同时消费，Continuity 监听 turn end；`AGENT_PROTOCOL_CONFORMANCE_REPORT.md` AC-010～017 | 原生 Codex 进程内可用；所有 Provider/跨 Core 重启尚未验证 |
| DSH 多订阅 | `src/agent/broker.js:160-163` 每次透传 Follow；`src/agent/dsh-agent-provider.js:217-219` 每次打开新的 `session/follow`，并未使用 `sinceSequence` | **协议缺口**：同一 DSH Session 的单上游读取者/独立 cursor 不能据现代码宣称满足；真实网关消费语义 `UNVERIFIED`，M3 前需反例/Schema/测试 |
| Session/Run/Task | Broker 绑定 Task/Workspace，Chat 有 requestId/turnId，Continuity 有 handoff 记录；三轮 fake CLI 回归 | 现有映射可用；统一 Run/Native Turn ID 尚无正式版本化 Schema |
| Capability 与 Owner | `src/app/ipc-runtime.js:63-96` 只在认证的 native Owner pipe 上分发，continuity actor 由服务端绑定，旧 fallback 赋予 console privilege；`test-ipc-runtime`、`test-bridge-privilege`、`test-capability-broker` | 已有权限夹具；旧 fallback 的方法白名单与未来拆分契约需收紧，**未发现未认证绕过的反例** |
| Agent none | `src/desktop/chat-service.js` 的显式 none 策略与 `test-desktop-chat-product`、`test-new-audit-critical` | `VERIFIED_FIXTURE`；真实 UI 选择链未跑 |
| 单写者 | `src/app/state-owner.js` 的 StateDir 锁、Task/Capability 的 Workspace 写者占用；`test-task-runtime`、`test-phase3-task-handoff` | `VERIFIED_FIXTURE`；跨进程真实故障/迁移双写仍是 M5 阻塞 |

本轮没有发现需要在 M1 重写 Broker、广播器或任务系统的已复现新故障。DSH Follow 的当前代码路径构成**单上游/独立 cursor 契约的反例**，但真实 DSH 网关是否因此丢事件/重复消费未验证；不以猜测改动 DSH Adapter，列入 M3 先行协议测试。现有 IPC fallback 只能在经 token 校验的 Owner UI pipe 上调用；接口清单仍需在 M2 设计中逐方法限定旧控制方法，不把“未知前缀回退”误写成已认证的长期公开协议。

## 隔离验证与新问题

新登记 `scripts/test-whalebridge-core-isolation.mjs` 使用唯一临时数据目录，故意损坏 `social-v2.json` 和 `integrations/plugins.json`，不注入 DSH API，并拦截网络。Core bootstrap 后 Workspace/Task/Memory 可读写；插件查询明确报 `INTEGRATION_STORE_CORRUPT`；原损坏文件字节不变，零网络请求。`scripts/test-core-entry.mjs` 的隔离 `--worker` 检查数据 IPC 可用、旧 HTTP 端口未监听，且无 DSH/QQ 网关时可启动。`test-standalone-model-path` 以本地 OpenAI 兼容夹具验证无 DSH 的普通 Chat；`test-process-extension-host`/`test-extension-runtime` 验证宿主失败边界；Agent none 与旧权限由上述专用 suite 覆盖。这些是 **VERIFIED_FIXTURE**，不是正式安装版或真实第三方 E2E。

| 本轮实际命令/场景 | 结果 | 证据边界 |
| --- | --- | --- |
| `npm test`（最终文件集；统一入口） | 退出码 0；109 suites：**101 PASS、0 FAIL、8 NOT_RUN_ENVIRONMENT** | 包含 AUD-001/002/003、Codex fake CLI 多订阅、Agent none、StateDir/Task 写者、Core worker、Harbor 虚拟列表和新增隔离 suite；测试器结果是夹具/本机条件，不是正式发布认证 |
| 新隔离 suite（亦单独以 `npm test -- --suite test-whalebridge-core-isolation` 运行） | PASS；无网络请求，损坏可选状态文件字节不变，Workspace/Task/Memory 可用 | 服务组合根级别；不证明真实插件进程崩溃与 Task/Memory 在同一安装版的 E2E |
| `test-core-entry` / `test-standalone-model-path` | PASS；隔离 worker 无旧 HTTP，DSH 不可达时数据 IPC 可用；本地模型路径 Chat 通过 | 源码 worker 与模拟模型；完全无 QQ/DSH 安装的正式包 `NOT_RUN_ENVIRONMENT` |
| 真实网关/发布条件 | 八项跳过：legacy bridge、MCP gateway、MCP network、OneBot gateway、real Codex、release-dist、Cargo check/test | `NOT_RUN_ENVIRONMENT`；真实 DSH preset/Harbor 10 秒可见性、QQ 单消费者切换亦未执行 |

首个受限执行中的 `npm test` 由于测试器无法 spawn，100 个 suite 均为环境性 `EPERM`，未进入断言；在获准启动子进程的环境重新运行后得到上表新鲜结果。本轮没有重新执行 `npm run build:core`、`npm run build:ui` 或 Rust 构建；`test-core-dist` 的 PASS 是既有构建产物上的测试，不作为本轮新打包成功证据。

新增架构问题 `M0-DEP-001`：正式 worker 由 Bridge 拥有 Core 的 bootstrap、UI/data IPC 与退出路径，且启动时总装配 QQ Runtime、尝试 SnowLuma；依赖方向不满足最终独立化目标。根因和最小改造方案见迁移计划 M2。`M0-DEP-002`：SEA 和桌面壳仍固定旧入口与资源/安装名；必须先提供兼容门面和可回滚发布方案。`M1-EVT-001`：DSH Follow 每次重新打开上游流，忽略 Broker 的 `sinceSequence`；真实网关事件交付风险未确认，M3 前先锁 Schema/反例。`M0-DATA-001`：Bridge 直接原子写旧 JSON（`bridge.js:151-175`），与现代 `src/storage/json-file.js` 并存；单进程目前未证明数据冲突，M5 前必须建立逐文件唯一写者/迁移仲裁。`M0-DATA-002`：`src/workspace/registry.js:61-79` 经 `config/loader.js` 读取 Workspace 清单，读取失败/损坏时返回空清单；写入最终使用 JSON primitive。这个既有回退语义可能让损坏文件显示为“没有 Workspace”，尚无用户数据损坏反例，迁移设计需先决定是否改为明确诊断/恢复。以上是结构或潜在数据可见性缺口，不等同已复现用户数据损坏。

正式安装版的“完全不安装 QQ/DSH/Bionic”、真实 WebView 可见性、真 Codex/DSH/OneBot、跨进程 crash/重启、用户历史数据 dry-run 均未执行：`NOT_RUN_ENVIRONMENT` 或后续待批准。四遍全仓审计与 269 功能/24 E2E 继续单独跟踪，不以本次局部扫描宣告完成。没有触及真实 StateDir、用户 preset 或迁移写入。
