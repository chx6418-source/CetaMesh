# CetaMesh Desktop 修复阶段 2：Model、Chat 与事件协议

日期：2026-10-16
工作分支：`codex/phase2-chat-model`
阶段 1 最终基线：`57fa6fc2feeeac6aec2b6512fa60ec1a9239c043`（含阶段 1 修复 `599b7e10d051275fd11dcd26267477196e0c0c83`）
阶段 2 修复 Commit：`23fd72f7e39d26e654372e94f2e9b1b8a637b135`

本分支直接从阶段 1 最终提交创建，`git merge-base --is-ancestor` 已确认该提交位于本分支历史中。仅处理本阶段指定的 16 项；没有合并 `main`、修改 Harbor 视觉设计、扩大 Capability Broker 权限、绕过 Owner Approval、删除用户数据或推送远端。

## 验证结果

| 命令 | 结果 | 证据边界 |
|---|---|---|
| `npm test -- --category runtime` | **35 PASS，0 FAIL** | 含阶段 2 新回归、Managed Agent 与既有 Model/Workspace 套件 |
| `npm test` | **91 PASS，0 FAIL，10 NOT_RUN_ENVIRONMENT**（101 suites） | 含阶段 1 安全套件、阶段 2 回归、Core/IPC、UI/Workspace 和已具备环境的 release 套件 |
| `npm test -- --category release` | **7 PASS，0 FAIL，1 NOT_RUN_ENVIRONMENT** | 最终重建的 Core 产物经 `test-core-dist` 与 installer package 回归；release-dist 未构建 |
| `npm run build:ui` | **PASS** | TypeScript `tsc --noEmit`、Vite 生产构建 |
| `npm run build:core` | **PASS** | SEA 构建及 6/6 产物审计；最终 Core exe SHA256 前缀 `8849c8e594566760` |
| `npm run desktop:check` | **PASS** | Cargo check；14 条既有 dead-code warning，0 error |
| `npm run desktop:test` | **197 passed，0 failed** | 使用此工作树内可写临时目录；默认系统临时目录拒绝创建文件的首次运行失败，复跑通过 |
| `git diff --cached --check` | **PASS** | 阶段 2 代码提交前无空白错误 |

全量聚合器的 10 项 `NOT_RUN_ENVIRONMENT`：`test-console`（legacy bridge）、`test-desktop-install`/`test-desktop-shell`/`test-installer-productization`（shell-debug）、`test-mcp-exec`/`test-onebot-connection`（gateway）、`test-mcp-web-search`（network）、`test-release-candidate`（release-dist），以及聚合器未设置 `WHALEBRIDGE_TEST_CARGO=1` 时的 `cargo:check`/`cargo:test`。Cargo 已由上表要求的独立命令真实执行并通过。真实外部 Model API、真实 QQ/DSH 和已安装 Windows 桌面端验收仍为 `NOT_RUN_ENVIRONMENT`，不算 Fixture PASS，也不构成 Stable 发布验收。

测试运行使用工作树内隔离的 `TEMP`/`TMP`。Windows 默认系统临时目录对原生 SEA/Rust 测试的文件创建返回 `PermissionDenied`；将临时目录置于此工作树后，指定命令的最终结果如上。`GIT_CEILING_DIRECTORIES` 指向工作树根，避免临时 Workspace Fixture 被误识别为外层仓库。初次诊断中的失败运行没有计入最终 PASS。

## 逐项修复记录

下表 `FIXTURE_PASS` 仅表示所列本地回归与全量聚合器通过；每项修复 Commit 均为 `23fd72f7e39d26e654372e94f2e9b1b8a637b135`。真实 Provider/安装版场景未执行时仍为 `NOT_RUN_ENVIRONMENT`。

| ID | 根因与问题点位 | 修复点位与回归证据 | 状态 / Commit |
|---|---|---|---|
| MODEL-01 | `src/model/service.js` 对空 Provider ID 直接 `registry.require(null)`，Managed Agent 默认配置触发能力检测错误。 | `supportsToolCalling` 先解析默认 Provider，并传入当前 Model；`scripts/test-phase2-chat-model.mjs` 验证默认/指定模型与生产 `createCetaMeshServices()` 装配。 | FIXTURE_PASS / `23fd72f` |
| MODEL-03 | `src/model/tool-execution.js` 把 JSON 字符串直接切到字符上限，可能形成非法 JSON、截断中文/emoji。 | 用合法的 `{truncated, originalChars, sha256, preview}` JSON 包装超大结果，并保持 Unicode 边界；阶段 2 Fixture 验证 1/8/9/16 次调用的结构化工具结果及中文/emoji。 | FIXTURE_PASS / `23fd72f` |
| MODEL-04 | 工具批次或循环到达上限后仍返回 `completed`。 | `src/model/tool-execution.js` 保留 `limitReached` 并返回 `partial/TOOL_CALL_LIMIT`；`src/agent/managed-agent-provider.js`、`src/desktop/chat-service.js` 显示失败而非完成；阶段 2 Fixture 验证上限。 | FIXTURE_PASS / `23fd72f` |
| MODEL-05 | `src/model/tool-execution.js` 对空 Manifest 的不支持模型可能进入假支持路径。 | 能力检查统一按具体模型执行，不支持时返回 `unsupported`；Managed Agent 用真实 `modelRuntime.stream` 降级为无工具文本流；`test-managed-agent-provider.mjs` 与阶段 2 Fixture 覆盖。 | FIXTURE_PASS / `23fd72f` |
| MODEL-06 | Tool coordinator 的文字增量与工具状态没有传给 Managed Agent Follow。 | `src/agent/managed-agent-provider.js` 把 `onTextDelta`/`onActivity`/reset 转成 Agent 事件，Chat 实时投影至 Harbor，避免最终文本重复追加；Managed Agent 回归验证流式增量。 | FIXTURE_PASS / `23fd72f` |
| MODEL-07 | `src/model/providers/openai-compatible.js` 只按 Provider 推断工具能力，目录项缺少逐模型 Tools/Streaming/Reasoning 状态。 | 读取模型目录明确发布的能力并呈现 `supported/unsupported/unverified`；明确不支持 Tools/Reasoning 时不发对应参数，`src/desktop/ui-service.js` 投影状态；阶段 2 Fixture 验证同 Provider 两个相反能力模型。未发布能力仍为 `unverified`，真实 API 未测。 | FIXTURE_PASS / `23fd72f` |
| CHAT-01 | `src/agent/managed-agent-provider.js` Follow 重订阅从头回放，第二轮可重复上一轮。 | Provider/Broker 接受 `sinceSequence`；`src/desktop/chat-service.js` 在同一 Session 保留 cursor 并按 sequence 去重；三轮不同问题的生产装配 Fixture、Managed Agent cursor 回归。 | FIXTURE_PASS / `23fd72f` |
| CHAT-02 | Chat 自己的 requestId 与 Agent ACK 的 requestId 未绑定，旧 turn/end 可终结新回合。 | `src/desktop/chat-service.js` 保存 ACK 的 Provider requestId，同时检查 sessionId、requestId 与 sequence；阶段 2 Fixture 注入旧会话/乱序事件。 | FIXTURE_PASS / `23fd72f` |
| CHAT-03 | Agent `turn/end(waiting)` 被 Chat 当成失败终态。 | `src/desktop/chat-service.js` 保持 `waiting-approval`、approvalId 和当前 turn；Managed Agent 回归覆盖等待、批准恢复与取消。 | FIXTURE_PASS / `23fd72f` |
| CHAT-04 | 审批恢复时缺少可中止句柄，Stop 后模型和工具仍可继续。 | `src/agent/managed-agent-provider.js` 为恢复执行持有 `AbortController` 并将取消传下去；`src/desktop/chat-service.js` 允许停止审批等待回合；回归验证批准后恢复、再取消。 | FIXTURE_PASS / `23fd72f` |
| CHAT-09 | `desktop-ui/src/app/HarborApp.tsx` 的时间线 memo 漏掉运行状态依赖。 | 补入 `status.statusMessage` 与 `status.agentActivity`；UI 生产构建和既有 500 条消息虚拟列表/实时状态 Fixture 通过。没有在真实安装版进行视觉验收。 | FIXTURE_PASS / `23fd72f` |
| CHAT-10 | 重连后重复历史事件与重复结束事件可再次写当前会话。 | Chat Follow 按 Session/sequence/requestId 拒绝旧事件，并由终态去重；阶段 2 Fixture 注入重复结束事件，既有聊天虚拟列表测试覆盖旧快照不覆盖已显示内容。 | FIXTURE_PASS / `23fd72f` |
| CORE-02 | `desktop-ui/src/bridge/typed-client.ts` 发送 ACK 超时后 UI 无法区分已接收与未接收，重试可能重复执行。 | 只对超时、且已有稳定 `clientMessageId` 的请求重发同一 ID；Chat 持久幂等记录保证一次消息；阶段 2 生产装配 Fixture 模拟丢 ACK，`test-core-entry.mjs`/`test-ipc-runtime.mjs` 经全量聚合器通过。真实 IPC 故障注入未运行。 | FIXTURE_PASS / `23fd72f` |
| WORKSPACE-03 | `src/workspace/tools.js` 按 UTF-8 强解文本，UTF-16/GB18030 乱码；二进制可能被误判。 | BOM/启发式 UTF-16、严格 UTF-8/GB18030 解码及二进制控制字符检查；分页读取保留多字节边界，返回 encoding/nextOffset；阶段 2 Fixture 含中文和 emoji。 | FIXTURE_PASS / `23fd72f` |
| WORKSPACE-04 | `filesystem.search` 仅匹配文件名，参数与真实内容搜索不符。 | `src/workspace/tools.js` 搜索文件名及源码内容，返回路径、行号、片段、编码、分页；`src/workspace/service.js`、`src/capability/service.js` 对齐参数；生产 `createCetaMeshServices()` Fixture 在真实 TypeScript 源码目录检索、分页读取并验证 Agent 敏感资源仍被拒绝。 | FIXTURE_PASS / `23fd72f` |
| UI-03 | `desktop-ui/src/app/HarborApp.tsx` 的消息状态推导缺少 `statusMessage`/Agent 状态依赖，长工具调用提示滞留。 | 时间线 memo 依赖同步；`test-desktop-chat-virtualization.mjs` 验证 500 条历史消息、流式更新、旧快照抑制，UI 构建通过。真实安装版状态视觉验收未运行。 | FIXTURE_PASS / `23fd72f` |

## 验证范围与限制

阶段 2 新测试 `scripts/test-phase2-chat-model.mjs` 已登记于 `scripts/run-all-tests.mjs`。它优先通过生产 `createCetaMeshServices()` 验证 Chat → Model → Capability Broker → Workspace，并使用隔离 StateDir、受控模型 Fixture 及真实 TypeScript 源码树；审批、Follow 与原生 IPC 的部分异常通过可控测试替身注入。`test-desktop-chat-product.mjs` 和 `test-desktop-chat-virtualization.mjs` 提供既有分页、500 条消息和后台刷新回归。

真实模型是否发布逐模型 Streaming/Tools/Reasoning 元数据取决于 Provider `/models` 响应；未发布者会显示 `unverified`，不能把目录推断当成真实服务验收。大型通用工具 JSON 超过限制时返回可解析的截断说明与摘要，不承诺模型已读取全部原文；Workspace 文件可按 `nextOffset` 分页继续读取。源码搜索在单文件 1 MiB 读取上限或整体遍历上限处明确标记 `truncated`，不假装完整结果。

本地分支仅交付阶段 2 修复和本报告。没有 push、没有合并 `main`、没有打正式 Stable；到此停止，等待阶段 3 指令。
