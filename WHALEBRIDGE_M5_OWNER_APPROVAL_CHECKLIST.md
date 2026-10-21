# WhaleBridge M5-B — Owner 独立批准清单

本清单是待审阅条件，**不是执行批准**。M5-A 工具提交：`4eb5887734d237a49e78e525e9947466ed678d10`。当前真实数据为 **REAL_DATA_NOT_AUTHORIZED / BLOCKED**；发布仍 **RELEASE_BLOCKED**。

## A. 必须先确认的真实来源

- [ ] Owner 核对三个已发现来源及所有额外 CLI/env/portable/自定义路径；确认运行进程实际继承的 DataDir/DSH_HOME，而非只接受默认路径推导。
- [ ] 为每个旧 Social 文件、QQ Session、人设及库提供可证明的机器人账号归属；ownerQQ、网关 URL 或相同群 ID 不能替代账号证据。
- [ ] 核对不同账号相同群号、不同群和不同用户的 Session/记忆/偏好来源；不默认合并，无法证明 Scope 时停止。
- [ ] 逐项决定未归属账号的 8 个候选文件，以及 6 项仓库人设资产；空 sessions 文件也不得未经批准删除。
- [ ] 解释两个来源根缺失游标的原因；取得足够的历史回执/消费者/未完成请求证据。不能创建空游标替代核验。
- [ ] 复核所有 outcome-unknown、in-flight、pending delivery、未完成 Task/Approval 及不可逆外发。未知请求不能因迁移自动重发。
- [ ] 保留 DSH/QQ Session ID 和原关联，但不得自动恢复旧 Follow、bootstrap 或未完成回合；旧 Social 文件可能含会话 Token。单独审阅凭据引用/失效/重新绑定方案，不能把字节复制等同于恢复认证或授权。

## B. 要批准的是具体计划

- [ ] 重新运行 Dry Run，核对最新 planId、逐文件来源 Hash/计数/Schema、目标映射、唯一 writer、冲突、空间估算和受影响数据。
- [ ] 来源或目标任何变化时重新计划、重新批准；不得复用本次库存快照作为未来切换凭据。
- [ ] 将真实迁移授权绑定具体 root IDs、文件清单、planId、账号映射、执行窗口、迁移/回滚动作及失效条件；接入既有 Core Approval，禁止复制 Fixture 自签 proof 为生产授权。
- [ ] 对未知 Schema、未知文件及已有目标作出显式决定；未经审阅保留原地，不能 force 合并。
- [ ] DSH preset 保持用户最终所有权；本次 1 项归属 UNVERIFIED、2 项整树匹配旧安装记录但缺 persona prefix。原生兼容仍 UNVERIFIED，单独决定后续兼容验证，不自动修复或覆盖。

## C. M5-B 尚需实施并验收的代码边界

- [ ] Owner 审阅生产 Bionic 数据根 resolver 与 pointer Schema/账号限制；当前只有 Fixture pointer，正式运行时仍使用 M4 固定路径和旧数据门禁。
- [ ] Owner 审阅 Legacy 只读兼容策略与兼容版本期限。旧可写 Bridge/旧二进制未确认停用前不得切换，不能仅写标记文件就认定旧循环已停止。
- [ ] 实际停止旧新 QQ/Bionic 和相关 Core 写入者并取得进程启动身份、账号/网关/StateDir 租约及停止 ACK；失联、PID 不可信或锁损坏时拒绝接管。
- [ ] 明确 Core Task/Memory/Workspace/Approval 不迁移、不创建第二 Store；Social 不自动转为长期 Memory，单独授权和 Scope 验证仍必需。
- [ ] 用户独立运行的 QQ 网关、SnowLuma、DSH 不作为迁移器可杀进程；必要手工操作由 Owner 决定。

## D. 备份和回滚实际证明

- [ ] 单独批准真实备份目的、加密/访问权限和保留期限；采集真实文件/目录 ACL、owner、继承、只读属性和卷信息，不将 Fixture 的 SDDL 当作真实证据。
- [ ] 验证备份 Hash、记录数、ID、Scope、原始权限及可恢复性；确认剩余空间、写权限、同卷原子 pointer 条件和空间不足时的保存策略。
- [ ] 验证新旧版本并存的真实只读行为、版本 pointer/manifest 一致性、每个崩溃窗口、重复执行和不可恢复状态的阻塞入口。
- [ ] 确认回滚窗口：新 writer 尚未改变目标时可按快照回滚；目标已更新时自动回滚必须停止，另做增量资料恢复设计，不能丢新记录。
- [ ] 备份、journal、旧目录及未激活版本的清理是另一个明确批准动作；本轮不清理真实数据。
- [ ] 卸载 Connector 后资料保持，旧安装包/兼容入口及恢复说明可用；M6 真实安装/卸载验收不因 Fixture 模拟而关闭。

## E. 允许与不允许的下一步

可先审阅本轮四份报告、脱敏 JSON 台账和 Fixture 代码，要求补充只读库存或隔离测试。只有 Owner 另行明确批准 M5-B 的具体设计与范围后，才能实施真实迁移入口；真实数据写入和切换仍须绑定实际最新计划及执行窗口。

M2_PARTIAL、M3_PARTIAL、M4_E2E_PENDING 与真实 QQ/DSH 环境验收独立保留。不得 push、合并 main 或发布 Stable；本清单没有授予任何这些权限。


## M5-A.1 当前补充（2026-10-18）

基线 `fda079e08ba65a2855d9706cbc2f68a4c6496ee8`；本段补充原 M5-A 历史记录，不替换其测试日期/统计。新鲜只读核查见 `WHALEBRIDGE_M5_PRE_MIGRATION_BLOCKERS.md`，分组待决动作见 `WHALEBRIDGE_M5_OWNER_DECISION_PACKAGE.md`；新快照为 `WHALEBRIDGE_M5_A1_READ_ONLY_EVIDENCE.json` 和 `WHALEBRIDGE_M5_A1_DRY_RUN_EVIDENCE.json`。

- 8 项 Social Hash 全部与 M5-A 一致；群/Session/人设关联不足以证明机器人账号，可靠账号映射新增 0 项，全部 OWNER_REVIEW_REQUIRED。不得转全局 Memory。
- 两个缺游标根在声明来源的 state/channel/backups/backup/data 检查内无可恢复 QQ 回执/发送账本，标 CURSOR_UNRECOVERABLE（限定于已检查范围），真实迁移 MIGRATION_BLOCKED。Social 局部序号/消息 ID 不替代消费 ACK。历史隔离、新实时 epoch 只是待批设计，不补造旧 cursor 或自动重放。
- 安装版 StateDir 锁 PID 与存活 Core Worker 对应；原源码 Bridge 锁 PID 当前不存在，但无停止 ACK/完整消费者证明。真实锁未回收。历史 portable 根未定位，普通/提升/其他用户运行环境及目标进程环境未完整验证；不得据当前 shell 或无锁推定安全接管。
- 连续两次 Dry Run 及测试结束后再次核验 planId 均为 `7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e`，原 86 项/3 个 preset 和 12 项阻塞不变。没有改真实文件来制造失效反例；旧计划失效在 Fixture 验证。
- 本轮实际 `npm test -- --suite test-whalebridge-m5-dry-run --suite test-whalebridge-m5-fixture`：2 PASS / 0 FAIL；`npm test -- --suite test-app-paths --suite test-core-entry --suite test-qq-runtime`：3 PASS / 0 FAIL。共 5 个定向 suites，DRY_RUN_PASS / FIXTURE_MIGRATION_PASS / ROLLBACK_PASS。原全量 npm/Rust/构建统计为历史证据，本轮无产品修改，不重新构建；Build 1081 保持。
- 当前没有可直接执行真实迁移的数据组。真实备份位置、账号归属、writer 停止、生产 resolver/Legacy 只读门禁及具体计划批准仍缺；设计待审不等于批准执行。REAL_DATA_NOT_AUTHORIZED / RELEASE_BLOCKED 保持；完成材料后停止等待 Owner 分范围决定。

M5-A.1 只读证据提交：`13f1dfc347fef81236a5e9d66613c50957f49109`；最终文档 HEAD 随交付答复记录。
