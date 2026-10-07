# HANDOFF — 会话 1：Model Runtime + Standalone Chat + Smart Router v1 + Cost Policy

## Base Commit

`aa5d28e`（main，2026-10-05 起点；分支 `feature/desktop-model-router-v1`）

## Final Commit

`51e1ba3` 之后：docs 提交（PROJECT_STATE 记录 + 本文件）为分支最后一个提交。
会话 2 应从**本分支最后一个 commit**开始（合并 main 后以 main HEAD 为准）。

## Goal

让 CetaMesh Desktop 在**不启动 QQ / SnowLuma / DSH** 的前提下，仅配置一个
Model Provider API Key 即可完成正常 Chat；正式分离 **Model Provider**（普通聊天）
与 **Agent Provider**（复杂工程任务）；Smart 从会话元数据升级为确定性路由 v1；
加入 Cost Policy。不重构 Agent Broker、Continuity、Workshop、Memory 等（属会话 2/3）。

## Completed Tasks

| Task | 内容 | 状态 |
| --- | --- | --- |
| TASK-S1-001 | ModelProvider 契约（id/label/listModels/chat/stream/abort/health）+ 注册表 + 服务 | 完成 |
| TASK-S1-002 | DeepSeek Official / OpenAI / OpenAI-compatible 三个 Provider（共享 OpenAI-compatible 实现，复用 `src/providers/secrets.js`） | 完成（真实 Key 调用待用户验收，见 Known Limitations） |
| TASK-S1-003 | Desktop Chat 双通道化：普通聊天 → Model Runtime；显式选择 Agent → Agent Provider；无 Key 配置时回落既有 DSH 通道 | 完成 |
| TASK-S1-004 | Standalone Chat 全路径（配置 Key → 新会话 → 选模型 → 发送 → 流式 → 停止 → 重试 → 历史持久化），DSH 零调用 | 完成（fixture 端到端；真机直连验收待 Key） |
| TASK-S1-005 | Smart Router v1（`src/router/`）：simple/tool/project 确定性分类 | 完成 |
| TASK-S1-006 | Cost Policy：economy/balanced/quality/agent-first，默认 balanced，持久化 | 完成（UI 展示属后续） |
| Desktop UI | Chat 页区分 Model 与 Agent：Agent（Auto/Disabled/DSH）+ Provider + 模型列表按通道切换 | 完成 |

## Architecture Decisions

1. **流事件协议复用**：Model Runtime 的流式协议 `model-stream-v1` 与 DSH
   `session/follow` 回合事件**同名同形**（turn/start / assistant/chunk(text-delta) /
   assistant/message / turn/end）。Chat 回合状态机（阶段 03，已被 11 组测试验证）
   对两条通道零改动复用。刻意不重造第二种格式。
2. **通道选择规则**（`chat-service.js` `startTurn`）：
   - `agentProvider` 显式设置（如 `'dsh'`）→ 整回合走 Agent Provider 契约（既有路径）。
   - 否则 Model Runtime 可用（会话 `modelProvider` 显式指定，或按 Key 配置自动解析出
     默认 Provider）→ Model Runtime 通道。
   - Model Runtime 不可用（无任何 Key 配置）→ 回落既有 DSH 直连通道（旧行为，兼容）。
   - `agentProvider='none'`（Disabled）→ 永不产生/执行 agent 路由。
3. **Smart 路由 v1 只记录不执行 agent**：mode=smart 时对每回合做确定性分类；
   project → `routing={class:'project', route:'agent', agentIntent:true,
   resolvedRoute:'model', fallbackReason:'agent-broker-not-available'}`，回合仍由
   Model 执行，routing 随 assistant 消息落盘。**会话 2 的 Agent Broker 应消费该意图**。
4. **默认模型解析**：会话 `model` 若仍等于 bridge 注入的 DSH 缺省模型（如
   `deepseek-flash`），Model 通道视为"未选择"，用 Provider 默认模型（DeepSeek
   `deepseek-chat`），避免把 DSH 内部模型 id 发给直连 API。
5. **IPC 家族命名**：Model Runtime 的私有方法族是 `modelrt.*`。控制面早已有
   `model.defaults.*` / `model.catalog.*`（DSH 模型管理，走 control.execute →
   controlService）；曾用 `model.*` 前缀导致 GUI 冒烟抓到 `modelRuntime is not
   defined` 碰撞（`model.defaults.get` 被新分流拦截），已改名修复。
6. **Key 纪律**：复用 `src/providers/secrets.js`（0600/原子写/损坏 fail-closed/掩码
   hint）。Key 只在每次调用时经 `secrets.raw()` 解析，不缓存；Provider 错误文本在
   源头 scrub（Key 字符串 → `***`）；catalog/列表/健康检查只输出 `hasKey` 布尔。
   未新建第二套 Secret Store。
7. **Reasoning 映射**：`off` → 不携带参数；`low/high/max` → `reasoning_effort`
   （max 映射为 OpenAI 语义上限 `high`）；DeepSeek 不携带该参数（reasoning 由
   `deepseek-reasoner` 模型区分）。
8. **DSH 模型重绑定守卫**：`chat.config.set` 改模型/强度时，只有会话仍在 DSH 通道
   （显式 Agent，或 Model Runtime 不可用）才立即 `session/selectModel`；Model 通道
   会话丢弃遗留 DSH 会话，模型下次回合生效。

## New Interfaces

### src/model/（Model Runtime）
```js
createModelProviderRegistry({ providers }) → { register, get, require, has, ids, list }
createModelRuntimeService({ registry, secrets, log }) → {
  resolveProvider(id|null),      // null → 第一个已配置 Key 的 Provider；无 → MODEL_PROVIDER_KEY_MISSING
  defaultProviderId(),           // 无 Key 配置返回 null
  listProviders(),               // [{id,label,hasKey}]（无 Key 材料）
  listModels(providerId|null),   // {provider, models, error}
  stream({ providerId, model, messages, reasoning, signal }),  // async generator，model-stream-v1
  chat(...), health(providerId),
  execute({method})              // modelrt.providers.list / modelrt.models.list / modelrt.health
}
createOpenAiCompatibleModelProvider({ id, label, baseUrl, defaultModel, secrets,
  fetchImpl, reasoningParam, supportsStreamOptions, log })
defineModelProvider({ id, label, defaultModel, methods })  // listModels/chat/stream 必须真实实现
```
错误码：`MODEL_PROVIDER_UNKNOWN / MODEL_PROVIDER_KEY_MISSING /
MODEL_PROVIDER_UNAVAILABLE / MODEL_PROVIDER_ERROR / MODEL_NO_MODEL`。

### src/router/（Smart Router v1）
```js
classifyTask({ text, attachments, hasWorkspaceContext, agentEnabled, costPolicy })
  → { class:'simple|tool|project', route:'model|agent', agentIntent, capabilityIntent,
      costPolicy, agentEnabled, signals, reasons }
createRouterService({ stateDir, log }) → {
  classify(params), currentPolicy(),
  execute({method})   // router.policy.get / router.policy.set / router.classify
}
```
Cost Policy 值：`economy / balanced / quality / agent-first`（默认 balanced），
持久化 `<stateDir>/router/policy.json`（损坏回落默认，不阻塞聊天）。

### chat.* 变更
- 会话 config 新增 `modelProvider`（string|null；null=自动）。
- `agentProvider` 取值：null（Auto）| `'none'`（Disabled）| 注册的 Agent Provider id。
- `chat.catalog` 返回新增 `modelProviders: [{id,label,hasKey,models,error}]` 与
  `defaultModelProvider`。
- `chat.status` 的 turn 新增 `routing`（Smart 路由决策，随 assistant 消息落盘）。
- 发送失败错误码新增 `MODEL_PROVIDER_KEY_MISSING` / `MODEL_PROVIDER_UNKNOWN` 等（原样透传）。

## Changed Files

- 新增：`src/model/`（types.js / model-provider.js / registry.js / service.js /
  index.js / providers/openai-compatible.js）、`src/router/`（types.js /
  smart-router.js / service.js / index.js）、`scripts/test-model-runtime.mjs`、
  `scripts/test-smart-router.mjs`、本文件。
- 修改：`src/desktop/chat-service.js`（双通道 + 路由 + 配置扩展）、
  `src/bridge.js`（modelRuntime/routerService/agent 接线 + dispatch）、
  `src/control/ipc-protocol.js`（白名单 +modelrt./router.）、
  `desktop-shell/src/chat_ui.rs`（config/catalog 解析扩展）、
  `desktop-shell/src/native_ui.rs`（Chat 页 Model/Agent 区分）、
  `scripts/test-desktop-chat-product.mjs`（11 → 17 组）、
  `package.json`（test-model-runtime / test-smart-router scripts）、`PROJECT_STATE.md`。

## Tests Run

| 测试 | 结果 |
| --- | --- |
| `node scripts/test-model-runtime.mjs`（新增） | **PASS（12 组）** |
| `node scripts/test-smart-router.mjs`（新增） | **PASS（9 组）** |
| `node scripts/test-desktop-chat-product.mjs`（11 旧 + 6 新） | **PASS（17 组）** |
| `npm run test-core-entry` | PASS |
| `npm run test-privilege` | PASS（24/24；运行中桥接端到端部分按惯例自动跳过） |
| `npm run test-dsh-integration` | PASS |
| `npm run desktop:check` | PASS（仅既有未使用字段警告） |
| `npm run desktop:test` | PASS（87/87，含新增 modelProviders 解析测试） |
| `npm run test-desktop-shell`（GUI 冒烟） | PASS（并抓出 model.* 前缀碰撞 bug，已修复复测） |
| `npm run self-test`（真实 DSH 链路） | PASS（DSH 侧回合 completed，回复"收到"） |
| `npm run test-architecture` | PASS（8 组红线） |
| `node scripts/test-ipc-protocol.mjs` | PASS |
| `npm run test-provider-secrets` | PASS（6/6） |
| `npm run test-model-selection` | PASS（7 组） |
| `npm run test-agent` | PASS（23 单元 + 真机段） |
| `node scripts/test-control-service.mjs` | PASS |
| `npm run test-system` | PASS（108 项） |
| `npm run test-task` / `test-memory` / `test-extension` / `test-mesh` | PASS（90/85/87/全） |
| `node scripts/test-continuity-rollover.mjs` | PASS（6 组） |
| `npm run test-desktop-supervisor` | PASS |
| 真实 DeepSeek API 直连回合（真机、需 Key） | **NOT_RUN_ENVIRONMENT**（本机 `state/provider-keys.json` 不存在；fixture 端到端已覆盖，待用户配置 Key 后人工验收） |
| Release 构建产物（build:release / RC 套件） | **NOT_RUN_ENVIRONMENT**（本会话未要求产出安装包；分支合并后按需构建） |

## Known Limitations

1. **agent-intent 不执行**（设计使然）：Smart 模式下 project 分类只记录 routing，
   回合仍由 Model 执行；自动启动 Agent 属会话 2（Agent Broker）。
2. **Cost Policy 无 UI**：`router.policy.get/set` 经 IPC 可用，Chat/设置页暂无入口。
3. **模型 id 命名空间不互通**：DSH 模型 id（如 `deepseek-flash`）与直连 API 模型 id
   （`deepseek-chat`）不同；切换 Agent 选择后需在模型下拉重选（下拉已按通道切换来源）。
4. **DeepSeek reasoning_content 不展示**：deepseek-reasoner 的思考增量被忽略（v1 只
   渲染最终文本）；思考期间 UI 静默直至首个 content 增量。
5. **history 携带上限**：Model 通道每回合最多携带最近 40 条正常终态消息（本地历史
   完整保留，只是不全部发给 API）。
6. 附件仍为文本拖拽（图片链路未接，与阶段 03 一致，非本阶段回退）。

## Known Risks

1. `classifyTask` 为关键词规则，存在误判/漏判边界（例如"项目"一词的语境依赖动作
   动词共现判定）。v1 接受该误差：误判 tool/project 都不会启动 DSH（route=agent
   只记录不执行），最坏影响是 routing 标注与未来 Agent Broker 的触发面。
2. OpenAI 兼容自定义端点兼容面不一（如不支持 `stream_options`）；已对自定义端点
   默认关闭该参数，但非标准 SSE 行为仍可能被忽略（解析器按行容错）。
3. `state/desktop-chat/sessions.json` 的旧记录无 `modelProvider` 字段——
   `normalizeRecord` 已归一化为 null（自动），无迁移脚本需求。
4. GUI 冒烟跑通的是编译自当前源码的 debug exe；发布 RC 需重新走 build:release +
   test-release-candidate（见 NOT_RUN）。

## Remaining Work（会话 2 入口）

1. **Agent Broker**：消费 chat 回合的 `routing.agentIntent`（assistant 消息已落盘
   `routing={class,route,resolvedRoute,agentIntent,capabilityIntent,costPolicy,
   fallbackReason,reasons}`）；把 project 意图升级为受控 Agent 执行，替换
   `fallbackReason:'agent-broker-not-available'` 语义。
2. Cost Policy UI（设置页或 Chat 页）+ 路由结果在消息流的可见标注（数据已就绪）。
3. Capability 网关消费 `capabilityIntent`（tool 类）。
4. 真实 Key 的 DeepSeek/OpenAI 直连人工验收（配置 `state/provider-keys.json` 即可）。
5. Reasoning 增量（reasoning_content）展示、图片附件等 Chat 体验项（低优先）。

## Required Entry State for Session 2

- 分支 `feature/desktop-model-router-v1` 合并 main 后的 HEAD（含本文件所述全部提交）。
- `node scripts/test-model-runtime.mjs` / `test-smart-router.mjs` /
  `test-desktop-chat-product.mjs` 三套全 PASS 为入口健康基线。
- 关键入口符号：
  - Chat 回合 routing 数据：`state/desktop-chat/history/<sessionId>.json` 中 assistant
    消息的 `routing` 字段（`agentIntent=true` 即待 Broker 消费的意图）。
  - Agent Provider 注册表：`src/agent/service.js` `createAgentService`（bridge 已把
    `agentService.listProviders()` 接入 chat）。
  - Router 服务：`src/router/service.js` `createRouterService`（bridge 持有
    `routerService` 实例，可注入 Broker）。
- 不需要任何数据迁移；`agentProvider='none'` 哨兵与 `modelProvider=null` 语义见上文。
