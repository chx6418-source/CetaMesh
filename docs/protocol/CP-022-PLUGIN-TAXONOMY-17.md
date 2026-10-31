# CP-022 — 17 类插件统一分类及协作契约

> 项目整合状态：**PROPOSED**（2026-10-31）。本文来自较早公开基线的草案，现状以[协议索引与实现映射](README.md)为准；示例与目标接口不改变现有 wire、授权或持久化格式。

**状态：PROPOSED；新增产品级分类与接口指导，不是 17 个现有 Runtime 的实现声明。**

## 0. 已有事实、范围与版本

- 17 类准确名称以用户既有《CetaMesh 插件体系与环境补验插件：讨论总结》（2026-10-25）及《CetaMesh 未来开发总体规划》（2026-10-16）为源。产品类型可叠加，**不授予任何权限**。
- 当前代码基线公开 main@`5330c5e`：Extension Manifest v1 仅有 `tool/external-api/workflow/memory-pack/channel-adapter/agent-adapter/ui` 七个 `type`。**17 类不得被误写入 Manifest v1 `type`，否则触发未知类型拒绝。**
- 17 类是产品 *category tags*；实现宿主按 **Data Pack、Extension Process、Managed App/Service、Isolated System/Device** 四层选择。任何新增技术 Host 应复用 Broker、Task、Memory、审计与生命周期基础。
- 每个可复合插件可有 `primaryCategory`（唯一）和 `categories[]`（1–17 个去重标签）。标签另存于分类侧车 / 未来经批准的 Manifest v2；v1 维持原样。
- `contractFamily` 是下表的**目标接口族名称**，不是当前已公开、可直接调用的 RPC method。

## 1. 17 类完整产品矩阵

| 编号 | 分类 | 中文名 | 核心功能 | 建议宿主 | 近期优先级 |
|---|---|---|---|---|---|
| 01 | **Agent Tool** | 工具插件 | 文件、检索、代码、数据单项能力 | Extension Process Host | P1 |
| 02 | **Agent Skill** | 技能插件 | 可复用提示、技能方法、步骤模板 | Data Pack；若需执行必须委托 Tool | P1 |
| 03 | **Agent Memory** | 记忆插件 | 角色/插件/任务的私有与受控共享记忆 | Core Memory Adapter；data-only Memory Pack | P1 |
| 04 | **Agent Knowledge** | 知识插件 | 文档索引、结构化资料、RAG 引用 | Data Pack + 受控索引服务 | P1 |
| 05 | **Agent Workflow** | 工作流插件 | 多工具/Agent 编排、条件分支和重试 | Extension + Task Runtime | P1 |
| 06 | **Agent Service** | 服务插件 | 常驻服务、队列消费者、API 与后台作业 | Managed Service Host（拟新增） | P2 |
| 07 | **Agent Connector** | 连接器插件 | MCP/ACP/OneBot、IDE、平台、外部 Agent | Extension Adapter + Agent Broker/MCP Adapter | P1 |
| 08 | **Agent Model** | 模型插件 | 模型 Provider 与本地推理桥接 | Model Runtime Adapter（非第二运行时） | P2 |
| 09 | **Agent Device** | 设备插件 | 手机、树莓派、摄像头、外部设备 | Device Mesh / Isolated Device Host | P2/P3 |
| 10 | **Agent Automation** | 自动化插件 | 定时、事件触发、受控桌面操作 | Core Automation + Controlled App Host | P2 |
| 11 | **Agent Team** | 多智能体团队插件 | 角色分工、任务协作、交接和验收 | Task + Agent Broker / Continuity | P2 |
| 12 | **Agent Identity** | 身份插件 | 角色人格、角色卡、认证资料和行为偏好 | Data Pack + Core Identity/Persona Adapter | P2 |
| 13 | **Agent UI** | 界面插件 | 面板、可视化、受控交互 | 隔离 UI Host（规划） | P2/P3 |
| 14 | **Agent Guard** | 安全防护插件 | 风控扫描、内容策略建议、质量检查 | Core Policy Hook（只读/拒绝型） | P1/P2 |
| 15 | **Agent Inspector** | 诊断监测插件 | 事件轨迹、健康、资源、失败回放 | Event Journal + Diagnostics projection | P1 |
| 16 | **Agent App** | Agent 应用插件 | Agent 专用浏览器、代码、Office、Data Lab | Managed App Host（规划） | P2 |
| 17 | **Agent OS** | Agent 系统插件 | Linux/WinPE VM、远程设备与 Agent 专用系统 | Isolated System/Device Host（规划） | P2/P3 |

## 2. 17 类独立开发契约（类型规范不得绕过通用核心契约）

下列类型接口均经 `Capability Registry → Capability Broker` 或更窄领域服务适配；当前版本不支持时必须返回 `UNSUPPORTED/UNAVAILABLE`，不能伪造接口。每一种类型的用户可见状态须区分：已安装、已配置、认证验证、运行就绪、已获授权、已真实验收。

### 01. Agent Tool — 工具插件

- **职责与输出**：文件、检索、代码、数据单项能力。对外能力族草案：`Tool/Capability`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Extension Process Host；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：现有 tool；覆盖范围需补验。
- **安全与数据边界**：执行前校验输入、Workspace 与效果类型。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：越界文件访问、伪造完成；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 02. Agent Skill — 技能插件

- **职责与输出**：可复用提示、技能方法、步骤模板。对外能力族草案：`Context Reference/SkillDescriptor`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Data Pack；若需执行必须委托 Tool；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：数据型 Skill Pack 计划中。
- **安全与数据边界**：提示仅是参考资料，不得变更系统权限。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：技能文本越权指令、版本漂移；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 03. Agent Memory — 记忆插件

- **职责与输出**：角色/插件/任务的私有与受控共享记忆。对外能力族草案：`Memory.Query/Propose/Link`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Core Memory Adapter；data-only Memory Pack；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：Core Memory v1/Memory Pack 基础已存在；插件 Scope 规划中。
- **安全与数据边界**：先授权再检索；长期记忆需用户确认。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：跨 Scope 探测、私有记忆外传；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 04. Agent Knowledge — 知识插件

- **职责与输出**：文档索引、结构化资料、RAG 引用。对外能力族草案：`Knowledge.Search/Reference`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Data Pack + 受控索引服务；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：知识类型已有；独立插件接口规划中。
- **安全与数据边界**：来源、许可证、证据可追溯，检索不直接提升权限。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：引用伪造、隐私索引泄漏；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 05. Agent Workflow — 工作流插件

- **职责与输出**：多工具/Agent 编排、条件分支和重试。对外能力族草案：`Workflow.Plan/Run/Status`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Extension + Task Runtime；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：Extension workflow v1、Task 基础已有。
- **安全与数据边界**：通过 Task/Attempt/Operation Identity 编排真实副作用。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：重复提交、循环工作流、重试外部写入；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 06. Agent Service — 服务插件

- **职责与输出**：常驻服务、队列消费者、API 与后台作业。对外能力族草案：`Service.Start/Health/Stop`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Managed Service Host（拟新增）；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：当前不可宣称通用 Service Host 已交付。
- **安全与数据边界**：进程身份、资源上限、背压、停止与重启隔离。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：无界任务/无限重启、异常资源耗尽；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 07. Agent Connector — 连接器插件

- **职责与输出**：MCP/ACP/OneBot、IDE、平台、外部 Agent。对外能力族草案：`Connector.Health/Invoke/Subscribe`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Extension Adapter + Agent Broker/MCP Adapter；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：channel-adapter/agent-adapter 已有部分基础。
- **安全与数据边界**：端点固定、认证凭据隔离、外发另行授权。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：SSRF、凭据越界、冒充授权 Actor；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 08. Agent Model — 模型插件

- **职责与输出**：模型 Provider 与本地推理桥接。对外能力族草案：`Model.Catalog/Infer/Usage`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Model Runtime Adapter（非第二运行时）；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：Model Runtime 已有；插件化 Provider 需评审。
- **安全与数据边界**：模型成本、数据出口、上下文、认证隔离。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：模型调用失败虚报成功、隐式收费；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 09. Agent Device — 设备插件

- **职责与输出**：手机、树莓派、摄像头、外部设备。对外能力族草案：`Device.Manifest/Invoke`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Device Mesh / Isolated Device Host；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：Device Mesh 协议已有；真实设备验证需独立进行。
- **安全与数据边界**：Trust≠Authorized；设备特权需本地 Policy 与 grant。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：配对后直接控制设备、跨设备记忆泄漏；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 10. Agent Automation — 自动化插件

- **职责与输出**：定时、事件触发、受控桌面操作。对外能力族草案：`Automation.Schedule/Trigger/Run`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Core Automation + Controlled App Host；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：能力规划中；不可暗中开启宿主进程特权。
- **安全与数据边界**：明确触发源、预算、频率、审批和去重。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：重复触发、无人值守高风险动作；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 11. Agent Team — 多智能体团队插件

- **职责与输出**：角色分工、任务协作、交接和验收。对外能力族草案：`Team.Plan/Delegate/Review`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Task + Agent Broker / Continuity；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：现有协作基础；Team 插件协议规划中。
- **安全与数据边界**：Task 属 Core；委托不能提升权限。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：Agent 交接丢进度、伪造子任务完成；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 12. Agent Identity — 身份插件

- **职责与输出**：角色人格、角色卡、认证资料和行为偏好。对外能力族草案：`Identity.Profile/Persona`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Data Pack + Core Identity/Persona Adapter；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：Simulation Persona 规划中；旧角色需保真。
- **安全与数据边界**：角色设定不是安全 Principal，不能伪造用户授权。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：人格卡注入系统权限、角色资产迁移损失；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 13. Agent UI — 界面插件

- **职责与输出**：面板、可视化、受控交互。对外能力族草案：`UI.Contribute/Action`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：隔离 UI Host（规划）；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：manifest ui 只声明接口，非完整安全 UI Runtime。
- **安全与数据边界**：UI 事件不持有 Core 内部对象；所有动作经 Broker。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：XSS、WebView 注入、伪装审批 UI；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 14. Agent Guard — 安全防护插件

- **职责与输出**：风控扫描、内容策略建议、质量检查。对外能力族草案：`Guard.Inspect/Flag/Veto`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Core Policy Hook（只读/拒绝型）；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：Core Policy 已有；插件 Guard hook 规划中。
- **安全与数据边界**：可建议更严格或拒绝，不能授予新权限。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：Guard 输出 allow 绕过 Core 拒绝、死锁；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 15. Agent Inspector — 诊断监测插件

- **职责与输出**：事件轨迹、健康、资源、失败回放。对外能力族草案：`Inspector.Observe/Report`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Event Journal + Diagnostics projection；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：现有部分日志/诊断；Inspector 插件标准待建。
- **安全与数据边界**：只读脱敏、限频、无隐式执行或秘密日志。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：未经授权导出日志、跨 Task 观测；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 16. Agent App — Agent 应用插件

- **职责与输出**：Agent 专用浏览器、代码、Office、Data Lab。对外能力族草案：`App.Open/Invoke/State`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Managed App Host（规划）；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：规划中，非当前 Extension v1 的完整产品支持。
- **安全与数据边界**：独立进程生命周期、受控文件/设备、用户可见操作。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：在普通 Extension 中开启任意进程/原生权限；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

### 17. Agent OS — Agent 系统插件

- **职责与输出**：Linux/WinPE VM、远程设备与 Agent 专用系统。对外能力族草案：`System.Create/Exec/Stop`；必须显式声明输入/输出 Schema、效果类别、最大结果/耗时，所需 Scope 和运行时版本。
- **宿主与所有权**：Isolated System/Device Host（规划）；不能自行创建影子权限、影子 Task、影子 Memory 或影子模型运行时。当前映射：AgentOS/环境测试基础≠通用 System Host。
- **安全与数据边界**：强隔离、镜像可信度、网络/磁盘显式授权。从其他插件消费数据时分别确认来源、接收者、用途与外发条件。
- **必测负例**：把普通插件权限升级为任意 Host 操作；再覆盖禁用/升级失效、输入超限、无授权、取消时未知效果和审计关联。

## 3. 分类交叠与冲突判定

- **同一包可多标签**：例如 `Agent Workflow + Agent Tool + Agent Knowledge`；UI 只显示主要类别，其他类为能力筛选标签，不产生额外 Host 或权限。
- **身份与模型**：Identity 仅描述角色/persona，不能代替可信安全 Principal；Model 适配只能通过 Model Runtime，不能因被某 Agent 选中而获得执行权。
- **Memory 与 Knowledge**：Knowledge 检索可提供引用；Memory 是带 Scope、Provenance、Revision 和明确读写授权的持久状态。Memory Pack data-only 仍完全独立于可执行 Memory Adapter。
- **Guard 与 Inspector**：Guard 建议风险/提供 veto（只会收紧权限），不得覆盖 Core `deny`；Inspector 只读最小脱敏观测，不能隐式执行工具。
- **Automation 与 Service**：Automation 产生有界的 *触发意图*；Service 是可健康检测的 Host；两者都不能在没有 Core Grant 时执行副作用。
- **Agent App / Agent OS**：专用 Host 与系统隔离能力是未来扩展，不解锁普通插件被禁止的 `shell/native/process/download`。

## 4. 组合时能力选择与版本协议

1. 核心只接受已注册且可用的 Capability Descriptor（精确 ID、协议主版本、输入/输出、效果、副作用、Scope、授权条件）。
2. 编排层按能力和真实就绪状态选插件，不以 17 类标签作为调用依据；存在多个适配器时不能擅自切换到不同数据目的地或不同授权范围。
3. 共享调用链必须携带由 Core 注入的 Task/Attempt/Workspace、操作标识、Trace 与执行预算；插件不能提交新的安全身份。
4. v1 的调用目标必须在受审 `delegates[]` 中精确列出。新增发现/订阅/依赖语法走侧车协议与未来 Manifest v2 的兼容性评审，不改旧 v1 解析行为。
5. 禁止从类型推断权限：Device ≠ 获得摄像头权限，OS ≠ 任意 Shell，UI ≠ Core 管理员，Identity ≠ 用户本人。

## 5. 17 类实现完成度审计准则

分类目录完整不等于 17 类产品均已实现。逐类报告 `DECLARED / ADAPTER_PRESENT / CONTRACT_TESTED / REAL_E2E_VERIFIED / BLOCKED_ENV / NOT_IMPLEMENTED`，必须附真实代码与测试证据；当前基线仅可断言已观察到的基础模块，不能宣称 17 类齐备。
