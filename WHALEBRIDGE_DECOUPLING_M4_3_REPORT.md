# WhaleBridge M4.3：QQ Connector 运行职责与 Core Channel Service 验收

**结论：M4_PARTIAL / RELEASE_BLOCKED。** 本轮基线为 `codex/whalebridge-decoupling-m4` 的 `6d0dd45243d6758438b598d07fc3f589a4f95e39`，起始工作树干净。入站回执的一处确定缺陷已修复并提交；Core Channel Service 的权威接收、独立 QQ Connector 和正式 SEA 生命周期仍未实现，不能把现有 Legacy 宿主或发行 Core 验收标为 M4 完成。

## 实际调用链及所有权

| 状态 | 调用链与事实 |
| --- | --- |
| `VERIFIED_RELEASE_INTEGRATION` | Desktop Shell → `--worker` → `bootstrapCetaMesh()` → `createCetaMeshServices()` → Owner IPC；`src/channel/service.js` 当前仅实现 `channel.list/setstate/independence`。无 QQ 时 Core 可启动，沿用 M2/本轮 `test-core-dist` 和 RC 证据。 |
| `PARTIAL` | 显式 `--legacy-exclusive` → `src/bridge.js` → `createQqRuntime()` → Bridge `onPrivateMessage/onGroupMessage` → `handleIncoming()` → Social 策略及 `social-v2.json` 写入。QQ Runtime 拥有传输和账号锁，Bridge 仍拥有消息处理和 Bionic 主循环。 |
| `PARTIAL` | 目标的 Connector 身份验证/规范化 → Core Channel Service → 权限/来源校验 → 持久事件 → Bionic/Agent/Task 独立游标链尚不存在。不能将 Owner IPC Token 给外部 Connector；现有 `channel.` 路由是 Owner IPC，未实现受限 Connector 身份。 |
| `PARTIAL` | `src/core-dispatch.js` 无 `--qq-connector` 模式；`desktop-shell/src/supervisor.rs` 无 Connector 子进程的 start/stop/health/reconnect 管理。正式 SEA 可启动纯 Core，不能独立启动 QQ Connector。 |

本轮没有创建第二个 Core、IPC Server、Task/Memory Store 或事件总线。现有 `src/desktop/ui-service.js` 事件总线是 UI 通知面；它不是已验证的持久 Channel Event Journal。不能把新的内存队列冒充可重放的 Core Channel Service。

## 本轮确定缺陷和修复

| 状态 | 根因、改动与证据 |
| --- | --- |
| `FIXED_CODE` | `src/channel/qq/receipts.js` 原 `claim()` 在调用 Bridge 处理器前就把消息写入已确认 `ids`。处理器失败时同一消息仍被标为成功，可能永久丢失。现在先经 Storage Primitive 原子写入 `pending`；处理器成功后才移入 `ids`。旧 `version:1, ids` 文件仍可读取，不清空真实回执。待核验集合有界，满时拒绝新消息。 |
| `FIXED_CODE` | `src/channel/qq/runtime.js` 等待异步回调完成后确认；失败或进程退出保留 `pending`，重复投递及重启不盲目重放可能已产生副作用的消息。`unresolvedInbound()` 提供本进程只读核验入口。带持久回执的消息还校验入站 `self_id` 与已验证账号一致。 |
| `FIXED_CODE` | `src/bridge.js` 的两类 QQ 消息回调原先吞掉 `handleIncoming()` 异常，令 Runtime 误判成功；现将失败传回 Runtime，由 Runtime 记录错误并保留待核验记录。Bridge 仍为唯一 Legacy 消费者，没有启动新消费者。 |
| `VERIFIED_FIXTURE` | `scripts/test-qq-runtime.mjs` 先复现失败后仍被错误确认（1 次尝试而无待核验状态），修后验证成功确认、失败待核验、重复消息不执行、重启后可查 `pending` 且不重复副作用；已在原有 `npm test` 聚合器内。此机制保证不盲目重放，**不保证自动恢复或 exactly-once**。 |

若 Bridge 处理器在多个副作用之间失败，`pending` 无法判断哪些步骤已经完成；必须人工核验后才能设计重放/补偿。现有 `unresolvedInbound()` 尚未暴露为 Owner UI 方法，不能宣称正式安装版已有用户可操作核验入口。这是阻塞项。

## QQ 外发入口覆盖检查

本轮按 `send_group_msg/send_private_msg/upload_*`、SDK send、卡片点击、拍一拍和表情收藏写动作搜索 `src/`、`scripts/`、`desktop-shell/`。产品可达的写动作如下；`src/mcp-snowluma-safe.js` 的 `onebot()` 使用点为读取，工具声明不等于直接写动作。

| 入口 | 最终执行链 | 状态 |
| --- | --- | --- |
| Bridge 文本、自动回复与 Bionic 分条 | `qqTransport`/`postOneBotAction` → `qqRuntime.executeSend()` | Runtime 账本、账号、白名单和现有 Legacy 策略覆盖；Core Capability Broker 端到端授权 **PARTIAL**。 |
| Bridge 卡片、拍一拍、贴纸及自定义表情 | `postOneBotAction`/`rawWrite`/`requestWrite` → `qqRuntime.executeSend()` | Runtime 最终执行覆盖；卡片仍由 Legacy 审批，不能宣称 Core Approval 统一覆盖。 |
| `src/mcp-qq-file-send.js` 文件、音频、音乐 | 数据面请求 → Bridge 受限动作 → `qqRuntime.sendOneBot()` | Runtime 最终执行覆盖；Core Capability Broker 授权 **PARTIAL**。 |
| `scripts/send-test-group.mjs` 诊断 | 显式启用 → `createQqRuntime().sendGroupMessage()` | 开发诊断经 Runtime；发行资源排除该脚本，沿用 M4.2 `test-core-dist`。 |
| Plugin/Extension | 当前没有核验到直接 OneBot 写函数调用；业务入口仍依赖 Legacy/MCP 路由 | 新的动态插件或外部调用不能据此宣称已获统一授权。 |

已定位的上述源码写路径最终汇聚 Runtime，但**Core `channel.send` 仍只做 Capability 校验且未绑定真实 QQ Transport**（`src/capability/adapters.js`）；Legacy 传给 `assertQqSendPolicy()` 的工具/媒体/审批证明没有 Core 签发的可验证授权身份。故“所有外发均经 Core Capability/Approval”覆盖率为 **未达成**，不能给出虚假的 100%。发送账本、稳定 requestId、`outcome-unknown`、账号锁沿用 M4.1/M4.2，未重复修改。OneBot 无可靠结果查询时，不自动重发未知结果。

## 生命周期、隔离与测试

| 验证 | 本轮结果 | 范围 |
| --- | --- | --- |
| `npm test` | **105 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT**（113 suites） | Node Fixture、现有 Core/Legacy/账本/权限/锁回归；真实 OneBot/QQ 未运行。 |
| `npm run build:core`、`npm run build:ui` | PASS / PASS | 现有 Core 与 Harbor 构建。Core SEA 哈希与 M4.2 相同，说明本轮 Legacy 入站修复不构成独立 Connector SEA 实现。 |
| `npm run desktop:check`、`npm run desktop:test`、`npm run desktop:build` | PASS / **198 PASS, 0 FAIL** / PASS | Rust Shell 现有功能。 |
| `npm run build:release -- --use-current-build-number` | PASS | 干净源码提交 `2221caa77a4c14af92c88a786cb4a6063342fa07`，清单 `sourceCommit` 完全一致，`dirtySourceTree=false`。 |
| `npm test -- --category release` | **8 PASS / 0 FAIL** | 安装包和现有 Core SEA/IPC 发行集成；独立 Connector start/stop/health 未验证，因为入口不存在。 |
| 跨进程 QQ/Legacy 互斥 | `VERIFIED_FIXTURE`，沿用 `test-qq-runtime` 的账号/网关锁、死 PID 恢复和拒绝活进程接管 | 未验证真实 QQ 网关。不能证明不存在 Legacy Social 双活的新 Connector，因为新模式尚未启用。 |
| QQ/OneBot 真实收发 | `NOT_RUN_ENVIRONMENT` | 没有受控真实账号和网关；`VERIFIED_REAL_E2E` 为 0。 |

## 发布记录及后续边界

- 代码提交：`2221caa77a4c14af92c88a786cb4a6063342fa07`；文件：`src/channel/qq/receipts.js`、`src/channel/qq/runtime.js`、`src/bridge.js`、`scripts/test-qq-runtime.mjs`、`release/version.json`。
- Version `1.0.0-rc.2`，Build **1080**；安装包 `artifacts/rc/1.0.0-rc.2/build-1080/CetaMesh-Setup-1.0.0-rc.2-build1080-x64.exe`，42,999,808 字节，SHA-256 `23AC0050D26D26376537A045D2B47636813FC911ED2B504F547344AD7CD2DF17`，Authenticode **NotSigned**。
- 发行清单 `sourceCommit=2221caa77a4c14af92c88a786cb4a6063342fa07`，`dirtySourceTree=false`。最终 HEAD 还将包含本报告提交，以交付时 `git rev-parse HEAD` 为准；报告提交不改变已构建源码。
- `PARTIAL`：Legacy QQ 回调、Social 主循环和 `social-v2.json` 唯一写者仍在 Bridge；Core Channel Service 没有受限 Connector ingress、独立消费者 cursor/ack/replay、来源鉴权或授权分发；正式 SEA 无独立 Connector 生命周期；Core Broker/Approval 未贯通所有 QQ 外发；待核验入站尚无 Owner UI 核验/补偿流程。
- M5 前置：先定义受限 Connector 身份与进程管理、Core Channel ingress 持久事件契约、消费者游标与异常恢复、Core 签发的发送授权和审批证明；再设计 Legacy Social 状态唯一写者移交、备份/回滚和不可确认副作用核验。**本轮未执行 M5 或改动真实用户数据**。

保持 **M4_PARTIAL / RELEASE_BLOCKED**，未 push、合并 main、创建正式 Release Tag 或发布 Stable。等待 Owner 验收与下一阶段指令。
