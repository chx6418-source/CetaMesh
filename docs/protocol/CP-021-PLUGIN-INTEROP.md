# CP-021 — 插件互联、受控委托与协作协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PARTLY IMPLEMENTED；核心基线 `src/extension/manifest.js:delegates` 与 `src/extension/runtime.js:capabilityExecutorFor`。**

## 1. 已实现的基础事实

已有 Manifest v1 可声明 `extension.invoke` 和 `delegates[]`：每条 Delegate 指向**精确的** `extension.<id>.<capability>` 以及对象型 `inputSchema`，当前有 1–20 个显式目标的限制。Runtime 通过 Capability Broker 执行嵌套调用，跟踪 `pluginChain`，当前最多 8 hops，并检查上游链各插件仍启用且身份未变化、授权交集、安装指纹和目标 Capability 是否存在。**不要重造独立 Plugin Bus**。

## 2. 统一调用模型

- Caller Plugin → Core Extension Host → Capability Broker → Target Plugin Host → Result → Caller。
- Plugin 对另一个插件的意图请求不等于授权。只由可信 Runtime 构造 `actor`, `constrainedActor`, `taskId`, `workspaceId`, `attemptId`, `operationId`, `approvalId` 等执行上下文，插件不得伪造这些字段。
- 每个调用必须匹配已审核的 `delegates` 中目标能力、输入 Schema、权限 `extension.invoke` 和实际 Owner Grants；目标插件运行期需要自己的权限和真实可用状态。
- 有效权限等于：当前操作允许范围 ∩ 上游约束 ∩ Caller 真实 Grant ∩ Target Grant ∩ 本地策略。**任何插件委托都不能提升权限**。
- 禁止任意动态 capability 名称、未经审阅的万能路由、隐式用户身份代入、跨 workspace 资源透传。

## 3. 对外的协作语义（Core DTO 提案）

```json
{
  "targetCapability":"extension.cetamesh.http-meta.meta.fetch-title",
  "input":{"url":"https://example.com"},
  "reason":"Read approved page title for current Task"
}
```

只允许调用者提供 `targetCapability/input/reason`。`requestId`、`operationId`、调用链、当前 Owner Grant、Task/Workspace 绑定由 Core 注入。**示例是领域调用意图，不等于可直接传给当前 Process Host 的 wire frame。**

## 4. 调用链、安全与生命周期

- 已有深度上限为 8；新增要求应把**环检测**（同插件或同 capability 重入）作为新契约测试，避免靠深度上限掩盖循环委托。
- 在途调用需要有界超时、取消传播和背压。取消只是执行控制，不能把不确定副作用标记为未发生。
- 每层调用记录 `correlationId`, Parent Operation Identity, pluginId, capabilityId, descriptorVersion, 审批/执行结果。审计记录脱敏且不得包含密钥/正文。
- 任一插件被禁用/卸载/升级/撤销权限或 Worktree 绑定变化，应使后续调用 fail closed，并保护已完成外部效果的证据。
- `pending_approval` 返回后必须暂停本次调用链；不得自动换另一插件绕过同一审批。

## 5. 插件协作不是分布式事务

一个插件调用多个插件时，不保证跨插件写操作原子性。对于写操作，必须用 Core Task/Attempt、Operation Identity、Effect Receipt、Workspace Diff 和 Reconciliation 表示可见结果；故障后一律按效果分类执行恢复，不能默认自动重试所有子操作。

## 6. 订阅/事件型协作（未来）

- 优先复用 Event Journal 与现有 `channel-adapter` data-only event 协议；事件是通知，不是授权。
- 订阅必须声明事件范围、Owner/Task Scope、保留期限、最大并发/队列、重放策略与过滤规则。
- 事件消费者若要触发文件写入/消息发送/Memory 改动，仍须发起新的 Capability Broker 请求。
- 默认不允许插件之间直接共享私有存储、Secret 引用、Memory DB 文件或可执行 IPC 通道。

## 7. 最小集成示例

A 只读信息插件需要调用 B 的 `meta.fetch-title`，A 在 Manifest 声明 `extension.invoke` 和精确 delegates；Owner 批准；Runtime 验证 B 存在、已启用、Schema/Grant 有效，Broker 再调用 B。B 的网络能力继续受自己的 host allowlist 与 SSRF 策略约束。B 失败，A 得到稳定错误，不替 B 伪造成功。

## 8. 必须通过的测试

无权限、未声明委托、目标插件不存在、目标改变版本/哈希、父插件停用、跨工作区、权限交集为空、嵌套层数超过 8、循环链、并发拥塞、取消后迟到回执、approval pending、跨插件写入未知效果与审计重建。


## 9. 完整多层互联补充（v1.1）

[CP-023](CP-023-NESTED-PLUGINS.md) 规定物理嵌套与逻辑依赖区别；[CP-024](CP-024-PLUGIN-MESH-ORCHESTRATION.md) 规定调用/订阅/引用协作；[CP-026](CP-026-PLUGIN-COMPAT-SECURITY.md) 规定升级、安全与回滚。**不要把 Package 深度限制 5 层错认为 Runtime 调用链上限（仍 8 hops）。**
