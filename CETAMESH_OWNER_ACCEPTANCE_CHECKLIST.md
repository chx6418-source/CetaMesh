# CetaMesh Owner 原生验收清单 — M6-B

## 判定与填写规则

候选 Version **1.0.0-rc.2 / Build1088**，生产来源 **c3d5657fba5dfcd9a5004b84d0e87cf329aafaea**。最终文档 HEAD 见交付提交；安装包 sourceCommit 保持此生产提交。当前 **RELEASE_BLOCKED，非 RC_READY**。本清单未勾选项不代表批准或通过。

本轮1084～1088已经用真实 Windows WebView2 和隔离资料执行了一部分交互，详细范围见 WHALEBRIDGE_M6_B_WINDOWS_E2E_REPORT.md。以下步骤用于补齐独立标准用户、干净系统及真实服务验收；不能将合成模型/假网关或源码 Fixture 结果填成真实 Provider E2E。

每项填写：操作人、北京时间、OS Build、标准用户 SID 的脱敏摘要、是否提升、安装路径、StateDir、Version/Build/Commit、操作、预期、实际、日志/截图文件、PASS/FAIL/NOT_RUN_ENVIRONMENT。证据不得包含 API Key、Token、真实账号、私人正文。

## A. 准备隔离 Windows 环境

- [ ] 使用可恢复快照的 Windows 10/11 VM 或专门测试账号；确认不是当前真实 Core/Legacy 的用户配置。
- [ ] 标准用户运行，记录管理员成员身份与实际进程提升状态，不能只看用户名或管理员启动的窗口。
- [ ] 准备中文、空格、非 C 盘目录，例如 `D:\CetaMesh 原生验收\程序`、`D:\CetaMesh 原生验收\数据` 和空的 `D:\CetaMesh 原生验收\工作区`。
- [ ] 复制候选安装包到客体；按报告核对 SHA256 与字节数；记录 Authenticode 为 NotSigned。不得把自签名或关闭系统安全措施当正式签名验收。
- [ ] 缺少 WebView2 时先验证明确提示和官方途径。可信安装入口为 [Microsoft WebView2 官方页面](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)；Owner 自行确认是否安装及使用 Bootstrapper/离线安装器。本文步骤不会自动下载或执行外部安装程序。
- [ ] 若遇到系统安全提示、登录或权限申请，交由 Owner 操作；不得绕过。

## B. 普通用户安装、升级与退出

1. 双击完整 `CetaMesh-Setup-1.0.0-rc.2-build1088-x64.exe`，完成完整自解压/安装流程，记录安装器进程退出码和安装清单。此项补齐全向导 GUI；本轮 CLI 后端安装不能替代该项。
2. 首次启动，拍摄 Harbor 首屏、右上 Core 连接状态；同时核对 `logs/desktop-shell.log` 的 WebView2 ready 和 `logs/worker.log` 的 IPC ready。仅 PID 存活不通过。
3. 将测试实例运行 PATH 限为 System32，确认不含 node.exe，实际发送一次消息并完成 Task；记录 SEA/子进程树，无源码目录依赖。
4. 登记中文空格测试工作区。目录选择对话框保留超过 40 秒再选择；应成功且没有 32 秒误超时。分别检查取消和超过 5 分钟的有界错误。
5. 区分关闭窗口到托盘与“退出应用”。经本测试实例托盘的“退出”关闭自己实例，确认 Core/Connector/Worker 收尾；不得关闭真实用户实例。
6. 重新启动，应恢复 Chat/Memory/Task/Workspace。记录每个测试 ID；检查后台无第二消费者或执行者。
7. 将上一个受控 RC 安装到同一测试环境，保存合成状态；关闭该测试实例后覆盖到本候选，核对状态 ID/Scope 和安装清单版本。不得用真实用户资料做覆盖试验。
8. 卸载时选择保留测试数据；重装同一候选，检查合成数据恢复。只删除专门 VM 快照或已确认的测试资料，不能清理真实目录。

可选 CLI 后端复核，仅在上述隔离客体内：

```powershell
# $candidate 指向客体中解包后的候选目录；先人工核对其来源和 Hash。
$candidate = 'D:\CetaMesh 候选\build-1088'
& "$candidate\WhaleBridge.exe" --install --payload-core "$candidate\payload" `
  --install-dir 'D:\CetaMesh 原生验收\程序' --data-dir 'D:\CetaMesh 原生验收\数据' `
  --start-menu-dir 'D:\CetaMesh 原生验收\菜单' --desktop-dir 'D:\CetaMesh 原生验收\桌面' `
  --registry-key 'HKCU\Software\WhaleBridgeTest\Owner-M6B' --no-dsh-integration
# 启动只指向这次新建的测试数据；不能对现有用户目录执行。
$env:WHALEBRIDGE_DATA_DIR = 'D:\CetaMesh 原生验收\数据'
$env:WHALEBRIDGE_INSTANCE_SUFFIX = 'Owner-M6B'
$env:PATH = "$env:SystemRoot\System32"
& 'D:\CetaMesh 原生验收\程序\WhaleBridge.exe'
```

## C. Harbor Chat / Task / Memory

| 编号 | 操作及明确预期 | 对应原验收 | Owner结果/证据 |
| --- | --- | --- | --- |
| C01 | 使用授权模型完成首次设置；错误 Key 应明确失败，修正后恢复；确认 Provider/模型名真实 | E01/E02/E21；AC004/006 | 待填 |
| C02 | 同一会话连续三轮不同问题；观察增量、终态、每轮正式消息；完成后10秒仍可见 | E03/E07/E18；AC007–020 | 待填 |
| C03 | 生成中停止，确认实际请求停止；重试产生明确新回合；取消不是伪 Completed；核对服务端计量 | E03；AC021/022 | 待填 |
| C04 | 结构化 Tool Calling 的成功/拒绝/失败/部分审批；工具结果回传模型，最终消息可见 | E04/E05；AC019/023–027 | 待填 |
| C05 | 实际500消息、长代码/工具卡/多DPI/窄窗；中部阅读不跳动；到最新功能正常 | E18；AC020 | 待填 |
| C06 | 显式“不使用Agent”，普通问题及诱导task.create均不派发任务；已有Task不能偷偷恢复 | AC035 | 待填 |
| T01 | Work选受控Workspace与Managed；不传隐藏模型参数，应使用已确认默认模型，显示真实回合结果/Checkpoint | E06/E09；AC028/029 | 待填 |
| T02 | 运行时暂停/恢复/取消，核对真实Agent状态与单写者；模型默认改变不改已有Task绑定 | E07/E08；AC021/022/028/034 | 待填 |
| T03 | 经Broker产生受控Artifact，审批前不能导入；拒绝、权限撤销、越界及迟到导入均拒绝 | E09；AC023–025 | 待填 |
| T04 | Core中断后核对旧副作用；从任务详情核验入口给出结论与新指令，未核验不得自动恢复 | E10；AC029/030/033/034 | 待填 |
| M01 | 合成“请记住”产生pending候选；批准前新会话不可当长期记忆使用；批准后持久保存 | E15；AC038 | 待填 |
| M02 | 第二候选明确拒绝；重启后保持拒绝且无长期记录；重复审批不重复创建 | E15 | 待填 |
| M03 | 新会话检索已批准记忆，跨Workspace/User/QQ群Scope拒绝；不能自动并入未知Social | E15；AC023/038 | 待填 |

Task 的 accepted、模型 turn/end、Checkpoint 和 Owner 验收完成分别记录。空Artifact不是“Artifact通过”，无工具记录不能当工具执行成功。

## D. Agent、MCP、Plugins、Channel

- [ ] Codex：已安装、可兼容、已认证、Sandbox可用、读/写Task和恢复能力分别核实。Sandbox拒绝时记录未运行，不关闭沙箱重试。
- [ ] DSH：实测API身份和版本/Profile、coding/social purpose、prefix/DSH_HOME、三轮与断线；用户Preset只读，不覆盖，不降级高权限Preset。
- [ ] MCP：五个受控stdio Server分别启停/握手/发现/调用/崩溃恢复；工具禁用后在实际执行点拒绝。
- [ ] Plugin：本地合成插件Stage→Review→安装/启用→Worker→Broker→Result；权限增量重新审批；禁用后从所有入口拒绝；不安装未知市场包冒充受控测试。
- [ ] QQ：Owner另行批准的隔离账号、网关和白名单目标才允许真实外发；否则全部真实QQ收发维持NOT_RUN_ENVIRONMENT。
- [ ] 正式SEA的Connector start/stop/health/reconnect、Legacy互斥、Bionic开关；基础QQ与Social独立，崩溃只影响自有Connector。
- [ ] 重投递、多消费者游标、Journal恢复/gap、账号租约失效、发送超时/回执丢失均核对；outcome-unknown不可盲重发。

## E. 签名和更新交付

| 门禁 | 需要的证据 | 当前决策 |
| --- | --- | --- |
| Authenticode | Setup/Host/Core有效发布者、信任链/时间戳及签名验证 | SIGNING_PENDING |
| 更新Manifest | Owner提供正式Ed25519签名流程及固定公钥；改动/错签/空公钥均fail-closed | SIGNING_PENDING |
| 下载校验 | 签名清单绑定本候选SHA256和大小；实际下载后重读校验；篡改/截断失败并清理临时文件 | 本地Fixture通过，真实交付待验 |
| GitCode/GitHub | 主源可取得合法签名清单及Asset；主源失败时备用源仍验签；无TLS绕过 | 部署/网络门禁未关闭 |
| provenance | Version/Build/Commit与安装器、资源、清单一致；报告不把文档HEAD伪装为生产sourceCommit | 本地候选核对，Owner复核 |

## F. Owner签收与禁止越界

- [ ] 对照 WHALEBRIDGE_M6_B_ACCEPTANCE_MATRIX.csv 逐项补齐 E01–E24、AC001–040；仅完成关联子步骤时标PARTIAL。
- [ ] 核对 CETAMESH_FINAL_RELEASE_BLOCKERS.md 中每个P0/P1，附关闭证据；缺关键真实验收继续RELEASE_BLOCKED。
- [ ] M5-B仍未授权。Social归属、真实备份、进程停止ACK、数据迁移、Epoch启用分别等待具体范围批准。
- [ ] 任何真实用户迁移、未知锁接管、QQ真实外发、Preset覆盖、push/merge/Stable都不由本清单默认授权。

Owner姓名/日期：______；具体接受的数据/功能范围：______；仍未接受项：______；是否达到RC_READY：______。
