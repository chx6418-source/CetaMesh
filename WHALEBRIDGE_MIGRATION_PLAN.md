# WhaleBridge 独立化 M2～M6 实施准备（设计，待 Owner 批准）

设计依据：本轮 M0/M1 证据、[WHALEBRIDGE_DEPENDENCY_MATRIX.md](WHALEBRIDGE_DEPENDENCY_MATRIX.md)、[WHALEBRIDGE_DATA_OWNERSHIP.md](WHALEBRIDGE_DATA_OWNERSHIP.md)、既有 [CM_AGENT_PROTOCOL_REVIEW.md](CM_AGENT_PROTOCOL_REVIEW.md) 与 363 行方法台账。审查起点 HEAD `f6586c323b41bb55872fac1d96e2a783ceeb7592`。**M2～M6 尚未实施，本文件不是启动迁移的授权。** 当前发布状态仍为 `RELEASE_BLOCKED`。

## 依赖方向与运行边界

```text
Harbor / Rust Shell → 已认证 Owner IPC → CetaMesh Core 组合根
                                        ├─ Chat / Model Runtime / Managed Agent
                                        ├─ Task / Memory / Workspace / Capability / Continuity
                                        ├─ Plugin / Extension / Device Mesh
                                        └─ AgentProvider / Channel / MCP 契约端口
                                              ↑                 ↑
                                  Codex、DSH Adapter     QQ、Bionic、MCP Connector

旧 CLI / 旧 HTTP(仅开发) → 有期限兼容门面 → 同一个 Core Owner IPC / Data IPC
```

Core 的 StateDir、Task、Workspace、审批与执行权不交给 Connector；每个原生流仅一个上游读取者，Chat/Task/Continuity 使用独立 cursor/投影。接受请求不代表执行完成；取消请求不代表进程已停；断流和未知副作用应记录 `unknown/needs_review`。沿用既有 Broker 和事件实现，先补契约与单写者证明，不再建立另一套广播器或任务系统。`src/control/ipc-protocol.js` 现有 framing `version=1`、Extension Worker frame `v=1` 是各自已经实现的版本；CM-Agent 仍是**设计草案**，不能将旧 IPC v1 错称为正式 CM-Agent v1。新增跨边界 DTO/schema 需先有兼容 RFC、版本/能力握手与 Owner 审批。

## M2：Core 启动与旧 Bridge 解耦（首个重大改造，先审批）

| 要素 | 具体方案 |
| --- | --- |
| 预计修改文件 | `src/core-dispatch.js`、`src/app/bootstrap.js`、`src/app/service-container.js`、`src/app/ipc-runtime.js`、`src/bridge.js` 的**入口薄层**、`src/control/data-ipc.js`、`src/app-paths.js`；新建一个最小 Core worker 组合入口/契约测试；Rust `desktop-shell/src/core_launch.rs`/`supervisor.rs` 先保持旧 CLI 调用，必要时仅加选择开关。**不搬整个 bridge.js。** |
| 新旧职责 | Core 入口取得 `.core-owner.lock`，装配现代服务并拥有 Owner/Data IPC、生命周期；Bridge 变成按需启动的兼容/社交宿主，不能再次 bootstrap Core。旧命令、数据目录和 token 协议保留明确映射。 |
| 接口/版本 | 保持 `--worker`、IPC framing v1 和既有 363 行方法行为；新内部分离端口定义显式 schema、方法白名单、错误码。未定义/未知旧方法返回稳定错误，不自动升级 console privilege。变更需兼容 RFC 与双路径期对照测试。 |
| 唯一写者/回滚 | 单个 Core worker 拥有 StateDir/Task/Memory/Workspace；灰度开关选**旧或新**入口，绝不同时启动；旧入口保留在构建中，失败先停新进程并确认锁释放，再恢复旧入口；不改用户文件格式。 |
| 业务与验收 | Chat、Model Runtime、Managed Agent、Task、Memory、Workspace、Capability、Continuity、Plugins、Mesh；无 QQ/DSH/SnowLuma 时直接 Core 启动，旧 HTTP 不监听，Owner/数据 IPC 权限不退化；旧 QQ/Bionic 显式启用时仍工作。自动化：静态/动态 import 禁止边、单写者双启动拒绝、断线/重启/消息提交/Agent none、SEA bundle 清单。真实 E2E：正式 Harbor/安装包在干净 Windows 用户配置下，无所有可选组件跑完整 Chat/Task/Memory/Workspace。 |
| 批准 | **需要 Owner 批准 M2 兼容 RFC 和实施范围**；本轮只提交此方案。 |

## M3：DSH Connector 独立

| 要素 | 具体方案 |
| --- | --- |
| 预计修改文件 | `src/agent/dsh-agent-provider.js`、`src/dsh-client.js`、`src/integrations/dsh-desktop.js`、`src/dsh-integration.js`、`src/local-services.js` 的 DSH 入口、`src/app/service-container.js` 的注入端口、`dsh/agent-presets/` 的**模板引用/元数据**及对应测试。用户 preset 文件不在修改范围。 |
| 新旧职责 | Core 仅发现/注册 DSH 能力；Connector 负责具体 DSH transport、版本发现、认证、Session purpose 和 preset 选择；安装与启动作为显式 Owner 操作，不能控制普通 Model Chat 或 Core 存活。 |
| 接口/版本 | 保留已用 DSH API 方法，不猜 CLI 参数；以真实目标版本和 schema 建 compatibility profile。先验证 `session/follow` 双订阅/晚订阅是否有重放及消费竞争，解决当前每个 Broker Follow 新开原生流、忽略 `sinceSequence` 的契约缺口；不得先宣布独立 cursor 已完成。Session 创建要求 `purpose`（coding/social）与可验证 preset 映射，未知版本标 `UNVERIFIED` 并拒绝宣称 readyForWriteTask。旧 preset 兼容需迁移设计，不能强制覆盖。 |
| 唯一写者/回滚 | Core 写 Task/Memory；DSH 只写自身授权 Session，工作区变更经 staging + Core Capability/Owner 审批。若 Connector 故障，停其会话/撤销能力，恢复旧 DSH 路由时不产生第二 Task 写者。 |
| 业务与验收 | 影响 Agent/DSH Chat、coding/social 两种 preset、MCP setup，不影响普通模型聊天。自动化版本/purpose/auth/超时/异常 EOF/取消/审批测试；真实 DSH 安装版本、登录、两用途 preset 与断线重连 E2E。 |
| 批准 | 需要 Owner 审批目的/preset 兼容规则和任何外部 DSH 配置写入。 |

## M4：QQ Connector 与 Bionic Chat 独立

| 要素 | 具体方案 |
| --- | --- |
| 预计修改文件 | `src/bridge.js` 的 QQ 回调/社交循环按函数切分；`src/channel/qq/{runtime,transport,tool-policy}.js`、`src/channel/service.js`、`src/integrations/{catalog,service}.js`、`src/memory/adapters/qq.js`、相关 `src/mcp-snowluma-safe.js` 与测试。目录移动是最后步骤，不以搬迁代替边界。 |
| 新旧职责 | QQ Connector 独占 OneBot/SnowLuma 连接、白名单、消息去重与回执；Bionic 是角色/唤醒/社交策略，消费 Channel 事件，不直接持有 QQ transport 或 Owner token；Core 持有能力授权与记忆候选确认。 |
| 接口/版本 | OneBot 实际 gateway/SDK profile 单独锁定；Channel DTO 含外部 message ID、序号/幂等键、来源权限和 ACK/错误；Bionic policy 版本化但不冒充通用 Agent 接口。旧 QQ MCP 方法保留兼容映射，先逐方法权限核验。 |
| 唯一写者/回滚 | **一个 QQ 消费者**：停旧 Bridge 消费，确认连接/lease 释放，才启新 Connector；失败则反向停新启旧。`social-v2.json` 等旧状态在切换期单写；Core Task/Memory 始终单写，QQ 只能提交候选。 |
| 业务与验收 | 私聊/群聊、卡片/贴纸、社交记忆、Bionic、SnowLuma/MCP；自动化乱序/重复/断线/取消/权限/双消费者拒绝/坏配置隔离；真实 OneBot 单账号无重复回复、坏 Bionic 配置不影响 Core、SnowLuma 断开不影响 Workspace。 |
| 批准 | 需要 Owner 批准 QQ 消费者切换窗口、真实账号 E2E 与旧社交写者移交。 |

## M5：旧数据迁移、兼容与回滚

| 要素 | 具体方案 |
| --- | --- |
| 预计修改文件 | 新迁移器/只读 dry-run 与 journal 模块；`src/app-paths.js` 的兼容路径解析；`src/storage/json-file.js` 现有 primitive 的复用；`src/task/store.js`、`src/memory/store.js`、`src/workspace/registry.js`、`src/continuity/runtime.js` **仅在已证明 schema 需要时做最小适配**；安装器仅在经过安全验证后提供显式迁移入口。 |
| 新旧职责 | 迁移器只做离线快照、校验、copy/transform、journal、对账和恢复；运行时永远只有一个 Core 数据 owner。旧路径保持可读兼容，未迁移用户不被强制搬迁。 |
| 接口/版本 | 逐文件 schemaVersion、来源版本、目标版本、ID/ref 映射和 checksum；不识别/损坏即 `needs_review`，不静默重置。迁移状态机至少 `planned → backed_up → copied → verified → committed`，失败可精确回滚；外部副作用单独列账。 |
| 唯一写者/回滚 | 必须确认旧/新 Core 和 QQ 写者全停，获取独占锁/epoch 后才操作；备份不可变，提交前后对账 Task/Memory/Chat/Session ID、rev、Workspace 内容和 DSH preset 哈希。回滚先停新写者再恢复备份；未知外部副作用人工核验。 |
| 业务与验收 | 影响历史 Chat/Task/Memory/QQ/角色/配置/扩展/凭据；自动化 fixture 多版本、损坏、权限拒绝、磁盘满、kill 每一步、重复执行和回滚字节对账；真实用户数据仅在单独批准后做 dry-run/备份/迁移，现阶段 **NOT_RUN_ENVIRONMENT**。 |
| 批准 | 真实 StateDir、用户 DSH preset 和安装目录写入均需 Owner **另行明确批准**；本轮绝不执行。 |

## M6：正式安装版回归与旧入口弃用

| 要素 | 具体方案 |
| --- | --- |
| 预计修改文件 | `scripts/build-core.mjs`、`scripts/build-release.mjs`、`desktop-shell/src/{core_launch,supervisor,installer}.rs`、发行清单/测试与用户文档；旧 Bridge/CLI 删除动作须另开批准项。 |
| 新旧职责 | 安装版默认新 Core worker；旧 Bridge 仅可选兼容宿主。SEA/资源/安装器记录 sourceCommit、协议 profile 与兼容开关，升级/卸载默认保留用户数据。 |
| 接口/版本 | 公开版本矩阵必须区分 installed/compatible/authenticated/sandbox/readyForChat/Read/Write/Resume；未知标 `UNVERIFIED`。保留现有 IPC/CLI 别名一个有文档的兼容期，测过才弃用。 |
| 唯一写者/回滚 | 安装更新时旧/新进程串行交接，确认锁和文件哈希；保留上一正式安装包与数据备份的回滚路径；不得在 rollback 时起双消费者/写者。 |
| 业务与验收 | 全量 `npm test`、适用 Node/Rust/Harbor 构建、签名/安装/升级/卸载、真实 Harbor 消息结束后 10 秒、VirtualList、无 QQ/DSH 纯 Core、真实 QQ/DSH/Agent、离线/断线/恢复、旧入口兼容、安装包 sourceCommit。四遍全仓审计、269 功能、24 E2E 是独立发布门槛。 |
| 批准 | 旧入口弃用、合并 main、push、发布 Stable 分别需要 Owner 明确批准；M6 验收本身也不能自动解除 `RELEASE_BLOCKED`。 |

## 与六阶段修复的兼容红线及本轮停点

- 不回退 AUD-001/002/003、异常 EOF、Agent none、DSML、Blocked Task 写者占用与 Harbor VirtualList/消息提交逻辑。每一阶段都应重跑双/三订阅、晚订阅/gap、三轮 Agent、Tool Calling 成功/失败、Chat 正式提交/10 秒显示、Task/Memory/Workspace 单写者以及 Owner 授权负面测试。
- 不把 Codex、DSH、ACP、MCP、OneBot 的原生协议强制合一。`AGENT_COMPATIBILITY_MATRIX.md` 中未认证的环境能力保持 `UNVERIFIED`；兼容 Profile 随真实版本和已验证 Schema 才能升级。
- 本轮 M0/M1 交付后停止。M2 首先提交可审查的 Core worker/兼容门面 RFC、IPC 白名单与测试切换表，获得 Owner 审批后才实施重大架构变更。没有执行 M2～M6、旧数据迁移或正式运行时替换。
