# CetaMesh Desktop 最新问题修复与回归验收报告

> 本报告记录 2026-10-17 增量修复。状态只表示下列证据所支持的范围；生产装配 Fixture、真实 Windows 安装版、第三方服务 E2E 和 GitHub Windows CI 分别判定。发行状态保持 **RELEASE_BLOCKED**。

## 基线与资料

- 修复分支：`codex/latest-audit-repair-20261017`，从当时的 `origin/main` / `7559ba6e9df7991a5a118db0f5962a0abce2f953` 创建独立 Worktree。原 `D:\GIT-QQ-BRIDGE` 脏工作树未修改；没有合并或推送。
- 发行版本：`1.0.0-rc.2`，代码变更后 Build Number 由 1069 增至 **1070**。Build 1070 仍非正式 Stable。
- 已读取 `AGENTS.md`、`RULES.md`、`PROJECT_STATE.md`、相关 Desktop 架构与发行说明、Phase 1–5 报告、10-17 增量审计及本轮用户任务。
- 用户任务提及的 `CetaMesh_Codex_最新仓库修复优先任务_2026-10-17.md` 和 `CetaMesh_核心功能全量核查清单_2026-10-16.md` 在任务附件、桌面和仓库中未找到；以下矩阵使用可访问的 10-17 增量审计原文作为追踪基线，未声称读过缺失文件。
- 10-17 报告中的链接与状态是审计证据，非执行指令；本轮状态由实际源码、失败回归、修复后测试和真实环境探测决定。

## NEW-01–NEW-10 增量结果

| ID | 本地代码状态 | 真实 E2E 状态 | 根因、修复与剩余边界 | 主要回归 |
|---|---|---|---|---|
| NEW-01 | `FIXED_CODE` / `VERIFIED_FIXTURE` | `NOT_RUN_ENVIRONMENT` | `agent.run` 丢弃 Provider 的 requestId/turnId，Smart 路由再丢一次；现从 Capability、Platform 到 Chat 逐层传递，区分 UI 请求与 Provider 身份。生产装配三轮 Smart Agent 均写入不同结果。 | `test-latest-audit-agent-identity`、`test-desktop-chat-product` |
| NEW-02 | `PARTIAL` | `NOT_RUN_ENVIRONMENT` | Codex native `turn`、Managed `requestId`、DSH native `turn` 采用各自真实身份匹配；ACK 前事件先缓冲后按 ACK 校验，旧 Session/Turn 被拒绝。DSH 0.1.5 `session/prompt` 只返回 accepted，没有可证明的 requestId↔native turn 映射；真实重放/断线 E2E 未验，不将 Fixture 算作完整关闭。 | `test-desktop-chat-product` |
| NEW-03 | `FIXED_CODE` / `VERIFIED_FIXTURE` | `NOT_RUN_ENVIRONMENT` | Chat 漏查已确认的 global Knowledge，跨分区检索又先按 scope 排列再截取；现仅在 Owner User 范围检索 global，并在授权分区并集上按相关性统一限额。Managed 仅能读取 Task 明确链接的 global ID，不扩大默认 Scope。 | `test-phase4-memory`、`test-service-container` |
| NEW-04 | `FIXED_CODE` / `VERIFIED_FIXTURE` | `NOT_RUN_ENVIRONMENT` | Work Resume 先送 Agent 再改 Task 状态；现先持久化 running，再送指令，发送失败转 `needs-reconciliation`。Broker 在发前和 ACK 后核对 Task 与 Session；暂停/取消交错时拒绝迟到 ACK。 | `test-phase3-task-handoff` |
| NEW-05 | `FIXED_CODE` / `VERIFIED_FIXTURE` | `NOT_RUN_ENVIRONMENT` | 非 Git Workspace 被 Git-only 自动恢复门挡住；现直接 Resume 明确要求 Owner 核对，Harbor 现有详情表单可记录核对结果和新的指令，随后只执行新指令。旧副作用不会自动重播。 | `test-phase3-task-handoff` |
| NEW-06 | `PARTIAL` / `VERIFIED_FIXTURE` | `NOT_RUN_ENVIRONMENT` | 原历史写失败发生在新 Agent 绑定后且不在补偿边界中；现先写持久 prepare 记录，历史提交失败取消目标、撤销绑定并阻断 Task，重启继续要求核对。已提交 history+packet 为权威，`latest.json` 仅作可恢复缓存。尚未做真实进程 kill / 磁盘满的全点位矩阵。 | `test-continuity-rollover` |
| NEW-07 | `FIXED_CODE` / `VERIFIED_FIXTURE` | Windows CI rerun `NOT_RUN_ENVIRONMENT` | GitHub run `39031564633` 的两个 BOUNDARY_ESCAPE 来自测试夹具用词法临时目录调用底层工具，未使用 Registry 的 canonical root；改为同生产契约的 canonical root。Workspace Boundary 本身未放宽。此前 CI 91 PASS/2 FAIL；本地两个专项均 PASS。未推送，无法声称 GitHub CI 已复绿。 | `test-phase1-security`、`test-phase2-chat-model` |
| NEW-08 | `NOT_RUN_ENVIRONMENT` | `NOT_RUN_ENVIRONMENT` | 无完整签名/安装版/Provider/QQ/Android 联合实测；见门禁报告。 | 现有 Fixture 仅作代码回归 |
| NEW-09 | `PARTIAL` | `NOT_RUN_ENVIRONMENT` | 已验证 Provider 身份与模型配置的本地契约；Codex CLI 真实 Task 被 Windows 沙箱拒绝，DSH API 未在线，不能宣布跨 Provider 真实接续完成。 | `test-phase3-real-codex` 实际返回环境阻塞 |
| NEW-10 | `PLANNED` / 安全默认拒绝 | `NOT_RUN_ENVIRONMENT` | 更新清单验签逻辑存在，但未配置可信固定公钥/正式签发流程；Plugin Catalog 明示 `publisherSignature: not-implemented`。没有伪造签名或降低校验。 | `test-update-source`、`test-plugin-center` |

## 失败回归与修改点位

- NEW-07：GitHub Windows job `117392884020` 日志显示 `test-phase1-security` 的 `note.txt`、`test-phase2-chat-model` 的 `utf16.txt` 均报 `BOUNDARY_ESCAPE`。修复在 `scripts/test-phase1-security.mjs`、`scripts/test-phase2-chat-model.mjs`；独立提交 `b5e1597`。
- NEW-01/02：`test-latest-audit-agent-identity` 首次运行因 `first.result.requestId === undefined` 失败；Smart 连续三轮和旧事件/ACK 前事件回归随后通过。修改 `src/capability/service.js`、`src/desktop/platform-runtime.js`、`src/desktop/chat-service.js`。
- NEW-03：global Knowledge 在 `retrievalLimit=1` 且 User Memory 先出现时缺席，新增回归先失败再通过。修改 `src/context/service.js`；跨 Scope Memory Policy 保持 authorize-before-retrieve。
- NEW-04：生产装配快速 Provider 断言在 Resume 中读到 Task=`paused`，新增回归先失败再通过；修改 `src/desktop/ui-service.js`、`src/capability/service.js`。新增失败发送、暂停/取消与 ACK 交错回归。
- NEW-05：修改 `src/desktop/ui-service.js` 和 `desktop-ui/src/app/HarborApp.tsx`；非 Git Core 重启后直接 Resume 被挡，Owner 核对后给新指令恢复，原文件内容不重播。
- NEW-06：修改 `src/continuity/runtime.js`；`rollovers.json` 写失败、重启未提交 journal、`latest.json` 缓存写失败均有专门夹具。写盘经过 `src/storage/json-file.js`。
- 上述 NEW-01–06 的代码与测试提交 SHA：`8f2545f`；NEW-07 独立提交 `b5e1597`。

## 已执行验证

| 验证 | 结果 | 证据界限 |
|---|---|---|
| `npm test` | **96 PASS / 0 FAIL / 11 NOT_RUN_ENVIRONMENT** | 统一聚合器，新增 suite 已登记。环境跳过不计为真实 E2E PASS。 |
| `npm run build:ui` | PASS | TypeScript + Vite 生产构建。 |
| `npm run build:core` | PASS | Build 1070 Windows SEA 构建及资源审计。 |
| `npm run desktop:check` | PASS | Rust 桌面端 check；仅已有 dead-code warnings。 |
| `npm run desktop:test` | PASS | 198 PASS / 0 FAIL。 |
| `npm run desktop:build` | PASS | Windows release-profile 原生 Shell 编译；仅 Rust dead-code 等 warning。首次沙箱下 Cargo build lock 拒绝访问，在同一工作树经受控提权重跑成功，未修改产品沙箱或授权。 |
| `test-core-dist` / `test-process-extension-sea` | PASS | 已构建 Core 的发行路径夹具；不等于安装版。 |
| 真实 Codex Task | `NOT_RUN_ENVIRONMENT` | CLI 0.163.0-alpha.10.2 已发现；隔离 Workspace 的 opt-in Task 返回 `CODEX_SANDBOX_UNAVAILABLE`。 |

## 旧版 91 项与 269 项检查点

以下附录保留 10-17 审计的逐项矩阵，便于对照且不隐去原证据等级。它们是**审计基线**，不是本轮逐项真实 E2E PASS；本轮变化以本报告 NEW 表和下表覆盖。其余旧编号只获得统一自动化回归，未逐项升级真实 E2E 状态。

| 原编号 / 检查点 | 本轮增量判断 |
|---|---|
| `WORKSPACE-02`, `WORKSPACE-03`, `F09.02`, `F09.03`, `F23.10`, `F23.11` | 本地 Windows 路径夹具修复并通过；GitHub CI 未重新运行，保留远端门禁。 |
| `CHAT-02`, `F04.05`, `F08.02` | Managed/Codex/Smart 身份链有生产装配回归；DSH 原生 turn 与请求的真实关联仍为 PARTIAL。 |
| `TASK-02`, `F06.10`, `F08.07` | Resume/非 Git 恢复的本地夹具通过；安装版重启与外部 Agent 未验。 |
| `HND-08`, `F08.05`, `F08.06`, `F23.07` | Handoff 持久化失败的补偿和待核对状态经故障注入；真实 kill/磁盘满矩阵未验。 |
| `MEM-02`, `F11.02` | 已确认 global Knowledge 在普通 Chat 可检索，Managed 只读明确授权引用；真实模型召回未验。 |

### 附录 A：旧 91 项 10-17 审计矩阵（原状态，以上增量覆盖）

| 编号 | 原优先级 | 10-16 原问题 | 10-17 代码复核结论 | 修复基线/阶段 | 最新源码点位 |
|---|---|---|---|---|---|
| `SEC-01` | P0 | Agent 文件写入按 medium 风险可免审批，与“写入需 Owner 批准”声明矛盾 | **`CODE_FIXED_FIXTURE_REPORTED`**：Agent `filesystem.write` 已按 high 风险及 `expectedHash` 控制，须保留每次 Owner 批准。 | PHASE-1 / 599b7e1 | [`src/capability/service.js:330`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/service.js#L330) |
| `SEC-02` | P0 | 审批执行前未核对 Task 已取消/Source Session 已换 | **`CODE_FIXED_FIXTURE_REPORTED`**：审批消费前复核 Task/Agent 绑定及 revision，源 Agent 失效后不得导入。 | PHASE-1 / 599b7e1 | [`src/capability/policy.js:10`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/policy.js#L10) |
| `SEC-03` | P1 | Capability result 异步 Abort 只保证本地返回，不证明外部副作用取消 | **`CODE_FIXED_FIXTURE_REPORTED`**：增加持久副作用 Dispatch Journal 与取消不确定状态，真实崩溃恢复仍需检验。 | PHASE-1 / 599b7e1 | [`src/capability/broker.js:1`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/broker.js#L1) |
| `SEC-04` | P1 | 磁盘读写损坏时部分 Domain 使用静默降级而不是 Schema 保护 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/memory/store.js:100`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/store.js#L100) |
| `SEC-05` | P1 | 多 Core/多进程共享 StateDir 的 JSON 更新缺进程间 CAS/锁 | **`CODE_FIXED_FIXTURE_REPORTED`**：Core StateDir owner lock 已存在；同进程、跨进程 PID 锁失效恢复须按 Windows 实测。 | PHASE-1 / 599b7e1 | [`src/app/state-owner.js:5`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/app/state-owner.js#L5) |
| `WORKSPACE-01` | P0 | 多文件 Staging 导入不是原子事务，部分文件已经改变后失败不能自动回滚 | **`CODE_FIXED_FIXTURE_REPORTED`**：多文件导入改成预检查点 + 备份 journal + 补偿回滚，非真正 OS 原子事务。 | PHASE-1 / 599b7e1 | [`src/workspace/transaction.js:1`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/workspace/transaction.js#L1) |
| `WORKSPACE-02` | P0 | Agent 直接写入使用覆盖式 writeFileSync，无原子替换且参数 append 被忽略 | **`CODE_CHANGED_CI_FAILED`**：append/expectedHash 与原子写入已存在；最新 Windows test-phase1-security 因路径 realpath 检查 FAIL，暂不能算 CI 通过。 | PHASE-1 / 599b7e1 | [`src/workspace/tools.js:112`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/workspace/tools.js#L112) |
| `WORKSPACE-03` | P1 | Windows 编码源码仅按 UTF-8 解码，GBK/UTF-16 会产生乱码或 Base64 | **`CODE_CHANGED_CI_FAILED`**：UTF16/GB18030、分页读功能已存在；最新 Windows test-phase2-chat-model 因路径 realpath 检查 FAIL，暂不能算 CI 通过。 | PHASE-2 / 23fd72f | [`src/workspace/tools.js:40`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/workspace/tools.js#L40) |
| `WORKSPACE-04` | P1 | filesystem.search 声称可搜索源码内容，实际只搜索文件名且参数错配 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/workspace/tools.js:190`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/workspace/tools.js#L190) |
| `CORE-01` | P1 | Core/会话重启后执行中的 Chat 回合不能恢复 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/chat-service.js:1630`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L1630) |
| `CORE-02` | P1 | UI/IPC 超时与后台完成状态需要统一核对 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/desktop/chat-service.js:1518`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L1518) |
| `MODEL-01` | P0 | Managed Agent 自动 Model Provider 传 null 造成工具能力检测报错 | **`CODE_FIXED_FIXTURE_REPORTED`**：自动 Provider 调用 `resolveProvider`；模型级 Tool 能力检测已补上。 | PHASE-2 / 23fd72f | [`src/model/service.js:166`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/model/service.js#L166) |
| `MODEL-02` | P0 | 模型能调用未在本轮 Manifest 授权展示的注册能力 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/model/tool-execution.js:376`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/model/tool-execution.js#L376) |
| `MODEL-03` | P0 | 工具结果直接字符串截断造成非法 JSON | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/model/tool-execution.js:100`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/model/tool-execution.js#L100) |
| `MODEL-04` | P1 | 模型工具循环达到上限可能仍以 completed 收尾 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/model/tool-execution.js:345`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/model/tool-execution.js#L345) |
| `MODEL-05` | P1 | 禁用原生 Tools 的 Provider 仍可能进入假支持路径 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/model/tool-execution.js:503`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/model/tool-execution.js#L503) |
| `MODEL-06` | P1 | 原生 Model Tool 调用与 Managed Agent 输出颗粒度不一致 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/agent/managed-agent-provider.js:131`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/agent/managed-agent-provider.js#L131) |
| `MODEL-07` | P1 | 自定义 Provider 模型列表或工具支持与具体模型不匹配 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/model/providers/openai-compatible.js:223`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/model/providers/openai-compatible.js#L223) |
| `CHAT-01` | P0 | Managed Agent 再次 Follow 重放旧事件，第二轮重复第一轮答案 | **`CODE_FIXED_FIXTURE_REPORTED`**：`sinceSequence` 游标与 Follow 去重已补。 | PHASE-2 / 23fd72f | [`src/agent/managed-agent-provider.js:352`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/agent/managed-agent-provider.js#L352) |
| `CHAT-02` | P0 | Chat/Agent 双 Request ID 失联，旧 turn/end 能终结新回合 | **`CODE_FIXED_FIXTURE_REPORTED`**：显式 Agent ACK 的 ID 已加入校验；但 Smart/Task 路径与 Codex/DSH 事件格式仍有新缺口，见 NEW-01/02。 | PHASE-2 / 23fd72f | [`src/desktop/chat-service.js:877`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L877) |
| `CHAT-03` | P0 | Managed Agent waiting 审批在 Chat 被解释成失败 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/desktop/chat-service.js:947`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L947) |
| `CHAT-04` | P0 | 审批恢复过程缺少可中止的 Managed Agent 执行句柄 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/agent/managed-agent-provider.js:371`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/agent/managed-agent-provider.js#L371) |
| `CHAT-05` | P1 | “继续”仅重发字符串继续，非执行断点接续 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/chat-service.js:1643`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L1643) |
| `CHAT-06` | P1 | 新 DSH/Agent Session 未注入既有 Chat 摘要和后续约束 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/chat-service.js:1688`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L1688) |
| `CHAT-07` | P1 | Chat 状态缺持久 Task ID 投影，详情栏关联丢失 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`desktop-ui/src/app/HarborApp.tsx:491`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-ui/src/app/HarborApp.tsx#L491) |
| `CHAT-08` | P0 | 活动回合允许修改 Workspace 绑定 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/desktop/chat-service.js:535`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L535) |
| `CHAT-09` | P1 | Harbor 消息列表 useMemo 依赖缺失，状态更新不刷新 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`desktop-ui/src/app/HarborApp.tsx:584`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-ui/src/app/HarborApp.tsx#L584) |
| `CHAT-10` | P1 | Chat 接收到重复历史 Provider 事件无幂等终态保护 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`src/desktop/chat-service.js:1046`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L1046) |
| `TASK-01` | P0 | Harbor Work 新建 Task 不会自动启动 Agent | **`CODE_FIXED_FIXTURE_REPORTED`**：`ui.task.create` 已自动派发实际 Agent；派发失败保留需要审查状态。 | PHASE-3 / 56117bf | [`src/desktop/ui-service.js:721`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L721) |
| `TASK-02` | P0 | Work 的 resume 按钮不恢复 Agent，仅改 running 状态 | **`CODE_FIXED_FIXTURE_REPORTED`**：`ui.task.resume` 改为实际调用 `agent.run`，但先 send 后 status resume 存在边界竞态，见 NEW-04。 | PHASE-3 / 56117bf | [`src/desktop/ui-service.js:804`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L804) |
| `TASK-03` | P0 | Task pause/cancel 不下行中止 Agent/工具/审批 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/ui-service.js:592`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L592) |
| `TASK-04` | P0 | 同一 Task 并发 agent.run 会合并为同一个发送而丢新指令 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/capability/service.js:552`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/service.js#L552) |
| `TASK-05` | P1 | Agent send accepted=false 后 Task 仍可能显示运行中 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/capability/service.js:626`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/service.js#L626) |
| `TASK-06` | P1 | 真实任务进度/决策/检查点未从 Agent 回合自动回写 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/task/runtime.js:340`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/task/runtime.js#L340) |
| `TASK-07` | P1 | Smart Router 基于意图而非真实 Agent 能力选择执行器 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/platform-runtime.js:15`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/platform-runtime.js#L15) |
| `TASK-08` | P1 | Harbor Work 任务状态筛选值与后端枚举不一致 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`desktop-ui/src/app/HarborApp.tsx:991`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-ui/src/app/HarborApp.tsx#L991) |
| `TASK-09` | P1 | Work 与 Chat 可能创建同一目标的不同 Task | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/ui-service.js:738`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L738) |
| `TASK-10` | P2 | 真正多 Agent 并行/依赖调度仍属于规划 | **`PLANNED_NOT_DELIVERED`**：真正多 Agent 并行/依赖调度/冲突合并仍不属于已交付功能。 | 当前非新增修复 | [`src/task/runtime.js:1`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/task/runtime.js#L1) |
| `TASK-11` | P1 | Task 创建输入长度 UI/Core 不一致 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/ui-service.js:721`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L721) |
| `HND-01` | P0 | Agent 切换前旧 Session 被 Chat 先关闭 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/desktop/chat-service.js:573`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/chat-service.js#L573) |
| `HND-02` | P0 | Handoff Bootstrap 与后续用户指令竞态 | **`CODE_FIXED_FIXTURE_REPORTED`**：Handoff 新 bootstrap 等待终态；跨工具用户回合提交身份仍需新增生产 E2E。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:543`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L543) |
| `HND-03` | P0 | Handoff 在新 Agent 真正验证前便转移执行权 | **`CODE_FIXED_FIXTURE_REPORTED`**：代码已等待 bootstrap turn 并强制 Workspace Reconciliation。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:549`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L549) |
| `HND-04` | P0 | Handoff 互斥登记晚于异步 Agent 状态查询 | **`CODE_FIXED_FIXTURE_REPORTED`**：inFlight.add 提前至异步状态读取之前。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:427`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L427) |
| `HND-05` | P0 | 旧 Agent 停止/关闭失败也可被记录为已成功交接 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:525`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L525) |
| `HND-06` | P0 | 旧 Agent 导入 Workspace 不校验当前 Session 绑定 | **`CODE_FIXED_FIXTURE_REPORTED`**：Workspace import 与当前 Session/Task 绑定、审批时 rev 已重新关联。 | PHASE-1 / 599b7e1 | [`src/capability/policy.js:10`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/policy.js#L10) |
| `HND-07` | P1 | Handoff 工作区核验复用旧快照，且不一致仍放行 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:556`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L556) |
| `HND-08` | P1 | Handoff Packet 成功状态与 latest.json 不能原子一致 | **`CODE_FIXED_FIXTURE_REPORTED`**：成功后刷新 latest Packet，但持久提交历史失败后的一致性仍有新风险，见 NEW-06。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:640`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L640) |
| `HND-09` | P1 | 历史截断后 sequence 依赖计数而可能复用编号 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:315`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L315) |
| `HND-10` | P1 | 交接包需求列表截断长度导致任务要求丢失 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/continuity/types.js:112`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/types.js#L112) |
| `HND-11` | P1 | 交接新 Session 未完整继承 Model Provider 配置 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:511`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L511) |
| `HND-12` | P1 | 上下文 Monitor 和策略不持久且 Token 估算存在偏差 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/continuity/runtime.js:710`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/runtime.js#L710) |
| `HND-13` | P1 | 新 Session 自动 Handoff 未统一注册 Task Follow | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-3 / 56117bf | [`src/capability/service.js:70`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/capability/service.js#L70) |
| `HND-14` | P2 | 跨工具切换原因被归为 other | **`CODE_FIXED_FIXTURE_REPORTED`**：`agent-provider-switch` 兼容映射和 Platform Runtime 正式 `provider-switch` 已修复。 | PHASE-6 / 7559ba6 | [`src/continuity/types.js:98`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/continuity/types.js#L98) |
| `MEM-01` | P0 | Chat 未自动提议长期记忆候选 | **`CODE_FIXED_FIXTURE_REPORTED`**：显式第一人称偏好/记住请求将创建待批准候选；非明确事实不会自动提议。 | PHASE-4 / a01401d | [`src/app/service-container.js:209`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/app/service-container.js#L209) |
| `MEM-02` | P0 | 普通聊天和 Managed Agent 未主动检索确认的 User/Global 记忆 | **`PARTIAL_OR_E2E_MISSING`**：User/Task/Workspace 自动检索已接线；普通 Chat 的 Global 知识仍未自动读取，见 NEW-03。 | PHASE-4 / a01401d | [`src/context/service.js:242`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/context/service.js#L242) |
| `MEM-03` | P0 | Harbor 缺候选记忆确认/拒绝，DTO 丢状态 | **`CODE_FIXED_FIXTURE_REPORTED`**：Harbor 候选/拒绝/批量确认接口已接入。 | PHASE-4 / a01401d | [`src/desktop/ui-service.js:888`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L888) |
| `MEM-04` | P0 | Harbor 创建用户偏好时 Scope 为 user（缺 ID） | **`CODE_FIXED_FIXTURE_REPORTED`**：用户偏好现固定 `user:desktop`。 | PHASE-4 / a01401d | [`desktop-ui/src/app/HarborApp.tsx:800`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-ui/src/app/HarborApp.tsx#L800) |
| `MEM-05` | P1 | Memory enabled/retrievalLimit 设置没有被运行时强制执行 | **`CODE_FIXED_FIXTURE_REPORTED`**：enabled/retrievalLimit 已参与 Chat 与 Managed Agent 上下文。 | PHASE-4 / a01401d | [`src/context/service.js:37`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/context/service.js#L37) |
| `MEM-06` | P0 | 候选文件读取失败时 loaded 标记过早置真，存在覆盖风险 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/memory/runtime.js:113`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/runtime.js#L113) |
| `MEM-07` | P0 | Memory Store 对结构合法性不足、可能静默丢记录 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/memory/store.js:93`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/store.js#L93) |
| `MEM-08` | P1 | 候选确认分多次落盘且缺崩溃恢复事务 | **`CODE_FIXED_FIXTURE_REPORTED`**：confirming 写盘、确定性 Memory ID 和启动恢复已实现。 | PHASE-4 / a01401d | [`src/memory/runtime.js:463`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/runtime.js#L463) |
| `MEM-09` | P1 | Memory UI 只抓200条并用 Date.parse 解析数值时间 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-4 / a01401d | [`src/memory/runtime.js:210`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/runtime.js#L210) |
| `MEM-10` | P1 | 记忆内容长度 UI 8000 与后端 4000 不一致 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-4 / a01401d | [`src/desktop/ui-service.js:909`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L909) |
| `MEM-11` | P1 | QQ 社交记忆为手动增量导入且原条目更新不会同步 | **`CODE_FIXED_FIXTURE_REPORTED`**：QQ 增量导入、原始内容更新/冲突处理已补，真实 QQ 双群未实测。 | PHASE-4 / a01401d | [`src/memory/adapters/qq.js:138`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/adapters/qq.js#L138) |
| `MEM-12` | P1 | Task Memory 引用缺 Scope，Handoff 无法跨 Scope 正确取回 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-4 / a01401d | [`src/context/service.js:16`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/context/service.js#L16) |
| `MEM-13` | P1 | Memory 待处理候选容量满后阻断新候选 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-4 / a01401d | [`src/memory/runtime.js:396`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/runtime.js#L396) |
| `MEM-14` | P1 | Managed Agent Memory 权限类型与实际偏好 Scope 不匹配 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-4 / a01401d | [`src/memory/policy.js:34`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/memory/policy.js#L34) |
| `MCP-01` | P1 | MCP“启用”与“启动”分离，需确保 UI 不把 Enabled 当 Running | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-5 / 774e324+ | [`src/integrations/mcp-runtime.js:237`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/integrations/mcp-runtime.js#L237) |
| `MCP-02` | P1 | 安装版 MCP child 与真实 DSH/QQ 工具调用尚缺全量 E2E | **`PARTIAL_OR_E2E_MISSING`**：本地 Core/SEA stdio 测试报告称通过；无真实授权 SnowLuma、DSH E2E。 | PHASE-5 / 774e324+ | [`src/integrations/mcp-runtime.js:45`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/integrations/mcp-runtime.js#L45) |
| `MCP-03` | P1 | Plugin 逐工具开关与 DSH 侧预设/Bridge 社交开关未形成统一执行权 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-5 / 774e324+ | [`src/integrations/tool-policy.js:1`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/integrations/tool-policy.js#L1) |
| `MCP-04` | P1 | MCP 工具目录静态登记不等于已发现的真实 Schema | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-5 / 774e324+ | [`src/integrations/registry.js:108`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/integrations/registry.js#L108) |
| `QQ-01` | P1 | QQ Bionic Tool Pack 和 Legacy Social 运行流程未完全接线 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-5 / 774e324+ | [`src/bridge.js:1590`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/bridge.js#L1590) |
| `QQ-02` | P1 | QQ 真实发送/收取/去重与官方卡片仍缺 Windows 实测 | **`PARTIAL_OR_E2E_MISSING`**：真实 SnowLuma/OneBot/卡片/授权群连续收发仍未测。 | PHASE-5 / 774e324+ | [`src/bridge.js:8695`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/bridge.js#L8695) |
| `QQ-03` | P2 | 部分 Bionic 扩展语音/贴纸/外发能力不支持或默认关闭 | **`PLANNED_NOT_DELIVERED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | 当前非新增修复 | [`src/integrations/catalog.js:75`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/integrations/catalog.js#L75) |
| `MEDIA-01` | P1 | Desktop 文件选择器仅支持文本源码，图片与富媒体链路尚未交付 | **`PARTIAL_OR_E2E_MISSING`**：已明确只允许文本/源码附件；图片视觉、音频、PDF 等能力尚未交付。 | PHASE-6 / 7559ba6 | [`desktop-shell/src/webview_ui.rs:250`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-shell/src/webview_ui.rs#L250) |
| `EXT-01` | P1 | 普通 Extension ProcessHost 不是 OS 沙箱，需要明示风险 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-5 / 774e324+ | [`src/extension/review.js:89`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/extension/review.js#L89) |
| `PLUGIN-01` | P1 | 插件目录未实现发布者签名，verified 标记不足以证明作者身份 | **`PARTIAL_OR_E2E_MISSING`**：产品已不再宣称目录 verified 等于发布者身份；Publisher Signature 仍是 not-implemented。 | PHASE-5 / 774e324+ | [`src/plugin-center/service.js:353`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/plugin-center/service.js#L353) |
| `PLUGIN-02` | P1 | 插件在线源/SDK 安装与生命周期缺真实线上目录验收 | **`PARTIAL_OR_E2E_MISSING`**：loopback Catalog fixture 通过；真实 HTTPS Catalog/签名/安装版未接通。 | PHASE-5 / 774e324+ | [`src/plugin-center/service.js:108`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/plugin-center/service.js#L108) |
| `MESH-01` | P0 | 设备 Mesh 启用开关未接入运行时（隐私/授权预期不一致） | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/mesh/node.js:58`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/mesh/node.js#L58) |
| `MESH-02` | P1 | 远程 Task/Memory/文件执行器未挂载，能力声明存在“可用性假象” | **`PARTIAL_OR_E2E_MISSING`**：当前未接线的远程 Task/Memory 能力已明确标 unavailable，功能本身仍未实现。 | PHASE-6 / 7559ba6 | [`src/mesh/node.js:65`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/mesh/node.js#L65) |
| `MESH-03` | P1 | 设备在线判定 TTL 设置与 Mesh 常量未接线 | **`CODE_FIXED_FIXTURE_REPORTED`**：presenceTtlMs 已进入 Trust 与运行态。 | PHASE-6 / 7559ba6 | [`src/mesh/trust.js:37`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/mesh/trust.js#L37) |
| `WORKSHOP-01` | P1 | Workshop 外部提议/Owner 审批链只见 Domain，Harbor 无正式端到端入口 | **`PARTIAL_OR_E2E_MISSING`**：Harbor Workshop Inbox、Private QQ Submit/Status/Supplement 已接入；真实授权 QQ 仍未实测。 | PHASE-6 / 7559ba6 | [`desktop-ui/src/app/HarborApp.tsx:1006`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-ui/src/app/HarborApp.tsx#L1006) |
| `SETTINGS-01` | P1 | 多项用户 Settings 写入但运行时无效 | **`PARTIAL_OR_E2E_MISSING`**：Harbor 只开放与运行态已接线的 editable keys；未接线设置隐藏而不是虚假生效。 | PHASE-6 / 7559ba6 | [`src/desktop/ui-service.js:33`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L33) |
| `SETTINGS-02` | P1 | Settings 合法 JSON 但类型不合 Schema 时缺原数据备份 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-1 / 599b7e1 | [`src/settings/store.js:26`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/settings/store.js#L26) |
| `UPDATE-01` | P1 | 更新检查安全默认无公钥，首启无法真正更新 | **`DEPLOYMENT_BLOCKED_BY_KEY`**：默认 pinnedPublicKey 为空时拒绝信任更新清单是安全要求；须部署正式签名密钥/发布配置。 | 当前非新增修复 | [`src/update/verify.js:5`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/update/verify.js#L5) |
| `INSTALL-01` | P0 | Windows 安装版/更新覆盖/SEA/MCP 子进程尚未完成真实 RC 端到端 | **`INSTALLER_E2E_NOT_RUN`**：无正式 Windows Release Candidate 从安装到完整外部任务的 E2E；GitHub Release 当前为空。 | 当前非新增修复 | [`desktop-shell/src/installer.rs:386`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-shell/src/installer.rs#L386) |
| `INSTALL-02` | P1 | Windows Codex .cmd Shim 可能误用 SEA Core 作为 Node | **`CODE_FIXED_FIXTURE_REPORTED`**：`.cmd` 经独立 Node 运行，不能把 SEA Core 当 Node；真实 Codex Task 仍受严格 Sandbox 约束。 | PHASE-5 / 774e324+ | [`src/agent/cli-agent-process.js:202`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/agent/cli-agent-process.js#L202) |
| `INSTALL-03` | P1 | Codex CLI 检查过于严格，将版本兼容性问题显示成“未安装” | **`CODE_FIXED_FIXTURE_REPORTED`**：已区分安装、兼容、认证、Sandbox；真实 Codex 执行仍需兼容可验证沙箱。 | PHASE-5 / 774e324+ | [`src/agent/codex-agent-provider.js:167`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/agent/codex-agent-provider.js#L167) |
| `UI-01` | P1 | Harbor 缺跨 Agent Handoff、任务转交和原生审计视图 | **`CODE_FIXED_FIXTURE_REPORTED`**：Harbor 已有任务/Agent Handoff 与历史界面；真实双 Provider 交接未做。 | PHASE-3 / 56117bf | [`src/desktop/ui-service.js:859`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L859) |
| `UI-02` | P1 | UI 上工具/Agent“就绪”可能仅反映注册而非真实可执行 | **`CODE_FIXED_FIXTURE_REPORTED`**：工具运行态/注册态/模型认证按层区分；授权实测缺失。 | PHASE-5 / 774e324+ | [`src/desktop/ui-service.js:170`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/src/desktop/ui-service.js#L170) |
| `UI-03` | P1 | 消息显示状态推导缺 statusMessage 依赖及占位恢复 | **`CODE_FIXED_FIXTURE_REPORTED`**：相关修复在 Phase 报告中登记，现阶段只认代码修复与已记录测试；外部 Windows E2E 仍需完成。 | PHASE-2 / 23fd72f | [`desktop-ui/src/app/HarborApp.tsx:592`](https://github.com/chx6418-source/whalebridge/blob/7559ba6e9df7991a5a118db0f5962a0abce2f953/desktop-ui/src/app/HarborApp.tsx#L592) |

### 附录 B：F01–F25 / 269 项 10-17 审计矩阵（原状态，以上增量覆盖）

### F01 · Core 运行与生命周期（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F01.01` | `IMPLEMENTED_UNVERIFIED` | 无 QQ / DSH / 插件 / Agent 时 Core 仍可启动，Standalone Chat 不受阻 | 无独立已定位问题 |
| `F01.02` | `IMPLEMENTED_UNVERIFIED` | 应用启动、单实例检测、Core Worker 创建和服务装配顺序正确 | `SEC-05` |
| `F01.03` | `IMPLEMENTED_UNVERIFIED` | WebView2 / React 与 Rust Host / Core 之间的握手、IPC 鉴权、角色及方法白名单正确 | 无独立已定位问题 |
| `F01.04` | `CODE_UPDATED_E2E_UNVERIFIED` | Core 启动失败、崩溃、退出后有明确状态、日志与受控恢复，不出现假 Ready | `CORE-01` |
| `F01.05` | `CODE_UPDATED_E2E_UNVERIFIED` | Core 重启后 UI 事件 epoch/cursor 能复位，重新订阅、不丢事件 | `CORE-01`, `CORE-02` |
| `F01.06` | `IMPLEMENTED_UNVERIFIED` | 多窗口、最小化/托盘、退出和关闭任务时进程清理完整 | 无独立已定位问题 |
| `F01.07` | `IMPLEMENTED_UNVERIFIED` | 生产版完全离线加载前端资源，不启动旧 localhost HTTP Console | 无独立已定位问题 |
| `F01.08` | `IMPLEMENTED_UNVERIFIED` | 桌面进程、子进程、命名管道、WebView 生命周期一致，失败不会留下幽灵进程 | 无独立已定位问题 |
| `F01.09` | `IMPLEMENTED_UNVERIFIED` | IPC 超时、取消、重复请求、Core 重连与错误码保持一致 | `CORE-02`, `SEC-03` |
| `F01.10` | `IMPLEMENTED_UNVERIFIED` | 安装版脱离系统 Node、仓库源码和 Vite 开发服务器独立运行 | `INSTALL-01` |

### F02 · Model Provider 配置与连接（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F02.01` | `IMPLEMENTED_UNVERIFIED` | DeepSeek 官方、OpenAI、OpenAI-compatible 可配置，支持实际授权的模型及自定义 ID | 无独立已定位问题 |
| `F02.02` | `IMPLEMENTED_UNVERIFIED` | API Key 安全保存、脱敏回显，重启后仍可用；日志和前端 DTO 不泄漏明文 | 无独立已定位问题 |
| `F02.03` | `IMPLEMENTED_UNVERIFIED` | 新 Key / 错误 Key / 失效 Key / 无 Key 情况给出可辨识状态 | 无独立已定位问题 |
| `F02.04` | `IMPLEMENTED_UNVERIFIED` | 自定义 Base URL 与 API Key 各自修改不互相覆盖；测试失败保留旧有效凭据 | 无独立已定位问题 |
| `F02.05` | `CODE_UPDATED_E2E_UNVERIFIED` | 选定 Provider/Model 真实决定下次请求目标，不被默认值或旧 Session 覆盖 | `MODEL-01`, `HND-11`, `NEW-09` |
| `F02.06` | `IMPLEMENTED_UNVERIFIED` | 模型目录 /models 缺失、慢、报错或为空时不会拖住历史与发送；可手填模型 | `MODEL-07` |
| `F02.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 模型是否支持 Tool Calling / Streaming / Reasoning 的参数按模型能力发出 | `MODEL-01`, `MODEL-05`, `MODEL-07` |
| `F02.08` | `IMPLEMENTED_UNVERIFIED` | 有效 DeepSeek 默认值与旧别名迁移、旧会话模型回退不会发送已失效 ID | 无独立已定位问题 |
| `F02.09` | `PARTIAL_OR_UNVERIFIED` | 连接测试区分 reachability、auth、model-list 和真实 inference，不把 /models 200 当推理成功 | `NEW-08` |
| `F02.10` | `IMPLEMENTED_UNVERIFIED` | 本地 loopback 模型网关如被支持，遵守受控 HTTP 例外；远程地址保留 HTTPS 限制 | 无独立已定位问题 |
| `F02.11` | `IMPLEMENTED_UNVERIFIED` | 可配置超时与取消并存，SSE 无响应/半断流按时间界限终止 | 无独立已定位问题 |
| `F02.12` | `IMPLEMENTED_UNVERIFIED` | Provider 状态区分 configured/reachable/authenticated/inferencing，不凭注册即标 Ready | `MODEL-07` |
| `F02.13` | `CODE_UPDATED_E2E_UNVERIFIED` | 模型用量、消耗、错误和可用性反馈真实；与实际响应模型 ID 相符 | `HND-12` |

### F03 · Product Intelligence / Smart Router / Tool Loop（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F03.01` | `IMPLEMENTED_UNVERIFIED` | 模型系统上下文正确表明自己运行在 CetaMesh，而不是普通裸 API Chat | 无独立已定位问题 |
| `F03.02` | `CODE_UPDATED_E2E_UNVERIFIED` | 动态能力 Manifest 只列当前真实可用、可见、可授权能力，具备描述和参数 Schema | `MODEL-01`, `MODEL-02`, `MCP-04` |
| `F03.03` | `CODE_DEFECT_OPEN` | Smart Router 能区分普通问答、单工具、持久任务与复杂 Agent 工作，不误路由 | `TASK-07`, `NEW-01` |
| `F03.04` | `CODE_UPDATED_E2E_UNVERIFIED` | 模型可发出结构化 tool_call，并经 Capability Broker 执行后把结果回传模型继续生成 | `MODEL-02`, `MODEL-03`, `WORKSPACE-04` |
| `F03.05` | `CODE_UPDATED_E2E_UNVERIFIED` | 不支持原生 tools 的 Provider 明确降级，不通过任意自由文本解析来执行命令 | `MODEL-05` |
| `F03.06` | `CODE_UPDATED_E2E_UNVERIFIED` | 多工具同轮调用、审批暂停/恢复、拒绝、超时、失败后结果消息协议完整 | `MODEL-03`, `MODEL-04` |
| `F03.07` | `CODE_UPDATED_E2E_UNVERIFIED` | Tool Loop 有轮数、调用次数、令牌/输出尺寸、总超时和取消上限 | `MODEL-03`, `MODEL-04` |
| `F03.08` | `CODE_UPDATED_E2E_UNVERIFIED` | 本轮无工具调用时仍流式显示，不因 supportsTools=true 强行非流式等待 | `MODEL-05`, `MODEL-06` |
| `F03.09` | `PARTIAL_OR_UNVERIFIED` | Context 注入不会因为超预算省掉关键能力最小语义，也不会跨越 Memory/Task Scope | `NEW-03` |
| `F03.10` | `IMPLEMENTED_UNVERIFIED` | 恶意文件、MCP 返回、网页或 Memory 的 prompt injection 不会改变服务端权限 | 无独立已定位问题 |
| `F03.11` | `CODE_DEFECT_OPEN` | 模型给出的 Task / Agent 任务委托真正生成可追踪的 CetaMesh Task，而不是裸 Agent Session | `NEW-01` |

### F04 · Chat 会话与消息（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F04.01` | `IMPLEMENTED_UNVERIFIED` | 新建、切换、重命名、归档、恢复、删除会话都真实操作持久化数据 | 无独立已定位问题 |
| `F04.02` | `IMPLEMENTED_UNVERIFIED` | 发送后用户消息立即出现，发送失败保留重试，不会延迟到 Assistant 完成 | 无独立已定位问题 |
| `F04.03` | `CODE_UPDATED_E2E_UNVERIFIED` | 普通模型 Streaming 增量持续显示，而非等完整结果一次性刷新 | `MODEL-06`, `CHAT-09` |
| `F04.04` | `CODE_DEFECT_OPEN` | Agent/Tool 执行显示开始、进度、审批、完成、失败；最终结果与事件顺序一致 | `MODEL-04`, `CHAT-01`, `CHAT-02`, `CHAT-03`, `CHAT-10`, `NEW-01`, `NEW-02` |
| `F04.05` | `CODE_UPDATED_E2E_UNVERIFIED` | 后台历史 load、catalog、Memory、审批刷新不会清空或覆盖已显示消息 | `CORE-02`, `CHAT-09`, `UI-03` |
| `F04.06` | `IMPLEMENTED_UNVERIFIED` | 过期异步请求不能覆盖新快照；消息按稳定 ID 去重且严格排序 | 无独立已定位问题 |
| `F04.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 单次发送、停止、取消、重试、继续均真实到达 Core，取消后不继续计费 | `CHAT-04`, `CHAT-05`, `SEC-03` |
| `F04.08` | `CODE_UPDATED_E2E_UNVERIFIED` | 模型、Agent、模式、工具、Workspace 切换是会话级选择，下一条消息真实生效 | `CHAT-08`, `HND-01` |
| `F04.09` | `CODE_DEFECT_OPEN` | 会话切换或重启后配置与历史保持；旧 Agent 事件不会混入新会话 | `CORE-01`, `CHAT-01`, `CHAT-02`, `CHAT-06`, `CHAT-07`, `CHAT-10`, `NEW-01`, `NEW-02` |
| `F04.10` | `IMPLEMENTED_UNVERIFIED` | 虚拟消息列表支持 100/200/500+ 条历史、向上分页、滚动锚点、底部跟随 | 无独立已定位问题 |
| `F04.11` | `IMPLEMENTED_UNVERIFIED` | Markdown、代码块、复制、引用、图片和长文本不崩溃，不执行危险 HTML | 无独立已定位问题 |
| `F04.12` | `CODE_UPDATED_E2E_UNVERIFIED` | Tool/Approval/Agent 卡片的状态在发起、等待、拒绝和完成后及时更新 | `CHAT-03` |
| `F04.13` | `IMPLEMENTED_UNVERIFIED` | 删除运行中的 Chat 能受控取消后台模型、Agent 和审批等待 | 无独立已定位问题 |
| `F04.14` | `IMPLEMENTED_UNVERIFIED` | 聊天标题、历史、搜索、列表性能、状态提示无明显延迟 | 无独立已定位问题 |
| `F04.15` | `IMPLEMENTED_UNVERIFIED` | 断网、Provider 404/429/500、API 错误、Core 重启等场景可解释并恢复 | 无独立已定位问题 |

### F05 · 附件 / 图片 / 富媒体（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F05.01` | `PARTIAL_OR_UNVERIFIED` | 文件和图片选择器、拖入、大小/类型校验正常，错误能定位到具体附件 | `MEDIA-01`, `WORKSPACE-03` |
| `F05.02` | `IMPLEMENTED_UNVERIFIED` | 消息发送与附件绑定到正确 Session/Message，重试不重复上传 | 无独立已定位问题 |
| `F05.03` | `IMPLEMENTED_UNVERIFIED` | 本地路径、文件内容、凭据不在前端和非授权服务中无界暴露 | 无独立已定位问题 |
| `F05.04` | `MISSING_OR_NOT_DELIVERED` | 模型具备视觉/附件能力时按真实协议发送，不支持时明确告知 | `MEDIA-01` |
| `F05.05` | `MISSING_OR_NOT_DELIVERED` | 消息图片预览、下载、保存、复制与失效文件提示正常 | `MEDIA-01` |
| `F05.06` | `IMPLEMENTED_UNVERIFIED` | 附件和 Artifact 的安全打开实施 canonical path/scheme/allowlist 校验 | 无独立已定位问题 |
| `F05.07` | `IMPLEMENTED_UNVERIFIED` | 重启后附件元数据与关联关系保持；缓存清理不会误删唯一原文件 | 无独立已定位问题 |

### F06 · Persistent Task（任务归 CetaMesh）（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F06.01` | `CODE_UPDATED_E2E_UNVERIFIED` | 创建 Task（目标、需求、Workspace、优先级等）并持久化，不依赖 Agent Session 存活 | `TASK-01`, `TASK-11` |
| `F06.02` | `CODE_UPDATED_E2E_UNVERIFIED` | 任务列表、详情、状态、进度、阶段和最近活动正确显示 | `CHAT-07`, `TASK-06`, `TASK-08` |
| `F06.03` | `CODE_UPDATED_E2E_UNVERIFIED` | Task start/pause/resume/wait/block/complete/fail/cancel 生命周期合法 | `TASK-01`, `TASK-02`, `TASK-03`, `TASK-05`, `NEW-04` |
| `F06.04` | `CODE_UPDATED_E2E_UNVERIFIED` | Task 的 Agent attach/detach、迁移与重复调用保持一致，不产生半绑定状态 | `HND-04`, `NEW-06` |
| `F06.05` | `CODE_UPDATED_E2E_UNVERIFIED` | Checkpoint、下一步动作、决策、验收条件、测试证据能写入并读取 | `TASK-06` |
| `F06.06` | `CODE_UPDATED_E2E_UNVERIFIED` | Artifacts 与 Memory 引用可挂到正确任务并且可在 UI 查看 | `MEM-12` |
| `F06.07` | `CODE_DEFECT_OPEN` | 重复请求、重试、跨进程重启不重复创建任务或重复执行高风险操作 | `TASK-04`, `TASK-09`, `NEW-01` |
| `F06.08` | `CODE_UPDATED_E2E_UNVERIFIED` | Task 与 Workspace 绑定冲突触发 Reconciliation Gate，不允许误操作其他目录 | `CHAT-08` |
| `F06.09` | `PARTIAL_OR_UNVERIFIED` | 单任务多 Agent 参与、子任务依赖/并行调度如尚未实现必须明确能力边界 | `TASK-07`, `TASK-09`, `TASK-10` |
| `F06.10` | `CODE_UPDATED_E2E_UNVERIFIED` | 任务完成后实际文件/交付物与状态一致，失败任务可恢复或安全终止 | `TASK-01`, `TASK-05`, `TASK-06`, `NEW-04`, `NEW-05` |
| `F06.11` | `CODE_UPDATED_E2E_UNVERIFIED` | 任务删除或取消不会留下正在运行的后台 Agent / test / 审批链 | `CHAT-04`, `TASK-03` |

### F07 · Agent Broker / Managed Agent / 外部 Provider（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F07.01` | `CODE_UPDATED_E2E_UNVERIFIED` | Agent Registry 列出 CetaMesh Managed Agent、DSH、Codex、ZCode 真实状态（不伪造支持） | `UI-02` |
| `F07.02` | `CODE_UPDATED_E2E_UNVERIFIED` | Provider 注册、安装检测、版本、认证、健康、可执行/需要任务状态互不混淆 | `INSTALL-03` |
| `F07.03` | `PARTIAL_OR_UNVERIFIED` | Managed Agent 能在 Model Runtime 上连续执行 Tool Loop，不因 null content 崩溃 | `MODEL-01`, `MODEL-05`, `MODEL-06`, `CHAT-01`, `CHAT-03`, `WORKSPACE-03`, `WORKSPACE-04` |
| `F07.04` | `IMPLEMENTED_UNVERIFIED` | DSH / Codex 创建 Session 时按真实 Provider 绑定，不错误绑定到 Managed Agent | 无独立已定位问题 |
| `F07.05` | `CODE_DEFECT_OPEN` | Agent 创建、发送、Follow、Cancel、Stop、关闭、失败回滚均按 Provider 契约正常 | `CHAT-02`, `CHAT-04`, `TASK-03`, `TASK-04`, `TASK-05`, `TASK-07`, `HND-13`, `NEW-01`, `NEW-02` |
| `F07.06` | `PARTIAL_OR_UNVERIFIED` | Agent 运行绑定到正确 Task / Workspace / Owner Approval，不能绕权修改权威工作区 | `NEW-04` |
| `F07.07` | `CODE_UPDATED_E2E_UNVERIFIED` | Codex CLI 在 Windows 的 codex.exe/codex.cmd、空格路径、PATH、登录后刷新均正确检测 | `INSTALL-02`, `INSTALL-03`, `NEW-08`, `NEW-09` |
| `F07.08` | `PARTIAL_OR_UNVERIFIED` | Codex 代理/环境变量最小授权、用户配置继承、Staging + Broker 导入边界有效 | `NEW-09` |
| `F07.09` | `CODE_UPDATED_E2E_UNVERIFIED` | Codex 模型/推理级别按 Session/Task 隔离，两个并行任务不串配置 | `HND-11`, `NEW-09` |
| `F07.10` | `PARTIAL_OR_UNVERIFIED` | Codex JSONL 增量、末尾无换行、错误事件可以被 Chat 正确消费 | `NEW-02` |
| `F07.11` | `IMPLEMENTED_UNVERIFIED` | DSH Desktop 安装/运行状态与 DSH Web API 可认证和 Agent Ready 分开 | 无独立已定位问题 |
| `F07.12` | `IMPLEMENTED_UNVERIFIED` | DSH_HOME、selectModel、慢 API、Follow 断线、鉴权过期、独立 profile 正确处理 | 无独立已定位问题 |
| `F07.13` | `IMPLEMENTED_UNVERIFIED` | ZCode 无受支持外部控制接口时标 Unsupported，不使用假 CLI/GUI 自动化冒充支持 | 无独立已定位问题 |

### F08 · Continuity / 会话接续与跨 Agent Handoff（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F08.01` | `IMPLEMENTED_UNVERIFIED` | 同 Provider 新会话 rollover 后 Task 不丢、进度和下一步动作保持 | 无独立已定位问题 |
| `F08.02` | `CODE_DEFECT_OPEN` | DSH ↔ Codex ↔ Managed Agent 切换时维护 provider+sessionId 身份与事件隔离 | `CHAT-01`, `CHAT-02`, `HND-01`, `HND-02`, `HND-06`, `HND-11`, `UI-01`, `NEW-01`, `NEW-02`, `NEW-09` |
| `F08.03` | `CODE_UPDATED_E2E_UNVERIFIED` | 上下文达到阈值后可受控生成 Handoff Packet，包含 Task Brief、Checkpoint、Workspace、Memory 引用 | `TASK-06`, `HND-08`, `HND-09`, `HND-10`, `HND-12`, `HND-14`, `MEM-12` |
| `F08.04` | `CODE_UPDATED_E2E_UNVERIFIED` | 新 Agent 不依赖完整聊天日志仍能依据当前真实工作区接续 | `CHAT-06`, `HND-02`, `HND-03`, `HND-10` |
| `F08.05` | `CODE_UPDATED_E2E_UNVERIFIED` | Workspace 的 Git SHA、Diff、文件变动会与 Checkpoint 核对并明确标记冲突 | `HND-07`, `NEW-06` |
| `F08.06` | `CODE_UPDATED_E2E_UNVERIFIED` | 旧 Session 停止/新 Session 初始化失败后，Task 可回滚到旧状态或进入待恢复态 | `HND-01`, `HND-03`, `HND-04`, `HND-05`, `HND-08`, `NEW-06` |
| `F08.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 断线/重启/异常关闭后的 Task 与 Agent 关系可恢复而非丢失 | `CORE-01`, `CHAT-05`, `CHAT-06`, `TASK-02`, `HND-12`, `NEW-05` |
| `F08.08` | `CODE_UPDATED_E2E_UNVERIFIED` | 不同 Agent 之间不自动继承未批准权限，审批与授予范围可审计 | `HND-06` |
| `F08.09` | `CODE_UPDATED_E2E_UNVERIFIED` | 已失效会话和旧 Context 不会污染新任务或越过 Workspace Scope | `CHAT-10`, `TASK-04`, `TASK-09`, `HND-04`, `HND-05` |
| `F08.10` | `CODE_UPDATED_E2E_UNVERIFIED` | 实际 handoff 后继续工作、生成结果并通过验收，不只是 packet JSON 测试 | `HND-02`, `HND-03`, `HND-07`, `HND-13`, `HND-14`, `UI-01`, `NEW-08` |

### F09 · Workspace / 文件 / Git / Test / Artifact（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F09.01` | `PARTIAL_OR_UNVERIFIED` | 工作区创建、选择、切换、列表、关闭、重启恢复；无 Workspace 时明确引导绑定 | `NEW-05` |
| `F09.02` | `CI_FAILED_NEEDS_REPRO` | 文件搜索、读取、写入、删除等仅在授权工作区生效 | `MODEL-03`, `CHAT-08`, `SEC-01`, `WORKSPACE-02`, `WORKSPACE-03`, `WORKSPACE-04`, `NEW-07` |
| `F09.03` | `CI_FAILED_NEEDS_REPRO` | Windows 大小写、8.3 短路径、junction、symlink、UNC、目录嵌套等隔离检查 | `NEW-07` |
| `F09.04` | `IMPLEMENTED_UNVERIFIED` | Git status/diff/commit 在正确 Workspace 执行，危险操作需适当审批 | 无独立已定位问题 |
| `F09.05` | `IMPLEMENTED_UNVERIFIED` | 测试运行只接受 allowlisted commands；test.run 无默认 Agent 自动执行授权 | 无独立已定位问题 |
| `F09.06` | `CODE_UPDATED_E2E_UNVERIFIED` | Agent Staging 与权威工作区严格隔离，变更经过 Diff/Hash/Approval/安全导入 | `HND-06`, `SEC-01`, `WORKSPACE-01` |
| `F09.07` | `PARTIAL_OR_UNVERIFIED` | 导入失败可回滚；敏感文件、其他工作区、越界路径不被复制/覆盖 | `WORKSPACE-01`, `WORKSPACE-02` |
| `F09.08` | `CODE_UPDATED_E2E_UNVERIFIED` | Workspace 文件变化与 Task/Agent 快照可同步，冲突需要人工 Reconciliation | `HND-07`, `WORKSPACE-01` |
| `F09.09` | `IMPLEMENTED_UNVERIFIED` | Artifacts 能登记、列出、预览、安全打开、删除或保留，受 Scope 保护 | 无独立已定位问题 |
| `F09.10` | `PARTIAL_OR_UNVERIFIED` | Workspace 损坏、被移动、无权限、只读目录、磁盘不足时不会污染其他任务 | `WORKSPACE-02`, `NEW-05` |
| `F09.11` | `CODE_UPDATED_E2E_UNVERIFIED` | 多任务共用工作区时冲突避免或检测机制有真实验证/明确限制 | `HND-05`, `WORKSPACE-01` |

### F10 · Capability Broker / 审批 / 权限（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F10.01` | `IMPLEMENTED_UNVERIFIED` | Owner、Agent、Extension、外部用户的 Actor/Scope/Grant 不相互冒用 | 无独立已定位问题 |
| `F10.02` | `IMPLEMENTED_UNVERIFIED` | 请求 capability 按规则执行：注册→授权→风险分级→审批→执行→记录结果 | 无独立已定位问题 |
| `F10.03` | `CODE_UPDATED_E2E_UNVERIFIED` | 默认拒绝未注册/未知/缺描述/缺 Scope 的能力，不用 UI 状态绕过 Broker | `MODEL-02` |
| `F10.04` | `PARTIAL_OR_UNVERIFIED` | 敏感能力（写文件、测试、发送消息、导入、删除）需要正确的单次审批 | `SEC-01`, `WORKSPACE-02` |
| `F10.05` | `CODE_UPDATED_E2E_UNVERIFIED` | 审批请求的指纹、TTL、一次性和重放保护真实有效 | `SEC-02` |
| `F10.06` | `CODE_UPDATED_E2E_UNVERIFIED` | 批准、拒绝、过期、撤销后工具循环都能正确恢复或终止 | `CHAT-03`, `CHAT-04`, `TASK-03`, `SEC-02`, `SEC-03` |
| `F10.07` | `IMPLEMENTED_UNVERIFIED` | 多 tool_calls 中部分等待审批时所有 callId 的结构化结果完整 | 无独立已定位问题 |
| `F10.08` | `CODE_UPDATED_E2E_UNVERIFIED` | 权限范围只给当前 Task/Workspace，跨任务与跨数据 Scope fail-closed | `MODEL-02`, `CHAT-08`, `HND-06`, `SEC-02`, `NEW-04` |
| `F10.09` | `IMPLEMENTED_UNVERIFIED` | 恶意插件/MCP/模型输出无法直接获得 shell/process/native 等禁止能力 | 无独立已定位问题 |
| `F10.10` | `IMPLEMENTED_UNVERIFIED` | Capability Audit 记录足够诊断但不泄露 API Key、正文、密钥 | 无独立已定位问题 |
| `F10.11` | `IMPLEMENTED_UNVERIFIED` | 权限变更之后所有 Registry、Agent Context、UI 状态和实际执行即时一致 | 无独立已定位问题 |

### F11 · Memory / 长期记忆 / 关联（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F11.01` | `CODE_UPDATED_E2E_UNVERIFIED` | Working、Chat、User、Task、Workspace、Social、Knowledge、Skill 等记忆分类清楚 | `MEM-04`, `MEM-14` |
| `F11.02` | `CODE_UPDATED_E2E_UNVERIFIED` | 记忆创建/读取/编辑/删除/置顶/检索/分页/统计正常 | `MEM-04`, `MEM-09`, `MEM-10` |
| `F11.03` | `CODE_UPDATED_E2E_UNVERIFIED` | 候选记忆提议、确认、拒绝与长期记忆保存真实执行 | `MEM-01`, `MEM-03`, `MEM-08`, `MEM-13` |
| `F11.04` | `CODE_UPDATED_E2E_UNVERIFIED` | Memory Link 可以关联 Task、Workspace、会话及实体，跨 Scope 必须明确授权 | `MEM-12` |
| `F11.05` | `PARTIAL_OR_UNVERIFIED` | 记忆 Context Pack 可按当前 Task/Workspace 授权、检索相关内容并有上限 | `MEM-02`, `MEM-05`, `MEM-14`, `NEW-03` |
| `F11.06` | `CODE_UPDATED_E2E_UNVERIFIED` | 模型或工具创建记忆不会无审批写入敏感长期偏好 | `MEM-03`, `MEM-05` |
| `F11.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 重启后记忆仍在，写失败回滚，损坏文件可诊断/恢复 | `MEM-06`, `MEM-07`, `MEM-08`, `SEC-04` |
| `F11.08` | `PARTIAL_OR_UNVERIFIED` | Memory 与 Task/Agent/Chat 结合的读写必须真正发生，不是仅有 Memory 独立页面 | `MEM-01`, `MEM-02`, `MEM-11`, `NEW-03` |
| `F11.09` | `PARTIAL_OR_UNVERIFIED` | 长对话切换、新会话、Agent Handoff 后经允许的记忆能够继续被正确检索 | `MEM-01`, `MEM-02`, `MEM-14`, `NEW-03` |
| `F11.10` | `CODE_UPDATED_E2E_UNVERIFIED` | 不同 QQ/用户/工作区社交记忆不能交叉泄漏 | `MEM-11` |
| `F11.11` | `IMPLEMENTED_UNVERIFIED` | Memory Pack（扩展数据层）与用户 Memory Overlay 有边界，不能伪装 System Prompt | 无独立已定位问题 |
| `F11.12` | `CODE_UPDATED_E2E_UNVERIFIED` | 清理/保留策略不删除持久记忆，错误数据不静默归零 | `MEM-06`, `MEM-07`, `MEM-13` |

### F12 · MCP Server / Tools Registry / 调用（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F12.01` | `PARTIAL_OR_UNVERIFIED` | MCP Server 列表、启动/停止/重启/启停开关/连接状态与错误诊断正常 | `MCP-01` |
| `F12.02` | `IMPLEMENTED_UNVERIFIED` | 内置 SnowLuma QQ、QQ 文件与音乐、安全联网搜索、Bilibili、进程状态等真实可启动 | `MCP-02` |
| `F12.03` | `IMPLEMENTED_UNVERIFIED` | 正式打包运行时 MCP stdio child 的 executable、cwd、env、entry 都存在且正确 | `MCP-02` |
| `F12.04` | `PARTIAL_OR_UNVERIFIED` | 所有 MCP 完成 initialize、tools/list、tools/call 握手，不出现统一 Connection closed | `MCP-01`, `MCP-02`, `MCP-04` |
| `F12.05` | `CODE_UPDATED_E2E_UNVERIFIED` | 工具列表/Schema/权限/来源/启用状态与实际可调用性一致 | `MCP-03`, `MCP-04`, `UI-02` |
| `F12.06` | `PARTIAL_OR_UNVERIFIED` | 聊天模型能发现并调用已授权 MCP 工具，结果能进入 Tool Loop 与聊天流 | `MCP-01` |
| `F12.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 禁用某 Server 或单 Tool 后立即不可被 Agent/Model 调用 | `MCP-03` |
| `F12.08` | `IMPLEMENTED_UNVERIFIED` | 工具错误/超时/断线/重连/进程崩溃后 Core 继续运行 | 无独立已定位问题 |
| `F12.09` | `IMPLEMENTED_UNVERIFIED` | SnowLuma 的 QQ、web_search/web_fetch、Bili 等按实际依赖分别验证 | 无独立已定位问题 |
| `F12.10` | `IMPLEMENTED_UNVERIFIED` | 高风险外发/进程控制默认禁止并遵守 Owner 审批，不为修复而放宽权限 | 无独立已定位问题 |
| `F12.11` | `PARTIAL_OR_UNVERIFIED` | 真实 Windows 安装版不依赖源码路径或全局 Node 启动 MCP | `MCP-02`, `INSTALL-01`, `NEW-08` |

### F13 · Extension Runtime / 沙箱 / 生命周期（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F13.01` | `IMPLEMENTED_UNVERIFIED` | 扩展安装、验证、权限 review、启用、禁用、启动、停止、重启、移除流程完整 | 无独立已定位问题 |
| `F13.02` | `PARTIAL_OR_UNVERIFIED` | 普通扩展 Process Host 与可信 builtin/VM fallback 清晰区分 | `EXT-01` |
| `F13.03` | `IMPLEMENTED_UNVERIFIED` | 每扩展独立 Worker 崩溃不影响 Core，错误状态、重启限额、超时正确 | 无独立已定位问题 |
| `F13.04` | `IMPLEMENTED_UNVERIFIED` | Worker RPC invoke/cancel/ping/shutdown 以及反向 Capability 请求协议正确 | 无独立已定位问题 |
| `F13.05` | `IMPLEMENTED_UNVERIFIED` | 安装包路径安全、Manifest/schema、包大小、签名/Hash、兼容性检查有效 | 无独立已定位问题 |
| `F13.06` | `IMPLEMENTED_UNVERIFIED` | 更新 staging、切换、rollback、权限扩张时重新 Owner Review | 无独立已定位问题 |
| `F13.07` | `IMPLEMENTED_UNVERIFIED` | 扩展 Settings schema、二级设置、secret reference 能保存且不泄密 | 无独立已定位问题 |
| `F13.08` | `IMPLEMENTED_UNVERIFIED` | Memory Pack 只能加载受控数据，不执行任意代码或覆盖用户记忆 | 无独立已定位问题 |
| `F13.09` | `IMPLEMENTED_UNVERIFIED` | Developer Mode 本地未验证插件与普通官方插件隔离，默认禁用/审批 | 无独立已定位问题 |
| `F13.10` | `IMPLEMENTED_UNVERIFIED` | 插件卸载默认不擅自删除用户数据，残留后台进程与缓存可回收 | 无独立已定位问题 |
| `F13.11` | `PARTIAL_OR_UNVERIFIED` | 第三方插件缺 OS 级沙箱时正确展示安全限制，不伪称完全隔离 | `EXT-01` |

### F14 · Plugin Center / Catalog / 开发者生态（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F14.01` | `IMPLEMENTED_UNVERIFIED` | 应用内插件推荐、搜索、分类、详情、截图、权限、开发者和版本正常 | `PLUGIN-02` |
| `F14.02` | `PARTIAL_OR_UNVERIFIED` | Catalog 在线/离线缓存、数据签名/可信主机、撤回版本处理正确 | `PLUGIN-01`, `NEW-10` |
| `F14.03` | `PARTIAL_OR_UNVERIFIED` | 插件下载、大小限制、SHA-256、Manifest 校验、审查、安装后启用完整 | `PLUGIN-01`, `NEW-10` |
| `F14.04` | `IMPLEMENTED_UNVERIFIED` | 本地安装入口调用原生文件选择器并经过同一安全安装管线 | `PLUGIN-02` |
| `F14.05` | `PARTIAL_OR_UNVERIFIED` | 官方集成 DSH/SnowLuma 与普通 Extension 在页面统一呈现但底层类型正确 | `MCP-01` |
| `F14.06` | `IMPLEMENTED_UNVERIFIED` | 插件更新、权限差异、回滚、卸载、安全禁用与异常恢复有效 | `PLUGIN-02` |
| `F14.07` | `IMPLEMENTED_UNVERIFIED` | 每个插件二级设置独立，Bionic 每个工具总/分开关真实生效 | 无独立已定位问题 |
| `F14.08` | `IMPLEMENTED_UNVERIFIED` | 目录/官网离线时不阻止 Chat 和本地现有插件运行 | 无独立已定位问题 |
| `F14.09` | `IMPLEMENTED_UNVERIFIED` | 插件开发 SDK 文档、Hello Plugin、Manifest、权限、测试与打包示例与实际 validator 对齐 | `PLUGIN-02` |
| `F14.10` | `PARTIAL_OR_UNVERIFIED` | 插件发布/审核/兼容版本/版本回退流程有真实说明与可验证接口 | `PLUGIN-01` |

### F15 · Channel Provider / QQ / OneBot / SnowLuma（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F15.01` | `IMPLEMENTED_UNVERIFIED` | QQ/SnowLuma/OneBot 为可选 Channel，未安装/离线时 Core 仍正常 | 无独立已定位问题 |
| `F15.02` | `IMPLEMENTED_UNVERIFIED` | 网关安装、连接、状态、服务启停、账号与 QQ 群/私聊通道正确区分 | 无独立已定位问题 |
| `F15.03` | `IMPLEMENTED_UNVERIFIED` | 消息收取、解析、群白名单、私聊白名单、发送/引用回复/群发正确 | `QQ-02` |
| `F15.04` | `IMPLEMENTED_UNVERIFIED` | 重复消息、乱序、重连、断线积压、限流和故障状态真实处理 | `QQ-02` |
| `F15.05` | `IMPLEMENTED_UNVERIFIED` | 图片、文件、音频、卡片和引用消息在已授权情况下收发 | `QQ-02` |
| `F15.06` | `CODE_UPDATED_E2E_UNVERIFIED` | QQ 端 MCP 工具实际可调用且遵守 Core Capability Broker/高风险审批 | `MCP-03`, `QQ-01`, `NEW-08` |
| `F15.07` | `IMPLEMENTED_UNVERIFIED` | SnowLuma 进程与 DSH Agent 互不作为 CetaMesh 启动必需条件 | 无独立已定位问题 |
| `F15.08` | `CODE_UPDATED_E2E_UNVERIFIED` | 社交记忆和 QQ 凭据在升级/插件迁移/重启后不丢失 | `MEM-11` |
| `F15.09` | `IMPLEMENTED_UNVERIFIED` | 外部群消息不能提升为 Owner、不能任意创建工作区/执行脚本 | 无独立已定位问题 |
| `F15.10` | `PARTIAL_OR_UNVERIFIED` | 将来 Telegram/Discord/微信等连接如仍只是规划，明确标未实现或未验证 | 无独立已定位问题 |

### F16 · Bionic Chat / 仿生社交工具（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F16.01` | `IMPLEMENTED_UNVERIFIED` | 角色/人设/风格与聊天模式配置实际影响输出，允许安全切换 | `QQ-01` |
| `F16.02` | `IMPLEMENTED_UNVERIFIED` | 社交状态（活跃/观望/潜水）、自动唤醒/休眠和状态记忆符合规则 | `QQ-02` |
| `F16.03` | `IMPLEMENTED_UNVERIFIED` | 黑话查询、候选学习、人工确认、清理与禁用正确 | 无独立已定位问题 |
| `F16.04` | `IMPLEMENTED_UNVERIFIED` | 贴纸列表、图片、备注、收藏、贴纸发送按 QQ 权限运作 | 无独立已定位问题 |
| `F16.05` | `IMPLEMENTED_UNVERIFIED` | 官方卡片、按钮审批、消息引用、合并转发及群聊信息按规则处理 | 无独立已定位问题 |
| `F16.06` | `PARTIAL_OR_UNVERIFIED` | 音乐/音频搜索、本地音频、网络音频与发送安全边界有效 | `QQ-03` |
| `F16.07` | `IMPLEMENTED_UNVERIFIED` | 对话节流、群友身份、消息去重、私聊白名单和防重复回复正常 | `QQ-02` |
| `F16.08` | `PARTIAL_OR_UNVERIFIED` | 历史 53 个工具（46 restored / 5 partial / 2 unsupported）逐项真实复测，不把恢复登记视作可调用 | `MCP-03`, `QQ-01`, `QQ-03` |
| `F16.09` | `IMPLEMENTED_UNVERIFIED` | Bionic 与 QQ Channel 解耦程度如实标注，不因 QQ 插件失败拖垮普通 Chat | `QQ-01` |
| `F16.10` | `MISSING_OR_NOT_DELIVERED` | 语音聊天/TTS/虚拟形象/情绪动画若尚未交付，不得当已实现功能 | `QQ-03` |

### F17 · Device Mesh / Desktop ↔ Mobile（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F17.01` | `IMPLEMENTED_UNVERIFIED` | Device identity、节点 ID、私钥安全保存与迁移策略有效 | 无独立已定位问题 |
| `F17.02` | `IMPLEMENTED_UNVERIFIED` | Desktop 生成 QR 邀请，Mobile 扫码/粘贴同一邀请可配对 | 无独立已定位问题 |
| `F17.03` | `IMPLEMENTED_UNVERIFIED` | 邀请一次性 Token、TTL、TLS certificate pin、双向签名与 replay 防护完整 | 无独立已定位问题 |
| `F17.04` | `CODE_UPDATED_E2E_UNVERIFIED` | 配对后 Trust 与 Capability Grants 分离，默认仅安全基础能力 | `MESH-01` |
| `F17.05` | `PARTIAL_OR_UNVERIFIED` | 设备列表、在线状态、presence、manifest、remote capability request 可实际通信 | `MESH-02`, `MESH-03` |
| `F17.06` | `CODE_UPDATED_E2E_UNVERIFIED` | 重启后的信任、撤销、断开、忘记设备、错误恢复真实生效 | `MESH-01` |
| `F17.07` | `PARTIAL_OR_UNVERIFIED` | LAN/TCP 和 loopback 支持状态真实；pipe/relay 等未完成不可显示 Ready | `MESH-02` |
| `F17.08` | `IMPLEMENTED_UNVERIFIED` | Desktop/Mobile 协议版本、黄金 Fixture、签名与 DTO 跨仓一致 | 无独立已定位问题 |
| `F17.09` | `MISSING_OR_NOT_DELIVERED` | 远程 Memory/Task/Notification/Artifact 同步只对真正实现的部分标可用 | `MESH-02` |
| `F17.10` | `IMPLEMENTED_UNVERIFIED` | 换网络、断网、旧证书、过期二维码、权限撤销不会留下未授权连接 | 无独立已定位问题 |
| `F17.11` | `PARTIAL_OR_UNVERIFIED` | Android 真机跨设备测试与仅本机 Node fixture 的结果分开报告 | 无独立已定位问题 |

### F18 · Workshop / 外部需求与交付（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F18.01` | `PARTIAL_OR_UNVERIFIED` | 外部提交 Proposal、补充需求、查看自身项目且无法访问他人项目 | `WORKSHOP-01` |
| `F18.02` | `PARTIAL_OR_UNVERIFIED` | Owner 审阅、批准/拒绝后再创建隔离 Workspace 与 Task | `WORKSHOP-01` |
| `F18.03` | `IMPLEMENTED_UNVERIFIED` | Agent 只获得批准 Task 与 Workspace 对应的精确能力 | 无独立已定位问题 |
| `F18.04` | `IMPLEMENTED_UNVERIFIED` | 执行过程、Checkpoint、进度、阶段、失败与恢复可追踪 | 无独立已定位问题 |
| `F18.05` | `IMPLEMENTED_UNVERIFIED` | Artifact 交付可以安全回到原提议者，访问内容经脱敏/权限约束 | 无独立已定位问题 |
| `F18.06` | `IMPLEMENTED_UNVERIFIED` | 审批失败、Workspace 创建失败、Agent 初始化失败不会留下错误的已执行状态 | 无独立已定位问题 |
| `F18.07` | `IMPLEMENTED_UNVERIFIED` | 外部请求不能直接触发 shell/native 或绕过 Owner 审批 | 无独立已定位问题 |
| `F18.08` | `PARTIAL_OR_UNVERIFIED` | Workshop UI/通道入口是否真的可用需要实测，不能仅凭 Core 服务存在判可用 | `WORKSHOP-01` |

### F19 · Harbor UI / 交互 / 真实接线（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F19.01` | `CODE_UPDATED_E2E_UNVERIFIED` | Chat、Work、Memory、Agents、Plugins、Settings、About 都有实际可用入口 | `UI-01` |
| `F19.02` | `CODE_UPDATED_E2E_UNVERIFIED` | 页面每个按钮、菜单、状态卡片均接真实 Bridge action，不存在假功能 | `TASK-01`, `TASK-02`, `TASK-11`, `MEM-03`, `MEM-04`, `MEM-10`, `UI-01` |
| `F19.03` | `CODE_UPDATED_E2E_UNVERIFIED` | UI 与 Core 的 DTO/event/snapshot 结果一致，刷新不产生“Ready/Unavailable”矛盾 | `CHAT-07`, `CHAT-09`, `TASK-08`, `MEM-09`, `UI-02`, `UI-03` |
| `F19.04` | `IMPLEMENTED_UNVERIFIED` | Chat/Agent/Model/Tool Select 不出现空白项，显示值和实际执行 ID 一致 | 无独立已定位问题 |
| `F19.05` | `IMPLEMENTED_UNVERIFIED` | Settings 不堆成单一长页面，根容器不滚动，分区单独滚动 | 无独立已定位问题 |
| `F19.06` | `IMPLEMENTED_UNVERIFIED` | Recent Sessions 右键菜单/浮层不会裁切、错位、重叠，归档/重命名生效 | 无独立已定位问题 |
| `F19.07` | `IMPLEMENTED_UNVERIFIED` | 聊天右侧 Context Panel 可收起，消息列表重新布局正常 | 无独立已定位问题 |
| `F19.08` | `IMPLEMENTED_UNVERIFIED` | 消息文字/代码与输入区允许必要选择和复制粘贴，静态 UI 避免误选择 | 无独立已定位问题 |
| `F19.09` | `IMPLEMENTED_UNVERIFIED` | 主题、字号、动画、减少动态效果、焦点、键盘、快捷键一致 | 无独立已定位问题 |
| `F19.10` | `PARTIAL_OR_UNVERIFIED` | 中文输入法、长中文、代码块、超长标题、窄窗口、不同 DPI 下布局可用 | `WORKSPACE-03` |
| `F19.11` | `IMPLEMENTED_UNVERIFIED` | 外部 URL 走默认浏览器，不让远程页面加载到 privileged WebView | 无独立已定位问题 |
| `F19.12` | `IMPLEMENTED_UNVERIFIED` | 加载/空态/错误/离线/未配置/等待审批等状态能给出下一步操作 | 无独立已定位问题 |
| `F19.13` | `CODE_UPDATED_E2E_UNVERIFIED` | 长会话与插件长列表不会出现显著 UI 卡顿或不合理全量刷新 | `UI-03` |

### F20 · 首次启动 / Settings / 用户偏好（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F20.01` | `IMPLEMENTED_UNVERIFIED` | 首次启动 7 步：欢迎、Provider、测试连接、选默认模型、可选 Agent/Integration、完成 | 无独立已定位问题 |
| `F20.02` | `IMPLEMENTED_UNVERIFIED` | 第 4 步保存 Provider/Model 后状态推进且重启保持，失败不误推进 | 无独立已定位问题 |
| `F20.03` | `IMPLEMENTED_UNVERIFIED` | 无 QQ、DSH、Codex、设备也能完成引导并使用独立 Chat | 无独立已定位问题 |
| `F20.04` | `IMPLEMENTED_UNVERIFIED` | 设置普通项与 Advanced 按产品层级分类，修改/保存/取消逻辑明确 | 无独立已定位问题 |
| `F20.05` | `PARTIAL_OR_UNVERIFIED` | 模型默认选择与 Chat 当前 Session override 不混淆 | `SETTINGS-01` |
| `F20.06` | `IMPLEMENTED_UNVERIFIED` | 设置 revision/expectedRevision 防并发覆盖，失败无隐式数据丢失 | 无独立已定位问题 |
| `F20.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 配置损坏保留原文件或备份，提示恢复而非静默覆盖 | `SEC-04`, `SETTINGS-02` |
| `F20.08` | `PARTIAL_OR_UNVERIFIED` | UI/Agent/Plugin/Memory/Update 相关设置重启后保持一致 | `MEM-05`, `MESH-01`, `MESH-03`, `SETTINGS-01`, `UPDATE-01` |
| `F20.09` | `IMPLEMENTED_UNVERIFIED` | 设置/凭据中 API Key 不进入 React 或无界日志 | 无独立已定位问题 |
| `F20.10` | `IMPLEMENTED_UNVERIFIED` | 用户个人空间/本地数据目录与安装目录及开发源码隔离 | 无独立已定位问题 |

### F21 · About / 版本 / 更新 / 官网（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F21.01` | `IMPLEMENTED_UNVERIFIED` | About 显示真实 Product Version、Build、Commit、Channel、开发者、官网 | 无独立已定位问题 |
| `F21.02` | `IMPLEMENTED_UNVERIFIED` | 版本与构建号从单一真实来源注入 Installer、About、Manifest、包名 | 无独立已定位问题 |
| `F21.03` | `IMPLEMENTED_UNVERIFIED` | Build Number 单调推进，代码有改变不重复发布同一不可区分版本 | 无独立已定位问题 |
| `F21.04` | `PARTIAL_OR_UNVERIFIED` | 检查更新：GitCode 国内优先、GitHub fallback，超时/失败/无更新清楚区分 | `UPDATE-01`, `NEW-10` |
| `F21.05` | `PARTIAL_OR_UNVERIFIED` | 下载更新验证 HTTPS、签名/Manifest、SHA-256、大小，失败不执行安装 | `UPDATE-01`, `NEW-10` |
| `F21.06` | `PARTIAL_OR_UNVERIFIED` | 更新 Channel（Stable/RC/Beta）排序正确，不能静默降级 | `UPDATE-01` |
| `F21.07` | `IMPLEMENTED_UNVERIFIED` | Release Notes 实际可加载且离线缓存/危险 HTML 安全处理 | 无独立已定位问题 |
| `F21.08` | `IMPLEMENTED_UNVERIFIED` | 反馈、Bug、功能建议、安全漏洞入口打开 cetamesh.com 已存在的真实页面 | 无独立已定位问题 |
| `F21.09` | `PARTIAL_OR_UNVERIFIED` | 插件文档、Privacy、Terms、下载地址与官网链接有效；不存在的路径不假装可用 | 无独立已定位问题 |
| `F21.10` | `IMPLEMENTED_UNVERIFIED` | 更新到新版本后用户的 Task/Memory/Plugin/Device trust 不丢失 | 无独立已定位问题 |

### F22 · Windows Installer / 发布包 / 桌面集成（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F22.01` | `PARTIAL_OR_UNVERIFIED` | 全新安装、覆盖升级、修复、迁移、卸载和用户数据保留符合产品声明 | `INSTALL-01`, `NEW-08` |
| `F22.02` | `IMPLEMENTED_UNVERIFIED` | 安装目录“浏览”可调用原生文件夹选择器，中文/空格/非 C 盘正常 | 无独立已定位问题 |
| `F22.03` | `IMPLEMENTED_UNVERIFIED` | 安装器完成可关闭，安装完成后启动 CetaMesh 并自行退出 | 无独立已定位问题 |
| `F22.04` | `IMPLEMENTED_UNVERIFIED` | 正常安装没有频繁 cmd/PowerShell 黑框，必要 UAC 正常显示 | 无独立已定位问题 |
| `F22.05` | `IMPLEMENTED_UNVERIFIED` | Per-user 与管理员场景下 HKCU/注册表写入实际目标用户正确 | 无独立已定位问题 |
| `F22.06` | `IMPLEMENTED_UNVERIFIED` | Windows 10/11 x64、不同 DPI、WebView2 缺失/已有情况下可安装与启动 | 无独立已定位问题 |
| `F22.07` | `IMPLEMENTED_UNVERIFIED` | 安装、升级、卸载出错时 staging/rollback 不产生半新半旧状态 | `INSTALL-01` |
| `F22.08` | `PARTIAL_OR_UNVERIFIED` | Release 中 React bundle、SEA Core、MCP child entry、插件资产完整且可离线启动 | `INSTALL-01`, `INSTALL-02`, `INSTALL-03` |
| `F22.09` | `IMPLEMENTED_UNVERIFIED` | Start Menu/桌面快捷方式、程序卸载登记、托盘、单实例正常 | 无独立已定位问题 |
| `F22.10` | `IMPLEMENTED_UNVERIFIED` | Authenticode 如果无真实证书如实展示未签名，不用自签名冒充正式发布 | 无独立已定位问题 |
| `F22.11` | `PARTIAL_OR_UNVERIFIED` | 正式 Artifact Manifest 的 SHA256/sourceCommit 与最终 clean HEAD 一致 | `NEW-10` |
| `F22.12` | `IMPLEMENTED_UNVERIFIED` | Release 包体积、磁盘占用、旧构建清理和版本保留策略合理 | 无独立已定位问题 |
| `F22.13` | `IMPLEMENTED_UNVERIFIED` | Crash recovery、日志权限和升级前数据备份不破坏用户 Memory/Task | `INSTALL-01` |

### F23 · 安全 / 存储可靠性 / 诊断 / CI（P0）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F23.01` | `IMPLEMENTED_UNVERIFIED` | 所有 Trust Boundary（WebView、IPC、Channel、MCP、Extension、Agent、Mesh）都有明确鉴权 | 无独立已定位问题 |
| `F23.02` | `IMPLEMENTED_UNVERIFIED` | Owner、Agent、设备、插件与外部参与者身份不被跨层冒用 | 无独立已定位问题 |
| `F23.03` | `IMPLEMENTED_UNVERIFIED` | 工作区/Artifact canonicalization、反路径穿越和 Windows 路径别名测试通过 | 无独立已定位问题 |
| `F23.04` | `IMPLEMENTED_UNVERIFIED` | 网络搜索/抓取的 SSRF、防私网访问、跳转 DNS 重新校验和响应体上限有效 | 无独立已定位问题 |
| `F23.05` | `PARTIAL_OR_UNVERIFIED` | 普通插件无 OS 沙箱的风险边界明示且强制人工 Review | `EXT-01`, `PLUGIN-01` |
| `F23.06` | `CODE_UPDATED_E2E_UNVERIFIED` | 高风险 Test Runner、外发消息、删除/覆盖、文件导入不能被单次模型文本绕开审批 | `SEC-01`, `SEC-02` |
| `F23.07` | `CODE_UPDATED_E2E_UNVERIFIED` | 所有持久状态采用可靠写盘；Task/Memory/Settings/Trust 写失败与数据损坏有恢复策略 | `HND-08`, `HND-09`, `MEM-06`, `MEM-07`, `SEC-04`, `SEC-05`, `SETTINGS-02`, `WORKSPACE-01`, `NEW-06` |
| `F23.08` | `IMPLEMENTED_UNVERIFIED` | 日志、追踪与诊断对凭据、私钥、用户正文、绝对敏感路径进行脱敏 | 无独立已定位问题 |
| `F23.09` | `IMPLEMENTED_UNVERIFIED` | 对未定义 Error、IPC timeout、孤儿 Worker、Promise rejection、资源泄漏可观测且可恢复 | 无独立已定位问题 |
| `F23.10` | `CI_FAILED_NEEDS_REPRO` | 测试包含生产 Service Container 路径，不只测试独立模块与 mock | `NEW-07` |
| `F23.11` | `CI_FAILED_NEEDS_REPRO` | Windows GitHub CI、Node 全套、Cargo、UI、Release Candidate 全绿；环境未执行不算通过 | `SETTINGS-01`, `NEW-07` |
| `F23.12` | `IMPLEMENTED_UNVERIFIED` | 负向测试（恶意输入、取消、崩溃、断网、并发、重启、磁盘空间、无权限）覆盖主业务 | `SEC-03` |
| `F23.13` | `PARTIAL_OR_UNVERIFIED` | 一次完整 Installer→First Run→Chat→Tool→Task→Agent→Memory→Plugin→Update 的真实 E2E 通过 | `NEW-08` |

### F24 · Mobile / 跨端业务（独立仓库，单独核实）（P1）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F24.01` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | Android 独立安装/离线启动，不依赖 Metro；iOS 若未交付不标完成 | 无独立已定位问题 |
| `F24.02` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | Mobile 的 Chat/Provider/Model/Session/Attachment 独立可使用 | 无独立已定位问题 |
| `F24.03` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | Mobile Task、Memory、Workspace、Action Center 等入口与真实业务一致 | 无独立已定位问题 |
| `F24.04` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | Mobile Device Identity、Secure Storage、QR Scan 与 Desktop Pairing v1.1 互通 | 无独立已定位问题 |
| `F24.05` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | 跨端设备发现、连接/断线恢复、信任/撤销/忘记同步 | 无独立已定位问题 |
| `F24.06` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | Memory 同步按 Object/Event 和 Scope 进行，不复制整库且不泄漏其他设备数据 | 无独立已定位问题 |
| `F24.07` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | 任务元数据/通知/远程能力按真正实现的协议同步 | 无独立已定位问题 |
| `F24.08` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | Android 后台限制、网络切换、权限拒绝、APK 更新/回滚处理正确 | 无独立已定位问题 |
| `F24.09` | `NOT_APPLICABLE_DESKTOP_REAUDIT` | 下载源/更新包签名哈希/正式版本与 Desktop/GitCode/官网一致 | 无独立已定位问题 |

### F25 · 规划/试验能力：不得自动算已完成（P2）

| 子项 | 最新复核状态 | 检查目标 | 相关旧问题 / 新问题 |
|---|---|---|---|
| `F25.01` | `PLANNED_NOT_DELIVERED` | 真正多 Agent 并行协作、依赖调度、冲突合并和工程守护（Project Guardian） | `TASK-10` |
| `F25.02` | `PLANNED_NOT_DELIVERED` | 跨设备远程自动化、Relay、云协作与实时数据同步扩展 | 无独立已定位问题 |
| `F25.03` | `PLANNED_NOT_DELIVERED` | 微信、Telegram、Discord 等新增正式 Channel Connector | 无独立已定位问题 |
| `F25.04` | `PLANNED_NOT_DELIVERED` | 语音实时聊天、STT/TTS、虚拟形象/动画互动与完整多模态 | 无独立已定位问题 |
| `F25.05` | `PLANNED_NOT_DELIVERED` | 全平台插件市场、账户/付费、插件评级与第三方 OS 沙箱 | 无独立已定位问题 |
| `F25.06` | `PLANNED_NOT_DELIVERED` | 跨仓 Desktop/Mobile 工程质量门禁、自动恢复包和 Agent 成本监控 | 无独立已定位问题 |

### 附录 C：E01–E24 真实验收矩阵（不得以 Fixture 代替）

| E 编号 | 原优先级 | 验收场景 | 当前真实 E2E | 核心相关缺口 |
|---|---|---|---|
| `E01` | P0 | 全新普通用户安装→引导→配置模型→成功回复 | `NOT_RUN_ENVIRONMENT` | `NEW-08` |
| `E02` | P0 | 模型 Key 错误→明确提示→更换 Key→恢复旧可用配置 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E03` | P0 | 发消息立刻出现→流式→中途停止→不会后台继续计费 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E04` | P0 | 普通 Chat 发出单个 tool_call→Broker→执行→结果→模型续答 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E05` | P0 | 三工具调用含需要审批项目→批准/拒绝→消息协议完整 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E06` | P0 | Chat 选择 Codex/DSH→创建 Task→执行→流式→Artifact | `NOT_RUN_ENVIRONMENT` | `NEW-01`, `NEW-02`, `NEW-05`, `NEW-08`, `NEW-09` |
| `E07` | P0 | 已有 Task 重复 Agent turn→新指令真正发送而非仅复用 Session | `NOT_RUN_ENVIRONMENT` | `NEW-01`, `NEW-04` |
| `E08` | P0 | 一个 Task 从 DSH 切 Codex/Managed→进度/Workspace 不丢不串 | `NOT_RUN_ENVIRONMENT` | `NEW-01`, `NEW-02`, `NEW-06`, `NEW-08`, `NEW-09` |
| `E09` | P0 | Agent 修改 Staging→审批导入→真实 Workspace 文件符合 Diff | `NOT_RUN_ENVIRONMENT` | `NEW-07` |
| `E10` | P0 | Core 中途重启→Chat 事件继续收取→Task/Memory/插件状态恢复 | `NOT_RUN_ENVIRONMENT` | `NEW-03`, `NEW-04`, `NEW-05`, `NEW-06` |
| `E11` | P0 | MCP 五个内置 Server 启动/握手/单工具调用/重启 | `NOT_RUN_ENVIRONMENT` | `NEW-08` |
| `E12` | P0 | SnowLuma QQ 收消息→工具调用→审批→发消息，不影响独立 Chat | `NOT_RUN_ENVIRONMENT` | `NEW-08` |
| `E13` | P0 | 插件本地导入→权限 Review→安装/启用→调用→崩溃隔离 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E14` | P1 | 插件商店下载→校验→更新权限变化→拒绝/批准→回滚 | `NOT_RUN_ENVIRONMENT` | `NEW-10` |
| `E15` | P0 | Memory 候选→确认→新会话相关检索→跨 Scope 拒绝 | `NOT_RUN_ENVIRONMENT` | `NEW-03` |
| `E16` | P1 | Workshop 外部 Proposal→Owner 通过→任务→成果交付 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E17` | P1 | Desktop ↔ Android QR 配对→presence/manifest→撤销权限 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E18` | P0 | 长对话 500 消息+持续 streaming+history paging+后台刷新，不闪烁 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E19` | P0 | 升级安装新 RC→旧会话/Memory/Task/Plugin/信任/安装路径均保留 | `NOT_RUN_ENVIRONMENT` | `NEW-07`, `NEW-08`, `NEW-10` |
| `E20` | P1 | 卸载保留数据→重新安装→旧状态可恢复 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E21` | P0 | 多 Provider 一个离线→其它 Model 可用、Chat 不冻结 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |
| `E22` | P0 | Windows Codex CLI .cmd+代理/自定义登录+不同 Task 模型隔离 | `NOT_RUN_ENVIRONMENT` | `NEW-08`, `NEW-09` |
| `E23` | P0 | DSH Desktop 安装但 Web API 未鉴权→不显示 Agent Ready | `NOT_RUN_ENVIRONMENT` | `NEW-02`, `NEW-08` |
| `E24` | P0 | 外部恶意插件/网页/模型输入不能越过 Capability 审批或窃取秘密 | `NOT_RUN_ENVIRONMENT` | 需安装版复验 |

## 安全和数据完整性

本轮未修改 `src/workspace/boundary.js`、未降低 Capability Broker 风险等级、未跳过 Owner Approval、未扩大 Agent 默认 Memory Scope、未关闭 Codex Sandbox。非 Git 恢复和 Handoff 不确定状态进入人工核对；真实用户数据未删除或覆盖。发行门禁仍为 **RELEASE_BLOCKED**。
