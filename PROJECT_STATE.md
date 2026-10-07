# CetaMesh Desktop — PROJECT_STATE

> 本文件只保留**当前事实**（Current State / Active Work / Next Steps）。
> 历史阶段快照与旧执行报告已归档至 `docs/archive/`，调查历史时才需要读取（见文末「文档地图」）。
> 读取契约见根目录 `AGENTS.md`；协作红线见 `RULES.md`。

## Git facts（2026-10-07）

- `main` = `142ebb6`（技术债会话 1 已合并：release HTTP 完整移除 + 统一测试入口/CI + 仓库卫生 + 静默失败红线）。
- 当前工作分支：`refactor/storage-foundation-v1`（技术债会话 2：D3 Storage Primitive + D12 State Retention + D7 文档瘦身）。
- 会话 1 的交接：`docs/archive/handoffs/HANDOFF_TECHDEBT_SESSION_1.md`。

## Architecture（稳定面）

- **产品形态**：原生 Rust/egui 桌面壳（`desktop-shell/`）+ Node Core（`src/bridge.js` worker）。
  Release 无 HTTP：数据面走 `\\.\pipe\WhaleBridge-Data-*`（MCP → `src/control/data-ipc.js` → handleApiRequest），
  管理面走 `\\.\pipe\WhaleBridge-UI-*`；legacy HTTP 仅 dev 显式 opt-in（SEA 内无效）。
- **运行模式**（`src/runtime-surface.js`）：`native-release / native-dev / headless-dev / legacy-web-dev`。
- **Core 服务装配**（bridge.js 内组装）：Chat（`desktop/chat-service.js`，Model Runtime + DSH 双通道）→
  Smart Router（`router/`）→ Task（`task/`）→ Agent Broker（`agent/`）→ Continuity（`continuity/`，rollover/handoff）；
  Memory（`memory/`，授权分区检索）、Workspace（`workspace/`）、Capability Broker（`capability/`，fail-closed）、
  Extension（`extension/`）、Mesh（`mesh/`）、Workshop（`workshop/`）、Settings（`settings/`）、Config（`config/`）。
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
  `test-state-retention`（日志轮转/状态 TTL/候选淘汰）。
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
| `state/continuity/` | rollovers ≤200（既有）；每 task packet/reconciliation 文件 ≤20，写入时清理 |
| `memory/candidates.json` | pending ≤500（满则 STORE_FULL，不静默丢）；已决策候选保留最近 200 条 |
| Task / Memory 本体 | 既有上限（MAX_TASKS=5000 / agentHistory≤100 / MAX_RECORDS=20000）；**长期记忆不适用日志式清理** |
| `fileSendCacheDir` | 保留既有 7 天 TTL |

损坏文件策略：Persistent truth（config / task / memory / trust / settings 值 / registry / continuity）fail-closed
或如实上报 lastError；仅明确标注为 cache 的数据（卡片、router policy、settings 回落）允许降级并留下记录，禁止静默 `→ {}`。

## Known Risks / Boundaries（当前仍然成立）

- Controlled Test Runner（`src/workspace/isolated-runner.js`）不是 OS 沙箱；VM Extension Host 不是进程隔离。
- `channel.send` 有校验面但未绑定真实传输；跨设备 Mesh 真实链路 = PENDING_NATIVE_VERIFICATION。
- 历史存量裸 `catch {}`（`scripts/error-hygiene-baseline.json`，112 处）只许收紧，禁止新增。
- 桌面壳 `supervisor.rs` 的 HTTP 探活 fallback 已是死代码（待后续会话删除）。
- NOT_RUN_ENVIRONMENT（无真实环境时如实不跑）：真实 provider-key 回合 / 真实 QQ / 跨设备 Mesh / 签名 / 真实发行产物。

## Active Work（技术债会话 2）

- 分支 `refactor/storage-foundation-v1`；完成后由 Owner 确认合并 main，交接见根目录 `HANDOFF_TECHDEBT_SESSION_2.md`。
- 本轮明确不做：Composition Root、IPC 结构大改、SQLite/向量库、bridge.js 大拆、DSH lifecycle、品牌 rename。

## Next Steps（技术债会话 3 入口）

1. D4 Composition Root：bridge.js 服务装配收拢（装配顺序与依赖注入显式化）。
2. D5 IPC 结构收口（Control Plane / Data Plane 既有分离之上的结构化，不改协议）。
3. DSH Lifecycle（启停/健康/版本边界）。
4. D6/D9/D11/D14 收尾 + 全量 RC（`build:core → desktop:build → build:release → test-release-candidate`）。
5. 建议（非阻塞）：历史裸 catch 按 config/storage/security 优先级逐类消化；删除 supervisor HTTP 死代码。

## 文档地图（Agent 默认只读这里列的）

- 开始工作必读：`RULES.md` → 本文件 → 相关架构文档（`docs/desktop/ARCHITECTURE.md` 等）。
- 仓库操作事实：`README.md`；能力覆盖裁决表：`CAPABILITY_COVERAGE.md`。
- **历史调查才读**：`docs/archive/`（project-state 历史快照 / handoffs / reports、旧控制台事实源 `AGENT_CONTEXT.md`）。
