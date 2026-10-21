# CetaMesh Desktop 新增审计关键修复报告

日期：2026-10-18。工作分支：`codex/new-audit-critical-repair`；基线 HEAD：`dc038da88929be064d3e11631c0a689e839816c5`。发布判定：**RELEASE_BLOCKED**。

## 范围和基线

本轮先读 `RULES.md`、`PROJECT_STATE.md` 和 Desktop 架构／构建文档，再读取桌面上的 01、02、03 三份材料。材料中的方案和旧审计判断作为待核证输入；本轮以实际 HEAD、源码和新执行结果为准。原主工作树位于 `design/ui-ia-exploration-2026-10`，有其他会话改动；本轮只在独立工作树 `D:\GIT- CetaMesh\audit-critical-repair` 修改。该工作树起点等于文档的 `dc038da`，所以以下“基线比较”是该提交的代码核对与本轮差异，不把更早快照当作最新状态。六阶段集成提交 `7559ba6` 及其后的 `8f2545f` 已在基线祖先中。

开始时运行统一测试：107 suites，87 PASS、7 FAIL、13 NOT_RUN_ENVIRONMENT。7 项失败来自本地离线依赖安装时 SnowLuma SDK 安装脚本未执行、`desktop-ui` 依赖未就绪；执行现有 `scripts/patch-snowluma-sdk.mjs` 并安装 UI 锁定依赖后重测，不将此包装成产品修复。

状态含义：`FIXED_CODE` 表示本分支源码修复；`VERIFIED_FIXTURE` 表示确定性夹具验证；`VERIFIED_REAL_E2E` 只用于真实 Windows/WebView、真实 Agent/DSH 与实际用户路径；`RISK_UNCONFIRMED` 表示有结构性依据但事故条件未证明；`NOT_RUN_ENVIRONMENT` 表示真实环境缺失；`BLOCKED` 表示发布门禁仍未满足。一个条目可以同时有代码修复与夹具验证，不能据此提升为真实 E2E。

## 逐项结果

| 项目 | 基线 `dc038da` 证据和根因 | 本轮处理及证据 | 状态／剩余风险 |
| --- | --- | --- | --- |
| AUD-001 | `src/agent/codex-agent-provider.js` 的 `follow` 对共享 `events` 调用 `shift()`；Task 和 Chat 各自跟随同一 Session，会竞争取走事件。 | 在 `emit` 分配 session 内单调 `seq`、稳定 `eventId`，保留有界日志；`follow` 用各自 `sinceSequence` 读取且不移除事件。`scripts/test-new-audit-critical.mjs` 覆盖三消费者、晚订阅、取消、重连及 gap；`scripts/test-agent-provider-expansion.mjs` 覆盖实际 fake CLI 事件、Task 与多个 Broker Follow。 | `FIXED_CODE`、`VERIFIED_FIXTURE`；原生真实 Codex E2E `NOT_RUN_ENVIRONMENT`。日志仍只在进程内，跨 Core 重启尚无持久 journal。 |
| AUD-002 | `src/agent/agent-provider.js` 为缺失的 `follow` 补普通 `async` 拒绝函数，调用处得到 Promise 而非 AsyncIterable。 | 改为抛 `AGENT_UNSUPPORTED` 的 async generator；回归先复现类型错误，再验证 `for await` 收到稳定领域错误。 | `FIXED_CODE`、`VERIFIED_FIXTURE`。 |
| AUD-003／P0-CHAT-UI-01 | Tool Calling 完成时 `finalizeTurn` 写入正式 assistant 消息后缺少明确的提交事件；UI 在 Streaming 进入 idle 时立即移走临时正文，历史响应晚到可出现空白。 | `src/desktop/chat-service.js` 在 JSON 原子写后发 `chat.updated`，携带 `sessionId/turnId/requestId/messageId/historyRevision/status`；Harbor 以 `requestId` 保留临时正文直到对应正式消息到达，失配时定期补读历史。产品夹具先复现缺失通知，再验证成功和失败终态及消息关联。 | `FIXED_CODE`、`VERIFIED_FIXTURE`；真实 WebView 中完成后 0.5/3/10 秒可见性 `NOT_RUN_ENVIRONMENT`。 |
| RSK-001 | 基线 Codex Follow 无独立 cursor；与 AUD-001 为同一问题族。 | 同 AUD-001：独立 `sinceSequence`，越前和超出保留窗口明确 `AGENT_EVENT_GAP`，稳定身份支持去重；取消不影响其他订阅者。 | `FIXED_CODE`、`VERIFIED_FIXTURE`；长期／跨进程 replay `BLOCKED`，不重复计作第二次用户故障。 |
| RSK-002 | `src/model/tool-execution.js` 流式工具循环在没有终态 reason 时可结束。 | 无终态时抛 `MODEL_STREAM_TERMINAL_MISSING`；新夹具先复现异常 EOF 被当成功，再验证拒绝。 | `FIXED_CODE`、`VERIFIED_FIXTURE`；真实第三方异常断流 `NOT_RUN_ENVIRONMENT`。 |
| RSK-003 | `src/core-dispatch.js` 的 worker 路径仍调用 `runBridge`；`src/bridge.js` 静态依赖 DSH、QQ、Social 等。 | 只读依赖核对，未实施文档 03 的模块搬迁。现有 `test-no-web-release`、`test-composition-boundary` 验证既有边界，但不能证明无插件冷启动的所有副作用。 | 结构耦合确认；具体事故 `RISK_UNCONFIRMED`，独立化阶段 `BLOCKED`。 |
| RSK-004／P0-DSH-01 | `src/agent/dsh-agent-provider.js` 的 Session 创建与仓库 `dsh/agent-presets/whale-chat*` 模板之间没有可证明的 purpose／preset／当前 Schema 锁。截图所示 `prefix` 缺失不能推及所有安装版本。 | 只读检查了调用和模板，未改用户 preset，未执行安装或覆盖。需固定实际 DSH、persona 包版本和有效配置，再验证 coding/social 两种用途。 | 兼容性 `RISK_UNCONFIRMED`；真实 DSH mount `NOT_RUN_ENVIRONMENT`，发布仍 `BLOCKED`。 |
| RSK-005／P0-TASK-01 | 基线虽有 `activeWorkspaceOwner` 和 Capability 层第二写入者拒绝，却只将 `running` Task 视作占用者。重启恢复将失联 Task 标为 `blocked`，仍带 `currentAgent`，于是另一 Task 可越过写入预约；这是本轮新增的确定性复现。失联 Follow 重试耗尽仅审计退出，健康／租约／Task 状态联合恢复仍不完整。 | `src/task/runtime.js` 将仍有 Agent 的 `waiting`／`blocked` Task 也计为 Workspace 占用。`test-task-runtime` 先红后绿；`test-phase3-task-handoff` 另外验证 Core 重启后，另一 Task 的 `agent.run` 被 Capability Broker 以 `TASK_WORKSPACE_BUSY` 拒绝，核对前不重放旧写入。 | 锁洞 `FIXED_CODE`、`VERIFIED_FIXTURE`；真实失联、恢复和锁占用 UX `NOT_RUN_ENVIRONMENT`，自动健康收敛及原生 Session 终态 `BLOCKED`。 |
| RSK-006 | `src/app/ipc-runtime.js` 同时有 `task.*` 和受鉴权 `ui.task.*`，未知方法仍进入旧 Control fallback。入口行为差异存在，但没有证据证明未授权调用可穿越 Owner 管道。 | 只读方法级核对，保持现行权限边界；未把差异冒充已利用漏洞。 | `RISK_UNCONFIRMED`；全接口盘点／统一语义待设计评审。 |
| Agent none | 基线 task-linked Chat 的 `platformRoute` 分支先于 Agent 禁用分支，显式 `none` 仍可能强制 project 派发。 | `startTurn` 对此分支加 `agentProviderId !== AGENT_PROVIDER_DISABLED`；产品夹具先复现自动派发，再证实 dispatch 为零。 | `FIXED_CODE`、`VERIFIED_FIXTURE`。 |
| DeepSeek DSML | 基线 OpenAI compatible provider 将 `content` 当正文转发；工具上下文中 DSML 可进入 Harbor。是否由额度末轮触发仍无原始包证明。 | DeepSeek 工具上下文的流式与非流式响应拒绝内部 DSML 标记，流式处理跨 chunk 标记前缀，不执行自由文本工具语法；夹具覆盖拆包标记。 | `FIXED_CODE`、`VERIFIED_FIXTURE`；真实 API 触发链和限额末轮 `NOT_RUN_ENVIRONMENT`，具体触发因子 `RISK_UNCONFIRMED`。 |
| Blocked Task 入口 | 基线 Work 详情已有 `ui.task.reconcile` 表单，但 Chat 错误仍显示通用“重试／继续”。 | Chat 遇 linked Task 的 `needs-reconciliation` 或对应错误码时改为“核对任务后恢复”，直接打开 Work 中该 Task 详情；普通失败仍保留 Retry/Continue。后端既有核对测试通过；UI 生产构建通过。 | `FIXED_CODE`、`VERIFIED_FIXTURE`（后端）；真实 UI 跳转 `NOT_RUN_ENVIRONMENT`。 |
| Harbor VirtualList | 基线生产 Harbor CSS 缺 `.virtual-inner` 相对定位和 `.virtual-row` 绝对定位，TanStack `translateY` 布局叠加正常流位移。 | 补全定位与宽度／盒模型，消息外边距移至 virtual row 内；`test-desktop-chat-virtualization` 对实际 VirtualList 100/200/500 消息和源码 CSS 做夹具测试，生产构建 CSS 包包含所需选择器。 | `FIXED_CODE`、`VERIFIED_FIXTURE`；真实 WebView DOM 坐标、最终间距、滚动 `NOT_RUN_ENVIRONMENT`。 |

逐项 Commit 对照：AUD-001、AUD-002、AUD-003、RSK-001、RSK-002、Agent none、DeepSeek DSML、Blocked Task UI 入口和 Harbor VirtualList 均在 `a41e6c5`；RSK-005 单写者修复及其回归在 `52f54af`。RSK-003、RSK-004、RSK-006 为只读复核，本轮没有对应代码 Commit。AUD-003 与 P0-CHAT-UI-01、RSK-005 与 P0-TASK-01 按同一根因记录，不重复计数。

## 文档 02：本轮最小事件契约与方法台账

本轮只固定直接关联缺陷的现有内部调用，没有引入新的对外 CM-Agent RPC、持久 journal、DSH Schema 或全 IPC 迁移。Codex provider 的生产者在 `emit` 写一次有界日志；Core 中 Task、Chat 和其他 Broker Follow 各有独立 cursor。`sessionId + seq` 给事件稳定身份，同一订阅者用 seq 去重；越界明确 `AGENT_EVENT_GAP`。`turn/end` 是终态，流异常 EOF 不等于完成。Chat 的正式消息原子提交后发 `chat.updated`；UI 用 requestId 等待正式消息。这是当前单进程最小合同；文档 02 提议的十进制字符串序号、跨重启持久事件 journal、generation 和水位快照仍待设计评审。

| 方法／事件 | Caller → handler，传输 | 输入／结果与错误 | 权限、副作用、取消、验证 |
| --- | --- | --- | --- |
| `agent.follow` | `src/agent/broker.js` → `src/agent/codex-agent-provider.js`；进程内 AsyncIterable | `provider, sessionId, sinceSequence, signal` → `type/data/seq/eventId`；`INVALID_PARAMS`、`AGENT_EVENT_GAP`、`AGENT_UNSUPPORTED` | Broker 限制 provider/session；只读事件，无持久写；AbortSignal 停止本订阅；新三订阅者夹具。 |
| Task Follow | `src/capability/service.js` → Broker；进程内 | 独立 sequence，消费 `tool/result`、`tool/activity`、`assistant/message`、`turn/end` | 当前 Task 执行者身份检查；工具结果写 Task 证据；重试后从 cursor 接续；fake CLI／handoff 夹具。 |
| Chat Follow | `src/desktop/chat-service.js` → Broker；进程内 | 独立 sequence，关联 request/turn，更新流状态 | Chat Session 范围；取消 AbortSignal；三消费者 fixture。 |
| `chat.updated` | Chat `finalizeTurn` → Desktop UI event bridge → Harbor；本地 IPC 推送 | 消息提交身份、历史 revision、终态；UI 按 session/requestId 补读、去重 | 正式历史写入后通知；测试成功／失败；真实 WebView 时序待验。 |
| `ui.task.reconcile` | Work Task 详情 → `src/desktop/ui-service.js` → Task runtime | Task ID/rev、核对摘要、新指令；未核对拒绝 | Owner 路径，可能开启新写入；既有重启副作用夹具验证；不能由 Chat 通用 retry 代替。 |
| Model stream termination | `src/model/tool-execution.js` 消费 provider 事件 | 缺终态抛 `MODEL_STREAM_TERMINAL_MISSING` | 不将断线视为完成；新异常 EOF 夹具。 |

上述表只涵盖本轮触及的方法，不是全仓接口清单。RSK-006 的 25 个前缀族不能冒充方法级全量台账。

## 文档 03：只读 M0 库存与依赖

`git ls-files` 在基线得到 657 个跟踪文件，`src/desktop-shell/desktop-ui/dsh/scripts` 共 422 个。以下 blob 固定了本轮读取的依赖样本：`src/app/ipc-runtime.js` `fb4755e`，`src/bridge.js` `0f27aa2`，`src/core-dispatch.js` `19849b8`，`src/desktop/chat-service.js` `d421ffa`，`src/memory/store.js` `79d4206`，`src/task/store.js` `d67fdcd`。修复后的 Chat blob 另计，不能继承旧审查标记。

`core-dispatch` worker → `runBridge` → DSH/QQ/Social imports 是可见反向依赖；`src/app/service-container.js` 装配 Core 服务，`src/app/ipc-runtime.js` 分配方法族。Chat、Task、Memory 的 JSON 写路径通过 `src/storage/json-file.js`，本轮未切换任何写入者。`src/dsh-integration.js` 和 `dsh/agent-presets` 涉及外部 DSH preset；本轮未写用户目录。没有移动核心模块、改真实用户数据根、双写或执行迁移。M0 的全文件职责／写入者清单与完整依赖图尚未完成。

## 验证与发布门禁

以下是本轮实际执行的统一测试、构建和产物检查结果：

- 新缺陷先红后绿：AUD-001 双消费者超时；AUD-002 Follow 类型错误；RSK-002 异常 EOF 未拒绝；RSK-005 失联 Blocked Task 丢失 Workspace 占用；DeepSeek DSML 未拒绝；Agent none 自动派发；Tool Calling 完成缺通知；VirtualList 生产 CSS 规则缺失。修复后 `test-new-audit-critical`、`test-agent-provider-expansion`、`test-desktop-chat-product`、`test-desktop-chat-virtualization`、`test-model-tool-calling`、`test-task-runtime` 通过。`test-agent-provider-expansion` 又验证同一 Harbor/Codex Session 连续三轮成功回答与后续结构化失败。
- `npm test` 一次源码运行：108 suites，95 PASS、0 FAIL、13 NOT_RUN_ENVIRONMENT。启用 Cargo 并具备 Core 与 debug Shell 产物后的最终统一运行：108 suites，**102 PASS、0 FAIL、6 NOT_RUN_ENVIRONMENT**，包含最终 RSK-005 单写者回归、Core EXE、SEA、桌面安装／壳、产品化夹具和 198 项 Rust 测试。
- `npm run build:ui`：TypeScript 与 Vite 生产构建通过，产物 CSS 含 `.virtual-inner` 相对定位、`.virtual-row` 绝对定位和 `.chat-message` 零外边距。存在既有 bundle 大小告警。
- 使用该生产 CSS 的本地 headless Edge 布局探针截图，观察两条模拟 virtual row 按 0/120px 偏移分开；这是浏览器 CSS 夹具，未启动真实 Harbor WebView 或加载实际消息列表，因此不记真实 E2E。临时探针在发行包构建前清除。
- `npm run build:core`：独立 Core EXE 及 17 个资源构建和产物审计通过；SEA 注入提示现有签名失效，正式签名仍属发布门禁。
- `npm run desktop:check` 通过；`npm run desktop:test` 198 PASS、0 FAIL。它们不等于真实 WebView/Agent/DSH E2E。
- `npm run desktop:build:debug` 和 `npm run desktop:build` 均通过。`npm run build:release -- --dev --use-current-build-number` 通过，生成本地 DEV 通道 `artifacts/dev/1.0.0-rc.2/build-1071/`（143.5 MB），安装器 `CetaMesh-Setup-1.0.0-rc.2-build1071-x64.exe` 为 43,212,800 字节，SHA-256 `A8B8FA2EF5B11818A9AC03B98C5C3CC385C1653C7BB7FA01BD7B7503F05E7292`。产物审计通过，Build ID `00c361e.DEV` 指向打包时的代码；之后仅把第二写入者回归测试补入同一修复提交，运行时源码未变。没有生成或发布 Stable。规范 RC `test-release-candidate` 因未制作 rc 通道产物仍为 `NOT_RUN_ENVIRONMENT`。

仍需真实安装版或授权环境验收：Task+Chat 同时接真实 Codex、三订阅者晚订阅／断线／取消、连续三轮 Agent 对话、Tool Calling 完成／失败后的 0.5/3/10 秒正文可见、真实 Harbor DOM 坐标与间距、真实 DeepSeek DSML、DSH coding/social preset mount、失联任务单写者恢复。夹具覆盖了其中的逻辑条件，但没有真实桌面或外部 API 证据，统一记 `NOT_RUN_ENVIRONMENT`，**不得发布 Stable**。

`VERIFIED_REAL_E2E`：本轮上述缺陷场景均没有可标记为真实 E2E 的结果。统一测试中的 `test-desktop-install`、`test-desktop-shell` 和 `test-installer-productization` 实际运行了隔离 Windows 可执行文件／安装流程，但未驱动真实用户 Harbor WebView 会话或外部 Agent/DSH，故仅证明这些打包路径。六项统一测试环境跳过为 legacy bridge、MCP gateway、MCP network、OneBot gateway、真实 Codex 和规范 rc 通道发行包；这些跳过不计 PASS。

DEV `release-manifest.json` 另列明：没有代码签名证书、未在 Windows 10 x64 验证、未在真实 QQ／DSH 会话核验四种模式和全部 MCP 工具、未验证 DSH/SnowLuma 重启恢复，且未签名安装器会触发 Windows 来源提示。这些是额外发布阻塞，不能由本轮单元／隔离安装测试消除。

全仓四遍审计保持独立进度：本轮只读了与缺陷有关的文件和 M0 样本；R1/R2/R3/R4 逐文件台账、269 功能和 24 项真实 E2E 均未由本轮局部修复完成，也不计算全仓通过率。文档 02 的大规模协议迁移和文档 03 的 M1–M6 均等待后续设计／拆分指令。

## Commit 与交付边界

代码修复 Commit：`a41e6c5d825e6e8f5eb58f7df9b993190dc75ff8`；RSK-005 追加修复与集成回归 Commit：`52f54af`。报告 Commit：见 `git log`。无 push、无 main 合并、无 Stable 发布；保留独立工作分支等待 Owner 后续指令。
