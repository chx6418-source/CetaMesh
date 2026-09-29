# CetaMesh Desktop — Codex / DSH 开发工作文档 v3.0

> **用途**：CetaMesh Desktop 的主施工文档，面向 Codex、DSH 及其他编码 Agent。
>
> **基线**：当前仓库仍是 `chx6418-source/whalebridge`，现有代码与安装产物仍大量使用 WhaleBridge 命名。
>
> **迁移策略**：不重写现有项目；保持现有 QQ / DSH / Desktop 能力可回归，在此基础上渐进演进为 CetaMesh。
>
> **产品方向**：Desktop 是完整 CetaMesh Node；QQ 是可选 Channel，DSH/Codex 是可选 Agent Provider，模型是 Model Provider，MCP 是 Capability Provider。
>
> **核心原则**
>
> 1. Tasks belong to CetaMesh, not to agents.
> 2. Memory belongs to CetaMesh, not to agents.
> 3. Sessions are disposable; progress is persistent.
> 4. Providers are replaceable; CetaMesh owns state, policy, memory and continuity.

---

## 0. Agent 必读施工规则

1. 开工前先读本文档、`RULES.md`、当前 `PROJECT_STATE.md`（若存在）和相关源码/测试。
2. 每次只处理一个 `TASK-ID`，除非任务明确要求批量变更。
3. 禁止全仓重写。
4. 禁止一次性 JS → TS。
5. 禁止一次性拆掉 `src/bridge.js`；只能按稳定边界渐进抽取。
6. 现有 QQ / DSH / Desktop 行为在对应迁移 Gate 通过前必须兼容。
7. 安全默认值只能保持或收紧，不得放宽。
8. 未知 Capability / Permission 默认拒绝。
9. Agent 不得绕过 Capability / Workspace / Permission 层直接访问主机能力。
10. Workshop 不得依赖 Prompt 限制文件访问，必须有硬隔离。
11. 测试失败不得标记 DONE。
12. 当前不做开源发布准备。
13. 当前不因品牌升级立即全仓 WhaleBridge → CetaMesh 改名。
14. 当前正式 Desktop Shell 是 Rust `eframe/egui`，不是 Tauri/WebView。
15. DSH 是 Agent Provider，不是 CetaMesh Core。
16. QQ/SnowLuma 是 Channel/Connector，不是 CetaMesh Core。
17. Agent Session 上下文接近上限时，优先执行 Continuity Runtime 的 Session Rollover，而不是依赖低质量压缩。

---

## 1. 当前仓库基线

### 1.1 技术栈

```text
Core:
  Node.js >= 22.13
  JavaScript / ESM
  DSH integration
  MCP
  SnowLuma / OneBot

Desktop:
  Rust
  eframe / egui

Desktop ↔ Core:
  Windows Named Pipe IPC

Distribution:
  esbuild
  Node SEA
  postject
```

### 1.2 当前重要代码

```text
src/bridge.js
src/core-entry.js
src/core-dispatch.js
src/core-sea.js
src/app-paths.js
src/bridge-privilege.js

src/control/
  control-service.js
  ipc-protocol.js

src/dsh-client.js
src/dsh-auth.js
src/dsh-integration.js

src/mcp-snowluma-safe.js
src/mcp-host-server.js
src/mcp-web-search-safe.js
src/mcp-qq-file-send.js
src/mcp-bilibili.js

desktop-shell/src/
  native_main.rs
  native_ui.rs
  supervisor.rs
  ipc_client.rs
  core_launch.rs
  installer.rs
  migrate.rs
```

`src/bridge.js` 当前仍是大型核心文件，只允许渐进拆分。

### 1.3 安全默认值

以下属于兼容红线：

```text
allowAllWhenEmpty = false
snowluma.allowProcessControl = false
socialV2.tools.clickCardButton = false
```

同时保持：

- 服务令牌不能获得控制台全权。
- QQ Agent 默认无本地 Shell / 文件工具。
- 高风险卡片动作必须审批。
- Web Fetch 保持 SSRF 防护。
- 配置损坏 fail-closed。
- 未知权限 / Capability 默认拒绝。

---

## 2. 目标架构

```text
                            CetaMesh Desktop
                                  │
          ┌───────────────────────┼──────────────────────┐
          │                       │                      │
         Chat                    Work                  Social
          │                       │                      │
          └──────────────┬────────┴─────────────┬────────┘
                         │                      │
                    Session Runtime        Channel Runtime
                         │                      │
                         └──────────┬───────────┘
                                    │
                               Task Router
                                    │
                   ┌────────────────┼───────────────┐
                   │                │               │
              Model Runtime    Capability Runtime  Agent Broker
                   │                │               │
              Model Provider    Tools / MCP     Agent Provider
                   │                │               │
                   └──────────┬─────┴───────┬──────┘
                              │             │
                         Policy Engine   Continuity Runtime
                              │             │
                         Workspace      Task / Checkpoint
                              │             │
                              └──────┬──────┘
                                     │
                                Memory Runtime
                                     │
                                CetaMesh Core
```

Foundation 只稳定承担：

```text
Identity
Event
Task
Capability
Permission
Workspace
Memory
State
Protocol
Lifecycle
```

Foundation 不写死：

```text
QQ
SnowLuma
DSH
Codex
特定模型
特定插件
特定 UI
```

---

## 3. Desktop 页面结构

目标一级导航：

```text
Home
Chat
Work
Social
Agents
Plugins
Memory
Workspaces
Devices
Connections
Security
Settings
```

### Chat

负责会话级选择：

```text
Mode
Model
Reasoning
Agent Escalation
Attachments
Tools
```

### Settings

只负责：

```text
General
Models
Agent Providers
Channels
Storage
Memory
Security
Network
Appearance
Updates
Developer
```

聊天页与设置页必须分开。

---

## 4. 模式重构

旧模式：

```text
chat
closed-agent
reserved
reserved2
```

目标：

```text
smart
chat
social
owner-agent
workshop
```

迁移：

```text
chat         → chat
reserved2    → social
closed-agent → owner-agent
reserved     → social（迁移兼容后废弃）
```

### Smart

```text
Simple → Model
Medium → Model + Tool
Complex → Professional Agent
```

### Chat

普通模型聊天与轻量工具。

### Social

原 reserved2 的正式产品化方向。QQ/Telegram/Discord 等均应作为 Channel Adapter。

### Owner Agent

Owner 专属复杂工作。

### Workshop

允许其他用户提出项目，Owner 审批后在严格 Workspace Sandbox 内开发。

---

## 5. Model Provider 与 Agent Provider 分离

### Model Provider

用于低成本任务：

```text
聊天
翻译
总结
问答
简单分析
简单工具调用
```

目标接口：

```ts
interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}
```

### Agent Provider

用于：

```text
代码修改
MCP 开发
插件开发
Git
测试
大型项目
长任务
```

目标接口：

```ts
interface AgentProvider {
  createTask(request): Promise<AgentTaskHandle>;
  resumeTask(request): Promise<AgentTaskHandle>;
  pauseTask(taskId): Promise<void>;
  cancelTask(taskId): Promise<void>;
  getProgress(taskId): Promise<AgentProgress>;
  exportCheckpoint(taskId): Promise<ProviderCheckpoint>;
  importCheckpoint(checkpoint): Promise<AgentTaskHandle>;
}
```

DSH / Codex 均是 Agent Provider。

---

## 6. Task Router

判断维度：

```text
是否写文件
是否需要 Shell
是否需要 Git
是否需要测试
是否多步骤
是否长时间
上下文规模
风险
成本
用户明确指定
```

路由：

```text
Simple
→ Model Runtime

Tool Task
→ Model + Capability

Project Task
→ Agent Broker
```

成本策略：

```text
Economy
Balanced
Quality
Agent First
```

默认推荐 `Balanced`。

---

## 7. Workspace Runtime

Workspace 是复杂工作硬边界。

```text
Workspace
├── root
├── owner
├── allowedCapabilities
├── taskIds
├── memoryScope
├── artifacts
└── policy
```

所有：

```text
filesystem.read
filesystem.write
shell.execute
git.*
```

必须经过 Workspace Broker。

Workshop 只允许 Workspace Root 内操作；其它 Workspace、Desktop、Documents、Downloads、用户凭据、CetaMesh 全局配置、SSH、浏览器 Profile、系统敏感路径默认拒绝。

Prompt 不是安全边界。

---

## 8. Memory Runtime

正式类型：

```text
Working Memory
Chat Memory
Task Memory
Workspace Memory
User Memory
Social Memory
Knowledge Memory
Skill Memory
Memory Pack
```

组件：

```text
Memory Store
Memory Index
Memory Graph
Memory Policy
Memory Resolver
Memory Consolidator
```

### Memory Link

支持：

```text
“A群之前那个权限方案”
“B项目之前做过类似实现”
“上次安装器那个问题”
```

流程：

```text
Reference
↓
Entity Resolution
↓
Scope + Time + Topic Search
↓
Memory Graph
↓
Source Verification
↓
Context Package
```

### Long-Term Memory

```text
Observation
↓
Candidate
↓
Reinforced
↓
Long-Term
↓
Archived / Superseded
```

Memory 必须有来源、Scope、置信度和版本。

### Memory Pack

目标格式：

```text
.cetamemory
```

采用：

```text
Base Memory
+
User Overlay
```

第三方 Memory Pack 默认：

```text
NO CODE
NO SHELL
NO NETWORK
NO SYSTEM INSTRUCTION
```

---

## 9. Plugin / Tool Lab

目标页面：

```text
Installed
Local
Develop
Import
Security Review
```

Chat 快捷入口：

```text
Create Tool
Create Plugin
```

简单工具优先 Tool Builder；复杂插件才升级到 Professional Agent。

安全链：

```text
Import
↓
Manifest Validation
↓
Hash
↓
Secret Scan
↓
Dependency Scan
↓
Permission Scan
↓
Static Analysis
↓
Sandbox Test
↓
Security Report
↓
Install
```

Marketplace 以后复用同一供应链。

---

## 10. Continuity Runtime

详细规范：

```text
docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
```

必须解决：

```text
Session Rollover
Agent Handoff
Provider Handoff
Process / Device Recovery
```

核心规则：

> 当 Agent 上下文接近上限时，不默认依赖该 Agent 自己的低质量压缩；在安全切换点生成结构化 Checkpoint，归档旧 Session，创建 Fresh Session，再从 Task + Workspace + Memory 恢复继续。

默认建议：

```text
0–70%    normal
70–78%   prepare checkpoint
78–85%   checkpoint ready
85–90%   preferred rollover
90–92%   forced safe rollover
92%+     emergency rollover
```

Provider 可覆盖。

复杂 Project/Coding 默认：

```text
prefer-new-session
```

普通 Chat 可：

```text
compression-first / hybrid
```

---

## 11. Checkpoint

Checkpoint 必须结构化，不得只是一段摘要。

至少包含：

```yaml
task:
  id: TASK-...
  goal: ...
  acceptance: []

phase:
  current: ...
  completed: []

work:
  current_objective: ...
  next_action: ...

workspace:
  root: ...
  git_head: ...
  dirty_files: []

tests:
  passed: []
  failed: []

decisions: []
blockers: []
artifacts: []
memory_refs: []
pending_questions: []

session:
  provider: ...
  session_id: ...
  rollover_reason: context_pressure
```

新 Session 必须重新读取真实 Workspace 并对账：

```text
git status
git diff
关键文件
测试
build config
```

原则：

> Checkpoint 说明上一班认为发生了什么；Workspace 说明实际上发生了什么。

---

## 12. Session Bootstrap

Fresh Session 输入层：

```text
L0 System / Security
L1 Task Goal + Acceptance
L2 Current Checkpoint
L3 Workspace Facts
L4 Memory References
L5 Minimal Recent Context
```

不把旧 Session 全量历史复制过去。

---

## 13. Work 页 Continuity 信息

目标：

```text
Task: Plugin Runtime
Agent: DSH
Session: #04

Context:
███████████████░░ 82%

Strategy:
New Session

Checkpoint:
Ready

[Create Checkpoint]
[Start New Session]
[Switch Agent]
```

Task 是主体，Session 是 Task 子资源。

---

## 14. Desktop 与 Mobile 双轨

Desktop 和 Mobile 各自独立 Roadmap，互不阻塞。

通过这些协议汇合：

```text
Identity
Task
Memory
Capability
Event
Device
Approval
```

Desktop 更偏：

```text
Agent
Workspace
Development
MCP
Plugin Lab
Workshop
```

Mobile 更偏：

```text
Standalone Chat
Memory
Approval
Task Control
Camera
Microphone
Share
Mobile Capabilities
```

---

# 15. Desktop Roadmap

```text
D0 Legacy Baseline
D1 Foundation
D2 Standalone Chat
D3 Memory Runtime
D4 Smart Router
D5 Agent Provider
D6 Continuity Runtime
D7 Social
D8 Workshop
D9 Plugin / Tool Lab
D10 Private RC
```

---

## D0 — Legacy Baseline

### TASK-D0-001 — Baseline Inventory

记录：

```text
startup
QQ
DSH
MCP
Desktop
Core SEA
Installer
Security Defaults
Tests
```

**Acceptance**

- [ ] 当前入口有记录
- [ ] 关键配置有记录
- [ ] 安全默认值有记录
- [ ] 当前正式 Desktop 架构有记录

### TASK-D0-002 — Baseline Test Matrix

优先运行：

```text
npm run self-test
npm run test-privilege
npm run test-core-entry
npm run test-dsh-integration
npm run desktop:check
npm run desktop:test
```

环境允许时继续：

```text
npm run test-desktop-supervisor
npm run test-desktop-shell
npm run test-desktop-install
npm run test-core-dist
npm run test-release-candidate
```

**Gate D0**

- 当前基线可重现。
- 安全红线有快照。
- 未运行项明确标注，不能冒充 PASS。

---

## D1 — Foundation

### TASK-D1-001 — Unified Config Service

目标：

```text
src/config/
  schema.js
  loader.js
  migrate.js
  service.js
```

要求：

- 使用已有 Zod。
- 旧 config 有 Migration。
- 安全默认不改变。
- 配置损坏 fail-closed。

验证：

```text
npm run test-core-entry
npm run test-privilege
npm run self-test
```

### TASK-D1-002 — Named Pipe Security Audit

要求：

- 当前用户 SID / ACL 明确。
- 未授权用户拒绝。
- 协议版本错误、超大帧、超时拒绝。
- 加自动测试。

### TASK-D1-003 — Trace / Error Envelope

统一：

```text
traceId
taskId
sessionId
eventId
error.code
error.message
```

### TASK-D1-004 — Capability Registry v1

先建立：

```text
register
list
describe
invoke
```

未知 Capability 默认拒绝。

### TASK-D1-005 — Permission Engine v1

表达：

```text
caller
capability
scope
workspace
risk
decision
```

### TASK-D1-006 — Workspace Model v1

建立 Workspace ID / Root / Policy。

### TASK-D1-007 — Task Runtime v1

Task 不绑定 DSH Session。

最小字段：

```text
id
goal
status
phase
progress
workspaceId
providerId?
createdAt
updatedAt
```

### TASK-D1-008 — Incremental Bridge Extraction

只抽明确稳定边界；每个抽取任务先有回归测试。

**Gate D1**

- Config 统一入口。
- Pipe Security 审计完成。
- Capability / Permission / Workspace / Task 基础类型可用。
- QQ / DSH 无回退。

---

## D2 — Standalone Chat

目标：

> Fresh Windows 不安装 QQ、SnowLuma、DSH，仅配置模型 API 就能正常使用 CetaMesh Chat。

### TASK-D2-001 — Model Provider API
### TASK-D2-002 — Provider Credential Storage
### TASK-D2-003 — Chat Session Store
### TASK-D2-004 — Desktop Chat UI
### TASK-D2-005 — Attachments v1

**Gate D2**

必须证明：

```text
NO QQ
NO SnowLuma
NO DSH
```

仍可：

- 启动
- 配模型
- 多轮 Chat
- Streaming
- 保存 Session
- 重启恢复

---

## D3 — Memory Runtime

### TASK-D3-001 — Memory Schema v1
### TASK-D3-002 — Memory Store
### TASK-D3-003 — Memory Policy
### TASK-D3-004 — Memory Search
### TASK-D3-005 — Memory Link / Resolver
### TASK-D3-006 — Long-Term Consolidation
### TASK-D3-007 — Memory UI

**Gate D3**

- Memory 类型可管理。
- 用户能看到系统记住了什么。
- Scope 有效。
- 来源可追溯。
- Memory Link 能向 Task 提供 Context Package。

---

## D4 — Smart Router

### TASK-D4-001 — Complexity Classifier
### TASK-D4-002 — Cost Policy
### TASK-D4-003 — Routing Policy

**Gate D4**

- 普通聊天不调用 DSH。
- 简单工具任务不启动 Professional Agent。
- 复杂任务可升级 Agent。
- 用户可手工覆盖路由。

---

## D5 — Agent Provider

### TASK-D5-001 — Agent Provider Interface
### TASK-D5-002 — DSH Adapter
### TASK-D5-003 — Agent Task Mapping
### TASK-D5-004 — Work UI

必须明确：

```text
CetaMesh Task ≠ DSH Session
```

一个 Task 可以拥有多个 Provider Session。

**Gate D5**

- DSH 是可选 Provider。
- 无 DSH 时 Standalone Chat 不受影响。
- Task State 归 CetaMesh。

---

## D6 — Continuity Runtime

### TASK-D6-001 — Context Monitor

跟踪：

```text
provider
model
window
used
ratio
estimatedRemaining
```

Provider 无精确 Token 数据时允许估计，但必须标记 estimated。

### TASK-D6-002 — Context Policy

```text
automatic
prefer-new-session
prefer-compression
manual
```

Project/Coding 默认 prefer-new-session。

### TASK-D6-003 — Checkpoint Schema
### TASK-D6-004 — Checkpoint Builder
### TASK-D6-005 — Rollover Trigger
### TASK-D6-006 — Safe Rollover Point
### TASK-D6-007 — Session Archive
### TASK-D6-008 — New Session Bootstrap
### TASK-D6-009 — Workspace Reconciliation
### TASK-D6-010 — Same Provider Rollover
### TASK-D6-011 — Cross Provider Handoff
### TASK-D6-012 — Recovery
### TASK-D6-013 — Work UI Context Controls
### TASK-D6-014 — Continuity Tests

最低测试：

1. 70% 不切换。
2. Preferred threshold 生成 Checkpoint。
3. Safe point 执行 Rollover。
4. 新 Session 恢复 Task。
5. Workspace 差异被发现。
6. Checkpoint 损坏 fail-safe。
7. Agent A → Agent B。
8. 旧 Session 可追溯。
9. 用户手工触发。
10. 自动策略可关闭。

**Gate D6 — Continuity Alpha**

完成真实长任务：

```text
Session #1
→ Context threshold
→ Checkpoint
→ Session #2
→ Continue
→ Tests
```

且：

- 用户无需复制上下文。
- Task ID 不变。
- Workspace 不变。
- Progress 不丢。
- 决策和测试记录可追溯。

---

## D7 — Social

### TASK-D7-001 — Mode Migration

```text
reserved2 → social
reserved → deprecated
closed-agent → owner-agent
```

### TASK-D7-002 — Channel Abstraction
### TASK-D7-003 — Social Memory

**Gate D7**

- Social 不使用 reserved2 产品名称。
- QQ 功能无回退。
- Channel Boundary 清晰。
- Social Memory Scope 生效。

---

## D8 — Workshop

### TASK-D8-001 — Proposal
### TASK-D8-002 — Owner Approval
### TASK-D8-003 — Workspace Creation
### TASK-D8-004 — Sandbox Enforcement
### TASK-D8-005 — Artifact Delivery

**Gate D8**

```text
Non-owner idea
→ Proposal
→ Owner approve
→ Workspace
→ Agent
→ Test
→ Artifact
→ Owner approve
→ Deliver
```

越权访问必须硬拒绝。

---

## D9 — Plugin / Tool Lab

### TASK-D9-001 — Tool Builder
### TASK-D9-002 — Plugin Manifest v1
### TASK-D9-003 — Import Pipeline
### TASK-D9-004 — Local Install Lifecycle
### TASK-D9-005 — Memory Pack

生命周期：

```text
install
enable
disable
update
remove
rollback
```

**Gate D9**

- 本地导入可审计。
- 权限明确。
- 未知权限 deny。
- 更新新增权限需重新确认。
- Memory Pack 无代码执行。

---

## D10 — Private RC

重点：

```text
Installer
Upgrade
Uninstall
Recovery
Code Signing
Performance
Backup
Migration
Real Machine Acceptance
```

至少验证：

```text
Win10
Win11
中文用户名
非管理员
干净安装
升级
卸载
数据保留
```

只有 D10 后再考虑：

```text
Open-source readiness
Public Marketplace
Public plugin ecosystem
```

---

## 16. 当前明确不做

```text
全仓重写
全量 TS 迁移
立即公开仓库
Kubernetes
Cloud 优先
Marketplace 优先
Mobile 阻塞 Desktop
Desktop 阻塞 Mobile
QQ 继续成为 Core
DSH 继续成为 Core
任意插件直接 import Core
Agent unrestricted host access
```

---

## 17. PROJECT_STATE 建议

```yaml
project: CetaMesh Desktop
repository: chx6418-source/whalebridge
current_phase: D0
current_gate: D0
release_strategy: private-first

active_tasks:
  - TASK-D0-001

blocked_tasks: []
completed_tasks: []

continuity:
  current_task: null
  current_session: null
  checkpoint: null
```

---

## 18. Agent 每次工作流程

```text
1. Read workplan
2. Read PROJECT_STATE
3. Read relevant current code
4. Select first unblocked TASK
5. Record IN_PROGRESS
6. Implement only task scope
7. Run required tests
8. Fix failures
9. Update docs if interface changed
10. Update PROJECT_STATE
11. Mark DONE only with verification
```

### Session 快满时的强制流程

```text
Context Monitor detects threshold
↓
Stop accepting unrelated new subtask
↓
Finish current atomic operation
↓
Build Checkpoint
↓
Validate Checkpoint
↓
Reconcile Workspace
↓
Archive Session
↓
Create Fresh Session
↓
Bootstrap Fresh Session
↓
Re-read actual Workspace
↓
Continue same Task
```

禁止把“让 Agent 自己压缩一下继续旧 Session”作为复杂长任务的默认策略。

---

## 19. 近期优先顺序

```text
D0 Baseline
↓
D1 Foundation
↓
D2 Standalone Chat
↓
D3 Memory
```

目前不要优先做：

```text
Marketplace
Cloud
完整跨端联动
Multi-Agent 编排
```

Mobile 已有独立 Track，可并行开发。

---

## 20. Codex 首次指令

> 阅读 `docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md`、`RULES.md`、`docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md` 和当前 `PROJECT_STATE.md`。从第一个满足依赖的 TODO 开始，每次只处理一个 TASK-ID。当前代码是 WhaleBridge → CetaMesh 的渐进迁移，不做全仓重写或全仓改名。DSH/QQ 都是可选 Provider/Channel，不得继续强化为 Core 依赖。长任务上下文接近阈值时，创建结构化 Checkpoint 并切换 Fresh Session，不依赖低质量上下文压缩。完成任务后运行规定测试并更新状态，测试失败不得标记 DONE。

---

## 21. 最终目标

```text
CetaMesh Desktop Node
│
├── Standalone Chat
├── Task Runtime
├── Memory Runtime
├── Capability Runtime
├── Workspace Runtime
├── Agent Broker
├── Continuity Runtime
├── Social
├── Workshop
├── Plugin / Tool Lab
└── Device Mesh
```

当前 WhaleBridge 功能逐步重新归类：

```text
QQ → Channel
DSH → Agent Provider
MCP → Capability Provider
SnowLuma → QQ Connector
Desktop Shell → CetaMesh Desktop
Memory → Memory Runtime
Approval → Permission / Task
```

这就是 Desktop 从当前基线演进到 CetaMesh 的正式施工方向。
