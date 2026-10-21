# CetaMesh Agent 接入契约复核（评审稿）

日期：2026-10-18。基线：`1aa5a8582ea8d7c76b5a3f7a4f7fabd00389707e`，分支 `codex/cm-agent-protocol-review`。本文依据当前源码及桌面文档 02；后者是待验证的设计输入，不是已生效标准。发布状态保持 **RELEASE_BLOCKED**。

## 已实现的边界

- Harbor 的 `ui.*` 方法由 `desktop-ui/src/bridge/typed-client.ts` 发到 Rust `desktop-shell/src/webview_ui.rs`，再经有 token 的 Owner named pipe 到 `src/app/ipc-runtime.js`，分发到 `src/desktop/ui-service.js` 和各 Core 服务。桥接请求上限 900 KiB，IPC 帧上限 1 MiB；前端请求等待 32 秒。`ui.events.next` 是有界内存事件列表和游标，Core 重启生成新的 instanceId。该列表没有持久 journal，游标落到保留窗口之前也没有显式 gap 错误。
- `src/agent/agent-provider.js` 定义 `createSession/send/cancel/status/contextUsage/resume/closeSession/selectModel/health/follow` 及三个可选方法；未实现的 Follow 是会抛 `AGENT_UNSUPPORTED` 的 AsyncIterable。`src/agent/broker.js` 统一分发会话调用、检查 Task Workspace 绑定、包装可选能力。它没有正式的跨 Provider Run 状态机或持久事件存储。
- Codex 当前接入是 `codex exec --json`。`src/agent/codex-agent-provider.js` 维护每 Session 的单一事件生产者、递增数字 seq、有界 2000 条内存日志；多个 Follow 各自从 `sinceSequence` 读，越界抛 `AGENT_EVENT_GAP`。`a41e6c5` 的修复保留。进程重启后的重放与相同 seq 不同 payload 的冲突证明尚无。
- DSH 当前使用 `src/dsh-client.js` 的 HTTP RPC 和 WebSocket `/api/remote.mux`，Agent Adapter 在 `src/agent/dsh-agent-provider.js`。其当前安装 CLI `dsh --version` 返回 `0.1.5-rc.1`，但未从本机生成/固定完整 Session Schema。coding/social purpose 与 preset 对应仍无环境认证。
- MCP 是工具连接器：`src/integrations/mcp-runtime.js` 通过 SDK `Client.connect`、`listTools`、`callTool`；Core 的权限和批准在 integration/capability 层，工具列表不授予 Workspace 写权限。QQ/OneBot 在 `src/channel/qq` 和 legacy `src/bridge.js`；Extension 在 `src/extension/service.js` 与受限 Runtime。它们不等同完整 Agent Session。
- Task/Workspace/审批权威留在 Core。`52f54af` 将带 Agent 的失联 blocked/waiting Task 继续视作写者占用；核验前第二写入者被拒。没有跨所有外部执行器的可靠 stop 确认。

## 拟议的兼容内部契约

此节只冻结供 Owner 评审的**语义**，不宣布 `cm-agent/1.0` 实施或要求外部供应商提供这些 RPC。现有 `agent.*` 继续作为兼容门面。

| 边界 | 应承担的职责 | 授权边界 |
| --- | --- | --- |
| ModelProvider | 推理、结构化 tool call、usage 与流式终态 | 不持有 Task/Workspace 执行权；正文中的 DSML 不产生工具授权 |
| AgentAdapter | 原生版本探测、Session/Turn 映射、唯一上游读取者、原生取消与终态解释 | 能力声明只是事实声明；不能批准工具或写权威 Task |
| MCP/Tool Connector | 工具发现、入参 Schema、执行结果、协议协商 | 每次有副作用调用仍经 Core Broker 的 grant 和审批 |
| Channel Connector | 外部身份、消息去重、收发与 OneBot 映射 | QQ 成员不自动成为 Owner；Channel 消息不自动派发 Task |
| Core | Task、Workspace、审批、requestId/runId、执行租约、持久消息和恢复裁决 | 核验当前授权和 assignmentEpoch 后才执行/导入 |

身份分离：`requestId` 对应提交的幂等请求，`runId` 对应一次执行尝试，`coreSessionId` 对应 Core 会话，`nativeSessionId/nativeTurnId/nativeRequestId` 只来自可核实的原生响应，`taskId/workspaceId` 由 Core 持有，`assignmentEpoch` 围栏由 Core 单调推进。原生 ID 未知用 null，不以同一字符串替代多个含义。现有代码并未完整持有这套字段，故属于**建议变更**。

状态语义：`accepted` 只表明受理；只有可证明的原生成功终态及 Core 投影完成才能标 `completed`。`cancel requested` 不表示 `stopped`；超时/EOF/重启后如果副作用无法核实，应进入 `outcome-unknown` 和人工核验，不能自动重试写入。Task 验收与 Agent Run 终态独立。

事件目标：`native stream → 一个 Adapter reader → Core 关联/校验/持久关键事件 → Chat、Task、Continuity 各自游标`。事件需稳定 `streamId + seq + eventId`、可验证顺序、terminal、重复事件幂等、冲突和缺口显式错误。正式 `message.committed` 要携带 messageId/requestId/historyRevision，先写入再通知 UI；临时 Streaming 行在正式消息出现前保持可见。当前 Codex 单进程有界日志和 Chat 提交通知只是这一目标的局部实现。

## 兼容迁移设计（需 Owner 审批）

1. 为现有 `agent.*` 与 `ui.*` 建立唯一请求/响应/错误 Schema 源和版本号；先加校验与生成类型，不改变旧调用语义。方法级缺口见 CSV 的 `UNVERIFIED` 列。
2. 在 Core 建可恢复事件 journal、保留水位和快照，明确持久关键事件、临时 delta、配额、gap/冲突和崩溃回放语义。先双写比较但只保留**一个**原生 reader；不能让旧消费者与新消费者各自触发执行。
3. 为各 Adapter 建独立 profile 锁（实际二进制/SDK 版本、schema hash、已通过方法、auth/sandbox/readyFor）；Codex app-server 与 exec JSONL 分开，DSH preset/schema 按本机版本验证，ACP 只对明确支持的对端启用。
4. 在可回滚的 opt-in 环境完成真实 Windows Harbor、真实 Codex/DSH、断线/取消/重启/审批/单写者验收，再讨论切换默认路径。协议重大改变、数据存储迁移及新的执行权限均需 Owner 设计审批。

## 方法盘点的证据界限

`AGENT_INTERFACE_METHOD_LEDGER.csv` 从当前 21 个 Core/UI handler 表、9 个 Rust Host 分支和 29 个原生调用点生成 **363 个逐方法记录**；生成器 `scripts/generate-agent-interface-ledger.mjs` 可重跑。每行列出调用/处理源码、传输、当前可见输入字段、权限入口及未验证字段。`INLINE` 表示源码投影，**不是正式 JSON Schema**；`UNVERIFIED` 不视为兼容或授权。此轮没有把 UI 后面可能未逐字段提取的间接参数、外部响应 Schema、所有错误码、持久版本冒充审完。下一次四遍审计需逐行补充 Pass2～4；不能把 `SOURCE_ENUMERATED` 当成全仓四遍审计通过。
