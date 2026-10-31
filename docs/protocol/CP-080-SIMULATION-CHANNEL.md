# CP-080 — 原生 Simulation / Persona / 外部 Channel 适配协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：NEW + MIGRATION；现有 Bionic 与 QQ/SnowLuma 的耦合属待迁移事实，不应宣称本规范已实现。**

## 1. 独立性

原生 Simulation 依赖 CetaMesh 内部 Model Runtime、Task、Memory、Workspace、Agent Broker 和 Capability Broker；不应把 SnowLuma、QQ 或 DSH 作为启动前提。**模型生成仍需已配置的云端或本地 Model Provider**。无 QQ/DSH 时可以进行本地仿真会话和项目任务规划；缺少模型需如实提示。

## 2. 角色人格资产是独立、版本化数据

`Persona` 应保留 `roleId`, `revision`, 原始角色卡（完整全文、Hash、来源）、人格约束、风格与节奏、对话正反例引用、场景行为偏好、与 Memory 的受控关系。`Dialogue Example Library` 用多轮正例/反例和情境标签，不能只提炼“傲娇、活泼”等泛化标签。

原始 `roles/*.md`、`state/current-role.json`、`social-v2.json`、相关记忆和历史会话数据先备份和所有权核对；不可静默截断 6000 字符、丢弃尾部范例，不能把负面示例误作为正向回复。

## 3. 新领域对象（提案）

- `simulation.room`：独立会话 ID、类型（自由聊天/讨论/项目协作）、参与者、Workspace/Task 引用、可用预算和状态。
- `simulation.participant`：`roleId + roleRevision`，实际执行 provider 的授权映射（可为空），不得自动等同真实独立 Agent 进程。
- `simulation.turn`：说话者、消息引用、序号、拟真行为决定、模型耗用、取消/暂停状态。
- `simulation.scene`：目标、预算、时间/轮次上限、唤醒/沉默规则、行为限制。
- `simulation.delivery`：Task/Attempt/Git Diff/Artifact/Test 的可验证引用；不因模型说“完成了”就标记 `completed`。

## 4. Behavior 和 Dialogue 生成

先由 Scenario Orchestrator 决定要不要发言、由谁发言、是否等待/潜水、是否受控主动提问；再由 Persona 层为当前场景检索相关正反对话示例并构建上下文；Model Runtime 生成回复。静默和节奏由 Core 原生调度执行，不依赖 QQ 文本标记或 DSH 特有工具。

自动多角色讨论必须有总轮次/费用/Token/并发上限、停止/暂停和人工打断；角色拥有长期风格不代表拥有外部工具调用权。

## 5. 项目执行契约

模拟讨论转真实任务：`room.plan → owner review → task.create → assign → capability execution → verify → deliver to room`。Task 与 Workspace 仍由 Core 持有；Git Worktree、文件写、测试和发布都需原有权限/审批，虚拟角色不是授权主体。

## 6. Channel Adapter（可选）

外部 QQ/OneBot、其他即时通讯、Webhook 等只是可插拔 `channel-adapter`。适配器处理消息来源、`eventId`, `conversationId`, `senderRef`, `receivedAt`, `body/mediaRefs`, `replyTo`, `dedup`；发送由 Capability Broker 的 `message.send`（或实际已注册的受控能力）审批和结果回执处理。

**SnowLuma 下线策略**：移除专属安装/更新/进程控制/UI/MCP 入口，不卸载用户程序、不杀用户 QQ 进程；保留独立 OneBot v11 WebSocket/HTTP 协议解析与可替换适配。旧 `config.snowluma` 如有信息需要迁移，要经 Owner 审查后转换为通用 OneBot 配置，不能自动搬运 accessToken。

## 7. 保真与安全验收

单角色/多角色在相同模型下的正反示例评估、沉默/主动行为的可解释理由、旧角色卡全文 Hash 比对、聊天恢复、多角色互不窃取 Memory、无 QQ/DSH 可用性、真实项目 Task 证据、无权限执行拒绝、旧渠道停用时不可调用历史工具 ID。
