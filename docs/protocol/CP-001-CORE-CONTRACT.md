# CP-001 — 跨模块通用领域消息、错误与身份语义（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：NEW / PROPOSED。此契约面向未来新增的 Core 内部模块交互与 typed DTO，不覆盖已有 IPC、ACP、MCP、Mesh 签名信封及 Extension Worker 的线上帧。**

## 1. 新领域契约信封

```json
{
  "protocolId": "cetamesh.core", "protocolVersion": "1.0", "kind": "request",
  "messageId": "req_3a91", "correlationId": "corr_3a91",
  "timestamp": "2026-10-31T13:00:00.000Z",
  "method": "example.read", "payload": { "id": "example-1" }
}
```

- 必填 `protocolId`, `protocolVersion`, `kind`, `messageId`, `correlationId`, `timestamp`, `payload`；`request` 还需 `method`。
- `kind` 为 `request | response | event | error`；`payload` 必须为 JSON object，避免原始巨型二进制穿过 IPC。
- 可选 `taskId`, `attemptId`, `workspaceId`, `traceId`, `deadlineAt` 仅用于**关联**，不能单独构成授权凭据。
- `principal`, `grants`, `approved`, `approvalId`, `secret` 等安全字段不可从不受信传输的 payload 反推为执行身份；由可信 Core 组合层注入。
- `timestamp` 是审计与时效提示，不是单独的防重放机制。跨网络发送必须使用其各自已有的签名、nonce、replay 缓存。

## 2. 统一业务结果与错误

```json
{
  "code": "OPERATION_OUTCOME_UNKNOWN", "category": "execution",
  "message": "执行结果尚不能确认，需要核对后继续。",
  "retryable": false, "effectState": "outcome-unknown",
  "correlationId": "corr_3a91"
}
```

- `category`: `validation | protocol | auth | policy | permission | unavailable | resource | execution | data | internal`。
- `effectState`: `not-applicable | no-effect | completed | outcome-unknown`。**超时/取消/断连本身不能直接归为 `no-effect`**。
- `retryable` 表示协议层可建议恢复，并不授予自动重复调用权；非幂等操作只在核心执行者证实 `no-effect` 或完成对账时重试。
- 错误 `code` 由模块命名空间稳定映射，例如 `AGENT_*`, `EXTENSION_*`, `MEMORY_*`, `IPC_*`, `CAPABILITY_*`, `MESH_*`；保持现有已暴露错误码，新增通用码使用单独映射表，不直接替换遗留码。
- UI 只得到可显示的 `message` 与引用；不接触底层堆栈、原始路径、密钥、Cookie、聊天内容。

## 3. 能力与状态语义

任何可用能力应区分 `declared / discovered / installed / configured / authenticated / reachable / ready / authorized / executable`。一个状态为 true 不推出其他状态为 true。未知用 `null/unknown`，不得自动转成通过。

活动状态建议标准化为 `queued / running / waiting / blocked / completed / failed / cancelled` 的投影；不得覆盖现有 Task v1 状态机。任务、工具、Provider、插件各自的具体状态通过**显式映射表**转成 UI 文案。

## 4. 资源与版本

- 所有 DTO 都有明确大小上限；大型附件使用受权限控制的对象引用 + 内容哈希，不向结构化事件中直接塞入文件字节。
- 对需原子更新的数据使用 `expectedRev`/ETag 风格的乐观并发检查；冲突返回稳定错误且保留旧数据。
- 垃圾输入、未知主版本、必填字段缺失 -> fail closed；未知附加可选字段由对应版本策略决定是否忽略，严禁触发新权限。
- 契约经 Schema 和 Golden Fixtures 验证；具体字节框架的上限不得因新 DTO 的引入而放宽。

## 5. 兼容边界

现有 `src/control/ipc-protocol.js` 是长度前缀二进制帧，现有 `src/extension/process-host.js` 使用 `{v:1,...}`，ACP 与 Codex 使用各自 JSON-RPC/JSONL，Desktop/Mobile 配对含受签名保护的特殊格式。**这些均不是 CP-001 信封的旧版本**，必须有明确的转换适配层，不允许自动加字段、重新序列化签名报文或隐式改变版本。
