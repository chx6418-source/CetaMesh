# WhaleBridge M6-A — 正式安装版集成验收报告

## 1. 结论与本轮范围

**最终状态：RELEASE_BLOCKED。RC_READY / STABLE_READY 均不满足。** 自动化、发行集成和干净 Windows 客体的安装子集分别记录，不能互相替代。M6-A 完成本轮可安全执行的集成与阻塞收口；普通用户干净系统 Harbor 全业务、真实 Codex/DSH/QQ 和真实资料升级仍有门禁。

起点 HEAD：612911b0a8b4748816c0e3b8cb0bb8c708618f63，原 M5-A.2；开始时工作树干净。新分支 codex/whalebridge-m6-integration，工作树 D:/GIT- CetaMesh/audit-critical-repair；原 D:/GIT-QQ-BRIDGE 的设计分支及未提交修改未覆盖。未迁移真实数据、停止真实 Core/Legacy、重置锁、切换 Epoch 或发真实 QQ 消息。

指定 CETAMESH_FINAL_RELEASE_GATE_REPORT.md 在当前仓库、已知工作树、Desktop 及 Git 全分支同名历史查询中未找到，作为 MISSING_REFERENCE 保留。E01–E24 复用 CetaMesh_Desktop_最新问题修复与回归验收报告.md 附录 C 原始定义；AC-001–040 复用 Desktop 文档 02 和既有协议报告，不重新发明编号，不宣称四遍全仓审计完成。

## 2. 最终生产与测试基线

- Version 1.0.0-rc.2 / **Build 1084**。
- 干净生产构建提交：**8dc4159a2a2c18ad3248bd4e7f32c2b1e34e3dfa**；build-info.json / release-manifest.json 均 sourceCommit 相同、dirty=false。
- 最终测试提交：bca4c57dff36b957d4652ac4ca6990f8a15ecc3e；该提交及前一测试提交只调整新增空格 TEMP 夹具长度和鉴权就绪 helper，补充暂时/永久错误 Token 反例，保留原断言和限时。与生产构建提交相比，src、desktop-shell、desktop-ui、各生产 build/package 脚本和 release/version.json 差异为 0。没有用旧 Build 验证新的产品代码。
- 当前 Core 为正式 SEA；Rust Host 使用 Windows static CRT；Harbor 为 TS/Vite 生产 bundle；--qq-connector / --bionic-runtime / --extension-worker 都使用 SEA 自身。安装包不要求系统 Node，无新增 HTTP Console。
- 实际核对 AUD a41e6c5、M2 5049dce、M3 08201f5、M4 bb63434、M5-A 4eb5887、A.2 612911b 均为当前祖先，363 条接口台账仍在。六阶段及 AUD 修复不回退。

| 文件 | bytes | SHA-256 | 签名 |
| --- | ---: | --- | --- |
| CetaMesh-Setup-1.0.0-rc.2-build1084-x64.exe | 43356160 | e810f7ac6163bb66d9854d3fc270c8b06c3e77e0e225310fa96f8bd92f16ab5d | NotSigned |
| payload/WhaleBridgeCore.exe | 98454528 | 333266f7f27c7544fb4d99aac81e1f59f97f76cf518881f6672b3116f95c0ba0 | NotSigned |
| WhaleBridge.exe | 7979008 | 7c8b834a50b32d6a190fbb2d36369be706cf0db459c2aa35b527ee7cdc57d321 | NotSigned |

规范产物目录：artifacts/rc/1.0.0-rc.2/build-1084。该包仅本地候选，不是 Stable 发布；本轮未签名、未推送或建正式 Release Tag。build-info、发行清单、SHA256SUMS、SBOM 与许可说明都在该目录。最终文档 HEAD 随交付答复提供，不能将随后文档提交伪标为安装包 sourceCommit。

## 3. 四个已定位问题及修复

| 问题 | 反例/根因 | 最小修改 | 最终证据 |
| --- | --- | --- | --- |
| 干净 Windows 无法加载安装 Host | Build1082 在 Windows Sandbox exit -1073741515 / 0xC0000135；PE 动态导入 VCRUNTIME140.dll / VCRUNTIME140_1.dll，开发机安装这些 DLL 掩盖缺依赖 | scripts/build-desktop.mjs 在 Windows 增加 -C target-feature=+crt-static；不拷贝用户 DLL、不改系统、不放宽权限 | 新 PE 导入回归先 FAIL 后 PASS；Build1084 客体两个 DLL 均不存在，安装/SEA help/卸载成功 |
| Desktop smoke 存活误判 | 自动在 ready 后 1 秒重启；HTTP 探测至少600ms，实测新建 PowerShell/CIM 查询437ms，可能在预期重启后检查旧 PID；Build1082 全量119/1/5 | scripts/test-desktop-shell.mjs 用同进程 signal0 检查，ESRCH 才视为消失，其他错误上抛；保留原断言/时限 | Build1083全量121/0/5；最终Build1084结果见下；不把测试竞态当Core故障 |
| IExpress 空格绝对 SED 路径失败 | Build1083 D盘RC 10 PASS/1 FAIL，失败仅夹具封包；同一TEMP下绝对SED参数退出1 | scripts/package-installer.mjs 以workDir为cwd、传SED basename；现有测试永久强制空格TEMP，图标/no-web断言不删 | 同一D盘父路径封包复测PASS；最终RC全套另列 |
| 数据面ready helper过早返回 | 初次Build1084全量120 PASS/1 FAIL/5未运行，Core-dist收到非成功响应就返回；隔离空Token/暂时401反例确定性复现 | test-core-dist在原30秒限时内等待非空Token且res.ok；增加永久错误Token仍失败的反例，不改生产鉴权 | 红例FAIL，修正后27.3s PASS；最终全量/RC另列 |

额外保留一个测试构造限制：新增冗长TEMP组件在D盘深层runner目录中叠加后封包失败且耗时135s；仅将该新增组件改为 p s，原D盘父路径、空格条件和所有断言保持，生产源码不变。旧失败日志保留，不宣称支持任意超长 IExpress 路径，也没有修改测试基线获得通过。

## 4. 生产装配覆盖与权威边界

正式链：Desktop Host → SEA --worker → Core Bootstrap → Service Container → Owner/Data IPC。Core 唯一持有 Task/Memory/Workspace/Capability/Approval；不依赖 runBridge()、QQ安装或DSH登录。Channel Service 管理受限继承管道 → SEA QQ Connector → QQ Runtime；Bionic 单独Social Runtime通过Channel工作，不持有QQ连接。MCP/插件Worker反向能力调用经过既有Broker，不创建第二Store/事件总线。

新增 test-m6-pure-core-sea：真实SEA在D盘隔离StateDir、System32-only PATH、空用户/DSH配置下启动；Owner IPC错误Token拒绝；本地合成Provider完成streaming Chat；Agent none不自动建Task；Task/Memory/Workspace可创建/读取并跨Core重启保留；越界读取拒绝；损坏Social原字节保留；消息结束及重启10秒后历史仍可读取。**这是生产运行路径+合成模型，不是实际模型推理或Harbor画面验收。**

既有 test-channel-sea：实际SEA QQ/Bionic子进程start/stop/health/reconnect、假网关账号/接收、Broker审批后单次发送、崩溃重连、Core重启的Task/Memory/去重/回执；test-channel-delivery覆盖独立消费者/未知交付；send-policy/attachments/send-ledger覆盖所有媒体授权与outcome-unknown。未向真实QQ网关或用户群发送。

Agent/Model/MCP/Plugins：全量重新执行 Model→Chat/tool calling→Broker、Task→Managed→staging/审批、Continuity/checkpoint、五内置MCP真实stdio、安全tools/call、SEA Extension Worker及反向Capability。除明确SEA套件外，部分宿主装配仍是源代码进程+受控Fixture；不能据此关闭真实原生Agent、安装版UI或外部市场整条业务E2E。

## 5. 全部要求命令与新鲜结果

| 命令/范围 | Build1084最终结果 | 日志 |
| --- | --- | --- |
| npm test（含Cargo opt-in） | 121 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT（126 suites，含Cargo） | artifacts/verification/m6-build1084/npm-test-final.log |
| npm run build:core | PASS | artifacts/verification/m6-build1084/build-core.log |
| npm run build:ui | PASS；保留既有>500kB提示 | artifacts/verification/m6-build1084/build-ui.log |
| npm run desktop:check | PASS；既有unused/dead-code提示 | artifacts/verification/m6-build1084/desktop-check.log |
| npm run desktop:test | 198 PASS /0 FAIL | artifacts/verification/m6-build1084/desktop-test.log |
| npm run desktop:build | PASS；正式static CRT | artifacts/verification/m6-build1084/desktop-build.log |
| npm run desktop:build:debug | PASS；现有安装/桌面套件所需 | artifacts/verification/m6-build1084/desktop-build-debug.log |
| npm run build:release -- --use-current-build-number | PASS；clean source、显式已提交Build，未覆盖旧候选 | artifacts/verification/m6-build1084/build-release.log |
| RC分类（D盘隔离TEMP） | 11 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT | artifacts/verification/m6-build1084/rc-verification.log |
| 真实Codex专项 | 0 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT；原生沙箱拒绝隔离Task | artifacts/verification/m6-build1084/real-codex.log |

统计为 suite 级：另有 Workspace staging 的 Windows 8.3 alias、dir symlink 夹具因卷/EPERM条件未执行；junction 断言已执行通过，不能将套件 PASS 解释为这两个子场景通过。

全量环境门禁5项为显式Legacy桥接、真实MCP gateway、真实OneBot、公网搜索、真实Codex默认未opt-in。Codex另行实际尝试，原生Windows沙箱拒绝而非fixture替代；没有关闭沙箱重试。Rust已实际运行，不算环境缺失。旧Build1082/1083及初次1084结果仅用于失败追溯，最终通过统计只取1084日志。

## 6. E01–E24（原完整真实业务）

逐行前置条件、执行入口、实际操作、期望、结果、环境、日志、production sourceCommit、testCommit和Build，见 WHALEBRIDGE_M6_ACCEPTANCE_MATRIX.csv（128行，E/AC各有Fixture与Real层）。CSV result仅针对该行限定执行入口，coverage=PARTIAL不能当完整场景通过；fullScenarioResult为原完整验收门禁。真实资料未授权用BLOCKED，契约待审不伪装环境失败。

| E | 原场景 | 本轮自动化入口 | 真实E2E |
| --- | --- | --- | --- |
| E01 | 全新普通用户安装→引导→配置模型→成功回复 | test-m6-pure-core-sea;test-onboarding | NOT_RUN_ENVIRONMENT |
| E02 | 模型 Key 错误→明确提示→更换 Key→恢复旧可用配置 | test-standalone-model-path;test-desktop-chat-product | NOT_RUN_ENVIRONMENT |
| E03 | 发消息立刻出现→流式→中途停止→不会后台继续计费 | test-standalone-model-path;test-desktop-chat-product | NOT_RUN_ENVIRONMENT |
| E04 | 普通 Chat 发出单个 tool_call→Broker→执行→结果→模型续答 | test-model-tool-calling | NOT_RUN_ENVIRONMENT |
| E05 | 三工具调用含需要审批项目→批准/拒绝→消息协议完整 | test-model-tool-calling | NOT_RUN_ENVIRONMENT |
| E06 | Chat 选择 Codex/DSH→创建 Task→执行→流式→Artifact | test-managed-agent-provider;test-phase3-task-handoff;real-codex.log | NOT_RUN_ENVIRONMENT |
| E07 | 已有 Task 重复 Agent turn→新指令真正发送而非仅复用 Session | test-agent-provider-expansion;test-latest-audit-agent-identity | NOT_RUN_ENVIRONMENT |
| E08 | 一个 Task 从 DSH 切 Codex/Managed→进度/Workspace 不丢不串 | test-phase3-task-handoff;test-continuity-rollover | NOT_RUN_ENVIRONMENT |
| E09 | Agent 修改 Staging→审批导入→真实 Workspace 文件符合 Diff | test-capability-broker;test-workspace-staging-boundary | NOT_RUN_ENVIRONMENT |
| E10 | Core 中途重启→Chat 事件继续收取→Task/Memory/插件状态恢复 | test-m6-pure-core-sea;test-channel-sea | NOT_RUN_ENVIRONMENT |
| E11 | MCP 五个内置 Server 启动/握手/单工具调用/重启 | test-core-dist;test-mcp-registry | NOT_RUN_ENVIRONMENT |
| E12 | SnowLuma QQ 收消息→工具调用→审批→发消息，不影响独立 Chat | test-channel-sea;test-qq-send-policy | NOT_RUN_ENVIRONMENT |
| E13 | 插件本地导入→权限 Review→安装/启用→调用→崩溃隔离 | test-process-extension-sea;test-extension-runtime | NOT_RUN_ENVIRONMENT |
| E14 | 插件商店下载→校验→更新权限变化→拒绝/批准→回滚 | test-plugin-center | NOT_RUN_ENVIRONMENT |
| E15 | Memory 候选→确认→新会话相关检索→跨 Scope 拒绝 | test-phase4-memory;test-memory-runtime | NOT_RUN_ENVIRONMENT |
| E16 | Workshop 外部 Proposal→Owner 通过→任务→成果交付 | test-workshop-production-flow | NOT_RUN_ENVIRONMENT |
| E17 | Desktop ↔ Android QR 配对→presence/manifest→撤销权限 | test-mesh-pairing-interop | NOT_RUN_ENVIRONMENT |
| E18 | 长对话 500 消息+持续 streaming+history paging+后台刷新，不闪烁 | test-desktop-chat-virtualization;test-m6-pure-core-sea | NOT_RUN_ENVIRONMENT |
| E19 | 升级安装新 RC→旧会话/Memory/Task/Plugin/信任/安装路径均保留 | test-release-candidate;test-desktop-install | NOT_RUN_ENVIRONMENT |
| E20 | 卸载保留数据→重新安装→旧状态可恢复 | test-desktop-install;windows-sandbox/output/sandbox.log | NOT_RUN_ENVIRONMENT |
| E21 | 多 Provider 一个离线→其它 Model 可用、Chat 不冻结 | test-standalone-model-path | NOT_RUN_ENVIRONMENT |
| E22 | Windows Codex CLI .cmd+代理/自定义登录+不同 Task 模型隔离 | test-agent-provider-expansion;real-codex.log | NOT_RUN_ENVIRONMENT |
| E23 | DSH Desktop 安装但 Web API 未鉴权→不显示 Agent Ready | test-dsh-connector-m3 | NOT_RUN_ENVIRONMENT |
| E24 | 外部恶意插件/网页/模型输入不能越过 Capability 审批或窃取秘密 | test-phase1-security;test-agent-test-run-security;test-process-extension-sea | NOT_RUN_ENVIRONMENT |

## 7. AC-001–AC-040

旧契约缺口保留审阅，M4 Channel持久Journal不能证明Codex原生Follow跨重启重放；Channel同ID冲突拒绝不能替代所有Agent seq/payloadHash契约；没有把CM-Agent草案升级正式标准。

| AC | 原场景 | 本轮覆盖边界 | 原生完整验收 |
| --- | --- | --- | --- |
| AC-001 | 无CLI/仅GUI/WSL/远程服务 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-002 | 应用启动后安装CLI并刷新 | 仍缺完整机制或验证，不关闭旧缺口 | BLOCKED（契约/证据待审） |
| AC-003 | npm cmd shim、中文空格路径、SEA | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-004 | 协议无交集/未知major | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-005 | 实际CLI变更但缓存PASS | 仍缺完整机制或验证，不关闭旧缺口 | BLOCKED（契约/证据待审） |
| AC-006 | 认证失败/过期/权限撤销 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-007 | ACK前先来start/delta/end | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-008 | 同native会话连续三轮不同问题 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-009 | bootstrap与user双回合 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-010 | Task+Chat两个订阅者 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-011 | Task+Chat+Continuity三个订阅者 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-012 | 晚订阅和慢消费者 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-013 | 重复seq同payload | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-014 | 相同seq不同payload | 仍缺完整机制或验证，不关闭旧缺口 | BLOCKED（契约/证据待审） |
| AC-015 | 断线乱序/队列溢出/seq缺口 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-016 | 没有turn/end直接EOF | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-017 | 重启后的合法旧journal重放 | 仍缺完整机制或验证，不关闭旧缺口 | BLOCKED（契约/证据待审） |
| AC-018 | terminal先到history后到 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-019 | Tool Calling成功/partial/error/cancel | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-020 | 500+消息/展开工具/窄窗/DPI | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-021 | 取消请求受理但原生仍工作 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-022 | 取消不支持或超时 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-023 | 模型伪造actor/taskId/grants | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-024 | 源Agent被切换后迟到导入 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-025 | 审批通过后权限/源Session改变 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-026 | 正文含DSML/XML伪调用 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-027 | 同轮部分工具等待审批 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-028 | 读任务与写任务共存 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-029 | 失联Task仍Running | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-030 | 新建/受理/执行后不同点kill | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-031 | 非Git目录/磁盘满/只读目录 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-032 | 源停止失败/目标初始化失败 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-033 | history写失败/latest缓存写失败 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-034 | 两次同时切换与并发取消 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-035 | 不使用Agent但已有Task或模型task.create | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-036 | 无QQ/DSH/插件启动纯Core | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-037 | QQ preset损坏/插件崩溃 | 相关夹具通过；覆盖局限见逐项CSV | NOT_RUN_ENVIRONMENT |
| AC-038 | 用户改过preset/旧新数据并存 | 相关夹具通过；覆盖局限见逐项CSV | BLOCKED（真实资料未授权） |
| AC-039 | 升级中断/portable/per-user/卸载重装 | 相关夹具通过；覆盖局限见逐项CSV | BLOCKED（真实资料未授权） |
| AC-040 | 真实Codex↔DSH↔Managed首轮与重连 | 仍缺完整机制或验证，不关闭旧缺口 | NOT_RUN_ENVIRONMENT |

## 8. M0–M6阶段验收矩阵

| 阶段 | 当前状态 | 本轮证据与边界 |
| --- | --- | --- |
| M0 | COMPLETE（继承） | 复用真实库存与依赖报告；只核对提交链/相关运行路径，不冒充新全仓审计 |
| M1 | COMPLETE（继承） | 363方法台账保留，AUD/Follow/消息提交夹具重新运行 |
| M2 | PARTIAL | 正式SEA独立Core/OwnerIPC及互斥通过；Legacy-exclusive完整兼容宿主仍保留，未与正式模式双活 |
| M3 | PARTIAL | DSH目的/preset/Follow/Managed切换夹具通过；真实Coding/原生版本兼容未闭环 |
| M4 | CODE_COMPLETE / E2E_PENDING | SEA Connector/Bionic和受限Broker链通过；真实QQ未授权/未验收 |
| M5 | A/A.1/A.2完成；B BLOCKED | 8项Social Hash不变；2根cursor不可恢复；停止ACK/真实备份/生产resolver未具备；本轮未迁移 |
| M6-A | 可执行自动化/发行集成已验；完整真实验收未完成 | 全量/RC/VM子集见表；普通用户干净系统、Harbor/原生服务仍待环境或Owner |

原生状态：Codex CLI0.163.0-alpha.10.2、已登录，隔离只读Task被沙箱拒绝；DSH CLI0.1.5-rc.1、TCP3080可达，当前API认证/运行服务版本未核验，不显示Task Ready；QQ只有受控Fixture通过，不宣称真实OneBotReady。详细P0/P1见 WHALEBRIDGE_M6_REMAINING_BLOCKERS.md，Windows范围见 WHALEBRIDGE_M6_WINDOWS_ACCEPTANCE.md。

没有真实资料备份/迁移、Epoch切换、释放未知锁、覆盖DSH preset、全局改名、push、合并main或发布Stable。完成本轮后停止，等待Owner验收。最终HEAD见文档提交历史/交付答复。

本轮最后新增的是测试helper修正，不是生产Core鉴权变更。Core/Host/Harbor/构建脚本与正式产物sourceCommit的生产输入diff=0；源码及产物SHA复核见最终证据JSON。

## 9. 本轮修改文件与提交

| Commit | 实际修改及目的 |
| --- | --- |
| 847d9f671d660465b25fbf427a07c1f6817157af | release/version.json：M6 Build1082基线 |
| 9b4d4cc756796a49f828b783906c2f8796e05879 | 新增生产SEA测试并登记聚合器 |
| 868e6114721afd0825875cd39f6cb4adc99098ef | scripts/build-desktop.mjs、test-desktop-runtime-dependencies.mjs、test-desktop-shell.mjs、run-all-tests.mjs、release/version.json：CRT及测试竞态，Build1083 |
| 8dc4159a2a2c18ad3248bd4e7f32c2b1e34e3dfa | scripts/package-installer.mjs、test-installer-package.mjs、release/version.json：IExpress路径修复，Build1084生产来源 |
| fba9bbab233941aa1f496820053e32ab1a891f02 | scripts/test-installer-package.mjs：保留空格的有界测试目录 |
| bca4c57dff36b957d4652ac4ca6990f8a15ecc3e | scripts/test-core-dist.mjs：鉴权成功才就绪及确定性红绿反例 |

新增SEA测试修改 scripts/test-m6-pure-core-sea.mjs、scripts/run-all-tests.mjs。以上之外交付提交仅含本轮报告、验收矩阵、脱敏证据与PROJECT_STATE；最终HEAD以交付答复/Git日志为准。
