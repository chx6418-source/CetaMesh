# WhaleBridge M5-A — Legacy 数据库存

基线：e70a3de70d002d10d744c27a4fa0e7d3c6e95a4c；分支 codex/whalebridge-m5-a-dry-run。真实数据只读，REAL_DATA_NOT_AUTHORIZED / RELEASE_BLOCKED。

## 来源发现与范围

| Root ID | 本次已知来源 | 证据与限制 |
| --- | --- | --- |
| c12a489fa781c9d2 | `%LOCALAPPDATA%/WhaleBridge` | 由正在运行的已安装 CetaMesh 可执行路径及 createAppPaths 打包规则推导；目录实际存在。没有读取目标进程环境块，不能据此宣称所有进程均使用此根。 |
| f595b99b0c257a0b | `D:/GIT- CetaMesh/audit-critical-repair` | 当前源码工作树默认根；仓库 roles 与用户 roles 共用布局，作为 source-role-asset 保留复核。 |
| 3402041dd63077f1 | `D:/GIT-QQ-BRIDGE` | Owner 提供的原源码目录；只读，不改其设计分支的既有未提交修改。 |

实际路径解析复用 src/app-paths.js：--data-dir > WHALEBRIDGE_DATA_DIR > portable.flag/data > LOCALAPPDATA（源码模式回源码根）；resourceRoot 独立；DSH 优先 config.dsh.homeDir，再 DSH_HOME，再用户 .dsh。不得把 ownerQQ 当成机器人 accountId。外部进程的继承环境、未声明历史便携目录仍为 UNVERIFIED，需要 Owner 补全来源清单。

本次 86 个文件元数据项、3 个 DSH preset 树；计划 ID：7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e。连续两次实际扫描的 planId 相同。

## 唯一数据所有权

| 数据 | 当前 / 目标唯一 writer | 迁移必要性 |
| --- | --- | --- |
| Task / Memory / Workspace / Approval / Continuity / Chat | Core → Core | 保留原 Store、ID/rev/Scope；不搬迁、不重复构建 Store。 |
| QQ 账号 / 网关配置引用、游标、收发账本 | 互斥的 QQ Runtime → QQ Connector | M4 路径兼容，保持原位置和原账本，不清空；外部凭据最终归用户。 |
| Social / Session / 黑话 / 贴纸 / 成员印象 / 卡片 | Legacy-exclusive → Bionic（账号归属批准后） | 旧未分账号资料是迁移候选；不自动映射账号或合并群。 |
| Social → Core 长期 Memory | Bionic 原资料保留，Core Memory 经授权纳入 | 不属于本轮迁移；不得自动导入，原只读 QQ adapter 不是导入授权。 |
| DSH 自定义 preset / 外部应用配置 | 用户/DSH | 永不自动覆盖；manifest 哈希匹配也不是本轮写许可。 |
| 人设模板 / 日志 / 未知文件 | Repository/User 或原 runtime；未知继续 UNVERIFIED | 不自动导入；不读取诊断日志正文，不删除缓存或旧目录。 |

## 逐文件库存

路径中的动态文件名、账号和用户标识使用稳定散列别名。完整 fileId、权限摘要、identityHash 与阻塞关联见 WHALEBRIDGE_M5_DRY_RUN_EVIDENCE.json。records 对 Social/Session 为会话/映射数，对数组为元素数，对单对象为文档数；不把 null 当作零。日志仅列元数据，hash=NOT_READ_DIAGNOSTIC，不代表已经读取或校验其内容。

| Root | 来源（脱敏相对路径） | 数据类型 / Schema | records | SHA-256 | 当前 writer → 目标 writer | 迁移/兼容动作及冲突 |
| --- | --- | --- | ---: | --- | --- | --- |
| c12a489fa781c9d2 | state/[entry-eb47b9ce4840] | secret-reference-only / OPAQUE_BYTES | 1 | 93efabb1a178982e2e0e9aaa2ab5ced588056e05a17ae215800e32bedc918b1e | User/Core → User/Core | NEVER_IMPORT; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/sessions.json | core-authoritative / 1 | 7 | f08beabc78810f95d2e7b7c5a7909793170699a862a8007f1d115902ee8a993e | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-d30ca7a7a32b]/[entry-4c5b4cace470] | compatibility-or-unknown / 2 | 1 | ce4d55fd0621900ac64b663c817faeb74c0b9d0413ee9ddeedcdff0f596dcdbf | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/tasks/tasks.json | core-authoritative / 1 | 7 | 2f58c23b476940b38371c99800e9498d014decf42485a9bce784c5aa541ec54f | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-27944708e393] | core-authoritative / UNVERSIONED | 1 | af27cca1d37d98dbf846bf090b617a256f404d7a434b32f9b97c4ee2ba15c8b3 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-c69734f920e3] | compatibility-or-unknown / OPAQUE_BYTES | 1 | e2b5e6801b4baf61704a96236848979bce551ef2414a3ce6252c5f90e527aea1 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| f595b99b0c257a0b | roles/[entry-54cbb007de74] | source-role-asset / OPAQUE_BYTES | 1 | 5a012400077cd89de0d8edb0109c3c447b19a9bfcde016ccc110ee51292e3ee7 | Repository/User (shared source layout) → User | PRESERVE_ASSET_REVIEW_REQUIRED; 无该项确定冲突；不等于真实迁移获批 |
| 3402041dd63077f1 | state/[entry-eb47b9ce4840] | secret-reference-only / OPAQUE_BYTES | 1 | 628c2daac240dcc87772b53fb7e6fd20bf29a359990702876800d8f415b3dfdf | User/Core → User/Core | NEVER_IMPORT; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-d30ca7a7a32b]/[entry-5000781e3caf] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 5e0e5bb4e7859d672c43b646df6971c429f865d7733d15cdce0f905d33fc20de | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-6b9c3d6aab0f] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 2bdd0ee466a87e177151863aa285ec6b0b377a685343a921959f53852d4cb0cd | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cde0fb0dec14]/settings.json | core-authoritative / 1 | 1 | ba850ff1f906e61e777922fd0a80ef4c146dc45dc2ee28b1aa34d27995e39796 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-bf7e3819ddd6] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/capability/[entry-c29bc7c0cb7d] | core-authoritative / UNVERSIONED | 1 | b07650d2ceb3b21d55c63c274c329272ad433138bf45b9adeebfe961c1ee6728 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/integrations/plugins.json | core-authoritative / 1 | 1 | cfe81aee76f68ebbc8376a2d3219a66cfa70c581bdc242fdc900e8815c2cc202 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| f595b99b0c257a0b | roles/[entry-b33563055168] | source-role-asset / OPAQUE_BYTES | 1 | b415422aa282898eda796e7994b3414f827b2cb63ecc6c4a3b801639dca8a4ae | Repository/User (shared source layout) → User | PRESERVE_ASSET_REVIEW_REQUIRED; 无该项确定冲突；不等于真实迁移获批 |
| 3402041dd63077f1 | state/[entry-bc7c55a37ffb] | secret-reference-only / OPAQUE_BYTES | 1 | 67d8f7537e2ebf2457164bad8d37d9e08f35210ab51c54844468177332e67472 | User/Core → User/Core | NEVER_IMPORT; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-08513b5c2266] | core-authoritative / UNVERSIONED | 1 | 00df34d936f6c9960eeb2d6b2fe0d79a1aec318ff49063e91ebead54ea932fce | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/social-v2-cards.json | bionic-legacy / UNVERSIONED | 1 | d19987a64832fa63c0674e5141ae49eff4865b4542486b2e4ac85d685b2e2a9c | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-7055666b7811] | compatibility-or-unknown / OPAQUE_BYTES | 1 | c6f7f52ed149e045222b2cce531bcc41847299993df921bd3bd43f89b788ac9e | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-a7f017c7f495] | core-authoritative / 1 | 1 | 5db17dcd0354f964be14367d9f6142d6cf906e109691c35b22b9f933c41957f7 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-e3e943a2e993] | core-authoritative / UNVERSIONED | 1 | ddae3ae736688dc216264af71a231850494630fa8c69000184849addbbacd0aa | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-91756107052d] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 456e2bfddebca7f83cba21f9780b2808014b92b91d8420c33e4098f56908593a | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-551e27c8c068]/[entry-797fa345bff0] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 608d382e8b142b600ce3728edcd1c9b8ee35bc1c9069fb930fd4ddc4979a5757 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/workspaces.json | core-authoritative / 1 | 3 | a3ada79006c5d5106b5f638eaca030db74e3f51ff76b17a32ef2571384d8390c | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| f595b99b0c257a0b | state/[entry-d30ca7a7a32b]/[entry-5000781e3caf] | compatibility-or-unknown / OPAQUE_BYTES | 1 | ce3ac3ca278b8a6fb2f757a3e8830e54196b3172e33034e9d8a65d59098fd00f | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; 无该项确定冲突；不等于真实迁移获批 |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-82646818c12d] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 30277887c559fcc6968a299b8f622e1058c51a8b8c954eef3eb7cb54d9a69ff7 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-30ce3882b14c] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 7eb744e3b367201a7e2dd5f18a3a3d213b563b14ad3159ac0951859ba33253b2 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-551e27c8c068]/[entry-75d728e94787] | compatibility-or-unknown / OPAQUE_BYTES | 1 | f23ba964bf150db6fbeee4c4de766bafe05bf2de6d7817dc4dd7b6330eccd3ad | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-81dc075c3d55]/[entry-00d50069da85] | core-authoritative / UNVERSIONED | 1 | 89104b320a5f1e1c1b9e21df1d4ba636d966ba05b08431e9b5e0284b53478eaa | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | roles/[entry-b73befa2706c] | source-role-asset / OPAQUE_BYTES | 1 | 12d09202a2921934e6149ac469b16b27f7d78daee6acc535e538c6cc66732526 | Repository/User (shared source layout) → User | PRESERVE_ASSET_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-05228a192569] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/capability/approvals.json | core-authoritative / UNVERSIONED | 16 | 52c7dba005cd13448d7af0bd5ac23c44583736850452d7bf80dc6f0a9acc5b74 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | config.json | config-references / UNVERSIONED | 1 | afa8179c51d36d16a48a1701bc895005e7fca63eff32abfc9b79bd4563b23e7a | Core/User → Core/User;Connector references only | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/current-role.json | bionic-legacy / UNVERSIONED | 1 | 9267509a51e2f83a543a228a211fffbb7ec484787534c882a6082975291798e1 | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | config.json | config-references / UNVERSIONED | 1 | ebf4b2f6fcbd2f559a6a43bbd93774ecdad8ee3a90030f4373950bfb6b9d1ff3 | Core/User → Core/User;Connector references only | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-462ee45538e0] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 55364692b0a4d9c75a8e3ca22aa23fe966ce54d6b437245cb528d77ed76aa39f | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-bf7e3819ddd6] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| f595b99b0c257a0b | roles/[entry-b73befa2706c] | source-role-asset / OPAQUE_BYTES | 1 | 0139577b299e549d3fa4e04aaa701a87f5b58fad044b437db8969fad2e60b708 | Repository/User (shared source layout) → User | PRESERVE_ASSET_REVIEW_REQUIRED; 无该项确定冲突；不等于真实迁移获批 |
| c12a489fa781c9d2 | state/[entry-9372c470eead]/[entry-b3bc1d66cac5] | compatibility-or-unknown / UNVERSIONED | 1 | 63b257d7315b12efbdd80092ffb03050b9de1983e3bb2d68c001f50711bcdad3 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-6bfaf6c43926] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 7faf4a232d44c2f58b6dfaaccddb376c937765e1d47b5328b3df63468b1d50f3 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/memory/memories.json | core-authoritative / 1 | 1 | 0edc54ecc4484b98e3de1f926b984deba4b61a850f9a7e3f7fd87f4c0ac2dd08 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| f595b99b0c257a0b | state/[entry-d30ca7a7a32b]/[entry-4c5b4cace470] | compatibility-or-unknown / 2 | 1 | 3963c9e4518c28ab5a83a4154a5ac160ca2e2a3071f4258a7155d455ff48b87e | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; 无该项确定冲突；不等于真实迁移获批 |
| 3402041dd63077f1 | roles/[entry-b33563055168] | source-role-asset / OPAQUE_BYTES | 1 | e2b3a5fd98d0162723319ec1560e966f814cb5de82f1f06ef437ea5abc53304c | Repository/User (shared source layout) → User | PRESERVE_ASSET_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-26ba1963eeb7] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-1fad4fba4bda] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-276851261c03] | core-authoritative / UNVERSIONED | 1 | 8e9ea9fe5dc2aac16e7e1f73947e33ef9e4597336e7e4ed689bce2b1c32a3380 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-d44446ff7270] | core-authoritative / 1 | 1 | c2fdd90254546f2ee4a0404ac9ca239cd68b1a5075cb33bd434a008e05c45421 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/capability/[entry-9c094306bc0f] | core-authoritative / UNVERSIONED | 1 | 3c84dbbdd9651a0dd940d8ae358c0fc66a0f77bbcc2e1e2c4fb73fc7a98ff680 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/mode.json | compatibility-or-unknown / UNVERSIONED | 1 | e410b84efdbc70778d36ebd4a783ca0888ecf2b8c2a31777afefa26dbf79517c | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/slang.json | bionic-legacy / UNVERSIONED | 63 | 0eb65b6c8fe5d177d79385c83e6c82d85e485b54e28614bf16f248a0ee54bf54 | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/sessions.json | bionic-legacy / UNVERSIONED | 0 | f833453cf2b1962c1a4bd1b0e8ae42cbe594446ec6ab233d14428c6d6e8a4313 | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-cf2e0a26e705] | core-authoritative / 1 | 1 | 825622282dd5cbee076e54608637216daf84eedb5b273b7ce199271ae6c43992 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-773ca0d3af78] | compatibility-or-unknown / OPAQUE_BYTES | 1 | ba55a8ffe585ee0cc54f7bfedb63f2c07e116d5542c87009295779c2583dd32c | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | roles/[entry-54cbb007de74] | source-role-asset / OPAQUE_BYTES | 1 | 7b9e5b5ab087b4d0147fc824718671509f7db2986b58009073404696960c4855 | Repository/User (shared source layout) → User | PRESERVE_ASSET_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/state/[entry-71a4a6dda069] | compatibility-or-unknown / 1 | 1 | 97ad8825d3745f71117f5b18537b617e6065c6c5057ed8049f5639a9a6e65e3e | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-79e932d38b45] | core-authoritative / UNVERSIONED | 1 | 4cfefcd0c02d174c0c85a4923ba1563cb76c09da13c8fa08708645d84a0e0cc3 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-d96da7d43658] | core-authoritative / UNVERSIONED | 1 | 68b509e22c5e03c1d45d68dbe0eb3dbaa10c8a2dffca1806f97d2835dabeeed5 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-bc7c55a37ffb] | secret-reference-only / OPAQUE_BYTES | 1 | a148e6ffcf5ab9e8d68e85bd8343d6e253a410f77f0e2f4c212489efe334bcd6 | User/Core → User/Core | NEVER_IMPORT; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-dd62a14b4a1f] | compatibility-or-unknown / OPAQUE_BYTES | 1 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-f9c3738e18dc] | core-authoritative / 1 | 1 | dbc39da829448b72de367d2f2bc60896397502eb816992961c26cc67c08a84c2 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-fb7b7c81f217] | core-authoritative / 2 | 1 | ff0b324fe57724894b88f6f050c0d9720f45bcbf36ed6f7ad1093671dcae75a8 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/stickers.json | bionic-legacy / UNVERSIONED | 40 | bc3ea2dc5556fcb4d80a86921f0a78a29e11463a32d94f1484449e31be50106a | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-dd5f0d172472] | compatibility-or-unknown / 2 | 1 | 1828250c9ebe34e036c3505b755abb9abb0175d4eabe3df9e51a37c46e7aab6c | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/slang-session.json | bionic-legacy / UNVERSIONED | 1 | add8da1b7d7703d10198aa1edea02c590465cbb0611751257525591196b75309 | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/social-v2.json | bionic-legacy / UNVERSIONED | 3 | 5bc0b08880862498ecdd171b7202ab4c1f88b88f5ae3a07d1f6f64dad3c064e8 | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-9372c470eead]/[entry-5ddea37495e5] | compatibility-or-unknown / UNVERSIONED | 1 | 1a767718cb74a1a3129b16927bb3952f5361e1519e185545a3b8a2861861d420 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/mode.json | compatibility-or-unknown / UNVERSIONED | 1 | 351b595ccf425cab1af9e8d06b5fee15faa8cb4288763705d2361311492b9be2 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-75451d9818da] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-ba915a0a68b7] | compatibility-or-unknown / UNVERSIONED | 0 | 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/sessions.json | bionic-legacy / UNVERSIONED | 2 | e7e2a1134353f3ff7cd0dc4e6fcf9e3fb699f48e20b144be9823e44ce80ca465 | Legacy-exclusive → Bionic | ACCOUNT_SCOPED_COPY_PROPOSAL; ACCOUNT_ATTRIBUTION_REQUIRED, CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-6319f058ef2d] | compatibility-or-unknown / 1 | 1 | 4259a6276689bba41a1fde310fd0c15d9dd7c4bfebbdfcbf08b86f506aad2360 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-8d853ce1b682] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 1ebcc2674db06ca71e71b94c14cb9c785d3e175740737c8154dd5d3bb4bbacb3 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-7f7358abf286] | core-authoritative / 1 | 1 | fa170e27f8c9093354090e4663420c01f1c61ff1a13e4780cb6641a2877083cf | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-a1cbd42cdafb] | diagnostic-retain / OPAQUE_BYTES | UNVERIFIED | NOT_READ_DIAGNOSTIC | Originating runtime → Originating runtime | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c69734f920e3] | compatibility-or-unknown / OPAQUE_BYTES | 1 | b0986769de6660baf7391afc10f2f2a297235f5c8eef2cf2555e904fb6a5a854 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-64f203fb99d4] | secret-reference-only / OPAQUE_BYTES | 1 | f7efbab4287353210f16ca1884b76ced017a685d143920f0872179269d6498ab | User/Core → User/Core | NEVER_IMPORT; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-8f7e24dcbb58] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 46bba76d76611579abcb3a0a259aa2c730a3eae3a4746a436ac4f90ef10853c3 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-551e27c8c068]/[entry-d4cbda49b1ed] | compatibility-or-unknown / OPAQUE_BYTES | 1 | 56d4af65701c26df20bd4021eda95b6e830348ce3a746086079fe89285548dc9 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-dd5f0d172472] | compatibility-or-unknown / 2 | 1 | 405b659806dcfcf31ea1aa596752f125f86d610dfdc6353d0402361445213078 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-6c2487be005f] | core-authoritative / UNVERSIONED | 1 | a85aac012de7942d2f2a3f0d07e15b785067eb9b9477dfccdcdf26a1ea66c385 | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-66345c5a7f26] | compatibility-or-unknown / 1 | 1 | 3e27daea9d25a3c1338c9da502692a90c47d71bc75c8d3541795d1e9b88dfd41 | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-30d15643e417] | core-authoritative / 1 | 1 | 9c6cb8fdfb5717db7209f209e575b681b31815551e65f49b3bc10048e2ab97fc | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/[entry-cbdae906706f]/[entry-259aa8ef98a8]/[entry-1f92f91a9d16] | core-authoritative / 1 | 1 | b33e407a6c8402027789dbe3ff39c81670db14bbb54bfdaaf6c85523afffe7be | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-31e6b25a32d1]/[entry-8061249eba40] | compatibility-or-unknown / OPAQUE_BYTES | 1 | ba55a8ffe585ee0cc54f7bfedb63f2c07e116d5542c87009295779c2583dd32c | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| c12a489fa781c9d2 | state/continuity/[entry-249215fed826]/[entry-187c4ab569dd]/[entry-48d41b6fe799] | core-authoritative / UNVERSIONED | 1 | ec5163e694debd111029c16c31f78fbf77a94b05dcfabd4eba62cb63f56cb69e | Core → Core | KEEP_IN_PLACE; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |
| 3402041dd63077f1 | state/[entry-c8cc8b73f1ca]/[entry-01195dd24b04]/[entry-8061249eba40] | compatibility-or-unknown / OPAQUE_BYTES | 1 | c6f7f52ed149e045222b2cce531bcc41847299993df921bd3bd43f89b788ac9e | UNVERIFIED → UNVERIFIED | PRESERVE_REVIEW_REQUIRED; CURSOR_MISSING, WRITER_STOP_UNCONFIRMED |

## DSH preset 只读证据

| Preset ID（Hash） | 文件数 | agent.cordis.yml SHA-256 | 整树 Hash | 归属证据 | persona prefix / 原生兼容 |
| --- | ---: | --- | --- | --- | --- |
| f2f0898b23bf63c7836b8a56359b46f53e4116b8e06484ee17485cb8a2aeef56 | 5 | 84b006ff303f299be76d122defc1d257fff85e0887793b1946e122906d755d1c | dc890fb5f94937ab0b60e44ae1213642ad59df10a5e21764b541dfbea1cab9ea | UNVERIFIED; USER 最终所有权 | true; 原生协议 UNVERIFIED; NEVER_OVERWRITE |
| 6dd02bb7c55a345e4e28882870313a5ef58bd51c9f72b9c60cbab76a4641a00e | 3 | 988fe3a527ae37c888297e232feedabe786108b6718a46c743baea8c46da41f9 | d7576597b425668643d097df0f226431c1452cefda36e951fa34bd5bc319dda5 | APP_OWNED_UNCHANGED; USER 最终所有权 | false; 原生协议 UNVERIFIED; NEVER_OVERWRITE |
| 9757530136641673aba9dfe1d24f40fe07ed136be2674b407166ff78b778b3a1 | 3 | 6bc8961b4cc3666ae792885d9b472f913b8bdeee18277570b8b153cce4c7b2da | f310fa9fe31daa2b920c67a7df4a73a0dbb1cb24fd1fa26cda0ffa85cc548569 | APP_OWNED_UNCHANGED; USER 最终所有权 | false; 原生协议 UNVERIFIED; NEVER_OVERWRITE |

## 迁移候选与阻塞

共 8 个 Legacy Social 文件候选：原源码根中的 Social 3 个会话、Session 2 个映射、黑话 63 条、贴纸 40 条、卡片 1 个会话、当前人设及黑话学习 Session 各 1 个文档；安装版根另有空 sessions 文档。它们均缺少批准后的账号归属。空文档也不能擅自删除以绕开 M4 的旧数据门禁。

本次 BLOCKED：ACCOUNT_ATTRIBUTION_REQUIRED 8 项；CURSOR_MISSING 2 个来源根；WRITER_STOP_UNCONFIRMED 2 个锁证据。消息游标/收发账本未在这些 Legacy 来源根发现，不能据此认定没有历史副作用，更不能合成空游标。真实来源没有扫描到可确认的 outcome-unknown 发送账本；这不是“未知结果已排除”，Fixture 已验证存在该状态时必须阻塞。

6 项仓库人设资产、26 项 Core 数据、5 项 Secret reference、2 个配置文档无需自动搬迁；32 项兼容/未知项保留复核；7 项诊断元数据保留原地。音乐未发现单独的业务数据库定义，相关外发能力仍受既有 QQ Runtime/媒体策略管控；发现的附件/缓存与未知文件不自动转长期记忆。

## 完整性和范围限制

没有枚举整块磁盘或读取进程环境内存；未知历史根、未声明的外部网关数据、外部数据库及实际 DSH 原生 Session 关系必须由 Owner 补充。扫描有 10,000 文件、深度 32、单文件 128 MiB/总读取 512 MiB 上限；越界、链接、无权限或并发变化会明确阻塞。真实 NTFS ACL 和完整备份空间/恢复演练尚未采集，必须在 M5-B 新批准后完成；不能把 Fixture 的 ACL 证据用于真实目录。

工具提交：`4eb5887734d237a49e78e525e9947466ed678d10`。最终测试和剩余门禁见另外三份 M5 报告。


## M5-A.1 当前补充（2026-10-18）

基线 `fda079e08ba65a2855d9706cbc2f68a4c6496ee8`；本段补充原 M5-A 历史记录，不替换其测试日期/统计。新鲜只读核查见 `WHALEBRIDGE_M5_PRE_MIGRATION_BLOCKERS.md`，分组待决动作见 `WHALEBRIDGE_M5_OWNER_DECISION_PACKAGE.md`；新快照为 `WHALEBRIDGE_M5_A1_READ_ONLY_EVIDENCE.json` 和 `WHALEBRIDGE_M5_A1_DRY_RUN_EVIDENCE.json`。

- 8 项 Social Hash 全部与 M5-A 一致；群/Session/人设关联不足以证明机器人账号，可靠账号映射新增 0 项，全部 OWNER_REVIEW_REQUIRED。不得转全局 Memory。
- 两个缺游标根在声明来源的 state/channel/backups/backup/data 检查内无可恢复 QQ 回执/发送账本，标 CURSOR_UNRECOVERABLE（限定于已检查范围），真实迁移 MIGRATION_BLOCKED。Social 局部序号/消息 ID 不替代消费 ACK。历史隔离、新实时 epoch 只是待批设计，不补造旧 cursor 或自动重放。
- 安装版 StateDir 锁 PID 与存活 Core Worker 对应；原源码 Bridge 锁 PID 当前不存在，但无停止 ACK/完整消费者证明。真实锁未回收。历史 portable 根未定位，普通/提升/其他用户运行环境及目标进程环境未完整验证；不得据当前 shell 或无锁推定安全接管。
- 连续两次 Dry Run 及测试结束后再次核验 planId 均为 `7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e`，原 86 项/3 个 preset 和 12 项阻塞不变。没有改真实文件来制造失效反例；旧计划失效在 Fixture 验证。
- 本轮实际 `npm test -- --suite test-whalebridge-m5-dry-run --suite test-whalebridge-m5-fixture`：2 PASS / 0 FAIL；`npm test -- --suite test-app-paths --suite test-core-entry --suite test-qq-runtime`：3 PASS / 0 FAIL。共 5 个定向 suites，DRY_RUN_PASS / FIXTURE_MIGRATION_PASS / ROLLBACK_PASS。原全量 npm/Rust/构建统计为历史证据，本轮无产品修改，不重新构建；Build 1081 保持。
- 当前没有可直接执行真实迁移的数据组。真实备份位置、账号归属、writer 停止、生产 resolver/Legacy 只读门禁及具体计划批准仍缺；设计待审不等于批准执行。REAL_DATA_NOT_AUTHORIZED / RELEASE_BLOCKED 保持；完成材料后停止等待 Owner 分范围决定。

M5-A.1 只读证据提交：`13f1dfc347fef81236a5e9d66613c50957f49109`；最终文档 HEAD 随交付答复记录。
