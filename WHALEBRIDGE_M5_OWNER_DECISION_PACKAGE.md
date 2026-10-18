# WhaleBridge M5-A.2 — Owner 决策包

> 第 1–6 节保留 A1 的逐文件 Hash 和核验记录；**第 7 节是本轮 A2 的当前决策表和授权边界**，不继承任何未作出的 Owner 决定。A2 基线 c04ad381916147eca10eddac2edf5f8f23d0060e。

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


## 7. M5-A.2 当前决策表（所有选择均未作出）

真实写入、备份、停止进程、切换 writer 和启用 Epoch 的批准均为 0。READY_FOR_APPROVAL 只表示材料可供决定，不是 AUTHORIZED。原第 3 节给出 S01–S08 的完整来源 Hash；新证据 WHALEBRIDGE_M5_A2_EVIDENCE.json 已重新验证八项均未变化，没有新可靠机器人账号证据。候选账号均为 UNKNOWN（非空默认账号）。

### 7.1 八项 Social 分别决定

| 编号/数据类别 | 来源→拟目标 | 归属/脱敏摘要及关联 | 必须迁移？/只读兼容 | 游标/旧 writer/风险 | 备份恢复 | 当前状态 / Owner 动作 |
| --- | --- | --- | --- | --- | --- | --- |
| S01 Social 会话 | 340…/state/social-v2.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；3 会话；与两项 Session、卡片及黑话来源键部分关联 | 未定；可选择只读，须门禁 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S01；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S02 聊天 Session | 340…/state/sessions.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；2 个 Session 映射；不自动恢复认证/Follow | 未定；可只读保留原 ID | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S02；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S03 人设状态 | 340…/state/current-role.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；1 文档；角色资产引用存在，不证明账号 | 未定；可只读引用 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S03；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S04 黑话 | 340…/state/slang.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；63 稳定 ID；一个来源会话别名与 Social 匹配 | 未定；不默认跨账号共享 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S04；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S05 学习 Session | 340…/state/slang-session.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；1 文档；独立学习 Session，不证明聊天账号 | 未定；只读时不自动运行学习任务 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S05；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S06 贴纸 | 340…/state/stickers.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；40 稳定 ID；时间元数据不证明账号 | 未定；可只读保留，不按内容合并 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S06；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S07 卡片缓存 | 340…/state/social-v2-cards.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；1 会话；会话键部分关联，非 ACK/回执 | 可决定无需迁移；不自行删除 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S07；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |
| S08 空 Session 容器 | c12…/state/sessions.json → 已确认账号的 Bionic 分区（当前目标未绑定） | UNKNOWN；0 映射；无身份，不证明废弃 | 可决定无需迁移；空文件保持 | CURSOR_UNRECOVERABLE；Legacy-exclusive 停止未确认；凭据/重复副作用/Scope 风险 | B1/S08；原字节/ACL/ID/Scope；目标更新阻止自动回滚 | OWNER_REVIEW_REQUIRED；四选一，未选择 |

每项四选一：**确认可靠账号证据后计划迁移 / KEEP_LEGACY_READ_ONLY / 暂缓迁移 / MIGRATION_NOT_REQUIRED**。确认后计划也不是执行许可。选择只读需保证旧新写入者门禁后才生效；当前未切换 writer，因此 KEEP_LEGACY_READ_ONLY 已生效项为 0。无法逐记录证明账号/群归属时不可拆并为多个账号，也不能变为全局 Memory。

B1 为未创建的备份规划 `<Owner-approved-backup-root>/<migration-id>/<rootId>/original/<source>`；先单独批准备份位置/权限/加密/保留期并演练恢复。回滚需原来源/备份/目标 Hash、权限、ID/Scope 和停止/租约证明；新目标有新增数据或未知外发时停止自动回滚。

### 7.2 其他组与五类归档

| 数据/范围 | 来源和目标/归属 | 必须迁移/只读 | writer/游标/风险 | 备份恢复及 Owner 动作 | 当前分类 |
| --- | --- | --- | --- | --- | --- |
| Core 26 文件 | 原根原 Store；Core 权威 | 不迁移；保留正常现有服务 | Core；不受 QQ Epoch pointer 控制 | 未来迁移只做保护性校验；任何真实备份另批 | MIGRATION_NOT_REQUIRED |
| 配置 2 / Secret 引用 5 | 原位置；用户/Core，外部配置最终归用户 | 不迁移、不复制凭据 | Core/User；不能用 ownerQQ 推断机器人账号 | 不改写；备份中若纳入凭据须独立明确授权 | MIGRATION_NOT_REQUIRED |
| 诊断元数据 7 | 原 runtime；正文未读 | 不迁移/删除 | 原 writer；不能代替游标证据 | 如需正文追溯另定受限范围，不能批量暴露私人数据 | MIGRATION_NOT_REQUIRED |
| 角色资产 6 | 源码 roles，Repository/User | 是否账号复制未定，可保留引用 | 非 Social 账号证明 | 逐资产选择共享只读或之后批准账号复制，Hash 见原库存 | OWNER_REVIEW_REQUIRED |
| 兼容/未知 32 | 原位置；owner/目标 UNVERIFIED | 不批量迁移，保留原地 | 未知 writer/Schema/Scope 不接管 | 明确每个 fileId 所有权后再决定，不 force 合并 | OWNER_REVIEW_REQUIRED |
| DSH preset 3 树 | 用户原 DSH_HOME；Hash 见库存 | 不搬迁/覆盖 | 用户/DSH；原生 coding 兼容仍未验收 | 保持；如需变更另批，不与资料许可捆绑 | MIGRATION_NOT_REQUIRED |
| 两根 cursor / 新 Epoch 执行 | 340… / c12…；不补造旧记录 | 真实接续未授权 | 旧消费者/副作用/真实边界尚不确定 | 参见 Epoch 设计；设计批准和启用分开 | MIGRATION_BLOCKED |
| 真实 writer 切换 | 旧根→批准账号分区，resolver 尚未安装 | 真实迁移不能开始 | 无停止 ACK/跨用户租约完整证据 | 先生产兼容设计批准、独立停止证明、恢复证明 | MIGRATION_BLOCKED |
| Epoch/备份/最小 resolver 设计材料 | 文档及隔离模型，不操作真实文件 | 仅审阅设计 | 不授予 writer，不恢复外发 | Owner 可分别批准设计范围；必须另行批准真实动作 | READY_FOR_APPROVAL |
| 只读兼容处置 | 尚无 Owner 选择 | 可选，不默认生效 | 不把现有文件只读观察等同于停用 writer | Owner 按 S 编号选择并批准相应门禁；当前 0 项 | KEEP_LEGACY_READ_ONLY（可选处置，已选 0） |

86 项库存文件的当前处置计数：OWNER_REVIEW_REQUIRED 46（Social 8+角色 6+未知 32），MIGRATION_NOT_REQUIRED 40（Core 26+配置 2+Secret 5+诊断 7）。READY_FOR_APPROVAL 可执行数据 0，KEEP_LEGACY_READ_ONLY 已生效 0。MIGRATION_BLOCKED 是接续/切换门禁及候选执行状态，不额外增加文件计数；DSH 3 树另计。无需迁移不允许删除。

### 7.3 批准记录字段与停止

Owner 应逐项记录：决策编号、数据 fileId/rootId、选择、可靠账号证明、源 Hash/planId、拟目标、具体允许动作、备份/停止/迁移/Epoch 分别授权、审批者/时间/有效窗口、拒绝或暂缓原因。来源/目标/权限/租约或真实连接身份变化使旧批准失效。未填写的记录一律 UNDECIDED，不代选。

本轮 13 个不同自动化 suites 最终通过（含 Rust 2、Core/SEA 2），Core 构建通过且 SHA/Build 1081 未变；详细执行与局限见 WHALEBRIDGE_M5_APPROVAL_READY_REPORT.md。当前没有真实 QQ E2E、新生产 Epoch 激活或数据切换验收。

M5-A.2 在此收口；不自动新增 M5-A.x。只有 Owner 明确批准的数据组和动作才可进入后续 M5-B。其他组继续等待；不 push、合并 main 或发布 Stable。


本轮工具/测试/证据提交：`c10145fff3c3fa7bbf4768a777deba7b6220268f`。脱敏证据文件 SHA-256（当前工作树原字节）：`e00e328c4ce71c6f8939fe3a8baf8232a94875b04d5fbe5372c9059b4d2ec5eb`。最终文档提交由 Git 文件历史及交付答复记录。真实数据、Epoch、写入者未切换，等待 Owner 分组决定。
