# WhaleBridge M4：QQ Connector / Bionic Chat 独立化审计与局部修复

状态：**M4_PARTIAL / M3_PARTIAL / M2_PARTIAL / RELEASE_BLOCKED**。本轮从 M3 的 `e9e5c2f62cf178634e56aa6c5d5052f9de66b13e` 出发，在本地 `codex/whalebridge-decoupling-m4` 分支实施非破坏性运行边界修复。没有执行 M5 数据迁移、真实 QQ 外发、push、main 合并或 Stable 发布。

## 调用链与验收结论

| 路径 | 当前事实 |
| --- | --- |
| 正式 Core | Desktop Shell → `--worker` → `src/app/core-worker.js` → `bootstrapCetaMesh()` → `.core-owner.lock` → Native IPC/Chat/Task/Memory/Workspace。没有从正式 Worker 启动 QQ/SnowLuma、Legacy Bridge 或 Bionic。沿用 M2/M3 成果。 |
| Legacy QQ | 显式 `src/bridge.js` → 同一 `.core-owner.lock` 的 `legacy-exclusive` 宿主 → `createQqRuntime()` → 网关锁 → SnowLuma WebSocket → `get_login_info` 账号锁 → 持久消息回执 → 旧 `handleIncoming()`。旧 Bridge 仍构造现代 Core 并持有 Social 状态，故它尚不是独立 Connector。 |
| Bionic | Legacy `handleIncoming()` 读取独立 Bionic 总开关；关闭时不进入社交策略或写其消息状态，QQ Runtime 仍可保持连接。角色、唤醒、黑话、贴纸、卡片、社交记忆、群聊规则仍由旧 Bridge 实现，**尚未**变为只依赖 Channel Contract 的独立插件。 |
| 发送与工具 | Bridge `createQqTransport()` 在调用 OneBot 发送前检查 QQ 开关和连接就绪；已排队的普通文本发送再次检查。SnowLuma MCP、QQ file-send MCP 与 `tools.invoke` 在调用前拒绝已关闭的 QQ 集成；`tools.invoke` 在审批后执行点复核。旧 Bridge 的其他 `bot.raw`/HTTP OneBot 外发仍需逐方法收敛到单发送者。 |

### QQ 单消费者与回执

- `src/channel/qq/ownership.js` 对规范化使用的网关 URL 和经 OneBot `get_login_info` 确认的账号分别独占建锁；同网关第二连接在打开 Socket 前拒绝，另一网关同账号在接收处理前拒绝。存储文件只有 PID/随机 nonce 和哈希标识，不写 QQ 凭据或账号明文。正常 stop/进程 exit 仅释放本进程确实拥有的锁。进程意外退出遗留的锁**不会被静默接管**，需要明确恢复操作；这保障未证实旧消费者停机时不双活，但自动故障恢复仍是缺口。
- `src/channel/qq/receipts.js` 使用 `src/storage/json-file.js` 原子读写 Legacy StateDir 中新增的 `qq-message-receipts.json`。以 self ID、私聊/群聊、会话 ID、原生 message ID 组成回执键；处理器调用前落盘，重投、重连、重启时不重复调用。缺消息 ID 和损坏/不可读回执时拒绝处理并保留原文件。该选择是**至多一次**处理：回执写入后若处理器失败，可能漏回复；不能宣称严格一次或已完成 ACK/重放契约。
- 现有 `.core-owner.lock` 继续阻止同 StateDir 的正式 Core 与 Legacy 双宿主；QQ 账号锁额外覆盖不同 StateDir/网关的同一账号。该锁只覆盖本轮接入 `createQqRuntime()` 的 WebSocket 消费者，**不覆盖**旧 MCP 直接 HTTP 外发或未接入此锁的其他 QQ 程序。

## 状态分级与 18 项验收映射

| 状态 | 证据、限制 |
| --- | --- |
| `FIXED_CODE` | QQ Runtime 增加 `start/connect/stop/reconnect/health`、网关/账号互斥、持久回执和损坏保护；Legacy 入口启用这些边界；QQ、Bionic 开关分别控制运行/策略；Bridge transport、SnowLuma MCP、QQ file-send MCP、Plugins `tools.invoke` 接入 QQ 禁用检查。 |
| `VERIFIED_FIXTURE` | `test-qq-runtime` 覆盖同网关与跨网关同账号竞争、双消息不重复、重连/重启不重处理、缺 ID 拒绝、损坏回执原字节保留、stop，以及真实 MCP stdio 工具禁用结果；`test-bionic-chat-plugin` 覆盖 Bionic/QQ 独立开关、53 项工具目录（46 restored/5 partial/2 unsupported）、单工具开关、Capability 审批/拒绝和模拟工具返回。`test-whalebridge-core-isolation` 沿用纯 Core/互斥/坏配置 Fixture；Core 数据 IPC Fixture 拒绝 QQ 外部令牌进入 Owner 面。 |
| `VERIFIED_REAL_E2E` | 本阶段没有真实 QQ/OneBot 收发 E2E。Windows RC 测试是真实 SEA Core/IPC 与安装器隔离验证，不等于真实 QQ Connector E2E。 |
| `PARTIAL` | QQ Runtime 运行职责和部分外发权限已收敛，但旧 Bridge 仍拥有 QQ 回调、DSH/Social 主循环、核心宿主和社交写者；Bionic 未通过独立 Channel Contract 运行。账号锁是进程文件锁 Fixture，没有跨进程双网关、崩溃恢复和真实账号切换验收。QQ 未连接时 Core 可用，但正式 SEA 尚无独立 QQ Connector 启动入口。 |
| `DEFERRED_TO_M5` | 旧 Social/QQ 状态的离线备份、读写者切换、用户凭据/游标/群记忆迁移和回滚；不得让新旧 Social 双写。正式切换前需完成单发送执行者、旧回调停机确认和所有 OneBot/MCP 直连动作归口。 |
| `NOT_RUN_ENVIRONMENT` | 真实隔离 QQ 账号及 OneBot/SnowLuma 网关收发、跨进程真实账号双活、真实群白名单与卡片/贴纸/音乐副作用、真实 Bionic 崩溃隔离、真实 MCP OneBot 调用、人工 Harbor/正式安装版 QQ 操作。没有向真实群发送测试消息。 |

| 需求序号 | 结论 | 证据或缺口 |
| --- | --- | --- |
| 1 无 QQ/SnowLuma 纯 Core | `VERIFIED_FIXTURE` | `test-whalebridge-core-isolation` 及正式 SEA Core/IPC RC。 |
| 2 Connector 启停重连 | `VERIFIED_FIXTURE` | `test-qq-runtime` 的 fake OneBot；真实网关未跑。 |
| 3 坏 QQ 配置不崩 Core | `VERIFIED_FIXTURE` | 纯 Worker 不初始化 QQ，既有 Core 隔离 suite。 |
| 4 Legacy/新 Connector 不双活 | `PARTIAL` | 本轮同进程双实例与跨网关同账号锁 Fixture；正式独立 Connector 尚未接入，跨进程真实账号切换未跑。 |
| 5 重复消息不重复回复 | `VERIFIED_FIXTURE` | 原生 ID 回执使回调仅执行一次；无真实 QQ 回复证据。 |
| 6 重连不重复发送 | `PARTIAL` | 重连重投不会再次调用处理器；独立 MCP/HTTP 外发仍未归单执行者。 |
| 7 QQ 开、Bionic 关 | `VERIFIED_FIXTURE` | 独立开关和 Legacy 接收门验证；真实 QQ 基础传输未跑。 |
| 8 QQ 关、Bionic 开 | `VERIFIED_FIXTURE` | Bionic 配置保持，QQ transport/MCP/Plugins 调用拒绝。 |
| 9 Bionic 崩溃隔离 | `PARTIAL` | 仍在 Legacy 进程内，不能证明故障隔离。 |
| 10 群记忆隔离 | `PARTIAL` | 旧 group key/数据保持，未运行新独立 Bionic 的双群写入测试。 |
| 11 QQ 无 Core Owner 权限 | `VERIFIED_FIXTURE` | 既有 Core 数据 IPC 外部 token 拒绝；旧 ownerQQ 管理命令按 RULES.md 保留。 |
| 12 工具禁用全入口拒绝 | `PARTIAL` | 已覆盖 transport、SnowLuma/QQ-file MCP 与 Plugins invoke；旧 `bot.raw`/HTTP 动作尚未逐项验证。 |
| 13 MCP 真返回 | `NOT_RUN_ENVIRONMENT` | 目录与 mock transport 返回通过；缺真实 OneBot。 |
| 14 Core 重启后状态 | `PARTIAL` | Core 既有重启/Task/Memory Fixture；QQ 回执重启 Fixture，真实网关重连未跑。 |
| 15 卸载保留数据 | `PARTIAL` | 本轮没有卸载/迁移实现，也没有删除数据；尚无新 Connector 卸载 Fixture。 |
| 16 SEA Connector 启动 | `PARTIAL` | SEA Core/IPC RC 通过，独立 QQ Connector 入口尚不存在。 |
| 17 Legacy 兼容无双活 | `PARTIAL` | 同 StateDir `.core-owner.lock` 既有 Fixture；真实 QQ Legacy/新 Connector 切换未跑。 |
| 18 Agent none | `VERIFIED_FIXTURE` | 沿用 `test-desktop-chat-product`，本轮未改变 Agent Broker 派发。 |

`restored` 只代表工具目录恢复登记，不能推出 OneBot 调用成功。消息回执最多保留最近 5000 个 ID；超出窗口后的旧消息重放仍需事件协议与持久游标处理。QQ 锁位于当前用户临时目录，不能据此宣称跨 Windows 用户会话独占。

## 数据所有权与仍存在的双写/越权风险

| 数据或动作 | 当前唯一写者/边界 | 后续条件 |
| --- | --- | --- |
| Task/Memory/Workspace | 正式 Core 或独占 Legacy 宿主，受 `.core-owner.lock` 保护；本轮未改其 Store、ID 或路径。 | 不允许 QQ/Bionic 再建写者。 |
| QQ 消息回执 | Legacy QQ Runtime 的 `qq-message-receipts.json`；新增原子文件，没有改写旧游标或用户数据。 | 离线对账并设计跨状态目录的游标切换与回滚。 |
| `social-v2.json`、群印象、黑话、贴纸、社交记忆 | 仍由旧 Bridge 单写；按原 `group:<id>`/私聊 key 分区。本轮没有迁移、清空、合并或另建数据库。 | Bionic 接管前逐群核对 schema/hash/count；旧写者确实停止后再启新写者。 |
| QQ 外发 | Bridge 普通文本 transport 和已接线 MCP 有权限门；旧 `bot.raw`、QQ file-send HTTP OneBot 仍是多个执行入口，未形成账号级统一发送队列。 | 把每个直接动作映射到受限 Channel 能力，验证白名单、审批、幂等和单发送者后才可切换。 |
| QQ 外部身份 | 来信只按旧 QQ ownerQQ 规则执行旧管理命令；Core 数据 IPC 拒绝 Legacy/外部 token。没有把 QQ 用户转换成 Core Owner token。 | 对旧所有 `/api/*` 与工具逐方法审计；保留 RULES.md 规定的 QQ 管理边界，禁止绕过 Core Capability Broker。 |

## 变更、构建与测试

代码和测试提交：`05202163b14f6e47e16ed3a488a8ca08d5f60797`。修改 `src/bridge.js`、`src/channel/qq/{runtime,transport,ownership,receipts}.js`、`src/integrations/{service,tool-policy}.js`、`scripts/test-{qq-runtime,bionic-chat-plugin}.mjs`。Build Number 提交：`65a1eb4`，`release/version.json` 从 1075 → **1076**。测试均使用统一 `npm test` 入口；未新增孤儿测试脚本。

| 验证 | 结果 |
| --- | --- |
| `npm test` | 最终代码和 Build 1076 提交之后重新运行：**103 PASS / 0 FAIL / 7 NOT_RUN_ENVIRONMENT**（110 suites）。跳过项含真实 OneBot、真实外部网关/网络、真实 Codex、未显式启用的 Rust 聚合项；Rust 已由下方独立命令验证。 |
| `npm run build:core` / `npm run build:ui` | PASS；SEA Core bundle/资源审计与 Harbor 生产 bundle 均完成。 |
| `npm run desktop:check` / `npm run desktop:test` | PASS；Cargo **198 passed / 0 failed**，现有 dead-code/unused 警告。 |
| `npm run desktop:build` / `npm run desktop:build:debug` | PASS。 |
| `npm run build:release` | PASS；Build 1076，源码提交 `0520216`，`dirtySourceTree=false`，发行禁止项/构建机路径/凭据审计通过。 |
| `npm test -- --category release` | 8 PASS / 0 FAIL；含 RC 安装器、SEA Core/IPC 隔离验证。 |

本地 RC 安装包：[CetaMesh-Setup-1.0.0-rc.2-build1076-x64.exe](artifacts/rc/1.0.0-rc.2/build-1076/CetaMesh-Setup-1.0.0-rc.2-build1076-x64.exe)，42,999,808 字节，SHA256 `F6465F7B2167A7BAD83488D647276F7B19B79165C120A9F5AFD19145E683F55A`。Core SEA SHA256 `BAD87A9086E3356D60931CC3E89684348BD82E7A35421E45C743305A558CEBE7`。未签名、未发布。发行包证明纯 Core/IPC 与安装器可运行；**不证明**独立 QQ Connector 可从 SEA 启动。

最终可执行代码/测试来源 HEAD `05202163b14f6e47e16ed3a488a8ca08d5f60797`；Build Number 提交 HEAD `65a1eb4`。本报告本身的提交会再推进一次分支 HEAD，因此最终分支 HEAD 以交付时的 `git rev-parse HEAD` 和交付消息为准，不能预先把提交自身的哈希写入其文件内容。

## M2/M3 剩余耦合及 M5 前置条件

M2 的正式 `--worker` 独立启动没有回退，M3 的 DSH Provider/Follow 没有修改。Legacy 仍是独占 Core 宿主且在旧入口启动 SnowLuma；这部分 `M2_PARTIAL/M3_PARTIAL` 没有因本轮的 QQ Runtime 封装而解除。

进入 M5 或真实账号切换前，需先完成：① 独立 QQ Connector 的受控进程/IPC 入口和版本化 Channel 消息、ACK、gap 契约；② Bionic 从 `bridge.js` 拆成消费 Channel 事件的单独策略组件，并只通过受限 Channel/Capability 接口发消息及提交社交记忆候选；③ 旧 Bridge 的 `bot.raw`、QQ file-send/MCP、卡片/贴纸/音乐逐方法归到一个发送执行者；④ 跨进程/崩溃恢复的消费者与发送者切换测试；⑤ QQ/Social 每份旧数据的离线库存、分群校验、备份/恢复 Dry Run 和唯一写者计划；⑥ Owner 批准隔离账号的切换窗口和真实 QQ E2E。上述条件达成前维持 **RELEASE_BLOCKED**，不得声称 M4 代码验收完成。
