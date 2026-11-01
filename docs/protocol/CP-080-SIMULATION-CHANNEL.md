# CP-080 — 原生 Simulation / Persona / 外部 Channel 适配协议（提案 v1.0）

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PARTIAL + MIGRATION。** 原生基础已在 `src/simulation/` 实施，使用既有 Model Runtime、Task、Workspace、Memory 和 Capability Broker；这不使本提案成为新的 wire 协议。原 Bionic/QQ 路径保留，完整历史迁移和人格人工保真验收尚未完成。当前行为及限制见 [Native Simulation](../desktop/SIMULATION.md)。

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

**SnowLuma 下线策略（当前 Desktop 实现）**：专属安装、检测、进程控制、配置、插件卡片与 MCP 入口已退役；旧 ID 明确拒绝，不自动映射为其他集成，不卸载外部网关或结束用户 QQ 进程。独立 OneBot v11 WebSocket/HTTP 适配保留，默认关闭、端点为空，需 Owner 显式配置、启用插件并请求连接。配置、连接、认证与可发送状态独立，不以插件启用代替就绪。

旧 `config.snowluma` 只通过可信 Owner UI 预览并确认端点迁移：核对原文件字节 Hash 并保留原始字节备份，不覆盖已有 OneBot 配置；迁移后保持关闭，不复制令牌，Owner 需重新输入。保存和迁移不发起连接。角色卡与私有历史数据不因通道退役而迁移或删除；预设工具命名空间修订不等于完成人格迁移。上述实现复用现有 Core/Channel 与授权边界，**本文仍为 PROPOSED，不新增 wire 版本**；当前安装版本、真实外部通道与完整人格保真仍需独立验收。

## 7. 保真与安全验收

单角色/多角色在相同模型下的正反示例评估、沉默/主动行为的可解释理由、旧角色卡全文 Hash 比对、聊天恢复、多角色互不窃取 Memory、无 QQ/DSH 可用性、真实项目 Task 证据、无权限执行拒绝、旧渠道停用时不可调用历史工具 ID。
