# COMM-01～13 通信、审批和生命周期集中修复

> 后续集成授权（2026-10-21）：Owner 已明确指示“合并提交推送”。以下“未提交/未推送”和 dirty=true 描述为修复交付与 DEV 构建时的历史事实；本次按授权提交、快进合并并核验远端。不重写 DEV 包的旧 sourceCommit/Hash，也不把提交后的源码称为已构建正式安装包。集成结果以最终 Git 提交与远端引用为准。

提交前重新运行全量聚合器（pre-merge-tests.log），并校正新增 input-schema.js 的两处空行格式；无行为变更。上述 DEV 包对应格式整理前的源码字节，不能当成最终提交的正式构建。GitCode main 存在历史分叉（本地基线多 388 个提交、GitCode 独有 1 个），本次仅普通快进推送 origin/main，不强推 GitCode。

提交前复核又发现 `test-service-container` 重复运行受旧测试状态污染（pre-merge-tests.log：145 PASS / 1 FAIL / 8 NRE）。根因是 Desktop 为取得固定名单导入 Integration service，间接提前初始化 APP_PATHS，使测试设置的独立数据根未生效。将名单移至无运行时副作用的 catalog；新增 settings store 必须位于临时根的断言，保留默认工具能力为 false 与显式 opt-in 的全部断言。相关三套回归通过；没有清空状态使测试变绿，也没有改写用户数据。该误写范围为本轮新建修复工作树中的忽略 state 目录，未自动清理未知内容。

最新验证包另增 Build1114，不覆盖历史 Build1113。Core/Host/DEV 构建日志及全量结果另存 `core-publish.log`、`desktop-publish.log`、`debug-publish.log`、`release-publish.log`、`publish-tests.log`、`results-publish.json`。输入指纹（316项）`0cc52b82db2346496f707e96cfd1a25a622dd0c612b26b9d71dd75854af13578`，明细 source-snapshot-publish.json。DEV 安装包 43,479,040 字节，SHA256 `201373499A5BE24EC819EC0379D38A8794A454EDD965B8F4D198E8CC7D14E356`，Authenticode NotSigned；sourceCommit 仍为原基线且 dirty=true，不能冒充最终提交的正式构建。

最新全量命令为 `npm test -- --verbose --jobs 4`；核对 runner 后确认其当前仍按串行执行，未将参数接受误报成并发调度已生效，也未为缩短时间改写聚合器或删除用例。

最新提交前完整验证：**146 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT，exit 0，约639秒；Rust 199 PASS / 0 FAIL**。Build1114 Core/Host/debug/DEV 构建均 exit 0，DEV 安装版集成已运行通过。构建后的 316 项生产输入重新核验一致。以上为 publish-tests.log / results-publish.json 的实际结果；pre-merge-tests.log 的一次失败保留，不混淆为最终结果。此后仅补充授权及验证文档，未再改产品逻辑。

日期：2026-10-21（Asia/Shanghai）。本轮结论：源码修复与隔离验证；全量统计见文末。本轮不自动提交、合并、推送、部署或发布。

## 1. 基线、工作树与输入

- 开始/结束 HEAD：`63f6155718e4ef7cbc182bd6b4debcde0f1faeb1`。尚未提交，HEAD 不变不代表没有修改。
- 修复分支：`codex/comm-01-13-repair`；隔离目录：`D:/GIT- CetaMesh/comm-repair`。
- 原入口 `D:/GIT-QQ-BRIDGE` 是旧 UI 设计工作树，带既有 staged/unstaged 修改；没有在其中实施修复。
- `product-context-main-merge` 的两份既有未提交文档保留；已安装 1111 未覆盖、未关闭。
- 当前本地 main 就是审计基线，没有回退分支、fetch/合入远端更新或清理用户修改。
- 已读取本次实际存在的两份审计/修复 Markdown 及 ZIP 清单。ZIP SHA256：`657747c55f867130b0a071ae1e1b16beada0ccd3b9948ec81a90d157662e6eea`。
- ZIP 内 `excerpts/` 与探针是历史存在性参考；本轮没有把它们的成功退出当成产品通过，而是新增生产模块/装配回归。
- 版本 `1.0.0-rc.2`，最终开发 Build `1113`，使用既有版本工具递增。1112 为首轮验证包；后续生产修复重新构建 1113，不沿用旧包证据。最终工作树为 dirty，新增源码/测试尚未跟踪。
- 最终产品输入指纹与逐文件 SHA256：`D:/GIT- CetaMesh/comm-evidence/source-snapshot-final.json`，316 项，指纹 `226c0150c216d052ed92e1ba4e1b071029b98238257930c0551a915b3c81798f`。包括未提交新增生产文件，不能只拿旧 HEAD 代表本次源码。首轮 source-snapshot.json 证据保留。

## 2. 第一组：审批、暂停、长执行、取消

### COMM-01

根因：审批绑定 `task.rev`，Task Follow 写普通进度也增加 rev。旧 policy 还可能拿持久化 actor 的旧 grants 授权。

修改：Task Store 在既有 JSON 中维护 `authorizationRevision`；仅目标/要求、状态、Workspace、Agent 分配、模型配置、Owner 上下文等授权相关变化推进代次。进度、报告、工作证据和 checkpoint 不推进该代次。v2 binding 继续绑定 Workspace、Provider/Session、当前 grants 指纹和已审请求指纹。旧 v1 Task 审批不自动迁移授权，必须重新确认。分配离开再回到原 Session 也不会复活旧审批。

动态复核又发现异步 validate 期间撤权/取消仍可派发。Broker 现于 validate 后和真正执行前重新核对当前注册条目、权限与 signal；默认 AbortError 的数字码不再冒充领域错误码。

证据：`test-comm-approval` 先复现 APPROVAL_EXPIRED 与撤权竞争副作用，再验证进度/重启、终态/暂停/阻塞、Workspace、grants、输入篡改、旧审批与离开再恢复均按预期处理。既有安全限制未移除。

### COMM-02

根因：`waiting` 被 Task Follow 当作终态，递减 expectedTurns 并退出。生产三轮测试还发现第二次审批续跑丢失 `targetKind`，误路由 Chat，出现 SESSION_NOT_FOUND。

修改：waiting 只保存游标，不消耗终态；真正结束才计数。有限缓存保留已结束回合身份，独立消费者仍各持有游标。Coordinator 恢复保留 agent/chat 目标身份；bootstrap/internal phase 过滤和原有报告证据等级不变。

证据：`test-comm-managed-turns` 贯穿真实 createCetaMeshServices、Managed Agent、Chat/UI、Broker、Task Follow、工作记忆。三轮复用 Task/Session，其中一轮两次独立写审批，各自经历三次进度更新。验证三份独立 run/report、两写一读完成证据、三条正确 Scope 的工作记忆，以及重复终态不重复生成回复。只替换模型叶节点，没有替换路由/审批/投影。

### COMM-04

根因：审批 RPC 同时等待工具与后续模型恢复，超过 IPC 期限后 UI 无法判断副作用结果。

修改：所有外部 Owner IPC 与 Harbor 的审批决定先返回 accepted 和稳定 operationId。既有 Capability 域增加有界持久操作记录；长执行由 Core 持有，提供查询、事件和显式停止。内部可信服务保留 awaited decide 兼容接口，但不用于传输等待。重复同决定返回原操作，改决定拒绝。重启的 accepted/running/waiting 记录转 unknown，不重放。结果记录只持久化最小状态，不复制整份工具返回。

Harbor 类型、窄方法、Rust 白名单和操作状态区同步更新；Native Security 同意流程必须查询授权操作完成后再检查当前授权。前端断线不等于 Stop。Task/Chat 停止会取消属于该任务/会话的操作；不确定结果不能伪报任务已取消。

证据：`test-comm-approval-operations` 通过实际 framed IPC→runtime→UI→service，真实 gate 阻塞超过测试传输期限 100ms，仍已返回接受并可查询。额外前进 61 秒为模拟时钟，**不是实际等待 61 秒**。实际断开协议连接后只执行一次；预取消、未知结果和重启禁止重放均验证。`test-comm-approval` 验证取消到达审批后的真实 Managed 模型叶节点。

### COMM-05

根因：Runner 不接收操作信号，旧 Windows 终止失败会被吞掉，POSIX 只杀直接进程。

修改：信号贯穿 Broker→test.run→Runner；工作区异步解析后及实际 spawn 前再次检查。只终止本次拥有的 Windows PID 树或 POSIX 独立进程组；收到真实 close 且终止已确认才返回 cancelled。无法确认返回 unknown，保留命令白名单、最小环境和每次审批。

证据：`test-comm-runner` 在临时 npm 项目中启动实际子孙进程持续写标记；取消后不再写，另一个并发项目正常完成。覆盖预取消、解析竞争、超时/取消/自然完成竞争及无法确认终止。Windows 已实测，POSIX 分支本机未执行。

## 3. 第二组：事件与关闭

### COMM-06

Core 和 Legacy 统一使用幂等可等待关闭 Promise，按反向依赖顺序、有界等待各资源，报告 completed/failed/timed_out/skipped。先拒绝新请求，等待自有 IPC/data/HTTP sockets、Agent/Chat 原始异步工作、MCP/Extension、QQ/Bionic、Mesh 和状态保存，最后释放 owner。resolved `{ok:false}` 也视为不确定清理。清理失败时保留活跃 owner 和锁，不允许 PID 消失后的错误接管。

Legacy API shutdown/restart、信号、stdin EOF/错误、HTTP/data/UI 错误均接入；删除退出时扫描并终止外部 start.bat 的旧行为。没有终止真实用户进程。原生 Native Adapter、发送账本、账号锁不重写。

证据：`test-comm-lifecycle`、`test-comm-legacy-shutdown`；真实延迟清理子进程、实际隔离 Core/Legacy、挂起/失败 handler、顺序/锁、重复 stop、信号/EOF/数据错误、Mesh 关闭、Chat/Managed 清理 gate。修复后的 close 等待实际底层 promise，不只等快速取消 ACK。未增加新的定时轮询或修改错误规范基线。

### COMM-07

按实际 JSON UTF-8 字节、合法最大 request id 转义、协议封装和 4 字节头计算响应预算。事件游标只推进到已返回项；大合法 delta/replaceText 有序分片并保留代理对边界；非法超大单项受控拒绝。缓存淘汰明确 reset/gap，真实 typed-client 消费后恢复权威快照。Chat 原始和 UI DTO 历史分别计算双向分页预算。

证据：`test-comm-event-budget` 使用实际 startIpcProtocol 序列化，12×32k 中文/ASCII/Emoji/转义文本、95k delta、256k replacement、多会话、gap、最大 request id、32 条历史双向全量 ID 与密集 UI DTO 分页。每帧含头部不超 1MiB，没有提高 IPC 限额。历史中原有长文本预览限制仍保留，未把预览称为原始完整正文。

### COMM-12

白名单明确保留 turnId/messageId/historyRevision 与最小 Channel 事件字段；不透传原始事件或凭据。Channel 真实入站/发送结果生产者补上 account/channel/request/message 标识。Harbor 当前账号活动与审批操作事件可见；账号变化清空局部视图，避免混入另一账号。未提交的 streaming 不伪造已持久化消息身份。

证据：实际 Chat finalize→持久消息→bus→framed IPC，核对落盘 revision；真实 typed-client gap 恢复；敏感字段剔除测试。Harbor 恢复继续读取所有 forward continuation 页，逐页核对会话代次；游标不前进/循环明确报错，最多 1000 页后提示继续刷新，不把未读页当成完成。真实 QQ Harbor 收发仍需授权账号验收。

### COMM-13

JSONL 不再把底层合块长度当单帧长度。帧含换行计限额，严格 UTF-8，单个固定接收缓冲区；尾部、在途请求、待响应与写队列分别有界；断线只清理一次。

证据：`test-comm-channel-mesh` 的 1,048,384 + 1,085 字节两合法帧，在 64KiB/随机/逐字节/合块四种分割下结果一致；中文跨块、畸形 UTF-8/JSON、超限、积压、pending 断开均验证。

## 4. 第三组：工具、可选模块与恢复

### COMM-03

包装外层保持严格；仅嵌套 input 显式允许有界 JSON。共享校验器保持默认拒绝未知字段，Integration 在审批前与执行时校验真实工具 Schema、开关、风险 capability、输入/Schema Hash。模型不能把 read wrapper 用于 admin 工具，也不能注入 actor/grants/Workspace 等字段。

证据：`test-comm-integration` 真实生产 Model→Coordinator→Broker→Integration→末端 fixture；合法 query 真实到达；错误类型/缺失/越界/权限注入/未知目标/篡改/Schema 变化拒绝；高风险通过审批只执行一次。MCP tools/list 成功没有被当成调用成功。

### COMM-08

正式默认服务容器绑定现有 Channel/Bionic 的固定管理 adapter。构造不启动 QQ/Bionic，仅查询健康。Harbor 原窄管理路由可达 health/start/stop/reconnect，Bionic 独立 health/start/stop；支持动作按实际描述符显示，不显示没有实现的配置保存能力。状态区分 running、ready、authenticated、canSend，未知安装/配置保留 null。

证据：`test-comm-controls` 先在默认生产装配（不额外注入 localServices）复现 actions=[]，接线后可发现、调用并保持默认停止；控制参数无法覆盖 actor/method/配置。UI 管理服务名单由 Integration 域提供，Desktop 不直接依赖 QQ 后端；action 的结构化 lastError 仅投影 message。真实 OneBot 登录、接收和审批发送、Owner Windows GUI 点击未运行，不据此称真实收发通过。新装无 wsUrl 的实例仍需既有配置入口，本页不提供尚未实现的 configure；这是配置能力限制，不是 QQ 已 Ready。

### COMM-09

恢复已启用且既存可信配对的 TLS 监听，不随一次性邀请生命周期消失。首次未配对节点不自行开放监听。使用已存证书/稳定端口，端口占用明确错误而不改到错误端口。禁用关闭，重新启用恢复；业务执行器缺失继续 fail-closed，没有新增跨设备 Task/Memory/审批同步。

证据：真实本地 TLS 双端配对、重启不新建邀请、禁用/启用、邀请取消/过期、占用端口及恢复。终态 close 与临时 suspend 分开：close 同步标记 disposed，排队 TLS 初始化/监听及残留设置回调不能重新打开端口；关闭后配对/恢复返回 MESH_CLOSED。新增回归先真实复现旧行为，再验证端口释放与关闭后拒绝。真实手机↔桌面未运行。

### COMM-10 / COMM-11

启用插件在 Core 重建时验证当前受管路径、审核 token、manifest/package 指纹和批准 grants，恢复能力目录但不启动全部 Worker；调用时懒启动。禁用/撤权/损坏项不可执行。版本切换原子替换该插件拥有的 descriptor/Schema/绑定，删除新版移除的能力；回滚恢复旧契约。捕获的旧绑定/旧审批不能执行新版本。

证据：`test-comm-extension` 实际进程 Worker 的安装审核/重启发现/懒启动、v2 必填字段、删除能力、回滚、禁用/撤权/损坏、升级中授权 gate。既有相关测试同步验证新契约，未删除原有断言来隐藏失败。

## 5. 修改和测试范围

实际列表及统计以最终 `git status --short` / `git diff --stat` 和本目录报告补充为准。

最终内容 diff 为 41 个已跟踪文件、1052 行新增/379 行删除；另有 5 个新生产模块、13 个新登记测试及本轮 3 份报告。package.json/package-lock.json 在版本工具运行后仅有换行变化，因此 status 显示 M 而内容 diff 不计入 41。完整路径和状态保存在 comm-evidence/git-status-final.txt 与 diff-stat-final.txt；没有 staging 或 commit。

|修改组|具体文件/入口|
|---|---|
|授权及异步审批|src/task/store.js；src/capability/{policy,broker,registry,service,operations}.js|
|Managed / Model 续跑|src/agent/managed-agent-provider.js；src/model/{tool-execution,input-schema}.js|
|关闭与进程取消|src/app/{bootstrap,core-worker,ipc-runtime,lifecycle,legacy-shutdown,service-container}.js；src/bridge.js；src/workspace/isolated-runner.js|
|IPC/事件/历史/UI|src/control/{ipc-protocol,response-budget}.js；src/desktop/{chat-service,ui-service}.js；desktop-ui/src/app/{HarborApp.tsx,chat-history.ts}；desktop-ui/src/bridge/typed-client.ts；desktop-shell/src/webview_policy.rs|
|QQ/Bionic 与 Integration|src/channel/{service,desktop-controls}.js；src/channel/qq/process-link.js；src/integrations/{service,catalog}.js|
|可选模块恢复|src/mesh/{node,service}.js；src/extension/runtime.js|
|构建与测试|release/version.json；scripts/run-all-tests.mjs；13 个 scripts/test-comm-*.mjs；相邻现有契约测试（详 git-status-final.txt）|

- 新增回归全部登记 `scripts/run-all-tests.mjs`，统一通过 `npm test -- --suite ... --verbose` 执行。
- 相邻旧测试只更新真实契约变化：审批接受后查询最终状态（原恰好一次、同回合、历史/事件断言保留）；真实 fixture 工具参数 Schema；异步关闭等待；禁用插件不再保留可发现 descriptor。
- 未修改 `scripts/error-hygiene-baseline.json`，未删除测试、放宽权限/审批或通过 continue-on-error 隐藏失败。
- 模块通信矩阵见 `COMMUNICATION_MODULE_MATRIX.md`；逐项状态见 `COMM_REPAIR_STATUS.md`。

## 6. 构建、全量统计与证据

最终全量：**146 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT，exit 0**，154 suites，约 623 秒；其中 144 个 Node 套件通过 + cargo:check/cargo:test 两个虚拟套件通过。Rust 实际 **199 PASS / 0 FAIL / 0 ignored**，并非只用虚拟套件数量代替测试数量。新增 13 个 test-comm 套件全部执行并通过。

所有证据位于 `D:/GIT- CetaMesh/comm-evidence/`。首轮 all-tests.log 的 **138 PASS / 8 FAIL / 8 NRE，exit 1** 保留；最终 all-tests-final.log 与 results-final.json 单独存档。首轮失败分别为两个审批调用方过早断言、Desktop 后端名字耦合、历史新字段契约、旧 supervisor 静态断言、绕过安装的插件 fixture、MCP fixture Schema 不符、跨任务拒绝顺序。修正了生产边界或 fixture 契约；旧真实行为断言保留。没有拿最终统计覆盖首轮失败。

|实际命令/入口|最终结果|证据|
|---|---|---|
|npm test -- --verbose（CARGO=1，NETWORK=0）|146 PASS / 0 FAIL / 8 NRE，exit 0|all-tests-final.log、results-final.json|
|npm run build:ui|tsc + Vite PASS，exit 0|ui-final.log|
|npm run build:core|SEA PASS，exit 0|core-final.log|
|npm run desktop:build|release Host PASS，exit 0|desktop-final.log|
|npm run desktop:build:debug|debug Host PASS，exit 0|debug-final.log|
|cargo check/test（经 npm test 聚合器）|check PASS；199 测试 PASS，exit 0|all-tests-final.log|
|npm run build:release -- --dev --use-current-build-number|DEV Build1113 PASS，exit 0|release-final.log|
|现有 RC verification 全断言（test-comm-dev-release 复用 test-release-candidate）|DEV 包隔离安装集成 PASS，26.7 秒；正式 RC 仍 NRE|all-tests-final.log|
|最终聚合器小回归：test-comm-controls + test-error-hygiene|2 PASS / 0 FAIL / 0 NRE，exit 0|aggregator-final-check.log|

首轮正式 build:release（不加 --dev）exit 1：dirty source 安全拒绝，日志 release.log。没有通过提交、伪造 sourceCommit 或放宽门禁绕开，也没有重复尝试同一已知门禁。最终自动化 0 FAIL 不代表该正式发行门禁已满足。

8 项 NRE：test-codex-chat-snapshot / test-phase3-real-codex（未启用授权 real-codex 测试）；test-console（未开启真实 Legacy 测试）；test-mcp-exec / test-onebot-connection（隔离工作树无获授权的 gateway 配置/环境）；test-mcp-web-search（公网测试关闭）；test-desktop-runtime-dependencies / test-release-candidate（无 clean-source 正式 release-dist）。这些均不计为 PASS，DEV 包没有冒充正式 RC 环境。

Node v24.19.0、Windows x64、cargo 1.98.1 / rustc 1.98.1；无远端 CI。日志内 Vite SSR 测试关闭后的 dep-scan “server closed” 诊断及既有 Rust unused 警告保留；构建/断言退出结果如上，没有隐藏日志来获得 PASS。

- 已执行 npm run build:ui（含 tsc）、npm run build:core、npm run desktop:build、npm run desktop:build:debug。
- 因源码未提交，正式 npm run build:release -- --use-current-build-number 被干净源码门禁拒绝；这是本轮禁止自动提交导致的明确门禁，不能标为正式构建成功。
- 使用既有 `--dev --use-current-build-number` 生成 channel=dev / dirty=true / `.DEV` 的本地验证包。DEV 包复用原安装版测试所有断言，单独记录，不替代正式 RC_READY。
- 最终包：`artifacts/dev/1.0.0-rc.2/build-1113/CetaMesh-Setup-1.0.0-rc.2-build1113-x64.exe`；43,479,040 bytes；SHA256 `66856F4FBBCC852A9E48008EF4877EEF99D7319DC83058ED438BFF1D4D317F48`；Authenticode `NotSigned / SIGNING_PENDING`。
- build-info：`1.0.0-rc.2-build1113+63f6155.DEV`、sourceCommit 为开始 HEAD、dirty=true、win32-x64。禁止项/构建路径审计通过；与真实 config.json 的凭据比对因隔离工作树无该文件而 skipped，不能称其已验证。正式更新签名/公钥信任链未重新验收。
- 真实 Codex/DSH/QQ/手机与签名/更新链仍未完成。本轮不访问真实账户发送、不迁移真实数据、不修改 DSH Preset，不结束真实 Core/Legacy。

## 7. 剩余验收与下一步

1. Owner 审阅当前 dirty 修复和测试结果；本轮不提交。
2. 获得单独授权后提交，并从干净源码重新构建正式 RC，复跑发行测试，不能直接发布本轮 DEV 包。
3. 授权测试环境中完成真实模型、Codex/DSH/Managed 交接、QQ Harbor 管理与收发、手机 Mesh，以及 Windows 普通用户 UI 验收。
4. 正式签名与更新可信链仍遵循原门禁，M5-B 真实迁移仍未授权。

整体仍为 **RELEASE_BLOCKED**。本报告区分源码修复、自动化验证和真实环境验证，不声明绝对零 BUG 或所有模块已经真实联通。

## 8. 九条整体链路的证据边界

|链路|本轮实际执行|证据/限制|
|---|---|---|
|Managed 三轮、两审批、进度、Task/Chat/Memory|生产装配 + 合成模型，VERIFIED_FIXTURE|test-comm-managed-turns；模型叶节点不是公网模型|
|包装入口带参数 MCP、读/写审批/拒绝|生产 Model/Coordinator/Broker/Integration + 合成 transport；另有真实 stdio MCP|test-comm-integration、test-mcp-registry；不等于外部用户 MCP 服务全部已测|
|长审批、查询、断线、显式停止|实际 framed IPC + 100ms 测试超时 + 可控执行 gate|test-comm-approval-operations；61 秒为模拟时钟，未声称真实 61 秒等待|
|Runner 自有子孙进程取消、并行任务|实际 Windows 进程树|test-comm-runner；POSIX 路径实现但本机未运行|
|长中文/Emoji、慢订阅、历史恢复|实际生产 bus/framed IPC/typed-client，恢复 helper 及分页|test-comm-event-budget；完整 Windows WebView2 视觉交互未操作|
|插件重启发现、升级/回滚、旧授权|隔离安装目录 + 实际进程 Worker|test-comm-extension、test-extension-runtime；不是第三方任意插件兼容承诺|
|Harbor QQ/Bionic 管理 + Mesh 恢复|默认 Core 管理装配 Fixture；实际本地 TLS 双端|test-comm-controls、test-comm-channel-mesh；真实 QQ GUI 和手机链路 NOT_RUN_ENVIRONMENT|
|同 Task 真实 Codex/DSH/Managed 交接|NOT_RUN_ENVIRONMENT|本轮未授权真实账号/项目及外部任务；既有合成 Continuity 回归不代替此项|
|多模块活动退出/重启及所有权|实际隔离 Core/Legacy 子进程 + 可控 Chat/Managed gate|test-comm-lifecycle、test-comm-legacy-shutdown、test-desktop-supervisor；清理失败保留 owner，不停止用户运行实例|

## 9. 已知限制与未隐藏的问题

- 旧 egui 兼容 UI 的审批响应仍仅提示“决定已提交”并刷新队列，没有 Harbor 的 operationId 状态面板；它没有把 accepted 宣称为执行完成。默认 Harbor 才是本轮完整操作追踪入口。
- operation journal 当前上限 1000 项，达到上限会明确拒绝新接受操作（OPERATION_CAPACITY），不静默删除历史或重放旧审批。
- 新 QQ 实例没有连接配置时，集成页如实禁用 start；本轮没有新增真实凭据配置写入器，不应将“bundled Connector 已安装”等同“账号已配置/登录”。
- 正式 RC 构建门禁仍要求 clean source；DEV 安装版测试不证明 Windows 普通用户 GUI、签名、更新可信链或真实外部 Agent 可用。
- CI 配置已读取：Windows / Node 22 / Rust stable，常规任务跑聚合器，发行 job 仅 main push 或手动。没有触发远端 CI。新增 DEV 包套件单独依赖 dev-release-dist，不要求普通 CI 凭空存在本地 DEV 包；原正式 release-dist 门禁保留。
