# CetaMesh Desktop 修复阶段 1：安全与数据完整性

日期：2026-10-16
基线：`560a3995ecf5fe8e7f08c9b773e41c4a964c6b8b`（Owner 确认的本地 `main`）
工作分支：`codex/phase1-security`
修复 Commit：`599b7e10d051275fd11dcd26267477196e0c0c83`
交付状态：**14 项 FIXTURE_PASS；真实安装版/外部服务 E2E 未执行。阶段 1 本地代码门禁通过，仍不构成 Stable 发布验收。**

本轮仅按两份 2026-10-16 附件中的阶段 1 问题点位修复。既有主工作树的未提交内容没有复制、清理或覆盖；修复位于独立工作树。没有修改 Harbor 设计、开发新功能、推送远端或合并 `main`。

## 验证结果

| 命令 | 实际结果 | 边界 |
|---|---|---|
| `npm test -- --category security` | 14 PASS，0 FAIL | 含新增 `test-phase1-security.mjs`，已登记 `scripts/run-all-tests.mjs` |
| `npm test -- --category core` | 18 PASS，0 FAIL | 含 Task/Memory/Settings 迁移与回滚用例 |
| `npm test -- --category integration` | 7 PASS，0 FAIL | 含 Workshop → Agent 审批、重启续跑及 MCP 集成 Fixture |
| `npm test` | **88 PASS，0 FAIL，12 NOT_RUN_ENVIRONMENT**（100 suites） | 全量聚合器最终运行结果；跳过项不计 PASS |
| `desktop-ui/npm run check` | PASS | TypeScript `tsc --noEmit` |
| `git diff --cached --check` | PASS | 代码提交前检查；无空白错误 |

全量聚合器的 12 项环境跳过包括缺少 legacy bridge、gateway/network、Core/Release 构建产物、`shell-debug`，以及未启用 `WHALEBRIDGE_TEST_CARGO=1` 的 Cargo check/test。本阶段未改 Rust 源码；Cargo 项如实记为 `NOT_RUN_ENVIRONMENT`。真实 Windows 安装版、真实 Agent/QQ/移动端 Mesh 端到端验收均为 `NOT_RUN_ENVIRONMENT`，不计入上述 PASS。

## 逐项修复记录

下表每行的状态 `FIXTURE_PASS` 仅指所列本地负向/回归 Fixture 及全量聚合器通过。每项的修复 Commit 均为 `599b7e10d051275fd11dcd26267477196e0c0c83`；真实产品 E2E 状态均为 `NOT_RUN_ENVIRONMENT`。

| ID | 问题点位与根因 | 修复和负向证据 | 状态 / 修复 Commit |
|---|---|---|---|
| SEC-01 | `src/capability/service.js`：Agent `filesystem.write` 原为 medium，可绕过 Owner Approve Once。 | 提升为 high，既有文件写入还须提供 `expectedHash`；`scripts/test-phase1-security.mjs` 验证未批准不写、批准一次写入及重放拒绝；`scripts/test-capability-broker.mjs` 覆盖审批链。 | FIXTURE_PASS / `599b7e1` |
| SEC-02 | `src/capability/policy.js`、`broker.js`：审批后执行没有重新核对 Task 终态及 Agent assignment。 | 审批保存 Task revision、Provider、Session，决策与执行前重新授权并核对指纹/TTL；取消 Task 后旧审批无副作用，见阶段 1 Fixture。 | FIXTURE_PASS / `599b7e1` |
| SEC-03 | `src/capability/broker.js`：本地 Abort 返回会掩盖外部副作用是否已经发生，重复 requestId 可能重放。 | 将已发出的取消报为 `INVOKE_CANCEL_UNCONFIRMED`/`effectStatus=unknown`；对可能产生外部副作用的能力写持久 dispatch journal，拒绝同 requestId 重放，记录后续完成/失败；阶段 1 Fixture 覆盖取消后实际完成及重启重试。Workshop 的内部 `agent.run` 续跑不受外部副作用去重误拦，集成专项验证。 | FIXTURE_PASS / `599b7e1` |
| SEC-04 | `src/task/store.js`、`src/memory/store.js`、`src/settings/store.js`：损坏或错误结构可能静默归一化。 | Domain Schema 校验、原文件原样备份，Task/Memory fail closed；Settings 只读回退并要求显式恢复/全部重置。阶段 1 Fixture 和 `test-storage-migrations.mjs` 验证损坏数据不被普通写入覆盖。 | FIXTURE_PASS / `599b7e1` |
| SEC-05 | `src/app/bootstrap.js`：两个 Core 可同时写同一 StateDir。 | 启动前获取 `.core-owner.lock`，进程存活时第二实例拒绝，退出释放；`src/app/state-owner.js` 和阶段 1 Fixture 验证同进程、跨进程、重启。 | FIXTURE_PASS / `599b7e1` |
| WORKSPACE-01 | `src/workspace/tools.js`：多文件 staging 顺序写入，后续失败留下已改文件。 | `src/workspace/transaction.js` 实施预检、preimage 备份、提交 journal、失败补偿及启动恢复。阶段 1 Fixture 注入第二次写入、第三次删除失败和中断恢复；发生并发外部修改时明确进入 `WORKSPACE_RECOVERY_REQUIRED`，不覆盖未知新内容。这是可恢复补偿流程，并非 OS 级跨文件原子事务。 | FIXTURE_PASS / `599b7e1` |
| WORKSPACE-02 | `src/workspace/tools.js`：覆盖式直接写，`append` 被忽略，缺并发冲突检查。 | 明确 append/`expectedHash`，同目录临时文件写入及 fsync 后受控 rename；目标重检并拒绝符号链接。阶段 1 Fixture 覆盖原文保留、hash 冲突及 junction 越界。 | FIXTURE_PASS / `599b7e1` |
| MODEL-02 | `src/model/tool-execution.js`：已注册但本轮 Manifest 未展示的工具仍可能执行。 | 本轮 descriptor 缺失立即 `UNKNOWN_TOOL_IN_TURN`，到不了 Broker；`test-model-tool-calling.mjs` 覆盖 Owner/Agent 隐藏工具零 dispatch。 | FIXTURE_PASS / `599b7e1` |
| HND-06 | `src/capability/service.js` 与 staged Agent provider：导入只核 Task/Workspace，不核当前来源 Session。 | Codex/DSH staged 导入显式携带 Provider+Session；执行时与 Task 当前 Agent 匹配，审批再绑定 revision。阶段 1 Fixture 验证切换后旧 Agent 的导入不能落盘。 | FIXTURE_PASS / `599b7e1` |
| MEM-06 | `src/memory/runtime.js`：候选加载先标记 loaded，解析失败后可能把空状态写回。 | 完整校验后才置 loaded，损坏源备份并允许修复后重试；候选写失败恢复内存态。阶段 1 Fixture 覆盖失败加载、修复重载、写失败时磁盘与内存保持原样。 | FIXTURE_PASS / `599b7e1` |
| MEM-07 | `src/memory/store.js`：结构不合法的记录可能被跳过并静默丢失。 | 严格验证版本、列表、记录、Scope、类型及 revision；保留坏源备份并 fail closed。阶段 1 Fixture 验证原文和备份保留。 | FIXTURE_PASS / `599b7e1` |
| MESH-01 | `src/app/service-container.js`、`src/mesh/node.js`：`meshEnabled=false` 未守住运行时入口。 | Settings 与 Mesh service/node 绑定；禁用时拒绝配对、入站信封和出站请求，关闭监听并撤销待处理配对/审批；阶段 1 Fixture 验证禁用时无配对会话且重启后仍拒绝，现有 Mesh runtime/interop 回归通过。 | FIXTURE_PASS / `599b7e1` |
| SETTINGS-02 | `src/settings/schema.js`、`store.js`：合法 JSON 中字段类型错误时自动回退，下一次保存可能覆盖原数据。 | 严格校验类型、未知字段及版本；原文件备份，默认设置只读展示，普通保存拒绝；现有 Settings UI 显示恢复状态。阶段 1 Fixture 验证类型错误、未知版本、备份和拒绝覆盖；UI 类型检查通过。 | FIXTURE_PASS / `599b7e1` |
| CHAT-08 | `src/desktop/chat-service.js`：活动回合可更换 Workspace 绑定。 | 活动 turn 拒绝跨 Workspace 修改并返回 `TURN_BUSY`；`test-desktop-chat-product.mjs` 验证旧回合绑定不会被切换。 | FIXTURE_PASS / `599b7e1` |

## 交付边界

修复代码和本报告只提交到本地 `codex/phase1-security`。未 push、未合并 `main`、未打 Stable，也没有开始阶段 2。Owner 可先检查分支、测试证据与上述 `NOT_RUN_ENVIRONMENT` 项，再决定下一阶段。
