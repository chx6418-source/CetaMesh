# CP-010 — 外部 Agent 接入协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT + 部分 NEW；现有事实源 `src/agent/agent-provider.js`、`broker.js`、`docs/desktop/AGENT_INTEGRATION_STATUS.md`。**

## 1. 架构边界

- `Agent Provider != Model Provider`；外部 Agent 通过 `AgentProvider` → `Agent Broker` 接入，底层可为 DSH、Codex exec/App Server、ACP、独立 CLI、私有 API/SDK 等。所有 Tasks 与 Workspace 归 CetaMesh 管理。
- `Agent Provider` 无权直接授予自身文件系统、进程、网络或用户记忆权限。Native tool 走已验证的权限桥或隔离/受控导入路径；执行安全模式不能由 Provider 自述绕过。
- Agent Client Protocol (ACP)、MCP 与 Agent2Agent (A2A) 是**不同用途**：ACP 是编辑器/客户端到编码 Agent 的交互，MCP 是工具/资源，A2A 是独立远程 Agent 间任务互通。外部传输通过 Provider Adapter 映射到 CetaMesh 领域契约，不能将三者直接混为一体。

## 2. 不变的 AgentProvider v1 方法

核心方法（当前 `agent-provider.js`）：`createSession`, `send`, `cancel`, `status`, `contextUsage`, `resume`, `closeSession`, `selectModel`, `health`, `follow`。

可选方法：`archiveSession`, `nativeCheckpoint`, `nativeHandoff`。不支持必须报告 `AGENT_UNSUPPORTED`/`supported:false`，禁止假实现。

- `createSession`：需显式 Provider、验证 Workspace/Task 关联、隔离 Profile 与权限描述。创建成功只证明有 Session，不等于获准运行任务。
- `send`：可接受文本或类型化内容块；有界输入；必须关联现有 Session、Task 范围和授权；返回实际请求/回合标识。
- `cancel`：必须停止后续执行，不应被视为“撤销已经发生的副作用”。
- `resume`：必须确认 Session、授权、工作区绑定和状态；发生未知副作用时进入对账。
- `follow`：按 Provider 原始事件协议转换为稳定的 Core 事件投影；报告递增 sequence 和可恢复 cursor（如 Provider 支持），不可伪造历史。
- `contextUsage`：未测到则 `unknown/estimated`；不能把估算写成真实计量。
- `health`：分开报 installed、configured、authenticated、reachable、ready、taskEligible、nativePolicyVerified、workspaceBoundary，不进行无授权登录、付费请求或外部副作用。

## 3. 连接元数据（新增 Adapter DTO 提案）

```json
{
  "providerId":"codex", "adapterVersion":"1.0", "transport":"codex-app-server-jsonl",
  "protocolId":"codex-app-server", "protocolVersion":"pinned-by-adapter",
  "capabilities": {"createSession":true,"send":true,"cancel":true,"follow":true,"nativeCheckpoint":false},
  "security":{"mode":"native-permissions","nativePolicyVerified":false},
  "readiness":{"installed":true,"configured":true,"authenticated":null,"ready":false},
  "limits":{"maxConcurrentSessions":1,"maxEventBytes":1048576}
}
```

**这是待引入的元数据 DTO，不是当前已上线的 JSON 响应格式。** 字段 `nativePolicyVerified` 必须来自 Core 可信探测证据，不由外部 Agent 任意上报而获得执行权。版本必须与精确的运行时构建/SDK/协议握手结果绑定，不能只按“发现了程序”判断可用。

## 4. 事件与轮次生命周期

标准投影建议包含 `session.opened`, `turn.started`, `message.delta`, `tool.started`, `tool.completed`, `approval.pending`, `turn.completed`, `turn.failed`, `session.closed`。这些是**Core 事件投影**，不是要求 ACP/DSH/MCP 改发同名消息。

每个事件带 `providerId, sessionId, taskId?, attemptId?, runId?, sequence, timestamp, correlationId, payload`。如果事件游标过期，明确返回 `CURSOR_EVICTED` 并要求受信快照对账，不假装完整重放。

## 5. Provider 运行就绪门禁

1. 发现安装 / 端点（不授予权限）；2. 协议版本与身份校验；3. 可用能力、输入契约、认证/配置证据；4. 执行策略/Native Approval 证据；5. Owner 绑定 Task/Workspace 与执行授权；6. 实际任务执行。

Gemini 类原生权限回调如果缺工具完整输入，必须显式 `native_input_unverified`，不能放行真实执行。外部 UI 客户端存在不代表 CLI/ACP 可用。验证失败的 Provider 可以保留注册但 `taskEligible=false`；不应因此阻止 Core 启动。

## 6. 错误与恢复

`AGENT_UNSUPPORTED`, `PROVIDER_UNAVAILABLE`, `SESSION_NOT_FOUND`, `AGENT_SECURITY_CONFIRMATION_REQUIRED` 等既有错误码保留。连接断开时不得假定工具没有执行；工作区有改变时进入 Task/Continuity Reconcile。Agent Handoff 只转移 Task 标准状态、Checkpoint、Memory 引用与可验证成果，不直接转移旧 Provider 的秘密、Session 内部 Token 或未审批工具权限。

## 7. 外部协议适配策略

- ACP：明确记录支持的上游主版本、方法、工具参数和权限回调映射，运行握手协商；不以“符合 ACP”代表所有能力可用。
- Codex App Server：现有独立 JSONL framing 不映射成 ACP framing；必须使用专有适配与版本守卫。
- CLI/SDK/API：独立 Profile、凭据引用及可证明的 native policy，严格区分 dry-run 探测和真实执行。
- A2A（可选未来）：远端 Task/Artifact 映射到 CetaMesh Task，远端身份与能力声明不自动产生本地 Workspace/Memory 授权；暂不能声称已实现。

## 8. 最小契约测试

未知版本/方法、会话不存在、禁止权限绕过、Provider 切换权限重评估、Native 工具参数缺失、取消/超时未知效果、跟随流 sequence、事件重放/游标失效、模型用量真假、Workspace 边界变化、重启恢复、真实协议握手。新 Provider 必须附 `PROTOCOL_SUPPORTED`, `AUTH_TESTED`, `TOOL_POLICY_VERIFIED`, `REAL_TASK_VERIFIED` 独立证据。
