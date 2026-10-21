# WhaleBridge M5-A.1 — 迁移前阻塞核验

## 1. 基线与结论

本轮基线：`fda079e08ba65a2855d9706cbc2f68a4c6496ee8`，分支 `codex/whalebridge-m5-a-dry-run`，实际工作树 `D:/GIT- CetaMesh/audit-critical-repair`。开始时干净；`D:/GIT-QQ-BRIDGE` 的另一设计分支及既有修改只读保留。产品版本 `1.0.0-rc.2` / Build **1081**，未修改产品代码、未重新打包。

**M5-A.1 只读核验及审批材料已准备；真实迁移仍为 REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED。** 没有将原阻塞改成批准：8 项账号归属仍缺可靠证据，2 处游标在已检查来源内不可恢复，2 处 writer 停止仍未获确认。M2_PARTIAL / M3_PARTIAL / M4_CODE_COMPLETE / M4_E2E_PENDING / RELEASE_BLOCKED 保持。

新增证据：`WHALEBRIDGE_M5_A1_READ_ONLY_EVIDENCE.json`（逐文件身份线索、候选来源、锁与进程观察）；`WHALEBRIDGE_M5_A1_DRY_RUN_EVIDENCE.json`（新执行的完整脱敏计划）。旧 M5-A 证据不覆盖。证据提交和最终交付提交见本报告末尾。

## 2. 八项 Social 文件逐项核验

根别名：`3402041dd63077f1` 为原源码来源；`c12a489fa781c9d2` 为安装版默认候选数据根。逐项原始字节 SHA-256、计数和 Schema 见 Owner Decision Package；八项均 **UNVERSIONED**、符合当前静态 Schema，且 Hash 与 M5-A 完全一致。

| 来源根 / state 文件 | 可核实的关联证据 | 不能据此推断的内容 | 结论 |
| --- | --- | --- | --- |
| 340… / social-v2.json | 3 个会话；2 个 Session 映射会话键与其匹配；保留消息 ID、局部 seq、lastUnreadSeq | 无已识别机器人 account/self/bot 字段或历史迁移标记；消息来源用户不等于机器人账号 | OWNER_REVIEW_REQUIRED |
| 340… / sessions.json | 2 个字符串原生 Session ID；会话键与 Social 两项相同 | Session ID 和同群关联不能证明机器人账号、原生授权或完成回合 | OWNER_REVIEW_REQUIRED |
| 340… / current-role.json | 1 文档，role/mode 结构；所引用的本地人设资产存在 | 人设存在、相同目录或默认账号均不是账号证据 | OWNER_REVIEW_REQUIRED |
| 340… / slang.json | 63 个稳定 ID；来源引用含一个与 Social 相同的会话别名 | 群来源能关联语料，不能判断哪个机器人采集或授权跨账号复制 | OWNER_REVIEW_REQUIRED |
| 340… / slang-session.json | 1 文档、一个学习 Session 引用，与聊天 Session 用途分离 | 学习会话不能映射为聊天账号或自动恢复学习任务 | OWNER_REVIEW_REQUIRED |
| 340… / stickers.json | 40 个稳定 ID，创建/更新时间字段 | 时间、贴纸内容或库位置不能证明账号；不得默认全局共享 | OWNER_REVIEW_REQUIRED |
| 340… / social-v2-cards.json | 1 个会话缓存键与 Social/Session 的同一会话别名一致 | 卡片用户字段不是机器人身份，缓存不构成消费 ACK 或发送回执 | OWNER_REVIEW_REQUIRED |
| c12… / sessions.json | 0 个映射；只有空 sessions 容器 | 空文件不能证明废弃、也不能删除以绕开 Bionic 旧数据门禁 | OWNER_REVIEW_REQUIRED |

检查包括 Schema/version、已识别 accountId/account_id/self_id/selfId/botQQ/botId/sourceAccountId 字段、group/private 会话键、Session 引用、来源 Scope 值、迁移标记及原字节 Hash。额外 account/self/bot/migration/scope/origin 类键的指纹筛查未发现新线索。没有输出真实账号、群号、用户号、Session ID、Token、人设/聊天/偏好正文。

可靠关联只支持“这些资料可能属于同一历史业务上下文”，不能推出“属于某个机器人账号”。本轮 **可靠账号映射新增 0 项**，自动归属 0 项，自动导入 Core Memory 0 项。Owner 后续若提供原账号绑定清单、受控网关身份/历史清单及可验证来源链，应生成新计划，不能直接给当前未知文件填默认账号。

## 3. 缺失游标与安全接续

| 来源 | 检查结果 | 决定 |
| --- | --- | --- |
| 3402041dd63077f1 | state/channel/backups/backup/data 的受限只读检查未发现 QQ receipts/send-ledger/cursor 或迁移 pointer。Social 有 93 处 messageId 字段，但不是 93 个已确认唯一或已消费事件；lastUnreadSeq 为会话局部递增，消息缓冲有界 | CURSOR_UNRECOVERABLE（限定于已检查来源）；MIGRATION_BLOCKED |
| c12a489fa781c9d2 | 同范围未发现旧 QQ receipts/send-ledger/cursor。找到另一 Core desktop-chat sessions 文件，属于 Core v1，不能替代空 Legacy QQ Session 的游标 | CURSOR_UNRECOVERABLE（限定于已检查来源）；MIGRATION_BLOCKED |

实际候选文件的路径指纹、字节大小和 Hash 已记录；没有读取诊断日志正文，没有枚举整个磁盘、网关数据库、其他 Windows 用户配置或 Owner 未声明的历史备份。后续合法来源包括：Owner 指定的原 StateDir 备份、账号绑定的原 receipts/send-ledger、旧消费者交付日志/journal、经验证的网关历史结果查询。是否支持查询必须依据真实协议，不能假定 OneBot 存在历史发送查询。

源码证据：`src/bridge.js` 的 `lastUnreadSeq` 在加入消息时本地加一，recentMessages/unread 分别有界保留；该状态不是 Core Channel consumer ACK；`src/channel/delivery-journal.js` 的消费者确认与游标另有语义。发送时间、lastAiReplyAt、卡片缓存、forward-id 去重也不能证明每条消息的副作用完成。

**需 Owner 单独选择的接续设计（尚未实施）：**

1. 保持原数据只读、自动社交外发暂停；继续寻找真实账号绑定的游标、回执和未完成请求证明。找不到时继续阻塞历史重放。
2. 如果 Owner 决定保留历史为只读档案、仅接续新实时输入，另批准一个新的接收 epoch：验证账号/网关身份、停止旧消费者并核实账号及 StateDir 租约，以真实新入站和 Core durable append 建立新 epoch 的事实边界。它不是补造旧 cursor，也不认定旧消息已处理。
3. 历史 unread、旧 Session bootstrap/Follow、工具调用及自动回复保持隔离，不自动投递。对历史未知副作用逐请求核验；不能查证就保持 outcome-unknown/待核验，不重发。无 requestId 的旧行为也不能凭内容或时间伪造 exactly-once。
4. 新 epoch 的生产门禁、持久身份及恢复测试需要单独设计/批准/实现；当前工具不提供该真实接续功能。Owner 不接受不重放历史的取舍时，只能继续阻塞。

## 4. Portable、环境与实际 writer

2026-10-18 11:17 UTC 的只读 CIM 快照（时点观察，迁移前必须重查）：

- 安装版默认根 `.core-owner.lock` 是 `PID:nonce` 文本格式，PID **43516** 存活，匹配安装目录 `WhaleBridgeCore.exe --worker`，父 PID **32632** 为桌面壳；记录了启动时间和可执行路径 Hash。**没有停止 ACK，也没有证明该锁 nonce 与进程启动身份的绑定；不回收锁。**
- 原源码根 `bridge.lock` 是纯 PID 文本，PID **28992** 当前不存在。没有启动时间/nonce/消费者停止 ACK，不能仅凭死 PID 删除锁或批准接管。旧网关订阅者和未完成外发仍需独立核验。
- 另 5 个安装版 Core.exe 的参数匹配 MCP 候选，不当作 5 个 Core owner。未观察到可识别的 QQ/Bionic worker；不能从进程名快照推出不存在外部消费者。
- 26 个其他 Node 进程用途未确定，其中 4 个可执行路径不可读。未读取其原始命令行到报告，也未据此认定它们全是本应用进程。**并发 writer 未排除**。
- 安装 exe 根和两个声明的源码根无 portable.flag/data。对两个仓库 dist/output/artifacts 做深度 5、排除 payload/resources/node_modules/webview2、拒绝跟随链接的目录元数据检查，共 207 目录，未发现 portable 标记或命名候选。该受限搜索没有定位到可确认的“历史 Portable 数据目录”，不能宣布其已停用；Owner 仍需提供历史目录/快捷方式/启动配置。没有扫描产物正文或日志。
- 当前探测进程 **未提升权限**（不能根据用户名 Administrator 认为已管理员运行）。当前 shell 的 DATA_DIR/RESOURCE_DIR/DSH_HOME 均未设置，LOCALAPPDATA/TEMP/TMP 存在；目标进程环境块未读取。跨普通用户/管理员/其他登录会话的运行与 ACL 继承为 **NOT_RUN_ENVIRONMENT**。

### 实际配置优先级与继承链

`src/app-paths.js` / `desktop-shell/src/desktop_paths.rs`：显式 --data-dir > WHALEBRIDGE_DATA_DIR > exe 同目录 portable.flag/data > 用户 LOCALAPPDATA/WhaleBridge；源码无覆盖时使用源码根。Node 相对覆盖路径按 cwd 解析，Rust 壳接受相对 PathBuf，**审批执行时要求记录解析后的绝对路径，不接受相对路径作为唯一证据**。resourceRoot 与可写 dataRoot 分离。LOCALAPPDATA 缺失时 Node 与 Rust 兜底不同，须显式绝对 data-dir，不能猜测两者仍一致。

`desktop-shell/src/supervisor.rs` 启动 Core 时设 cwd=data_dir，并显式注入 WHALEBRIDGE_DATA_DIR、SUPERVISED 和 Owner IPC 环境，其余继承壳；Owner Token 不在报告输出。`src/channel/qq/connector-host.js` 显式传 --data-dir 并注入同一 dataRoot，删除 Owner IPC/console 及部分模型环境；stdin/stdout 是受控通信。DSH_HOME、TEMP/TMP、USERPROFILE、LOCALAPPDATA、PATH 等其余环境继承，不能以本次 shell 值替代目标进程值。DSH 配置 homeDir 优先，其后 DSH_HOME/用户 .dsh；本轮两个配置都未设置 homeDir。

账号锁默认基于 `os.tmpdir()/cetamesh-qq-ownership`；当前用户 TEMP 中该目录不存在，**不等于其他用户/提升环境没有租约**。切换前须确认所有相关进程的有效 TEMP/账号/网关锁命名空间及启动身份，跨用户同账号唯一消费者尚未证明。不得在本轮创建新锁、接管、停网关或杀 DSH。

当前/目标唯一 writer：Core Store 保持 Core；QQ durable ingress/发送账本由现有 Core Channel/QQ Runtime 链各持有既有职责，迁移不得产生第二份；Bionic 专属状态目标为账号分区下唯一 Bionic writer。Legacy-exclusive 与新链必须互斥。真实 writer 尚未停止，且生产版本 pointer resolver/Legacy 只读门禁尚未安装，所以无法批准实际切换。

## 5. 新鲜验证与剩余阻塞

实际相同参数连续两次 Dry Run，planId 均为 `7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e`，与 M5-A 相同；86 项库存、3 个 preset 元数据、原 12 项阻塞未变化。实际源未被改写，不通过变更真实文件测试失效。隔离 Fixture 已验证改写/新增来源会令旧计划及旧批准失效。

本轮迁移测试：`npm test -- --suite test-whalebridge-m5-dry-run --suite test-whalebridge-m5-fixture` → **2 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**（0.3s / 111.0s）。覆盖首次、重复、6 个强制子进程崩溃窗口、回滚、源/目标变化、租约、账号/群隔离及历史 ID/Scope 原样核验；结果 **DRY_RUN_PASS / FIXTURE_MIGRATION_PASS / ROLLBACK_PASS**。现有测试已在统一聚合器登记，本轮未增删测试或改断言。

路径/Core/QQ scoped 回归结果见 Owner Decision Package 最终验证节。M5-A 的全量 npm 114/0/7、Rust 198/0 和构建结果是历史证据，本轮不将其冒充新执行；本轮无产品代码变更，不重复产品全构建或制作安装包。

| 阻塞 | 当前状态 | 关闭所需证据/决定 |
| --- | --- | --- |
| 八项 Social 账号映射 | OWNER_REVIEW_REQUIRED | 逐项可靠来源链、批准映射；不能只凭目录/群/ownerQQ |
| 两根旧消息游标 | MIGRATION_BLOCKED / CURSOR_UNRECOVERABLE | 原游标与副作用证明，或单独批准/实现新 epoch、历史隔离方案 |
| Writer / 便携 / 跨用户环境 | MIGRATION_BLOCKED / OWNER_REVIEW_REQUIRED | 真实有效根、启动身份、停止 ACK、租约命名空间；不可读环境仍 NOT_RUN_ENVIRONMENT |
| 生产 resolver / Legacy 只读门禁 | MIGRATION_BLOCKED | Owner 审阅 M5-B 兼容实现，独立验证，不能用 Fixture pointer 顶替 |
| 真实备份/ACL/空间/恢复位置 | MIGRATION_BLOCKED | 独立批准具体备份根和保留/保护方案；实际校验可恢复性 |
| DSH / QQ 真实 E2E | NOT_RUN_ENVIRONMENT | 独立真实协议、coding preset 和 QQ 验收，不因资料方案关闭 |

## 6. 交付与停止

没有真实迁移、写入者切换、账号切换、凭据/preset 覆盖、旧资料清理或跨群/跨账号合并；真实操作次数为 0。只将新增脱敏证据和文档提交本地分支。Owner Decision Package 提供逐数据组待决动作；没有自动批准任何条目。

证据提交：`13f1dfc347fef81236a5e9d66613c50957f49109`；最终交付 HEAD 由包含本文件的本地提交标识（Git 可据文件历史直接定位，避免自引用 SHA）。完成后停止，等待 Owner 分范围批准；不 push、不合并 main、不发布 Stable。


### 交付证据校验

只读证据文件 SHA-256（当前工作树原字节）：`7008891d9344777a8ff7aab43b13c6cd3eae5932bcdf726c8c0d1232782b24f4`；新 Dry Run JSON：`81184498adf3e76d6851289ea8471d3ef50fa502c5e1b76fc835c520010d6120`。这些是证据文件 Hash，不是安装包 Hash；本轮没有生成新安装包。最终回查真实 planId/八项 Social Hash 均未变化，Fixture 工作树残留为 0。

本轮仅 5 个定向 npm suites：5 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT。真实环境的 NOT_RUN_ENVIRONMENT 是单独的验收状态，不混入这 5 个自动化统计。证据快照提交 `13f1dfc347fef81236a5e9d66613c50957f49109`；最终报告 HEAD 取 `git log -1 --format=%H -- WHALEBRIDGE_M5_OWNER_DECISION_PACKAGE.md`，确切值随最终答复交付，避免在提交内容内自引用其尚未生成的 SHA。
