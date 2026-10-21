# HANDOFF — 技术债收口会话 2：D3 Storage Primitive + D12 State Retention + D7 文档瘦身

日期：2026-10-07

## Git

- Base HEAD：`142ebb6`（main，"docs(handoff): record tech-debt session 1"——会话 1 已合并后的最新 main）
- 工作分支：`refactor/storage-foundation-v1`
- Final HEAD：本文件所在提交的前一版代码提交（交接文档提交后 Final = 本提交）
- 未 push；Owner 确认后合并 main 并删除工作分支。
- 提交清单：
  1. `refactor(storage): add shared json persistence primitives`
  2. `refactor(state): migrate runtime stores to shared storage`
  3. `feat(state): add bounded retention policies`
  4. `docs(state): reduce active agent context footprint`
  5. `test(storage): register storage and retention suites`
  6. `fix(continuity): import discardFile used by packet pruning`

## Storage API（src/storage/json-file.js，D3）

统一的是「JSON 文件可靠 I/O」，**不是** Domain Schema；没有任何 GenericStore 接管业务语义。

```
readJsonFile(file, { missing, maxBytes })   // missing 用 Object.hasOwn 区分「没配」与「fallback=undefined」
writeJsonAtomic(file, value, { mode=0o600, indent=2 })
writeTextAtomic(file, text, { mode=0o600 }) // 设备身份 PEM / token 等非 JSON 持久化
updateJsonFile(file, mutate, options)       // 读改写 convenience；无锁，并发语义仍归 Domain
parseJsonText(text, { file })               // BOM 容错解析（供已有文本的使用点）
discardFile(file)                           // best-effort 删除（清理语义专用，返回 boolean）
StorageError: MISSING | CORRUPT | READ_FAILED | TOO_LARGE | WRITE_FAILED（.file / .cause）
```

- 原子写：同目录临时文件 `file.<pid>.<crypto 16hex>.tmp` → write → fsync（尽力）→ rename 替换 → 失败清理 temp。
- Windows：rename 覆盖替换 + EPERM/EBUSY/EACCES 有界重试（5 次，25ms×2ⁿ 退避，杀毒/索引类句柄场景）。
- 读：BOM 统一剥离；空文件/非 JSON = CORRUPT（**不偷偷降级为 {}**）；maxBytes 默认 128 MiB 防失控读取。
- Storage 层不定义 Domain 错误码；Domain 把 StorageError 映射为自己的错误码，UI 侧契约零变化。

## Migrated Stores（全部改经 Primitive）

task/store · memory/store · memory/runtime（candidates）· memory/links（顺带获得 BOM 容错）·
extension/store（registry + 扩展私有存储）· extension/installer（manifest 解析）· extension/memory-pack（解析）·
settings/store · continuity/runtime（含 packet/reconciliation 落盘）· desktop/chat-service（sessions+history）·
mesh/trust · mesh/identity（读 JSON + writeTextAtomic 写 key）· workshop/service · router/service（policy）·
config/loader（底层复用 parseJsonText/writeJsonAtomic，ConfigError 文案逐字节保持，test-config-service 69 项全过）。

- **错误码兼容**（对外不变）：STORE_CORRUPT/STORE_UNREADABLE（task）、STORE_CORRUPT（memory/links/candidates）、
  REGISTRY_UNREADABLE/REGISTRY_CORRUPT/MANIFEST_CORRUPT（extension）、TRUST_CORRUPT/TRUST_UNREADABLE、
  IDENTITY_CORRUPT/IDENTITY_UNREADABLE、WORKSHOP_STORE_CORRUPT、STORE_CORRUPT（continuity/chat）、
  CONFIG_CORRUPT/CONFIG_NOT_OBJECT/CONFIG_MISSING。UI 永远看不到 StorageError。
- capability/service + capability/approval：仅把 pid-only 临时名加固为 pid+crypto 随机名（未整体迁移，见下）。
- bridge.js `saveState()`：弃用固定 `STATE_FILE + '.tmp'` 名（可预测临时名反模式），改走既有 atomicWriteJson。

## Not Migrated（有意为之）

- **bridge.js 其余状态文件**（sessions.json 之外的 social-v2 / slang / stickers / feedback / tokens）：属 legacy
  runtime，本轮不做"覆盖率 100%"式迁移；其原子写/BOM 语义与 Primitive 等价。
- **capability service 完整迁移**：与 D5 IPC/Composition Root 有耦合，只做临时名加固。
- **local-services.js / about/build-info.js** 的 BOM 解析点：legacy 面，行为不变。
- 建议：上述残留可在后续会话按需逐个收编（每个都是 <10 行的小改）。

## Corruption Semantics（逐域明确，无静默吞损坏）

| Domain | 缺失 | 损坏（parse/读失败） |
| --- | --- | --- |
| config | required=true → CONFIG_MISSING fail-fast | CONFIG_CORRUPT fail-closed |
| task | 空状态起步 | STORE_CORRUPT fail-closed |
| memory store / links / candidates | 空状态起步 / 空 links | STORE_CORRUPT fail-closed |
| settings | 默认值 | 回落默认值 + `lastError` 如实上报（不阻断启动，UI 可见） |
| extension registry | 空注册表 | REGISTRY_CORRUPT fail-closed |
| continuity / chat | fallback | STORE_CORRUPT fail-closed |
| mesh trust / identity | 未配对起步 | TRUST/IDENTITY_CORRUPT fail-closed |
| workshop | 默认空状态 | WORKSHOP_STORE_CORRUPT fail-closed |
| router policy | 默认策略 | 回落默认（策略非关键数据，不阻塞聊天） |
| social-v2 cards | 空 | 空（cache，可回源） |

## Retention（D12；新模块 `src/logging/rotate.js`、`src/social-retention.js`）

| 状态 | 策略 |
| --- | --- |
| bridge.log | >1 MiB（= CONTROL_LOG_MAX_BYTES，tail 读取窗口对齐）→ 轮转 `bridge.log.1`；替换每条日志整读文件的旧裁剪 |
| social-v2.json | 14 天不活跃会话清空消息性缓冲（recentMessages/unread/activeTopics/pendingThoughts/memberImpressions/seenForwardIds/wakeTimes/sendTimes/stickerCollectTimes），**wakeConfig 保留**；总会话 ≤500，超出从最不活跃整体丢弃 |
| social-v2-cards.json | 卡片条目新增 `time` 时间戳；7 天 TTL + 会话 ≤300（cache 语义，可经 OneBot 回源）；remember 时刷新会话 recency |
| continuity packet | rollovers.json ≤200（既有）；每 task 的 packet/reconciliation 文件保留最近 20，写入时清理（`prunePacketFiles`，已导出） |
| memory candidates | pending ≤500（满则 STORE_FULL，显式报错，**绝不静默丢**）；已决策候选保留最近 200（`pruneDecidedCandidates`，已导出，内存态同步淘汰） |
| 长期记忆 | **不适用任何日志式清理**（测试红线覆盖：50 条旧时间戳记录原样保留） |
| 既有保留 | qq-activity 500 行 / tool-calls 2000 行 / feedback 500 条 / task agentHistory 100 / MAX_TASKS 5000 / MAX_RECORDS 20000 / fileSendCache 7 天 TTL（审计确认，未改） |

拍板依据：阈值全部为「月级 TTL / 数百条」的宽边界，正常用户永远触不到；pending 候选满额显式报错而非淘汰。

## Docs Archive（D7）

- 新 `PROJECT_STATE.md`：144KB → 8KB（Current State / Architecture / Verified State / Retention /
  Known Risks / Active Work / Next Steps / 文档地图）。历史快照原样归档：
  `docs/archive/project-state/PROJECT_STATE_2026-10-07_PRE_STORAGE.md`。
- `docs/archive/AGENT_CONTEXT.md`（旧 Web 控制台事实源，SUPERSEDED）。
- `docs/archive/handoffs/`：HANDOFF_SESSION_1/2/3、HANDOFF_TECHDEBT_SESSION_1。
- `docs/archive/reports/`：ARCHITECTURE_INTEGRATION_REPORT、DESKTOP_V2_HARDENING_REPORT、FINAL_DESKTOP_RC_REPORT。
- 新根目录 `AGENTS.md`（阅读契约）：开始工作只读 RULES.md → PROJECT_STATE.md → 相关架构文档；
  `docs/archive/**` 仅历史调查时按需读。未删除任何历史文件（全部 git mv，可追溯）。
- 会话 1 移交的 AGENT_CONTEXT「仓库卫生·审计」剩余项（design-demos 组装链漂移、硬编码本机路径、
  测试端口隐式依赖）：属 legacy 源码清理决策（涉及删源码），**未在本轮处理**，留给 Owner/后续会话。

## Tests

- 新增 3 套件（已登记 `scripts/run-all-tests.mjs`，孤儿检测覆盖）：
  - `test-json-storage`（23 组）：原子覆盖替换、BOM、损坏、空文件、缺失、maxBytes、temp 清理、
    rename 失败（目标为目录）、并发 update 不损坏、Windows 空格/中文路径、writeTextAtomic。
  - `test-storage-migrations`（27 组）：各 store 重启读回 / BOM / 损坏错误码逐域断言 /
    Task expectedRev 冲突兼容 / continuity packet 收敛 / config 文案逐字节一致。
  - `test-state-retention`（24 组）：日志轮转、会话缓冲 TTL + wakeConfig 保留、卡片 TTL/上限、
    已决策候选淘汰（pending 永存）、长期记忆不受清理红线。
- 最终全量 `npm test`：**62 PASS · 1 FAIL · 4 NOT_RUN_ENVIRONMENT**（会话 1 为 59 PASS · 1 FAIL）。
  - 唯一 FAIL：`test-desktop-shell` 末段「深色主题应用日志」超时——与会话 1 记录的既有问题**同一失败点**
    （该等待读取的是 Rust 壳自身 shellLog，本轮零 Rust 改动；会话 1 已在其 base 上复现，环境敏感）。
  - NOT_RUN_ENVIRONMENT：test-mcp-exec / test-onebot-connection（无网关）、test-mcp-web-search（公网）、
    test-console（需运行中的 legacy 桥接）。
- `npm run desktop:test`：cargo 109/109 PASS。
- 静默失败红线：通过；存量裸 catch **净减 1**（112 → 111，workshop 迁移顺带消除），基线已按规则收紧。

## Session 3 Entry Point

1. **D4 Composition Root**：bridge.js 服务装配收拢（装配顺序/依赖注入显式化）；迁移清单里"Not Migrated"
   的 capability 完整迁移建议在此一并处理（天然属于装配重构）。
2. **D5 IPC 结构收口**：Control Plane / Data Plane 分离之上做结构化（不改协议语义）。
3. **DSH Lifecycle**：启停/健康/版本边界。
4. **D6/D9/D11/D14 收尾 + 全量 RC**：`build:core → desktop:build → build:release → test-release-candidate`。
5. 顺手项（非阻塞）：supervisor.rs HTTP 探活死代码删除；裸 catch 存量 111 处按 config/storage/security
   优先级消化并继续收紧基线。

## 已知边界（不装完成）

- bridge.log 轮转在 `.1` 被外部程序长期占用的极端场景下会持续重试（日志继续追加，下次轮转成功后收敛）。
- social-v2 会话「14 天不活跃清消息缓冲」意味着超期休眠群重新激活时上下文从零重建（wakeConfig/管理员配置保留）；
  卡片缓存 7 天过期后靠 OneBot 回源（与缓存淘汰前未收到卡片时的行为一致）。
- `npm test` 里 `test-desktop-shell` 的既有深色主题段超时未在本轮修复（非本轮范围，Rust 侧）。
