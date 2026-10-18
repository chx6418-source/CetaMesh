# WhaleBridge M5-A.1 — Owner 决策包

## 1. 本次需要决定什么

本文件是待审材料，**不是迁移执行批准**。基线 `fda079e08ba65a2855d9706cbc2f68a4c6496ee8`，Build 1081。真实数据仍 **REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED**；M2_PARTIAL / M3_PARTIAL / M4_E2E_PENDING / RELEASE_BLOCKED 保持。

可供审阅的设计范围标 **READY_FOR_OWNER_APPROVAL**；这不表示任何真实文件已经具备迁移执行条件。**当前可直接执行真实迁移的数据组：0。** Owner 对某一组作出决定，不连带批准其他组、停进程、恢复外发或改写 DSH。

## 2. 来源根和目标边界

| 根别名 | 当前来源 | 当前/目标 writer | 目标 |
| --- | --- | --- | --- |
| c12a489fa781c9d2 | 当前用户 LOCALAPPDATA/WhaleBridge，安装版候选根；Core 锁有存活进程匹配 | Core Store 原地 Core；空旧 QQ Session 的旧 writer 为 Legacy，尚无停止 ACK | Core 不搬迁；旧 QQ Session 在账号确认前无可执行目标 |
| 3402041dd63077f1 | D:/GIT-QQ-BRIDGE，另一设计工作树，只读 | Legacy-exclusive → 批准账号分区下 Bionic | `<approved-dataRoot>/channel/qq/<verified-account>/bionic/state/…`，须生产 resolver/只读门禁先验收 |
| f595b99b0c257a0b | D:/GIT- CetaMesh/audit-critical-repair | 仓库/User 资产及原 Domain writer | Core/配置保留；共享角色资产先决定使用范围，不默认导入账号 |

以上位置不穷尽历史 portable/其他用户/进程覆盖目录。有效绝对 StateDir、account 及目标目录未绑定前，不能用模板目标作为执行路径。不得让 Bionic pointer 影响 Core Task/Memory/Workspace/Approval 的权威根。

## 3. 八项文件的独立决定

所有条目为 UNVERSIONED；本轮 Hash 与 M5-A 相同。records 单位如下，不能把会话/文档/库元素数相加冒充统一消息数量。账号映射均未证明。

| 编号 | 来源根 / state 文件 | records | SHA-256 | 迁移必要性 / 决定 |
| --- | --- | ---: | --- | --- |
| S01 | 340… / social-v2.json | 3 会话 | 5bc0b08880862498ecdd171b7202ab4c1f88b88f5ae3a07d1f6f64dad3c064e8 | 账号分区兼容候选；OWNER_REVIEW_REQUIRED |
| S02 | 340… / sessions.json | 2 映射 | e7e2a1134353f3ff7cd0dc4e6fcf9e3fb699f48e20b144be9823e44ce80ca465 | 保留原 Session/Scope，但不自动恢复认证/Follow；OWNER_REVIEW_REQUIRED |
| S03 | 340… / current-role.json | 1 文档 | 9267509a51e2f83a543a228a211fffbb7ec484787534c882a6082975291798e1 | 引用资产存在，账号未证明；OWNER_REVIEW_REQUIRED |
| S04 | 340… / slang.json | 63 条 | 0eb65b6c8fe5d177d79385c83e6c82d85e485b54e28614bf16f248a0ee54bf54 | 保留 ID 与来源 Scope，不默认跨账号分享；OWNER_REVIEW_REQUIRED |
| S05 | 340… / slang-session.json | 1 文档 | add8da1b7d7703d10198aa1edea02c590465cbb0611751257525591196b75309 | 学习 Session 独立隔离；OWNER_REVIEW_REQUIRED |
| S06 | 340… / stickers.json | 40 条 | bc3ea2dc5556fcb4d80a86921f0a78a29e11463a32d94f1484449e31be50106a | 保留 ID/关联，不能按内容跨账号合并；OWNER_REVIEW_REQUIRED |
| S07 | 340… / social-v2-cards.json | 1 会话 | d19987a64832fa63c0674e5141ae49eff4865b4542486b2e4ac85d685b2e2a9c | 缓存只可作为兼容资料，不是 ACK；是否迁移由 Owner 决定，不自行删除；OWNER_REVIEW_REQUIRED |
| S08 | c12… / sessions.json | 0 映射 | f833453cf2b1962c1a4bd1b0e8ae42cbe594446ec6ab233d14428c6d6e8a4313 | 空文件保留原地；决定是否需要未来兼容处理，不能现在删；OWNER_REVIEW_REQUIRED |

每个 S 编号分别需 Owner 提供/选择：①可靠账号证据与 Scope；②保留原地、只读兼容、或将来批准复制到单一账号；③具体目标与旧 writer 停止窗口；④是否允许恢复原生 Session（默认否）；⑤备份目的和权限。任一未知项不能自动转成批准。若多账号共用旧库且无逐记录归属，保持隔离，不复制为多个可写权威库。

这 8 个文件共 932,568 bytes，仅估算三份字节副本为 2,797,704 bytes；不是实际所需磁盘空间承诺。ACL/目录元数据、journal、其他批准资产、新写入和安全余量必须另计。潜在会话 Token/私人资料使备份本身也必须受保护。

## 4. 其他数据组、Hash 与所需动作

组 Hash 是按当前脱敏台账顺序对 `{fileId,hash,records,version}` 数组计算 SHA-256；不是把多文件原字节拼接的文件 Hash。逐文件完整计数/Schema/Hash 见新 Dry Run JSON；日志 hash=NOT_READ_DIAGNOSTIC，组 Hash 不证明日志正文内容。

| 组 | 文件数 | manifest SHA-256 | 目标 / 迁移必要性 / 状态 |
| --- | ---: | --- | --- |
| Core 权威 Store | 26 | 6872cd7ca0cd9430231b4cff0f69843ea26829b06e4402cea34cdb6ba195a1ca | 原位置、Core 单 writer；MIGRATION_NOT_REQUIRED |
| 用户/Core 配置引用 | 2 | 9a01decfc6a78e2aa1e7ab45a04fd83008dadd6901bfb08528875baae53ca258 | 保持原位置，Connector 只取受控引用；MIGRATION_NOT_REQUIRED |
| Secret references | 5 | e85a85cd0e8aef28769ec687409eb180267c4bbb35220830055ac64ad61a73d1 | NEVER_IMPORT，用户/Core 所有，不输出值；MIGRATION_NOT_REQUIRED |
| 源码角色资产 | 6 | 96382f18cbd6743f5eba637e43cc3812b629719ee451aedc1ff78997a5681680 | Repository/User，兼容引用还是账号复制待逐项决定；OWNER_REVIEW_REQUIRED |
| 兼容/未知 | 32 | 23a5886654afec6ef44c408465a44f000b688f91d9fe262443e4b3f8ac52252e | 保持原地，当前/目标 owner 未证明；不能批量迁移；OWNER_REVIEW_REQUIRED |
| 诊断元数据 | 7 | eef4a3ee8ca0ddf77300b13dbe160864554186b779b879025db5cbc67b062377 | 原 runtime，日志正文未读，保持原地；MIGRATION_NOT_REQUIRED |
| Social S01–S08 | 8 | 4d5e3a3c69bff3288b6849a22bcc6968df21676db3448cc5c5f79643e1291fdd | 账号/游标/writer 关闭前 MIGRATION_BLOCKED；归属 OWNER_REVIEW_REQUIRED |

DSH 的 3 个 preset 是单独的树库存：逐树 Hash/manifestHash 见旧库存及新 Dry Run presets 数组（本轮相同）。用户最终所有权；1 项 attribution UNVERIFIED、2 项 APP_OWNED_UNCHANGED 但缺 persona prefix；静态检查不能证明真实 coding Session 兼容。**MIGRATION_NOT_REQUIRED**（不覆盖/搬迁）；原生兼容 **NOT_RUN_ENVIRONMENT**，若需修复 preset 另行批准。

QQ receipts/send-ledger 在两个旧来源根未发现，因此不是一个可批准“迁移 0 条”的组；它们是缺证据导致的 **MIGRATION_BLOCKED**。现有 M4 账本/Channel 权威职责保持，不另建账本。Social 转 Core 长期 Memory 不属于这次迁移，默认不做，不能靠审批账号映射连带授权。

## 5. 备份、回滚和审批拆分

仅提出路径规划，不创建目录：`<Owner-approved-backup-root>/<migration-id>/<rootId>/original/…`，旁置权限清单和 journal；临时目标为批准 resolver 能识别的未激活版本。必须先决定绝对备份根、数据保护/加密、访问主体、保留期、同卷切换条件、空间余量和恢复位置。不能把备份写到未知云同步目录或自行复用其他账号目录。

| 决策编号 | 可审批内容 | 当前状态 | 未被连带批准的动作 |
| --- | --- | --- | --- |
| D01 | 审阅 S01–S08 的逐文件归属及补充历史来源 | OWNER_REVIEW_REQUIRED | 不复制、不合并、不删除；没有“全部映射默认账号”选项 |
| D02 | 审阅缺游标时历史隔离 + 新实时 epoch 的设计取舍 | READY_FOR_OWNER_APPROVAL（仅设计选择） | 不补造旧游标、不重放、不恢复外发；生产实现仍待批准 |
| D03 | 明确历史 portable、有效绝对 StateDir、普通/提升/其他用户环境和 writer 停止窗口 | OWNER_REVIEW_REQUIRED | 不停现有 Core/网关/DSH，不回收真实锁；未知环境 NOT_RUN_ENVIRONMENT |
| D04 | 审阅备份保护、存放/保留及恢复方案模板 | READY_FOR_OWNER_APPROVAL（仅方案） | 没有选定真实绝对目的根，不执行真实备份写入 |
| D05 | M5-B 最小生产 resolver、版本兼容、Legacy 只读门禁及恢复实现范围 | READY_FOR_OWNER_APPROVAL（仅设计范围） | Fixture pointer 不得直接用于正式根；本轮未实施 |
| D06 | 将来绑定具体 planId、账号/文件/目标/Hash/时间窗的真实执行批准 | MIGRATION_BLOCKED | 当前任何其他决定均不能视为 D06；不得批准未知来源整目录 |
| D07 | 原生 DSH coding / QQ E2E 与跨用户 ACL/租约验收 | NOT_RUN_ENVIRONMENT | 自动化 Fixture 不等同于真实验收，不关闭发布阻塞 |

回滚条件：停止新旧 writers、持有有效协调/数据/账号租约、校验原字节与 ACL、只读备份、完整 pointer/journal 和目标；新目标若未产生新写入，才可按已批准快照切回旧权威。新 writer 已更新目标或外发结果未知时自动回滚停止，另做增量对账；不能丢新记录或“撤销”已经发送的消息。旧 writer 恢复也须单独确认新消费者停止。未提交残片保留证据，不能清空后伪装首次迁移。

批准必须绑定：执行者、真实绝对来源/目标/备份根、rootId/账号映射、逐文件 Hash/记录数/ID/Scope、planId、写入者/停止证明、允许动作、禁用自动外发/Session 恢复策略、有效期、失败/回滚窗口。任一来源/目标/权限/运行身份变化都使批准失效。不能用 Fixture 自签 proof 替代 Core Approval。

## 6. 本轮验证和证据

重新运行相同真实 Dry Run 两次，planId 均为 `7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e`，与 M5-A 相同。8 个候选 Hash 均未变；原阻塞仍为账号 8、缺游标 2、停止未确认 2。聚合器中隔离 Fixture 改变/增加来源时验证新 planId、拒绝旧计划/旧批准，且唯一 writer、历史 ID 与 Scope 保持。

| 验证 | 本轮实际结果 |
| --- | --- |
| npm test -- --suite test-whalebridge-m5-dry-run --suite test-whalebridge-m5-fixture | 2 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT；DRY_RUN_PASS / FIXTURE_MIGRATION_PASS / ROLLBACK_PASS |
| npm test -- --suite test-app-paths --suite test-core-entry --suite test-qq-runtime | 3 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT；0.1s / 10.6s / 1.6s |
| 真实账号接续/迁移/恢复外发 | REAL_DATA_NOT_AUTHORIZED；未执行 |
| 跨用户/提升环境、真实 QQ/DSH 协议 | NOT_RUN_ENVIRONMENT；没有以 Fixture 代替 |
| 产品 Build、安装包和全构建 | 无产品修改，Build 1081 不变；本轮未重新构建或生成安装包，不给旧包绑定新 sourceCommit |

详细核查范围、真实 writer 快照和游标语义见 `WHALEBRIDGE_M5_PRE_MIGRATION_BLOCKERS.md`。本轮证据提交：`13f1dfc347fef81236a5e9d66613c50957f49109`；最终文档提交包含本包，Git 文件历史可定位其确切 SHA。本轮完成后停止，等待 Owner 按 D01–D07 分别作出决定；不 push、不合并 main、不发布 Stable。


### 交付证据校验

只读证据文件 SHA-256（当前工作树原字节）：`7008891d9344777a8ff7aab43b13c6cd3eae5932bcdf726c8c0d1232782b24f4`；新 Dry Run JSON：`81184498adf3e76d6851289ea8471d3ef50fa502c5e1b76fc835c520010d6120`。这些是证据文件 Hash，不是安装包 Hash；本轮没有生成新安装包。最终回查真实 planId/八项 Social Hash 均未变化，Fixture 工作树残留为 0。

本轮仅 5 个定向 npm suites：5 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT。真实环境的 NOT_RUN_ENVIRONMENT 是单独的验收状态，不混入这 5 个自动化统计。证据快照提交 `13f1dfc347fef81236a5e9d66613c50957f49109`；最终报告 HEAD 取 `git log -1 --format=%H -- WHALEBRIDGE_M5_OWNER_DECISION_PACKAGE.md`，确切值随最终答复交付，避免在提交内容内自引用其尚未生成的 SHA。
