# CetaMesh Desktop — v2 Hardening Report

Date: 2026-10-05 · Branch: `feature/desktop-v2-hardening`（本地提交，未 push）

> ## Current Integration Status（2026-10-06 更新）
>
> 本报告所述工作已 **合并进 `main` 并推送远端**：Owner 确认后
> `feature/desktop-v2-hardening` fast-forward 合并，`origin/main` = `9861976`。
> 其后 `main` 追加主题/品牌提交 `4f6e3e8`；当前安全修复轮
> （`fix/agent-test-run-security`，见 `FINAL_DESKTOP_RC_REPORT.md`）基于其上。
>
> **下方正文中所有 "本地提交，未 push"、"Branch: feature/desktop-v2-hardening"、
> "local only" 等描述均为开发期（Historical Build Context）状态，不再是当前事实。**
> Base/Final HEAD 表、测试矩阵与产物哈希保留为历史构建记录。

## Base / Final HEAD

| 项 | 值 |
| --- | --- |
| Base HEAD | `74ede4e`（main；Sessions 1–3 已合并，local 与 origin 一致） |
| Final HEAD | `32571d4`（+ 本报告文档提交） |
| 本轮提交 | `744efe0` docs(state) · `bb5f25a` test(model) · `6b67e0e` refactor(capability) · `6145257` feat(security) · `cc1a151` refactor(extension) · `8aba9b5` feat(workshop) · `9f0ee96` docs(product) · `124fb0a` test(security) · `32571d4` test(env) |
| RC buildId | `1.0.0-rc.1+32571d4`（**dirty=false**，干净 worktree 构建） |

## A. Documentation State — PASS

- `PROJECT_STATE.md` 顶部 CURRENT STATE 修正为真实 Git 事实（Sessions 1–3 已合并
  main；local 与 origin 一致于 `74ede4e`），旧"local only / 不 push"表述标记
  superseded。
- `ARCHITECTURE_INTEGRATION_REPORT.md` 顶部加更新声明：Session 3 分支已合并推送，
  原 "local branch only / not merged" 描述改为历史。
- `DESKTOP_APP_WORKPLAN.tmp.md` → `docs/archive/DESKTOP_APP_WORKPLAN.md`
  （ARCHIVED/SUPERSEDED 头部；README 引用同步）。根目录不再有"像当前工作计划"的
  冲突事实源。
- `AGENT_CONTEXT.md`（旧 Web 控制台事实源）加 SUPERSEDED 横幅。
- 事实优先级（代码 > 测试 > RULES 安全约束 > PROJECT_STATE > 历史文档）已在
  CURRENT STATE 与交接说明中明确。

## B. Standalone Model — PASS（真实 HTTP 路径）/ NOT_RUN_ENVIRONMENT（真实 Key 回合）

新增 `scripts/test-standalone-model-path.mjs`（7 组，全部真实 TCP/HTTP，不是桩替换）：

- **零 DSH 依赖**：chat-service 以 `api:null` + 无 `controlExecute` 构造，经本地真实
  HTTP 的 OpenAI 兼容 Provider 完成整回合（流式 → 定稿 → usage 落盘）；源码级断言
  `src/model/**` 零 DSH 导入、零 DSH 端点。
- **应用重启**：全新服务实例重载 sessions/history，会话与历史完整。
- **停止**：真实挂流（服务端停发数据）上 abort → cancelled partial 落盘。
- **Retry**：401 失败回合 → 修复后重试同一 user 消息成功（不重复落盘）。
- **无效 Key**：401 → send 同步结构化拒绝；错误与历史零 Key 泄漏；会话保留可重试。
- **Provider 不可达**：真实连接拒绝 → 结构化拒绝，错误与 DSH 无关（不回退 DSH）。

**修复的两个真实产品缺陷**（fixture 先于修复复现）：
1. `openai-compatible` SSE 读取循环不感知 abort：服务端停发数据时 `reader.read()`
   永久阻塞，"停止"失效。修复：abort 竞争 + `reader.cancel` 关闭 socket。
2. Model 通道 `send` 阻塞整个回合：UI 单 worker IPC 线程被占住 → 流式不可见、停止
   不可达、回合超过 IPC 10s 超时必报错。修复为"握手"语义：send 等待首个流事件
   （首事件前失败仍同步拒绝，会话 1 契约不变；流开始后立即返回、后台推进）。

**真实 Provider（DeepSeek/OpenAI 官方端点 + 真实 Key）回合：NOT_RUN_ENVIRONMENT**
（本机 `state/provider-keys.json` 不存在；未向用户索要 Key，未伪造验证）。

## C. Workshop UI — PASS

`desktop-shell/src/workshop_ui.rs`（Work 页内 "Workshop（工作坊）" 区域）：

- 列表 + 状态计数/过滤：submitted / approved / provisioning / provision_failed /
  active / rejected / delivered；每条显示 submitter、来源（requestId）、title、
  description、requirements、supplements、createdAt/updatedAt、status、派生风险、
  计划字段（workspace/provider/capabilities/model/reasoning）。
- Owner 审阅：批准前必须显式确认 checkbox；默认最小能力集（read/write/git.status/
  git.diff），test.run / git.commit / workspace.create / memory.* 需主动勾选——
  不默认授予全盘/shell/网络；拒绝必须填理由（提交者可见）。
- 批准后展示 Task ID/Workspace/状态/阶段/进度/Agent/Session/Checkpoint + Continuity
  上下文（%、source、建议）；provision_failed 显示错误并可重试。
- Artifact 交付：仅 Task completed + 显式确认时可用（Runtime 侧同样强制）；交付列表
  只对 Owner 展示全文。
- cargo 测试 7 组（解析/风险推导/默认最小能力/确认门槛/交付门槛/状态关联/过滤）。

## D. Capability Coverage — PARTIAL（按计划只做 Adapter 与关键路径）

新增 `CAPABILITY_COVERAGE.md`（逐模块 Brokered / Adapter / Direct(by design) /
Deferred 矩阵 + 理由）与 `src/capability/adapters.js`：

- **本轮迁移**：`channel.status`、`channel.declarations`、`mesh.status`、
  `mesh.capabilities` 只读进 Broker；`channel.send` 建校验面（permission
  `message.send`、risk high、actor/channel/target/allowlist 校验、text 有界、
  白名单未配置 fail-closed）。
- **有意不迁移**：QQ MCP 工具链（适配器硬边界更细：发送白名单 + 风险卡逐次审批，
  搬进 Broker 是边界弱化）；Mesh pair/trust/grant（已是 Owner 显式操作 + approvals）。
- **channel.send 真实传输未绑定**（`sendImpl` 注入点缺省 → `PROVIDER_UNAVAILABLE`
  如实报告）：QQ 实际发送仍走原边界；绑定真实传输属后续。
- 测试：`test-capability-coverage.mjs` 6 组（注册/只读/正面/五类负面/未绑定如实/
  external 拒绝）。

## E. Agent Security — PASS（受控执行边界，非 OS 沙箱）

`src/workspace/isolated-runner.js`：Managed Agent `test.run` 从"无条件 DENY"升级为
**受控执行**（命令 allowlist：`npm test` / `npm run <script>` / `cargo test [name]`；
argv 逐 token 白名单，无空白与 shell 元字符；最小 env 白名单，宿主凭据不透传；
stdin 关闭；超时杀进程树；maxBuffer + 截断标记；cwd 固定 workspace root；并发上限 4）。
win32 上 npm 经显式 `cmd.exe /d /s /c` 包装（Node CVE-2024-27980 后禁止 shell:false
spawn .cmd），经 cmd 的只有已过 token 校验的参数。

- runner 未注入时保持原 `TEST_SANDBOX_UNAVAILABLE` fail-closed（既有断言不回归）。
- 测试：`test-isolated-runner.mjs` 6 组（正面 2、负面 7 向量、最小 env、超时杀树、
  output 有界）；`test-security-negatives.mjs` 补 Broker 层：非 allowlist 命令经
  Broker 仍拒、跨工作区 test.run 拒。
- 边界如实声明：这是受控执行边界，**不是 OS 级沙箱**（子进程系统能力与普通进程
  相同；allowlist 的意义是模型只能触发工作区自身定义的测试入口）。

## F. Extension Security — PASS（契约）, VM Host 保持

`src/extension/process-host.js`：ProcessExtensionHost **契约 + 帧协议**
（v:1 invoke/result/error/cancel/ping/pong），transport 注入（fixture 全测），强制
安全契约：能力白名单（未声明/未授权不出帧）、帧大小上限（发送前拦截）、帧模式校验
（坏帧丢弃）、每次 invoke 墙钟超时、cancel 后迟到结果丢弃、shutdown 拒绝后续调用、
health 如实。`createExtensionHost` 仍 = `VmExtensionHost`（Alpha/受信扩展的活动宿主，
如实标注 VM 不是进程隔离）；真实进程沙箱**有意不在本轮实现**（半吊子进程隔离比
没有更危险），按同一契约后续接入。测试：`test-process-extension-host.mjs` 8 组。

## G. Product Cleanup — PASS

- `package.json` description 改为 CetaMesh 产品定位（包名 `whalebridge` 保持兼容）。
- README 顶部重写：CetaMesh 产品主区（Chat/Work/Memory/Workspaces/Agents/Plugins/
  Devices/Connections/Security/Settings）在前；DSH 与 QQ 归入 Optional Integrations
  （非 Core 依赖）；新增 CAPABILITY_COVERAGE 入口。
- 旧注释清理：chat-service 顶部与 `startModelOrDshTurn` 的"只记录不执行/属会话 2"
  已按现实现实（Smart agent-intent 经 platformRoute 受控执行；回退语义只存在于
  未注入 platformRoute 的精简装配）。
- 遗留未跟踪实验文件（`plugins/cetamesh-*`、`src/desktop-plugin-*`、
  `desktop-shell/native-spike/`、`design-demos/*`、`output/`、`%SystemDrive%/`）：
  自洽簇、已提交代码零引用，**保持未跟踪原样**（未纳入提交、未删除）。

## H. UI Integration — PASS（增量，未大改设计语言）

- **Work 页**：新增 Tasks | Workshop 内部 tab（Workshop Owner 审阅，见 C）。
- **Continuity UI（Work 详情）**：选中任务自动读取 `continuity.status`/`history`；
  展示 Context%（真实 usage / 字符估算）、阈值建议（none/checkpoint/ready/rollover/
  forced/emergency）、rollover 策略声明、Fresh Session rollover 历史（from→to +
  原因 + 跨 Provider 标记 + seq），并注明"同一 Task 的 Session 交接、Task ID 不变"。
- **Capability 审批入口**：审批页新增 Capability 审批队列（进入自动读取 +
  批准一次/拒绝；指纹绑定单次生效）；此前该队列没有任何 UI 入口。
- Chat 页沿用会话 1/3 的 Model/Agent 区分，无回退。

## Tests

全部在本机实跑（`PASS` / `FAIL` / `NOT_RUN_ENVIRONMENT` / `NOT_APPLICABLE` 分类）：

| 套件 | 结果 |
| --- | --- |
| `test-standalone-model`（新增，真实 TCP/HTTP 7 组） | PASS |
| `test-capability-coverage`（新增 6 组） | PASS |
| `test-isolated-runner`（新增 6 组，真实子进程） | PASS |
| `test-process-extension-host`（新增 8 组） | PASS |
| `test-security-negatives`（新增 8 组） | PASS |
| `test-agent-broker` 7 / `test-agent` 23+真机段 / `test-managed-agent` | PASS |
| `test-capability` / `test-workshop` / `test-workspace` / `test-task` / `test-memory` / `test-memory-link` | PASS |
| `test-continuity-rollover` / `test-continuity-auto-rollover` / `test-workspace-reconciliation` | PASS |
| `test-extension` / `test-extension-capability` / `test-mesh` / `test-model-runtime` / `test-smart-router` / `test-model-selection` / `test-smart-platform-routing` / `test-provider-secrets` | PASS |
| `test-platform` / `test-ipc-protocol` / `test-control-service` / `test-desktop-chat-product` 17 组 / `test-owner-agent-mode` | PASS |
| `test-config` / `test-core-entry` / `test-privilege` 24 / `test-dsh-integration` / `test-system` 108 / `test-architecture` 8 组 | PASS |
| `test-core-dist`（修正断言后真实跑通：全功能段 + 无本测试产物残留） | PASS |
| `test-md` / `test-wait` / `test-forward` / `test-card` / `test-local-services` / `test-slang` / `test-stickers` / `test-app-paths` / `test-app-icon` | PASS |
| `test-vision`（端点探针因端口被其它实例占用） | PASS + 1 项 NOT_RUN_ENVIRONMENT |
| `desktop:check` / `desktop:test` | PASS（cargo 100/100） |
| `test-desktop-supervisor` / `test-desktop-shell`（GUI 冒烟） / `test-desktop-install` / `test-installer-package` | PASS |
| 真实 Provider（官方端点 + 真实 Key）回合 | NOT_RUN_ENVIRONMENT（无 Key） |
| 真实 QQ（SnowLuma）全模式 / 跨设备 Mesh 真链路 / 代码签名 | NOT_RUN_ENVIRONMENT |

环境说明（如实记录）：
- 用户已安装的 CetaMesh 实例在运行（占用 127.0.0.1:3100 与 `WhaleBridgeCore.exe`）。
  `test-core-dist` 的残留断言已改为只统计本测试产物路径（原断言隐含"机器上没有任何
  Core 在跑"）；`test-vision` 的 live 探针在 401/403 时分类 NOT_RUN_ENVIRONMENT。
  两处都是测试口径修正，不是功能放宽（其余状态码仍按原样判定）。

## Release Build

| 步骤 | 结果 |
| --- | --- |
| `npm run build:core` | PASS |
| `npm run desktop:build` | PASS |
| `npm run build:release`（干净 worktree @ `32571d4`） | PASS（buildId `1.0.0-rc.1+32571d4`，dirty=false） |
| `npm run test-release-candidate`（对干净 RC） | PASS（中文+空格路径安装 / 无系统 Node / 只读安装目录 / 崩溃恢复 5.9s / 单实例 / 孤儿守卫 / 卸载保留数据） |

产物（`dist/app`，干净构建）：

- `WhaleBridge-Setup-x64.exe` 42,037,248 字节
  SHA256 `6EBB6B364217D48273BD0209EAC123D98435B6545FAD7424C185E2D39E99EE33`
- `WhaleBridge.exe` SHA256 `551B167A4671F08E4809B2A0882DD9D225CECFB0673946775E1DD595F5FE190F`
- `payload/WhaleBridgeCore.exe` SHA256 `5CF6F52DA41805F52419FD3A5ACDFFDC5DAA8DDB08090ADAA9E7BF734DAA59B8`

前一次（dirty）候选保留在 `dist/app-dirty-2026-10-05` 供对照。

## Final Acceptance Table

| 项 | 状态 | 依据 |
| --- | --- | --- |
| Standalone Chat without DSH | PASS | 无 api/controlExecute 构造完成真实 HTTP 回合（test-standalone-model 7 组） |
| Smart Router | PASS | simple→Model / tool→Capability→Model / project→Task→Agent（test-smart-router + platform） |
| Model Provider | PASS | Model Runtime 12 组 + provider-secrets 6 + 无 Key fail-closed |
| Agent Broker | PASS | test-agent-broker 7 + managed-agent + 真机 DSH 段 |
| Persistent Task | PASS | test-task（Task 独立于 Session；rollover 后 Task ID 不变） |
| Automatic Fresh Session | PASS | test-continuity-auto-rollover 9 组（阈值/估算/安全点/防重复） |
| Workspace Reconciliation | PASS | test-workspace-reconciliation 6 组（真实 git 仓库） |
| Capability Broker | PASS | test-capability + 新增 coverage 6 组 + negatives 8 组 |
| Workshop Runtime | PASS | test-workshop |
| Workshop Owner UI | PASS | workshop_ui.rs + cargo 7 组（Work 页内区域） |
| Memory v2 | PASS | test-memory 85 / memory-link |
| Memory Link | PASS | test-memory-link（跨作用域需显式授权） |
| Extension Capability | PASS | test-extension + extension-capability（经 Broker） |
| Channel Adapter | PASS（Adapter） | 只读 + send 校验面进 Broker；真实发送传输未绑定（by design，见 D） |
| Mesh Adapter | PASS（Adapter） | status/capabilities 只读进 Broker；trust/grant 保持 Owner 操作面 |
| Isolated Test Runner | PASS（受控边界） | test-isolated-runner 6 组；非 OS 沙箱（如实声明） |
| Process Extension Host | PARTIAL | 契约 + 帧协议 + fixture 测试完成；真实进程 transport 未实现（有意） |
| Release Candidate | PASS | 干净构建 + RC 验收 7 项全过；未签名 → 见下 |

## PASS / PARTIAL / BLOCKED / NOT_RUN_ENVIRONMENT 汇总

- **PASS**：A–H 全部阶段目标、17/18 项最终验收表、全部回归与 Release 链。
- **PARTIAL**：Process Extension Host（契约已交付、真实进程沙箱按计划留待后续）；
  Capability 全量目录（MCP/QQ/完整 Mesh 有意保持 Direct，理由已记录）。
- **BLOCKED**：无。
- **NOT_RUN_ENVIRONMENT**：真实 Provider Key 回合、真实 QQ 全模式、跨设备 Mesh
  真链路、代码签名 / 干净 VM 人工走查；`test-vision` 的 live 端点探针（端口被他
  实例占用）。

## Recommended Next Step

1. 在有真实 Provider Key 的机器上跑 `npm run test-standalone-model` 的同款人工验收
   （配置 `state/provider-keys.json` 后 Chat 页直接发一条消息即可），补上唯一缺失的
   真实模型链路证据。
2. 用户确认本分支后合并 main、删除工作分支（沿用会话 1–3 的流程）。
3. 后续候选（需用户批准再启动）：ProcessExtensionHost 真实进程 transport、
   Channel `sendImpl` 绑定、Workshop 交付物与 Task artifacts 的联动、代码签名。
   **不启动**：Marketplace / Cloud / Mobile / 大型 Knowledge Graph / Multi-Agent
   Scheduler。
