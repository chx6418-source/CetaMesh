# Agent Native Security Policy

适用：CetaMesh Desktop 1.0.0-rc.2 / Build 1104。状态：Native Security 路径已实现；严格隔离仍未验证；整体 RELEASE_BLOCKED。

## 1. 安全职责

CetaMesh 管理 Task、Session、Workspace、Memory Scope、执行权、Checkpoint、Continuity、Core 私有 IPC、平台工具的 Capability Broker 和 Owner Approval。外部 Agent 管理自身原生文件与命令执行、原生工具和原生安全环境。

**Capability Broker 不能拦截外部 Agent 直接调用操作系统的文件、命令或网络操作。** Native Security 的读取范围可能超出工作区；不得把 cwd、Staging、提示词或导入审批称为主机隔离。原生操作可访问哪些主机资源，最终由 Agent 原生策略和操作系统账号权限决定。

平台不向 Agent 注入 Owner IPC Token、平台密钥或 Owner 身份。现有私有 IPC 鉴权、平台工具权限、任务租约、Memory Scope、导入校验保持生效。这并不保证原生 Agent 不能读取当前 OS 用户有权读取的应用数据；有此强隔离需求时必须选择经验证的独立环境，当前实现不提供该保证。

## 2. 模式

| 模式 | 当前行为 | 不作出的保证 |
| --- | --- | --- |
| Native Security（默认） | 使用当前已安装 CLI 支持的官方沙箱，在运行前展示真实范围并取得 Owner 确认 | 不保证工作区外不可读；不保证所有原生文件修改都经过平台审批 |
| Isolated Workspace（可选） | 未有已验证独立环境时拒绝执行，返回 ISOLATED_ENVIRONMENT_UNVERIFIED | 不把旧严格权限表或 WSL 安装状态当作有效隔离证明 |

不自动启用 WSL、管理员提权、全盘授权、无沙箱或全权限回退。Windows Native 不需要 WSL。

## 3. 当前 Codex Profile

本机实际 CLI：codex-cli 0.163.0-alpha.10.2。检测命令与帮助输出来自当前安装程序，不从模板猜测参数。

正式 Adapter 继续使用 exec JSONL：`--sandbox workspace-write`、`-c windows.sandbox="unelevated"`、`--ask-for-approval never`，以及现有 `exec --ignore-user-config --strict-config --skip-git-repo-check --json -`。`never` 是原生非交互策略：需要升级授权时拒绝，不自动扩大权限；当前没有桥接原生交互审批的承诺。Native 保留用户 execpolicy rules，不加载无关用户 hooks、MCP、插件配置。

只在选定的 Windows unelevated 后端获得本轮执行证据。选定 elevated/mxc 时拒绝，不替换为 unelevated。无法可靠识别的 dotted/inline/quoted Windows TOML 安全设置返回明确 UNVERIFIED，要求人工规范配置后重新检查。本轮不修改用户配置。

实际读取、写入及网络边界遵循 Codex 原生策略。Windows unelevated 的网络约束不是专用防火墙边界。临时目录的写权限按原生策略处理。本轮 canary 验证“工作区内可写、合成工作区外可读、合成工作区外写入被拒绝”，并非严格读取隔离。

## 4. 首次范围确认

Harbor 在 Chat、Task 创建/开始/恢复、重试/继续与 Handoff 前查询 `ui.agent.security`，展示服务端权威说明。Owner 接受后，通过 `ui.agent.authorize` 请求现有高风险 `agent.execution.authorize` Capability 审批；确认不是任意 actor 可以授予的普通 Agent 方法。

确认绑定 provider、Workspace ID/实际根、CLI 身份、版本及文件状态、原生后端和 rules 摘要。策略变化拒绝旧 fingerprint。确认仅在同一 Core 进程内有效，Core 重启需要重新确认；不持久化一个跨任务的 Owner 全权令牌。拒绝或未批准时，在执行前停止。

后端在 createSession/send 重新校验，不依赖 UI 检查。Session 必须通过 Broker 绑定 Task/Workspace；发送要求当前 Task 仍由该 Provider/Session 持有，且处于可执行状态。Handoff 持有执行权时拒绝普通发送，只允许 Core 的初始化回合。公共 Agent IPC 不接受调用者指定的 bootstrap 权限。

确认范围是“本 Core 进程、该工作区、该 Agent 和策略”，不是每一条原生命令逐次批准。平台工具和导入审批仍独立发生。

## 5. Staging 与成果

Codex 任务继续在合成的 Staging 工作区执行。权威 Workspace 的变更导入仍通过 `workspace.apply`、Owner Approval 和完整性检查。若原生 Agent 能直接修改其他由其策略允许的路径，这些直接 OS 修改不受导入流程拦截，不得向用户声称相反。

暂停/取消必须等待实际执行终止；未知副作用保持核验流程，不能因恢复而盲目重试。Handoff 的目标必须获得自己的范围确认，不继承旧 Agent 的确认。现有 Task/Memory/Continuity/Store 不重建。

## 6. 新 Agent 接入

适配器可在现有 capabilities 中描述 security：mode、nativeSandboxSupported、nativeSandboxMode、nativeApprovalSupported、nativeApprovalPolicy、executionBoundary、workspaceAccess、directFilesystemAccess、platformToolPermissions、strictIsolationVerified、securityLimitations、identity。字段表达不同 Agent 的实际差异；不能用描述字段授予平台权力。

需要原生执行的适配器必须声明真实策略、可核验版本和身份变化依据。使用通用 Broker 范围确认及现有 Capability 审批，无需为每个 Agent 增建平台权限系统。新增测试 Adapter 使用另一种原生策略，已验证同一 Core 逻辑处理确认、拒绝和策略更新。

安装、版本兼容、认证、原生沙箱实际验证、taskEligible、readyForTask 分开表达。允许首次显式测试不等于已验证 Ready；原生配置或程序/rules 变化使旧沙箱结果失效。

## 7. 验证与限制

真实源代码服务装配已验证 Native Session、多轮、JSONL assistant 事件、原生命令活动、失败恢复、Staging 导入审批、暂停/恢复/取消。exec JSONL 的 assistant/chunk 是消息粒度事件；不宣称 app-server token 级 Streaming 或本轮 app-server 集成。

真实 Harbor 的安全确认弹窗、所有原生交互权限分支及其他 Agent 安全后端仍需独立验收。不得用 Fixture 或构建通过替代这些项目。

官方参考：[Codex 安全与审批](https://learn.chatgpt.com/docs/agent-approvals-security)、[Windows Sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)。实际采用的参数以本机 CLI 帮助和本轮运行结果为准。
