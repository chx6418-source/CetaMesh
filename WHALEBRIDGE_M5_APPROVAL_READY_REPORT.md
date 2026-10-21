# WhaleBridge M5-A.2 — 审批准备收口报告

## 1. 结果

本轮基线 `c04ad381916147eca10eddac2edf5f8f23d0060e`，沿用独立本地功能分支 `codex/whalebridge-m5-a-dry-run`，开始时干净。完成只读预检工具、Epoch 设计/隔离验证、备份与恢复反例验证、逐数据组 Owner 决策表。

**READY_FOR_APPROVAL ≠ AUTHORIZED。真实数据迁移、真实备份、停进程、账号接续和 writer 切换均未获许可、未执行。** 当前没有可直接执行迁移的数据组。M2_PARTIAL / M3_PARTIAL / M4_CODE_COMPLETE / M4_E2E_PENDING / RELEASE_BLOCKED 保持。本轮不再派生 M5-A.x；完成后停止，只有 Owner 明确批准的具体范围才可进入后续 M5-B。

## 2. 八项 Social 与计划

8 项 Hash 全部与 A1 相同；新鲜两次 Dry Run planId 均为 `7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e`，库存 86 项。可靠账号证据新增 0 项，候选账号列表为空（“未知”，不代表没有真实账号）；未默认选任何迁移方式。每项均提供脱敏摘要、原 Hash、现有会话关联及四种 Owner 选择，见更新决策包。

两个旧根在已检查范围内的 CURSOR_UNRECOVERABLE 保留；原 8 个账号归属、2 个缺游标、2 个 writer 停止证明阻塞未关闭。新 Epoch 不补造旧游标，不自动补发历史；真实 LIVE 边界无法证明时继续阻塞，不能因 Owner 批准就把未知消息当作实时输入。

## 3. 修改与验证

| 文件 | 职责 |
| --- | --- |
| src/migration/runtime-preflight.js | 只读观察候选 StateDir、锁、租约、持久发送/交付/审批/执行/migration 状态；不构造 Domain Store，不回收锁、不发认证请求 |
| scripts/whalebridge-runtime-preflight.mjs | 独立只读 CLI；始终报告当前未授权迁移阻塞，无 apply/stop/recover 参数 |
| scripts/test-whalebridge-m5-preflight.mjs | 缺文件不等于空、死 PID 不等于安全停止、隐私、Schema/损坏/链接、无恢复写入 |
| scripts/test-whalebridge-m5-epoch.mjs | 复用真实 Channel Journal 的设计夹具：准入、历史隔离、独立游标、跨 Epoch/重启去重、未知结果和封存拒绝 |
| scripts/test-whalebridge-m5-backup.mjs | 复用既有迁移 Fixture；备份失败、回滚指针写失败及 Journal 可恢复核验 |
| scripts/run-all-tests.mjs | 登记三个新 suite，不删除、跳过或放宽原测试 |
| WHALEBRIDGE_M5_A2_EVIDENCE.json | 新鲜脱敏计划/源 Hash、进程身份别名、只读预检和命名空间观察 |
| 三份新报告及 Owner Decision Package / PROJECT_STATE | 本轮设计、证据、决策边界与停止状态 |

没有修改 Core/Bridge/QQ Runtime/Bionic、迁移引擎、Agent Broker 或权威 Store；只读工具/测试不进入产品 bundle。保留 M0–M5-A.1 全部修复。

| 本轮命令 | 最终结果 |
| --- | --- |
| npm test -- --suite test-whalebridge-m5-preflight --suite test-whalebridge-m5-epoch --suite test-whalebridge-m5-dry-run --suite test-whalebridge-m5-fixture --suite test-channel-delivery --suite test-core-entry --suite test-json-storage | 7 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT（原 Fixture 111.5s） |
| npm test -- --suite test-whalebridge-m5-backup | 1 PASS / 0 FAIL（4.8s） |
| npm test -- --suite test-whalebridge-m5-epoch --suite test-whalebridge-m5-preflight | 最终封存/损坏 Epoch 补充后 2 PASS / 0 FAIL；属于前述 suite 重跑，不重复计数 |
| npm test -- --suite test-error-hygiene --suite test-core-dist --suite test-channel-sea | 3 PASS / 0 FAIL；现有 Core/SEA 发行隔离回归 |
| WHALEBRIDGE_TEST_CARGO=1 npm test -- --suite cargo:check --suite cargo:test | 2 PASS / 0 FAIL，通过统一聚合器实际运行 Rust check/test |
| npm run build:core | PASS；SEA SHA-256 与基线相同 |

共 **13 个不同 suite 最终 PASS / 0 FAIL**，含 2 个 Rust suite；不是全量 npm test 总数。未修改 UI/Rust 产品代码，本轮不重跑 UI 构建或完整 Installer RC，不将既有历史结果冒充新执行。

红绿证据：新预检缺模块首次 FAIL；修正一个测试把 bridge 锁误取为 Core 锁的索引错误后通过；封存 Epoch 的设计反例首次 FAIL，补入夹具状态门禁后通过。原引擎未修改，无安全基线/断言放宽。

Version `1.0.0-rc.2` / Build **1081**；无打入产品的代码变化，Build 不递增。重新构建 Core SHA-256：`333266f7f27c7544fb4d99aac81e1f59f97f76cf518881f6672b3116f95c0ba0`。本轮未创建新安装包或签名；未把本轮提交标成既有安装包 sourceCommit。

## 4. 允许的 M6 只读验收规划

| 范围 | 后续隔离验收条件（本轮仅规划） |
| --- | --- |
| Windows Installer | 沙箱安装/卸载/升级、权限与锁、旧数据 Hash 不变；使用虚构账户配置，不能覆盖真实 StateDir |
| 纯 Core SEA | 无 QQ/DSH、无系统 Node、非源码路径握手/重启/故障恢复，保持 Task/Memory/Workspace |
| Harbor UI | 完成消息可见、流式到正式提交、权限拒绝与未知状态呈现；只接隔离 Core，不发真实 QQ |
| MCP / Adapter | 启停/崩溃/取消、禁用工具执行拒绝、Owner Token 不向外部 Connector 暴露 |
| Connector / Bionic | 假网关下 start/stop/health/reconnect、租约互斥、故障隔离，Bionic 与 QQ 开关独立 |
| Chat / Task / Memory | synthetic 模型/数据验证 ID/Scope/审批，真实模型或账号环境缺失另列 NOT_RUN_ENVIRONMENT |
| 数据负向保护 | 保留 sentinel Hash、未知 Schema/旧目录并存/账号不明/无批准均拒写；禁止测试触发迁移、Epoch 切换或真实外发 |

M6 规划不授权真实安装覆盖、用户进程停止、QQ E2E 外发或资料迁移。本轮 Core/SEA 回归只是已执行的适用验证，不宣布 M6 完成。

## 5. 决策收口与停止

数据处置五类及逐条待决动作见 Owner Decision Package。READY_FOR_APPROVAL 只包括已准备的 Epoch/备份/兼容设计；8 项 Social、6 项角色资产及 32 项未知兼容文件仍 OWNER_REVIEW_REQUIRED；40 项 Core/配置/Secret 引用/诊断元数据保持 MIGRATION_NOT_REQUIRED（不删除）。KEEP_LEGACY_READ_ONLY 是 Owner 可选处置，当前选择 0 项，不伪称已切换只读 writer；缺游标和停止/生产 resolver 条件仍 MIGRATION_BLOCKED。

本轮没有新增必须继续自动修复的 M5-A.x。Owner 可按组确认归属并计划迁移、保留只读、暂缓或无需迁移；备份/停进程/迁移/Epoch 启用分别批准。没有选择或证据不足则继续阻塞，停止等待。

代码/证据提交：`c10145fff3c3fa7bbf4768a777deba7b6220268f`。最终文档 HEAD 随交付答复记录，并可通过本文件 Git 历史定位。本地提交后不 push、不合并 main、不发布 Stable；真实数据授权次数为 0。

补充红绿证据：Core 锁只有 PID 而缺 nonce 的反例首次失败，现按 Core/账号锁 PID:nonce 与 Legacy bridge.lock 纯 PID 分别解析，最终新增 3 suites 重跑全部通过。检查器始终不授权、不回收真实锁。


本轮工具/测试/证据提交：`c10145fff3c3fa7bbf4768a777deba7b6220268f`。脱敏证据文件 SHA-256（当前工作树原字节）：`e00e328c4ce71c6f8939fe3a8baf8232a94875b04d5fbe5372c9059b4d2ec5eb`。最终文档提交由 Git 文件历史及交付答复记录。真实数据、Epoch、写入者未切换，等待 Owner 分组决定。
