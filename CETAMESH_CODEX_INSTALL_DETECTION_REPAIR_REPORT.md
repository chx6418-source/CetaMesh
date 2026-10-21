> 2026-10-19 更正：用户截图证实Build1095普通启动仍误报。此前原生验收继承CODEX_CLI_PATH，不能证明自动发现完整；本报告保留为历史记录。最终Build1096无覆盖复现、修复与原生验收见 [CETAMESH_CODEX_DESKTOP_DISCOVERY_FOLLOWUP.md](CETAMESH_CODEX_DESKTOP_DISCOVERY_FOLLOWUP.md)。

# Codex CLI 安装检测专项复现、修复与回归报告

## 范围与基线

- 按 Owner 授权执行桌面专项指引；旧文档 e8965be 仅作历史线索，以当前代码复现为准。
- 起点 f8424a93162736f7d2636240bf0cae791f4e3cb6，包含 Build1091 全部修复。
- 分支 codex/codex-cli-detection-repair；产品最终源码 745362672f388909c2d1abf5a00743bd97b7ccca，Version 1.0.0-rc.2 / Build1095。
- 保留根目录设计分支及其未提交文件；没有 push、merge、Stable、Tag、真实数据迁移、账号/凭据/Preset写入。
- FINAL_STATUS: RELEASE_BLOCKED。检测正确与真实 Task 成功分别验收。

## 逐项结论

| 编号 | 实际根因 / 现有证据 | 处理与状态 |
| --- | --- | --- |
| CDEX-01 | findCliExecutable 缺少官方 standalone 路径，空PATH有exe仍返回null；7个初始反例均失败 | 受限候选包含 LOCALAPPDATA/Programs/OpenAI/Codex/bin、CODEX_INSTALL_DIR和受控绝对CODEX_CLI_PATH；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-02 | Provider克隆环境；初始未安装状态后无法发现新独立安装 | CLI发现与启动环境分离，envSource可实时取值；强制refresh重建候选并绕过TTL；真实createCetaMeshServices及SEA同一进程安装后刷新通过；FIXED_CODE / VERIFIED_RELEASE_INTEGRATION |
| CDEX-03 | 旧UI未解释集成对象；Sandbox拒绝也可能投影ready | Codex CLI诊断卡区分安装/协议/登录/Sandbox/Task；Desktop/IDE不等于CLI；已知Sandbox拒绝投影not-supported，任务不可用；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-04 | shim版本失败上层统一unsupported，没有Node/未知shim诊断 | 保留安全npm脚本解析和SEA禁止充当Node；准确传递NODE_RUNTIME_UNAVAILABLE、UNSUPPORTED_WINDOWS_SHIM；未知pnpm布局拒绝，不运行任意cmd；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-05 | where/PATH只返回第一个存在的程序，坏候选遮蔽正常CLI | 按受限来源列举候选，逐个版本/帮助/exec协议验证；显式路径失败不回退；原生优先shim；where的CWD-only结果拒绝；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-06 | capabilities捕获启动时动态状态，其他消费者读旧值 | 静态协议仍走原contract；为兼容既有消费者保留动态兼容字段，但每次capabilities从同一inspection投影，不冻结启动快照；agent.list/health仍走既有Broker；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-07 | Agent目录统计和筛选只看Chat eligible | isAgentReady=chat eligible或taskEligible；标签改可用Agent，保留独立任务数及仅工作区任务说明；Chat选择权限不扩大；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-08 | 首次Sandbox unknown无法自动选择；已有明确选择Task允许验证、false拒绝路径 | 保留现有路由栅栏：unknown不自动执行，Owner明确选择Task可验证；成功后才自动；false仍拒绝。新增CLI身份/版本变化清空旧证据，回合绑定探测世代，A→B→A迟到完成不能置true；VERIFIED_FIXTURE；真实Task NOT_RUN_ENVIRONMENT |
| CDEX-09 | version/help/exec-help/login错误丢失相位和稳定码 | 有界installKind/probePhase/probeCode/detectedVersion/checkedAt/requiresStandaloneNode；Owner DTO只投影安全字段，不输出CLI绝对路径、PATH、凭据或stderr；FIXED_CODE / VERIFIED_FIXTURE |
| CDEX-10 | 无真实Windows用户现场和完整Task成功证据 | 本机真实版本/鉴权及打包SEA健康可验证；完整Task被Windows原生Sandbox拒绝，保持NOT_RUN_ENVIRONMENT，不能关闭沙箱换PASS |

官方路径依据：本轮读取OpenAI官方安装脚本 https://raw.githubusercontent.com/openai/codex/main/scripts/install/install.ps1 ，defaultVisibleBinDir 与 CODEX_INSTALL_DIR 定义与上述候选一致。

## 安全边界与明确限制

- 不执行cmd/bat本身、不启用shell:true、不导入任意API凭据。命令探测仍使用最小环境；代理与OpenAI环境授权策略不变。
- 不扫描WindowsApps受保护包目录，不绕过ACL。只接受Owner明确路径、PATH和既有/官方固定候选；where只能补充这些来源内的文件。
- 显式CODEX_CLI_PATH必须为存在的绝对exe，失败不会悄悄改用其他CLI；配置说明不意味着自动安装软件。
- 正常health沿用30秒TTL，refresh:true绕过缓存。刷新重新查已授权候选；未导入Windows注册表全量环境。若自定义安装器只修改注册表PATH、目录不在已知候选且Core仍持旧环境，应明确配置CODEX_CLI_PATH后启动Core；没有声称能动态发现所有第三方布局。
- 不添加Codex Desktop App私有API接入，不把桌面App存在等同CLI可执行。
- Sandbox证据属于当前CLI路径/版本和探测世代；旧进程的成功或拒绝不能污染新世代。Task/Workspace staging、审批、导入、Follow、Task身份不重写。
- 完整原生Task E2E仍未通过，检测和UI通过不改变RELEASE_BLOCKED。

## 复现与回归证据

- 新 scripts/test-codex-discovery.mjs 登记现有聚合器。初始7反例全部红灯；生产服务刷新、显式路径失败、坏候选、Node缺失、未知shim、help相位、CWD来源、CLI身份变化、旧运行A→B→A、Sandbox拒绝徽标均有反例与绿灯。
- 现有test-agent-provider-expansion增加CLI切换重验；保留真实staging/Broker审批/取消/导入/Follow隔离测试。
- 现有test-harbor-agent-setup实际SSR组件和Agent页面，检查CLI/App分层文案、Task-only分类、精确诊断；没有仅检查按钮是否存在。
- test-m6-pure-core-sea在真实生产SEA同一Core实例通过Owner IPC验证：原无CLI → 官方路径新增可执行文件 → 强制刷新发现installed=true → 协议不兼容拒绝Task → 移除后installed=false。复制Node二进制只用于可执行但非Codex协议的负例，不作真实CLI成功证据。
- 初始1092全量132PASS/2FAIL/5NOT_RUN_ENVIRONMENT：新增comment-only catch触发安全门禁；旧UI静态断言要求只看Chat eligible。修复catch保留fallback状态；更新三个精确源码期待对应新的overall helper，新增SSR行为及安全负例保留原要求，没有删断言、跳过测试或改baseline。
- 发现旧CLI迟到成功覆盖新Sandbox证据后，追加A→B→A反例先红后绿；成功和失败分支都要求相同世代。
- 中间候选1092/1093/1094及日志仅作过程证据，最终以1095重新执行结果为准，不用旧包通过记录代替。
- 构建曾出现postject Couldn't write executable；磁盘空间充足，文件可写，没有本工作树Core占用，独立相同输入注入成功。瞬时原因未证明；保留诊断日志，不调整构建安全门禁、不杀真实Core，也不把原因猜为杀毒软件。
- 附加SEA健康脚本曾错误转义管道并忽略事件帧，已复用仓库RPC实现；夹具错误单独记录，不计产品通过。原生UI自动化只操作返回列表中明确匹配本轮隔离安装路径的窗口。

## 本地提交

- 1714fb07c54c1b562ebcea11df70509b3407370f：发现/刷新/诊断/动态状态/Agent页面，初始用例。
- b517ac3d4fc59857397ec2750fce9455ad630da8：发现fallback可追踪、旧UI源码契约期待与Build1093。
- 1ec9cfbad53b0ccc42732620cc704f055dec46b8：where来源约束、CLI身份变化清空Sandbox；Build1094。
- 24e2ea4483a1dfca0d99b0ff769b47c7a649752c：迟到回合与探测世代隔离。
- 745362672f388909c2d1abf5a00743bd97b7ccca：Sandbox拒绝UI状态；Build1095。



## 最终验证结果（仅7453626 / Build1095）

- 完整 npm 聚合（WHALEBRIDGE_TEST_CARGO=1）：134 PASS / 0 FAIL / 5 NOT_RUN_ENVIRONMENT，共139 suites。
- 其中Node/JS 132 PASS；Rust desktop:test 199 PASS / 0 FAIL；Cargo check/test 两个聚合suite不重复相加。
- 完整聚合内RC/release分类 12 PASS / 0 FAIL。所有原有release suites实际执行，不以编译成功代替安装验收。
- build:core、build:ui、desktop:check、desktop:test、desktop:build、desktop:build:debug、build:release -- --use-current-build-number 均通过。
- 五个环境suite：test-console(legacy-bridge)、test-mcp-exec(gateway)、test-mcp-web-search(network)、test-onebot-connection(gateway)、test-phase3-real-codex(real-codex opt-in)。另行显式启用真实Codex后仍被原生Windows Sandbox拒绝，0PASS/0FAIL/1NOT_RUN_ENVIRONMENT，不宣称Task成功。
- 过程1094回归因期间继续修正反例并递增版本，发行测试读到尚未构建的1095，出现2FAIL；该跨修订运行作废，不作为最终证据。最终运行期间固定源码、版本和测试，重新构建后从头聚合。原始日志保留，没有删断言或改安全基线。

## 最终安装包与Windows实测

- 安装包：D:\GIT- CetaMesh\codex-detection-verification\CetaMesh-Setup-1.0.0-rc.2-build1095-x64.exe
- bytes：43446272
- SHA256：a2f34cd9cef0277e72ffe8577a4a1b0a988251f25668f947be0f8fd0907c5a74
- sourceCommit：745362672f388909c2d1abf5a00743bd97b7ccca
- buildId：1.0.0-rc.2-build1095+7453626
- dirtySourceTree：false。Manifest 30 files及SHA256SUMS 31 entries全部匹配。
- Authenticode：NotSigned / SIGNING_PENDING。
- 实际使用单文件Setup自解压，再走其正式Host安装入口，专用HKCU key、D盘中文空格路径、独立StateDir、PATH无系统Node。实际Harbor/WebView2显示本机真实Codex CLI 0.163.0-alpha.10.2：已检测、协议兼容、已认证、仅工作区任务；实际点击Codex检查连接完成后仍正确。VERIFIED_RELEASE_INTEGRATION，并有本机真实检测/UI证据。
- 本机真实CLI来自已配置的显式exe，未扫描受保护WindowsApps；这不等于已经证明任意用户仅装Desktop App即可自动发现CLI。官方Standalone无PATH和安装后刷新由受控Fixture及真实SEA负例验证。
- sandboxCapable仍null，UI明确待首次明确选择任务验证；真实Task实际拒绝后不冒称通过。真实在线三轮Task/完整staging import/取消 E2E 未通过；这些安全路径的Fixture通过单列。
- 此为本机非提升测试token，不是独立干净普通用户/VM全向导验收。用户原有安装与运行Core未替换。真实DSH/QQ、更新可信链、正式签名和既有M2/M3/M4/M5门禁保持原状态。
- 两次先前及最终专用测试安装均已卸载；最终Host/Core确认0残留，专用注册表key不存在；合成数据保留。没有关闭真实用户Core/Legacy/DSH/网关或释放未知锁。

## Owner后续最小操作

1. 审阅本分支修复与最终安装包；本轮未合并或push。
2. 在授权的普通用户环境确认安装的是独立Codex CLI；若仅有Desktop/IDE插件，不能据此要求CLI状态为已安装。自定义位置可明确配置绝对CODEX_CLI_PATH再启动Core；无需提供API Key/Cookie。
3. 使用1095隔离安装版点击Codex检查连接，确认安装、协议、登录和Sandbox分层状态；官方默认安装后点击强制检查应无需重启Core。
4. 原生Sandbox能保持所需Workspace限制后，才复验一次性只读Task和完整Task/取消/import；不关闭Sandbox或放宽Broker。
5. 完整真实Windows/外部服务/签名/更新门禁关闭前，保持RELEASE_BLOCKED。

报告后继文档提交不改变安装包sourceCommit。完整脱敏证据见docs/repair-evidence/codex-discovery/verification.json和native-codex.jpg；原始日志在上述D盘专用目录。完成后停止，等待Owner验收。
