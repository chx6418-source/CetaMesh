# CetaMesh 八个 Agent 接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development only if Owner explicitly selects delegation. Steps use checkbox syntax for tracking. Owner 已于 2026-10-22 批准计划并选择委派实施与复核；执行中。

**Goal:** 按批准规格交付可单独验证的八项 Agent 接入，保留现有会话和权限边界，诚实报告不能执行及未真实验证的项目。

**Architecture:** 保留 Agent Broker / Registry / Provider 契约。共享有界传输支撑三个 ACP Provider；Codex App Server、Claude SDK、WorkBuddy 使用独立适配器；ZCode 以官方协议证据决定能否进入执行实现。

**Tech Stack:** Node.js ESM、现有 Node SEA / esbuild、Rust WebView2 Host、React / TypeScript、ACP v1、各厂商官方协议/SDK；测试统一 npm test。

**Spec:** [已批准规格](../specs/2026-10-22-agent-expansion-design.md)，Owner 于 2026-10-22 明确批准。

## Global Constraints

- 保留 dsh/codex/zcode ID、Task identity、Broker/Registry；不得自动提交、合并、推送、打包、安装或修改用户凭据。每任务以显式文件清单和 diff 交付，提交步骤均等待单独授权。
- 现有未提交 UI 修改原样保留；不得 git reset/stash/clean 或把它们复制为新 Provider 的实现。继续现有隔离工作树；执行前重新检查当前状态。
- 默认单帧 1 MiB，待处理 RPC 256，每会话事件缓冲 512；握手 15 秒，控制 RPC 30 秒；生成回合不套 30 秒总时限。每 Provider 最多 16 活跃本机会话、stderr 环形上限 64 KiB（落实规格所需有界资源，超限明确错误）。
- ACP 初版只支持已验证 v1；只声明实现的客户端能力；未知/不支持能力拒绝。原生事件归一到 agent-turn-events-v1，DSH 保持其原协议。
- 不猜厂商 CLI 参数，不自动安装或升级用户运行时；版本/schema/argv 从官方资料及实际二进制帮助取得，形成版本证据台账；缺少实际版本依据时适配器保持 unavailable。
- Owner 审批、Workspace identity、执行绑定、原生安全策略和导入审批保持；Staging 不代表宿主隔离；不能虚报 sandbox 支持或放宽 Broker 白名单。
- JSON 持久化只经 src/storage/json-file.js；凭据只存引用和现有保护存储；空 catch 必须注释；新增 scripts/test-*.mjs 先登记 scripts/run-all-tests.mjs。
- Implementation、Fixture/Contract、Real E2E 分列；注册、探测或模拟成功不得冒充真实联通。文档计划本身不触发产品测试或真实调用。

## Review Focus

1. Windows GUI PATH 缺少 npm shim、路径含空格/中文、CLI 输出 BOM/中文跨字节：任务 1/2/4 用真实子进程合成 fixture 覆盖，避免 shell 拼接和乱码。
2. 停止发生于权限审批等待，或进程退出后迟到事件到达：任务 3/5/6/7 保证等待解除、原生终态区分且不把迟到事件写入下一回合。
3. Provider Session ID 重复、旧 Codex exec Session 不兼容 App Server：任务 3/7/10 按 Provider+transport+Workspace 绑定，不盲目恢复或重放。
4. 外部工具继承插件/hooks/MCP 或伪造 cwd、客户端 fs 请求：任务 3/4/6 默认拒绝未验证执行范围，不能只靠 prompt 限制权限。
5. 用户机器没有 Node、缺 SDK/凭据，WorkBuddy token 撤销或链接重定向：任务 6/9/11 分别验证 SEA 可选运行时、脱敏和受控目的地；不拖垮 Core。

## 工作包与顺序

包 A：任务 1–5（基线、共享协议、三个 ACP）。包 B：任务 6–7（Claude 与 Codex App Server）。包 C：任务 8–11（ZCode/WorkBuddy、组合投影和验收）。各包可单独保持可运行状态；按序推进，环境缺项记录后继续不依赖它的任务。
执行建议：本会话顺序实施，避免共享协议、安全审批和装配同时被修改。当前没有委派授权，不启动子代理。

### Task 1: 固定现有基线及外部协议证据

**Files:** Read RULES.md、PROJECT_STATE.md、docs/desktop/ARCHITECTURE.md、src/agent/{agent-provider,broker,registry,service,cli-agent-process,codex-agent-provider,dsh-agent-provider,staged-dsh-agent-provider}.js；Modify scripts/test-agent-provider-expansion.mjs、docs/desktop/AGENT_EXPANSION_EVIDENCE.md（新建）。
**Interfaces:** 不改生产接口。证据表列 provider、runtimePath、version、官方 URL/schema来源、实测 argv、认证/原生策略状态、时间；不写凭据。

- [ ] 记录 status/branch/HEAD/worktrees/unmerged/merge 状态和已有 diff；无冲突时继续当前隔离工作树。
- [ ] 通过 Get-Command 与既有发现逻辑定位运行时；只调用可证实的 --version / --help，不发 prompt。核查 Codex App Server schema、ACP v1、Claude SDK 实际可支持版本；记录原文摘要及来源，不猜版本 floor。
- [ ] 运行 npm test -- --suite test-agent-provider --suite test-agent-broker --suite test-agent-provider-expansion --suite test-agent-native-security --suite test-codex-discovery --suite test-dsh-model-selection --suite test-codex-chat-snapshot，保存真实 PASS/FAIL/NRE，现有失败先复现定位。
- [ ] 对确认存在的缺陷补最小 failing regression，观察预期 FAIL，修复对应现有模块后重跑相同 suite；无缺陷仅补必要验证，不为追求 diff 重写。
- [ ] 更新证据表和显式 diff 清单，保留未授权提交状态。

### Task 2: 有界双向 JSON-RPC 传输

**Files:** Create src/agent/protocol/json-rpc-transport.js、scripts/test-agent-rpc-transport.mjs；Modify scripts/run-all-tests.mjs。仅在需要时扩展 src/agent/cli-agent-process.js 的受监督 stdio 通道，不改变现有 exec run 语义。
**Interfaces:** createJsonRpcTransport({readable,writable,framing,maxFrameBytes=1048576,maxPending=256,controlTimeoutMs=30000,onNotification,onRequest}) → {request(method,params,{signal,timeoutMs}={}):Promise,notify(method,params),close(reason):Promise}。framing 显式为 acp-v1-jsonl 或 codex-app-server-jsonl；Codex 帧不补 jsonrpc 字段。

- [ ] 写并登记测试：将 UTF-8 中文按每字节分割；一个 chunk 多帧；RPC 响应乱序仍按 ID 关联；超 1048576 字节拒绝；第 257 个未决请求拒绝；未知 response ID 不污染其他请求；关闭使未决 Promise 全部拒绝且无 listener 泄漏。
- [ ] npm test -- --suite test-agent-rpc-transport；预期因缺少模块/接口 FAIL。
- [ ] 实现增量 UTF-8 解码、字节级帧上限、固定 wire codec、timeout/abort 清理；协议畸形关闭对应连接，stderr 只进 64KiB 脱敏环形缓冲。取消单个 RPC 不等价取消 Agent 回合。
- [ ] 同 suite PASS；验证既有 test-agent-provider-expansion 不退化。记录 diff，不提交。

### Task 3: ACP 会话、权限和成果的通用适配器

**Files:** Create src/agent/acp-agent-provider.js、src/agent/protocol/agent-event-buffer.js、src/agent/protocol/agent-permission-bridge.js、scripts/test-agent-acp.mjs；Modify scripts/run-all-tests.mjs。复用 src/workspace/staging.js、src/agent/execution-security.js 与现有 Capability 服务，不另建权限系统。
**Interfaces:** createAcpAgentProvider({descriptor,launch,resolveTaskWorkspace,applyChanges,approvalStatus,cancelApproval,requestNativeApproval,log}) → AgentProvider。descriptor 含 id/label/protocolVersion=1/verifiedRuntime/security。requestNativeApproval({provider,sessionId,workspaceId,taskId,requestId,fingerprint,action,target,options}) → Promise<{outcome:'approved'|'rejected'|'cancelled'|'expired',optionId?:string}>，仅可信装配层注入。createAgentEventBuffer({limit=512}) → {push(event),follow({signal}),close(error)}，溢出显式报错，不静默丢终态。

- [ ] 写并登记 fixture 测试：initialize 必须在 session/new 前；协商不兼容版本拒绝；未知权限默认拒绝；没有客户端 fs/terminal 实现则不声明；同 session ID 不同 Provider 事件不串；第17个会话拒绝。
- [ ] 添加审批期间 cancel、approval 指纹变更、进程退出/迟到流、pending request 清理、跨 Workspace/Task 伪造字段、symlink 逃逸、导入快照失败/冲突测试；断线后不自动重放 prompt。
- [ ] npm test -- --suite test-agent-acp，观察预期 FAIL。
- [ ] 实现 Provider 契约，生命周期 new/ready/running/waiting/unknown/closed 与单一终态；session/cancel notification ACK 不标记取消完成。权限回调交给现有审批能力，不自行回传 allow。超过控制等待保持 unknown 并可查询，不自动重发。
- [ ] 将正文、工具、usage、终态归一到既有事件形状，真实 token 缺失为 null；注入 approved import，不能通过 Runtime 参数绕过 Workspace identity。
- [ ] 运行 test-agent-acp、test-agent-broker、test-workspace-staging-boundary、test-agent-native-security；全部断言通过，记录 diff。

### Task 4: Gemini / OpenCode / Qwen 的独立接入配置

**Files:** Create src/agent/acp-provider-descriptors.js、scripts/test-agent-acp-providers.mjs；Modify src/agent/service.js、src/app/service-container.js、scripts/run-all-tests.mjs。
**Interfaces:** createAcpProviders({runtimeResolver,taskOptions,nativeApprovalBridge,log}) → AgentProvider[]；ID 固定 gemini/opencode/qwen。runtimeResolver(id) → {executable,argv,version,compatible,securityVerified}，无证据不得返回 compatible/securityVerified=true。

- [ ] 写并登记测试：三项缺安装仅 unavailable；未知版本/缺原生权限确认不得 readyForTask；健康检查不 createSession/send；Windows shim/路径空格中文、恶意任意 argv 配置被拒绝；用户 hooks/MCP 继承无法限制则禁用任务。
- [ ] npm test -- --suite test-agent-acp-providers，观察 FAIL。
- [ ] 基于任务1台账落实三个固定启动描述，版本未匹配/缺功能明确失败；不自动下载。健康探测只检查握手/版本，仍不把登录成功认定 Task 安全通过。
- [ ] 通过注入装配 taskOptions 和批准回调注册，保持 dsh/codex/zcode 兼容；现有 provider 列表精确断言按新有序八项目标有意识更新，不能删除安全断言。
- [ ] 运行 test-agent-acp-providers、test-agent-provider、test-agent-broker；逐 Provider 真实运行仅在已有对应授权和环境时执行，否则 NRE 写明原因。

### Task 5: 统一取消、退出和重连的跨 Provider 回归

**Files:** Create scripts/test-agent-protocol-lifecycle.mjs；Modify scripts/run-all-tests.mjs、必要时 Task2/3 的对应模块与 src/app/service-container.js 关闭钩子。
**Interfaces:** 复用 Provider cancel/closeSession；closeSession 必须解除权限等待和清空本会话回调。未观察到退出则返回可诊断失败/unknown，不伪造 closed。

- [ ] fixture 覆盖 prompt 运行中取消、权限等待取消、关闭 stdin、进程退出、管道半帧、超时、cancel ACK 后继续输出、重连 session 不存在、重复终态与服务关闭。
- [ ] npm test -- --suite test-agent-protocol-lifecycle，先在缺失场景上观察 FAIL。
- [ ] 按失败点修正状态和资源回收；生产只清理本次启动的子进程，保留既有 CliAgentProcess 生命周期政策；真实用户 CetaMesh/DSH 正常退出仍需具体授权，不强杀、不删锁。
- [ ] 同 suite 及 test-comm-approval-operations、test-comm-lifecycle 通过；检查未决数/事件监听归零，记录 diff。

### Task 6: Claude 官方 SDK 与 SEA 内受监督 runner

**Files:** Create src/agent/claude-agent-provider.js、src/agent/claude-sdk-runner.js、scripts/test-agent-claude.mjs；Modify src/core-dispatch.js、scripts/test-core-entry.mjs、src/agent/service.js、src/app/service-container.js、scripts/build-core.mjs、package.json/lock（仅锁定任务1确认的官方 SDK）、scripts/run-all-tests.mjs。
**Interfaces:** createClaudeAgentProvider({launchSdkRunner,taskOptions,resolveCredential,requestNativeApproval,log}) → AgentProvider；runClaudeSdkRunner({input,output,loadSdk}) → Promise<void>。Core 私有模式固定 --agent-sdk-runner claude，严格参数解析；SDK 不在 Renderer/主服务装配时实例化。使用任务2的宿主 RPC；launchSdkRunner 生产通过 process.execPath 启动相同 SEA 模式，源码模式经现有 core-entry 启动。

- [ ] 写并登记 runner 契约/Provider 测试：懒加载、缺凭据/SDK/官方二进制不拖垮 Core、审批拒绝、流式换行、取消/恢复、只读和工具范围、stderr 脱敏；不能冒用用户订阅登录态。
- [ ] npm test -- --suite test-agent-claude，观察 FAIL。
- [ ] 验证并锁定官方 SDK 版本及传递依赖；实现 SDK 与宿主 RPC 映射，凭据从现有 secret reference 解析后经受控匿名 stdin 通道传递，不放 argv/日志或公开事件。环境键仅增加显式授权的 Anthropic 项，不扩大全局 env allowlist。
- [ ] esbuild 将 SDK runner 代码纳入 SEA，保留懒加载生命周期。官方 Claude 二进制单独验证位置及版本；不把 Core SEA 当作系统 Node 执行任意脚本。任何 SDK 动态资源无法在 SEA 可靠解析时 runner 保持 unavailable，禁止源码 PASS 就开放。
- [ ] 运行 test-agent-claude、test-provider-secrets、test-agent-native-security、test-core-entry；新增私有 mode 不启动 Owner IPC/其他服务。实际 SEA 验证归任务11授权门槛。

### Task 7: Codex App Server 与旧 exec 兼容路由

**Files:** Create src/agent/codex-app-server-provider.js、src/agent/codex-provider-router.js、scripts/test-codex-app-server.mjs；Modify src/agent/service.js、scripts/run-all-tests.mjs。src/agent/codex-agent-provider.js 保留旧执行实现，不整体替换。
**Interfaces:** createCodexAppServerProvider({launch,taskOptions,requestNativeApproval,log}) → AgentProvider；createCodexProviderRouter({legacyProvider,appServerProvider,rolloutEnabled=false,resolveTransport}) → AgentProvider(id='codex')。resolveTransport(sessionId) → 'exec'|'app-server'|null；transport 为可信内部元数据，不来自 Agent 文本。

- [ ] 写并登记固定版本 schema fixture：initialize/initialized 顺序、thread/turn 创建/恢复/中断/终态、permission 请求、乱序事件、缺失线程、原生策略不支持、旧 exec Session 仍走旧 Provider。
- [ ] npm test -- --suite test-codex-app-server，观察 FAIL。
- [ ] 按任务1 schema 实现 stdio App Server；权限模式由已批准 policy 派生，不能复用可能语义不同的 exec 参数。默认新路径 rolloutEnabled=false，只有完整真实验收明确通过再修改默认开关；不因健康检查成功切换。
- [ ] Router 建立 Provider+transport+Session+Workspace 对照；重启无法证明 transport 时拒绝恢复并提示新会话，不猜测；需要持久元数据时复用现有 Agent session store 与 Storage Primitive，不创建 Renderer 文件写入口。
- [ ] 运行 test-codex-app-server、test-agent-provider-expansion、test-codex-discovery、test-codex-chat-snapshot、test-agent-native-security；旧路径回归必须保持。

### Task 8: ZCode 协议核验与诚实能力声明

**Files:** Read src/agent/zcode-agent-provider.js；Modify docs/desktop/AGENT_EXPANSION_EVIDENCE.md、scripts/test-agent-provider.mjs；仅证据满足时另增 src/agent/zcode-runtime-provider.js 和 scripts/test-agent-zcode.mjs（需登记）。
**Interfaces:** 既有 createZCodeAgentProvider 签名不破坏；若有正式协议，新增 createZCodeRuntimeProvider({verifiedProtocol,launch,taskOptions,...}) → AgentProvider(id='zcode')，verifiedProtocol 必须含版本与公开文档/schema 对应。

- [ ] 核查官方文档/正式二进制帮助/公开源码的外控合同，分别记录新会话与附着既有会话是否支持；不扫描凭据或读写私有数据库。
- [ ] 无证据：补测试保证 desktopDetected=true 仍 available=false、externalControl=false、原因明确，记录 BLOCKED_PROTOCOL，并继续任务9。
- [ ] 有证据：先写受控 fixture FAIL，再实现专用适配；复用任务3的原生权限桥接和事件 buffer。新增协议不适合既有边界时先修订规格，不用猜参解锁。
- [ ] 运行 test-agent-provider；若实现执行路径再运行已登记 test-agent-zcode，真实附着仅经具体用户许可验证，未验证不列为支持。

### Task 9: WorkBuddy 受约束 Open API 与条件化认证

**Files:** Create src/agent/workbuddy-agent-provider.js、src/agent/workbuddy-api-client.js、scripts/test-agent-workbuddy.mjs；Modify src/agent/service.js、src/app/service-container.js、scripts/run-all-tests.mjs；必要时在既有受保护 settings/secret 层增加窄配置，不创建 Renderer token 存储。
**Interfaces:** createWorkBuddyApiClient({fetch,resolveCredential,baseUrl='https://www.workbuddy.cn',allowedAcpOrigins,log}) → {localStatus(),sendLocal(input),localHistory(input),createTask(input),getTask(id)}；方法/字段以任务1固定官方版本为准。createWorkBuddyAgentProvider({client,oauthReadiness,taskOptions,log}) → AgentProvider(id='workbuddy')。

- [ ] 写并登记测试：缺开发者配置、缺 scope、401/403、过期/撤销/刷新失败、超时、429（仅幂等查询按 Retry-After 重试）、创建请求断线不自动重发、token 不进入 UI/日志、服务端返回任意 ACP host/重定向被拒绝。
- [ ] npm test -- --suite test-agent-workbuddy，观察 FAIL。
- [ ] 实现 HTTPS 固定源 API，默认 redirect:error；本地助理与云任务分别声明能力，不能把远端任务当本机 Workspace Task。上传和远端创建需要既有明确授权，不自动发送 Workspace 内容。
- [ ] OAuth 配置无已批准服务端交换端点或官方公共客户端证据时返回 oauth_exchange_unconfigured；不内嵌 clientSecret，不伪造刷新能力。具备条件后 state 随机且一次性/5分钟失效、redirect URI 精确匹配、scope 最小化；通过现有秘密存储持久化，回调 URI/服务端交换方案作为具体外部配置审阅，不自动搭服务。
- [ ] 运行 test-agent-workbuddy、test-provider-secrets、test-agent-native-security；无开发者申请/真实用户授权时 Real E2E=NRE，适配器不标 ready。

### Task 10: 八项装配、状态投影及现有 UI 兼容

**Files:** Modify src/agent/service.js、src/app/service-container.js、src/desktop/ui-service.js、desktop-ui/src/bridge/typed-client.ts、desktop-ui/src/app/HarborApp.tsx；Modify scripts/test-agent-provider.mjs、scripts/test-desktop-ui-v2-production.mjs、scripts/test-harbor-agent-setup.mjs。
**Interfaces:** 八项 ID 稳定顺序 dsh/codex/claude/gemini/opencode/qwen/zcode/workbuddy；沿用 available/readyForTask/reason/capabilities，增加字段只可选；Renderer 不得提交 executable/argv/secret/security-authority。

- [ ] 在现有测试补 FAIL：八项都可发现但不可用不进入执行选择；缺一个 runtime 不影响其他 Provider；未知原因有保守 fallback；历史 codex/dsh/zcode Session 与模型配置不变。
- [ ] 按上述 registered suites 统一 npm test 验证 FAIL；实现窄装配和文案映射。Claude UI 显示 Claude Agent。恢复、新建、模型选择均由真实能力控制，不用方法存在性推断。
- [ ] 确认 Memory、任务卡片、工具汇总、正文分段与新设置/侧栏本地修改未被覆盖；npm run build:ui，再跑 test-settings-layout、test-sidebar-layout、test-ui-motion、test-chat-context-card、test-chat-composer-layout、test-desktop-ui-v2-production。
- [ ] 更新 PROJECT_STATE.md 逐 Provider 状态，记录真实未验证项；不把外部原因改成无错误空状态。

### Task 11: 验收闭环与正式 SEA 门槛

**Files:** Create docs/desktop/AGENT_EXPANSION_ACCEPTANCE.md、scripts/test-agent-expansion-sea.mjs；Modify scripts/run-all-tests.mjs、必要的构建资源清单。不得修改 RC1116 既有产物。
**Interfaces:** 每 Provider 记录 {version,source,implementation,fixtureContract,realE2E,reason,evidencePath}，不向产品添加假的 readiness 标志。

- [ ] 写登记 SEA test，未有新构建时按既有 environment policy 输出 NOT_RUN_ENVIRONMENT，不从源码/旧发行包偷换测试目标；fixture 覆盖 Core runner dispatcher 和无系统 Node 场景。
- [ ] 运行全量 npm test（Cargo 按现有显式 opt-in；未具备记 NRE）、npm run build:ui、git diff --check；失败定位后仅补与本轮相关回归。
- [ ] 本规格禁止自动打包。准备好可审阅 diff、依赖锁、版本与来源后，再请求新正式 SEA/RC 构建授权；不修改旧 RC1116，不伪称本次已经通过打包测试。
- [ ] 获准构建后，正式 SEA 在隔离数据目录/移除系统 Node PATH 下测试每适配器：受控 fixture、真实 CLI 握手、Claude SDK runner/缺 CLI/缺凭据场景均可诊断；验证 SHA/来源、无开发目录依赖和资源清理。未获准或环境缺失保留 NRE。
- [ ] 真实 E2E 每 Provider 至少3轮只读对话、流式/取消/继续、隔离测试目录写入与拒绝、审批等待取消、关闭与重启恢复；以现有具体授权为准，未授权付费/外发/导入/账号步骤由 Owner 完成。
- [ ] 完成验收矩阵和差异报告。任何仍未真实验证的 Provider 不宣传正式支持；不自动提交/合并/推送/安装/发布。

## Self-review（计划文档核对，非产品测试）

- 规格1–3目标/优先级 → 任务1、4、6–10；规格4模块边界 → 任务2–4、6–9；规格5协议/有界资源 → 任务2–7；规格6权限 → 任务3–10；规格7凭据 → 任务6/9；规格8兼容 → 任务7/10；规格9阶段 → 工作包A/B/C；规格10验收 → 每任务及任务11；规格11证据 → 任务1/8。
- 接口复核：新函数均由本计划所属任务定义；工厂返回既有 AgentProvider；Task3 权限桥接不接受 Renderer authority；Task6 SEA 入口有明确 producer/consumer；Task7 legacy 路由默认不切换。
- 五项 Review Focus 已分配具体 fixture；未知官方 schema/argv 的定版是任务1交付，不在计划中伪造。测试 suite 名称须用注册表实际值，新增先登记。
- 没有运行产品测试、安装依赖或 Agent 真调用；这里只创建文档。旧 UI 验证结果不计入 Agent 新实现验收。

## 执行交接

Owner 已审阅批准并选择 subagent-driven-development。共享文件顺序装配，独立叶模块可并行；每项实施后独立复核。无论哪种方式，源码提交/合并/推送和打包安装仍需各自授权。

## 执行结果与后续授权（2026-10-22）

源码实现与逐任务、整体及维护补丁复核结果见 docs/desktop/AGENT_EXPANSION_ACCEPTANCE.md。原计划清单保留为批准时的要求；真实运行时、原生安全、OAuth和正式SEA项目按矩阵保持未验证，不将模拟通过计为全部规格验收。Owner随后明确授权完成后提交、合并并推送现有公开/私人两远端，最后关机；原先禁止自动Git操作的约束由该具体授权覆盖。没有授权或执行新的打包/安装。
