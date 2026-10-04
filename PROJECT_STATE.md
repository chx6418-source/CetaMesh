# CetaMesh Desktop — PROJECT_STATE

## Current authoritative snapshot — 2026-10-04（TASK-D1-001 Unified Config Service）

本快照取代下方 D0 快照。本阶段完成 roadmap **TASK-D1-001**：统一配置服务（Unified Config Service）。

### 本阶段落盘内容

- 新增 `src/config/`（四文件）：
  - `loader.js`：BOM 容错读取、fail-closed（缺失/损坏/根非对象 → `ConfigError`，错误文案与旧 `readJsonSafe` 一致）、`readRawConfigOrEmpty`（MCP"未配置"语义）、`atomicWriteConfig`（临时文件+rename，0600）。
  - `migrate.js`：旧 config → 规范配置的逐字段等价移植（旧 `loadConfig` 的默认值、`allow.privates/group` 别名、`ownerQQ`/白名单规范化、`socialV2.tools` 与 `sticker.collect` 深度合并），导出 `DEFAULT_MODEL` / `normalizeOwnerQQ` / `normalizeIdList`。
  - `schema.js`：Zod 4 校验契约（`validateRawConfig` 只做诊断不改写）、`SECURITY_DEFAULTS`、`assertSecurityInvariants`（迁移不得把未显式开启的安全开关升级为 true）。
  - `service.js`：`createConfigService({ configFile })` → `load / readRaw / updateSection(merge|replace) / writeFile`。
- `src/bridge.js`：`loadConfig()` 改为薄封装委托 `migrateLegacyConfig(readRawConfig(CONFIG_FILE, { required: true }))`，删除约 290 行内联合并逻辑；`DEFAULT_MODEL` / `normalizeOwnerQQ` 改从 config 模块导入（运行期控制台直接改写 `cfg` 的行为不变）。
- 4 个 MCP 模块（`mcp-snowluma-safe` / `mcp-qq-file-send` / `mcp-bilibili` / `mcp-host-server`）的重复 raw 读取统一到 `readRawConfigOrEmpty`（行为等价：读不到按 `{}`，使用点 `!== true` / `=== false` 自行 fail-closed）。
- `package.json`：新增 `test-config` 脚本。
- 附带修复：esbuild 构建曾告警的 `src/bridge.js` 重复 `collect` 键已消除（迁移实现用单次显式合并达成相同最终结果）。

### 本阶段验证（本机实测）

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `npm run test-config`（`scripts/test-config-service.mjs`） | `PASS` | 黄金参照等价测试：内嵌迁移前 `loadConfig` 原文副本（git d35dbfe 行 329-619 提取），7 组夹具（空/最小/旧别名/socialV2 局部覆盖/全量/错误类型/未知字段）全部 deepEqual；另覆盖 loader fail-closed、BOM、orEmpty、schema 诊断、service 读写、ownerQQ 非法值、安全不变量 |
| 真实 `config.json` 新旧迁移输出 deepEqual | `PASS` | 一次性验证脚本（未入库）：对仓库当前真实配置，新旧实现输出完全一致 |
| `npm run test-core-entry` | `PASS` | worker 隔离数据目录启动成功——新 `loadConfig` 在 worker 模式实跑通过；五个 MCP 模式 initialize/listTools/callTool 通过 |
| `npm run test-privilege` | `PASS` | 24/24；运行中桥接端到端部分 fetch failed 自动跳过（该部分 `NOT_RUN_ENVIRONMENT`） |
| `npm run self-test` | `PASS` | 本机 DSH（127.0.0.1:3080）在线：探活/建会话/prompt/回合 completed/回复正常。注意 self-test 不经过 loadConfig，模型链路验证与配置改造相互独立 |
| `npm run test-app-paths` | `PASS` | 路径解析回归 |
| `esbuild`（ESM bundle `src/core-sea.js`） | `PASS` | 0 告警（duplicate collect-key 告警已消失） |
| Release / SEA 产物重建 | `NOT_RUN_ENVIRONMENT` | 本阶段未重建 dist/ 与 RC；安装器不受影响（无 Rust 改动） |

### 边界与已知问题

- **控制台 30+ 处写路径未迁移**：仍按原样直接读改写原始文件（保留未知字段）。`ConfigService.updateSection / writeFile` 已就绪并测试，逐个迁移是后续小阶段。
- `src/local-services.js` 安装期仍直写 `config.json`（snowluma/dsh 两个字段补丁）——后续迁移。
- `migrateLegacyConfig` 按等价性要求**原样保留**非布尔的安全开关值（如字符串 `'true'`）；fail-closed 由使用点 `=== true` 保证，类型异常由 `validateRawConfig` 诊断。二者配合即红线语义。
- schema 为诊断性校验，不因新增未知字段阻断启动（宽松透传）。

### 并发工作观察（重要，待所有者裁决）

本阶段执行期间（约 20:05–20:10），另一会话在同一工作区并行修改了**本阶段未触碰**的文件：`desktop-shell/*`（`native_ui.rs` +321 行等）、`src/control/ipc-protocol.js`（新增 `chat.*` 方法族）、新增 `src/desktop/`（含 `chat-service.js`）、`desktop-shell/src/chat_ui.rs`、`src/memory/`、`scripts/test-desktop-chat-product.mjs`，并在 `src/bridge.js` 追加了 17 行 chat 接线。该工作与本文下方"桌面 Chat 闭环不得恢复重建"的历史决定方向相反，**未提交、未由本阶段验证、未纳入本阶段提交**。本阶段对 `src/bridge.js` 采用了部分暂存（`git apply --cached` 仅暂存配置相关 hunk），并发改动完整保留在工作区。另发现异常目录 `%SystemDrive%/`（疑似环境变量展开错误产生），未处置。请所有者确认该并行方向是否有效。

### 下一阶段入口

- 按 roadmap：**TASK-D1-002 Named Pipe Security Audit**（当前用户 SID/ACL、未授权拒绝、协议版本/超大帧/超时拒绝 + 自动测试）。
- 小型后续（可先做）：把控制台写路径逐个迁移到 `ConfigService`；`local-services.js` 安装期写入接入。
- Persistent Task v1 / Context Rollover / Agent Handoff 维持搁置（见下方第 20 节禁扩建清单）。

---

## D0 snapshot — 2026-10-04（TASK-D0-001/002 基线快照，被上方快照取代）

This snapshot supersedes older status notes below. The repository is Desktop / Windows only; Mobile is a separate project.

### Repository and working tree

- Audit start: branch `main`, HEAD `90def05` (`docs(desktop): D0 基线复验记录（TASK-D0-001/002）`), four local commits ahead of `origin/main@1b8ef61`. The earlier local commits include the installer `--remove-data` fix (`05a6c99`) and the explicit Chat-loop revert (`34b321d`).
- The only configured remote is `origin` → `https://github.com/chx6418-source/whalebridge.git`. No `CetaMesh` remote is configured. No fetch, push, or upload was performed.
- At audit start tracked files were clean. Existing untracked paths are preserved and excluded from this work: `desktop-shell/native-spike/`, `output/`, five `plugins/cetamesh-*` directories, `scripts/test-desktop-plugin-helpers.mjs`, `scripts/test-desktop-plugins.mjs`, `src/desktop-plugin-host.js`, `src/desktop-plugin-storage.js`, and `src/mcp-desktop-utilities.js`.
- `AGENTS.md` is absent. `RULES.md` and `README.md` retain WhaleBridge / QQ bridge era context. `docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md` is a plan, not evidence of implementation.

### Actual implementation status

| Area | Source inspection | Verification |
|---|---|---|
| Desktop Shell | Native Windows Rust `eframe/egui` UI; currently an administration console | Cargo check/test and shell smoke ran; visual interaction is `PENDING_NATIVE_VERIFICATION` |
| Core and lifecycle | Node.js ESM Core; source worker and Node SEA executable; Rust supervisor starts, restarts, stops, and waits for readiness | Core entry, supervisor, and SEA worker tests ran as listed below |
| IPC | Windows Named Pipe; v1 little-endian length-prefixed JSON, requests/responses, events, structured errors, version checks | Rust tests, Node IPC test, and shell smoke `PASS` |
| Chat / Agent | No mature independent CetaMesh Chat product page; DSH client/session APIs exist, but no generic AgentProvider contract | Chat loop from `d632720` was reverted by `34b321d`; it is not current functionality |
| Model Provider | DSH model catalog, default model, and presets exist; no generic Model Provider or credential store | Generic provider flow not verified |
| Memory | Primarily QQ/Social Memory tools and storage; no unified authorized Memory Runtime | Product-level cross-session/task/workspace memory not implemented or verified |
| Workspace | DSH workspace API concepts exist; no CetaMesh-owned file security boundary | Product-level isolation not implemented or verified |
| Tasks / Continuity | Internal service tasks exist; no CetaMesh Persistent Task, Context Rollover, or Agent Handoff runtime | Deferred: the earlier explicit instruction not to start Persistent Task v1 remains in force |
| Capability / Approval | Legacy roles/policy and approval/question/risk queues exist; no unified Capability, Permission, Approval, Audit, and Workspace Scope engine | Only legacy module regression coverage ran |
| Channels / MCP | QQ/SnowLuma adapters and MCP host/dispatch exist; they are adapters, not the Core center | Core entry, DSH integration, and privilege tests ran |
| Plugins / Device Mesh | No verified Desktop plugin install/execution system or Device Mesh protocol in tracked source | Untracked plugin drafts/declarations are not treated as runnable features |
| Installer / release | Native install, repair, migration, uninstall, SEA, and release scripts exist | Installer lifecycle and SEA/Core distribution tests ran; full Release Candidate remains unverified |

Security defaults confirmed in source: `allowAllWhenEmpty=false`, `snowluma.allowProcessControl=false`, and `socialV2.tools.clickCardButton=false`.

### Source checks and automated verification

`PASS` applies only to the command run on this machine; it does not imply external services, native visual interaction, or release coverage.

| Check | Status | Result and boundary |
|---|---|---|
| `npm run test-privilege` | `PASS` | 24 passed, 0 failed; live end-to-end portion did not run because fetch failed (`NOT_RUN_ENVIRONMENT`) |
| `npm run test-core-entry` | `PASS` | Core entry, MCP modes, and temporary worker startup |
| `npm run test-dsh-integration` | `PASS` | Install/repair/migration/rollback/idempotence and DSH config snapshot preservation |
| `npm run test-desktop-supervisor` | `PASS` | Supervisor lifecycle |
| `npm run desktop:check` | `PASS` | Rust Desktop check |
| `npm run desktop:test` | `PASS` | Final run: 62 Rust tests, including remove-data uninstall transaction regression |
| `node scripts/test-control-service.mjs`; `node scripts/test-ipc-protocol.mjs` | `PASS` | Control service and Node IPC protocol |
| `npm run test-desktop-shell` | `PASS` | Core/Shell IPC, query/control, restart, shutdown, and conflict paths; existing instance held the single-instance lock, so interactive UI was not verified (`PENDING_NATIVE_VERIFICATION`) |
| `node scripts/test-desktop-install.mjs` | `PASS` | Final standalone run covered install, upgrade, repair, migration, preserve-data uninstall, full data removal, and reinstall. An earlier concurrent run once exited with stack overflow `3221225725`; subsequent isolated and parallel runs passed and did not reproduce it. This remains an intermittent observation, not a confirmed root-cause fix. |
| Core SEA build in a unique temporary output directory | `PASS` | Resource/executable audit passed; executable `--help` ran; existing `dist/` was not overwritten |
| `scripts/test-core-dist.mjs` against that temporary SEA output | `PASS` | PATH-isolated worker, data paths, MCP stdio, API authentication, DSH compatibility, and process cleanup; assertions now reflect the API-only/no-product-HTML Core contract |
| `npm run self-test` | `NOT_RUN_ENVIRONMENT` | It creates a DSH session and sends a prompt, so requires a live DSH/model and external session side effects; not launched |
| Release build / Release Candidate / installer package / icon checks | `NOT_RUN_ENVIRONMENT` | No fresh complete candidate was produced; existing ignored `dist/` was preserved, so there is no release verification claim |
| Native Windows UI visual operation | `PENDING_NATIVE_VERIFICATION` | Automated shell smoke is not a visual interaction check |

The Core build emitted a duplicate `collect` key warning in `src/bridge.js` and a Windows SEA injection signature warning. Neither failed the build. The earlier installer stack overflow was not reproduced; do not claim its cause is resolved.

### D0 changes in this stage

- `desktop-shell/src/installer.rs`: added a regression test ensuring successful `--remove-data` uninstall removes user data, the empty install directory, and the temporary backup.
- `scripts/test-desktop-install.mjs`: scoped registry cleanup to this run's unique test key and added opt-in preservation of the temporary directory for debugging.
- `scripts/test-core-dist.mjs`: asserts the current API-only SEA contract, checks resource trees contain no product HTML, and registers child-process exit listeners before killing processes.
- This file records the verified repository snapshot and test boundaries.

Only these three code/test files and `PROJECT_STATE.md` are candidates for this local commit. Pre-existing untracked paths remain excluded. Do not push.

### Next stage entry

Recommended: roadmap D1 Foundation / `TASK-D1-001`, first inventorying configuration readers/writers, data paths, sensitive fields, and callers, then defining the smallest backward-compatible Unified Config Service boundary. Do not start Persistent Task v1, Context Rollover, or Agent Handoff runtime until the user explicitly lifts the existing deferral. Candidate product order after that: Chat, Memory, Workspace security boundary, then AgentProvider, each with its own verifiable loop.

---

> 状态日期：2026-10-04  
> 仓库：`chx6418-source/whalebridge`  
> 产品名称：`CetaMesh`  
> 当前基线：`main@05a6c991c980ff951ea5f357699c657eb0b4c629`（D0 基线复验 + installer 栈溢出修复；本文件更新在其后的 docs 提交中）  
> 范围：**Desktop / Windows only**。Mobile 已独立到 `chx6418-source/cetamesh-mobile`，本文件不记录 Mobile 具体实现。

---

## 阶段 01 审计 — 2026-10-04（真实状态审计，基线 `main@d35dbfe`）

本节是「阶段 01：CetaMesh Desktop 真实状态审计」的产物，方法为打开实际代码取证（grep / 读文件 / 实跑测试），不按名字判断。它不重复上方快照，只补充证据位置与增量结论。v1 交付检查表见 `docs/desktop/DESKTOP_V1_PLAN.md`。

### 能力矩阵（17 项，证据为本机源码）

| 能力 | 标签 | 证据（file:line 为 2026-10-04 实测） |
| --- | --- | --- |
| Chat | PARTIAL | QQ↔DSH 桥接聊天全链路在 `src/bridge.js`（10003 行）；桌面 Chat 产品页不存在（`cdb3bd8` 已弃、`34b321d` revert）；`public/console.html`（324KB）为旧 Web 控制台遗留，发行构建不打包 |
| Session | IMPLEMENTED | QQ 会话↔DSH 会话映射 `state/sessions.json`（`bridge.js:120,624`）；DSH session API（`src/dsh-client.js:7-8` 端点速查） |
| Model Provider | PARTIAL | 模型目录/默认模型/preset 绑定（control 28 方法中 model.*/preset.*）；`settings/describe`×8、`selectModel`×4 实际调用；无通用 ModelProvider 抽象、无独立凭据库 |
| DSH | IMPLEMENTED | `src/dsh-client.js`：session/create\|prompt\|cancel\|list、selectModel、workspace/create\|rename\|list\|reset\|archiveSession、settings/describe、agentPresets/list、`$events/result`、remote.mux WS follow |
| Agent | PARTIAL | whale-chat / whale-chat-v2 preset + 角色注入 + `dsh/agent-presets/*/qq-tool-restrict.mjs` 工具收敛；**无 AgentProvider 抽象**（grep 0 命中） |
| Task | PARTIAL | 仅内部 service task；Persistent Task 无任何实现（grep 0）；**BLOCKED（所有者冻结）** |
| Memory | PARTIAL | `qq_memory_append/query/remove/clear`（`bridge.js:4992-5111`，socialV2 存储 + `v2ToolEnabled('memory')` 会话令牌门）；无统一 Memory Runtime、无跨会话/任务记忆 |
| Workspace | PARTIAL | DSH 侧 workspace API（create/rename/list/reset/archiveSession）；无 CetaMesh 自有文件安全边界 |
| Capability | MISSING | 无 Registry/Permission 引擎（grep 0）；未知能力默认拒绝的原则只在旧模块局部成立 |
| Approval | IMPLEMENTED | legacy 队列：`pending.list/decide`（`control-service.js:31-32,150-206`）+ ask_user 转发 + 风险卡逐次审批（`state/social-v2-cards.json`） |
| Security | IMPLEMENTED | 双令牌分离（`src/bridge-privilege.js` 收敛式白名单）、回复审计硬拦截（`src/sensitive.js`）、SSRF 防护（`src/safe-fetch.js`）、发送强制白名单；安全默认 `allowAllWhenEmpty=false` / `snowluma.allowProcessControl=false` / `socialV2.tools.clickCardButton=false`（源码证实） |
| IPC | IMPLEMENTED | `src/control/ipc-protocol.js` v1（4 字节长度前缀 JSON、1MiB 帧、30s 超时、结构化错误）；`control.execute` 28 方法白名单 + `core.ping`；事件仅 `core.ready` |
| Named Pipe | IMPLEMENTED | `desktop-shell/src/ipc_client.rs` + `supervisor.rs` + `core_launch.rs`；shell smoke PASS |
| Installer | IMPLEMENTED | `installer.rs` / `install_cli.rs` / `migrate.rs` / `native_installer_ui.rs`；安装/升级/修复/迁移/卸载/重装全生命周期测试 PASS |
| Update | MISSING | 无任何自动更新机制（auto-update/checkForUpdate grep 0）；仅有重装/修复路径 |
| QQ / Channel | IMPLEMENTED | SnowLuma OneBot v11 + `mcp-snowluma-safe/host` + 卡片风险审批；定位为 Channel Adapter，非 Core 中心 |
| Plugin | PARTIAL | DSH 侧 `plugins/whale-mode-console`（已跟踪）；桌面插件系统仅存在于**未跟踪草稿**（`src/desktop-plugin-*.js` 等），不作为已有能力 |

### 6 项“是否真有 Runtime”的确认

`AgentProvider` / `PersistentTask` / `rollover` / `handoff` / `Checkpoint` / `CapabilityRegistry` 在 `src/` 与 `desktop-shell/src/` 中 **grep 全部 0 命中**。Workspace 安全边界与统一 Memory Runtime 同样无 runtime。相关设计只存在于 `docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md` 与 roadmap（PLANNED，非实现）。Context Rollover / Agent Handoff / Persistent Task 运行时：**BLOCKED（所有者冻结）**。

### 旧四模式现存位置（只记录，本阶段不重构）

`chat` / `closed-agent` / `reserved` / `reserved2` 出现于：`src/bridge.js`(14 处)、`src/control/control-service.js`(3)、`desktop-shell/src/native_ui.rs`(5)、`README.md`(2)、`RULES.md`(2)。处置属 workplan TASK-D7-001，reserved* 去留需所有者决策。

### 代码与旧文档的不一致（增量补充）

- `AGENT_CONTEXT.md`（116KB，09-22）：WhaleBridge/QQ 时代内容；其“多智能体协作唯一事实源”自我定位已过时。**历史参考地位**（详见第 17 节）：`PROJECT_STATE.md` = 当前状态入口；`AGENT_CONTEXT.md` = WhaleBridge 历史实现资料。保留，不删除。
- `README.md` / `RULES.md` / `config.example.json`：品牌与结构仍是 WhaleBridge QQ 桥（与代码一致，但产品名已定 CetaMesh；全仓改名被 workplan 规则 13 明确暂缓）。
- `desktop-shell/README.md`：Tauri/WebView 描述为历史段落（文件头已注明以 Cargo/native_main.rs 为准）。
- `docs/DESKTOP_APP.md` / `DESKTOP_ACCEPTANCE.md`（09-23）：未反映 10-04 的 D0 复验与缺陷修复。
- roadmap / continuity spec：**规划文档，不构成实现证据**（上方快照已声明，此处重申）。
- `AGENTS.md` 不存在。

### 本阶段测试结果（2026-10-04 本机实跑，基线 `main@d35dbfe`）

| 测试 | 结果 |
| --- | --- |
| `npm run desktop:test` | PASS（62/62，含 `d35dbfe` 新增 remove-data 事务回归） |
| `npm run test-core-dist` | PASS（`d35dbfe` 改后复验） |
| `npm run test-desktop-install` | PASS（`d35dbfe` 改后复验） |
| `npm run test-privilege` | PASS（24/24） |
| `npm run test-core-entry` | PASS |
| `npm run test-dsh-integration` | PASS |
| `node scripts/test-control-service.mjs` | PASS |
| `node scripts/test-ipc-protocol.mjs` | PASS |
| `npm run test-desktop-shell` | PASS（视觉交互 PENDING_NATIVE_VERIFICATION） |
| `npm run self-test` | NOT_RUN_ENVIRONMENT（DSH 127.0.0.1:3080 拒绝连接，实测） |

### 技术债与风险

1. `src/bridge.js` 10003 行单体（模式/会话/审批/记忆/贴纸/TTS 混居）——D1-008 增量抽取对象，禁止一次性重写。
2. 配置系统：默认值内联于 `loadConfig()` 约 290 行 + 三个旁路读取者（`local-services.js` / `mcp-host-server.js` / `mcp-snowluma-safe.js` 执行期直读 config.json）——D1-001 统一入口待建。
3. 卸载回滚弱点仍在：data_dir 快照备份位于 data_dir 内部，中途失败触发回滚时备份会随数据目录先被删除（`d35dbfe` 回归测试只覆盖成功路径）。
4. 无自动更新通道（About/Update 缺失）。
5. 未跟踪插件草稿长期漂移：保留/删除需所有者决策（禁止 `git add -A`，提交只按文件）。
6. 本地 main 领先 origin/main 5 个提交未推送——推送时机由所有者决定。
7. 构建警告：`src/bridge.js` 重复 `collect` key、Windows SEA 注入签名警告（不阻塞，未修）。

### 推荐下一阶段

**D1 Foundation / TASK-D1-001 Unified Config Service**（入口与前置盘点见 `docs/desktop/DESKTOP_V1_PLAN.md` Stage B）。Persistent Task / Rollover / Handoff 冻结照旧。

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

---

## 24. 2026-10-04 本机基线验证记录（TASK-D0-001 / D0-002）

范围：Windows 10（10.0.22631 x64）开发机，`D:\GIT-QQ-BRIDGE`，分支 `main`。验证基线：`main@05a6c99`（本文件在其后的提交中更新）。

### 已验证（PASS）

| 测试 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test-privilege` | PASS | 24/24；运行中桥接的端到端部分由脚本自动跳过（本机桥接未运行） |
| `npm run test-core-entry` | PASS | worker + 五个 MCP 模式 |
| `npm run test-dsh-integration` | PASS | 隔离沙箱；真实 `~/.dsh` 字节级未触碰 |
| `npm run desktop:check` | PASS | cargo check 无警告错误 |
| `npm run desktop:test` | PASS | 61/61 |
| `npm run test-desktop-supervisor` | PASS | 孤儿守卫 / restart / shutdown 契约 |
| `npm run test-desktop-shell` | PASS | 首跑 FAIL 是 `target/debug` 旧 exe（09-22）与 09-23 源码不匹配；重建后通过 |
| `npm run test-desktop-install` | PASS | 先修复下述 P1 缺陷后全生命周期通过 |
| `npm run test-core-dist` | PASS | 无系统 Node 参与 |
| `npm run build:core` + `build:release` + `test-release-candidate` | PASS | 中文+空格路径 / 无系统 Node / 只读安装目录 / 崩溃恢复 / 单实例 / 孤儿守卫 / 卸载保留数据 |

### NOT_RUN_ENVIRONMENT

- `npm run self-test`：需要运行中的 DSH（`127.0.0.1:3080`），本机未启动（ECONNREFUSED）。真实模型链路仍未验证，不得记为 PASS。

### D0 期间发现并修复

- **P1：`--uninstall --remove-data` 必现栈溢出（0xC00000FD）**。备份目录建在 `data_dir/.whalebridge-backup/<stamp>/` 内部，而卸载计划对 `data_dir` 本身做快照，`snapshot_path → copy_dir` 的复制源包含复制目标，无限递归（并伴随备份树指数复制、磁盘占满风险）。修复：`copy_dir_excluding` 在快照复制时排除备份子树（`installer.rs`）。修复后 `test-desktop-install` 全生命周期 PASS。
- **已知遗留（未修，D1 候选）**：回滚路径中 `data_dir` 的快照备份位于 `data_dir` 内部——若卸载中途失败触发回滚，`remove_path(data_dir)` 会先删掉备份导致恢复不完整。需要把备份目录设计到被删树之外（涉及备份位置契约，非本阶段范围）。

### 基线清点结论（对照正文其余章节）

- 正文的架构 / 入口 / 安全默认描述与本机代码一致，无需改写；本节仅补充日期化验证记录。
- 安全红线复验：`test-privilege`（双令牌收敛）、RC 测试断言（HTTP console-token 管理调用被拒、根路径仅 JSON、PATH 无 node）均通过。
- `dist/core`、`dist/app` 已从当前源码重建；旧产物（09-21/22，缺 `noWebUi` 标记）曾让 `test-release-candidate` 首跑 FAIL——**产物过期会伪装成回归，先核对 `builtAt` 再下结论**。

### 历史事实（防止重复踩坑）

- 2026-10-04 17:47 的提交 `cdb3bd8`（native desktop chat loop）已于当日 18:00 被 reset 主动放弃；所有者已确认该方向作废：桌面 Chat 闭环（`src/desktop-chat-service.js`、`chat.*` IPC、`native_ui.rs` 对话页）与 desktop-utilities 插件接线（`--plugins` CLI、`mcp-cetamesh-desktop` 注册）均**不得恢复重建**。当日曾有一次错误恢复（`d632720`），已用 `34b321d` revert 撤销。
- 工作区存在未跟踪文件：`src/desktop-plugin-host.js`、`src/desktop-plugin-storage.js`、`src/mcp-desktop-utilities.js`、`plugins/cetamesh-*`、`scripts/test-desktop-plugin-*.mjs`、`desktop-shell/native-spike/`、`output/`。这些文件**保留原样：不接线、不引用、不删除、不作为开发基础**；其存在不代表已批准的产品方向。
- Persistent Task v1 等禁扩建清单照旧（见第 20 节）。

### 下一阶段入口

- D1 Foundation → **TASK-D1-001 Unified Config Service**（`src/config/`：Zod schema + 旧 config 迁移 + 损坏 fail-closed；验证 `test-core-entry` / `test-privilege` / `self-test`）。尚未开工。
