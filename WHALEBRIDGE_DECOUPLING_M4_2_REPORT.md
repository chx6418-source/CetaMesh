# WhaleBridge M4.2：QQ Connector / Bionic 运行职责收尾

状态：**M4_PARTIAL / RELEASE_BLOCKED**。基线为 `codex/whalebridge-decoupling-m4` 的 `fffcebbd98e2fa5d9bbc44f9366758650e3e5847`，工作树开始时干净。本轮没有执行 M5、迁移真实用户数据、覆盖 QQ/DSH 配置、删除 Legacy Bridge，或启动真实 QQ 发消息。

## 实际调用链与运行职责

| 边界 | 本轮后的实际调用链 | 验收状态 |
| --- | --- | --- |
| 纯 Core | Desktop Shell → `--worker` → Core Bootstrap / Service Container / Owner IPC；QQ 不参与 Core readiness | 沿用 M2 已验证路径；本轮不重建 Core。 |
| Legacy QQ 接收 | 显式 `--legacy-exclusive` → 旧 Bridge → `createQqRuntime()` → Bridge `onPrivateMessage/onGroupMessage` → Bridge `handleIncoming()` | **PARTIAL**：回调与消费者仍由 Bridge 宿主持有。 |
| Legacy Bionic | Bridge `handleIncoming()` / `handleSessionEvent()` → Social 策略、主循环、`social-v2.json` 写入 → QQ Runtime 发送 | **PARTIAL**：没有把唯一社交写者移交给独立 Bionic Runtime。 |
| QQ 外发 | Bridge / Bionic / MCP → `qqTransport` 或 `postOneBotAction` → `createQqRuntime().executeSend()` → SDK 或 OneBot HTTP | Runtime 是现有产品链的最终发送执行点；Core Capability Broker 的 QQ 授权证明尚未贯通。 |
| 开发诊断 | `scripts/send-test-group.mjs` → `createQqRuntime()` → 账号/网关锁、最终策略、持久账本 → SDK | **FIXED_CODE**：不再独立 SDK 直发；发行资源仍排除该脚本。 |
| 正式 SEA QQ Connector | `src/core-dispatch.js` 只有 `--worker` 等现有模式；桌面 supervisor 没有 QQ Connector 子进程生命周期 | **PARTIAL**：没有真实的独立 start/stop/health 入口。不能把 Core SEA 验收冒充 QQ Connector 验收。 |

现有 `src/channel/service.js` 只提供 `channel.list/setstate/independence`，没有消息投递、发送授权和状态写者交接协议。直接添加一个会连接网关但不处理消息的 SEA 入口会丢弃 QQ 消息；让它转而调用 `runBridge()` 会创建第二套 Core/IPC/Task/Memory 权威宿主。因此本轮未添加伪 Connector 模式。该运行契约、受限身份和唯一 Social 写者的安全移交仍是关闭 M4 的前置条件。

## 本轮修改及根因

| 状态 | 根因与修改位置 | 测试与限制 |
| --- | --- | --- |
| `FIXED_CODE` | `src/bridge.js` 的自动社交/普通回复此前每次调用都让 Runtime 生成随机 ID；回放同一 DSH `turn/end` 可产生第二次发送。`src/channel/qq/auto-request.js` 按 Session、目标、原生终态序号和分条索引生成稳定 ID；`src/channel/qq/transport.js` 把 ID 传到 Runtime；Bridge 使用它发送自动回复。 | `test-qq-auto-request` 验证重放稳定、分条分离、同文不同回合独立、不同群隔离和无序号拒绝。原生流不提供可靠终态序号时自动回复拒绝发送。MCP 工具回合另有身份边界，未宣称全部自动工具调用已统一。 |
| `FIXED_CODE` | Bridge 的旧文本/分条队列把发送错误记日志后继续返回，可能将结果未知当作完成。Bridge 经 `requireKnownQqSendResult()` 检查 SDK/Runtime 结果，未知时抛 `QQ_OUTCOME_UNKNOWN`，后续分条停止。 | `test-qq-runtime` 验证 SDK 无回执为未知且同 ID 不再派发；`test-qq-auto-request` 验证未知不能当作完成。当前 SDK 无可靠回执时，社交状态不会被误更新为成功，实际 QQ 消息可能已经发出，须核验原请求。 |
| `FIXED_CODE` | `src/channel/qq/runtime.js` 原来只在连接时检查账号，SDK 连接静默换号后仍能发送。现在每次最终执行前重新读取账号；不匹配或无法核验即拒绝，health 降为 unavailable。 | `test-qq-runtime` 先复现静默换号仍发送，修后验证零新增外发和 health 降级。HTTP 发送仍保留其自身的 HTTP/WS 账号一致性检查。 |
| `FIXED_CODE` | `src/channel/qq/ownership.js` 在旧消费者被强制结束后留有锁，不能恢复。现只在持有者 PID 确认不存在时，以互斥恢复标记归档旧锁并创建新锁；PID 存活、权限不足、锁格式不明或恢复标记不明均拒绝接管。 | `test-qq-runtime` 先红后绿，覆盖活进程互斥、确认死亡后的恢复、恢复后第二写者拒绝和损坏锁 fail closed。PID 重用或恢复中再次崩溃可能留下阻塞标记，须人工核验，不能称自动恢复覆盖所有异常。 |
| `FIXED_CODE` | 手工诊断脚本此前用 SDK 直接 `sendGroupMessage()`，只靠手工白名单与锁。现在调用相同 QQ Runtime，要求显式启用、稳定 requestId，并执行当前账号/白名单/账本检查。 | `test-qq-runtime` 先红后绿，验证源调用不绕过 Runtime、默认禁用；`test-core-dist` 验证不进入 SEA 资源。诊断脚本仍不代表 Core Capability Broker 已给 QQ 发送授权。 |

## 外发授权覆盖与保留阻塞

`src/bridge.js` 文本、自动回复、贴纸、卡片按钮、拍一拍和自定义表情的外发，以及 `src/mcp-qq-file-send.js` 的文件/音频动作，仍汇聚到 M4.1 的 QQ Runtime 发送队列和账本。Runtime 在派发前复核连接与账号、目标白名单、媒体类型、QQ/Bionic/工具开关；卡片仍沿用 Legacy 逐次审批与原卡片复核。开发诊断脚本本轮也进入 Runtime。

**PARTIAL**：当前 `assertQqSendPolicy()` 接收 Legacy 提供的工具名、媒体授权和卡片审批证明；它不从 Core Capability Broker 取得可验证的 QQ 发送授权令牌或审批记录。现有 Core `channel.send` 还没有绑定 QQ Transport，`channel.service` 也没有跨进程投递契约。在这条边界完成前，不能声称所有外发路径已有统一 Capability/Approval 验收。旧 Bridge 的 Social 循环及数据写者也仍在，不能启用一个与 Legacy 并行消费的正式 Connector。

`outcome-unknown` 账本及只读回执核验沿用 M4.1。OneBot/SDK 无可查询发送结果时，不能伪造 exactly-once；同一 ID 不重发，不同原生回合不按文本去重。旧消息游标、回执和社交状态未清空或迁移。

## 验证边界与发行记录

| 项目 | 结果 | 边界 |
| --- | --- | --- |
| `npm test` | **105 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT**（113 suites） | 新 `test-qq-auto-request` 已登记在 `scripts/run-all-tests.mjs`；真实 QQ、网关和部分外部环境仍跳过。 |
| `npm run build:core` / `npm run build:ui` | PASS / PASS | Core SEA 资源与 Harbor 构建；不等于独立 Connector。 |
| `npm run desktop:check` / `desktop:test` / `desktop:build` | PASS / 198 PASS / PASS | Rust Shell 检查、单测、release profile。 |
| `npm run build:release -- --use-current-build-number` / RC verification | PASS / **8 PASS, 0 FAIL** | 从干净源码提交构建并核对 `sourceCommit`；安装器及现有 Core SEA/IPC 测试通过，独立 QQ Connector 生命周期未测试，因为入口尚不存在。 |
| `VERIFIED_REAL_E2E` | 0 | 真实受控 QQ/OneBot 账号未运行。 |

代码与构建源码提交：`637799f65b1122279b8c8f52abb4340d9017fe14`，发行清单 `sourceCommit` 与之完全一致，`dirtySourceTree: false`。修改文件：`src/bridge.js`、`src/channel/qq/{auto-request,ownership,runtime,send-result,transport}.js`、`scripts/send-test-group.mjs`、`scripts/test-qq-auto-request.mjs`、`scripts/test-qq-runtime.mjs`、`scripts/test-qq-send-policy.mjs`、`scripts/run-all-tests.mjs`、`release/version.json` 和 M4.1/M4.2 两份报告。新增测试只通过 `npm test` 聚合器运行。

版本 `1.0.0-rc.2`，Build **1079**。安装包 [CetaMesh-Setup-1.0.0-rc.2-build1079-x64.exe](artifacts/rc/1.0.0-rc.2/build-1079/CetaMesh-Setup-1.0.0-rc.2-build1079-x64.exe)：**42,999,808 字节**，SHA-256 `B2DDE9AD919E61B9AA1EB116D1C9E4E97AADF4F560704BFA4BCA353D6B7AE71E`，`Get-AuthenticodeSignature` 为 **NotSigned**。SEA Core SHA-256 `3BBDAABF69AC9EEA470E52366F0395B54F15A3A70BEF80132EEEED3041F7ECDD`；该 Core 产物不包含独立 QQ Connector 模式。最终分支 HEAD 包含本段报告补录提交，以交付时 `git rev-parse HEAD` 为准。

**M4_PARTIAL / RELEASE_BLOCKED** 保持。`VERIFIED_FIXTURE` 只适用于上述自动回复、权限、账本和锁测试；`VERIFIED_RELEASE_INTEGRATION` 只适用于现有 Core/安装器路径；QQ Connector 的正式 SEA start/stop/health 为 `PARTIAL`，真实 QQ/OneBot 消息及副作用为 `NOT_RUN_ENVIRONMENT`，`VERIFIED_REAL_E2E` 为零。等待 Owner 对运行职责和授权契约验收，不开始 M5 数据迁移；未 push、合并 main 或发布 Stable。
