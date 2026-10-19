# CetaMesh Build 1091 发行构建与验收报告

日期：2026-10-19（Asia/Shanghai）。本轮范围为当前主线发行输入、Windows候选包、完整自动化、安装后Core/Harbor及MCP/Connector/插件发行装配。**FINAL_STATUS: RELEASE_BLOCKED**；本轮构建与适用自动化已通过，不代表完整真实产品E2E或Stable门禁通过。

## 1. 基线与源码

| 字段 | 实际值 |
| --- | --- |
| 用户提供的历史主线 | db2b060018d0309052eeea004cdbd14e257aa56d |
| 开始时实际干净 main / origin/main | ad1b81b5d872982030b5fa09cef24dce736e302e，两者0 ahead/0 behind；保留后续已合并的30提交 |
| 修复分支 | codex/build-1091-release-verification，从上述最新main建立 |
| 最终产品源码 / sourceCommit / 测试源码 | 4ba0895b9a66fb1fb0766d2807956ea5da002b55 |
| Version / Build | 1.0.0-rc.2 / 1091 |
| buildId | 1.0.0-rc.2-build1091+4ba0895 |
| dirtySourceTree | false（打包时干净提交） |
| 修复后产品代码变化 | 打包后没有再改；交付文档另行提交，不能把文档提交伪填为安装包sourceCommit |
| 测试系统 | Windows 11 Pro 10.0.22631 x64，本机测试token未提升；不是独立标准用户/干净VM |

工作目录：C:/Users/Administrator/.codex/worktrees/product-context-main-merge。名称含main-merge，但当前实际分支为上述修复分支。共享 D:/GIT-QQ-BRIDGE 的设计分支及未提交文件未覆盖。

## 2. 实际安装包

- 可直接交付的位置：D:\GIT- CetaMesh\release-1091-verification\CetaMesh-Setup-1.0.0-rc.2-build1091-x64.exe
- 规范发行目录：C:\Users\Administrator\.codex\worktrees\product-context-main-merge\artifacts\rc\1.0.0-rc.2\build-1091
- 安装包名：CetaMesh-Setup-1.0.0-rc.2-build1091-x64.exe
- 大小：**43442176 bytes（41.43 MiB）**
- SHA-256：**b4cb2fe803bac9a12f3ae7c256d98a47b072a325a3a6455f48d74a82a99bfb70**
- Setup / Host / Core Authenticode：**NotSigned / NotSigned / NotSigned**，正式签名状态SIGNING_PENDING。
- release-manifest.json 的30个文件Hash及SHA256SUMS.txt的31条记录逐一重算，全部匹配；交付副本Hash与规范目录一致。
- Host、Core的build-info与Manifest对应同一Version/Build/source；真实安装版About显示1.0.0-rc.2、1091、1.0.0-rc.2-build1091+4ba0895。

| 二进制 | bytes | SHA-256 |
| --- | ---: | --- |
| CetaMesh-Setup-1.0.0-rc.2-build1091-x64.exe | 43442176 | b4cb2fe803bac9a12f3ae7c256d98a47b072a325a3a6455f48d74a82a99bfb70 |
| payload/WhaleBridgeCore.exe | 98761728 | 13430fba101c269b056aede00abef65e0b5c5b0e7c46e23653b412c32c12dd79 |
| WhaleBridge.exe | 7979008 | a469f7c1d33947bfc770b8ea2659ea832938f91b91adac3105b6c15b3cb5698d |

首轮ad1b81b候选没有通过全量，不作为本次交付。为保留证据，原包和原索引分别隔离为 artifacts/rc/1.0.0-rc.2/build-1091-unverified-ad1b81b 与 artifacts/manifests/rc/1.0.0-rc.2/build-1091-unverified-ad1b81b.json。发行器曾正确拒绝已有旧索引；没有删除/放宽防覆盖检查，也没有手改sourceCommit、Build或Hash。按本轮指定的未发布Build1091重新生成最终候选，只有上述4ba0895与SHA对应当前交付；隔离旧包不得分发。

## 3. 失败复现与最小修复

首轮完整npm：**130 PASS / 3 FAIL / 5 NOT_RUN_ENVIRONMENT**，日志保留为npm-test.log。

| 失败 | 根因及修改 | 回归依据 |
| --- | --- | --- |
| test-agent-provider-expansion | settings/describe已鉴权成功，随后Session API不支持时把authenticated证据丢为null。src/agent/dsh-agent-provider.js保留已验证鉴权，但认证拒绝、认证材料缺失、连接失败仍分别false/null；available/sessionCapable/ready/taskEligible继续false | 原有失败断言保持；追加认证拒绝、材料缺失、ECONNRESET负例，全部通过 |
| test-product-services | 上游main已实现DeepSeek off/low/high/max推理协议，但产品元数据测试仍期待只显示baseUrl | 精确期待值与已实现reasoningEffort一致，并增加DeepSeek枚举断言；独立test-model-continuation实际驱动Provider受控fetch验证thinking/reasoning_effort映射。不是取消断言或删除已支持字段，真实Provider未因此宣称验证 |
| test-whalebridge-m5-dry-run | 合成预设缺少严格Persona Schema要求的name，原测试想验证有效prefix却提供了不完整Schema | 仅给隔离测试YAML补name=@deepseek-ai/dsh-persona，保留兼容true、缺prefix=false、NEVER_OVERWRITE和原文件字节不变等断言。原生校验器未放宽；test-dsh-setup非法/别名/路径等负例仍通过 |

四个实际修改文件：src/agent/dsh-agent-provider.js、scripts/test-agent-provider-expansion.mjs、scripts/test-product-services.mjs、scripts/test-whalebridge-m5-dry-run.mjs。修复提交4ba0895b9a66fb1fb0766d2807956ea5da002b55。新增负例位于既有已登记suite，没有孤儿测试、删测试或跳过断言。五组定向回归5PASS/0FAIL；独立只读复核未发现新增问题。

辅助GUI验证脚本曾把前一轮工具结果误当当前轮，随后按当前user消息边界过滤；重复向同一非空自解压目录解包也发生覆盖等待超时。均保留为夹具诊断，未修改产品来适配；最终使用新的空解包目录与独立数据根，实际安装包自解压exit0。此处不把夹具问题冒充产品修复或计作真实Provider通过。

## 4. 最终构建与自动化

以下均针对4ba0895干净源码及其最终1091产物重新执行；不使用旧包通过记录替代。

| 命令/范围 | 最终结果 | 日志（公共前缀D:/GIT- CetaMesh/release-1091-verification/） |
| --- | --- | --- |
| npm ci --offline；npm ci --offline --prefix desktop-ui | PASS，锁定依赖；没有第三方版本升级 | npm-ci.log、ui-ci.log |
| npm run build:core | PASS，独立SEA | build-core-final.log |
| npm run build:ui | PASS，TypeScript/Vite生产bundle | build-ui-final.log |
| npm run desktop:check | PASS | desktop-check-final.log |
| npm run desktop:test | **199 PASS / 0 FAIL** | desktop-test-final.log |
| npm run desktop:build | PASS | desktop-build-final.log |
| npm run desktop:build:debug | PASS，为现有原生测试提供输入 | desktop-build-debug-final.log |
| npm run build:release -- --use-current-build-number | PASS，发行审计与干净source记录 | build-release-final-retry.log；旧索引拒绝记录build-release-final.log |
| WHALEBRIDGE_TEST_CARGO=1 npm test -- --verbose | **133 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT**，共138suite含Cargo | npm-test-final.log |
| Node/JS登记suite（上述聚合扣除2个Cargo suite） | **131 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT** | 同上，不与聚合重复相加 |
| RC verification：npm test -- --category release --verbose | **12 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT** | rc-final.log |

全量使用系统TEMP；RC单独使用D:/GIT- CetaMesh/release-1091-verification/rc-temp，保留中文空格的隔离安装场景。Rust现有dead-code提示、Harbor bundle大小提示及模块级use-client打包提示未当作失败，也未为清除提示改产品。

五个未运行suite及真实原因：

- environment  test-console                         0.0s  缺少环境：legacy-bridge
- environment  test-mcp-exec                        0.0s  缺少环境：gateway
- environment  test-mcp-web-search                  0.0s  缺少环境：network
- environment  test-onebot-connection               0.0s  缺少环境：gateway
- environment  test-phase3-real-codex               0.0s  缺少环境：real-codex

NOT_RUN_ENVIRONMENT不计PASS；真实DSH三轮Coding业务也没有本轮新验证，不能因模拟DSH测试通过而改为通过。

## 5. 正式包安装与运行证据

| 场景 | 实际执行及证据 | 结论 |
| --- | --- | --- |
| 最终单文件安装包 | 实际运行本次Setup.exe /Q /C /T:全新隔离解包目录，取得内嵌Host和WhaleBridgePayload.zip；解压其真实payload，通过正式--install路径安装到D盘中文空格目录，专用HKCU测试key，禁止DSH集成覆盖 | VERIFIED_RELEASE_INTEGRATION；sfx-extract.json exit0、gui-install.log |
| Core与Harbor | 实际安装后的Host→SEA→Owner IPC→WebView2；PATH仅System32，不含系统Node，无QQ/DSH，Harbor内容与控制项实际加载，不以PID存活判PASS | VERIFIED_RELEASE_INTEGRATION，native-observations-final.json、GUI日志WebView2 ready |
| 取消与正式消息 | 真正Harbor输入受控写工具请求，执行前停在Owner审批；实际停止按钮取消，工具卡已取消、回合停止、审批数归零，超过10秒仍可见；目标文件始终不存在 | VERIFIED_RELEASE_INTEGRATION，实际截图见本会话工具输出，持久UIA/时间摘要及native-cleanup.json；没有自动点击安全批准控件 |
| About对应关系 | 原生About实际显示1.0.0-rc.2 /1091 /build1091+4ba0895 | VERIFIED_RELEASE_INTEGRATION |
| 纯Core与持久化 | 已登记test-m6-pure-core-sea，生产SEA无QQ/DSH/插件，合成Streaming Chat、Agent none、Task/Memory/Workspace重启、历史消息10秒、损坏可选Social文件不覆盖 | VERIFIED_RELEASE_INTEGRATION；完整聚合和RC均PASS |
| 安装/升级/卸载 | test-release-candidate真实安装/启动、IPC、重启与单实例、无Node、中文空格目录、保留数据卸载；其余Desktop suite覆盖升级/修复/卸载重装的隔离数据 | VERIFIED_RELEASE_INTEGRATION；不是独立干净标准用户的完整向导GUI验收 |

当前本机token未提升，但账号和环境不等于独立普通用户/干净VM。完整首次安装向导、干净Windows Runtime缺失处理、所有用户路径/DPI/升级手工矩阵仍NOT_RUN_ENVIRONMENT，沿用Owner清单待验。没有自动下载依赖、关闭Sandbox或绕过安全提示。

## 6. MCP、QQ Connector与插件发行装配

| 能力 | 最终产物验证范围 | 状态与边界 |
| --- | --- | --- |
| MCP | test-core-dist在真实SEA安装资源中启动内置MCP，真实stdio initialize/tools/list/tools/call；test-mcp-registry验证审批、禁用、崩溃恢复和停止 | VERIFIED_RELEASE_INTEGRATION；工具进程真实执行与协议返回不等于真实外部QQ/网站业务成功 |
| QQ Connector/Bionic | test-channel-sea用实际Core SEA运行Connector/Bionic生命周期与生产Core Channel装配，不使用系统Node；假OneBot、账号锁、Legacy互斥、重连、发送账本/outcome-unknown和权限等既有测试均通过 | VERIFIED_RELEASE_INTEGRATION + VERIFIED_FIXTURE；没有真实QQ账号/群外发，M4_E2E_PENDING保持 |
| Plugins/工具 | test-process-extension-sea和test-m6-c-business-sea：真实SEA子Worker、Broker能力调用、安装Review门禁、启用/禁用实际拒绝、重启后保持禁用、卸载；受控Model完成文件工具批准/拒绝/取消/失败，Artifact身份解析拒绝foreignID | VERIFIED_RELEASE_INTEGRATION；开发模式仅隔离合成插件，不代表发布者签名或Windows OS级沙箱；Artifact为Owner关联受控结果 |

原生GUI测试两实例已结束，实际确认本轮拥有的Host/Core进程数0；两测试key不存在、测试程序文件已移除，合成数据保留。没有杀死真实用户Core/Legacy、DSH或网关，没有强制释放未知锁。

## 7. 剩余发布阻塞

- **真实Codex：NOT_RUN_ENVIRONMENT**。本轮没有真实认证/沙箱Task与恢复证据，不关闭Sandbox来获取通过。
- **真实DSH：NOT_RUN_ENVIRONMENT / M3_PARTIAL**。Coding/Social Session、用户Preset/Profile、真实三轮和Follow仍需安全环境；本轮health修复不等于Task Ready或真实编码通过。
- **真实QQ/OneBot：NOT_RUN_ENVIRONMENT / M4_E2E_PENDING**。仅隔离Fixture；真实收发必须明确测试账号、白名单、目标与允许动作。
- **Authenticode：SIGNING_PENDING**。最终Setup/Host/Core均NotSigned，不生成自签冒充正式签名，不宣称SmartScreen或Stable就绪。
- **更新可信链：未完成**。正式Manifest签名、可信公钥、实际下载源/TLS、Hash/大小、安全恢复需分别验证；本轮没有重新探测远端，不把历史404/TLS记录改成当前成功，也不忽略证书错误。
- **完整独立普通用户Windows验收仍缺**。本轮真实本机WebView2及安装后端通过，不替代干净VM全向导/升级/卸载的人工产品验收。
- **兼容与许可门禁继续保留**。M2_PARTIAL、M3_PARTIAL以及既有兼容/协议/许可待办未由本次构建关闭；包内Node Runtime许可与依赖再分发材料仍需正式复核。
- **M5-B仍REAL_DATA_NOT_AUTHORIZED / MIGRATION_BLOCKED**。只运行完全隔离Fixture；没有真实用户数据迁移、账号/Epoch切换、Social归属合并、凭据或DSH Preset覆盖。迁移不是默认发行前提，但真实旧数据访问与写入者兼容边界未擅自放行。

## 8. 交付与停止

**构建及适用自动化目标完成：0 FAIL；最终发布状态仍为RELEASE_BLOCKED，不满足RC_READY或STABLE_READY。**

本轮不合并修复分支、不push、不创建正式Tag、不发布Stable；停止等待Owner验收。最小后续动作是Owner审核本地4ba0895修复与本报告，提供独立Windows/授权外部服务及正式签名、更新可信链条件，再按明确范围复验。无需重做已通过模块或自动启动迁移。

完整脱敏证据：docs/repair-evidence/build-1091-release/verification.json；原始日志与交付副本保存在D:/GIT- CetaMesh/release-1091-verification/。产品sourceCommit固定为4ba0895；文档后继提交不改变安装包来源。报告提交后再次核对工作树、产品diff和安装包Hash。
