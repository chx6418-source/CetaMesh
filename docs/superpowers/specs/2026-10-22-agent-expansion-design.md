# CetaMesh 八个 Agent 接入规格（Owner 已批准）

日期：2026-10-22。状态：DESIGN_APPROVED；Owner 已于 2026-10-22 批准书面规格，实施计划待审阅，未开始 Agent 产品实现。

## 1. 目标与范围

按 Owner 截图提供 8 个 Agent：P0 Codex、DSH、Claude、Gemini CLI、OpenCode、Qwen Code；P1 ZCode 预览、WorkBuddy 条件开放。
目标是完整的创建会话、发送、流式进度、取消、真实结束、可验证恢复和成果交付。缺少协议、权限或环境的项目明确报告不可用，不以注册成功或合成探针替代真实联通。
先完成已授权 UI BUG 修复；保留当前本地修改。不得自动提交、合并、推送、打包、安装或修改用户凭据。

## 2. 当前代码事实

- 工作树 D:/GIT- CetaMesh/comm-repair，codex/app-icon-refresh；检查时 HEAD ee88b215bab4570f27866f57fa86493fe9b8ea26；有已授权但未提交的 UI 修改。
- src/agent/service.js 当前注册 dsh、codex、zcode；入口仍为 registry.js / broker.js / agent-provider.js。
- Codex 为 codex-agent-provider.js + CliAgentProcess，使用 exec JSON 事件；不是 App Server。
- DSH 复用专有 API/Follow，Task 使用 staged-dsh-agent-provider.js 包装与既有导入审批。
- ZCode 当前只检测桌面安装，外控 unsupported_external_control；不能把该占位当作接入实现。
- 本次 Get-Command 在 PATH 只找到 codex.exe、dsh.ps1；其他 Agent 未找到不等于全机未安装。
- 既有 execution-security.js 与 Broker 绑定 Provider、Workspace identity、安全策略指纹；继续作为授权边界。

## 3. 接入选择与替代方案

推荐：保留 Broker 契约；协议分别适配，三个原生 ACP Agent 共用传输和会话底座。每个 Provider 仍有独立描述、版本检查、配置和能力集。

不选择全量改写 Broker：会扩大已验证 Task/Continuity/审批路径的回归范围。
不选择统一拼 CLI 命令：不同 Agent 的生命周期与权限协议不同，会丢失交互审批、恢复及准确终态。

| 优先级 | Provider ID | 选定接入 | 开放条件 |
| --- | --- | --- | --- |
| P0 | codex（保持 ID） | 官方 App Server stdio，按协议版本固定；先保留旧 exec 路径用于受控回退 | 新路径通过权限、会话、取消、恢复、真实 E2E，才能成为默认 |
| P0 | dsh（保持 ID） | 既有专用通道与 Task staging 包装 | 真实版本/预设/模型绑定及 Follow 恢复验证 |
| P0 | claude | 官方 Claude Agent SDK，优先 Core 子进程桥接以保留 SEA 可选依赖边界 | SDK/运行时可用、凭据与原生权限策略核验；UI 名称用 Claude Agent |
| P0 | gemini | 官方原生 ACP | 实际版本支持的启动方式、握手与权限验证 |
| P0 | opencode | 官方原生 ACP（官方文档给出 opencode acp） | 同上；不能凭协议名称假定全部能力可用 |
| P0 | qwen | 官方原生 ACP（官方文档给出 qwen --acp） | 同上 |
| P1 | zcode（保持 ID） | 官方外控协议核实后专用适配器 | 当前未确认稳定外控协议；保持不可执行，显示具体原因 |
| P1 | workbuddy | 官方 Open API；本地助理和云任务分别声明能力 | 开发者应用、用户 OAuth、所需 scope、发布/权限审核条件满足 |

Claude 的第三方 ACP 包不能标为官方原生 ACP；此版本选官方 SDK，不额外引入第三方 ACP。官方 SDK 文档与订阅支持说明可能适用对象不同，产品默认走 API Key 引用；不复制 claude.ai 登录态，订阅授权须先核实适用条件。
ZCode 允许研究官方文档、正式二进制帮助和公开协议；不写其私有数据库，不复用桌面内部 token，不猜测已有桌面会话附着协议。

## 4. 模块边界

Renderer → typed UI 投影 → 现有 Agent Service/Broker → Registry → Provider → 官方 Runtime。

建议新增模块（最终文件细分由获批实施计划确定）：
- src/agent/protocol/json-rpc-transport.js：有界 UTF-8 分帧、request ID、请求超时、关闭、错误分类；不得默认混用 ACP 与 Codex wire framing。
- src/agent/acp-agent-provider.js：ACP 握手、能力协商、Session 管理、事件与权限回调。
- Provider 描述表：gemini/opencode/qwen 官方命令与兼容范围；不允许 Renderer 提交任意命令行。
- src/agent/codex-app-server-provider.js：独立 App Server 协议适配，保持 codex 既有 ID。
- src/agent/claude-agent-provider.js 与受监督 SDK runner：可选运行时缺失只影响 Claude。
- src/agent/workbuddy-agent-provider.js：受约束 HTTPS 客户端与凭据引用；远端 ACP 只在官方任务 API 返回且通过目的地验证后连接。
- ZCode 只在协议证据满足后新增执行路径。

Broker 业务契约不重写。若既有契约缺少必要字段，先以向后兼容可选字段处理，并对旧消费者回归；不得改变 Task identity 为 Provider Session identity。
Core 不因缺少某个 CLI/SDK/账号而启动失败。新适配器采用延迟加载；Node SEA 不假定目标机有系统 Node 或仓库 node_modules。Claude runner 的打包与启动方式必须在实施计划中落实并经过正式 SEA 测试；不满足则该 Provider 保持不可用。

## 5. 协议、事件与能力

1. 启动前：定位实际可执行文件、读取版本和官方帮助，固定 argv 数组，不用 shell 拼接；健康探测不得发消息或启动付费任务。
2. ACP：先 initialize，协商版本及客户端能力，再按认证需求进入会话；只声明实际实现的客户端文件/终端能力。初版只支持已验证 ACP v1；未知版本拒绝，不自动按 v1 解析。
3. Provider 事件统一到既有 agent-turn-events-v1；DSH 原通道保持不变。稳定标识包含 provider/session/turn/request，防跨会话串流；重复与乱序事件需回归。
4. 正文增量保留原换行；工具状态独立；无法提供的 token usage 为 null，不能把字符估算说成真实 usage。
5. cancel 请求 ACK、进程退出、turn terminal 是不同事实。等待原生终态；超时返回 unknown/需核验，不能提前报 cancelled/completed。
6. resume/selectModel/contextUsage/archive/checkpoint/handoff 只根据实际版本和握手能力开放；不以方法桩存在认定支持。
7. 进程断开时标记不确定状态并解除本机等待；恢复时重新鉴权/握手、核实会话归属；不得自动重放可能产生副作用的 prompt/tool 请求。
8. 事件缓冲、stderr、单帧大小、待处理请求、会话数量均设上限；默认单帧 1 MiB，待处理 RPC 256，每会话事件缓冲 512，超限明确错误。大合法产物走现有 artifact 通道。握手默认 15 秒，控制 RPC 30 秒；生成回合不套 30 秒总时限。

## 6. 权限与工作区

- 保留 Owner 审批、Workspace canonical identity、Task 执行绑定、审批代次/指纹及凭据脱敏。
- 原生 Runtime 可能直接操作 OS；不得宣称 Broker 能拦截所有原生文件/终端操作。
- 新 Provider 如支持客户端代理文件/终端操作，必须经既有 Workspace/Capability 路径，默认拒绝越界、symlink 逃逸和未声明能力。
- 原生内置工具必须核实其原生限制和确认范围。确认不等于平台授权；Staging 只是工作副本，不是宿主文件隔离。
- 不通过修改 Broker 白名单或虚报 nativeSandboxSupported 使新 Agent 获得 Task 资格。无法满足当前安全契约时仅列出不可用/待验证。
- 原生权限请求映射 Owner 审批：包含目标、动作、Workspace、Provider Session、请求指纹与失效条件；仅对应已批准请求回传允许结果。取消/退出/策略变化使未决请求失效。
- 成果导入复用快照核验与审批；快照失败保留诊断并阻断导入，不能回报成功，也不能借导入批准扩大原生权限。
- 未注册/审批中 MCP、用户插件和 hooks 不随新 Agent 自动启用。无法可靠限制继承配置时必须披露并保持任务禁用。

## 7. 凭据与 WorkBuddy

沿用现有凭据保护机制，UI 只见 configured 状态和凭据引用，不返回 access_token/refresh_token/clientSecret。日志、事件、错误、链接查询均脱敏。
WorkBuddy OAuth 使用 state、精确 redirect URI、最小 scope、过期与撤销处理；支持 PKCE 与否按官方协议验证，不猜参数。
带 clientSecret 的授权码交换不能把 secret 嵌入桌面包或 Renderer。默认要求 Owner 提供合规的服务端交换端点/部署方案，或官方明确支持公共客户端流程；未具备时 OAuth 接入保持 BLOCKED。
本地助理与云任务的操作范围不同；云任务创建、文件上传、账号授权分别按既有产品审批，不自动上传整个 Workspace。返回的 ACP link/token 不能直接写入普通配置或展示到日志。

## 8. 状态与兼容

沿用已有 available/readyForTask/capabilities 投影；reason 用稳定错误码映射为产品文案，缺失分类才做向后兼容增加。
必须区分未安装、版本不兼容、未认证、权限不足、原生策略未验证、协议不支持、远端不可用。
八项都可列出，但仅通过相应能力与安全验证的项目可选用于执行。历史 dsh/codex/zcode ID、会话、任务、模型配置不变；旧 Codex Session 不盲目交给 App Server，先核实官方恢复兼容，否则保持旧 transport 或要求新会话。
现有工具汇总折叠、正文分段、任务卡片和输入区保持；新增 Provider 复用这些展示，不暴露底层 JSON/长工具串到正文。

## 9. 实施顺序与停止条件

A. Codex/DSH 现状复核及兼容基线；先补当前确认存在的缺陷。
B. 共享有界传输与 ACP Provider；Gemini/OpenCode/Qwen 逐个接入，逐个运行可用性与真实协议验收。
C. 官方 Claude SDK runner 与 Codex App Server；新 Codex 通过完整验收才切默认，既有会话不强迁移。
D. ZCode 官方协议探查、WorkBuddy 受条件约束的 Open API 适配；外部条件未满足时继续可执行工作，报告缺项。
E. 汇总回归与逐 Provider 验收报告；不自动创建 RC 或宣称正式支持。

若出现新安全边界需求、无法防止越权的配置继承或必须破坏旧契约，记录具体证据并提交设计修订。环境缺项仅阻断对应真实验证，不阻断其他已批准工作。

## 10. 验收矩阵

每个 Provider 独立记录 Implementation / Fixture-Contract / Real E2E 三列，取 PASS、FAIL、NOT_RUN_ENVIRONMENT，附版本、来源、命令、时间和脱敏证据。

必测：
- 缺失二进制/SDK、未知版本、协议拒绝、无凭据、不支持能力，不影响 Core 和其他 Provider。
- UTF-8 跨 chunk、多帧、超长帧、stderr 噪声、未知 RPC、超时、重复和乱序、并发会话串流隔离。
- 创建→发送→流式→真实结束；停止中等待审批、取消超时、退出清理、重连、重启恢复、会话不存在。
- Owner 批准/拒绝/过期/取消/指纹变化；Workspace 越界/symlink、失效 Task 绑定、跨用户/跨 Provider Session、恶意事件伪造。
- Staging 快照失败、导入审批拒绝、导入冲突，不能报成功或丢失原始文件。
- WorkBuddy 无授权、缺 scope、401/403、刷新失败、撤销、回调 state 不匹配和 token 脱敏。
- 真正受控的只读回合与隔离测试目录内写入/拒绝/取消；不使用用户仓库作为写入实验场。
- Windows 正式 SEA/Host 可启动新 adapter；不依赖开发机路径、系统 Node 或构建目录。

测试只经 npm test；新增 scripts/test-*.mjs 必须注册 scripts/run-all-tests.mjs。持久 JSON 只经 src/storage/json-file.js。
真实付费调用、账号授权、安全确认和文件导入仍需要对应授权。环境缺失写明具体原因，不能以模拟成功填充 Real E2E PASS。

## 11. 官方资料与证据边界

以下在 2026-10-22 在线核查；实施时仍需固定实际版本对应 schema/帮助。文档支持只证明接入方向，不证明本机执行通过。

- Codex：[官方平台接入说明](https://developers.openai.com/blog/codex-as-a-platform)、[App Server 源码协议](https://github.com/openai/codex/tree/main/codex-rs/app-server)。本期选本机 stdio，不启用实验性公网 WebSocket。
- Claude：[官方 Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)。注意第三方登录适用条件与 UI 品牌命名。
- Gemini：[官方 ACP Mode](https://geminicli.com/docs/cli/acp-mode/)。启动参数以当前正式版本文档和本机帮助为准。
- OpenCode：[官方 ACP](https://docs.opencode.ai/docs/acp/)。
- Qwen：[官方架构与 ACP](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/)。
- ACP：[初始化及版本协商](https://agentclientprotocol.com/protocol/v1/initialization)。
- ZCode：[官方文档](https://zcode.z.ai/en/docs/welcome)。尚未确认外部控制协议，不能推断其不存在或编造 CLI。
- WorkBuddy：[官方 Open API](https://open.workbuddy.cn/docs/openapi)、[第三方应用](https://open.workbuddy.cn/en/docs/third-party-app)。

## 12. 审阅结论

方向与本文已获 Owner 明确批准；实施计划见 ../plans/2026-10-22-agent-expansion-plan.md，待 Owner 审阅并选择执行方式。没有自动提交文档，以遵守本轮不自动提交约束。
