# WhaleBridge M5-A — 迁移、兼容与安全回滚方案

## 1. 授权与当前实现边界

基线 `e70a3de70d002d10d744c27a4fa0e7d3c6e95a4c`，独立分支 `codex/whalebridge-m5-a-dry-run`。本轮只授权实际只读库存、Dry Run、工具设计和隔离 Fixture 验证。真实数据状态始终为 **REAL_DATA_NOT_AUTHORIZED**，发布仍 **RELEASE_BLOCKED**。

新增的生产可用工具只有只读 CLI：`scripts/whalebridge-migration-dry-run.mjs`。没有 `--apply`、`--force`、删除、停进程、注册表或凭据导出命令。迁移执行原型在 `src/testing/legacy-migration-fixture.js`，仅操作自己分配的临时 Fixture；未接入 Core/Bridge/安装器或 SEA。Owner proof、writer 停止确认及版本 pointer 是测试原型，**不是已接入 Core Approval 的真实迁移授权或生产存储解析器**。

工具代码提交：`4eb5887734d237a49e78e525e9947466ed678d10`。基线 Build 1081 保持；本轮未更改产品启动/运行装配，Core SEA SHA-256 仍为 `333266f7f27c7544fb4d99aac81e1f59f97f76cf518881f6672b3116f95c0ba0`，没有生成新的安装包或宣称真实迁移完成。

## 2. 来源、目标与唯一写入者

| 数据 | 目标关系 | 本轮行为 |
| --- | --- | --- |
| Task / Memory / Workspace / Approval / Continuity / Chat | 原 Core Store 保持原位置，Core 唯一 writer | 只读元数据和 Hash；不新建 Store、不重写历史 ID/rev/Scope |
| QQ 账号、网关配置及凭据 | 配置仍由用户/Core 拥有，Connector 使用受控引用 | 不复制凭据；不自动选择账号；ownerQQ 不是机器人账号证明 |
| QQ 游标、去重、发送账本及回执 | 沿用 M4 的原路径和唯一 QQ Runtime writer | 保留原账本，未知发送不能通过迁移归零或重发；缺游标停止自动接管 |
| Legacy Social / QQ Session / 人设 / 成员印象 / 黑话 / 贴纸 / 卡片 | 批准账号归属后进入 Bionic 账号分区，保留群/用户子分区 | 只提出映射，不拆并记录，不自动导入 Core Memory |
| 已有正式 Bionic 数据 | 原 Bionic writer 与原账号目录 | 任何既存目标均须复核，不覆盖、不合并 |
| DSH preset / 外部 QQ、SnowLuma、DSH 应用数据 | 用户最终所有权 | 用户修改或归属未知即保留；manifest 匹配不构成本轮更新许可 |
| 安装资产、仓库 roles、日志、未知文件 | 维持原所有权/UNVERIFIED | 作为兼容或资产保留，不自动搬迁或清理 |

源数据完整清单、Schema/Version、计数及 Hash 在 `WHALEBRIDGE_M5_DATA_INVENTORY.md` 和脱敏 JSON 台账中。真实来源的账号归属未确认，本轮没有构造可执行的真实账号映射。

### 目标结构及必要的 M5-B 设计门禁

M4 当前实际路径为 `dataRoot/channel/qq/<accountId>/bionic/state/...`，发现旧根 Social/roles 时阻止启动新 writer。Fixture 用 `versions/<planId>/accounts/<accountId>/<原相对路径>` 验证版本化快照，再以一个原子 `active-version.json` 选择权威版本。该布局是隔离验证模型，**不等于 M4 运行时已经能够读取这个 pointer**。

M5-B 必须另行批准并实现最小 Bionic 数据根 resolver、Legacy 只读兼容门禁及版本检查。resolver 必须同时校验完整 pointer 的 version、planId、directory、legacyMode 和账号映射；不得用 Junction、覆盖原目录或删除空 sessions 文件绕开 M4 门禁。Core Store 不随此 pointer 搬迁。不能在 resolver/Legacy 门禁尚未实现时对真实目录生成 active pointer 并宣布切换成功。

Legacy-exclusive 新旧版本的启动能力须逐个核验：可写旧入口未确认停止、旧版本不能理解只读标记或外部网关仍有其他消费者时，拒绝切换。不能仅修改配置文字宣告旧实现已只读。只读兼容只允许读取旧资料或经权威服务调用，不准旧 Social 循环回写。回滚启用旧 writer 也必须先停止新 writer 并核验账号租约。

Session ID/Scope 保持不代表可恢复原生回合或认证。旧 Social 快照可能含会话 Token，M5-B 必须审阅敏感备份保护及凭据引用/失效/重新绑定，不自动启动旧 Follow、bootstrap、工具调用或重发。Fixture 的字节一致性只证明数据保真，不是原生 Session 恢复或权限证明。

## 3. Dry Run 机制

1. 复用 `createAppPaths()` 的 CLI/环境/portable/LOCALAPPDATA 优先级；显式额外来源和安装 exe 作为候选根，记录 provenance。
2. 只读遍历 state/roles/channel 和 config，拒绝 Symlink/Junction/不可读路径、越界及扫描中变化；不调用会修复/备份/创建文件的 Domain Store 构造器。
3. 按实际 Domain 区分同名文件：例如 Core `state/desktop-chat/sessions.json` 是 v1，Legacy `state/sessions.json` 是未版本化 QQ 映射，不可仅凭文件名判成同一 Schema。
4. 记录原始字节 Hash、Domain Schema、记录数及 ID/Scope/reference fingerprint；原生身份、正文、Token、Cookie、动态文件名和任意根路径仅输出散列/别名。
5. 不猜测机器人账号；人工提出的 `--account` 只是计划建议，不是权限证明。多个来源指向同一账号、不同账号回执、坏 Schema、既存目标、未知副作用等停止自动接管。
6. 输出稳定 planId，无时间戳、随机 ID 或写回；来源有变化必须重新计划并重新批准。备份空间只读估算；目的写权限、NTFS 元数据与真实恢复能力未证明时不能视为真实 apply-ready。

边界：扫描不枚举整块磁盘或读取进程环境内存；隐藏在未声明 portable 目录、外部数据库或用户自定义历史目录的数据需 Owner 补充。日志正文未读，只列大小/位置别名。超过安全扫描上限必须分批明确复核，不得静默当不存在。

## 4. 隔离 Fixture 执行状态机

```text
只读计划 + 绑定 planId 的模拟 Owner proof
  -> 停止 Fixture writers 的 ACK
  -> Coordinator + 每个源 StateDir + 每个 QQ 账号租约
  -> PLANNED
  -> 原字节快照、原 ACL/mode 元数据、只读备份 -> BACKED_UP
  -> 未激活版本目录写入 -> STAGED
  -> Hash + Schema + 计数 + ID/Scope + ACL + 再扫来源 -> VERIFIED
  -> 原子替换完整 active pointer
  -> COMMITTED
```

- 真实备份路径不能在真实来源目录中随意创建；本轮所有路径均为工具自己分配的 Fixture。测试夹具准入有进程内分配表和父进程对子进程的专用 permit，伪造 manifest 本身无效；child 不获 dispose 权限。该辅助模块不对抗能执行任意同权限 Node 代码的本机攻击者，不是生产沙箱。
- JSON 读写经 Storage Primitive；复制需保留原字节时使用同一 primitive 的 writeTextAtomic。权限保存原 mode，Windows 保存完整 SDDL；备份另设只读属性，保留原 ACL 元数据用于对账。备份/目标 Hash 与 ACL 均验证后才允许提交。
- 目标只是未激活版本目录。存在目标或备份时不覆盖；重复已提交的同一计划只有在来源、备份、完整 pointer、目标、停止写者和有效租约全部仍可证明时返回 duplicate，不重复导入。
- journal 包含预期文件清单、实际已备份清单、protected source Hash、记录数、ID/Scope fingerprint、权限和阶段证据；提交态的文件清单不完整即拒绝核验。
- 获得协调租约后才读取最新 journal。所有提交、恢复和回滚在写 pointer/journal 前复核租约；仅匹配 planId 不足以证明权威目录正确。
- 原来源始终不改写，Core 资料仅作保护性 Hash 对账。Source 数据/权限变化、staging 期间新增文件、目标变化或未知外发都阻止提交。

## 5. 崩溃恢复与失败补偿

| 磁盘证据 | 恢复决定 |
| --- | --- |
| 尚无 journal / 尚未开始写入 | 验证批准及停止条件后报告 NOT_STARTED，不生成或切换权威数据 |
| pointer 尚未提交，journal 为 planned/backed_up/staged/verified | 验证已记录备份和原来源，保持旧权威，标 ROLLED_BACK；保留残留快照/未激活版本 |
| pointer 已提交但 journal 仍 verified | 完整核对 pointer、目标、备份和来源后认定 COMMITTED，不能再次导入 |
| pointer 与 journal 不匹配、备份/来源/目标/ACL 不可信 | BLOCKED，保留全部证据；不猜测成功、失败或回滚完成 |
| 回滚已记录 ROLLING_BACK，pointer 已回到旧值 | 对账后结束为 ROLLED_BACK；若新 pointer 仍完整有效，可核验为 COMMITTED，等待重新批准回滚 |

Fixture 在 PLANNED、BACKED_UP、STAGED、VERIFIED、pointer 已替换但 journal 未提交、COMMITTED 六个位置强制杀死自己创建的 Node 子进程。遗留账号/源目录租约只在原 PID 已确认消失后按既有锁规则恢复；没有杀任何真实 Core/网关/DSH。

磁盘不足、EACCES、目标写中断采用可重复的 Fixture 故障注入；部分目标和备份保留，不自动清空以“重试成功”。未提交或已回滚的同一版本如仍有快照/目标，重新 apply 可返回 TARGET_CONFLICT/BACKUP_EXISTS，需 Owner 受控归档和新计划。当前原型验证**安全拒绝与恢复判断**，不宣称任意残片均能自动续传。

## 6. 回滚条件与停止点

回滚必须另有同计划批准、停止新旧 writers、持有当前数据与账号租约，验证完整当前 pointer、只读备份、原来源以及当前目标。先写 ROLLING_BACK，再原子切回旧 pointer，最后写 ROLLED_BACK。原文件未改，历史 ID、Scope、session mapping 和原权限保留。

**如果新 writer 已写入新资料，当前版本 Hash 不再等于迁移快照，自动回滚必须阻塞。** 不能丢掉新消息后简单切回旧资料。后续需另做新旧增量只读对账、备份与恢复方案，并由 Owner 决定；外部已发消息等不可逆副作用没有自动补偿。未知发送结果没有查询证据时保持 outcome-unknown，不重放。

本轮未接入真实 Core Approval、真实 writer 停止协议、生产 pointer resolver、Legacy 只读启动门禁或安装器升级入口；这些是 **M5-B 的设计/批准和实施前置条件**。不能据 Fixture 成功开启真实迁移。

## 7. 阶段关系

- M2_PARTIAL：Legacy-exclusive 兼容宿主仍存在；要先保证它理解并执行数据只读/回滚门禁，不通过删除 Bridge 规避。
- M3_PARTIAL：DSH 真实 coding Session、原生版本和 preset 兼容未完全验收；本轮不写 preset，不以静态 prefix 检查替代原生 Session E2E。
- M4_CODE_COMPLETE / M4_E2E_PENDING：保留既有单账号租约、入站游标、发送账本及权限；真实 QQ E2E 未完成，不能用数据迁移代替它。
- 本轮只交付 M5-A；真实数据为 REAL_DATA_NOT_AUTHORIZED，等待独立 M5-B 指令。
