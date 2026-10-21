# HANDOFF — 会话 2：Agent Broker + Continuity Runtime v2 + 自动 Fresh Session Rollover

## Base Commit

`08a3934`（main，会话 1 最终提交；分支 `feature/desktop-continuity-v2`）

## Final Commit

`f4cb224`（feat(continuity): add automatic session rollover）。
其前为 `53f4f43`（refactor(agent): unify agent provider runtime）、
`35f6ec4`（feat(continuity): reconcile workspace on resume）；
随后的 docs 提交（本文件 + PROJECT_STATE 记录）为分支最后一个提交。

## Goal

结束"双 Provider 抽象"：`src/agent/` 成为唯一正式 AgentProvider 契约，Continuity
不再自带窄 Provider 注册表，Chat / Task / Continuity 一律经 **Agent Broker** 消费
会话能力（DSH 保持第一个真实 Provider）。在此之上实现自动 Context Monitoring、
自动 Fresh Session Rollover（同 Provider 第一优先）、Checkpoint v2、Session
Bootstrap v2 与 Workspace Reconciliation。核心原则落地：
`Tasks belong to CetaMesh, not to agents. Memory belongs to CetaMesh, not to
agents. Sessions are disposable; progress is persistent.`

## Completed Tasks

| Task | 内容 | 状态 |
| --- | --- | --- |
| TASK-S2-001 | AgentProvider 契约收口：核心方法 + 可选能力显式 unsupported；`checkpoint/handoff` 改名 `nativeCheckpoint/nativeHandoff`，新增可选 `archiveSession`；`normalizeUsageTokens` 归一化多种 usage 形状 | 完成 |
| TASK-S2-002 | Agent Broker（`src/agent/registry.js` + `broker.js`）：注册表唯一事实源、会话操作统一分发、可选能力诚实包装（`{supported:false, reason:'UNSUPPORTED'}`）、回合结束事件扇出（onTurnEnd/reportTurnEnd）、rolloverStrategy 声明 | 完成 |
| TASK-S2-003 | Continuity Provider 收口：删除 `src/continuity/provider.js`（窄注册表 + 窄 DSH 实现），Runtime 只依赖 Agent Broker | 完成 |
| TASK-S2-004 | 回合结束自动上报：chat-service Agent/DSH 通道 `finalizeTurn` → `onTurnEnd` → bridge 接线 `broker.reportTurnEnd` → Continuity `observeAgentTurn`；真实 usage 优先，无真实 usage 用字符估算并标记 estimated；Model 通道不上报 | 完成 |
| TASK-S2-005 | 自动 Fresh Session Rollover：`observeAgentTurn` 达 rollover/forced/emergency 阈值 → 结构化 Checkpoint → 结束旧 Session → 经 Broker 开新 Session → Bootstrap → `task.attachAgent` → Workspace Reconciliation → 继续任务（Task ID 不变） | 完成 |
| TASK-S2-006 | Checkpoint v2：packet 新增 `memoryRefs`（仅 memoryId 引用，原文不复制）与 `workspaceFacts`（真实 git/文件事实）；缺失如实 null/[]，不编造 | 完成 |
| TASK-S2-007 | Workspace Reconciliation（`src/continuity/reconcile.js`）：collectFacts（真实 gitStatus/gitHead/gitDiff --stat/文件存在性）+ reconcile（branch/headSha/missing-file/no-git-repo discrepancy 记录；consistent:true/false/null 三态） | 完成 |
| TASK-S2-008 | Session Bootstrap v2：结构化恢复说明（Goal/Requirements/Completed/Remaining/Decisions/Workspace/Tests/Failures/Memory 引用/Acceptance/Next Action），明示旧任务续接、不重做 completed work、先验证 Workspace、从 nextAction 继续；绝不复制聊天历史 | 完成 |
| TASK-S2-009 | 同 Provider Rollover（DSH→DSH / fixture alpha→alpha'）：默认路径，fixture 全链路验证可用 | 完成 |
| TASK-S2-010 | Cross Provider Handoff：`targetProvider` 参数 + 同一 Broker 内多 Provider 寻址；fixture A→B 验证 Task ID/Workspace/Progress 不变、agentHistory 追加 | 完成（架构 + fixture） |
| Work UI | 未改动（Runtime/API 完整优先，UI 状态展示记为后续） | 按提示词允许跳过 |

## AgentProvider Final Contract

```js
// 核心方法（AGENT_PROVIDER_CORE_METHODS）：
createSession, send, cancel, status, contextUsage,
resume, closeSession, selectModel, health, follow
// 可选能力（AGENT_PROVIDER_OPTIONAL_METHODS，缺省自动填充显式 unsupported 桩）：
archiveSession, nativeCheckpoint, nativeHandoff
// capabilities() 返回 { id, label, eventProtocol, supported, unsupported, ...capabilityExtras }
// capabilityExtras 例：DSH 声明 rolloverStrategy: { preferred: 'fresh-session' }
// 错误码新增：AGENT_PROVIDER_UNKNOWN（未知 Provider 专用）
// 新增工具：normalizeUsageTokens(usage) —— 兼容
//   {inputTokens,outputTokens} / {input_tokens,output_tokens} /
//   {prompt_tokens,completion_tokens,total_tokens}；凑不出 token → null（不伪造）
```

Broker 门面（`createAgentBroker({ registry, log })`）：`register/get/require/has/
ids/listProviders/capabilities` + 会话操作（provider id 必填首参）+
`archiveSession/nativeCheckpoint/nativeHandoff`（unsupported → 结构化
`{supported:false, reason:'UNSUPPORTED'}`，真错误原样上抛）+ `reportTurnEnd/
onTurnEnd`（单监听器失败不阻断扇出）+ `rolloverStrategy(providerId)`。
`createDefaultAgentService` 返回的服务对象带 `.broker`，供 bridge 接线。

## Continuity Flow

```text
Agent Turn Ends（chat-service Agent/DSH 通道，或 continuity.turn.observe 显式上报）
  → 真实 usage 优先入 Context Monitor（source:'usage'）
  → 无真实 usage → 字符估算（source:'estimated'，绝不冒充真实 Token）
  → evaluate → none / checkpoint / ready / rollover / forced / emergency
  → 达 rollover+ 且 policy.autoRollover 且绑定 Task：
      canRollover 安全点检查（未到 → ROLLOVER_NOT_SAFE，保留当前 Session）
      → 互斥窗口（in-flight → ROLLOVER_IN_FLIGHT 收敛为 rolledOver:false）
      → buildHandoffPacket（Checkpoint v2 + workspaceFacts）→ savePacket
      → task.setCheckpoint → broker.cancel（尽力）+ broker.archiveSession（如实能力）
      → task.detachAgent（agentHistory 追加，Task ID 不变）
      → broker.createSession(targetId) → broker.send(bootstrap 结构化恢复说明)
      → task.attachAgent(新 Session)
      → Workspace Reconciliation（fresh session 后核验，discrepancy 记录不篡改）
      → rollover 历史落盘 + monitor.reset（新 Session 从零计数）
```

## Auto Rollover Thresholds

| 带区间 | 动作 | 自动行为 |
| --- | --- | --- |
| < 70% | normal → none | 只记录 |
| 70–78% | prepare → checkpoint | 建议 checkpoint，不切换 |
| 78–85% | ready | 寻求安全点，不切换 |
| 85–90% | rollover | 自动 Fresh Session（reason=context-threshold） |
| 90–92% | forced | 自动 Fresh Session（reason=forced-rollover） |
| 92%+ | emergency | 自动 Fresh Session（reason=forced-rollover） |

全部可配置（`continuity.policy.set`：prepare/rollover/forced + `autoRollover`
开关，默认 true；false = 只评估不执行）。Provider 可声明
`rolloverStrategy.preferred`；本阶段唯一实现策略为 `fresh-session`，其他声明值
照实透传但执行仍按 fresh-session（不假装实现了压缩续接）。

## Checkpoint Schema（Checkpoint v2）

```js
{ taskId, goal, requirements[], currentPhase, completedWork[], pendingWork[],
  decisions[], workspace, relevantFiles[], artifacts[], 
  memoryRefs: [{ memoryId, note }],          // 仅引用；原文留 Memory Runtime 按需加载
  checkpoint: { summary, nextAction },
  acceptanceCriteria[], 
  previousAgent: { provider, sessionId }, reasonForHandoff,
  coding: { branch, headSha, gitStatus, gitDiffSummary, testsRun[], buildStatus, knownFailures[] },
  workspaceFacts: { available, workspaceId, git: { isRepo, branch, headSha, dirty, diffSummary }, files: [{ path, exists }], collectedAt } | null,
  reconciliation: { checkedAt, consistent, discrepancies[], note } | null,
  sequence, createdAt }
```

落盘：`state/continuity/handoff/<taskId>/packet-NNNN.json` + `latest.json` +
`reconciliation-NNNN.json`（侧车）；历史 `state/continuity/rollovers.json`（含
strategy / archiveSupported / workspaceReconciled / reconciliation）。

## Workspace Reconciliation Behavior

- 事实来源：workspace 登记条目（`workspaceService.describeWorkspace` 只读入口）+
  tools 只读动词（`gitStatus` / 新增 `gitHead`=rev-parse HEAD / `gitDiff{statOnly}`）。
  `relevantFiles` 存在性检查收敛在 root 内（防越界探测）。
- 规则：真实 Workspace > 旧 Agent 摘要。不一致项逐条记录 discrepancy
  （branch / headSha / missing-file / no-git-repo，双侧值如实保留），
  绝不静默修改 Task State。
- 三态结论：`consistent: true / false / null`（null = 事实不可得——工作区未绑定、
  不存在或收集失败，明确"无法核验"，不判定真伪）。
- 空 git 仓库 HEAD 如实为 null；非 git 目录记 no-git-repo，不编造 SHA/分支。

## Changed Files

- 新增：`src/agent/registry.js`、`src/agent/broker.js`、`src/continuity/reconcile.js`、
  `scripts/test-agent-broker.mjs`、`scripts/test-continuity-auto-rollover.mjs`、
  `scripts/test-workspace-reconciliation.mjs`、本文件。
- 删除：`src/continuity/provider.js`（窄 AgentProvider 注册表 + 窄 DSH 实现）。
- 修改：`src/agent/agent-provider.js`（契约收口 + normalizeUsageTokens）、
  `src/agent/service.js`（Broker 支撑）、`src/agent/dsh-agent-provider.js`
  （rolloverStrategy 声明）、`src/continuity/{runtime,service,index,types}.js`、
  `src/task/runtime.js`（只读 findByAgent）、`src/workspace/tools.js`（gitHead +
  diff statOnly）、`src/workspace/service.js`（describeWorkspace 只读入口）、
  `src/desktop/chat-service.js`（onTurnEnd 上报）、`src/bridge.js`（Broker 接线 +
  reconciler 适配器 + 事件注册）、`scripts/test-agent-provider.mjs`、
  `scripts/test-continuity-rollover.mjs`（移植 Broker）、`package.json`
  （3 个新测试脚本）。

## Tests Run（本机实跑）

| 测试 | 结果 |
| --- | --- |
| `node scripts/test-agent-broker.mjs`（新增） | **PASS（7 组）** |
| `node scripts/test-continuity-auto-rollover.mjs`（新增） | **PASS（9 组）** |
| `node scripts/test-workspace-reconciliation.mjs`（新增，真实临时 git 仓库） | **PASS（6 组）** |
| `node scripts/test-continuity-rollover.mjs`（移植 Broker） | **PASS（6 组）** |
| `npm run test-agent`（23 单元 + 真机 DSH 段 D1–D7） | **PASS** |
| `npm run test-task` / `test-memory` / `test-workspace` | PASS |
| `node scripts/test-desktop-chat-product.mjs` | PASS（17 组） |
| `npm run test-core-entry` / `test-privilege` 24/24 / `test-dsh-integration` | PASS（privilege 运行段按惯例跳过） |
| `npm run test-architecture` | PASS（8 组红线） |
| `npm run desktop:check` / `desktop:test` | PASS / 87/87 |
| `npm run test-system` 108 / `test-control-service` / `test-model-runtime` 12 / `test-smart-router` 9 / `test-model-selection` 7 / `test-provider-secrets` 6 | PASS |
| `node scripts/test-ipc-protocol.mjs` | PASS |

## Known Limitations

1. **自动上报的回合机目前只有 chat-service**：Agent/DSH 通道的回合结束会自动进入
   Monitor（未绑定 Task 的会话只记录不触发）。Task 专属的 Agent 执行器（自动驱动
   任务回合的循环）尚不存在——Task 绑定会话的自动 rollover 已就绪并经 fixture 全链路
   验证，等 Task 执行器（后续会话）接入即生效；也可经 `continuity.turn.observe`
   显式上报。
2. **rollover 策略只实现 fresh-session**：Provider 的其他策略声明照实透传但不执行
   （无压缩续接实现）。
3. **Work UI 未接**：Tasks 页尚未展示 Agent/Session/Context%/source/Strategy 与
   Create Checkpoint / Start Fresh Session / Switch Agent 操作（Runtime/API 已完整：
   `continuity.status/evaluate/rollover/reconcile/turn.observe` 均经 IPC 可用）。
4. **DSH contextUsage 投影未并入 Monitor**：`tokenUsage.uncachedInputTokens /
   contextPressure.pressureTokens` 与回合 usage 语义不同（非累计），未自动换算，
   避免把不可比数据冒充累计使用率。
5. `evaluate`/`observeAgentTurn` 的 rollover 期间（detach 之后）反查任务会得到
   "未绑定"，此时上报只记录不触发——并发语义已在测试中固定。

## Known Risks

1. chat-service 的上报对旧 DSH 直连通道同样生效（provider 归一为 'dsh'）；若未来
   把 chat 会话与 Task 绑定到同一 DSH Session，可能触发意外的自动 rollover——当前
   chat 与 Task 会话从不共享 sessionId，无实际路径。
2. `gitHead`/`gitDiff` 依赖工作区 git 可用；git 缺失时事实收集失败按
   available:false / unknown 处理（不炸 rollover，但核验能力退化为 null）。
3. `estimateTokens` 字符估算法（charsPerToken=4）对中文/代码混排偏差较大；估算值
   永远带 `estimated` 标记，误判方向是提前/滞后触发 rollover，不影响数据完整性。
4. Bridge 中 chat-service→broker→continuity 为进程内异步链路；observe 失败仅记
   日志（fire-and-forget），若 continuity 存储目录损坏会持续失败但不阻塞聊天。

## Session 3 Entry Point

- 分支 `feature/desktop-continuity-v2` 合并 main 后以 main HEAD 为准。
- 入口健康基线：`test-agent-broker` / `test-continuity-auto-rollover` /
  `test-workspace-reconciliation` 三套新测试 + `test-continuity-rollover` /
  `test-agent-provider` 全 PASS。
- 关键入口符号：
  - Agent Broker：`src/agent/index.js` `createDefaultAgentService`（返回值带
    `.broker`）；bridge 持有 `agentService`/`agentBroker` 实例。
  - Continuity Runtime：`src/continuity/service.js` `createContinuityService`
    （bridge 已接线 onTurnEnd → observeAgentTurn 自动链路）。
  - Workspace Reconciliation：`src/continuity/reconcile.js`
    `createWorkspaceReconciler`（bridge 已用 workspace 只读入口组装）。
  - Session 1 遗留消费点：chat 回合 `routing.agentIntent`（project 意图）仍只记录
    不执行——会话 3 的 Capability/Workshop 接入时应把它升级为经 Broker 的受控执行。
- 建议（Session 3）：Task 执行器接 `observeAgentTurn`（或直接复用 Broker 事件）、
  Work UI 最小状态展示、Capability 网关消费 `capabilityIntent`、Cost Policy UI。
