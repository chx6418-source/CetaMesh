# CP-050 — Task、Attempt、Agent 协作与连续性协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：ALIGNMENT；已有 `src/task/types.js`, `src/continuity/types.js`, `docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md`。**

## 1. 所有权

**Sessions are disposable; progress is persistent.** Task 是 Core 持久对象；Session/Provider/Agent 是可替换执行资源。跨 Agent 交接不可创建一个冒充原任务的新 Task，也不能只靠对话摘要证明项目已完成。

现有 Task 状态机：`queued`, `running`, `waiting`, `blocked`, `paused`, `completed`, `failed`, `cancelled`。不得在通用协议里自创 `pending` 替代 `queued`。合法转换必须复用 `src/task/types.js:TASK_TRANSITIONS`。

## 2. Task/Attempt/Operation 对象

- `taskId`：稳定、与 Provider 无关。
- `attemptId`：某次执行尝试或交接尝试的标识；一次失败可生成新 Attempt，但不能抹掉旧的副作用。
- `sessionId`：属于某个具体 Provider，必须与 Task/Attempt 绑定。
- `workspaceId`：Core 授权的工作区；任何 Git、测试和文件能力需检查实际路径与授权。
- `expectedRev`：并发更新时确保不覆盖其他 Agent 或用户修改。
- `operationId`：Core 可信的副作用幂等身份；禁止模型、插件随意替换。

## 3. 协作协议

`plan → assign → prepare attempt → authorize → execute → verify → deliver/review → settle`。

- `plan` 可由多角色 Simulation 讨论形成，但讨论不等于执行，必须创建真实 Task。
- `assign` 基于实际 Agent readiness/能力/安全策略/费用与 Workspace 约束。不能因 Agent 宣称“可用”就自动发任务。
- `execute` 由受授权的 Managed Agent / 外部 Agent 通过既有 Broker/Capability 运行；多 Agent 工作区写入需要互斥、独立 Worktree 或经过既有写入归属控制。
- `verify` 采集真实 git diff、test、artifact、提交与任务结果；仅 LLM 自述不构成完成证据。
- `deliver` 将成果引用回 Task/Chat/Simulation；用户确认流程与工具审批不同。

## 4. Handoff Packet

优先复用 `src/continuity/types.js:normalizePacket()` 的字段及已有 `versionContext`、操作记录与安全范围，不直接要求另一 Provider 理解旧的私有 Session 格式。

Packet 应包括：任务目标/验收、已完成和待完成工作、当前 Workspace/Branch/HEAD/Dirty state、Artifact/Test evidence、关键决策、Memory refs、上次错误及未知副作用、Checkpoint 和下步行动。

Secrets、未授权的私人 Memory、完整聊天原文不能靠交接自动携带。换 Provider 必须重新评估能力、认证和本机执行授权。

## 5. 安全恢复路径

- 先 `checkpoint`，再创建/切换执行会话；旧会话保留可追溯性。
- `reconcile` 以**真实 Workspace 和操作回执**为事实源，Checkpoint 是进度声明而非写盘事实。
- 若 Workspace HEAD/内容与 Checkpoint 不符，暂停继续执行，进入 `needs-reconciliation`/`blocked`；不得盲目自动合并、清空或重放。
- 未知效果的提交/发送/网络写入必须单独确认结果，不能仅凭新 Session 建立成功而重复执行。

## 6. 事件建议（Core 视图层）

`task.created`, `task.assigned`, `attempt.started`, `attempt.blocked`, `attempt.completed`, `checkpoint.created`, `handoff.started`, `handoff.completed`, `reconcile.conflict`, `artifact.verified`。事件必须带稳定 Task/Attempt/Run 关联、递增 sequence 和来源证据，不得伪造成功。

## 7. 契约测试

双 Agent 同一文件写冲突、Task Rev 竞争、Checkpoint 损坏、Provider 重启、额度耗尽、Session rollover、跨 Provider 切换、旧审批失效、Test FAIL、生成 Artifact 缺失、取消时未知副作用、多个子任务完成状态与父任务围栏、Worktree Import 审批。
