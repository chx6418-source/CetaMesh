# CetaMesh M6-B — Windows 原生产品验收

## 结论与基线

**RELEASE_BLOCKED；不满足 RC_READY / STABLE_READY。** M6-B完成了本轮可执行的原生验收、四处定向产品修复和本地发行回归；完整普通用户/真实外部服务验收仍未完成。M2_PARTIAL、M3_PARTIAL、M4_CODE_COMPLETE / M4_E2E_PENDING、M5-B REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED均保持。

- 工作目录：`D:\GIT- CetaMesh\audit-critical-repair`；分支 `codex/whalebridge-m6-integration`。
- 开始 HEAD：`49cb8b481741c0d8339efcae647a08d874fe7b38`，Version `1.0.0-rc.2` / Build1084。
- 最终产品 sourceCommit：`c3d5657fba5dfcd9a5004b84d0e87cf329aafaea`；Version `1.0.0-rc.2` / **Build1088**。该提交包含本轮四处修复及新增测试。生产打包时工作树干净，release-manifest 的 dirtySourceTree=false。
- 最终交付 HEAD 为包含本报告的后续文档提交，完整SHA记录于 `artifacts/verification/m6-b-build1088/final-delivery.json` 并在交付答复给出，可用 `git log -1` 核对；**不把后续文档提交伪装成安装包 sourceCommit**。
- 没有修改主工作树 `D:\GIT-QQ-BRIDGE` 的并行设计变更，没有 push、合并、Release Tag 或 Stable 发布。

| 阶段 | 当前状态与验收边界 |
| --- | --- |
| M0/M1 | 已完成的库存/契约成果保留，没有重新开展全仓审计 |
| M2 | PARTIAL；正式Core独立，Legacy-exclusive兼容宿主保留 |
| M3 | PARTIAL；可选DSH Connector存在，真实coding/preset兼容未完成 |
| M4 | CODE_COMPLETE / E2E_PENDING；正式SEA装配Fixture不替代真实QQ |
| M5-A/A.1/A.2 | 已完成；本轮只复核只读Hash/preflight与隔离Fixture，不新增迁移任务 |
| M5-B | REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED |
| M6-A | 既有集成成果保留，1084结果不充当1088证明 |
| M6-B | 本轮可用环境验收及定向修复完成；完整产品验收PARTIAL，RELEASE_BLOCKED |

## 1. 实际环境与证据等级

本轮实际使用 Windows 上的原生 Rust Host / WebView2、正式 SEA 和打包 Harbor，通过 computer-use 的 `@oai/sky` 观察、输入与点击。不是进程存活推断，不是浏览器替代 WebView2。截图由工具在会话中显示，保存了脱敏 UIA 文本、时间、操作标签及可用的截图 ID（纯文本观察的ID列表为空）；没有虚称导出了本地 PNG。

运行于当前 Windows 11 专业版 **10.0.22631 / Build22631** 主机的非提升 token，**并非独立标准用户或全新虚拟机**。Host/StateDir/注册表/模型/Workspace均隔离：

| 项目 | 实际设置 |
| --- | --- |
| 安装目录 | `artifacts/verification/m6-b-build1084/Windows 普通用户 验收/程序`（目录名称不代表普通用户验收已完成） |
| 合成数据 | 同根 `数据`；测试工作区 `artifacts/verification/m6-b-build1084/受控 Workspace` |
| 注册表 | 仅 `HKCU\Software\WhaleBridgeTest\m6-b-gui-1084`；测试菜单/桌面也在隔离目录 |
| Provider | 本机 loopback HTTP 合成 models/SSE；无真实 Key、费用或外部推理 |
| Node | 产品进程 PATH/Path 仅 System32；SEA不依赖系统Node；Node只用于测试驱动 |
| QQ/DSH/SnowLuma | 无授权真实账号；测试配置白名单为空、外部服务指向离线loopback；不触发真实QQ外发 |
| 生命周期 | 驱动仅结束自己创建的测试Host；没有终止真实Core/Legacy/DSH/网关 |

证据分为 **NATIVE_UI_WITH_FIXTURE**（真实界面+合成服务）、**VERIFIED_RELEASE_INTEGRATION**（正式进程/发行路径+Fixture）、**VERIFIED_FIXTURE**、**REAL_E2E**。前三者不能替代真实Provider或干净系统完整验收。

原生记录索引在 `WHALEBRIDGE_M6_B_VERIFICATION_EVIDENCE.json`；原文存于 `artifacts/verification/m6-b-build1084` 至 `m6-b-build1088` 的 `native-ui-observations-*.json`。每条保留实际Build；1084/1085/1086/1087的交互不能单独证明1088通过。最终1088另行运行了全部自动化/RC并实际打开About、恢复Chat/Task页面。

## 2. 先复现、再修复的产品缺陷

| 编号 | 原生反例 / 根因 | 实际修改 | 测试与本地Commit |
| --- | --- | --- | --- |
| B-F01 |1084真实目录选择对话框停留超过32秒，Harbor已报超时，稍后选择结果丢失。普通Host RPC期限被误用于人类输入对话框 | `desktop-ui/src/bridge/typed-client.ts`仅三个原生picker方法300秒，其余32秒不变；超时仍有界 | 已登记 `test-harbor-host-dialog`：实际Vite装载客户端+fake clock，33秒选择/取消、普通RPC32秒、picker300秒；1085原生停留超过40秒后成功注册Workspace。Commit `0b6f74816ec685b67e8a7b6ca82fdbd6fa592998` /1085 |
| B-F02 |1085真实Work选择Managed+Workspace后MODEL_NO_MODEL；设置已有默认模型，但Work请求与Provider自身均无默认 | `src/desktop/ui-service.js`仅未显式指定且未持久绑定模型的cetamesh Task采用Owner设置默认值，Broker继续持久化；显式/已有绑定不覆盖 | `test-ui-task-model-defaults`红例MODEL_NO_MODEL→真实服务容器绿例验证Checkpoint内结果及模型优先级；1087实际运行/暂停/恢复/取消。Commit `7a15f11fa0d2d342584f7eb9d4d5470ae53f0278` /1086 |
| B-F03 |1086原生Memory确认按钮一直超时，候选仍pending；Rust精确UI白名单遗漏了已实现Owner方法 | `desktop-shell/src/webview_policy.rs`仅补ui.task.reconcile、memory confirm/confirmBatch及extension settings describe/get/update六条；未知方法继续拒绝。补WebView2缺失提示的Microsoft官方手动安装链接 | `test-desktop-ui-v2-production`实际typed UiMethod/Rust列表对比红例列出六项→29项契约绿；Rust新增精确授权/拒绝测试。1087实际Memory accepted与rejected。Commit `ba3089c7873e1c6f57a1febda1969db51554ba6b` /1087 |
| B-F04 |1087原生About长期unknown/dev，而exe旁build-info正确；SEA服务从数据CWD/sourceRoot找版本 | `src/app/service-container.js`packaged About绑定exe旁build-info/release-manifest及resourceRoot，禁止数据目录冒充身份；source模式保留 | `test-packaged-about-assembly`真实容器，在数据根放9.9.9/9999假身份红→绿；1088原生About实际显示1.0.0-rc.2/1088/c3d5657。Commit `c3d5657fba5dfcd9a5004b84d0e87cf329aafaea` /1088 |

三条新测试均登记在 `scripts/run-all-tests.mjs`；既有生产UI契约测试扩展，没有删除原断言或放宽安全检查。四次产品改动均递增Build。新权限仅使已有Owner方法通过相同来源、Token与Core权限检查，不给QQ/MCP/Plugin发Owner Token。

红绿日志分别见1084的dialog-red/green-final，1085/1086的task-default-red-final/green-final，1086/1087的UI边界复现与原生记录，1087的about-red及最终1088 aggregate。1087 about-green.log保留了首次受沙箱限制无法spawn的失败；随后提升执行同一聚合器单套件PASS，最终1088全量再次覆盖，不将该失败文件称为绿证据。

## 3. Windows 安装与原生结果

| 场景 | 操作、预期与实际 | 判定 |
| --- | --- | --- |
| 首次安装/首次启动 | 1084正式Host的install后端在专用注册表/中文空格D盘路径exit0，实际Harbor onboarding和IPC连接、模型catalog/合成回复成功 | VERIFIED_RELEASE_INTEGRATION + NATIVE_UI_WITH_FIXTURE；完整IExpress向导及独立标准用户NOT_RUN_ENVIRONMENT |
| WebView2 | 当前主机真实WebView2完整显示、导航、输入；1088 About真实版本正确 | 本机原生子步骤PASS；无Runtime的全新客体未在M6-B重跑，M6-A缺Runtime证据保留 |
| 缺Runtime提示 | Rust错误保留依赖诊断并补Microsoft官方手动安装URL；没有下载或执行外部安装程序 | FIXED_CODE；新缺依赖客体GUI NOT_RUN_ENVIRONMENT |
| 中文/空格/非C盘/无Node | 真实Host+SEA从上述D盘中文目录运行，PATH仅System32，UI/IPC/模型/任务可用 | VERIFIED_RELEASE_INTEGRATION；不能推广为所有便携/长路径/Windows版本 |
| 覆盖升级 | 同一合成StateDir从1084至1088覆盖，Chat历史、TaskID、Workspace及候选决策保留；1088再次可见cancelled Task和历史 | VERIFIED_RELEASE_INTEGRATION；真实用户数据未迁移 |
| 关闭/重启 | Alt+F4实际是隐藏到托盘，Core继续工作；随后驱动只结束自建Host，孤儿守卫收尾；重新安装/启动恢复合成状态 | PARTIAL；**托盘“退出应用”真实点击与完整资源释放由Owner补验**，不把隐藏等同退出 |
| 卸载/重装/保留数据 | 最终自动化安装器测试覆盖隔离目录的保留/恢复；M6-B没有完整向导GUI逐步操作 | VERIFIED_FIXTURE / RELEASE_INTEGRATION；普通用户GUI NOT_RUN_ENVIRONMENT |
| 干净VM/标准用户 | 本轮未获得完整独立标准用户+WebView2环境。旧M6-A Sandbox无VC依赖安装/SEA帮助通过属于历史证据 | NOT_RUN_ENVIRONMENT，提供Owner清单，不能自动关闭门禁 |

可信Runtime安装入口：[Microsoft WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。安装策略、许可及实际安装由Owner另行确认。

## 4. Harbor 业务交互

| 功能 | 本轮实际操作与结果 | 未证明的范围 |
| --- | --- | --- |
| Chat |1084三轮、1087另三轮不同合成问题；真实增量/终态、完成后超过10秒仍可见。1087 slow流点击Stop保留部分正式消息并标“本轮已停止”；1088重启仍可见 | 真实Provider费用停止、失败重试全组合、原生Tool Calling审批/续答、500消息/多DPI/窄窗均未完整验收 |
| Agent none | 真实Chat选择“不使用Agent”，连续轮次没有新增Task；既有Task不被自动恢复 | 对抗模型task.create、所有分配入口由自动化负向测试覆盖，不声称手工全覆盖 |
| Workspace |1085原生picker停留40秒以上后选中受控目录并成功登记 | 未碰真实未知Workspace锁；大权限/损坏状态由既有fixture验证 |
| Task |1087真实Work任务选Managed，产生可见Checkpoint结果，暂停→恢复→取消均实际执行；最终cancelled。1088重启后cancelled与Workspace仍在 | Checkpoint/Agent回合完成≠Task Owner验收完成。未生成文件Artifact，不称Artifact/导入或Codex/DSH任务通过 |
| Memory |1087候选一批准accepted且有长期MemoryID；候选二拒绝rejected且无MemoryID。合成scope=user:desktop | 新会话检索、跨Scope实际GUI和真实Social迁移未验证；内核隔离由自动化另证 |
| Agents |1087原生页面：DSH Desktop已检测但needsSetup/authentication-material-missing；隔离PATH Codex不可用；Managed要求Workspace | 不是主机全部安装状态结论；真实Codex/DSH Session/Task/三轮未执行 |
| Plugins/MCP |1087真实页面如实报service_not_configured，未假报Ready。最终自动化实际stdio Server和SEA Extension Worker握手/调用另列 | 商店/本地GUI安装、权限审批到调用、真实第三方服务恢复未原生闭环 |

原生Task与候选脱敏结果见1087的 `native-task-result.json`、`native-task-lifecycle.json`、`native-memory-results.json`。1088停止测试实例后只读核对的 `native-state-restored.json` 再证Task cancelled及原Checkpoint、Memory accepted/rejected和原ID/Scope保留。当前合成Chat仍显示历史 `Desktop control service is unavailable` 诊断；UI已连接和普通模型结果不能消除此诊断，列为待核实的控制面集成残留，不宣称全部状态页无误。

## 5. Core / Channel / 外部服务与可靠性

- 最终1088的 `test-m6-pure-core-sea`、`test-channel-sea`、`test-process-extension-sea`使用正式SEA：OwnerIPC、纯Core、合成Streaming/Task/Memory/Workspace恢复；QQ start/stop/health/reconnect、受限Connector、Legacy互斥、Bionic独立生命周期、隔离子进程路径不要求系统Node。属于VERIFIED_RELEASE_INTEGRATION，不是真实QQ。
- `test-channel-delivery`、`test-core-channel-assembly`、`test-qq-connector-process`、`test-bionic-runtime-lifecycle`、发送policy/attachments/ledger/auto-request覆盖去重、独立消费者游标、账号锁、媒体授权、outcome-unknown及崩溃隔离；没有再造账本/事件总线。实际断言范围以套件日志为准。
- Task/Memory/Workspace、Continuity、Capability/Approval、禁用MCP/Plugin、Agent none等保留既有测试。Fixture恢复证明不能扩展为所有原生Agent在崩溃/未知副作用时都可安全继续；AC-002/005/014/017协议门禁继续保留。
- 真实Codex、DSH、QQ未执行新的外部任务。M6-A的Codex版本/登录和Windows Sandbox拒绝、DSH CLI版本/TCP可达均为历史观察，未提升为本轮能力认证。不能关闭Sandbox或覆盖Preset来通过。
- 八项真实Social只读Hash与M6-A相同；两个来源根只读preflight均MIGRATION_BLOCKED、stopConfirmed=false。PID缺失不是停止ACK。未备份、迁移、接收Epoch启用、账号归属确认或写入权切换。
- 真实安装目录下观察到的Core进程创建时间为2026-10-18 21:17:53（本机时间），PID5772/5800/6040/6104/21192；进程数量本身不证明双Core或角色。未发送停止指令。M6-A旧PID43516已不在，不能称其从旧阶段一直存活。

## 6. 最终自动化与发行验证

最终命令从c3d5657产品提交执行。日志根 `artifacts/verification/m6-b-build1088/`：

| 命令 | 最终结果 | 日志 |
| --- | --- | --- |
| npm test -- --verbose | **124 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT**，129 suites | npm-test.log |
| npm run build:core | PASS | build-core.log |
| npm run build:ui | PASS | build-ui.log |
| npm run desktop:check | PASS | desktop-check.log |
| npm run desktop:test | **199 PASS / 0 FAIL** | desktop-test.log |
| npm run desktop:build | PASS | desktop-build.log |
| npm run desktop:build:debug | PASS（发行自检所需） | desktop-build-debug.log |
| npm run build:release -- --use-current-build-number | PASS，干净生产来源、不再次递增 | build-release.log |
| npm test -- --category release --verbose | **11 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT** | rc.log |

全量已包含Rust套件与Release分类，单列199与11是分类复核，不能加总成独立用户场景数。五项环境未运行：test-console（legacy-bridge）、test-mcp-exec（gateway）、test-mcp-web-search（network）、test-onebot-connection（gateway）、test-phase3-real-codex（real-codex）；准确原因保留在最终aggregate summary，未提供真实服务开关以绕过授权。可选旧HTTP测试跳过不构成启用HTTP Console的理由。

保留失败历史：1084 RC在更深TEMP下IExpress suite超时300.1秒（10/1），相同断言改用M6-A已验证的D盘空格TEMP后11/0。1088首次全量误用仓库内RC TEMP，117 PASS /5 FAIL /7未运行：三个“非Git目录”测试实际位于父仓库，安装临时路径过长及Extension Worker找不到路径，另遗漏开启Cargo聚合开关。保留 `npm-test-wrong-temp.log`；不改产品或断言，用正常系统TEMP重跑五项定位环境根因，再重新全量并开启WHALEBRIDGE_TEST_CARGO=1。最终全量用正常系统TEMP；RC仅用reference D盘空格TEMP。**未证明任意深TEMP路径可靠**，列P1风险。1086迭代中旧runner遇到1087产物尚不存在的并发构建失败不作为最终结果；1087 releaseguard等待活动fixture自动收尾后才重建，不清空测试资料来通过。

E01–E24、AC-001–040逐项复用在 `WHALEBRIDGE_M6_B_ACCEPTANCE_MATRIX.csv`。128行区分自动化和完整REAL_E2E，原场景文字/历史真实行来源保留；另增本轮原生子步骤、Build和证据列。完整真实场景尚无整套PASS，部分原生子步骤不自动替代原验收条件。

## 7. 最终包、签名与下载信任

目录 `artifacts/rc/1.0.0-rc.2/build-1088`。安装包 **43,356,160 bytes（41.35 MiB）**。

| 文件 | SHA-256 | 签名 |
| --- | --- | --- |
| CetaMesh-Setup-1.0.0-rc.2-build1088-x64.exe | cf15d45bd88bdfbec63d6446d6831b147574eff6fd3d412d800aa32c817c1a1c | NotSigned |
| payload/WhaleBridgeCore.exe | 190379f3dc1132454c4ec4b29e6c123dc2189c797e899af0c725e00c3c4eeff0 | NotSigned |
| WhaleBridge.exe | 393a7a3850c14b5a5f9ac17346ba3eb8f68d306629032b79ab8a96a2c4567e7a | NotSigned |

实际重算manifest全部files与三个二进制Hash；版本/Build/sourceCommit与本机1088About一致。更新Manifest固定公钥生产默认空，缺公钥fail-closed；没有正式签名材料，不用测试私钥或自签名冒充正式发布信任。

2026-10-18 13:40 UTC匿名探测：配置GitCode主源stable.json返回404；GitHub备用源在当前Node TLS链校验报UNABLE_TO_VERIFY_LEAF_SIGNATURE。未关闭TLS验证。未发布的本地RC不能证明两个公网源交付成功，也没有上传Stable清单。签名、大小/SHA校验负例在最终测试验证；真实签名清单+下载+备用源门禁仍SIGNING_PENDING / NOT_RUN_ENVIRONMENT。

## 8. Owner收口与停止

详见 `CETAMESH_FINAL_RELEASE_BLOCKERS.md` 的P0/P1和 `CETAMESH_OWNER_ACCEPTANCE_CHECKLIST.md` 的可执行手工步骤。干净标准用户完整安装、托盘真实退出、原生Tool/Artifact/插件完整操作、真实Provider/QQ、签名/源交付、许可证和未关闭协议门禁仍阻止RC_READY。

本轮已停止隔离GUI驱动，仅保留可复验的测试资料/日志/安装包；不擅自清理测试注册表或目录，以免失去交付证据。真实进程/旧数据没有被清理。完成后停止，等待Owner验收；不自动开展M5-B或新增M6后续任务。
