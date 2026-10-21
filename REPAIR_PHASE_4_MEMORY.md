# CetaMesh Desktop 阶段 4：Memory 长期记忆修复

## 基线与边界

- 工作分支：`codex/phase4-memory`；从阶段 3 最终提交 `261be6d309dd7c3bc7ca7a6a89398ba545397140` 建立独立工作树。阶段 1 `599b7e1`、阶段 2 `23fd72f`、阶段 3 `261be6d` 均为本分支祖先。
- 没有重新开展全量审计；没有改动 Harbor 视觉方案、Capability Broker 的 Owner Approval 边界或现有用户数据。候选与正式 Memory 仍使用原有 `src/memory` 单一事实源和 `src/storage/json-file.js`。
- 本报告的 `FIXED_CODE` 指代码根因已修复；`VERIFIED_FIXTURE` 指隔离状态目录下经 `createCetaMeshServices()` 的真实生产装配链验证。夹具模型和 QQ 文件不算真实外部 E2E。
- 修复代码 Commit：`a01401d096e16bc9108971f2b2da09659d6b354e`。本报告另有文档提交；没有 push、合并 main 或发布 Stable。

## 12 项问题逐项记录

| ID | 状态 | 根因 | 修改点位 | 回归证据 | Commit |
| --- | --- | --- | --- | --- | --- |
| MEM-01 | FIXED_CODE / VERIFIED_FIXTURE | Chat 完成后没有候选触发；Managed 任务完成也未把 Owner 明确偏好提交给 Memory。 | `src/memory/auto-candidate.js:3`、`src/desktop/chat-service.js:994`、`src/app/service-container.js:170,214`：仅从用户原文或可信 Task 目标提议，敏感字段过滤，提议仍为 pending。 | `scripts/test-phase4-memory.mjs`：Chat A、重复提议、Managed Agent 完成任务；无审批不进入 Memory。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-02 | FIXED_CODE / VERIFIED_FIXTURE | Product Context 只解析 Task 引用，普通 Chat 没有 User Memory 检索；旧八条上限与设置不一致。 | `src/memory/runtime.js:252`、`src/context/service.js:37,75,243,291`、`src/context/task-context.js:3`：先授权再按 Scope/相关性检索，按数量和保守 UTF-8 字节预算限流；Chat 与 Managed 每轮重建。 | T01/T03/T04/T05/T07；500 条以外的旧偏好仍可按相关性命中。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-03 | FIXED_CODE / VERIFIED_FIXTURE | Harbor 只展示 Memory CRUD，候选投影丢掉状态且没有批准/拒绝入口。 | `src/desktop/ui-service.js:810`、`desktop-ui/src/bridge/typed-client.ts`、`desktop-ui/src/app/HarborApp.tsx:790`：候选、恢复状态、单项和批量决策接入真实 Core；展示最近批准/拒绝结果。 | 生产装配 `ui.memory.overview`、`ui.memory.candidates.confirm/confirmBatch`；`build:ui` PASS。Windows 原生视觉操作未执行。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-04 | FIXED_CODE / VERIFIED_FIXTURE | Harbor 使用无身份 ID 的 `user` Scope；用户主体过去可跨读其他 User Scope。 | `desktop-ui/src/app/HarborApp.tsx:790` 固定为 `user:desktop`；`src/memory/policy.js` 与 `src/memory/runtime.js` 把 User Scope 绑定实际 principal。 | 无 ID Scope 拒绝、其他 User Scope 创建/列举/确认均拒绝。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-05 | FIXED_CODE / VERIFIED_FIXTURE | Memory 设置没有进入 Chat/Agent 运行时。 | `src/app/service-container.js:214,382`、`src/context/service.js`：`enabled=false` 停止自动提议和注入，`retrievalLimit` 控制 Context；`requireConfirmationForLongTerm` 保持锁定为 true，直接写入仍由策略拒绝。 | T05、检索上限为 1 的生产 Context、尝试关闭确认得到 `LOCKED_SETTING`。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-08 | FIXED_CODE / VERIFIED_FIXTURE | 旧确认路径先写 accepted、再写 Memory、再补 memoryId，崩溃可留下半成功。 | `src/memory/runtime.js:463,485`、`src/memory/service.js:24`：持久 `confirming` 意图、确定性 Memory ID、启动恢复、旧 accepted 空 memoryId 修复；确认重试幂等。 | T09：插入前写盘失败、Memory 写入后模拟中断、Core 重启恢复、旧半成功文件恢复；没有重复 Memory。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-09 | FIXED_CODE / VERIFIED_FIXTURE | Core/Harbor 固定取前 200 条，客户端过滤无法找到旧记录；时间值为 epoch 时解析错误。 | `src/memory/runtime.js:223,252`、`src/memory/service.js`、`src/desktop/ui-service.js:810`、`desktop-ui/src/app/HarborApp.tsx:790`：服务端总数/offset/查询/类型、加载更多，正确处理数值或字符串时间。 | T10：超过 500 条时第 500 条之后仍可分页、搜索；旧记录可被相关性检索。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-10 | FIXED_CODE / VERIFIED_FIXTURE | Harbor 编辑上限 8000 与 Runtime 4000 不一致；投影与 QQ 导入可能静默截断正文。 | `src/desktop/ui-service.js`、`desktop-ui/src/app/HarborApp.tsx`、`src/memory/adapters/qq.js`：输入统一 4000；过长明确报错，已保存正文完整投影，QQ 正文不再 slice。 | 4001 字符在 UI/Core 均拒绝；中文和 emoji 长文本完整写读。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-11 | FIXED_CODE / VERIFIED_FIXTURE | QQ Adapter 仅按来源 ref 首次导入，无法更新、删除或处理本地编辑冲突。 | `src/memory/adapters/qq.js:151`、`src/memory/runtime.js:562`：只读源文件、来源指纹、增量新增/更新/删除、冲突计数；源文件缺失时禁止删除镜像。 | T11：两个群 Scope 隔离；修改/删除同步；Owner 本地编辑或 pin 时冲突保留；缺失源文件不删除记录。真实 QQ 未运行。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-12 | FIXED_CODE / VERIFIED_FIXTURE | Task 和 Handoff Packet 只存 Memory ID，Context 假定其 Scope 恒为 Task。 | `src/task/service.js:84`、`src/task/runtime.js:548`、`src/continuity/runtime.js:183`、`src/continuity/types.js:146`、`src/context/service.js:16`：经用户控制面核对真实 Memory，保存 Scope/类型/授权人并跨 Handoff 保留，加载时再核对。 | T08：新 Agent Session 的同一 Task 可取得合法引用，未关联 User Memory 不进入 Context。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-13 | FIXED_CODE / VERIFIED_FIXTURE | 候选没有去重；容量满只抛错，页面无处理入口。 | `src/memory/runtime.js:396,445`、`src/memory/service.js:73`、Harbor 候选区：待确认去重、已批准同内容去重、500 个未决容量提示、50 项一批人工处理。 | T12：重复提议同 ID、批准后不再重复、500 个未决候选明确 `STORE_FULL`、批量拒绝释放容量。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |
| MEM-14 | FIXED_CODE / VERIFIED_FIXTURE | Agent 默认读类型与授权 User 引用不匹配；单纯扩 Scope 会泄漏整个用户分区。 | `src/capability/service.js:327`、`src/memory/policy.js:62`、`src/memory/runtime.js`、`src/memory/links.js:37`：从真实 Task 引用生成只读精确 ID 授权，所有检索和链接解析都受限；不授予默认跨 Scope 权限。 | T06/T07/T08：Managed Agent 实际回合只收到授权 User 记忆；Task B 与同 Scope 未授权记录被拒绝。 | `a01401d096e16bc9108971f2b2da09659d6b354e` |

## 完整链路与数据可靠性

`scripts/test-phase4-memory.mjs` 已登记 `scripts/run-all-tests.mjs`，使用隔离目录，不接触真实用户状态：

| 验证 | 结果 |
| --- | --- |
| T01 Chat A 明确偏好 → 候选 → Harbor 批准 → 删除 Chat A → Core 重启 → Chat B 新模型回忆 | VERIFIED_FIXTURE |
| T02 拒绝候选不进入新 Chat 或重启后 Context | VERIFIED_FIXTURE |
| T03 修改 Memory 后只注入新正文 | VERIFIED_FIXTURE |
| T04 删除后不再注入 | VERIFIED_FIXTURE |
| T05 `enabled=false` 停止提议和注入，旧数据保留；恢复开关后仍可读 | VERIFIED_FIXTURE |
| T06 Task A/B Scope 与精确 ID 授权隔离 | VERIFIED_FIXTURE |
| T07 Managed Agent 真实执行夹具回合，读取该 Task 明确关联的 User Memory | VERIFIED_FIXTURE |
| T08 Task Handoff Packet 和新 Session 保留合法引用，未授权记录不进入 Context | VERIFIED_FIXTURE |
| T09 候选确认两种写盘中断窗口、旧半成功格式与 Core 重启恢复 | VERIFIED_FIXTURE |
| T10 超过 500 条 Memory 的分页、搜索、排序和旧记录相关性命中 | VERIFIED_FIXTURE |
| T11 QQ 不同群 Scope 隔离、增量同步、冲突和缺失源文件保护 | VERIFIED_FIXTURE |
| T12 重复提议/确认、容量与批量处理、Memory revision 冲突 | VERIFIED_FIXTURE |

阶段 1 的 MEM-06/07 修复未重写。`test-phase1-security`、`test-memory-runtime`、`test-memory-link`、`test-json-storage` 在全量聚合器中通过；损坏的 Memory 文件在夹具中保持原字节且 Chat Context 可继续构造。候选写盘失败不会返回假成功；未批准候选始终不出现在正式检索。QQ Adapter 不改原始 social-v2 文件。

## 验收命令

| 命令 | 最终结果 |
| --- | --- |
| `npm test` | `PASS 93 / FAIL 0 / NOT_RUN_ENVIRONMENT 11（104 suites；含新增 Phase 4 suite）` |
| `npm run build:ui` | PASS，TypeScript + Vite；现有大 chunk 警告，不计 FAIL |
| `npm run build:core` | PASS，Core bundle/SEA 和资源审计通过；未签名产物不是 Stable |
| `npm run desktop:check` | PASS，已有 Rust dead-code warnings，0 error |
| `npm run desktop:test` | PASS，197 passed / 0 failed |

测试命令在默认工具沙箱曾因 Windows `spawn EPERM` 中止；获得本地执行批准后，同一分支的构建与聚合器通过。此操作没有关闭 CetaMesh 产品沙箱或修改授权策略。

## 真实外部环境与剩余边界

- 真实模型/外部 Agent 回合：`NOT_RUN_ENVIRONMENT`。本机未提供 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 或真实模型测试开关；生产装配使用显式标记的模型夹具，不能据此宣称真实 Provider E2E PASS。
- 真实 QQ 双群同步：`NOT_RUN_ENVIRONMENT`。未提供真实 QQ 测试环境开关；仅用隔离 social-v2 夹具验证同步语义，未修改用户 QQ 数据。
- Harbor 原生 Windows 人工视觉与交互验收：`NOT_RUN_ENVIRONMENT`。Core UI 桥接夹具、TypeScript 与 Vite 构建已通过；没有将其冒充原生手动验收。
- `VERIFIED_REAL_E2E`：0 项。`PARTIAL`：0 项（代码范围）。上述外部验证仍待具备环境时执行；本阶段不以夹具结果替代其结论。

阶段 4 达到本地代码验收条件：12 项根因均已修复并有夹具回归，自动化检查 0 FAIL，未发现新增安全或数据完整性问题。停止于独立本地分支，等待阶段 5 指令。
