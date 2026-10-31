# CP-060 — IPC、传输绑定、事件与背压协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT + NEW DTO。统一语义不意味着统一所有 wire framing。**

## 1. 当前至少四种真实传输

| 路径 | 当前格式/事实源 | 不得自动更改的点 |
| --- | --- | --- |
| Native UI ↔ Core | `src/control/ipc-protocol.js`：四字节 LE 长度前缀 + UTF-8 JSON；`version:1`；默认 1 MiB 帧/30s 超时 | 既有字段 `version/id/method/params` 与回应 `ok/result/error` |
| 外部编码 Agent | `src/agent/protocol/json-rpc-transport.js`：显式 `acp-v1-jsonl` 或 `codex-app-server-jsonl`，JSONL；默认帧 1 MiB | ACP 与 Codex JSONL 在协议头/方法集上不同 |
| Extension Worker | `src/extension/process-host.js`：`{v:1,id,kind:invoke|result|error|cancel|ping|pong|shutdown}` JSONL | 包身份绑定、请求 ID、超时、取消、背压、关闭时序 |
| Desktop/Mobile Mesh | `docs/protocol/UNIFIED_PAIRING_V1_1.md`（签名信封）和 legacy `src/mesh/protocol.js`（另一字段形状） | 已签名 canonical bytes、版本、nonce、TLS pin、重放保护 |

应用层可以拥有共享的状态语义/错误类别/DTO 模型，但不得将这些传输的序列化帧直接替换成 CP-001 的领域消息。

## 2. 领域事件契约（新投影）

事件投影建议字段：`protocolId/protocolVersion/kind=event/messageId/correlationId/timestamp/method/payload`。领域标识由生产者明确分配，如 `task.updated`, `capability.operation.started`, `plugin.status.changed`, `memory.candidate.proposed`, `agent.turn.completed`, `simulation.room.message`。

- 事件有 `sequence` 的流必须单调递增，消费者保存 Cursor；过期返回显式 `CURSOR_EVICTED` 并执行受信快照再连接。
- 业务操作重复回放必须具备 `eventId` 和幂等性处理；通知本身不能重复触发外部写操作。
- 事件包只带状态、受限摘要和已审核引用；大文件和私有内容需另走受保护资源接口。
- 日志、Event Journal 和用户界面事件是不同概念；不能把敏感原始 ToolCall 透传 UI。

## 3. 请求/取消/背压

- 每个传输声明最大帧、最大排队数、最大并发、超时及取消传播规则；以实际代码的已发布限制为准，新系统不能静默放宽。
- `abort` 只保证停止等待/尝试终止，不代表外部副作用未发生；超时产生待对账状态。
- 写入队列拥塞应拒绝新请求并给稳定错误，不能无限增长并拖垮 UI。
- RPC 控制面、Agent Session Follow、文件流与插件事件传输分开；禁止拿无认证的 Event 通知作为命令通道。

## 4. 关联关系与幂等键

字段分工：`requestId` 是一次请求标识，`correlationId` 串起跨组件追踪，`taskId/attemptId` 表示执行上下文，`operationId` 表示可信 Core 赋予的副作用身份，`eventId/sequence` 用于订阅去重。**它们不等价**。请求端输入不能自称已审批，也不能用 correlationId 绕过 operationId 风险控制。

## 5. 安全桥接

为每种现有传输建立 Adapter Map：解码 → Schema 验证 → 可信身份绑定 → Core 业务方法 → 脱敏结果 → 编码。签名数据只在已验证的协议域内解析；签名前后的 JSON 键顺序/大小写和 payload 序列化不得在中途随意改写。

## 6. 双端接口约束

共享的只有不依赖 UI/设备的稳定领域类型与 Golden Fixtures。Mobile 在 React Native/TypeScript 下保持 Native Capability 权限系统，不能复制 Desktop 进程/Node IPC 作为手机 transport。大改配对协议必须 Desktop + Mobile 双端同时测试。

## 7. 测试集

非法帧、截断 UTF-8、未知版本、无认证请求、巨大帧、队列上限、断线、取消、迟到回执、事件丢包、Cursor 过期、消息重复、未知授权字段、签名序列化变化、双端 fixture 一致性。
