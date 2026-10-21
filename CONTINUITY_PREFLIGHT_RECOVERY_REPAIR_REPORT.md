# Continuity Preflight and Detached Task Recovery Repair

日期：2026-10-20（Asia/Shanghai）

## 边界与基线

- 基线：`bb448536b4d5f6888132a28b16bab493b83d5a59`，保留 DSH 设置简化与全部此前修复。
- 本轮分支：`codex/continuity-preflight-repair`。
- Version `1.0.0-rc.2`；源码 Build `1109`。当前安装版仍是 1107；本轮不退出应用、不覆盖安装。
- 发布状态：`RELEASE_BLOCKED`。
- 不修改真实 Task、Workspace 或 Social 数据，不恢复真实 Agent，不删除运行锁，不重试曾被 Defender 拦截的文件读取。
- 工作树原有 `CODEX_SNAPSHOT_READ_RECOVERY_REPORT.md` 与 `PROJECT_STATE.md` 修改保持原样，未混入此次提交。

## 真实故障证据（只读）

截图对应任务 `task_mvgqi1w4_3fcb157ca3` 的持久状态为 blocked，currentAgent=null，progress.note 为 `needs-reconciliation: Handoff failed after old Agent stopped (WORKSPACE_CHANGED); verify Workspace before recovery`。

已有 reconciliation-0001 显示非 Git 工作区，branch/headSha 的 checkpoint 为空字符串、当前值为 null，同时记录 no-git-repo。空值差异不能证明文件发生变化；非 Git 的自动核验缺口仍需保留。正文显示不代表 Task 已完成。

不输出项目正文、凭据或私人聊天。该真实任务本轮未取消、未恢复、未重新绑定执行者。

## 修复与验证

### R1 空 Git 元数据误报 — FIXED_CODE / VERIFIED_FIXTURE

`src/continuity/reconcile.js` 仅将 branch/headSha/diffSummary 中的空白文本统一为 null。保留非空值、布尔证据、真实变更与 no-git-repo 阻塞。

先运行新增断言，观察到 branch/headSha/diffSummary 误报；修复后只保留 no-git-repo。真实非空值变成 null 仍报告变化。

### R2 交接核验过晚 — FIXED_CODE / VERIFIED_FIXTURE

旧链：构建包 → prepare/create target → cancel old → bootstrap → 核验 → 失败并解除执行者。

新链：采集基线 → 临时包 → 重新采集当前事实并预检 → prepareHandoff 刷新 Owner 上下文及工作记忆 → 重建正式包 → 保存包与事务 → create target → cancel old → bootstrap → 再次采集并核验 → 提交。

预检失败前禁止 prepare/create/cancel/send/close，不改变 Task rev、checkpoint、currentAgent，不创建交接事务。调用者提供的旧事实仅作基线，不能替代当前采集。

首次反例明确观察到 create/cancel/send/cancel/close；修复后 plain、missing、stale-supplied-facts、missing-file 四类均在副作用前拒绝。

原 bootstrap 后变更测试保留 blocked 与 currentAgent=null 断言，加入前置采集后使用三次事实采集模拟：基线一致、预检一致、bootstrap 后变化；仍须拒绝。

独立审查发现初稿在 prepare 前固定正式包导致新上下文遗漏。新增失败测试确认后修复，最终包重新读取 Task 与 Memory，不遗漏 prepare 保存的内容。

### R3 失去执行者的任务无法正式恢复 — FIXED_CODE / VERIFIED_FIXTURE

`src/desktop/ui-service.js` 的人工恢复接口增加可选 provider。已有绑定时不得借恢复改换 Provider；无绑定时必须明确选择。提前验证 Provider、健康、工作区与 Native execution consent，再进行工作区检查和既有审批/事务核对记录。

`HarborApp.tsx` 的人工核对区在无当前 Agent 时显示“恢复执行者”，默认不选择，只列 Task eligible 项；复用既有 Native Security 确认，不自动替用户批准。typed client 传递所选 Provider。按 Task ID 重建表单状态，避免跨任务保留选择。

新增生产服务 Fixture 验证：缺执行者的请求拒绝且 Task/decision 不变；明确选择 Managed Agent 后可恢复并保留 Task ID。每项恢复测试使用独立工作区，单写者门禁保持有效。

### R4 恢复错误提示 — FIXED_CODE

Chat 与平台路由保留 `TASK_RECOVERY_REVIEW_REQUIRED` 错误码，将英文泛化提示改成任务详情“人工核对后恢复”的操作说明。不自动重放旧工具操作。

## 测试与构建

最终相关回归：8 suites PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT：

- test-workspace-reconciliation
- test-continuity-rollover
- test-continuity-auto-rollover
- test-handoff-context-working-memory
- test-phase3-task-handoff
- test-harbor-agent-setup
- test-desktop-ui-v2-production
- test-error-hygiene

新增测试均扩展既有已登记套件，由 npm test 统一运行。RED 失败、测试 Fixture 返回 DTO 修正、单写者拒绝和闭合 Select SSR 语义修正均如实区分；未删除原有安全断言。

- 最终 UI：`npm run build:ui` PASS（tsc + Vite；既有 chunk size 警告）。
- 最终 Core SEA：`npm run build:core -- --out .../continuity-core1109-final` PASS。
- 最终 SEA 集成：`WHALEBRIDGE_DIST_DIR=.../continuity-core1109-final npm test -- --suite test-core-dist`：1 PASS / 0 FAIL（28.3s），验证生产 Worker / IPC / MCP，无系统 Node 和隔离数据路径。
- 全量 `npm test`：141 suites，131 PASS / 0 FAIL / 10 NOT_RUN_ENVIRONMENT。全量执行期间完成定向审查修正，受影响的 8 个套件随后单独回归通过，最终 UI / Core 重建及最终 SEA 集成再次通过。
- 10 个未运行项：2 个真实 Codex、Legacy Console、2 个网关、network、2 个完整 release-dist 验收，以及未设置 WHALEBRIDGE_TEST_CARGO=1 的 cargo:check/cargo:test。未将其计作通过。
- Rust 未独立重跑：本轮无 Rust 修改，不引用历史 Rust PASS 作为新证据。
- 独立只读代码复查：初轮 1 个 Important 已修复；复查未发现新增 Critical/Important。复查不冒充独立运行测试。

## 构建输出与限制

仅构建验证用 SEA：`D:/GIT- CetaMesh/live-model-repair/continuity-core1109-final/WhaleBridgeCore.exe`

- 大小：98,799,616 bytes。
- SHA256：`12adf18f78e75dba3b97258530f5805dc95aad928d530060ef044ffc9122f981`。
- Authenticode：NotSigned。
- 该构建来自本地带未提交修改的源码，非正式干净发行候选；不能冒充安装包或已安装验证。
- 未构建完整安装器、未覆盖 1107，Windows 原生恢复 UI 与真实 Codex 恢复仍未验收。

## 剩余门禁

- 非 Git 工作区仍不能自动证明文件和未知副作用一致，不将其判为可自动 Handoff。
- 已阻塞真实任务仍需 Owner 检查文件与先前副作用，填写真实核对结果和新指令，明确选择可用执行者，并完成所需原生执行范围确认。
- 本轮未声明先前 Defender 报警已经解决，未禁用防护、加入排除或跳过文件核验。
- 未 push、未合并 main、未发布、未迁移真实数据。
- 本报告随修复提交；代码 SHA 由 `git log -1 -- src/continuity/runtime.js` 查询，最终答复附实际提交 SHA，避免伪造自引用 commit。
