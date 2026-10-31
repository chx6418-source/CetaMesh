# CP-024 — Plugin Mesh 插件互联、协同工作与事件协议

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PROPOSED；受控 Capability Invoke 部分已有实现，Plugin Event Pub/Sub 和跨层语义属于新增提案。**

## 1. 不建第二套 Plugin Bus

```
UI / Agent / Workflow / Simulation
               |
          Core Task/Attempt + Coordination Plan
               |
        Identity / Capability Broker / Approval
               |
   Plugin Mesh logical router + Event Journal (logical projection)
        /             |             \
  Extension Host    App Host       Device/System Host
     A → B → C      service         VM / remote
               |
          Memory/Artifact References
```

Plugin Mesh 是 Core 对现有 Broker、Extension Registry、Task/Continuity、Event Journal 的**协议视图**，不是新的授权服务、第二个队列真相源或旁路执行器。Agent/外部模型只有建议和声明权，实际授予、操作身份和结果归 Core。

## 2. 三条受控互联通道

| 通道 | 用途 | 传递什么 | 禁止内容 |
|---|---|---|---|
| Capability Invoke | 单能力调用或逐步委托 | 精确目标 ID、JSON 输入、受控上下文 | 任意 Core 权限、跨插件进程对象、伪造 actor/grant |
| Event Pub/Sub | 状态、事件、订阅触发 | 版本化事件、来源、序号、TTL、最小已授权内容 | 以事件自动获得新权限、默认传播私有正文 |
| Memory/Artifact Link | 可复用结果与证据 | 有界引用、Scope、版本、来源、接收方、目的 | 原始私有 Memory DB、凭据、任意绝对路径 |

不允许插件间通过自建本地 socket、共享私有文件、绕过 Broker 的任意 HTTP 通道调用宿主特权；网络类插件的正常外部 API 调用与 Plugin Mesh 互联应分开审计。

## 3. 能力合同与匹配

- **Producer** 公布 `capabilityId`, `contractVersion`, `inputSchema`, `outputSchema`, `effectClass`, `risk`, `dataClasses`, `limits`, `platforms`, `health`, `ownerPlugin`。
- **Consumer** 声明精确调用目标、受审输入 Schema、目的、必要范围、允许副作用和可接受版本。当前 Extension v1 走 `delegates[]`，不得假设已支持任意动态插件发现调用。
- **Coordinator** 只从实际注册且符合版本/授权/就绪/预算的候选中选择；计划阶段可推荐，但替换目标时如果数据接收方、权限、收费或效果类型不同，必须重新征得授权。
- **Schema 演进**：新增可选字段可 minor；删除/重命名字段、改变授权语义或副作用是 major；协议不兼容时返回 `PROTOCOL_VERSION_UNSUPPORTED`。

## 4. 端到端一次调用

1. 用户或 Task 形成 `Intent`，Core 解析并绑定可信 Principal、Task/Attempt、Workspace、预算与协作追踪标识。
2. Core 检查 Producer 真实 `READY`、契约版本、Producer 身份、Component InstancePath、包指纹、Caller 真实授权、精确 delegation 声明及 Owner/Task Scope。
3. 在 Broker 中计算权限交集与副作用等级；涉及数据外发、写操作、费用或敏感动作按策略审批。
4. 执行前生成 Core Operation Identity、记录必要的幂等键/效果证据预期；启动受限执行、发送结构化请求。
5. Producer 执行并返回有界结果/证据引用；Broker 验证来源、输出 Schema、执行状态及真实副作用。
6. Coordinator 将结果作为新的 Task 观察事实，只在真实成功后继续下游；`pending`、`cancelled`、`unknown effect` 时停止自动链并等待决策或对账。

### 参考调用（概念 API，非已实现 SDK）

```ts
await ctx.plugins.invoke({
  targetCapability: 'extension.cetamesh.parser.document.parse',
  input: { artifactRef: 'art_67' },
  reason: 'Parse reviewed task attachment'
});
// taskId/actor/workspaceId/traceId/grants 从 Core 受信上下文注入，插件不可自填。
```

## 5. 执行协调计划（Coordination Plan）

- 计划仅描述步骤 DAG：`stepId`, `dependsOn[]`, `targetCapability`, `inputBindings`, `expectedEffects`, `requiredApprovals`, `resultRef`；不包含原始 Secret 或自行颁发的 Grant。
- 状态：`planned → ready → running → waiting_approval / waiting_dependency / needs_reconciliation → completed / failed / cancelled`。
- 真实状态由 Task/Attempt/Event Journal 投影；Planner 和角色对话只是建议，不能自称步骤 completed。
- Fan-out/Fan-in 必须限制并发和全局预算；分支失败时只停止受影响路径，已完成副作用不自动删除。
- **Workflows 不是跨插件 ACID 事务**：跨系统写入需要事务外补偿建议、审计和 Owner 核验；禁止自动假定可逆。

## 6. Event Pub/Sub 合同（新提案）

- Producer 声明 `eventType` 与 Payload Schema、保留期、分类、版本、可订阅范围；Subscriber 声明精确事件、数据过滤、Scope、消耗速率、幂等策略，Core 才授予 Subscription Lease。
- Core 生成 `eventId`, `sourceInstance`, `sequence`, `emittedAt`, `traceId`, `taskId?`, `payloadRef/RedactedPayload`；第三方不得以自己的 payload 伪造 Core Event 身份。
- 有界队列和背压（队列上限、消费者并发、每分钟投递数、重试间隔）；缓冲区溢出必须上报 `EVENT_OVERFLOW` 和可恢复游标，不得静默补全历史。
- 初版选 **at-least-once notification** + 有界去重/ack；严格一次的跨插件外部副作用不可承诺。事件处理器欲执行外部写操作，应发出新的 Broker Capability 请求和 Operation ID。
- 订阅随插件禁用、升级、撤销 Scope、工作区关闭或 TTL 失效而终止；不因父插件自动订阅而泄漏子插件的事件。
- 与现有 `cetamesh-events-v1` data-only channel-adapter 的边界必须写适配器，不把已有远端 Event 源等同于内部订阅注册表。

## 7. 引用协作合同

- `MemoryRef`、`ArtifactRef` 由 Core 颁发，最少含稳定 ID、属主、Scope、类别、来源/证据、版本、消费者、用途、TTL/撤销条件。
- **读≠转交≠上传**。A 能读取某附件不代表 B 能读取该附件；B 能读取不代表 C 能带着附件调用远程模型。每次跨边界投递重新计算接收方和目的地授权。
- Ref 过期、失效、未授权、原对象被撤销或版本变化时返回结构化错误，不能自动降级为明文原始路径。
- 插件 Memory Pack 不可用一般可执行插件的写入或直接替换用户 Overlay。

## 8. 可靠性、配额与安全

- Root Budget 可指定调用 hops<=8、并发<=8、时间上限、Token/费用、文件 bytes、网络域名，任何子层只能缩减，不能扩大。
- 操作副作用用现有 `read-only/idempotent-write/conditional-write/non-idempotent/unknown`，`outcome-unknown` 不自动重试。
- 明确 Root Cancellation 对子孙传播；子进程退出、断线、超时后不能谎称所有外部效果不存在。
- 错误必须带稳定码、实际阶段、是否可重试、效果是否已知和 Trace，但所有日志脱敏。
- Guard 插件最多 veto/加约束，不可以替代 Core Policy 作 allow；Inspector 只消费最小诊断事件，不输出凭据。

## 9. 端到端示例：从聊天到开发、测试和交付

```
用户目标 → Team/Simulation 提议拆解 → Task 根授权
  → Workflow 创建依赖图
    → Knowledge/Memory 授权检索资料（仅 Ref）
    → Tool/Connector 在 Workspace 中修改和构建
    → Inspector 记录轨迹；Guard 可阻止高风险操作
    → QA Tool 执行测试，证据进入 Artifact Hub
  → Task 验证结果 → UI 审阅 Diff → Owner 验收
```

每步的能力来自对应插件真实 Descriptor，未经批准的 Source/Memory 不跨项目复用。将来 App/OS 按独立 Host 增加，不更改整个协调模型。

## 10. 最低契约测试

A→B→C 只读成功、单跳无权限拒绝、事件订阅越权拒绝、未启用时撤销、无限事件反馈环拒绝、消费者掉线与重放游标、重复事件只应用一次本地状态、跨插件文件外发需独立授权、审批挂起停止下游、未知副作用进入对账、节点失败不能把整个 Core 卡死。
