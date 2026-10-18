# WhaleBridge M5-A — Dry Run 与 Fixture 验证报告

## 1. 基线、交付和授权

- 基线 HEAD：`e70a3de70d002d10d744c27a4fa0e7d3c6e95a4c`（M4.4）。开始时工作树干净，原默认检出目录的设计分支和未提交修改未触碰。
- 本轮分支：`codex/whalebridge-m5-a-dry-run`；工作树：`D:/GIT- CetaMesh/audit-critical-repair`。
- 工具实现提交：`4eb5887734d237a49e78e525e9947466ed678d10`；最终交付文档提交另行记录，产品 Build 保持 **1081**。
- 结果分类：只读工具与隔离迁移见下文；真实资料一律 **REAL_DATA_NOT_AUTHORIZED**，实际切换 **BLOCKED**，发布 **RELEASE_BLOCKED**。

交付：DATA_INVENTORY、MIGRATION_AND_ROLLBACK_PLAN、OWNER_APPROVAL_CHECKLIST、本报告，以及 `WHALEBRIDGE_M5_DRY_RUN_EVIDENCE.json` 脱敏逐文件元数据台账。没有生成可执行的真实用户迁移入口。

## 2. 实际只读 Dry Run

实际执行：

```powershell
node scripts/whalebridge-migration-dry-run.mjs --root 'D:/GIT-QQ-BRIDGE' --app-exe 'C:/Users/Administrator/AppData/Local/Programs/CetaMesh/WhaleBridgeCore.exe'
```

当前源码默认根按 createAppPaths 自动纳入，额外原源码根与安装版候选根分别记录 provenance。当前进程 WHALEBRIDGE_DATA_DIR、DSH_HOME 未设置；安装进程 exe 路径已只读确认，但未读取其环境内存，所以 installed default root 仍是有证据的候选，不能宣称全部真实历史目录均已发现。

- 86 个文件元数据项，3 个 DSH preset 树；无凭据、账号 ID、聊天正文、用户偏好内容或人设正文输出。
- 计划 ID：`7e71a291dffc4359c3b7dc0e8dbf2c7db2fb6c155904e618fd171a96f6e98b3e`。
- 脱敏 JSON 台账文件 SHA-256：`81184498adf3e76d6851289ea8471d3ef50fa502c5e1b76fc835c520010d6120`。
- 同一命令连续两次 planId 完全一致，实际文件未变化时结果可复现。Fixture 进一步验证编辑来源/增加文件后旧计划拒绝执行。
- 实际计划 **BLOCKED**：账号归属未确认 8 项；缺游标的来源根 2 个；写入者停止证据未确认 2 项。没有为消除阻塞重置、清空或修复任何真实文件。
- 26 项 Core 文件、5 项 Secret reference、2 个配置文档保留原地；6 项仓库角色资产不自动迁移；32 项兼容/未知项保留审阅；7 项日志诊断元数据不读取正文。
- DSH：1 个 preset 归属 UNVERIFIED，2 个整树匹配已记录安装 Hash；后两者未满足 persona prefix 静态要求。所有原生协议兼容均 UNVERIFIED；均 NEVER_OVERWRITE。

**DRY_RUN_PASS** 表示工具在受控合法数据上的只读一致性验证通过；真实计划状态仍为 **BLOCKED**。这两个结论不能互相替代。

## 3. 可执行机制与安全边界

`src/migration/inventory.js` / `schemas.js` 不调用 Domain Store 构造器、不持久化、不停进程或回收租约。输出 Schema/计数/原字节 Hash、ID/Scope fingerprint、权限摘要、所有权、拟目标、冲突及备份条件。路径和原生身份也使用稳定别名。CLI 对 --apply/--force 等参数拒绝。

`src/testing/legacy-migration-fixture.js` 只接受自己分配的临时目录和本进程登记，真实路径或伪造 manifest 拒绝。专用 child 通过父进程 permit 使用同一 Fixture，不能销毁目录；回收也只允许父进程登记的独立根。执行原型既不打入 SEA，也不被 Core/Bridge 引用。

Fixture 包含模拟 Owner plan 绑定、停止 ACK、实际 Coordinator/源 StateDir/账号租约、Windows SDDL/原权限、只读备份、分阶段 journal、临时版本、Hash/Schema/记录数/ID/Scope 核验、原子 pointer、旧 writer 只读模拟、崩溃恢复和回滚。该模拟 Owner proof 不是生产 Core Approval 的替代品。

## 4. 异常场景验收台账

| # | 场景 | 结果与证据边界 |
| --- | --- | --- |
| 1 | 首次迁移 | FIXTURE_MIGRATION_PASS：仅新分配 Fixture，备份/目标/pointer 对账后提交 |
| 2 | 已迁移重复执行 | FIXTURE_MIGRATION_PASS：同计划验证后 duplicate，不重复派发；外国租约/来源变化不能返回 duplicate |
| 3 | 新旧目录并存 | FIXTURE_MIGRATION_PASS：原目录保持原字节，只有 pointer 选择新版本；既有正式目标阻塞 |
| 4 | 用户修改旧记录 | DRY_RUN_PASS：Hash/planId 改变，旧批准/计划失效；staging 中新增文件也拒绝 |
| 5 | 不兼容 Schema | DRY_RUN_PASS：损坏 JSON/未知游标版本阻塞；Core Chat v1 与 Legacy 同名 Session 正确区分 |
| 6 | 两账号、多群 | FIXTURE_MIGRATION_PASS：同群号在不同账号目录分开；两个群 Session、成员偏好/Scope 原样保留 |
| 7 | 缺失/损坏游标 | DRY_RUN_PASS：CURSOR_MISSING / SCHEMA_INCOMPATIBLE，不能制造空游标 |
| 8 | outcome-unknown 账本 | DRY_RUN_PASS：OUTCOME_UNKNOWN 阻塞；未触发任何真实外发 |
| 9 | 目标写中断 | ROLLBACK_PASS：Fixture 故障注入，保留部分目标与 journal，权威不提前切换 |
| 10 | 磁盘空间不足 | ROLLBACK_PASS：statfs 预检及 ENOSPC 故障注入，无 pointer 提交；不真实填满磁盘 |
| 11 | 迁移进程崩溃 | ROLLBACK_PASS / FIXTURE_MIGRATION_PASS：六阶段强制杀死 Fixture child、保留租约，PID 核验后区分已提交/未提交；不是杀真实 Core |
| 12 | 写者无法停/租约失效 | FIXTURE_MIGRATION_PASS：停止 ACK 缺失、外国账号租约、回滚期间租约改变均拒绝 |
| 13 | 目标/指针/备份冲突 | FIXTURE_MIGRATION_PASS：既有目标、不匹配完整 pointer、不完整提交清单、被改备份/目标均阻塞 |
| 14 | 中文、空格、非 C 盘、portable | DRY_RUN_PASS / FIXTURE_MIGRATION_PASS：解析便携根、中文临时数据、人设文件与 D 盘工作树 Fixture 实际执行 |
| 15 | Symlink/Junction、权限、只读 | DRY_RUN_PASS / ROLLBACK_PASS：真实 Junction 拒绝、源只读属性阻塞，Fixture EACCES 故障注入；Windows ACL 真实采集/复制/核验，仅限 Fixture |
| 16 | 卸载 Connector 保留数据 | FIXTURE_MIGRATION_PASS：移除隔离模拟组件安装标记，资料/备份/版本保留；不宣称真实卸载集成已验收 |
| 17 | 回滚保持 ID/Scope | ROLLBACK_PASS：原字节/Hash 不变；新目标若已被 writer 更新，TARGET_UNVERIFIED 阻止丢新资料的回滚 |
| 18 | Legacy/new 双写 | FIXTURE_MIGRATION_PASS：模拟旧写 API 在 pointer 生效后拒写；既有 M4 core-entry/QQ 跨进程互斥回归保留；生产迁移只读门禁尚待 M5-B 实施 |

所有 Fixture 都在独立临时根运行，退出后仅删除自身夹具。没有读取 Fixture 外的凭据或给真实 QQ 群发测试消息。18 行是具体验证边界，不是“真实用户迁移通过”。

## 5. 复核中发现并修复的问题

1. 恢复/回滚在拿协调租约前读 journal，可能用旧清单覆盖新提交：改为持有租约后读取，提交清单必须完整。
2. 原型只按 planId 判断 pointer，实际目录或 legacyMode 可能不匹配：改为完整结构比对，补充冲突反例。
3. duplicate / recover / rollback 可能忽略租约变化：全部走同一停止/租约门禁，写入/返回前再核验，补充外国租约和中途替换反例。
4. 仅靠自声明 Fixture manifest 不足以证明目录归属：增加本进程分配登记与受限 child permit；伪造 manifest 不能获得执行/删除能力。
5. 初版按同名 sessions 文件误套 Legacy 版本：先复现 Core desktop-chat v1 误报，再按实际 Domain 路径修正，没有修改真实资料或放宽其运行时 Schema。
6. Windows PowerShell 子进程继承 pwsh 的 PSModulePath 会导致 ACL 模块加载失败：Fixture ACL 调用使用系统 WindowsPowerShell 模块路径，实际 Get/Set-Acl 及权限对账已通过。

原先的复核反例均已在限定源码复核中关闭。允许任意同权限本机 Node 代码执行并不是该测试 helper 的安全模型；生产权限仍由既有 Core Capability/Approval 与未来批准的迁移入口负责。

## 6. 回归、构建与版本

| 命令 | 本轮最终结果 |
| --- | --- |
| npm test | **114 PASS / 0 FAIL / 7 NOT_RUN_ENVIRONMENT**（121 suites） |
| npm run build:core | PASS；Core SEA Hash 与 M4.4 相同，迁移测试模块未进入 bundle |
| npm run build:ui | PASS；TS/Vite，保留既有 >500 kB 提示 |
| npm run desktop:check | PASS；既有 dead-code 警告 |
| npm run desktop:test | 198 PASS / 0 FAIL |
| npm test -- --suite test-channel-sea --suite test-core-dist | 2 PASS / 0 FAIL，M4 生命周期/独立 Core 发行回归 |
| 新增迁移套件 | DRY_RUN_PASS / FIXTURE_MIGRATION_PASS / ROLLBACK_PASS，均已登记进现有聚合器 |

聚合器 7 个未运行项为显式 Legacy 环境、真实网关 MCP、真实 OneBot、公网搜索、真实 Codex，以及默认未 opt-in 的 Cargo check/test；后两项本轮已单独实际通过，不表示 Rust 环境缺失。全量包含既有 RC 沙箱安装验收；M5-A 不重新打包或分发安装器。

开发过程保留红绿证据：初始缺实现、ACL 模块环境错误、重复调用遗漏租约及 Core/Legacy 同名 Schema 反例曾失败并修复。一次全量运行与强制崩溃用例调整重叠，旧测试进程期望 exit 99 而新 child 使用硬终止，结果为 113 PASS / 1 FAIL / 7 未运行；最终版本冻结后重新运行完整聚合器，以上表最终统计为准。没有删测试、跳过断言或修改安全基线获取通过。

本轮未更改 SEA 产品运行代码，所以 Build 保持 1081；Core SHA 与 M4.4 一致。没有新安装包、没有冒用新工具提交为旧 RC 的 sourceCommit。既有 M4.4 RC sourceCommit 仍为 bb6343483d04c65cd88104c9e9c76d23df656afb；它不是带真实迁移能力的安装包。

## 7. 最终状态与下一步门禁

- 只读工具和受控计划：DRY_RUN_PASS；实际用户数据计划：BLOCKED。
- 隔离模拟迁移：FIXTURE_MIGRATION_PASS；隔离回滚/崩溃恢复：ROLLBACK_PASS。
- 真实写入、账号切换、Store writer 切换：REAL_DATA_NOT_AUTHORIZED，执行次数 0。
- 真实 QQ/OneBot、DSH coding Session、实际用户迁移与新生产 resolver：NOT_RUN_ENVIRONMENT 或未授权/待实施，不标 PASS。
- M2_PARTIAL、M3_PARTIAL、M4_CODE_COMPLETE / M4_E2E_PENDING 和 RELEASE_BLOCKED 保持。

完成后停止，等待 Owner 审阅清单并单独批准 M5-B。没有 push、合并 main、发布 Stable、覆盖 DSH preset、删除旧目录或清空旧资料。
