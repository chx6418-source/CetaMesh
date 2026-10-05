# CetaMesh Desktop v1 开发检查表

> **历史文档（2026-10-04 基线 `d35dbfe`）**：本检查表记录的是 v1 施工前的规划与状态，
> 其中的 PARTIAL/MISSING/BLOCKED 判断已被后续阶段（Chat/Tasks/Memory/Workspace/Agent/
> Continuity/Extension/Mesh/Settings/Installer）取代。**当前权威状态以 `PROJECT_STATE.md`
> 的阶段 14/15 快照为准**；本文件仅保留施工范围映射与历史决策，不再作为状态事实源。

> 建立日期：2026-10-04（阶段 01 真实状态审计产物）
> 基线：`main@d35dbfe`（Windows，分支 main）
> 上游施工文档：`docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md`（本文件把其 D0–D10 任务映射为可勾选的 v1 交付序列）
> 状态事实源：`PROJECT_STATE.md`（本检查表不重复证据，只引用结论）

## 状态图例

```text
[ ]  未开始        [~]  进行中        [x]  完成（附验证）
标签：IMPLEMENTED / PARTIAL / PLANNED / DEPRECATED / BLOCKED / NOT VERIFIED
规则：只有当对应测试在本机实际运行并通过，才能把条目标成 [x]；
      PASS 只对本机命令负责，不代表真机/真实模型/视觉验收。
```

## v1 交付范围映射（目标 19 项 → 施工阶段）

| v1 交付项 | 当前状态 | 施工阶段 |
| --- | --- | --- |
| Chat | PARTIAL（QQ 桥接聊天可用；桌面独立 Chat 页不存在） | Stage C（D2） |
| Session | IMPLEMENTED（QQ↔DSH 会话映射 + DSH session API） | Stage C 扩展 |
| Model Provider | PARTIAL（DSH 目录/默认模型；无通用抽象与凭据库） | Stage B/D2（D1/D2-001~002） |
| Agent Provider | MISSING（抽象不存在；DSH client 是原料） | Stage E（D5） |
| Agent execution | PARTIAL（DSH 会话回合、MCP 工具） | Stage E |
| Tasks / Persistent Task | MISSING —— **BLOCKED：所有者冻结，未明确解除不得开工** | 冻结（解除后并入 D1-007） |
| Memory | PARTIAL（qq_memory_* 社交记忆；无统一 Runtime） | Stage D（D3） |
| Workspace | PARTIAL（仅 DSH 侧概念；无 CetaMesh 安全边界） | Stage B/D5（D1-006 起步） |
| Capability | MISSING（无 Registry） | Stage B（D1-004） |
| Approval | IMPLEMENTED（legacy：pending/提问/风险卡队列） | Stage B 重构到 Permission Engine（D1-005） |
| Context Rollover | MISSING —— BLOCKED（同上冻结） | Stage G（D6，解除后） |
| Agent Handoff | MISSING —— BLOCKED（同上冻结） | Stage G（D6，解除后） |
| Local Plugin/Extension | PARTIAL（DSH 侧 whale-mode-console；桌面插件仅有未跟踪草稿，不计入） | Stage I（D9） |
| Device Mesh desktop node | MISSING —— v1 范围外，明确不做 | 范围外 |
| Settings | PARTIAL（原生 UI 12 个管理页） | Stage J 收敛进 v1 信息架构 |
| About / Update | MISSING（无自动更新通道；仅重装/修复） | Stage J（D10） |
| Logs / diagnostics | IMPLEMENTED（活动/日志/诊断页 + CONTROL_LOG_FILES） | Stage J 复验 |
| Windows installer | IMPLEMENTED（安装/升级/修复/迁移/卸载全生命周期测试 PASS） | Stage J 复验 |
| Release verification | NOT VERIFIED（RC 测试本机 PASS 过，发布验收未做） | Stage J（D10） |

---

## Stage A — Legacy Baseline（workplan D0）【IMPLEMENTED】

- [x] TASK-D0-001 基线清点（PROJECT_STATE 第 0–24 节 + 阶段 01 审计节）
- [x] TASK-D0-002 基线测试矩阵（2026-10-04 本机：cargo 62/62 + 7 个 Node 套件 PASS；self-test = NOT_RUN_ENVIRONMENT）
- [x] 遗留缺陷修复：`--remove-data` 卸载栈溢出（`05a6c99`）；remove-data 事务回归测试（`d35dbfe`）

## Stage B — Foundation（workplan D1）【PLANNED，下一入口】

- [ ] TASK-D1-001 Unified Config Service（`src/config/`：schema/loader/migrate/service；Zod；旧 config 迁移；安全默认不变；损坏 fail-closed）
  - 前置事实（2026-10-04 盘点）：唯一主读取路径 `src/bridge.js:356 loadConfig()`（约 290 行内联默认值，文档级已 fail-fast，字段级宽松）；写路径为原始读改写（`atomicWriteJson`）；旁路读取者 `local-services.js` / `mcp-host-server.js` / `mcp-snowluma-safe.js` 执行期直读 config.json
  - 验证：`npm run test-core-entry` / `test-privilege` / `self-test`（DSH 未运行时如实标 NOT_RUN_ENVIRONMENT）+ 新增 config 差分测试（金样本来自重构前 `loadConfig` 真实输出）
- [ ] TASK-D1-002 Named Pipe Security Audit（SID/ACL、未授权拒绝、超大帧、版本错误；补自动测试）
- [ ] TASK-D1-003 Trace / Error Envelope（traceId/taskId/sessionId/eventId/error.code）
- [ ] TASK-D1-004 Capability Registry v1（register/list/describe/invoke；未知默认拒绝）
- [ ] TASK-D1-005 Permission Engine v1（caller/capability/scope/workspace/risk/decision）
- [ ] TASK-D1-006 Workspace Model v1（ID/Root/Policy——先建模，不做文件隔离 enforcement）
- [ ] TASK-D1-007 Task Runtime v1 —— **BLOCKED（冻结解除前不得实施）**
- [ ] TASK-D1-008 Incremental Bridge Extraction（先回归测试、后小步抽取 `bridge.js`）

**Gate D1**：Config 统一入口；Pipe 安全审计完成；Capability/Permission/Workspace 基础类型可用；QQ/DSH 行为无回退。

## Stage C — Standalone Chat（workplan D2）【PLANNED】

- [ ] TASK-D2-001 Model Provider API
- [ ] TASK-D2-002 Provider Credential Storage
- [ ] TASK-D2-003 Chat Session Store
- [ ] TASK-D2-004 Desktop Chat UI（原生窗口；工程配置下沉）
- [ ] TASK-D2-005 Attachments v1

**Gate D2**：Fresh Windows 不装 QQ/SnowLuma/DSH，仅配模型 API 即可用 Chat。

## Stage D — Memory Runtime（workplan D3）【PLANNED】

- [ ] TASK-D3-001 Memory Schema v1
- [ ] TASK-D3-002 Memory Store
- [ ] TASK-D3-003 Memory Policy（先授权再检索）
- [ ] TASK-D3-004 Memory Search
- [ ] TASK-D3-005 Memory Link / Resolver
- [ ] TASK-D3-006 Long-Term Consolidation
- [ ] TASK-D3-007 Memory UI

## Stage E — Agent Provider（workplan D5）【PLANNED】

- [ ] TASK-D5-001 Agent Provider Interface（createSession/send/cancel/status/contextUsage/checkpoint/resume/handoff/capabilities）
- [ ] TASK-D5-002 DSH Adapter（基于 `src/dsh-client.js` 既有端点包装，不改 DSH）
- [ ] TASK-D5-003 Agent Task Mapping（依赖 Task Runtime 解冻）
- [ ] TASK-D5-004 Work UI

## Stage F — Social / Mode 迁移（workplan D7）【PLANNED，只记录不重构】

旧四模式现存位置（2026-10-04 实测计数）：`src/bridge.js`(14)、`src/control/control-service.js`(3)、`desktop-shell/src/native_ui.rs`(5)、`README.md`(2)、`RULES.md`(2)。

- [ ] TASK-D7-001 Mode Migration（chat/closed-agent → Chat/Social/Owner Agent；reserved* 处置需所有者决策）
- [ ] TASK-D7-002 Channel Abstraction（QQ/SnowLuma 收敛为 Channel Adapter）
- [ ] TASK-D7-003 Social Memory（并入 D3）

## Stage G — Continuity Runtime（workplan D6）【BLOCKED】

- [ ] D6-001~014 全部条目 —— **BLOCKED：属 Persistent Task 冻结范围，所有者明确解除前不得开工**。设计参考 `docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md`（仅设计，非实现证据）。

## Stage H — Workshop（workplan D8）【PLANNED】

- [ ] TASK-D8-001~005（Proposal / Owner Approval / Workspace Creation / Sandbox Enforcement / Artifact Delivery）

## Stage I — Plugin / Tool Lab（workplan D9）【PLANNED】

- [ ] TASK-D9-001~005（Tool Builder / Manifest v1 / Import Pipeline / Install Lifecycle / Memory Pack）
- 注：`plugins/cetamesh-*` 与 `src/desktop-plugin-*.js` 是**未跟踪草稿**，不代表已批准方向；启用其任何内容前必须所有者明确决策。

## Stage J — Private RC / 发布（workplan D10）【PLANNED】

- [ ] TASK-D10-001 发布候选（重跑 `build:release` + `test-release-candidate`）
- [ ] Settings 页收敛进 Chat/Tasks/Memory/Workspace 四导航
- [ ] About / Update 通道设计（当前无任何自动更新机制，grep 证实）
- [ ] Logs / diagnostics 复验
- [ ] Windows 真机安装验收 + `PENDING_NATIVE_VERIFICATION` 项人工视觉确认
- [ ] Release verification 报告

---

## 全局禁令（与 PROJECT_STATE 第 20 节一致）

Persistent Task v1、Multi-Agent Scheduler、万能 Agent Runtime、完整 Knowledge Graph、Plugin Marketplace server、全磁盘 Agent 权限、无限 Shell、Device Mesh 大规模同步、Desktop/Mobile 合仓——未经所有者明确要求一律不得开工。

## 每阶段收尾纪律

```text
git status/diff → 对应测试 → 能跑的 build/check → 修本阶段引入的问题
→ 更新 PROJECT_STATE.md（已完成/已验证/未验证/已知问题/下一阶段入口）→ 本地 commit（不主动 push）
```
