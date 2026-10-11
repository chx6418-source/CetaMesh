# CetaMesh Desktop — PROJECT_STATE

> 本文件只保留**当前事实**（Current State / Active Work / Next Steps）。
> 历史阶段快照与旧执行报告已归档至 `docs/archive/`，调查历史时才需要读取（见文末「文档地图」）。
> 读取契约见根目录 `AGENTS.md`；协作红线见 `RULES.md`。

## Git facts (2026-10-08)
- Session 3 base HEAD: `aaff6bf490c95f77e64aed3ebef61f8dbdeb6fba` on local `main`, including Sessions 1 and 2.
- Session 3 integration commit: `c22257240be86f7c8dfd2badee5b3f862a134cc6`; integrated into `main` and pushed to `origin/main`.
- `refactor/core-composition-v1` was merged to `main`; its managed worktree was archived and the local branch was deleted.
- Session 1 / 2 handoffs: `docs/archive/handoffs/HANDOFF_TECHDEBT_SESSION_1.md` and `docs/archive/handoffs/HANDOFF_TECHDEBT_SESSION_2.md`.
- 上线冲刺任务 B（统一配对）：`feature/unified-device-pairing-v1`（基线 `e8a122a`）已在 Owner 确认后**快进合并**到本地
  `main`（实现 `18a2d5d` + 文档 `3f28079`），工作分支已删除；两端协议副本与 `fixtures/pairing/` 已核对为 blob 级一致。
  **未 push**（等 Owner 指示）。协议事实源 `docs/protocol/UNIFIED_PAIRING_V1_1.md`，验收报告 `UNIFIED_PAIRING_INTEROP_REPORT.md`。
- 上线冲刺任务 D（Web → Native 高保真主题迁移）：`feature/native-theme-fidelity-v1`（基线 `e8a122a`，实现 `13a54d4`）已在 Owner
  确认后**合并**到本地 `main`（merge commit `ce647b1`；与任务 B 的 `PROJECT_STATE.md` / `mesh_ui.rs` 冲突已按双方保留原则解决）。
  合并验证时发现并修复一处**先于本分支的既有回归**：`4f6e3e8` 改写了主题应用日志措辞，`test-desktop-shell` 一直等待「主题已应用：深色」
  （此前无 debug 产物故未暴露）；修复为「深色/浅色 · 主题名」并保留历史契约（`6103199`）。合并后 `npm test` **70 PASS · 0 FAIL**。
  工作分支已删除。**未 push**（等 Owner 指示）。报告 `NATIVE_THEME_MIGRATION_REPORT.md`。

## Architecture（稳定面）

- **产品形态**：原生 Rust/egui 桌面壳（`desktop-shell/`）+ 单个 Node worker（`src/bridge.js` 兼容入口）。
  Release 无 HTTP：数据面走 `\\.\pipe\WhaleBridge-Data-*`（MCP → `src/control/data-ipc.js` → handleApiRequest），
  管理面走 `\\.\pipe\WhaleBridge-UI-*`；legacy HTTP 仅 dev 显式 opt-in（SEA 内无效）。
- **运行模式**（`src/runtime-surface.js`）：`native-release / native-dev / headless-dev / legacy-web-dev`。
- **Core 服务装配**：`src/app/bootstrap.js` → `src/app/service-container.js` 构造现代服务 → `src/app/ipc-runtime.js` 接管 UI IPC 路由。`src/bridge.js` 留作 worker 兼容入口和 Legacy QQ/Social runtime；Chat（`desktop/chat-service.js`，Model Runtime + 可选 DSH Agent Provider）→
  Smart Router（`router/`）→ Task（`task/`）→ Agent Broker（`agent/`）→ Continuity（`continuity/`，rollover/handoff）；
  Memory（`memory/`，授权分区检索）、Workspace（`workspace/`）、Capability Broker（`capability/`，fail-closed）、
  Extension（`extension/`）、Mesh（`mesh/`）、Workshop（`workshop/`）、Settings（`settings/`）、Config（`config/`）。
- **统一设备配对 v1.1（上线冲刺任务 B）**：`src/mesh/pairing/`（protocol / tls / invitations / server / client / qr）。
  Desktop 「连接手机」→ QR 邀请（同一文本可复制粘贴）；Mobile 扫码或粘贴 → 同一个 `parseInvitation` + PairingRuntime。
  配对 = HTTPS（每安装唯一自签证书，pin = sha256(DER) 写进邀请）+ 一次性 token（指纹先落盘再回包）+ 双向签名
  transcript（v1 / v1.1 由邀请是否含 `tlsPin` 决定，见 `docs/protocol/UNIFIED_PAIRING_V1_1.md`）。配对后经
  `POST /cetamesh/v1/mesh/envelope` 承载 presence / manifest / capability.request；默认 grants 仅
  `mesh.presence` + `mesh.manifest`（Trusted != Authorized 不变）。Desktop 身份 schema v2 = P-256
  （v1 Ed25519 受控迁移：备份 + `legacyNodeId`，旧对端需重新确认；旧 Ed25519 对端仍可验签）。
- **存储（D3 后）**：所有持久化 JSON 读写统一经 `src/storage/json-file.js`
  （`readJsonFile / writeJsonAtomic / writeTextAtomic / updateJsonFile / parseJsonText`）：
  crypto 随机临时名 + 0600 + fsync + rename 替换 + 失败清理 + Windows rename 有界重试 + BOM 统一剥离。
  Storage 层只报 `StorageError`（MISSING/CORRUPT/READ_FAILED/TOO_LARGE/WRITE_FAILED）；
  Domain 把它映射为自己的错误码（STORE_CORRUPT / CONFIG_CORRUPT / REGISTRY_CORRUPT / ...），UI 侧契约不变。
  **统一的是 JSON 文件可靠 I/O，不是 Domain Schema**；没有 GenericStore 接管业务语义。
- **主题系统（Task D 后，分支待批）**：`desktop-shell/src/theme/` 是 Native 壳的唯一视觉事实源——
  `ThemeSpec`（背景配方/表面/阴影/圆角/按钮/动效）+ 主题插值过渡 + egui 绘制器；页面经
  `native_palette()` 读取插值 token。`--screenshot-dir` 截图验收能力仅存在于 debug 构建（release 排除）。

## Verified State

- 测试唯一入口：`npm test`（`scripts/run-all-tests.mjs`，孤儿测试脚本未登记会直接 FAIL）；
  分类入口 `npm run test:core|architecture|security|runtime|integration|desktop|release|environment`；
  CI：`.github/workflows/ci.yml`（windows-latest：`npm ci → npm test → desktop:check → desktop:test`）。
- 会话 2 新增套件：`test-json-storage`（原语行为/Windows 语义）、`test-storage-migrations`（各 store 迁移回归）、
  `test-state-retention`（日志轮转/状态 TTL/候选淘汰）。Session 3 新增 `test-service-container`、
  `test-composition-boundary`、`test-ipc-runtime`、`test-dsh-lifecycle`、`test-qq-runtime` 和
  `test-runner-environment`（真实旧控制台测试须显式 opt-in）。
- 任务 B（统一配对）新增套件：`test-mesh-pairing-interop`（共享 golden fixtures + **真实局域网 TLS/HTTP 互操作**：
  配对握手 / 一次性 token / 过期 / pin 不符零字节 / presence / manifest / notification.send 审批链 / 重启免扫码 / 撤销）。
  `test-mesh-runtime` 的传输断言随 LAN（tcp）落地更新为 supported=`[loopback,tcp]`、deferred=`[pipe,relay]`；
  桌面壳新增配对 UI（QR 由 JS 生成矩阵、egui 画方块；`mesh_ui.rs` 单测 4 个）。
- Storage 迁移范围（会话 2）：task / memory（store+runtime+links） / extension（registry+manifest 解析+memory-pack） /
  settings / continuity（含 packet 清理）/ chat session / mesh（trust+identity）/ workshop / router policy /
  config loader 底层复用。capability 仅加固临时文件命名（crypto 随机），未整体迁移。

## Retention（D12 运行状态保留）

| 状态 | 策略 |
| --- | --- |
| `state/bridge.log` | 大小轮转：>1 MiB → `bridge.log.1`（`src/logging/rotate.js`），不再逐条整读文件 |
| `state/qq-activity.log` | 保留既有 500 行裁剪 |
| `state/tool-calls.jsonl` | 保留既有 2000 行裁剪 |
| `state/feedback.json` | 保留既有 500 条上限 |
| `state/social-v2.json` | 14 天不活跃会话只保留 wakeConfig/标量（清空消息缓冲）；总会话数 ≤500（`src/social-retention.js`） |
| `state/social-v2-cards.json` | 卡片条目带 `time`；7 天过期 + 会话数 ≤300（卡片可回源，cache 语义） |
| `state/mesh/pairing-used.json` | 已消费 token 指纹 ≤200 条、24h 过期清理；**只存 sha256 指纹，绝不含 token 原文** |
| `state/mesh/pairing-tls.json` | 每安装唯一配对 TLS 证书/私钥（持久；私钥不出机、不随日志轮转） |
| `state/continuity/` | rollovers ≤200（既有）；每 task packet/reconciliation 文件 ≤20，写入时清理 |
| `memory/candidates.json` | pending ≤500（满则 STORE_FULL，不静默丢）；已决策候选保留最近 200 条 |
| Task / Memory 本体 | 既有上限（MAX_TASKS=5000 / agentHistory≤100 / MAX_RECORDS=20000）；**长期记忆不适用日志式清理** |
| `fileSendCacheDir` | 保留既有 7 天 TTL |

损坏文件策略：Persistent truth（config / task / memory / trust / settings 值 / registry / continuity）fail-closed
或如实上报 lastError；仅明确标注为 cache 的数据（卡片、router policy、settings 回落）允许降级并留下记录，禁止静默 `→ {}`。

## Known Risks / Boundaries（当前仍然成立）

- Controlled Test Runner（`src/workspace/isolated-runner.js`）不是 OS 沙箱；VM Extension Host 不是进程隔离。
- `channel.send` 有校验面但未绑定真实传输。Mesh LAN（TLS pinning + 一次性 token）链路已实现并有真实 socket 验收；
  **真机 Android/iOS ↔ Desktop 实际配对未验证（NOT_RUN_ENVIRONMENT：本机无 Android SDK/adb/模拟器，已用 preflight 核实）**；
  pipe/relay 传输、Memory/Task/Approval 同步（协议 §15 M6）本轮未接。
- 历史存量裸 `catch {}`（`scripts/error-hygiene-baseline.json`，112 处）只许收紧，禁止新增。
- 桌面壳 `supervisor.rs` 的 HTTP 探活 fallback 已是死代码（待后续会话删除）。
- NOT_RUN_ENVIRONMENT（无真实环境时如实不跑）：真实 provider-key 回合 / 真实 QQ / 跨设备 Mesh / 签名 / 真实发行产物。

## Active Work (Owner confirmation pending)

- DSH Desktop Application Integration 完成，隔离分支 `codex/dsh-desktop-integration-v1`，worktree `C:\Users\Administrator\.codex\worktrees\dsh-desktop-integration-v1\GIT-QQ-BRIDGE`。Base HEAD `aec93a04a3b2b418f9345250e7fa190bdabef79c`；实现 HEAD `7a92356d11a6f2f6e01640e121c2a888e534e07e`。全量 `npm test`（启用登记的 Cargo suites）为 85 PASS / 0 FAIL / 10 NOT_RUN_ENVIRONMENT。实际检测到 DSH Desktop `0.2.0-rc.2` 运行中，CLI `0.1.5-rc.1` 可用。详见 `DSH_DESKTOP_INTEGRATION_REPORT.md`。尚未合并、推送或删除分支；等待 Owner 确认。

- UI v1（Owner 选定方案 01/02/04 融合，主题收敛为唯一「纸面」）**已完成并在 Owner 确认后合并**到本地
  `main`（快进；探索稿分支 design/ui-ia-exploration-2026-10 同批并入以兑现代码注释引用的视觉事实源）；
  合并完成：main 位于探索稿并入后的合并提交；工作分支 feature/product-ui-v1 与 worktree .worktrees/2026-10-11-product-ui-v1 已删除；安装包与纸面验收截图已拷贝到主检出目录 dist/app 与 output/uiv1-qa9。
  最终交付：导航 15→5+2；Chat 第一入口（历史列/消息区/Composer、工具·Agent·模型渐进披露）；
  智能体接 agent.list、插件接 plugins.*/tools.*/mcp.*（pending 不自动批准）；
  主题=唯一「纸面」（十主题移除、旧偏好值回落）；Core 状态卡在 设置→高级。
  视觉 bug 修复轨迹：蓝色旧胶囊（旧构建）/白弧（paint_button rim 门控）/悬停白圈/模式 chip/锚点滚动/
  重复标题/worker.log 人话提示/圆角渐变 mesh（选择框直角根因）/圆形发送键。
  验证：cargo check 0 error；cargo test 150P/17F（全部 TEMP/HKCU 沙箱同类）；
  npm test PASS 77；release/debug 构建成功；纸面截图 9/9 人工核验。
  安装包 1.0.0-rc.2（最新 48408f9）在主检出目录 dist/app/。**未 push**。

- 产品化任务 B（Tools / MCP / Plugin Integration Restoration）**已完成并在 Owner 确认后合并**到本地 `main`
  （merge commit `04ab303`：first parent `38ff756` = 合并前 main，实现 `ed3331d`）；工作分支
  `feature/tools-mcp-plugin-restoration-v1` 已删除。**未 push**（等 Owner 指示）。
  审计先把"工具消失"证伪：QQ MCP 工具全历史**只增不减**（39 个从未删改），不可用是挂载/白名单/默认开关问题——
  见 `LEGACY_TOOL_INVENTORY.md`（90 条历史条目，逐条 commit/路径取证）。
  交付：`src/integrations/**`（Plugins/Tools/MCP Registry + MCP Runtime，复用官方 MCP SDK 与既有
  `src/mcp-*.js`），IPC `plugins.` / `tools.` / `mcp.` / `integrations.` 四族；SnowLuma=Channel Provider、
  DSH=Agent Provider 以 Integration Plugin 呈现（不改底层架构）；CetaMesh 仿生聊天工具包 53 个工具
  = 46 restored / 5 partial（默认关，Owner 逐项开）/ 2 legacy-unsupported（进程控制）；
  所有工具调用与管理动作经 Capability Broker（high 风险 Owner Approve Once）。
  合并后全量：**PASS 78 · FAIL 0 · NOT_RUN_ENVIRONMENT 9**。报告 `TOOLS_MCP_PLUGIN_RESTORATION_REPORT.md`。
  Owner 确认后已 **push 到 `origin/main`**（`e8a122a..bd60537`，2026-10-10）；GitCode 远端
  `gitcode/main`（`5633dd7`）存在 1 个本地没有的提交，**未**强行推送（等 Owner 指示）。

- Product Intelligence Runtime / Product Context tool-calling follow-up is merged into local `main` through feature commit `b8c0cbc`; merged-tree `npm test` reported 73 PASS, 0 FAIL, 9 NOT_RUN_ENVIRONMENT (2026-10-10). Not pushed per Owner instruction.

- 反馈功能修正（2026-10-10）**已完成并在 Owner 确认后快进合并**到本地 `main`（`cc201ee..bf12184`）；
  工作分支 `codex/session-20261010-feedback-links` 与隔离 worktree `.worktrees/2026-10-10-feedback-links` 已删除。
  **未 push**（等 Owner 指示）。按产品决定**移除软件内反馈收集**：
  删除 `src/feedback/**`（FeedbackService / Outbox / 发送通道）、`feedback.*` IPC 与软件内表单；
  改为**只提供入口**——反馈与建议 / Bug 反馈 / 功能建议 / 安全漏洞，点击用系统默认浏览器打开官网页面
  （`/feedback`、`/feedback?type=bug`、`/feedback?type=feature`、`/security`），站点根来自 `release-config.json`
  （`feedback.baseUrl`，缺省回落 `website`），链接只带 `version` / `build` / `platform`（形状白名单）。
  新增 `src/product/feedback-links.js`、`desktop-shell/src/external_link.rs`（唯一允许调 `explorer.exe`
  的模块，https-only 校验）与 `test-feedback-links.mjs`（40 项）。
  验证（合并后在 `main` 上复跑）：`npm test` → PASS 70 · FAIL 3 · NOT_RUN 7（3 个 FAIL 全部是环境：
  `cargo:test` 的本会话 TEMP 限制 + 本机 3000 端口恰好有网关监听导致两个 environment 套件真实运行并失败）；
  `cargo test` 161 passed / 2 failed（HKCU 注册表限制）；`test-desktop-shell` 全通过。
  边界与细节见 `PRODUCT_SERVICES_REPORT.md`（含 §0.1 修订记录）。

- 产品化任务 D（Product Services / Onboarding / Feedback）**已完成并在 Owner 确认后快进合并**到本地 `main`
  （`ce83264..33ed3ce`：`049129f` 服务层 / `9f7d050` 原生 UI / `33ed3ce` 侧边栏与截图验收）；
  工作分支 `codex/session-20261009-2145-rules-confirm` 与隔离 worktree `.worktrees/2026-10-09-2145` 已删除。
  **未 push**（等 Owner 指示）。交付物与验收见 `PRODUCT_SERVICES_REPORT.md`：
  About 服务（build/release manifest 驱动，不写死版本）、更新公告安全渲染 + 离线缓存、
  ~~Feedback（本地 Outbox + 重试 + 诊断附件）~~（见上条修正：已改为纯入口）、
  First Run Onboarding（7 步，**不依赖 QQ/DSH/移动端**）、
  Provider 基础/高级字段视图与空状态文案；**原生桌面壳新增 About / Feedback / Onboarding 三个页面并接线**
  （`desktop-shell/src/product_ui.rs` + `native_ui.rs`，首次运行自动进入引导页；全站错误条统一为"用户语言优先 +
  技术细节折叠"）；新增 `test-product-services` / `test-onboarding` / `test-product-copy` 三个套件（已登记聚合器）。
  验证：`npm test` → **PASS 69 · FAIL 1 · NOT_RUN_ENVIRONMENT 9**（唯一 FAIL 为 `desktop/cargo:test` 的本会话令牌
  TEMP 限制）；`cargo test` **157 passed · 2 failed**（+12 新单测；2 项为 HKCU 注册表限制）；
  `test-desktop-shell`（构建 debug 壳 + `dist/core` 后）**全部通过**；debug 截图验收扩到 14 张
  （新增 About/Feedback/Onboarding 三页），并据此修掉"15 个导航项在 1280×800 下侧边栏被裁、Settings 点不到"
  的真实缺陷（侧边栏改为可滚动）。About/Feedback/Onboarding 三张验收截图保留在 `output/product-qa-task-d/`。
  详见报告 §5/§6.5；UI 需要的 IPC 契约（`about.*` / `update.notes` / `feedback.*` / `onboarding.*` / `product.*`）
  见报告 §4。

- 上线冲刺任务 B（统一配对）已完成并在 Owner 确认后合并到本地 `main`，工作分支与临时 worktree 已清理；
  Mobile 仓 `feature/unified-device-pairing-v1` 同样已合并到其本地 `main` 并删除分支。**两个仓库均未 push**（等 Owner 指示）。
- 上线冲刺任务 D（Web → Native 高保真主题迁移）已完成并在 Owner 确认后合并到本地 `main`；工作分支
  `feature/native-theme-fidelity-v1` 已删除。**未 push**（等 Owner 指示）。
  - Native 十主题升级为完整 Theme Engine（`desktop-shell/src/theme/`：spec / themes / painter / motion + debug-only qa 截图驱动）。
  - 配方逐值转写自 `design-demos/CetaMesh-ten-themes/public/console.html`；Soda 还原旧 Web 三段渐变 + 三光斑 + 白雾 + 软糖玻璃。
  - 动效：700ms 主题插值 + ripple、30fps blob 漂移、页面淡入、Reduce Motion 持久化（auto 跟随 Windows 动画开关）。
  - 验证：合并后 `npm test` 70 PASS · 0 FAIL（含 `desktop:check` / `cargo test` 142 项 / `test-desktop-shell`）；
    1280×800 验收截图在 `output/theme-qa/`（gitignored）。报告：`NATIVE_THEME_MIGRATION_REPORT.md`。
- 验收记录、遗留清单（M6 Memory/Task 同步未接；真机 Android/iOS = NOT_RUN_ENVIRONMENT）见 `UNIFIED_PAIRING_INTEROP_REPORT.md`。
- Session 3 技术债收口（`TECH_DEBT_CONSOLIDATION_REPORT.md`）仍有效。

## 文档地图（Agent 默认只读这里列的）

- 开始工作必读：`RULES.md` → 本文件 → 相关架构文档（`docs/desktop/ARCHITECTURE.md` 等）。
- 仓库操作事实：`README.md`；能力覆盖裁决表：`CAPABILITY_COVERAGE.md`。
- **历史调查才读**：`docs/archive/`（project-state 历史快照 / handoffs / reports、旧控制台事实源 `AGENT_CONTEXT.md`）。
