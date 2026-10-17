# CetaMesh Desktop 剩余问题与真实 E2E 门禁

版本：`1.0.0-rc.2` / Build 1070。分支：`codex/latest-audit-repair-20261017`。本轮没有推送、合并 main、签发更新或发布 Stable。最终结论：**RELEASE_BLOCKED**。

## 不能升级为 PASS 的项目

| 项目 | 状态 | 现有证据 | 完成门禁所需动作 |
|---|---|---|---|
| GitHub Windows CI | `NOT_RUN_ENVIRONMENT` | run `39031564633` 的两项真实 FAIL 已在本地修复并通过专项；本分支未推送，因此没有新 CI run。 | 经 Owner 决定如何发布分支后，在 Windows GitHub Actions 重跑 `npm test` 和 RC gate，留存 run/job URL 与 0 FAIL 摘要。 |
| Codex Task / Handoff | `NOT_RUN_ENVIRONMENT` | `codex.exe` 在 PATH，版本 `0.163.0-alpha.10.2`；真实隔离 Task 返回 Windows Sandbox 拒绝。 | 保持沙箱启用，记录 CLI/系统沙箱诊断，在受支持的 Windows 环境复测 Task、Follow、取消和 Handoff。 |
| DSH Agent / Handoff | `NOT_RUN_ENVIRONMENT` | `dsh.ps1` 版本 `0.1.5-rc.1` 可发现；本机 3080 端口未监听，未执行真实 session/follow。 | 在授权 DSH Desktop/API、认证和模型可用时复测 send ACK、native turn 关联、三轮、断线重连和跨 Agent 接续。不得读取未授权 Desktop Cookie。 |
| QQ / SnowLuma / OneBot | `NOT_RUN_ENVIRONMENT` | QQ 进程存在不等于 OneBot 已连接、白名单有效或工具可调用。 | Owner 提供授权测试账号/群白名单与网关后，受控测试接收、去重、审批、工具开关；禁止向真实用户群自动发送。 |
| Android / Device Mesh | `NOT_RUN_ENVIRONMENT` | 本轮未配对 Android 真机。 | 授权真机上验证 TLS Pin、信任与 Capability Grant、撤销及重启恢复。未实现远程能力仍显示 Unsupported。 |
| Windows 安装版 | `NOT_RUN_ENVIRONMENT` | Core SEA 和 Rust/安装器 Fixture 不能证明普通用户全新安装、覆盖升级、卸载。 | 在独立 Windows 测试账号/虚拟机安装 Build 1070，按 Owner 清单保存视频、日志、版本、安装路径和数据保留证据。 |
| Update 清单签名 | `SIGNING_PENDING` | 更新校验代码要求签名；没有配置可信固定公钥与正式签发服务。 | Owner 提供可信公钥与签发流程，验证合法/错误签名、SHA256、大小和回滚；不能临时关闭校验。 |
| Windows Authenticode | `SIGNING_PENDING` | SEA 注入阶段出现签名失效警告；未提供正式代码签名证书。 | 由授权发布流程对最终安装器签名并验证；此项与更新清单 Ed25519 验签是两道独立门禁。 |
| Plugin Publisher Signature | `PLANNED` | Catalog 明示 `publisherSignature: not-implemented`；SHA256 不证明发布者身份。 | 在正式可信 Publisher 方案交付和复核前不得显示“发布者签名已验证”。 |
| NEW-02 DSH native turn | `PARTIAL` | Fixture 中单回合 native turn 锁定、旧事件与 ACK 前缓冲通过；DSH `session/prompt` 不回传 native turn ID。 | 真实 DSH 0.1.5 session/follow 重放、断线和三轮关联实测；若协议不能可靠关联，产品须明确返回不可关联状态，不能伪造 ID。 |
| NEW-06 崩溃点位 | `PARTIAL` | 历史写失败、缓存写失败与持久 journal 重启夹具通过。 | 在受控 Windows 测试环境执行旧 Agent 停止、新绑定、commit 前后 kill 与磁盘满矩阵，核对 Task/history/packet/审批。 |

## E01–E24 真实业务验收

详见主报告附录 C 的 24 条原始场景。当前均无可核实的完整安装版加外部服务 `VERIFIED_REAL_E2E` 证据；真实 Codex Task 已尝试但以沙箱拒绝结束，不能计 PASS。由 Owner 在 Windows 真机按实际依赖顺序执行并保存：录屏/截图、脱敏 Core 与 Shell 日志、Task ID、Session ID、请求 ID、Workspace 变更前后哈希、审批记录、安装器 SHA256 与签名状态。仅在授权白名单目标上执行 QQ 外发。

## 最小诊断与复测顺序

1. 记录 `git rev-parse HEAD`、`git status --short`、`release/version.json`、安装器 SHA256 和 Authenticode 状态；核对 `sourceCommit`。不要用脏工作树声称正式 RC。
2. 在隔离 Windows 测试账号执行安装版的 Chat 三轮、停止、Tool Approval、Work Task Resume/Cancel、Memory 跨会话；保存 Core/Shell 脱敏日志与 Harbor 状态截图。
3. 启动经授权的 DSH，再检查 API reachable/authenticated、session create/send/follow 的 native turn 与 request 对应。独立复测 Codex 沙箱，不放宽其权限。
4. 完成 MCP/Plugin 的正式打包调用与崩溃隔离，再对授权 QQ 测试目标执行消息和工具链。设备 Mesh 另用真机验证。
5. 安装、覆盖升级、卸载后复查 Task/Memory/Settings/Plugin 数据保留；同时验证更新清单 Ed25519 签名与 Windows Authenticode，分别留证。

自动化 0 FAIL 是继续真实验收的必要条件，但不足以解除上述门禁。未关闭真实 P0/P1、签名和安装版验收前，发布结论维持 **RELEASE_BLOCKED**。
