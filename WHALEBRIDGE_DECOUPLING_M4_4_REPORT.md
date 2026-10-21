# WhaleBridge M4.4 — QQ Connector 运行职责独立化

## 结论与验收边界

本轮从本地 `codex/whalebridge-decoupling-m4` 的 `30ab2d32c37c2381d75ab8d4435949deaee7fd50`、Build 1080 开始，起始工作树干净。正式 Core 启动链沿用 M2；未回退 AUD-001/002/003、稳定自动回复 requestId、原有发送账本或账号锁恢复规则。

**产品源码提交 / Final product HEAD：`bb6343483d04c65cd88104c9e9c76d23df656afb`。版本 `1.0.0-rc.2`，Build `1081`。** 本报告为随后单独提交的证据文档；交付 HEAD 以该分支最新文档提交和最终答复为准，安装包 sourceCommit 始终指向上述产品源码提交。

**阶段判定：M4_CODE_COMPLETE / M4_E2E_PENDING / RELEASE_BLOCKED。** 四项正式运行架构阻塞已关闭，最终自动化和发行集成均为 0 FAIL。真实 QQ/OneBot 为 `NOT_RUN_ENVIRONMENT`，不允许据自动化宣称真实 E2E 或解除 `RELEASE_BLOCKED`。M2/M3 的其他阶段性限制未在本轮关闭。

## 1. 四项运行职责移交

| 原阻塞 | 修改后的实际职责 | 证据分类 |
| --- | --- | --- |
| Bridge 是正式 QQ 消费宿主 | 正式 `--worker` → bootstrap → service-container → Channel Service → `createQqConnectorHost()` → 同一 SEA 的 `--qq-connector` → 既有 QQ Runtime → OneBot。Bridge 不参与此传输启动链。 | `FIXED_CODE`、`VERIFIED_FIXTURE`、`VERIFIED_RELEASE_INTEGRATION` |
| Core 缺权威入站接收/确认 | Connector 私有继承管道 → Core 验证活动子进程绑定/账号/来源/大小 → 稳定身份及持久投递记录 → 授权消费者独立游标 → 完成后确认；不明副作用阻止自动重放。 | `FIXED_CODE`、`VERIFIED_FIXTURE`、`VERIFIED_RELEASE_INTEGRATION` |
| Social 生命周期仍绑定正式 Bridge 宿主 | `channel.bionic.start` → 独立 `--bionic-runtime` → `createBionicPolicyHost({channel})` 复用 Social 策略 → 受控 Social Loop。该分支在创建 Core/IPC、检测/启动本地服务之前返回，不持有 QQ 客户端。 | `FIXED_CODE`、`VERIFIED_FIXTURE`、`VERIFIED_RELEASE_INTEGRATION` |
| 正式 SEA 无独立 Connector 入口 | 同一 SEA 分派 `--qq-connector` / `--bionic-runtime`；Core Owner 方法执行真实 start/stop/health/reconnect；无需系统 Node、源码工作目录或 Owner Token 下发。 | `FIXED_CODE`、`VERIFIED_RELEASE_INTEGRATION` |

Legacy-exclusive 仍保留完整兼容宿主，它与正式 Core 受 `.core-owner.lock` 互斥；不是可与正式 Connector 双活的第二宿主。它仍拥有仅 Legacy-exclusive 模式下的 QQ 回调、Social 状态与循环，属于明确保留的兼容模式，不是正式模式残留的生命周期所有者。

## 2. 新的实际调用链

```text
Desktop Shell -> --worker -> bootstrapCetaMesh -> createCetaMeshServices
  Core Channel Service / Capability Broker / Approval / existing Core services
    -> createQqConnectorHost -> same SEA --qq-connector
       -> createQqRuntime -> account/gateway lease -> OneBot HTTP / WebSocket

QQ inbound -> Connector authenticated account -> inherited ingress request
  -> Core source/account/allowlist validation -> Channel delivery records
  -> trusted per-consumer authorization -> independent cursor / claim
  -> Bionic child receive -> existing Social policy -> durable Social write
  -> acknowledgement; failure/crash -> outcome-unknown -> Owner reconciliation

Bionic/MCP/Plugin/Legacy compatibility output -> Channel facade
  -> Core Capability Broker -> Owner Approval -> dispatch revalidation
  -> QQ Connector private command -> Runtime final checks + original send ledger
  -> gateway -> reliable receipt or outcome-unknown
```

Core 继续唯一创建 Task、Memory、Workspace、Capability、Approval；Connector/Bionic 不创建 Core 或第二个 IPC Server。Child EOF/崩溃仅清理应用自己启动的子进程及自己持有的租约；不启动或终止用户的 QQ 网关、SnowLuma、DSH。Connector 不反向启动任何本地外部服务。

## 3. Core Channel 权威职责和协议

- 身份分离：`messageId` 是原生消息标识；`accountId` 是已验证账号；`externalUserId` 是外部发言人；`sessionId=qq:<account>:<kind>:<target>`；Core 产生独立 `eventId` 与连续 `sequence`。外部 actor 固定 `external`，群文本中的命令不会成为 Owner 请求。
- 去重身份为账号、目标和原生消息 ID；同身份不同内容返回 `CHANNEL_MESSAGE_CONFLICT`，不同消息同文本不按内容去重。Core 接收确认表示已持久接受，消费者确认是另一个阶段。
- 每个可信消费者独立 authorize、delivery state 和 cursor；一个消费者失败不会竞争掉或吞掉其他消费者的消息。实际注册消费者为 Bionic；Agent/Task 不被 QQ 群消息自动派发，其他消费者通过同一受控注册契约接入。
- 复用 Storage Primitive 的原子写入、现有 Core UI 事件通知与 Capability/Approval。`state/channel/delivery.json` 是 Channel Domain 的投递/确认记录，不是第二套 Event Bus 或通用 Store；既有 Agent Event Journal 与广播器不变。
- 持久 claim 先于消费者副作用，成功完成后 ack。重启将 `in-flight` 转为 `outcome-unknown`；不能证明未发生副作用时不自动重放。Owner 可提供有界核验证据，选择 `verified-completed` 或 `verified-no-effect`，后者才允许继续投递。
- 数据损坏不覆盖原文件，QQ Channel 进入明确不可用状态，其他 Core 服务仍能装配。投递最多 5,000 条、24 MiB 写入上限，最多 32 个消费者，满时拒绝并要求 Owner 归档，不静默丢弃。
- 子进程协议当前为内部 frame version 1，继承 stdio、有限方法列表、1 MiB QQ / 16 MiB Bionic frame、最多 256 个待处理请求与有界超时。没有公开 TCP/HTTP Connector Listener，不把本实现宣布为 CM-Agent 正式标准。

### Owner 可调用方法

| 方法 | 请求 / 结果 | 权限及错误语义 |
| --- | --- | --- |
| `channel.qq.start` | 无参数；真实连接/account/ready/状态 | Owner IPC；未连接或账号未核实不 Ready；账号占用拒绝 |
| `channel.qq.stop` | 无参数；stopped，必要时 previousEffectUnconfirmed | 先停止 Bionic，再关闭自己拥有的 QQ 子进程；保留未知副作用 |
| `channel.qq.health` | 真实 child PID、账号、连接就绪 | 不以注册描述符或 UI 开关替代连接状态 |
| `channel.qq.reconnect` | stop 后 start；新生命周期结果 | 旧进程未释放租约不能接管；不是盲目恢复发送请求 |
| `channel.qq.send` | requestId + account/action/kind/params/options；pending 或 completed | actor 来自鉴权 IPC，Core Broker/Approval；外部 actor 无权提升 |
| `channel.qq.send.status` | accountId/requestId；原发送记录/回执或 null | Owner 只读；直接读取同一账本，不依赖 Connector 存活，不产生新 writer |
| `channel.delivery.status` | 持久投递和各消费者状态 | Owner 只读核验 |
| `channel.delivery.resolve` | consumerId/eventId/decision/evidence | 仅 Owner；持久审计证据后恢复 drain |
| `channel.bionic.start/stop/health` | 实际 policy child/loop 状态 | QQ ready 后才可 start；旧数据须经迁移门禁 |

## 4. 统一外发覆盖及遗留调用点

以下为本轮对实际产品外发路径的有限追踪；没有重做全仓四遍审计。

| 业务调用点 | 权威执行链及最终检查 | 测试证据 |
| --- | --- | --- |
| Bridge `sendToQQ`/`postOneBotAction`/自动分条回复 | 正式 Bionic Channel facade；Legacy 使用 `createBrokeredQqRuntime`；二者进入 Core Broker，再进入唯一 QQ Runtime | channel-delivery、core-channel-assembly、qq-auto-request |
| 文本、普通 QQ 通信、`channel.send` | 旧 Capability adapter 绑定同一 `dispatchApproved`；保留外层授权，未嵌套第二次批准；按真实群/私聊目标重新检查工具开关 | channel-delivery、qq-send-policy、core-channel-assembly |
| MCP 文件/音频/音乐 `mcp-qq-file-send.js` | 既有数据 IPC → Bionic API 会话/工具检查 → Channel send → Broker → Runtime；不可直接给 OneBot 发写动作 | qq-runtime、qq-send-policy、qq-attachments、core-entry |
| `sendStickerV2`、自定义表情增改 | Channel requestWrite/sendOneBot；真实媒体类型、工具开关、media permission、账号及审批 | qq-send-policy、qq-attachments；真实贴纸发出未验收 |
| `group_poke/send_poke/click_inline_keyboard_button` | Channel rawWrite → Broker → Runtime；SDK request 保留完整成功 envelope，再由既有账本确认 | qq-runtime 红绿反例、qq-send-policy |
| Plugin/Extension | `channel.send` 或现有 MCP 受控入口；没有赋予直接底层写客户端 | capability/extension 既有套件及 channel-delivery |
| 开发诊断 `scripts/send-test-group.mjs` | 仍需显式真实发送 opt-in；经既有 Runtime、账号锁、账本和最终工具策略；不属于产品调用入口，不进入 Release 资源 | qq-runtime、core-dist/发行资源审计；本轮未运行真实发送 |
| `mcp-snowluma-safe.js` 的 `onebot()` | 当前可达 action 为 login/status/group/member/history 读取；写请求走数据 API，不是直接 OneBot 写入口 | 本轮调用点检查及既有 MCP 套件 |

执行前和最终 Runtime 均检查账号、实际目标、连接/租约、QQ 插件开关、媒体能力/工具开关、必要批准及附件权限。调用方传来的 options 不得覆盖实际账号/目标/动作。图片、文件、音频、视频本地路径经 realpath 和声明目录/缓存边界校验；公网 URL 复用 safe-fetch 校验。高风险外发 pending 不会触达网关。

已识别产品写路径均有统一权威执行链；没有发现仍直接绕过 Runtime 的产品写调用。这里的覆盖率按上述已识别调用族计算，不能据此声称动态第三方插件或所有真实 QQ 媒体行为已 E2E 验证。

### 保留的 bridge.js 代码与原因

- `onPrivateMessage/onGroupMessage`：只在 Legacy-exclusive 构造 native QQ Runtime 时注册；正式模式由 Connector 收取。
- `handleIncoming`、`startSocialLoop`、Social 数据读写、黑话/贴纸/卡片/记忆策略：正式 Bionic child 通过职责接口复用；没有通过搬动整个文件冒充解耦。
- `startProductSurfaces`：正式 policy 分支只暴露内存 API handler，立即返回，不构建 Core 或监听管道；已有 Core 数据 IPC 经受限路由转发到 policy child。
- Legacy-exclusive 的 Core bootstrap、兼容 IPC、本地服务启动仍保留；它与正式 Core 互斥，不承担新 Connector 生命周期。其全部弃用、目录拆分及真实数据切换不在本轮范围。

## 5. 发送账本、未知结果与修复反例

沿用 M4.1/M4.2 的 `qq-send-ledger.json`，未另建发送账本、重置旧回执或更改稳定自动 requestId。相同逻辑请求先持久 claim 再调用网关；重启后不可盲目再派发。OneBot 没有可靠查询能力时，只能保留未知结果并人工核验，不能声称 exactly-once。

| 反例 / 根因 | 最小修复 | 证据 |
| --- | --- | --- |
| 调用参数可尝试覆盖真实账号/收件人、卡片伪报文本 | Runtime 使用实际身份覆盖 options；从实际 action/segments 推导媒体和目标，拒绝冲突身份/混合媒体/CQ 伪装 | qq-runtime 中先复现再修复；账号/目标/媒体拒绝均在网关前 |
| 正在 drain 时新消息到达可能丢唤醒 | 每一步读取最新持久事件快照 | channel-delivery 并发入站反例 |
| Transport 本地预 claim 可能吞掉 Core 尚未保存的消息 | 正式 Connector 不用 Legacy transport receipt 预占入站；以 Core durable acceptance 为准 | qq-connector-process：第一次 Core append 失败后重投能再次接收 |
| Social 落盘异常被旧策略吞掉，Core 会误确认 | 正式 policy host 传播 `BIONIC_STATE_WRITE_FAILED`；消费者进入待核验 | bionic-runtime-lifecycle：以目录代替状态文件制造真实写失败，先红后绿 |
| 返回 unknown 或发送中 child 断连/命令超时被 Broker 标 completed/failed | Channel 归一化 `QQ_OUTCOME_UNKNOWN` / `CHANNEL_PROCESS_CLOSED` / `CHANNEL_COMMAND_TIMEOUT` 的未知副作用；Broker 持久 dispatch status 保持 outcome-unknown | channel-delivery：返回及抛出三类错误均验证 |
| 拍一拍/卡片成功时 SDK raw 丢弃完整回执 | 受限 rawWrite 使用 SDK request，保留 status/retcode 成功证据 | qq-runtime：原实现错误 unknown 的反例先失败，修后 ledger acknowledged |
| SDK 读取 facade 混淆 data 与 envelope、face 参数错误 | raw 返回 data，request 保留 envelope；fetch_face_entity 带 face_id/refresh；限定读方法清单 | bionic-runtime-lifecycle 与已安装 SDK 实现对照 |
| 省略 toolName 绕开文本工具热关闭 | 按实际群/私聊派生执行时工具检查；卡片点击检查自身开关 | qq-send-policy 红绿反例 |

## 6. 数据权威与 M5 边界

| 数据 | 唯一 writer / 兼容方式 |
| --- | --- |
| Task/Memory/Workspace/Capability/Approval | 既有 Core services；Connector/Bionic 不构造对应 Store |
| QQ 发送账本和租约 | 既有 Runtime 唯一写入；Core/Bionic receipt 查询只读；Legacy 与正式 Connector 受进程/账号互斥 |
| Channel 入站及消费者确认 | Core Channel Service，原子持久化；损坏/容量耗尽失败关闭 QQ，不覆盖或清空 |
| 正式 Bionic Social 状态 | `dataRoot/channel/qq/<accountId>/bionic/state/`；沿用旧业务 Schema，群 key 分离。不同账号为不同 root |
| 旧根目录 Social/roles 数据 | 保留原位置与内容；不自动拷贝、不改写、不切换 writer，返回 BIONIC_MIGRATION_APPROVAL_REQUIRED |

门禁检查 `social-v2.json`、`sessions.json`、`current-role.json`、`slang.json`、`slang-session.json`、`stickers.json`、`social-v2-cards.json` 和用户 roles/。旧格式缺少可证明的 QQ 账号归属，不能安全直接映射到新账号目录。已归属的新目录损坏返回 BIONIC_STATE_UNAVAILABLE，原文件保留。

这不是迁移已完成：已有旧数据的安装可以独立运行 Core/QQ 基础传输，但 Bionic 切换被门禁阻止。需要下一阶段只读库存、账号/群/会话映射、差异和备份设计、Dry Run、核验未完成外发、显式 Owner 批准后，才能执行真实切换。本轮没有开展 M5，也没有修改真实 QQ/DSH 配置或用户数据。

## 7. 回归与发行证据

新增六个 suite 均登记在 `scripts/run-all-tests.mjs`：channel-delivery、qq-connector-process、bionic-runtime-lifecycle、core-channel-assembly、qq-attachments、channel-sea。没有删除测试、跳过断言或改错误卫生基线。

| 验证 | 状态 / 实际范围 |
| --- | --- |
| 首轮 npm test | 111 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT；之后收口修改经定向回归，再运行最终全量 |
| 最终 npm test | **112 PASS / 0 FAIL / 7 NOT_RUN_ENVIRONMENT**（119 suites，最终产品源码 bb63434） |
| build:core / build:ui | PASS / PASS；SEA 审计无构建机路径、禁止 UI 页面及凭据资源；Harbor TS/Vite 通过 |
| desktop:check / desktop:test / desktop:build | PASS / 198 PASS, 0 FAIL / PASS；保留现有编译告警 |
| build:release -- --use-current-build-number | PASS；干净源码 bb63434，dirtySourceTree=false |
| 最终 npm test -- --category release | **9 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**；包括 RC verification |
| 打包 payload 的 test-channel-sea | 1 PASS / 0 FAIL；明确 WHALEBRIDGE_DIST_DIR 指向 Build 1081 payload，PATH 移除系统 Node |
| Core 真实生产装配 | VERIFIED_FIXTURE、VERIFIED_RELEASE_INTEGRATION：原生 Owner IPC start/stop/health/reconnect、真实子进程、审批前零 sends、批准后一次 send、Bionic 分组/停止、Connector kill 隔离、Core kill/restart、Task/Memory/事件/回执保留 |
| 双/三订阅者、晚订阅、失败/重启及核验恢复 | VERIFIED_FIXTURE：独立 cursor/ack，外部身份拒绝，失败不吞其他消费者 |
| Core/Legacy 互斥 | VERIFIED_FIXTURE：core-entry 已有跨进程双向排斥、Core Owner IPC 不重复、Legacy 未获取回调锁前退出；QQ child 竞争同账号拒绝；账号租约失效与原有恢复测试保留 |
| 正式安装 RC | VERIFIED_RELEASE_INTEGRATION：发行壳/SEA，沙箱安装、无 Node、单实例、崩溃拉起、安装/数据完整性；不等于真实 QQ 登录/收发 |
| 真实 QQ/OneBot / 真实 DSH 社交推理 | NOT_RUN_ENVIRONMENT；没有受控真实账号/网关/Provider 验收，本轮未向真实群发送测试消息 |

曾将全套 release 的 WHALEBRIDGE_DIST_DIR 都设为安装 payload，导致 core-dist 查找不发行的 `build/core.bundle.cjs` 报 ENOENT；该调用为 8 PASS / 1 FAIL。随后恢复各套件原本输入目录：完整发行套件按默认 dist/core 检查构建产物，RC 自行使用规范安装包；仅 channel-sea 单独指定打包 payload。没有为通过测试把中间 bundle 放进发行包或放宽断言。最终结果以上表重跑为准。

最终聚合的 7 个未运行项为 Legacy Bridge 环境套件、真实网关的 MCP/OneBot 两项、公网搜索、真实 Codex，以及默认未 opt-in 的 Cargo check/test 两项。后两项已由本轮单独执行 desktop:check / desktop:test 实际通过；不将其误述为 Rust 不可用。新 Connector 的本地生产装配与 SEA 测试没有跳过。VERIFIED_REAL_E2E 数量为 0。

### 安装包

- 路径：`artifacts/rc/1.0.0-rc.2/build-1081/CetaMesh-Setup-1.0.0-rc.2-build1081-x64.exe`
- 大小：43,270,144 bytes（41.27 MiB）。
- SHA-256：`cdb5375a6955e93e88e5c1ce897191f0e21cd2783de104c21f33b3fd2233db56`
- Core payload SHA-256：`333266f7f27c7544fb4d99aac81e1f59f97f76cf518881f6672b3116f95c0ba0`
- 签名：`NotSigned`；未签名 RC，不是 Stable 或生产签名验收。
- build-info/release-manifest 的 sourceCommit：`bb6343483d04c65cd88104c9e9c76d23df656afb`；dirty / dirtySourceTree 均 false。打包后只提交报告及计划完成证据，不改变该 payload 的产品源码身份。

## 8. 修改位置与未解决事项

源码及测试共 39 个文件纳入产品提交；可用 `git show --stat bb63434` 精确复核。核心位置：

- 运行装配：src/core-dispatch.js、src/app/service-container.js、bootstrap.js、core-worker.js、ipc-runtime.js。
- Channel：src/channel/service.js、delivery-journal.js、registry.js。
- QQ 子进程与执行：connector-host.js、connector-worker.js、process-link.js、broker-facade.js、request.js、attachments.js、runtime.js、ownership.js、send-policy.js。
- Bionic：src/bionic/service.js、worker.js、channel-facade.js、social-loop.js；src/bridge.js 保留策略实现与 Legacy-exclusive 兼容。
- Capability：adapters.js、broker.js；没有更换 Broker、审批机制、Task/Memory/Workspace。
- 测试：上述六个新增 suite，既有 qq-runtime / qq-send-policy / whalebridge-core-isolation，及聚合器登记。
- 发布及记录：release/version.json、PROJECT_STATE.md、docs/desktop/ARCHITECTURE.md、实施计划、开发诊断脚本权限回调。

仍然需要 Owner 验收的事项：真实 QQ 多媒体发送/回执/重连，真实 DSH 社交行为、手工 Harbor 操作体验、旧数据账号归属及迁移审批。OneBot 未知结果没有可靠自动查询/自动重发保证；投递记录和原发送账本满时需要受控归档。此处不是把环境缺失或人工核验问题伪装为成功。

## 9. 阶段决定

四项正式模式缺口均已通过代码及发行集成验收，标记 **M4_CODE_COMPLETE**；真实 QQ/OneBot 尚未验收，保留 **M4_E2E_PENDING / RELEASE_BLOCKED**。M2_PARTIAL、M3_PARTIAL 不因本轮而自动关闭。

可以在 Owner 下一阶段指令后进入 **M5 只读库存与 Dry Run 设计**。真实旧 Social 数据的账号归属和权威 writer 切换仍是明确审批门禁；不能自动迁移、删除或覆盖。Legacy-exclusive 兼容宿主仍保留且互斥，正式模式不依赖它。不存在借状态名称关闭仍在运行的正式 Legacy 主循环的做法。

打包时工作树干净；最终交付只追加本报告、计划完成标记和当前状态说明。文档提交后再次核对 git status，无未提交修改。

本轮没有 push、合并 main、发布 Stable、创建正式 Release Tag、覆盖 DSH preset 或执行真实数据迁移。完成本地提交后停止，等待 Owner 验收。
