# CetaMesh Desktop — PROJECT_STATE

> 状态日期：2026-10-03  
> 仓库：`chx6418-source/whalebridge`  
> 产品名称：`CetaMesh`  
> 当前基线：`main@09d2758c663e353c30e1bf4a605c914ccd3fdc87`  
> 范围：**Desktop / Windows only**。Mobile 已独立到 `chx6418-source/cetamesh-mobile`，本文件不记录 Mobile 具体实现。

---

## 0. 本文件用途

这是 CetaMesh Desktop 当前阶段的项目状态事实表，用于让后续 Agent / DSH / Codex / 开发者快速判断：

- 什么已经真正落到代码；
- 什么只有部分能力；
- 什么目前仅存在于设计文档；
- 哪些旧 WhaleBridge 机制仍在运行但不再代表最终产品方向；
- 下一步可以做什么；
- 当前明确**不做什么**。

本文件优先描述“当前仓库真实状态”，不把 roadmap、历史对话或架构愿景当作已完成功能。

### 事实来源优先级

当信息冲突时，按以下顺序判断：

1. 当前 `main` 中的实际代码；
2. 当前 `main` 中的自动化测试；
3. 当前正式文档；
4. `AGENT_CONTEXT.md` / 历史工作文档；
5. 旧 roadmap / 旧讨论。

项目真实状态以 **Git / 文件 / Tests / Build / Artifact** 为准，而不是 Agent 自述。

---

## 1. 当前总状态

CetaMesh Desktop 已经拥有较完整的 **Windows 原生运行、Core、安装、IPC、安全与旧 WhaleBridge/QQ 集成基础设施**。

但新的 CetaMesh 产品层：

```text
Chat
Tasks
Memory
Workspace
Agent Provider
Context Rollover
Agent Handoff
Device Mesh
```

仍处于“不完整、部分存在或仅文档规划”的状态。

因此当前 Desktop 不能描述为“CetaMesh 完整桌面产品已经完成”。

更准确的状态是：

```text
Windows Desktop 基础设施          已有较多实现
WhaleBridge / QQ / DSH 旧能力     已有较多实现
CetaMesh 新产品信息架构           未完成
Persistent Task                  未实现
通用 Workspace 安全边界           未实现完整产品闭环
通用 Memory                      未实现
统一 Agent Provider              未实现
Context Rollover Runtime         未实现
跨 Agent Handoff Runtime         未实现
```

---

## 2. 产品与仓库身份

### 已确定

- 产品名：`CetaMesh`
- 当前仓库名仍为：`whalebridge`
- 目标平台：Windows
- 主要技术栈：
  - JavaScript / TypeScript
  - Rust Desktop Shell
  - 云端模型 / Agent API
- 当前阶段不优先开源。
- 先完善产品、真机测试和真实闭环，再考虑公开生态。

### 旧名称 / 旧定位

历史名称：

- WhaleBridge
- Cetora
- WhaleMesh

旧定位曾以 QQ Bridge / 仿生聊天 / DSH + SnowLuma 控制台为中心。

这些历史能力可以继续复用，但不能再决定 CetaMesh 的核心架构。

---

## 3. 当前架构原则

### 3.1 CetaMesh Core 不绑定 QQ

QQ、Telegram、Discord、微信等应属于：

```text
Channel Adapter
```

而不是 CetaMesh Core 的入口。

### 3.2 Desktop 与 Mobile 独立

```text
CetaMesh Desktop
CetaMesh Mobile
```

是两个独立产品线 / Node。

未来可以通过 Device Mesh、Task Sync、Memory Sync、Capability 连接，但 Desktop 不依赖 Mobile，Mobile 也不是 Desktop Remote Controller。

### 3.3 Task 不等于 Agent Session

长期原则：

```text
A Task may outlive every session that worked on it.
```

目标关系：

```text
CetaMesh Task
  ├─ Agent Provider A
  │    └─ Session A1
  ├─ Agent Provider B
  │    └─ Session B1
  └─ ...
```

**注意：该原则当前主要存在于架构规划，Persistent Task Runtime 尚未实现。**

### 3.4 Workspace 是项目安全边界

长期原则：

```text
Workspace 内
→ 按 Capability + Approval 访问

Workspace 外
→ 默认禁止
```

不允许 Agent 默认获得整机文件、系统凭据、浏览器数据或任意 Shell 权限。

**注意：当前仓库还没有完成这一通用 Workspace 产品闭环。**

### 3.5 Memory 先授权，再检索

长期原则：

```text
Memory retrieval is an authorization decision
before it is a ranking problem.
```

### 3.6 Workspace reality outranks agent narrative

代码项目的真实状态优先由以下事实确定：

```text
文件
Git
Test
Build
Artifact
```

---

## 4. 已实现：Windows Desktop 基础设施

以下能力已经能在当前仓库代码中找到实际实现，而不是单纯 roadmap。

### 4.1 原生 Desktop Shell

当前 Desktop 已经从早期 Web 控制台方向迁移到 Windows 原生壳。

现有：

- Rust 桌面壳；
- 原生 `eframe/egui` UI；
- Core worker 生命周期管理；
- 单实例 / 进程监管；
- 崩溃后的退避重启；
- Desktop 与 Core 的 IPC；
- 安装 / 修复 / 迁移 / 卸载基础。

主要目录：

```text
desktop-shell/
src/core-entry.js
src/core-dispatch.js
src/control/
```

### 4.2 Core 打包

已有 Node SEA / bundle 相关构建链。

目标是不要求普通用户预装 Node.js。

相关脚本包括：

```text
npm run build:core
npm run desktop:build
npm run build:release
npm run test-release-candidate
```

### 4.3 Desktop ↔ Core IPC

当前已有命名管道 / 控制服务方向的实现。

管理面不应继续依赖旧 Web 控制台 HTTP token。

已有 ControlService 方法注册与固定字段投影。

### 4.4 安装与生命周期

已有：

- install
- repair
- migrate
- uninstall
- remove-data
- DSH integration setup / uninstall
- 安装归属记录
- 用户数据保留策略

### 4.5 DSH / SnowLuma 本地服务管理

已有：

- 本地服务探测；
- SnowLuma / DSH 启停；
- 路径 / 版本选择；
- 服务状态；
- DSH integration。

### 4.6 模型 / Preset / Session 管理基础

已有：

- 模型目录相关能力；
- 默认模型；
- DSH Agent Preset；
- Preset binding；
- Session 列表；
- Session phase 等既有管理能力。

注意：这些能力目前不等于新的 CetaMesh Chat / Task / Agent Provider 产品层。

---

## 5. 已实现：安全基础

### 5.1 双令牌模型

旧 Bridge 已有：

```text
console token
agent/service token
```

分离。

Agent 服务令牌只能访问收敛的数据面白名单，不能自动升级成控制面权限。

### 5.2 QQ Agent 工具收敛

旧 QQ Agent 模式已有较严格的工具和发送目标限制。

### 5.3 风险操作审批基础

现有 Desktop / Core 已有：

- pending queue；
- approval / question；
- 风险卡片审批；
- allow / reject 类能力。

这些可以为未来 CetaMesh Workspace / Agent Approval 复用，但目前还不是完整的通用 Agent 文件/命令审批系统。

---

## 6. Chat 当前状态

### 状态：**部分实现 / 产品层未完成**

已有底层：

- DSH Session；
- 模型与 Preset；
- QQ 会话；
- Session 列表与状态；
- 模型 / Agent 服务连接基础。

缺少新的 Desktop 独立 Chat 产品闭环，例如：

- 正式消息时间线；
- Composer；
- 会话创建 / 切换的成熟 UI；
- Chat 内模型切换；
- Chat / Agent 模式切换；
- Memory 注入；
- Tool 状态 UI；
- Attachment 产品体验；
- 与 Persistent Task 的明确关系。

结论：

```text
当前有“会话和模型基础”，
但还不能把它当作新的 CetaMesh Desktop Chat 已完成。
```

---

## 7. Tasks 当前状态

### 状态：**Persistent Task 尚未实现**

当前代码中存在一些内部 service task / async task 概念，但它们不是 CetaMesh Persistent Task。

当前没有完成统一的 Task 数据模型，例如：

```text
Task ID
Goal
Requirements
Status
Current Phase
Progress
Completed Work
Pending Work
Workspace
Artifacts
Decisions
Checkpoint
Acceptance Criteria
Agent History
```

也没有完成：

```text
Task 生命周期独立于 Agent Session
```

的 Runtime。

### 当前明确决定

> **现在先不开始 Persistent Task v1 构建。**

在用户明确重新启动该工作之前：

- 不创建 Task Runtime；
- 不创建 Task DB schema；
- 不重写现有 Session；
- 不引入 Multi-Agent Scheduler；
- 不因为 roadmap 已存在就自动施工。

---

## 8. Memory 当前状态

### 状态：**存在旧 QQ/social memory；通用 CetaMesh Memory 未实现**

已有旧能力包括：

```text
qq_memory_append
qq_memory_query
qq_memory_remove
qq_memory_clear
```

这些主要属于 QQ / socialV2 范围。

尚未完成统一 CetaMesh Memory：

```text
工作记忆
聊天记忆
长期记忆
项目记忆
人物记忆
群聊记忆
插件记忆
```

也尚未完成统一：

- Scope；
- Authorization；
- Task / Workspace 关联；
- Entity / Relation；
- Memory Association；
- Memory Pack / .cetamemory。

前期不要直接建设完整 Knowledge Graph。

---

## 9. Workspace 当前状态

### 状态：**存在 DSH workspace 相关能力，但通用 Workspace 安全产品未完成**

现有代码和 DSH API 中存在 `workspace/*` 能力。

但当前还没有完成统一 CetaMesh Workspace：

```text
Owner 创建 / 选择 Workspace
↓
明确根目录
↓
所有 Agent 文件访问在根目录内解析
↓
越界访问默认拒绝
↓
高风险操作进入审批
↓
Task / Agent Session / Artifact 均引用 Workspace ID
```

因此现在不能把 DSH workspace 直接等同于最终 CetaMesh Workspace。

---

## 10. Agent Provider 当前状态

### 状态：**DSH 集成存在；统一 AgentProvider 抽象未实现**

当前已经有较深的 DSH 集成。

`src/dsh-client.js` 已知 DSH API 能力包括：

```text
session/create
prompt
selectModel
list
cancel
follow
workspace/create
workspace/rename
workspace/delete
...
```

但还没有统一的 CetaMesh Agent Provider 接口，例如：

```text
createSession
send
cancel
status
contextUsage
checkpoint
resume
handoff
capabilities
```

所以当前关系更接近：

```text
CetaMesh / WhaleBridge
   ↓
DSH integration
```

而不是：

```text
CetaMesh
   ↓
AgentProvider
   ├─ DSH
   ├─ Codex
   ├─ Claude Code
   └─ ...
```

---

## 11. Context Rollover 当前状态

### 状态：**架构文档已存在；Runtime 未实现**

已有正式规划：

```text
docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
```

目标流程：

```text
上下文接近阈值
↓
完成当前原子步骤
↓
Checkpoint
↓
Handoff Summary
↓
新 Session
↓
继续同一个 Task
```

但当前代码搜索未发现完整产品 Runtime。

因此：

```text
Context Rollover = planned, not implemented
```

不能在产品状态中标记为完成。

---

## 12. Agent Handoff 当前状态

### 状态：**架构规划存在；Runtime 未实现**

目标 Handoff Packet 应至少能描述：

```text
Task ID
Goal
Current Phase
Completed
Pending
Important Decisions
Known Problems
Relevant Files
Modified Files
Git State
Tests
Artifacts
Memory References
Next Action
Acceptance Criteria
```

代码项目还应包含：

```text
Branch
Commit SHA
Uncommitted Changes
Build Status
Test Status
Known Failures
```

当前没有完整落地。

---

## 13. 旧运行模式状态

当前代码仍明确存在：

```text
chat
closed-agent
reserved
reserved2
```

主要可在以下位置看到：

```text
src/control/control-service.js
desktop-shell/src/native_ui.rs
RULES.md
```

### 新方向

已确定：

- `reserved`：未来删除；
- `reserved2`：未来重命名，不作为最终产品术语；
- `closed-agent`：未来应按受控场景重新拆分；
- 不应让旧模式体系决定新的 CetaMesh 产品架构。

### 当前处理原则

暂不因为命名旧就立即大规模重写。

等新的 Chat / Task / Workspace / Agent Provider 边界明确后，再做迁移，降低回归风险。

---

## 14. Plugin 当前状态

### 已有

仓库已有：

```text
plugins/
MCP integrations
DSH plugin/preset integration
```

### 尚未完成

新的通用 CetaMesh Plugin Runtime / Registry / Marketplace 尚未完成。

当前阶段不要建设大型 Marketplace。

优先方向仍应是：

```text
Local Import
Manifest
Permission Review
Enable / Disable
Security Boundary
```

---

## 15. Channel / QQ 当前状态

QQ 已有较丰富历史能力，包括：

- OneBot / SnowLuma；
- 群聊 / 私聊；
- 卡片；
- 图片；
- 文件 / Sticker 等部分能力；
- socialV2；
- 安全发送白名单；
- Agent safe MCP。

但新的架构定位必须保持：

```text
QQ = Channel Adapter
```

而不是：

```text
QQ = CetaMesh Core
```

未来 Telegram / Discord / 微信等也应遵循 Adapter 模式。

---

## 16. UI 当前状态

当前原生 Desktop UI 已能承载不少管理功能，但整体仍偏：

```text
运行管理 / 配置 / WhaleBridge 控制台迁移
```

而不是最终：

```text
Chat
Tasks
Memory
Workspace
```

产品信息架构。

曾经存在的十主题、Logo 等视觉任务不应优先于产品闭环。

Logo 当前不继续设计。

---

## 17. 文档状态

### 当前正式 / 有价值文档

```text
docs/DESKTOP_APP.md
docs/DESKTOP_ACCEPTANCE.md
docs/DSH_SETUP.md
docs/PROJECT_GUIDE.md
docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md
```

### 历史文档

`AGENT_CONTEXT.md` 包含大量真实历史实施细节，仍有参考价值。

但它原本定义自己为“多智能体协作唯一事实源”，这个定位已经过时。

从本文件建立后：

```text
PROJECT_STATE.md
= 当前 Desktop 状态入口

AGENT_CONTEXT.md
= WhaleBridge 历史实现与旧 UI / QQ 细节资料
```

### Mobile 文档

仓库中仍存在旧：

```text
docs/roadmap/CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md
```

它属于历史时期 Desktop/Mobile 共仓的遗留文档。

当前 Mobile 已独立，不应继续在 Desktop 仓库中更新 Mobile 实现内容。

是否后续迁移 / 删除该历史文档，需要单独决策。

---

## 18. 已知验证边界

正式 Desktop 文档记录了大量自动化测试和隔离 release candidate 验证。

这些记录证明很多基础设施曾经通过测试，但不能自动等同于：

- 当前所有真机环境都通过；
- Windows 10 / Windows 11 全覆盖；
- 新 CetaMesh 产品层已验收；
- 所有 QQ / DSH / SnowLuma 真实组合都通过；
- 新 Agent / Task / Workspace 体系已完成。

涉及发布前仍应重新跑对应测试与真机验收。

---

## 19. 当前开发纪律

后续 Desktop 开发保持：

```text
小阶段
↓
代码落盘
↓
测试
↓
Checkpoint
↓
Git Commit
↓
Push
↓
更新 PROJECT_STATE
```

避免：

```text
长时间只存在于 Agent 会话
↓
最后统一落盘
```

尤其是 Agent / Workspace / Task 相关开发。

---

## 20. 当前禁止自动扩建的内容

除非用户明确启动，否则不要自行建设：

- Persistent Task v1；
- 大型 Multi-Agent Scheduler；
- 万能 Agent Runtime；
- 完整 Knowledge Graph；
- 完整 Plugin Marketplace server；
- 大量通用 Tool；
- 全磁盘 Agent 权限；
- 无限 Shell；
- 浏览器账户 / Secret 默认访问；
- Device Mesh 大规模同步；
- Desktop 与 Mobile 重新合仓。

---

## 21. 下一阶段候选，不代表已批准施工

以下只是候选顺序，不表示可以自动开始：

```text
A. 完善 PROJECT_STATE / 文档事实源
B. 核对 Desktop 原生 UI 与新产品导航的差距
C. 核对 Chat 独立产品闭环
D. 核对 Workspace 安全边界
E. 统一 Agent Provider 设计
F. Persistent Task v1
G. Context Rollover
H. 跨 Provider Handoff
```

当前用户已经明确：

> **先不开始 Persistent Task v1 构建。**

所以 F 以及依赖它的 G / H 不应自行启动。

---

## 22. 当前推荐读取顺序

新的 Agent 接手 Desktop 时建议按以下顺序：

```text
1. PROJECT_STATE.md
2. RULES.md
3. docs/DESKTOP_APP.md
4. docs/DESKTOP_ACCEPTANCE.md
5. docs/PROJECT_GUIDE.md
6. docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
7. AGENT_CONTEXT.md（只用于历史细节）
8. roadmap（用于方向，不用于判断“已经实现”）
```

开始代码任务前必须再检查：

```text
git main HEAD
recent commits
target files
tests
current branch
```

不要只依赖本文档的日期状态。

---

## 23. 当前一句话状态

> **CetaMesh Desktop 已拥有较成熟的 Windows 原生运行、Core、DSH/QQ 集成与安全基础，但新的 CetaMesh Chat / Persistent Task / Memory / Workspace / Agent Provider / Context Rollover 产品层仍未完成；当前先整理真实状态，不启动 Persistent Task v1。**
