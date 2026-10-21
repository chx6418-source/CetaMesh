# CetaMesh Build 1101 原生功能实测与实际升级

## 结论

已实际控制 Windows 电脑，使用正式发行资源安装并操作 WebView2 Harbor，而非只检测进程或按钮。已按 Owner 明确授权升级实际安装至 1101 并启动。**不能宣称所有功能均正常，发布状态保持 RELEASE_BLOCKED。**

- 产品分支：`codex/live-model-tool-repair`。
- 产品 sourceCommit：`b2891b0ad87c67e43f541ff2f328018ae003d243`。
- Version：`1.0.0-rc.2`；Build：`1101`。
- 实际安装：`C:\Users\Administrator\AppData\Local\Programs\CetaMesh`。
- 原数据目录：`C:\Users\Administrator\AppData\Local\WhaleBridge`，没有数据迁移或权威写入者切换。
- 运行窗口已创建新会话，选择现有 NexBox-main / 不使用 Agent / deepseek-flash；未自动发送用户私有项目或重试旧任务。
- 旧历史中已经保存的 DSML 及失败记录原样保留；本次修复约束新响应，不伪造历史成功或清空记录。

## 环境与边界

使用当前 Administrator 桌面的真实 Windows/WebView2；不是干净普通用户 VM。正式单文件 Setup 实际解包，再由其中安装器安装到 `D:\GIT- CetaMesh\live-model-repair\Harbor 1101 全功能隔离验收\程序`，独立测试 StateDir、中文/空格/非 C 盘路径。测试 Host 环境 PATH 仅 System32，Core 不依赖系统 Node；开发 Node 只用于外部验收驱动。

隔离项目仅含合成的 CountBox/0.2.0/add 描述。模型走已有配置的真实 DeepSeek，不使用本地假模型证明真实能力。QQ 白名单为空，网关离线，DSH 指向不存在的隔离目录。未关闭 Sandbox、批准安全权限、修改真实凭据或 DSH Preset。

所有以下 GUI PASS 只覆盖表中实际动作；自动化/Fixture 与真实 GUI 分开。备份与卸载验证只涉及隔离测试数据；实际安装升级只执行产品安装器保留数据流程。

## 实际功能矩阵

| 功能 | 实际操作与结果 | 结论 |
| --- | --- | --- |
| 正式安装/Harbor/Core | 单文件 Setup 解包、CLI 安装隔离目录；打开真实 WebView2，完整导航和 Core 已连接；About 显示1101+b2891b0 | VERIFIED_RELEASE_INTEGRATION |
| 普通 Chat/Tool Calling | Agent none，读取 analysis.txt；模型调用 filesystem.read，回答 CountBox、0.2.0、add作用 | VERIFIED_REAL_E2E（真实模型+合成项目） |
| 连续三轮 | 第一轮文件分析，第二轮仅问版本，第三轮输入类型风险；三个回答不同，第二轮返回0.2.0，未串上轮回答或泄漏 DSML | VERIFIED_REAL_E2E |
| 消息可见与布局 | 第一轮完成后10秒以上仍存在；三轮历史、工具详情、纵向滚动与消息间距实际观察；切换页面后仍可读 | VERIFIED_REAL_E2E（所测窗口尺寸） |
| Streaming/停止 | 发起100条纯文字建议，在生成中点击停止；保留约25条部分正文并明确“本轮已停止”，回到idle和发送按钮 | VERIFIED_REAL_E2E |
| Task 创建与执行 | Work新建任务，指定隔离Workspace及cetamesh；真实读取文件，保存报告Checkpoint及filesystem.read执行证据 | VERIFIED_REAL_E2E |
| Task 暂停/恢复/取消 | 暂停后paused；继续后running并新增读取证据；取消确认后cancelled、currentAgent解除，Task记录仍在 | VERIFIED_REAL_E2E |
| Task 结果与Artifact | 检查点如实标记Unverified Agent report；本次只读任务未生成文件交付物 | 检查点已验；Artifact GUI生成链 NOT_RUN_ENVIRONMENT，不能记PASS |
| Memory 保存/检索 | UI新增非敏感测试偏好，显示global；搜索UI1101验收偏好只显示该条；另一条系统Working Memory保留task Scope | VERIFIED_REAL_E2E（本机UI，不代表全部Scope负向用例） |
| 重启恢复 | 隔离Host/Core正常退出，确认均退出后同一路径重新启动；三轮Chat、停止标记和历史恢复；磁盘Task为cancelled、记忆2条且ID/Scope仍在 | VERIFIED_RELEASE_INTEGRATION；重启后Memory再次GUI检索未完成，磁盘持久化已核验 |
| Agents 页面 | Codex CLI 0.163.0-alpha.10.2已检测/兼容/认证；Sandbox明确待首次任务；DSH因隔离目录缺认证显示需要设置；ZCode明确不支持；Managed已就绪 | 页面状态可见，不能代替真实外部任务 |
| Codex真实Task | opt-in测试实际被Windows原生Sandbox拒绝；未绕过 | NOT_RUN_ENVIRONMENT |
| DSH真实Coding | 未选编程Preset，旧whale-chat/v2 persona-prefix-required；未修改或自动选替代Preset | NOT_RUN_ENVIRONMENT / OWNER_ACTION_REQUIRED |
| MCP授权 | 实际点击内置安全搜索MCP“启动”，返回integration.mcp.manage待审批，服务仍停止；未代点权限请求 | 拒绝未授权启动 VERIFIED_RELEASE_INTEGRATION；批准后启动/调用 GUI NOT_RUN_ENVIRONMENT |
| 插件中心 | 实际打开显示service_not_configured，没有可安装目录 | 尚不可用；OPEN，不能称插件安装闭环通过 |
| 插件/MCP禁用、崩溃 | 最终聚合器与SEA发行套件通过；本次GUI未运行新插件或批准管理动作 | VERIFIED_FIXTURE / VERIFIED_RELEASE_INTEGRATION，GUI真实闭环未验证 |
| QQ/Connector/Bionic | 最终test-channel-sea通过正式SEA隔离网关装配；本次GUI没有授权QQ测试账号，不做外发 | VERIFIED_RELEASE_INTEGRATION；真实QQ VERIFIED_REAL_E2E未通过 |
| 更新 | About点击检查更新，实际显示检查失败；没有接受无签名更新或降低TLS检查 | OPEN；可信更新链仍阻塞 |
| 普通用户安装/升级/卸载 | 当前是Administrator，不具备干净普通用户VM；隔离测试安装和卸载实际执行，卸载后Task/Memory/Workspace Hash不变 | 隔离发行集成通过；干净普通用户全链 NOT_RUN_ENVIRONMENT |

这不是所有功能正常的证明。记忆删除/拒绝、写入审批后的工具执行、Artifact文件生成、批准后的MCP GUI执行、插件商店安装、真实外部Agent/QQ和干净Windows升级恢复均不得补写PASS。

## 实际原路径升级与进程证据

1. Owner批准正常退出旧CetaMesh并覆盖1101。通过产品QuitRequest事件和原生退出确认正常结束旧Host/Core。
2. 第一次覆盖因独立DSH的5个MCP持有旧Core.exe而被安装器拒绝。未使用`--stop-core`，未强杀，原1098保留，36个state JSON Hash不变。
3. Owner随后明确批准“允许正常退出DSH后覆盖”。只读核验Node21212执行真实dsh bin.js web，父cmd20536属于专用批处理；检查控制台仅含DSH、5个MCP及自己的退出助手。发送**一次正常Ctrl+C**；未发送第二次升级信号，未调用TerminateProcess/taskkill。观察DSH和5个MCP退出。
4. 原路径安装器使用`--no-dsh-integration`，exit0。升级前54个已有用户JSON在覆盖后Hash全部不变；新增4个JSON位于安装器`.whalebridge-backup/.../snap-6`资源备份，不是新增或覆盖业务Store。
5. 安装校验脚本因其“任何新增JSON均返回1”的过严检查返回1。完整结果保留：安装器exit0、changedJson为空、addedJson为4个备份文件。未调整测试断言或将失败隐藏为PASS。
6. 安装后的24个清单文件全部Hash匹配，build-info sourceCommit b2891b0、dirty=false。启动真实安装目录Host/Core，UI显示已连接，已有历史和两个Task保留。
7. 最后只剩实际安装目录的Host21172/Core20676；隔离Host/Core和DSH MCP均已退出，没有强制清理真实锁。DSH保持按Owner授权退出状态，未擅自重新启动。

隔离重启期间，一次受限执行器启动的**自建测试Host**5180未建立窗口/Core。核验其隔离路径后仅回收该测试PID，并在原权限环境重启；没有终止任何真实用户进程。不能把这一受限执行器现象记成普通用户安装PASS。

## 数据与清理

- 测试Workspace analysis.txt字节内容保持不变。
- Task ID保持task_mvfchv1c_e5504551ce、status=cancelled；两条记忆分别为task Scope和global，未合并到真实Memory。
- 原生重启后磁盘数据存在；隔离卸载后Task、Memory、Workspace SHA256全部不变。测试安装器exit0。
- 隔离测试凭据副本已移除，providerKeyCopyRemoved=true；原凭据与DSH Preset未修改。
- 卸载的是D盘隔离安装，不是用户已升级的正式安装；保留测试数据用于核验，不清空真实StateDir。
- 用户真实数据覆盖前后Hash核验发生在重新启动之前。后续Owner授权的新会话/模型/工作区选择会正常写会话配置，不声称运行后所有JSON仍逐字不变。

## 最终自动化与产物

- `WHALEBRIDGE_TEST_CARGO=1 npm test -- --verbose`：**134 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT**。
- Rust：**199 PASS / 0 FAIL**；同次聚合器Release分类：**12 PASS / 0 FAIL**。
- build:core、build:ui、desktop:check、desktop:test、desktop:build、desktop:build:debug、build:release -- --use-current-build-number均退出0。
- 前置Build1100存在test-model-continuation原契约失败；没有改原断言，修复为默认保持原契约、生产Core显式启用总结策略后，最终1101全量重新通过。
- Installer：`D:\GIT- CetaMesh\live-model-repair\CetaMesh-Setup-1.0.0-rc.2-build1101-x64.exe`。
- Size：43,446,272 bytes。
- SHA256：`077C750905C75C844EA65631BE406F8504C816CE6E89FCB56E17104AE0A367BA`。
- Authenticode：`NotSigned / SIGNING_PENDING`。未签名和更新失败继续阻塞发布。
- 安装包产品源码是b2891b0；后续提交仅报告与脱敏证据，不改变验收二进制。交付提交SHA见本分支Git提交及最终答复。

## 可复查证据

统一外部证据目录：`D:\GIT- CetaMesh\live-model-repair`。

- `1101-native-functional-results.json`：安装Hash、GUI实际范围、持久化及隔离卸载结果。
- `1101-authorized-upgrade.json/.log`：实际1098→1101升级与用户数据Hash核验。
- `1101-owner-upgrade.json/.log`：第一次安全拒绝，不覆盖历史证据。
- `1101-full-test.log`、`1101-focused.log`、`1101-real-sea-results.json`、`1101-real-chat-none-results.json`：最终Build测试。
- 截图：`1101-ui-task-paused.jpg`、`1101-ui-task-cancelled.jpg`、`1101-ui-agents.jpg`、`1101-ui-mcp-approval.jpg`、`1101-ui-memory-search.jpg`、`1101-ui-about.jpg`、`1101-ui-chat-stopped.jpg`、`1101-ui-chat-restarted.jpg`、`1101-installed-ready.jpg`。
- 仓库脱敏证据：`docs/repair-evidence/live-model-usability/verification.json`与`native-functional.json`。

## 下一步

当前实际安装版可直接用新会话做已验证的普通模型只读分析。不要继续旧的失败/阻塞会话来判断新代码；需要Codex写任务时仍先解决原生Sandbox条件，不能取消其安全检查。

本轮不自动推进发布。仍需Owner/环境处理Codex沙箱、DSH合法编程Preset、授权QQ测试网关、插件目录、MCP GUI人工安全审批、完整Artifact闭环、普通用户VM验收、正式签名和可信更新链。没有push、合并main、发布Stable、真实数据迁移或关机。
