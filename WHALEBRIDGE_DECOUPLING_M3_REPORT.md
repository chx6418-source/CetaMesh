# WhaleBridge M3：DSH Connector 独立化

状态：**M3_PARTIAL / M2_PARTIAL / RELEASE_BLOCKED**。本报告以本地 `codex/whalebridge-decoupling-m3` 分支为准；没有执行 M4～M6、真实数据迁移、用户 DSH preset 写入、推送、合并或 Stable 发布。

## 基线、边界与调用链

- 起点 HEAD：`c0a627408d0130ab604158c28958abc621fa50c3`，Build 1073，干净工作树。继承 M0/M1、六阶段、AUD-001/002/003 和 M2 Core 启动成果。Build 1074 是本轮第一份本地候选；发行脚本禁止覆盖，Schema 精修后保留该候选并递增至**最终 Build 1075**。
- 正式路径：Rust Shell → `--worker` → `src/app/core-worker.js` → `bootstrapCetaMesh()` → 唯一 `.core-owner.lock` → `createCetaMeshServices()`。Worker 只创建可选 `NodeApiClient`，经既有 AgentService/Broker 注入 DSH Provider；它不调用 `runBridge()`，不启动 DSH、SnowLuma、QQ，不建立第二个 IPC 或 Task/Memory 写者。
- DSH Session：Task/Chat/Continuity → 既有 Agent Broker → staged DSH Provider → DSH Provider → NodeApiClient → 原生 DSH API。Task 写入仍先到 staging，经过 Capability Broker 的 Owner 审批与导入；DSH Connector 不直接写权威 Workspace。
- Follow：每个 DSH Session 一个原生上游读取者 → Provider 内有界缓存 → Task、Chat、Continuity 独立 `sinceSequence`。DSH 0.1.5-rc.1 的 `SessionFollowRequest` **没有** `sinceSequence`；重放是 Core 缓存加原生 opening snapshot，不称为原生重放。缺失序号、跳号、游标超出缓存和无法填补的断线窗口报 `AGENT_EVENT_GAP`；回合未终止的 EOF 报 `PROVIDER_UNAVAILABLE`。只有已经收到明确 `turn/end` 的流结束才可结束当前读取。
- 旧路径：显式 `node src/bridge.js` 仍是 `legacy-exclusive` 宿主，取得同一 `.core-owner.lock` 后才构造旧 QQ/DSH/Social 与现代 Core；与正式 Worker 不可同 StateDir 双活。旧 DSH 入口保留，完整 Legacy 宿主去除与 QQ/Bionic 单消费者转交属于 M4。没有把它误称独立 Connector。

## 版本、能力与 Session purpose

| 项目 | 证据及结论 |
| --- | --- |
| DSH CLI installed | 本机 `dsh --version` 为 `0.1.5-rc.1`；安装包 `@deepseek-ai/dsh` 版本相同。 |
| DSH Process/API/Auth | 本机 `http://127.0.0.1:3080` 的 `settings/describe`、`session/list`、`agentPresets/list` 只读调用成功，说明本轮探测时 API 可达且鉴权通过；`session/list` 返回 150 项，不读取其内容。服务端响应不携带可核对的版本，运行服务版本仍 **UNVERIFIED**。 |
| Desktop 与进程 | `createDshDesktopIntegration().status()` 返回 `installed:false`、`running:false`、CLI `available:true`；此探测不能把桌面客户端与 API 监听者视为同一进程。真实服务进程归属 **UNVERIFIED**，Core 不会停止它。 |
| Schema | 已安装包的 `SessionCreateRequest.agentPreset?`、`SessionFollowRequest`（无 `sinceSequence`）、`SessionFollowFrame` snapshot/event 与 `SessionWireEvent.seq` 已核对；`@deepseek-ai/dsh-persona` 的 `config.prefix` 是 required。此结论限已安装的 0.1.5-rc.1 包，不泛化为未来版本。 |
| coding | Core Agent 路径要求显式 `purpose: coding` 和 `dsh.codingPreset`。本地只读校验 persona `prefix`，再通过 `agentPresets/list` 确认 DSH 已加载，随后仍由原生 `session/create` 最终验证。缺配置或不兼容则 `DSH_PRESET_INCOMPATIBLE`，不静默选 `standard`、`liangshen` 或 QQ Social preset。 |
| social | 显式 `purpose: social` 对应 `dsh.socialPreset`，同样校验；旧 QQ/Social Bridge 路由仍在独占兼容宿主，不能据此声称 M4 完成。 |
| readyForWriteTask | 本机未显式配置合格的编码 preset，故 **false / NOT_RUN_ENVIRONMENT**。已安装、运行、API 可达、已鉴权不能自动推导 Agent Task Ready。真实 DSH 模型回合、三轮任务及真实 Workspace 导入未运行。 |

### 用户 preset 迁移 Dry Run（只读）

| 预设 | 当前检查 | 原文件 SHA256 | 拟议动作（未执行） |
| --- | --- | --- | --- |
| `whale-chat` | `config.text`，缺 required `prefix` | `988FE3A527AE37C888297E232FEEDABE786108B6718A46C743BAEA8C46DA41F9` | 保留原文件；如 Owner 后续同意，先生成不可覆盖备份，再在人审下迁移字段并核验 QQ 工具限制。 |
| `whale-chat-v2` | 同上 | `6BC8961B4CC3666AE792885D9B472F913B8BDEEE18277570B8B153CCE4C7B2DA` | 同上；须同时验证 Bionic/QQ 行为，属于 M4 前置。 |
| `liangshen` | persona 有 `prefix`，权限用途尚未审计 | `84B006FF303F299BE76D122DEFC1D257FFF85E0887793B1946E122906D755D1C` | 不自动作为 coding 默认，不改动。 |

Dry Run 方案：以每个原文件 SHA256 作为前置条件；目标备份使用同目录唯一后缀、独占创建并再次核对字节；产生候选 diff 供 Owner 审批；正式写入、DSH 重载和回滚另行授权。本轮只执行检测与差异分析，**未创建备份、未写入用户 DSH_HOME**。

## 修复点与验证边界

| 状态 | 内容 |
| --- | --- |
| `FIXED_CODE` | Core Worker 注入可选 DSH 客户端；Provider 按 purpose 选 preset；staged Provider 显式 coding；Follow 单读取者、独立 cursor、缓存重放与 gap；取消响应区分 requested/stopped；UI 不把 preset 未就绪标为 Task eligible。 |
| `VERIFIED_FIXTURE` | 注册的 M3 suite 覆盖双/三订阅者、晚订阅、重放、gap、异常 EOF、三轮不同回合、coding/social 兼容、用户 preset 原字节不变、Connector 崩溃下真实 Core 服务构造；现有 Task staging、审批、取消、正式 Node Worker 隔离 IPC 与 Core/Legacy 互斥 suite 已回归。 |
| `VERIFIED_REAL_E2E` | 本机 DSH API 的只读鉴权及 `settings/describe`、`session/list`、`agentPresets/list` 方法探测；未发送真实模型回合。 |
| `PARTIAL` | 用户真实 DSH 服务版本无握手字段；完整 session/create/send/follow/cancel/close 的真实 E2E 缺合格且获授权的 coding preset；仅 persona `prefix` 的本地检查不足以证明全部插件 Schema，最终以 DSH 原生加载及 session/create 为准。 |
| `DEFERRED_TO_M4` | 旧 Bridge 仍是独占宿主并可启动 QQ/SnowLuma；QQ/Bionic 单消费者和 Social 预设迁移、旧 IPC 兼容门面仍待 M4。 |
| `NOT_RUN_ENVIRONMENT` | 真实 DSH coding/social 回合、真实 QQ/Bionic、正式签名及人工 Harbor E2E。 |

验收映射：`test-core-entry` 与 `test-whalebridge-core-isolation` 覆盖无 DSH 的生产 Worker、Core/Legacy 双向互斥和 Task/Memory 可用；`test-agent-provider-expansion` 覆盖假服务鉴权失败、Task staging/审批/取消、Follow 后 Workspace 单次导入；`test-dsh-connector-m3` 覆盖 purpose/preset、修改字节不变、双/三订阅、晚订阅、gap、异常 EOF、三轮不同回答及 Connector 故障隔离；`test-desktop-chat-product` 覆盖 Agent none 策略；`test-task-runtime` 覆盖 DSH → Managed Agent 的 Task 身份切换和重启后历史保留（仅领域 fixture）。真实 DSH → Managed 执行交接、真实 DSH 重连/写任务/三轮模型回复和真实 QQ/DSH 同机生命周期仍未验收，不能由 fixture 推导通过。

## 修改文件、测试、构建与提交

修改 `src/agent/dsh-core-connector.js`、`dsh-follow-hub.js`、`dsh-preset-policy.js`、`dsh-agent-provider.js`、`staged-dsh-agent-provider.js`、`service.js`、`broker.js`、`src/app/core-worker.js`、`service-container.js`、`src/config/schema.js`、`src/desktop/ui-service.js`、`scripts/test-dsh-connector-m3.mjs`、已有 Agent/Task fixture、测试登记、架构说明及 `release/version.json`。无用户 StateDir、DSH_HOME、QQ 数据库或 DSH preset 写入。

代码与测试提交：`a59dd26c1e52468aaee453cfb25671e98d9a71bd`（Connector/测试）、`1479909`（显式配置 Schema）、`cd13ece40cfb881637765240f72927591f2795c2`（最终 Build Number）、`08201f5`（DSH → Managed Task 身份 fixture）。**最终代码/测试 HEAD 为 `08201f5`；发行包的可执行代码来源 HEAD 为 `cd13ece`。**本报告的文档提交会使分支 HEAD 再前移，最终分支 HEAD 在交付消息中核对。

| 验证 | 结果 |
| --- | --- |
| `npm test` | 最终 Build 1075 全量 110 suite：**103 PASS / 0 FAIL / 7 NOT_RUN_ENVIRONMENT**。7 项为 Legacy Console、真实网关/网络/Codex 与聚合器未启用的 Cargo check/test；Cargo 已单独执行。Build 1074 首轮在 RC 未构建前有一项“找不到安装包”，构建后归零；最终 Build 1075 全量无失败。 |
| `npm run build:core`、`npm run build:ui` | PASS；Core SEA 重新打包于 Build 1075，生产 Harbor CSS/JS 构建通过。 |
| `npm run desktop:check`、`npm run desktop:test`、`npm run desktop:build` | PASS；Cargo 198 passed / 0 failed。 |
| `npm run build:release -- --use-current-build-number` | PASS；最终 Build 1075 清洁来源 `cd13ece`，`dirtySourceTree=false`，发行禁止项/构建机路径/凭据审计通过。 |
| `npm test -- --category release` | Build 1075：8 PASS / 0 FAIL，含隔离安装器、真实 SEA 启动与 IPC。 |
| 真机 DSH Agent 编码/社交回合、真实 QQ、人工 Harbor | `NOT_RUN_ENVIRONMENT`：缺显式配置且经验证的编码/社交 preset，模型推理 Key/额度未核验；QQ/SnowLuma、签名及人工安装环境未在本轮配置。 |

最终本地 RC 路径：`artifacts/rc/1.0.0-rc.2/build-1075/CetaMesh-Setup-1.0.0-rc.2-build1075-x64.exe`，42,999,808 字节，SHA256 `FF18AAE12ED4778F4B593D67BF357B3B41789B9C8667323BEED2BFCB0CABA8FB`。Core SEA SHA256 `3934A1A6D94FEF2FB9C74CD9588134F762B0E16910990380DEB85EF7B58EB51A`。两者均未签名、未发布。真实用户三个 DSH preset 的 SHA256 在所有探测与测试后保持与上表一致。

## M4 前置与剩余发布阻塞

1. Owner 明确 coding/social preset 选择，审核权限与实际 DSH 服务版本；如要迁移用户 preset，先审批逐文件备份、候选 diff、回滚和真实 QQ 行为验证。本轮没有改写任何用户配置。
2. M4 在同一 `.core-owner.lock` 和 QQ 消费者独占条件下转移旧 Social/QQ 运行权；先核对方法级兼容门面、消息去重/ACK、旧数据唯一写者，再验证真实 OneBot 收发。不能让 Legacy Bridge 与新 Connector 双宿主。
3. 保留 M2_PARTIAL：Legacy 独占入口仍会构造现代 Core，且可启动 SnowLuma。完整解除该宿主依赖与正式安装版真实 QQ/DSH/Harbor 验收之前，持续 `RELEASE_BLOCKED`。
