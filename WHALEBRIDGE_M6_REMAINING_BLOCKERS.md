# WhaleBridge M6-A — 剩余阻塞与Owner门禁

## 当前判定

**RELEASE_BLOCKED**。Build1084的自动化/发行集成与真实业务验收分开；RC_READY/STABLE_READY均不成立。M2_PARTIAL、M3_PARTIAL、M4_CODE_COMPLETE/M4_E2E_PENDING、M5-B REAL_DATA_NOT_AUTHORIZED/MIGRATION_BLOCKED保持；没有自动升级阶段状态。

生产sourceCommit 8dc4159a2a2c18ad3248bd4e7f32c2b1e34e3dfa；测试提交bca4c57dff36b957d4652ac4ca6990f8a15ecc3e；最终文档HEAD随交付答复。详细E/AC逐项数据在WHALEBRIDGE_M6_ACCEPTANCE_MATRIX.csv（文件名无空格，以实际附件为准）。

## 1. 本轮已关闭的具体缺陷

| 编号 | 根因/修改 | 证据与状态 |
| --- | --- | --- |
| M6-F01 | Rust Host动态依赖开发机VC Runtime，清机无法启动；build-desktop在Windows静态链接CRT | FIXED_CODE / VERIFIED_RELEASE_INTEGRATION；PE回归红绿、客体无DLL时安装/SEA help/卸载PASS |
| M6-F02 | smoke在1秒定时重启附近用慢CIM探测旧PID；改为signal0，ESRCH才认为结束 | FIXED_TEST；保留原断言，最终全量及RC结果见主报告 |
| M6-F03 | IExpress带空格绝对SED参数失败；从workDir以basename调用 | FIXED_CODE / VERIFIED_FIXTURE；原D盘父路径复测通过，既有图标/no-web断言保留 |

保留Build1082初次全量119 PASS/1 FAIL/5未运行与清机安装失败；保留Build1083全量121/0/5及D盘RC10/1；保留新增过深临时目录构造的135秒失败。最终统计只取Build1084，不用旧失败候选交付代替新验证。

新增M6-F04（FIXED_TEST）：Core-dist ready helper首次接到非成功响应即返回；空Token/暂时401确定性红例后修正为原限时内鉴权成功才返回，另测永久错误Token必须失败。初次1084全量120/1/5保留，最终结果取npm-test-final.log。

## 2. 未关闭P0/P1

| 编号/优先级 | 实际阻塞/证据 | 需要的条件与下一步 | 当前状态 |
| --- | --- | --- | --- |
| M6-P0-01 | 原完整E01–E24尚无整套真实业务闭环；Harbor配置真实模型、流式停止计费、Tool审批、任务/原生Agent接续、长消息实际布局等仍缺证据 | 授权隔离Windows用户/环境、真实模型及录屏/日志；按矩阵逐项验收，不以Mock或进程存活替代 | NOT_RUN_ENVIRONMENT |
| M6-P0-02 | Codex CLI0.163.0-alpha.10.2已登录，但本轮隔离只读Task被Windows原生沙箱拒绝 | 受支持且能维持现有文件围栏的运行环境，复测Task/Follow/Checkpoint/Handoff；不能无沙箱重跑 | NOT_RUN_ENVIRONMENT / sandboxCapable不可当true |
| M6-P0-03 | DSH CLI0.1.5-rc.1、TCP3080可达；当前API鉴权/服务版本/真实coding purpose+Persona兼容及三轮未闭环 | 授权并核实真实API/Profile/preset引用；不覆盖用户preset，不换高权限preset；已安装不能显示TaskReady | NOT_RUN_ENVIRONMENT / M3_PARTIAL |
| M6-P0-04 | 真实QQ/OneBot收发、协议能力与故障恢复无本轮授权测试账号/网关；只是假网关SEA通过 | Owner单独提供授权测试账号/白名单目标/网关；实际外发另有明确范围，不向用户群自动测试 | NOT_RUN_ENVIRONMENT / M4_E2E_PENDING |
| M6-P0-05 | Legacy用户切换资料：8项Social账号未知、两个cursor不可恢复、writer停止ACK/真实备份/生产resolver缺失 | 按M5决策包分组批准；备份/停止/迁移/Epoch分别授权；未知结果核验，不伪造cursor或双写 | REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED |
| M6-P1-01 | 干净WindowsSandbox安装/SEA帮助/卸载通过，但无WebView2，Harbor明确报告缺Runtime；客体标准用户创建步骤未成功 | Owner确认离线/前置Runtime交付策略；独立普通用户、具备WebView2的干净系统完成Harbor验收；未尝试关闭保护或切Legacy冒充通过 | NOT_RUN_ENVIRONMENT；冷机依赖交付未闭环 |
| M6-P1-02 | 最终安装器/Host/Core为NotSigned；更新/Publisher完整信任链非本轮交付 | 由授权签名流程及可信公钥策略验收；不关闭验证/不伪造publisher verified | SIGNING_PENDING |
| M6-P1-03 | 既有AC原生版本/Schema失效、跨重启Agent journal、泛化seq冲突/取消停机确认与Handoff全组合仍缺完整机制或证明 | 保留协议评审，不把Channel证明冒充Agent证明；重大变更等待Owner设计批准；本轮未复现的风险不称已确认漏洞 | BLOCKED_CONTRACT_REVIEW / PARTIAL |
| M6-P1-05 | 发行 licenses/README.md 明确要求公开发布前补齐 Node.js Runtime 许可文本并复核依赖声明 | Owner批准公开分发前完成许可证材料核对；本轮仅本地产物，不将SBOM生成等同许可门禁关闭 | DISTRIBUTION_CHECK_PENDING |
| M6-P1-04 | 指定CETAMESH_FINAL_RELEASE_GATE_REPORT.md未找到；远端CI未为此本地分支运行，269功能/四遍审计并未由M6替代 | Owner补充原报告或明确本轮证据与原门禁关系；后续远端动作另授权 | MISSING_REFERENCE / NOT_RUN_ENVIRONMENT |

Windows Sandbox为Windows11 build22621，不能当Windows10或所有普通用户环境。真实Android/Device Mesh、外部插件商店、所有真实MCP/Provider业务组合也未由当前Fixture关闭。

## 3. M2/M3/M4/M5的准确剩余边界

- M2正式Core通过Bootstrap独立启动；Legacy-exclusive仍可在独占StateDir下构造兼容宿主。现有锁拒绝同根双活，保留不等于已移除宿主；不删Bridge来改变状态文字。
- M3可选DSH Connector与native协议差异保留。coding/social purpose、prefix/DSH_HOME的fixture并不证明真实codingSession已经可用；用户Preset始终用户所有。
- M4正式QQ/Bionic职责已经转交，发送经Core Broker/Approval/Runtime账本；Legacy-exclusive只在互斥模式保留旧回调。真实OneBot验收缺口仍在。
- M5八项Social Hash本轮只读复核保持，不重新映射账号；未补造游标或写Epoch。真实Core仍运行且无停止ACK，缺失账本不是副作用清零证明，真实备份未获授权。

## 4. Owner需要分别决定的范围

1. 审阅本轮候选安装包/日志及128行矩阵，并确认是否接受固定依赖前置条件；不批准当前正式部署或Stable。
2. 为真实Harbor/模型、原生Codex/DSH、QQ测试账号/目标及设备测试分别提供安全环境和授权范围。
3. 对M5每个数据组逐项选择：可靠归属后计划、保留只读、暂缓、无需迁移。只有明确批准的数据组才能进入M5-B；备份、停进程、迁移、Epoch启用不是一项捆绑授权。
4. 签名、更新信任链、Publisher、协议重大迁移/Legacy弃用以及任何push/merge/release都需要独立指令。本轮没有执行这些动作。

本轮没有继续派生M5-A.x或擅自开始M5-B。完成后停止，等待Owner验收；不得用自动化0FAIL关闭这里的真实门禁。
