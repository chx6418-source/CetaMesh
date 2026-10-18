# CetaMesh 最终发布阻塞 — M6-B

## 发布判定

**RELEASE_BLOCKED**。候选1.0.0-rc.2 / Build1088，sourceCommit `c3d5657fba5dfcd9a5004b84d0e87cf329aafaea`。最终124 npm PASS /0FAIL /5未运行、Rust199/0、RC11/0只关闭实际自动化范围；RC_READY、STABLE_READY均不成立。

M2_PARTIAL / M3_PARTIAL / M4_CODE_COMPLETE / M4_E2E_PENDING / M5-B REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED保持。M6-A完成不代表完整Windows产品验收完成。

## P0 / P1门禁

| ID / 优先级 | 证据与实际剩余问题 | 状态 | 关闭条件 |
| --- | --- | --- | --- |
| P0-WIN | 本机非提升token真实WebView2有交互，独立普通用户/干净VM的完整安装向导、退出、升级卸载重装仍未全程执行；M6-A缺WebView2客体不作本轮通过 | NOT_RUN_ENVIRONMENT | 隔离标准用户/VM按Owner清单完成安装器退出、Runtime策略、Harbor、无Node、路径、托盘退出与保留测试数据；日志/截图绑定1088 |
| P0-UI | Chat三轮/停止、Managed结果与暂停恢复取消、Memory确认拒绝已在真实UI+合成服务完成；真实模型费用停止、Tool Calling/多审批/Artifact导入、插件GUI闭环与500消息多DPI未完整证明 | PARTIAL / NOT_RUN_ENVIRONMENT | 授权模型和隔离Workspace，逐项原生操作，保留实际副作用/审批/服务端证据；不能只检查按钮 |
| P0-CODEX | 本轮无新的真实Codex任务；M6-A原生沙箱拒绝是历史未关闭条件 | NOT_RUN_ENVIRONMENT / M2_PARTIAL边界保留 | 在受支持且保留Sandbox/Workspace围栏的环境验证Task、Follow、恢复/Handoff；不关闭沙箱 |
| P0-DSH | DSH installed≠Ready；本轮UIneedsSetup，真实API版本、coding Session、Persona prefix、三轮与恢复未验收 | NOT_RUN_ENVIRONMENT / M3_PARTIAL | Owner授权环境/预设只读兼容核验，真实coding任务结果；不覆盖用户Preset或切高权限preset |
| P0-QQ | 正式SEA假网关生命周期/互斥/发送账本可验证，真实OneBot能力/收发/回执/恢复未授权 | NOT_RUN_ENVIRONMENT / M4_E2E_PENDING | 明确隔离账号、白名单、目标与允许操作；真实收发另行授权。无授权不发送 |
| P0-DATA | 八Social归属未知、两cursor不可恢复、writer停止ACK/真实备份恢复仍缺；本轮只读Hash均不变，stopConfirmed=false | REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED | Owner对具体组分别决定；归属、备份、停止、迁移、Epoch启用分别批准，不捆绑授权；不能证明停止就不接管 |
| P1-SIGN | Setup/Host/Core均NotSigned；没有正式发布者信任链 | SIGNING_PENDING | 授权正式Authenticode流程、时间戳和签名验证；自签名不算 |
| P1-UPDATE | 生产pinnedPublicKey为空；GitCode匿名404、GitHub本机TLS链失败；真实签名清单与下载/fallback链未通 | SIGNING_PENDING / NOT_RUN_ENVIRONMENT | 正式Manifest签名/可信公钥、来源部署、当前候选大小/SHA与改包负向验证；不取消TLS或验签 |
| P1-PROTOCOL | AC-002/005/014/017原协议能力失效/seq冲突/跨重启Agent replay等未由本轮原生流程证明 | BLOCKED_CONTRACT_REVIEW | 原协议评审与兼容设计按Owner批准闭环；不以Channel fixture冒充所有Agent |
| P1-LEGACY | 正式worker已独立；Legacy-exclusive兼容宿主仍存在，锁/跨进程互斥的发行fixture不等于旧宿主已弃用 | M2_PARTIAL | 保留独占模式与同根拒绝双活；Owner确认兼容期限和弃用条件，不删除Bridge或绕过数据迁移门禁 |
| P1-TEMP | 1084更深TEMP下IExpress套件300.1秒超时，reference D盘空格TEMP重跑通过；1088在reference路径全量/RC通过 | OPEN_RISK / PARTIAL | 对路径敏感的封装器复现根因/修复或明确受支持构建环境。现有通过不证明任意长TEMP可靠 |
| P1-LICENSE | 当前包licenses/README仍声明公开发布前需补Node Runtime许可文本及依赖声明复核 | DISTRIBUTION_CHECK_PENDING | 完整许可材料与公开再分发核对 |
| P1-CONTROL | 合成Chat会话保留Desktop control service is unavailable诊断，尽管主IPC/模型/Task可用 | PARTIAL / OWNER_NATIVE_REVIEW_REQUIRED | 明确控制面缺失与历史会话错误展示语义，标准用户生产环境核对；不把“已连接”视为全部服务Ready |
| P1-GATES | 指定CETAMESH_FINAL_RELEASE_GATE_REPORT.md在M6-A缺失；远端CI/269功能/全仓四遍审计未被本轮替代 | MISSING_REFERENCE / NOT_RUN_ENVIRONMENT | Owner补门禁事实源、独立审计进度和后续CI授权；本轮不push来获取CI |

M5-B数据迁移未授权本身不允许擅自迁移来“关闭发布”；若Owner选择保留Legacy只读或缩小本次RC范围，需明确新的范围与升级兼容证据，当前报告不自行批准替代范围。

## 本轮已关闭的具体产品缺陷

| 缺陷 | 代码/测试结果 |
| --- | --- |
| 原生目录选择32秒误超时 | 仅picker300秒有界；真实长时间选择成功，普通RPC32秒不变 |
| Managed Work任务未继承Owner默认模型 | 未指定/未绑定模型时采用Owner默认；显式及已有模型不覆盖；实际Checkpoint结果 |
| Rust Host漏Owner UI精确方法 | 六个已有方法显式允许；未知方法仍拒绝；Memory真实accepted/rejected |
| SEA About元数据来自数据CWD | 从exe/resources读取安装版本；数据伪身份负例拒绝；1088原生About真实一致 |

生产提交依次0b6f748 /7a15f11 /ba3089c /c3d5657。没有重写Core、Task、Memory、Broker、QQ Runtime或迁移引擎；未削弱权限、Sandbox或审批。

## 下一步仅等待Owner

1. 按 `CETAMESH_OWNER_ACCEPTANCE_CHECKLIST.md` 明确提供隔离原生/外部服务环境，逐项填写结果；Fixture不能改填真实E2E PASS。
2. 按M5决策包分别决定数据组；READY_FOR_APPROVAL不等于AUTHORIZED。本轮未执行真实备份/停止/迁移/Epoch。
3. 签名、更新源部署、协议重大变更、后续发布动作另需指令。本轮不push、不合并、不发布。

详细执行证据：`WHALEBRIDGE_M6_B_WINDOWS_E2E_REPORT.md`、128行 `WHALEBRIDGE_M6_B_ACCEPTANCE_MATRIX.csv`、脱敏JSON证据。最终文档HEAD见交付提交，安装包sourceCommit固定c3d5657，不随文档改变。
