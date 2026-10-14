# CetaMesh Desktop 外部模型与 Agent 修复完成报告

## 问题闭环

| ID | 状态 | 根因 | 修改 | 回归测试 |
| --- | --- | --- | --- | --- |
| M03 | FIXED / PASS | reasoning 参数序列化未按具体模型能力过滤。 | 按模型能力声明决定是否发送 reasoning 参数。 | `test-model-runtime`、`test-model-tool-calling` |
| M05 | FIXED / PASS | 用户取消与超时未同时作用于同一请求生命周期。 | 合并 abort signal 与 deadline，任一触发都终止请求。 | `test-model-runtime` |
| M06 | FIXED / PASS | SSE 只等待网络结束，没有流空闲超时。 | 为 SSE 增加 idle timeout 并清理计时器。 | `test-model-runtime` |
| M07 | FIXED / PASS | 连通性测试先写候选凭据，失败可能覆盖已有凭据。 | 先用候选值测试，仅成功后再持久化。 | `test-provider-secrets` |
| M08 | FIXED / PASS | Base URL 探测使用已保存地址而不是候选地址。 | 测试函数直接使用本次候选 URL。 | `test-provider-secrets` |
| M09 | FIXED / PASS | 局部更新 Key 时整对象替换并清空旧 Base URL。 | 配置采用字段级合并，未提交字段保留旧值。 | `test-provider-secrets` |
| M10 | FIXED / PASS | 工具能力默认声明与 OpenAI-compatible 服务实际协议不一致。 | 添加能力探测/配置，只有明确支持时才走工具调用。 | `test-model-tool-calling`、`test-model-runtime` |
| M11 | FIXED / PASS | `/models` 失败会阻断选择，没有手动模型 ID 路径。 | 允许用户输入并保存手工模型 ID。 | `test-model-runtime` |
| M12 | FIXED / PASS | URL 校验一律要求 HTTPS，阻止本地网关。 | 只对 loopback 受控允许 HTTP，远程地址仍强制 HTTPS。 | `test-model-runtime` |
| M13 | FIXED / PASS | Provider 健康状态以乐观默认值推断 available。 | 用显式 configured/reachable/authenticated 状态呈现探测结果。 | `test-model-runtime`、`test-provider-secrets` |
| M14 | FIXED / PASS | DSH Catalog 错误沿共享状态传播，影响其它模型。 | 隔离 DSH catalog 错误，不改写其它 Provider 的可用性。 | `test-model-runtime`、`test-service-container` |
| M15 | FIXED / PASS | Model Catalog 刷新串行且没有独立缓存。 | 加入缓存、并行加载和 Provider 独立刷新。 | `test-model-runtime`、`test-service-container` |
| M16 | FIXED / PASS | 空 tools 请求仍发送 `tool_choice`。 | 没有 tools 时省略 `tool_choice` 与 tool payload。 | `test-model-tool-calling` |
| A02 | FIXED / PASS | 复用 Agent Session 只更新状态，没有发送新指令。 | 复用 Session 时仍执行新 prompt，并回传执行状态。 | `test-agent-provider-expansion`、`test-service-container` |
| A04 | FIXED / PASS | Harbor/Chat 到 Agent 缺少受控 workspace 绑定。 | 在请求中透传并校验授权 workspaceId。 | `test-desktop-chat-product`、`test-service-container` |
| A06 | FIXED / PASS | 审批暂停时没有完整保留多个 tool call 及恢复位置。 | 持久化调用队列/游标，审批后从正确位置恢复。 | `test-model-tool-calling`、`test-agent-provider-expansion` |
| A07 | FIXED / PASS | `selectModel` 失败后 DSH Session 仍显示 Ready。 | 选择模型失败即将 Session 置为错误/不可用状态。 | `test-agent-provider`、`test-agent-provider-expansion` |
| A08 | FIXED / PASS | 初始化失败没有回滚 Task、Session 与 staging。 | 初始化按阶段登记资源，失败时逐项清理并回滚。 | `test-agent-provider-expansion`、`test-service-container` |
| A09 | FIXED / PASS | Continuity 在 Provider 成功前提交了新状态。 | 切换失败时恢复旧 Provider 与旧 Continuity 状态。 | `test-continuity-rollover` |
| A10 | FIXED / PASS | 删除运行中 Chat 没有取消模型/Agent 执行。 | 删除前取消关联任务和 provider execution，并等待清理。 | `test-desktop-chat-product`、`test-service-container` |
| A11 | FIXED / PASS | Follow 断线后没有有界重试与明确终态。 | 限制重连次数并暴露 recovering/error 状态。 | `test-agent-provider-expansion`、`test-dsh-integration` |
| H01 | FIXED / PASS | DSH 根路径 HTTP <500 被误当作 Agent Ready。 | 以 Agent API 能力和会话探测结果判定 Ready。 | `test-dsh-integration`、`test-local-services` |
| H02 | FIXED / PASS | 进程、网络、认证与 Session 能力折叠成一个状态。 | 分别报告 processAlive/reachable/authenticated/sessionCapable。 | `test-dsh-integration`、`test-service-container` |
| H03 | FIXED / PASS | 服务管理与认证读取使用不同 `DSH_HOME`。 | 统一从同一 runtime 配置解析 DSH_HOME。 | `test-dsh-integration`、`test-local-services` |
| H04 | FIXED / PASS | DSH API 请求没有统一默认超时。 | 为 API 客户端设置默认 deadline 并允许受控覆盖。 | `test-dsh-integration` |
| H05 | VERIFIED / PASS | 长操作与安装状态缺少独立可观测契约。 | 验证 requestId/进度事件及 Desktop Installed 与 Agent API Ready 分离。 | `test-dsh-integration`、`test-service-container` |
| C01 | FIXED / PASS | Windows `.cmd`/`.bat` 按普通可执行文件启动。 | 识别脚本入口并用无任意 shell 拼接的安全启动路径。 | `test-agent-provider-expansion` |
| C02 | FIXED / PASS | Windows 参数边界没有按 argv 规则严格编码。 | 对参数使用受控 argv 编码与平台兼容启动选项。 | `test-agent-provider-expansion` |
| C03 | FIXED / PASS | Codex 配置继承策略过度排除用户合法配置。 | 建立最小且受控的配置继承规则。 | `test-agent-provider-expansion` |
| C04 | FIXED / PASS | 安装/登录状态只在启动时探测。 | 增加 refresh/reprobe 并更新可用状态。 | `test-agent-provider-expansion` |
| C05 | FIXED / PASS | 代理变量未按安全 allowlist 继承。 | 只允许 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 等明确变量。 | `test-agent-provider-expansion` |
| C09 | FIXED / PASS | 授权的最小 OpenAI 环境变量未注入子进程。 | 经授权只注入必要的 OPENAI_API_KEY/OPENAI_BASE_URL。 | `test-agent-provider-expansion` |
| C10 | FIXED / PASS | 诊断路径未统一脱敏 API Key。 | 在输出错误与日志前按凭据规则脱敏。 | `test-agent-provider-expansion` |
| C11 | FIXED / PASS | JSONL EOF 未换行未 flush；审批取消清理不足。 | EOF 时 flush 最后一条，规范 `{code,message}` 错误，取消时清理 staging。 | `test-agent-provider-expansion`、`test-process-extension-host` |
| U01 | FIXED / PASS | 长 IPC 操作受 30/32 秒固定超时限制。 | 长操作改为异步请求状态，不让 IPC 同步等待任务完成。 | `test-desktop-chat-product`、`test-service-container` |
| U02 | FIXED / PASS | 长操作缺少 ACK、requestId 与进度事件。 | 立即返回 requestId，后续以事件发布进度/结果。 | `test-dsh-integration`、`test-service-container` |
| U03 | FIXED / PASS | cancel/retry 没有请求级幂等约束。 | 通过请求身份去重并让 cancel/retry 重复调用幂等。 | `test-desktop-chat-product`、`test-service-container` |
| U06 | FIXED / PASS | 错误被泛化，revision/epoch/cursor 无跨重启契约。 | 保留稳定错误码；校验 expectedRevision；Core epoch 变化时重置 cursor。 | `test-service-container`、`test-desktop-chat-product` |

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | **93 PASS / 0 FAIL / 6 NOT_RUN_ENVIRONMENT**（99 suites） |
| `npm test -- --category release` | **8 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT** |
| `cargo check --manifest-path desktop-shell/Cargo.toml` | PASS |
| `cargo test --manifest-path desktop-shell/Cargo.toml` | **192 passed / 0 failed** |
| `npm run build:ui` | PASS |
| `npm run desktop:build` | PASS |
| `npm run build:core` | PASS |
| `npm run build:release -- --use-current-build-number` | PASS，RC 审计通过 |
| `npm run test-release-candidate` | PASS，安装/启动/IPC/恢复/单实例/孤儿进程关闭/卸载与用户数据保留通过 |
| `git diff --check` | PASS |

`npm test` 的 6 个环境跳过项：旧 bridge、MCP exec、OneBot gateway、网络搜索，以及聚合入口默认未启用的 Cargo 两项；Cargo 已单独完整运行并通过。Build Number 为 **1065**。

PR Windows CI 首轮发现 4 个测试可移植性问题，已修正并在本机重新运行 `npm test`：路径断言统一比较 canonical path、死端口 DSH fixture 显式提供认证 cookie、图标生成测试断言格式/尺寸而不比较不同 Windows GDI+ 版本产生的 PNG 字节、artifact 路径断言使用 `realpathSync.native`。本地结果仍为 **93 PASS / 0 FAIL / 6 NOT_RUN_ENVIRONMENT**；修正后的远端 CI 需以本次分支更新后的 Actions 结果为准。

第二轮 CI 进一步指出 Codex 运行目录是隔离 staging root 下的 Task 子目录，测试已改为 canonical path containment 校验；security 分类 **13 PASS / 0 FAIL**，随后完整 `npm test` **93 PASS / 0 FAIL / 6 NOT_RUN_ENVIRONMENT**。最终远端 CI 仍待本次提交触发后确认。

第三轮 CI 暴露两个 runner fixture 边界：Extension cancellation fixture 的 100ms deadline 会在 Windows 冷启动 worker 尚未到达 Broker 前过期，已放宽为 2s；Mesh service fixture 预置随机持久端口可能命中 Windows excluded port range，现用 Storage Primitive 把该 fixture 端口设为 0（系统分配临时端口）。两项覆盖在 security/runtime 分类 **47 PASS / 0 FAIL**，完整 `npm test` **93 PASS / 0 FAIL / 6 NOT_RUN_ENVIRONMENT**；最新远端 CI 待验证。

## 真实 Provider / Agent 验证

- **DeepSeek：真实 E2E PASS。** 使用生产 `createCetaMeshServices()` 装配、隔离状态目录和本机凭据，`deepseek-flash` 实际返回 `OK`；凭据没有输出到日志或报告。
- **DSH：Implementation PASS；Fixture/Contract PASS；Real E2E NOT_RUN_ENVIRONMENT。** 本机 3080 端口拒绝连接，未创建真实 Session；未绕过认证或 Workspace Boundary。
- **Codex：Implementation PASS；Fixture/Contract PASS；Real E2E NOT_RUN_ENVIRONMENT。** CLI 安装且已认证，但本机执行沙箱无法提供所需的分离文件系统策略（`CODEX_SANDBOX_UNAVAILABLE`）；没有改用不安全的无沙箱执行。
- **Agent Task：生产装配链 fixture E2E PASS**（`test-smart-platform-routing`、`test-service-container`）；真实 DSH/Codex Task 随上述外部环境项未运行。
- 外部真实服务验证限制均为环境问题，没有降低 Capability Broker、Approval、Workspace Boundary 或 Agent sandbox。

## 提交与产物

- 实现提交：`a98f5788277c38d66299f4f0a0a0c4e621dc05f4`
- 测试/RC 闭环提交：`caaab62e1a68a1216fa1e30a16d25944c9462c2c`
- 验证时实现 HEAD：`caaab62e1a68a1216fa1e30a16d25944c9462c2c`
- 版本：`1.0.0-rc.2`，Build **1065**
- Release Candidate：`artifacts/rc/1.0.0-rc.2/build-1065`
- 合并后最终 HEAD 与最终 RC manifest `sourceCommit`/`dirty` 状态由本次 PR 合并后的验证记录确认；不在本报告中猜测远端生成的合并 SHA。
- Stable：未发布。

## 剩余真实 blocker

未发现已验证代码路径上的 Node、Release 或 Cargo 阻断失败。DSH 本机 Agent API 未运行、Codex real Task 受本机沙箱策略限制，因此两项真实 E2E 仍为环境验收 blocker；对应实现与 fixture/contract 已通过。Stable 发布不在本任务范围内。
