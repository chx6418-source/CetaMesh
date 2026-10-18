# WhaleBridge M4.1：QQ 外发所有权收敛（进行中）

状态：**M4_PARTIAL / M3_PARTIAL / M2_PARTIAL / RELEASE_BLOCKED**。本轮基线为本地 `codex/whalebridge-decoupling-m4` 的 `b14f3bc64004721c3d7fa550776c590abc335958`。本报告记录已经实施的最小边界修复及尚未完成的 M4.1 切换；不能据此宣布 QQ Connector / Bionic Chat 已独立运行。

## 现有调用链与反例

| 路径 | 基线行为 | 本轮结果 |
| --- | --- | --- |
| 普通文本 | Legacy `sendChain` → `createQqTransport()` → SnowLuma SDK | 仍保留业务顺序队列；底层写调用交给 `createQqRuntime()` 的发送队列。 |
| 引用、贴纸 | Legacy `sendChain` → Bridge 内部 OneBot HTTP `fetch()` | HTTP 写动作由 QQ Runtime 执行；Legacy 保留业务校验、分条和节奏。 |
| 拍一拍、卡片按钮、自定义表情写动作 | Legacy `bot.raw()` / `bot.request()`，部分没有进入文本队列 | 写动作经 Legacy 顺序队列进入 QQ Runtime 的动作允许集；既有逐次审批和会话校验未放宽。 |
| 文件与音频 MCP | 独立 stdio 子进程直接 `fetch(OneBot HTTP)`，可绕过运行中 QQ 宿主的账号锁 | 子进程改经既有 `data.call` 请求 `/api/send/file-action`；当前 QQ 宿主复核工具开关、白名单、文件路径和大小后送到 QQ Runtime。纯 Core 不提供此路由，返回拒绝。 |
| QQ 接收和 Social | `createQqRuntime()` → Bridge `handleIncoming()`；Bridge 持有 Social 主循环与 `social-v2.json` 写入 | **尚未切换**。仍是 `legacy-exclusive` 兼容宿主，不是独立 Connector / Bionic Worker。 |

此外，新增的 Legacy 文件动作回归测试揭示现有 `executeDataCall()` 的 POST 请求体可能在处理器监听之前发出，造成 15 秒超时。虚拟请求改为可缓冲 `Readable`，包括处理器先 `await` 再读取请求体的情况；保留 `close` 仅表示 IPC 取消的语义。

## 验证边界

- `FIXED_CODE`：`src/channel/qq/runtime.js` 成为当前 Legacy QQ 连接内的实际 SDK/HTTP 写动作执行者，提供单队列、就绪检查和动作允许集；`src/mcp-qq-file-send.js` 不再直接调用 OneBot HTTP；`src/bridge.js` 通过现有数据 IPC 接收文件动作并复核授权；`src/control/data-ipc.js` 缓冲 POST 请求体。
- `VERIFIED_FIXTURE`：`test-qq-runtime` 在修改前复现 MCP 无宿主仍可直发、Runtime 不串行、未允许动作可执行；修改后通过。覆盖本地 HTTP fixture 的 OneBot 路径/鉴权头/响应、无宿主不外发、不同写动作串行、未知写动作拒绝。`test-core-entry` 覆盖真实隔离 Legacy 进程的文件动作白名单拒绝；`test-ipc-protocol` 覆盖异步处理器读 POST 体；`test-card` 保持卡片审批路径的源码契约。
- `VERIFIED_FIXTURE`：重连时切换 QQ 账号和 HTTP/WS 账号不一致先复现失败，再由 Runtime 拒绝；socket open 尚未核验身份时不可发送。Runtime 队列有 256 个待处理操作上限，超限返回 `QQ_SEND_QUEUE_FULL`。
- `NOT_RUN_ENVIRONMENT`：真实 QQ 账号、SnowLuma/OneBot、真实贴纸/卡片/文件副作用和正式 SEA 独立 QQ Connector E2E 未验证；不能把本地 HTTP fixture 记为真实 QQ E2E。
- `PARTIAL`：Bridge 仍拥有 QQ 回调、Social 主循环与 Social 状态写者，仍以 `legacy-exclusive` 构建 Core/IPC；正式 SEA 仍没有独立 QQ Connector 运行入口；`mcp-snowluma-safe` 的 OneBot 只读 HTTP 查询仍直接访问网关。手工 `scripts/send-test-group.mjs` 也是独立直发诊断脚本，不能作为单发送者产品路径运行。

## 切换前必须完成

1. 设计并验证受限的 Connector ↔ Core/Channel 事件与能力契约；不能把服务令牌升级为 Owner token，也不能同时启动第二套 IPC Server 或 Task/Memory 写者。
2. 将 Legacy 的 QQ 回调转为独立 Connector 的单消费者投递；切换前确认旧进程、网关锁和账号锁释放。真实跨进程、跨网关账号互斥和崩溃恢复尚需验收。
3. 将 Social 主循环与 `social-v2.json` 唯一写者转为 Bionic 运行边界，逐群核对旧状态，保留可回滚的旧兼容模式；不得双 Social 写入。
4. 为正式 SEA 增加明确 QQ Connector 入口及受控生命周期，复测 Core 单独、Connector 单独、Core+Connector、Legacy 冲突、Connector 异常退出。旧 Bridge 自动启动 SnowLuma 的路径仍仅属 Legacy 模式。
5. 对 HTTP 网关与 WebSocket 所属 QQ 账号进行一致性验证，并对发送超时后的未知副作用、重试去重和 ACK 建立明确契约；当前队列只保证单进程内提交顺序，不等于跨进程严格一次外发。

## 全仓外发入口台账与权限边界

| 入口 | 底层动作 | 本轮落点 | 当前校验 | 未完成的契约 |
| --- | --- | --- | --- | --- |
| Bridge `sendToQQ` / `sendBurstToQQ` | SnowLuma SDK private/group send | `qqTransport` → `qqRuntime.sendPrivateMessage/sendGroupMessage` | Bridge 模式、Connector 就绪；业务调用前的 allowlist | Runtime 本身没有逐次白名单/Capability 检查；无 requestId 和可靠回执；发送失败被 Bridge 的日志 catch 吞掉。 |
| Bridge `onebotSend` / 贴纸 | OneBot `send_private_msg` / `send_group_msg` | `qqRuntime.sendOneBot` | Bridge token、模式、目标、内容或贴纸 URL；Runtime 动作/连接/账号 | HTTP 账号检查与实际发送间仍有网关切换窗口；未知结果未持久化。 |
| Bridge 拍一拍、卡片按钮、自定义表情 | SDK raw/request 写动作 | `qqRuntime.rawWrite/requestWrite` | 卡片逐次审批、会话检查；Runtime 动作允许集 | 逐动作 Capability 与回执账本未统一。 |
| MCP `mcp-qq-file-send` 文件/音频 | OneBot 上传文件 / record 发送 | 现有 data IPC → Bridge `/api/send/file-action` → Runtime | 服务 token、插件/工具开关、白名单、文件 realpath/大小/目录、动作类型 | 无稳定 requestId，超时后调用方不可安全自动重试；Bridge 将多类异常映射为 HTTP 403。 |
| MCP `mcp-snowluma-safe` 发送工具 | Bridge `/api/send/*` | Bridge → Runtime | 模式、token、工具开关、目标、社交节流 | 没有跨进程发送幂等与 outcome-unknown 账本。 |
| `scripts/send-test-group.mjs` | SDK 直发 | **绕过产品 Runtime** | 手工脚本参数 | 诊断入口仍可直接发，不能在单写者验收时运行；需改为受控 Connector IPC 或移出发行路径。 |

`mcp-snowluma-safe` 直接访问 OneBot HTTP 的现存路径经源码搜索均是只读查询（登录、状态、群/成员/历史）；`src/bridge.js` 的 `bot.raw('get_forward_msg')` 和 `bot.request('fetch_custom_face_detail')` 也是只读。未知第三方插件自行使用 OneBot 凭据不受当前进程内队列约束。当前 Runtime 只做动作允许集和连接/账号核验，**未满足“所有外发权限均在 Runtime 内核验”的验收条件**。

## 打开的产品缺陷与迁移条件

| 状态 | 问题与可核验反例 | M5 前置条件 |
| --- | --- | --- |
| `PARTIAL` | Legacy 仍持有 QQ 回调、Social 主循环和社交状态写入；`runBridge()` 仍是兼容宿主。 | 先建立 Connector → Channel Contract 单消费者投递，再移交 Bionic 唯一社交写者；切换前证明旧消费者退出。 |
| `PARTIAL` | 正式 SEA `core-dispatch` 尚无独立 QQ Connector 模式；不能在安装版中独立发现、启停或报告健康状态。 | 定义正式子进程入口与 supervisor 生命周期，保留 Core `.core-owner.lock`，做实际安装版隔离验收。 |
| `PARTIAL` | 未关闭产品缺陷：没有持久 requestId、发送意图、回执和 `outcome-unknown` 状态。OneBot 超时或断线可能已有副作用，重试可能重复发送；单队列与内容去重均无法解决。 | 先确定 OneBot 查询能力与回执身份，建立账号级有界账本；未知结果仅可人工/受控查询核验，不能盲目重放。 |
| `PARTIAL` | 未关闭产品缺陷：Runtime 未统一执行 allowlist、Capability、审批、媒体类型权限。Bridge 当前多个调用点各自校验，直接 SDK 写动作与文件路径使用不同策略。 | 定义发送请求的业务身份、能力和审批证明，统一验证后方可写；保留按媒体类型的独立权限。 |
| `PARTIAL` | QQ 接收回执文件仍为单路径，切换账号后的隔离和旧账号历史核对未完成；账号身份突变现已拒绝继续发送。 | 按账号隔离游标、回执和社交状态，验证旧状态只读迁移/回滚，不清空原文件。 |
| `NOT_RUN_ENVIRONMENT` | 没有真实受控 QQ/OneBot 账号，文件、音乐、卡片、贴纸的真实副作用和 E2E 均未执行。 | 使用隔离账号和白名单，禁止对真实用户群自动发送。 |

因此本轮不能宣告 M4.1 代码验收完成。`DEFERRED_TO_M5`：旧 QQ/Social 数据的备份、逐账号/逐群核对、Dry Run、唯一写者切换与回滚须等待以上运行契约及 Owner 审批；本轮没有改动真实用户数据。

旧 `bridge.js`、QQ/Bionic 功能、用户数据和 DSH preset 均保留。本轮未启动真实 QQ，不迁移用户 StateDir，不 push、不合并 main、不发布 Stable。

## 本轮测试、构建与提交记录

| 项目 | 实际结果 | 证据边界 |
| --- | --- | --- |
| `npm test` | 110 suites：102 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT | 最终源码和 Build 1077 的本地聚合测试；环境跳过未计为通过。 |
| `npm run desktop:check` | PASS | Rust 编译检查；有原有 dead code 警告。 |
| `npm run desktop:test` | PASS：198 passed / 0 failed | Rust 单元/集成测试。 |
| `npm run build:core` | PASS | Windows SEA Core、资源与禁止项审计；独立 QQ Connector 未包含。 |
| `npm run build:ui` | PASS | 首次在受限执行环境 `spawn EPERM`，允许 esbuild 子进程后重跑通过。 |
| `npm run desktop:build` | PASS | Windows 桌面壳 release profile。 |
| `npm run build:release -- --use-current-build-number` | PASS | 从干净的代码提交 `6edd502a2367fc02a634a761108c72706a0245d7` 打包 Build 1077；发行审计通过。 |
| `npm test -- --category release` | 8 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT | 正式 RC 安装器、SEA Core/IPC、发行清单与打包保护；**未**验证独立 QQ Connector。 |

修改文件：`src/channel/qq/runtime.js`、`src/bridge.js`、`src/mcp-qq-file-send.js`、`src/control/data-ipc.js`、`scripts/test-qq-runtime.mjs`、`scripts/test-core-entry.mjs`、`scripts/test-ipc-protocol.mjs`、`scripts/test-card.mjs`、`release/version.json` 及本报告。版本 `1.0.0-rc.2`，Build `1077`。代码提交与构建源码 Commit 为 `6edd502a2367fc02a634a761108c72706a0245d7`；本报告发行结果补录将另有文档提交，因此最终分支 HEAD 以该提交后的 `git rev-parse HEAD` 为准。构建前工作树干净，清单 `dirtySourceTree: false`，`sourceCommit` 与代码提交一致。

`VERIFIED_RELEASE_INTEGRATION`：本地 RC 路径通过，安装包 [CetaMesh-Setup-1.0.0-rc.2-build1077-x64.exe](artifacts/rc/1.0.0-rc.2/build-1077/CetaMesh-Setup-1.0.0-rc.2-build1077-x64.exe) 为 **42,999,808 字节**，SHA-256 `3637655767CCB2A669147E825A588FD7960B9C9D7B2CF4BE843D922DFD063AED`，`Get-AuthenticodeSignature` 为 `NotSigned`。Core SEA SHA-256 `3C0FB2F774A011E3440969EC428C19FB8414D040C578D39464ABE00BB2BC337D`。发行包没有独立 QQ Connector 入口，故该状态只覆盖 Core/IPC/安装器；QQ 发送、接收、社交循环和账号切换仍为 `NOT_RUN_ENVIRONMENT` / `PARTIAL`，`VERIFIED_REAL_E2E` 为零。

## M4.1 后续收口（基线 `db2832f09f492aa538dd850125f4914d55db8ace`）

本节记录本轮增量；上文 Build 1077、`6edd502` 和测试统计只属于上一轮基线，不得当作本轮的新验证。当前仍为 **M4_PARTIAL / RELEASE_BLOCKED**。

### 根因与实际修改

| 状态 | 根因与反例 | 本轮改动 | 证据及限制 |
| --- | --- | --- | --- |
| `FIXED_CODE` | Runtime 虽串行发送，但同一 requestId 重放会再次调用网关；进程重启后没有发送意图和未知结果。 | `src/channel/qq/send-ledger.js` 使用 Storage Primitive 原子写入账号、requestId、类型、目标、时间、状态和回执；Runtime 在副作用前写 `outcome-unknown`，可靠 `message_id` / `file_id` 回包或网关 OK 回包才更新状态。重复 ID 且参数相同只读返回，参数不同拒绝。 | `test-qq-send-ledger`、`test-qq-runtime` 先红后绿；未知结果不自动重放。OneBot 不提供通用发送结果查询时，不能据此声称 exactly-once 或收件人已收到。 |
| `FIXED_CODE` | Runtime 原动作允许集没有每种媒体的最终权限核验。 | `src/channel/qq/send-policy.js` 统一核验账号、连接总开关、白名单、媒体工具、Bionic 状态和卡片审批/低风险证明；Legacy 调用该策略，并给贴纸、拍一拍、账号表情、卡片及文件动作附上各自授权上下文。 | `test-qq-send-policy` 覆盖文本、文件、音频、音乐、贴纸、卡片、拍一拍、账号表情拒绝；仍依赖 Legacy 上游产生的审批证明，尚未把 Core Capability Broker 的批准记录编码进发送契约。 |
| `FIXED_CODE` | 文件/音频 MCP 对未知结果可能按 HTTP 2xx 当成功；未暴露稳定 requestId。 | MCP Schema 增加可选 requestId，数据 IPC 传给 Runtime；`send-result.js` 识别重复回执和 `QQ_OUTCOME_UNKNOWN`，Legacy 增加认证的 `/api/send/receipt` 只读核验入口。 | 可选 requestId 由调用方负责复用；未提供时 Runtime 生成唯一 ID，但跨调用重试无法自动关联。TTS/增益会生成新临时文件，同 ID 重试可能因参数指纹变化而安全拒绝，需核验原请求。 |
| `FIXED_CODE` | `scripts/send-test-group.mjs` 可独立用 SDK 发送，不经产品 Runtime。 | 诊断脚本要求显式开发环境口令和消息参数、目标必须在显式白名单中；先取同一网关和 QQ 账号租约，旧消费者在场时拒绝。 | `test-qq-runtime` 验证默认门禁与跨进程互斥，`test-core-dist` 检查脚本不进入 SEA 资源。该脚本仍是开发专用直发路径，不能由产品或插件调用。 |
| `FIXED_CODE` | Runtime 在发送尚未返回时释放账号锁，新进程可以接管并成为第二发送者。 | `stop()` 先关闭接收、等待发送队列排空，再释放账号与网关租约；65 秒仍未排空则返回 `QQ_SEND_DRAIN_TIMEOUT` 并保留租约。 | `test-qq-runtime` 先红后绿，覆盖在途发送期间第二 Runtime 被 `QQ_ACCOUNT_BUSY` 拒绝。超时后的人工核验和跨进程恢复仍待 Connector 生命周期设计。 |

### 尚未解除的运行耦合

- `PARTIAL`：实际调用链仍为显式 `src/bridge.js --legacy-exclusive` → 同一 `.core-owner.lock` → Legacy Core/IPC → `createQqRuntime()` → Bridge `handleIncoming()` → Bridge Social 主循环及 `social-v2.json` 写入。Bridge 未降为纯兼容门面，Core 与 QQ/Bionic 的运行职责尚未分离。
- `PARTIAL`：正式 SEA `src/core-dispatch.js` 与桌面 supervisor 仍没有独立 QQ Connector 的 start/stop/health 模式。不得将 Core `--worker` 的安装版验证记成 Connector 验收；也不得启动一个只消费并丢弃 QQ 消息的假 Connector 以获得命令行入口。
- `PARTIAL`：账号锁可阻止两个活进程双消费者。异常退出后遗留锁时当前策略会拒绝接管，避免双活；自动核验旧 PID、Gateway 状态和安全恢复尚未实现。`test-qq-runtime` 用两个真实 Node 进程验证了争用与崩溃后的 fail-closed，不能据此宣称自动恢复通过。
- `PARTIAL`：自动社交回复若调用方未传稳定 requestId，会获得本次新 ID；账本保证同一 ID 不重放，但无法识别另一轮新 ID 是否重试了同一历史动作。发送结果未知时，Bridge 若仅记日志并继续业务流程，仍需迁移为显式待核验状态。
- `PARTIAL`：当前 `assertQqSendPolicy()` 在最终执行点校验 QQ 开关、当前账号、白名单、Bionic 开关、工具开关与媒体类型；Core Capability Broker 的授权证明和审批记录尚未贯通所有 Legacy 调用方。诊断脚本仍是隔离开发工具，不代表产品统一发送执行器。SDK 文本调用缺少稳定网关回执时账本保守地记为未知，不可将调用返回解释为用户已收到。
- `NOT_RUN_ENVIRONMENT`：真实 QQ/OneBot 的文本、文件、音频、卡片、贴纸、音乐 E2E、真实账号切换与真实旧消费者切换未执行；Fixture 和 SEA Core 集成均不能替代。
- `DEFERRED_TO_M5`：本轮没有迁移、覆盖或清空旧 QQ 游标、回执、Social 状态及用户配置。数据迁移必须待 Connector 唯一写者、账号锁恢复、分群状态校验与回滚方案完成后再获 Owner 批准。

### 本轮验证与交付记录

`VERIFIED_FIXTURE`：`npm test` 当前聚合器共 112 suites，**104 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT**；新 `test-qq-send-ledger`、`test-qq-send-policy` 纳入该聚合器。`test-qq-runtime` 覆盖相同 requestId、不同 requestId、未知结果、重启读账本、跨进程账号锁、在途发送停止、媒体伪装拒绝和诊断脚本默认门禁。`test-core-entry` 检查 Legacy 真实隔离进程的账本只读入口，`test-core-dist` 检查诊断脚本不在 SEA 资源中。Node 真实 QQ 测试仍因环境缺失跳过。首次并行执行 Core SEA 构建时 `dist/core/WhaleBridgeCore.exe` 遭 `EBUSY`；聚合测试退出后重跑通过，未改测试断言或基线。

`VERIFIED_FIXTURE`：`npm run desktop:check` 通过；`npm run desktop:test` **198 PASS / 0 FAIL**；`npm run build:ui` 与 `npm run desktop:build` 通过。`npm run build:core` 重跑通过，SEA 资源审计通过。正式 RC 构建与安装器核验在干净代码提交后记录，不得用上述编译结果冒充独立 QQ Connector 的 Release Integration。

`VERIFIED_RELEASE_INTEGRATION`：`npm run build:release -- --use-current-build-number` 从干净代码提交 `eddd401d7df10f663eb71bfb90ed0b229fa3d585` 组装 Build **1078**，清单 `sourceCommit` 与提交完全一致，`dirtySourceTree: false`。`npm test -- --category release` **8 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**，覆盖发行包安装、SEA Core 启动和 IPC 等既有 RC 套件；正式 SEA 仍无独立 QQ Connector 的 start/stop/health 入口，故此项不能标记 QQ Connector Release Integration 通过。

安装包 [CetaMesh-Setup-1.0.0-rc.2-build1078-x64.exe](artifacts/rc/1.0.0-rc.2/build-1078/CetaMesh-Setup-1.0.0-rc.2-build1078-x64.exe)：**42,999,808 字节**，SHA-256 `255F65ED4466E158A71FD8734BC3BA70CCC1BF0BF5437C73AEFD5807F9026D4E`，`Get-AuthenticodeSignature` 为 `NotSigned`。SEA Core SHA-256 `3BBDAABF69AC9EEA470E52366F0395B54F15A3A70BEF80132EEEED3041F7ECDD`。版本 `1.0.0-rc.2`，Build **1078**。真实 QQ/OneBot 流量未执行，`VERIFIED_REAL_E2E` 为零；未把本地安装器通过视为真实社交验收。

代码提交：`eddd401d7df10f663eb71bfb90ed0b229fa3d585`。本段为构建后补录，只改报告；最终分支 HEAD 包含后续文档提交，以 `git rev-parse HEAD` 为准。工作树在构建前干净；报告补录提交后复核工作树。没有 push、合并 main、正式标签或 Stable 发布。
