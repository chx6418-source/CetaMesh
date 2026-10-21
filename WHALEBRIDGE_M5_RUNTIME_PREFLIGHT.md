# WhaleBridge M5-A.2 — 只读运行预检与恢复准备

## 1. 可运行入口和边界

基线 `c04ad381916147eca10eddac2edf5f8f23d0060e`；当前功能分支 `codex/whalebridge-m5-a-dry-run`。新增 `src/migration/runtime-preflight.js` 与 CLI：

```powershell
node scripts/whalebridge-runtime-preflight.mjs --root 'D:/GIT-QQ-BRIDGE' --app-exe 'C:/Users/Administrator/AppData/Local/Programs/CetaMesh/WhaleBridgeCore.exe'
```

CLI 使用现有 createAppPaths/discoverMigrationRoots，包含当前配置默认根。输出脱敏元数据，退出 **2** 表示 MIGRATION_BLOCKED，是预期的阻塞结果；没有 --stop/--recover/--apply 模式。只读观察不能颁发迁移许可，因此本工具没有“自动全部通过就迁移”的入口。

不实例化 Channel Journal、Task/Memory Store 或 Approval 服务，避免构造时恢复写入；JSON 经 Storage Primitive。检查锁时只读文本及 signal 0 存在性，不发送终止信号，不回收锁；拒绝 Symlink/Junction，单个 JSON 32 MiB 上限、租约目录 1,000 项上限。缺失、损坏、不支持 Schema、读取中变化分别报告，不修复原件。CLI 未打入 Core SEA。

## 2. 检查表与本次实际结果

当前脱敏快照：`WHALEBRIDGE_M5_A2_EVIDENCE.json`。时点证据不能作为未来执行窗口的停止证明。

| 项目 | 实际观察 | 未证实项 / 门禁 |
| --- | --- | --- |
| Core 身份 | 安装版 `.core-owner.lock` PID 存活，与 CIM 的 --worker 进程别名、exeHash、启动时间和父壳关系匹配 | 锁内容未绑定可验证进程创建身份；无停止 ACK，MIGRATION_BLOCKED |
| Legacy 身份 | 原根 bridge.lock PID 当前 ABSENT；锁 Hash 与 A1 相同 | 死 PID 不证明旧消费者、Social writer、未完成外发均已停止；锁不释放 |
| 当前 StateDir | 三个已声明候选根均逐根检查；路径来源及优先级沿用 A1 | 目标进程环境块、其他用户/便携/相对路径解析未完整验证，effectiveProcessStateDir 仍 UNVERIFIED |
| 账号/网关租约 | 当前 TEMP 锁目录未发现，未取得任何租约 | 其他用户或提升环境的 TEMP 不能排除；不认定无账号消费者 |
| IPC | 命名空间观察可见 1 个 Owner 管道 | 未发起认证 read-only health 请求，NOT_RUN_ENVIRONMENT；存在管道不等于协议可达/健康，不导出 Owner Token |
| 活动 QQ 消费者 | 产品进程快照中无可识别 QQ/Bionic worker；5 个额外 Core.exe 仅为 MCP 候选 | 其他进程/网关订阅者未证明，activeQqConsumers=UNVERIFIED，不能据此接管 |
| 未完成发送/未知结果 | 三根均未发现 QQ send-ledger；delivery journal 也未发现 | NOT_FOUND_NOT_PROOF_OF_EMPTY；不能推断“没有发送”或“所有副作用已完成” |
| 持久审批/请求 | 安装版 capability/approvals.json、requests.json 可读，本次 unresolved 各 0 | 仅限两个持久文件，不含内存卡片审批、其他根或外部系统；不取消/消费任何审批 |
| 迁移/导入 | 固定 root/migration-journal.json 未发现 | Workspace 导入 journal 实际可在 TEMP/CetaMesh/workspace-import-journal；未枚举所有 Workspace/其他用户、外部导入和内存状态，整体 UNVERIFIED |
| 权威 writer | Domain 设计仍 Core / QQ Connector 链 / Bionic 各有既有权威职责 | 真实 writer 清单、停止 ACK、账号映射和只读门禁未证实；authoritativeWriter 观察状态 UNVERIFIED |

工具 `unresolved` 只计已识别持久状态：发送 outcome-unknown；交付 in-flight/outcome-unknown/retry-authorized；审批 pending/approved；执行请求 in-flight。未知 Schema 不按 0 处理。当前工具不是完整 Domain Schema 验证器，OBSERVED_NOT_COMPLETENESS_PROOF 也不能作为清空或接管证明。

正式 M5-B 前仍需既有 Owner IPC 的受权只读查询，核对所有活动消费者、待决审批、Workspace 导入 journal 及执行状态；真实进程停止须另批并返回停止 ACK，随后以启动身份、锁 nonce、账号/网关/StateDir 复核。旧版本不能执行只读门禁时拒绝切换。不杀用户独立网关或 DSH。

## 3. 数据根与备份能力核对

现有 `src/app-paths.js` / Rust desktop_paths 的 CLI > env > portable > LOCALAPPDATA 优先级保持；Core supervisor 与 Connector 子进程显式继承同一 dataRoot。A1 已记录普通/提升环境、LOCALAPPDATA 缺失和相对路径差异，真实执行必须绑定有效绝对路径。

**生产没有安装版本化 Bionic 数据根 resolver，也没有真实迁移备份/apply API。** M4 Bionic 固定账号路径、旧数据阻塞门禁继续生效。现有 `src/testing/legacy-migration-fixture.js` 仅能操作自己分配的根：备份固定在该根 backups/planId，保存原始 Hash、记录数、ID/Scope、mode/Windows SDDL；只读备份、临时版本、journal 与原子 pointer 已有，不重写引擎。

真实备份目的规划为 `<Owner-approved-backup-root>/<migration-id>/<rootId>/original/...`。现在未选择或创建真实目录。以后分别审批备份绝对位置、访问主体/加密、容量/卷、权限继承、保留期、恢复位置；备份许可不批准停进程或切换，停进程许可也不批准迁移。无权限、空间、链接或未知归属一律停止。

## 4. 本轮隔离备份/恢复验证

| 场景 | 证据与结果 |
| --- | --- |
| 备份目录/权限、Hash/记录数/ID/Scope | 复用原 Fixture 套件；Windows SDDL 实际采集、复制与对账，仅夹具根 |
| 备份后原文件改变、新文件出现 | 原套件 stale plan/beforeVerify 反例，拒绝提交和旧批准 |
| 备份失败 | 新 backup suite 在已分配夹具中用普通文件阻塞 backups 目录，真实 WRITE_FAILED；无 pointer 提交，原件保留，journal 恢复 ROLLED_BACK |
| 空间不足 | 原套件 statfs 及 ENOSPC 注入；不真实填满磁盘，不生成权威指针 |
| 恢复失败 | 新 suite 在已分配夹具中用目录阻塞 pointer 原子替换；WRITE_FAILED 后 journal 保持 ROLLING_BACK，原件不变；保留/恢复夹具指针证据后 recover 核验 COMMITTED，再按批准回滚 |
| 备份或目标损坏 | 原套件阻止不可信备份/目标回滚，不丢弃新记录 |
| 迁移中断/Journal 恢复 | 原套件六个子进程硬中断窗口；区分 pointer 前未提交与 pointer 后已提交；不重复导入 |
| 指针回滚 | 原套件及新增 suite 均 ROLLBACK_PASS；历史 ID/Scope/字节保留 |

恢复失败用例验证的是“不伪报回滚成功、保留可恢复证据”，不是证明生产系统能无条件自动修复。真实 ACL、真实目的目录写权限、真实备份/恢复及账号接续均未运行/未授权。

新增预检测试也验证空目录无副作用、死 PID 仍阻塞、损坏/未知 Schema/链接拒绝、隐私不输出，以及读取 in-flight Journal 不触发恢复写入。最终测试/提交统计见 `WHALEBRIDGE_M5_APPROVAL_READY_REPORT.md`。

当前探测环境无 WHALEBRIDGE_UI_AUTH_TOKEN，正式 IPC 要求目标进程环境中的 64 位十六进制认证值（src/app/ipc-runtime.js）；本轮不读取目标进程环境内存、不以 consoleToken 替代，不导出 Owner Token。因此认证只读健康查询保持 NOT_RUN_ENVIRONMENT，管道命名空间观察单独列证据。


本轮工具/测试/证据提交：`c10145fff3c3fa7bbf4768a777deba7b6220268f`。脱敏证据文件 SHA-256（当前工作树原字节）：`e00e328c4ce71c6f8939fe3a8baf8232a94875b04d5fbe5372c9059b4d2ec5eb`。最终文档提交由 Git 文件历史及交付答复记录。真实数据、Epoch、写入者未切换，等待 Owner 分组决定。
