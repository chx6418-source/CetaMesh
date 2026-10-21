# CetaMesh Desktop 新发现问题修复报告

## 总览

- 分支：`codex/cetamesh-new-issues-20261015`
- 集成前基准 HEAD：`48b402de984aca9a8955c4bf19bc985a77bc35d8`（当时与 `origin/main` 一致）。
- 本报告记录修复分支在集成前的验证状态；提交与合并结果以本轮 Git 历史及最终交付报告为准。
- 版本 / Build：`1.0.0-rc.2` / `1065`
- 问题结果：16 项已修复；0 项已知代码缺陷未修复；真实服务、RC 安装验收和 GitHub Actions 受环境限制未执行。

## 问题逐项结果

### P0-01 — FIXED

- **根因：** `principalForTask()` 返回 Agent principal 本身，生产 `actorResolver` 却读取不存在的 `.actor` 属性；重新验证阶段因此拿不到当前 Task 的有效身份。
- **修改：** `src/app/service-container.js` 直接解析并校验 Agent principal 的 kind、Task、Workspace 与 grants；不使用固定 Owner 身份绕过权限检查。
- **回归：** `scripts/test-service-container.mjs` 通过真实 `createCetaMeshServices()` 装配运行 Managed Agent 工具调用，读取授权工作区文件并校验工具结果；全量套件 PASS。

### R01 — FIXED

- **根因：** Chat 历史、状态、Context 等异步响应没有会话代次校验，迟到的旧响应可能覆盖当前 Chat。
- **修改：** `desktop-ui/src/app/HarborApp.tsx` 为加载与 Context 请求增加 session/request epoch 检查；切换 Chat 时清空旧上下文并以 session key 隔离页面状态。
- **回归：** `scripts/test-desktop-chat-virtualization.mjs` 延迟 A/B/C 请求并乱序完成，确认只应用当前会话数据；architecture suite PASS。

### R02 — FIXED

- **根因：** RAF 合并只保留最后一个流式事件，同一帧里的中间 delta 会丢失。
- **修改：** `desktop-ui/src/app/HarborApp.tsx` 将事件排队后按原顺序批量消费；`desktop-ui/src/app/chat-async-state.ts` 按 Session/Request 隔离 reset、replaceText、delta。
- **回归：** 512 个小 delta 全量拼接、旧 session/request 拒绝以及 reset/replace/delta 顺序测试通过。

### R03 — FIXED

- **根因：** Continuity 把 Core 重启后失效的旧 Agent Session 当成不可恢复错误，导致新 Provider Session 创建前退出。
- **修改：** `src/continuity/runtime.js` 只将明确的 `SESSION_NOT_FOUND` 视为旧 Session 已失效，并走 Fresh Session 交接；其他状态错误仍失败关闭，保留 Task/Workspace/Progress。
- **回归：** `scripts/test-continuity-rollover.mjs` 覆盖旧 Session 缺失后的交接和 Task 状态保留；runtime suite PASS。

### R04 — FIXED

- **根因：** SSE EOF 在没有 `[DONE]` 或明确 `finish_reason` 时仍可能被视为成功完成。
- **修改：** `src/model/providers/openai-compatible.js` 对不完整流返回 `MODEL_STREAM_INCOMPLETE`，不发送完成态 assistant 文本；保留支持的 finish_reason 变体。
- **回归：** `scripts/test-model-runtime.mjs` 覆盖截断 EOF、显式完成和工具调用完成变体；runtime suite PASS。

### R05 — FIXED

- **根因：** DSH 客户端认证材料可能在构造时固定，后续切换 DSH Home 仍使用旧目录的凭据。
- **修改：** `src/dsh-client.js` 支持按请求读取 DSH Home 与 Cookie；`src/bridge.js` 传递当前配置 getter。
- **回归：** `scripts/test-agent-provider.mjs` 在同一进程切换两个独立 DSH Home，使用各自测试密钥验证请求认证材料；runtime suite PASS。测试使用 fixture，不代表真实 DSH 服务验收。

### R06 — FIXED

- **根因：** Tool Calls 用 `slice()` 截断，超出批次上限的调用没有对应结果，模型回合无法可靠续行。
- **修改：** `src/model/tool-execution.js` 为每个 Tool Call 留下结果；超过执行上限的调用获得明确 `TOOL_CALL_LIMIT`，不产生副作用。
- **回归：** `scripts/test-model-tool-calling.mjs` 覆盖 1、8、9、16 个调用，验证所有调用有结果且副作用不超过上限；runtime suite PASS。

### R07 — FIXED

- **根因：** Tool Calling 或 Agent/DSH 启动耗时被包含在 IPC 请求应答中，可能先发生 IPC 超时而后台仍继续执行。
- **修改：** `src/desktop/chat-service.js` 对已接受的长操作快速返回稳定 `requestId`，后台继续发流式事件和状态；失败保留明确错误码。
- **回归：** `scripts/test-desktop-chat-product.mjs` 与 `scripts/test-service-container.mjs` 验证快速 ACK、requestId、后台终态、重试及删除取消；architecture/core suites PASS。

### R08 — FIXED

- **根因：** IPC 的 AbortSignal 到达 Chat 后没有区分受理前取消与已接受回合的生命周期取消。
- **修改：** `src/desktop/chat-service.js` 在受理前检查 IPC signal；受理后的执行由显式 Stop、Chat 删除或服务关闭控制，取消操作保持幂等。
- **回归：** Chat product tests 覆盖受理前 IPC cancel、已接受回合 Stop、删除期间取消与迟到 Agent Session 回收；architecture/core suites PASS。

### N02 — FIXED

- **根因：** DSH staged Session 取消时，关联的待审批 Workspace import 仍可在之后被批准。
- **修改：** `src/agent/staged-dsh-agent-provider.js` 在取消、关闭和 reconcile 时撤销对应待审批导入并清理 staging；保留审批审计记录。
- **回归：** `scripts/test-agent-provider-expansion.mjs` 验证取消后批准旧审批不修改 Workspace，且 staging 被清理；security suite PASS。

### N03 — FIXED

- **根因：** 子任务文件导入只会在 Chat 页面订阅 DSH Follow 并收到 turn/end 时触发。
- **修改：** `src/capability/service.js` 为受控、具备 Workspace boundary 的 Agent Session 建立有界 Task 级 Follow consumer；限制并发与重试，按 Turn 去重。`src/app/bootstrap.js` 先关闭消费者再关闭 Agent 服务。
- **回归：** 生产 Capability Broker 启动 DSH 子任务，在没有 Chat Follow 订阅的情况下完成 Task Follow、Owner approval 和导入；重复 turn 不重复导入。`scripts/test-agent-provider-expansion.mjs` security suite PASS。

### N04 — FIXED

- **根因：** Chat 历史只保存附件元数据，重启后的 Retry 无法还原正文；去重也可能把同名不同内容当成同一请求。
- **修改：** `src/desktop/chat-service.js` 将附件正文、内容指纹按 Chat 存入专用本地目录，限制大小并在 Chat 删除时清理；历史只写元数据，Retry 使用原始正文。
- **回归：** `scripts/test-desktop-chat-product.mjs` 覆盖重启后重试、同名异内容冲突、正文不进入历史以及删除清理；architecture suite PASS。

### N05 — FIXED

- **根因：** Provider/Model 配置可能先持久化，再绑定 Agent Session；绑定失败或并发修改会令 UI、存储和运行时配置不一致。
- **修改：** `src/desktop/chat-service.js` 在活动回合或配置事务中拒绝不安全改动，先完成 Session binding 再提交配置，失败保留旧值；`HarborApp.tsx` 仅在成功响应后更新选择。
- **回归：** `scripts/test-desktop-chat-product.mjs` 覆盖绑定失败回滚、并发 `CONFIG_BUSY`、绑定期间旧配置不变和成功提交；architecture suite PASS。

### W01 — FIXED（原待验证风险已复现）

- **根因：** DSH WebSocket 建连阶段及建立后缺少握手超时、心跳和 pong 超时，半开连接可能永久等待。
- **修改：** `src/dsh-client.js` 增加 handshake deadline、ping/pong idle timeout、Abort 快速退出及 timer/listener 清理；重连由上层有限策略负责。
- **回归：** `scripts/test-agent-provider.mjs` 使用本地 stalled-handshake 和不回 pong 的 WebSocket fixture 验证超时及错误码；core suite PASS。真实网络恢复场景未运行。

### W02 — FIXED（原待验证风险已复现）

- **根因：** Chat 删除会中止 Agent startup，但生产路径在 Session 创建等待期间可能留下无 Agent 的 `queued` Task；此外生产 Chat 装配未注入 Workspace resolver，配置 workspaceId 会失败。
- **修改：** `src/desktop/platform-runtime.js` 在本次启动创建的 Task 被取消且仍 queued、未绑定 Agent 时将其标记 cancelled，保留 Task 记录；Capability Service 回滚并关闭迟到 Session。`src/app/service-container.js` 为 Chat 注入正式 Workspace resolver。
- **回归：** `scripts/test-service-container.mjs` 使用生产 `createCetaMeshServices()` 延迟 Session 创建，删除 Chat 后验证 Task 存在且为 cancelled、没有 Agent 绑定、迟到 Session 已关闭；core suite PASS。

### CI01 — FIXED（GitHub 托管工作流未实跑）

- **根因：** CI 上传路径仍指向 `dist/app/`，但 `scripts/build-release.mjs` 实际发布到 `artifacts/<channel>/<version>/build-<number>/`。
- **修改：** `.github/workflows/ci.yml` 改为 canonical artifact glob，覆盖 exe、release-manifest、SHA256SUMS 和 SBOM；继续使用 `if-no-files-found: error`，没有 `continue-on-error`。
- **回归：** `scripts/test-release-versioning.mjs` 比较 workflow 上传路径和正式产物结构；release suite PASS。当前没有可触发/读取 GitHub Actions 运行结果的环境，因此远程 workflow NOT_RUN_ENVIRONMENT。

## 验证结果

| 命令 / 检查 | 结果 |
|---|---|
| `npm test`（设置 `WHALEBRIDGE_TEST_CARGO=1`） | **91 PASS / 0 FAIL / 8 NOT_RUN_ENVIRONMENT**。包含 Core dist、SEA extension、Cargo check/test。 |
| `npm test -- --category release`（Core 构建后） | **7 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT**；跳过项是缺少正式 release-dist 的 RC 安装验收。 |
| `npm run build:ui` | PASS；保留 Vite 既有大 bundle 警告（546 KB）。 |
| `npm run build:core` | PASS；Core bundle、SEA、资源和发行审计通过。 |
| `npm run desktop:build` | PASS；Windows release profile shell 编译通过，存在既有 Rust warning。 |
| `cargo check --manifest-path desktop-shell/Cargo.toml` | PASS。 |
| Cargo test（经 unified runner 的 `cargo:test` suite） | PASS。 |
| `npm run build:release` | **BLOCKED**：正式 Release 要求 clean source tree；当前按要求保留未提交改动。命令在打包前被 clean-tree guard 拒绝。 |
| RC verification | **NOT_RUN_ENVIRONMENT**：没有正式 `release-dist`；未通过 dev 包冒充 RC。 |
| `git diff --check` | PASS；无空白错误。 |
| GitHub Actions hosted workflow | **NOT_RUN_ENVIRONMENT**：本机只能做 workflow 路径契约回归，不能启动或读取 GitHub 托管运行。 |

## 真实服务验证与限制

- DeepSeek/OpenAI-compatible：实现与协议 fixture/contract 回归 PASS；本轮未使用真实 Provider 凭据发起公网 E2E。
- DSH：DSH 客户端、认证目录切换、Follow、超时与任务导入 fixture/contract 回归 PASS；本轮没有连接真实 DSH API。
- Codex：Codex Session/配置隔离与 Harbor contract fixture 覆盖 PASS；本机真实 Codex 登录态/CLI E2E 未执行。
- Windows Shell installer / Explorer first-run / uninstall 的交互验收：未执行。正式 RC 包缺失，debug shell 验收套件也未具备对应产物。

## 安全与剩余事项

- 未关闭 Capability Broker、Owner Approval、Workspace Boundary 或 Agent sandbox；没有放宽凭据读取或环境变量继承。
- 没有发现已知未修复的代码缺陷。仍需在有真实服务与正式 RC 产物的环境完成 Provider/DSH/Codex E2E、普通用户安装/卸载及 GitHub Actions 实跑。
- 本报告中的验证发生在集成提交前；当时 Final HEAD 仅代表基准提交，不可作为本次修改的可发布 sourceCommit。正式 `build:release` 与 RC verification 仍需在有干净源树和正式 RC 产物的环境重新执行。
