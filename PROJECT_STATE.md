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

## Active Work (none)
- 上线冲刺任务 B（统一配对）已完成并在 Owner 确认后合并到本地 `main`（`3f28079`），本地工作分支与临时 worktree 已清理；
  Mobile 仓 `feature/unified-device-pairing-v1` 同样已合并到其本地 `main`（`de0f0de`）并删除分支。**两个仓库均未 push**（等 Owner 指示）。
- 验收记录、遗留清单（M6 Memory/Task 同步未接；真机 Android/iOS = NOT_RUN_ENVIRONMENT）见 `UNIFIED_PAIRING_INTEROP_REPORT.md`。
- Session 3 技术债收口（`TECH_DEBT_CONSOLIDATION_REPORT.md`）仍有效。

## 文档地图（Agent 默认只读这里列的）

- 开始工作必读：`RULES.md` → 本文件 → 相关架构文档（`docs/desktop/ARCHITECTURE.md` 等）。
- 仓库操作事实：`README.md`；能力覆盖裁决表：`CAPABILITY_COVERAGE.md`。
- **历史调查才读**：`docs/archive/`（project-state 历史快照 / handoffs / reports、旧控制台事实源 `AGENT_CONTEXT.md`）。
