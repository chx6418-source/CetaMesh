# Agent 协议一致性测试报告

日期：2026-10-18；分支 `codex/cm-agent-protocol-review`；基线 `1aa5a85`。状态标签：`VERIFIED_FIXTURE` 仅指本轮统一测试实际运行的确定性场景；`PARTIAL_FIXTURE` 表示仅覆盖场景一部分；`NOT_RUN_ENVIRONMENT` 表示真实外部环境/原生安装版未运行；`GAP` 表示当前源码无所需机制或证据。任何 Fixture 都不升级为 `VERIFIED_REAL_E2E`。

## AC-001～AC-040 方法与场景台账

| AC | 对应现有测试/证据 | 当前判定与缺口 |
| --- | --- | --- |
| 001 | `test-agent-provider`, `test-agent-provider-expansion` 的缺安装夹具 | PARTIAL_FIXTURE；仅 GUI/WSL/远程组合未跑 |
| 002 | `agent.health(refresh)` 源码；无运行中安装 CLI 探针 | GAP |
| 003 | `test-agent-provider-expansion` CLI 参数夹具、`test-process-extension-sea` | PARTIAL_FIXTURE；真实中文路径/SEA CLI 未同场实测 |
| 004 | `defineAgentProvider` unsupported 与 Broker 拒绝夹具 | PARTIAL_FIXTURE；正式 contractRange 握手未实现 |
| 005 | 无 native schemaHash 锁或变更失效测试 | GAP |
| 006 | Agent health 与 CLI 登录状态源码 | PARTIAL_FIXTURE；本机真实认证撤销未跑 |
| 007 | `test-desktop-chat-product` ACK 前事件回放 | VERIFIED_FIXTURE；有界隔离/所有原生格式仍需补 |
| 008 | `test-agent-provider-expansion` 连续三轮 fake CLI；`test-latest-audit-agent-identity` | VERIFIED_FIXTURE；真实 Agent NOT_RUN_ENVIRONMENT |
| 009 | Continuity bootstrap/user 回合相关夹具 | PARTIAL_FIXTURE；跨原生协议身份未统一 |
| 010 | `test-new-audit-critical`、`test-agent-provider-expansion` 双 Follow | VERIFIED_FIXTURE；真实 Codex 双订阅 NOT_RUN_ENVIRONMENT |
| 011 | 同上三订阅、单订阅取消 | VERIFIED_FIXTURE；真实三订阅 NOT_RUN_ENVIRONMENT |
| 012 | 同上晚订阅和 `sinceSequence` | PARTIAL_FIXTURE；慢消费者/跨重启未覆盖 |
| 013 | `test-phase3-task-handoff` 工具结果重复投影 | PARTIAL_FIXTURE；通用 seq/payloadHash 去重未实现 |
| 014 | 无相同 seq 不同 payload 冲突校验 | GAP |
| 015 | `test-new-audit-critical` 过期 cursor 抛 `AGENT_EVENT_GAP` | PARTIAL_FIXTURE；乱序/溢出/快照恢复未覆盖 |
| 016 | `test-new-audit-critical` 模型流异常 EOF 拒绝 | VERIFIED_FIXTURE；DSH/Codex 真实断线 NOT_RUN_ENVIRONMENT |
| 017 | Codex 日志仅进程内，无重启持久重放 | GAP |
| 018 | `test-desktop-chat-product`、`test-desktop-chat-virtualization` 正式消息前保留 Streaming | VERIFIED_FIXTURE；真实 Harbor 10 秒观察 NOT_RUN_ENVIRONMENT |
| 019 | `test-desktop-chat-product`、`test-model-tool-calling` 完成/失败通知 | PARTIAL_FIXTURE；所有 partial/cancel 组合和真实 UI 未闭环 |
| 020 | `test-desktop-chat-virtualization` 100/200/500 条与生产 CSS | PARTIAL_FIXTURE；实际 WebView DPI/DOM 坐标 NOT_RUN_ENVIRONMENT |
| 021 | Task/Capability 占用检查夹具 | PARTIAL_FIXTURE；原生 cancel requested 与 stopped 分离未统一 |
| 022 | unsupported Provider / timeout 相关夹具 | PARTIAL_FIXTURE；跨适配器 unknown outcome 仍无统一状态 |
| 023 | `test-capability-broker`, `test-bridge-privilege` | VERIFIED_FIXTURE；真实插件逆向权限逐项未验 |
| 024 | `test-phase1-security`, `test-phase3-task-handoff` | VERIFIED_FIXTURE；assignmentEpoch 统一身份尚待设计 |
| 025 | `test-phase3-task-handoff` 失效审批/旧会话写入 | VERIFIED_FIXTURE；真实原生回调 NOT_RUN_ENVIRONMENT |
| 026 | `test-new-audit-critical`、`test-model-tool-calling` DSML 拆包文本 | VERIFIED_FIXTURE；真实 DeepSeek 响应 NOT_RUN_ENVIRONMENT |
| 027 | Tool Calling/审批夹具 | PARTIAL_FIXTURE；同轮多 callId 全结果与拒绝续接未证明 |
| 028 | `test-task-runtime`, `test-capability-broker` 单写者 | PARTIAL_FIXTURE；只读隔离与写任务并行真实运行未测 |
| 029 | `test-task-runtime`, `test-phase3-task-handoff` blocked 写者占用 | VERIFIED_FIXTURE；真实失联恢复 NOT_RUN_ENVIRONMENT |
| 030 | `test-phase3-task-handoff`, `test-phase1-security` 重启后不重放副作用 | PARTIAL_FIXTURE；所有 kill 点及第三方不可查询副作用未覆盖 |
| 031 | `test-phase3-task-handoff` 非 Git 目录；`test-workspace-reconciliation` | PARTIAL_FIXTURE；磁盘满/只读目录真实恢复未测 |
| 032 | `test-phase3-task-handoff`, `test-continuity-rollover` | PARTIAL_FIXTURE；源原生 stop 失败/目标初始化失败矩阵不全 |
| 033 | `test-continuity-rollover` handoff packet/latest 相关夹具 | PARTIAL_FIXTURE；权威历史写失败和缓存失败组合未证明 |
| 034 | Handoff 串行/占用测试源码 | PARTIAL_FIXTURE；两次切换并发取消的完整交错未证明 |
| 035 | `test-owner-agent-mode`, `test-new-audit-critical` Agent none | VERIFIED_FIXTURE；真实 UI 选择链未测 |
| 036 | `test-standalone-model-path`, `test-no-web-release`, `test-composition-boundary` | PARTIAL_FIXTURE；完全无 QQ/DSH/插件的正式安装版未测 |
| 037 | Extension 崩溃与 DSH 故障夹具 | PARTIAL_FIXTURE；真实 preset 损坏隔离未测 |
| 038 | 文档 03 禁止迁移；未碰用户 preset | NOT_RUN_ENVIRONMENT；属于下一阶段 |
| 039 | 文档 03 禁止迁移；未碰真实用户数据 | NOT_RUN_ENVIRONMENT；属于下一阶段 |
| 040 | `test-phase3-real-codex` 在统一 runner 中有环境门槛 | NOT_RUN_ENVIRONMENT；真实 Codex/DSH/Managed 首轮和重连未联合运行 |

## 本轮验证记录

`npm test` 首次在受限进程沙箱启动 100 个子进程均报 `spawn EPERM`，没有进入测试逻辑，因此不计产品 FAIL。随后在可启动子进程的执行环境重跑统一入口，退出码 0：108 suites，**100 PASS、0 FAIL、8 NOT_RUN_ENVIRONMENT**。跳过的八项分别为 legacy bridge、真实 MCP gateway、MCP network、真实 OneBot gateway、真实 Codex、release-dist、Cargo check/test（统一 runner 未设置 `WHALEBRIDGE_TEST_CARGO=1`）。适用构建入口全部通过；构建不替代真实 Harbor/Agent/DSH E2E。

| 验收项 | 本轮结果 |
| --- | --- |
| 统一 `npm test`（可启动子进程） | PASS，100/108；0 FAIL；8 NOT_RUN_ENVIRONMENT，退出码 0 |
| `npm run build:core` | PASS，6 步 Core SEA 打包与 17 资源审计；未签名告警仍属发布边界 |
| `npm run build:ui` | PASS，TypeScript + Vite 1792 模块；现有 bundle 大小告警 |
| `npm run desktop:check` | PASS，Rust dev profile；14 条 unused/dead-code 告警 |
| 真实 Codex/DSH/QQ/MCP 网关 | NOT_RUN_ENVIRONMENT |
| 真实 Harbor WebView 的 10 秒消息可见性和 VirtualList 坐标 | NOT_RUN_ENVIRONMENT |

## 协议缺口、建议和发布判定

**现有已实现/测试已验证：** 上表的 Fixture 项可支持已有修复不回退；AUD-001/002/003 分别位于 `a41e6c5`，失联 Task 单写者修复位于 `52f54af`。本轮只新增盘点生成器与文档，没有改写执行路径。

**协议缺口：** `ui.events.next` 的旧 cursor 越过保留窗口时没有 gap；Codex Follow 只有进程内有界日志；没有全局稳定 Run/Request/Native Turn 映射、持久 journal、跨原生协议的取消确认或 schema hash/profile 失效机制。逐方法请求/响应目前多是 inline 代码，并非正式版本化 Schema。CSV 的 `FIELD_REVIEW_REQUIRED`、`NATIVE_SCHEMA_UNVERIFIED` 不算四遍审计完成。

**建议变更／需要 Owner 审批：** 正式化 CM-Agent 契约、持久事件 journal、状态机和旧门面迁移，先提交详细兼容/回滚设计及 Schema。当前用户本轮禁止大规模重写与数据迁移，故不执行上述变更。

**发布阻塞：** RELEASE_BLOCKED。真实安装版 Harbor、真实 Codex/DSH/OneBot/MCP profile、DSH coding/social preset、订阅重启恢复和多场景写入对账尚无验收；既有四遍全仓审计、269 功能与 24 E2E 继续独立记录，不由本台账替代。
