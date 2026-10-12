# CetaMesh Desktop UX v2 — 生产能力对照

Owner 选定方向：**01 Harbor**。本表对照用户提出的生产能力与当前 Core / Harbor 路由；“已接线”只说明接入真实 DTO / action，不等同于真实外部服务 E2E 或视觉验收。

## 状态定义

- **READY**：页面、Core 路由和适用的本地合同均已接通；不代表外部供应商已经实测。
- **PARTIAL**：有真实接线，但缺少完整字段、外部环境或人工验收。
- **BLOCKED**：当前 Core 配置或安全边界使该能力不可用。
- **NOT_APPLICABLE**：该项不属于此产品或平台范围，并说明原因。

## 页面与能力

| 页面 / 能力 | Harbor 实现与真实入口 | 状态 | 缺口 / 本轮验收边界 |
| --- | --- | --- | --- |
| Chat | `ui.chat.sessions.*`、分页 `ui.chat.history`、`ui.chat.send`、`ui.chat.stop/retry/continue`；Chat 时间线由 Harbor `VirtualList` 渲染 | PARTIAL | 稳定 ID 去重、分页、锚点恢复和 100/200/500 条自动窗口 fixture 均通过；每页最多 200 条，500 条经多页读取。真实 Provider 回合、真实 DOM 内存和手工滚动验收未执行。 |
| 模型选择 | `ui.chat.catalog`、`ui.chat.config.set`、`ui.onboarding.setModel`；Provider 声明其高级字段，API key 仅在密码输入控件和单次 IPC 参数中短暂存在 | PARTIAL | Base URL / reasoning 等 Provider 实际消费的字段有设置入口；runtime 不支持配置的 timeout 不暴露。没有真实 Provider 凭据回合。 |
| Streaming | `chat.streaming` / `chat.updated` 由 Chat service 经 composition root 进入 UI event bus；状态刷新按 animation frame 合并，Chat 区分底部跟随与历史阅读 | PARTIAL | 虚拟列表与流式行、锚点/新消息提示的本地合同通过；没有真实模型 token 回合或长时间流式性能验收。 |
| 附件 | Renderer 通过 Rust 文件选择边界，Chat service 附件上限与桥接 DTO 约束生效 | PARTIAL | 本轮没有选取真实文件并向 provider 发送的 E2E；不支持任意路径读取。 |
| Tool Calling | 运行时走现有 Capability Broker / provider 能力；本地兼容 Provider fixture 覆盖工具调用与续接 | PARTIAL | Tool Calling fixture / contracts PASS；没有真实 provider + gateway 的完整工具回合；QQ 高风险工具仍按既有权限策略。 |
| Approval | `ui.approvals.list/decide`、`approval.pending/resolved`；Chat 右侧收到刷新后的审批数据 | PARTIAL | 本地批准/拒绝/续接、过期与重放防护合同 PASS；没有真实高风险工具触发到用户逐次批准的 Provider 端到端回合。 |
| Tasks / Work | `ui.task.overview/get/create/pause/resume/cancel`、`task.updated/deleted` | PARTIAL | Core 合同实测创建、读取任务及更新事件；真实长任务、故障恢复及多 Agent 工作负载未手工运行。 |
| Workspace | Task/Workspace 元数据走 Core；文件选择与授权产物打开边界留在 Rust Host | READY | `artifact.open` 从授权 task/artifact 身份解析规范路径，检查 workspace/artifact 根边界、符号链接/联接逃逸和允许类型；拒绝未知 scheme 与任意可执行文件。边界合同 PASS；真实 Windows 默认程序打开的手工确认未执行。 |
| Context Panel | Chat 右侧读取当前 Chat 的 Task 状态、Memory 结果、Approval 列表和 Artifact 元数据；订阅事件并轮询刷新 | PARTIAL | DTO 来自 Core；Artifact 不展示路径或任意 `ref`，打开动作走 Rust Host 安全边界。真实运行期负载与视觉密度未手工验收。 |
| Artifact 元数据 | Chat 上下文展示列表、空状态与脱敏详情；授权产物打开由 Host 处理 | READY | Renderer 只发送身份，不接收内部 `ref` / 路径；授权路径与文件类型边界合同 PASS。手工确认最终默认程序行为未执行。 |
| Memory | `ui.memory.overview/get/create/update/pin/delete`、`memory.updated`；完整 Memory 通过 Chat 上下文“查看全部”进入，不占主导航 | READY | Core 合同实测创建、更新；页面可编辑、固定、删除。Owner 视觉验收仍待执行。 |
| Agents | `ui.agent.list/health` 与 Agent 注册表 | PARTIAL | 本机真实 Registry 快照（2026-10-12 20:19 CST）：Codex ready（`codex-cli 0.162.0-alpha.17.2`）；DSH Agent unavailable（`not_connected`）；检测到 ZCode，但外部 Agent 控制不受支持。此为单机健康快照，未执行 Agent 任务。 |
| DSH Desktop / DSH Provider | 桌面应用安装状态和 Agent Provider 健康状态分别显示 | PARTIAL | 本机快照：DSH Desktop 已安装（`0.2.0-rc.2`）、未运行；DSH Agent 为 unavailable（`not_connected`）。桌面安装状态与 Provider 可用状态独立报告；未执行 DSH Agent 任务。 |
| Plugins 目录 | `ui.plugins.catalog/status/detail/refresh`；全部、精选、已安装、可更新筛选；“Update Available”映射为 update | PARTIAL | Core 返回的截图仅为数量，没有安全本地图片 URL；远程图片不注入特权 WebView。 |
| Plugin 安装 / 更新 | `ui.plugins.stage/install`；安装和更新均经过包审核 / 权限复核；已安装包更新进入 Extension update 流程 | PARTIAL | 本地 loopback catalog/package lifecycle fixture PASS；真实远端目录服务没有配置或连接。 |
| Plugin 专属设置 | Integration 设置走 `ui.plugins.integration.settings/manage`；普通 Extension 使用 manifest-backed schema 与独立设置入口 | READY | 本地 schema / 保存 / 投影合同 PASS；没有安装真实远端 Extension 包做交互验收。 |
| 内建 Integration / Bionic | Plugin Center 连接列表显示 Bionic；53 个工具可查看与逐项开关，危险工具继续受 Capability Broker 保护 | PARTIAL | 46 个已恢复、5 个部分支持、2 个退役进程控制工具不支持；工具清单与设置接线有合同覆盖，真实 QQ / Agent Gateway 未连接。 |
| MCP | `ui.mcp.list/tools/manage/config.get/config.update`；可启停/启动/停止/重启，配置投影脱敏 | READY | 本地 MCP process/host/safety fixture PASS；不提供任意 env/args 编辑；本机没有真实 production MCP Gateway。 |
| Devices | Settings 可见设备相关本地偏好 | PARTIAL | 没有完整设备注册表、配对状态列表或真实移动端互操作验收。 |
| Settings — Models | Provider / model 目录、默认选择和所选 Provider 实际支持的高级字段接入设置服务 | PARTIAL | 本地字段合同 PASS；runtime 不消费的 timeout 不提供设置。真实 Provider 凭据验证未运行。 |
| Settings — Appearance | `ui.settings.describe/get/update` 持久化 `general.theme`，Harbor 使用对应 token | READY | 实际外观需要各窗口尺寸和系统缩放的视觉验收。 |
| Settings — Window behavior | `startMinimized` 从 Core 设置读取；`confirmOnExit` 经 `app.setWindowBehavior` 应用 | READY | 设置合同与 Native Host 行为有自动化覆盖；真实多屏、DPI 和系统托盘体验待人工验收。 |
| Settings — Notifications | 有运行状态摘要 | PARTIAL | 当前不是可配置的完整通知偏好面板。 |
| Settings — Privacy / Security | 权限与本地数据策略由 Core 提供 | READY | 文案和安全合同已接线；需 Owner 对屏幕密度与可理解性进行视觉确认。 |
| Secret isolation | Provider key 通过密码输入框和一次 IPC 参数交给本机 Core；React state、设置 DTO 和日志不保存/回传密钥 | READY | `test-provider-secrets` 与 UI 源码合同通过；真实 Provider 凭据回合未执行。 |
| About / 版本 / Build | `ui.about.info` 读取 build/release 元数据；未配置开发者显示“未配置” | PARTIAL | 网站、开发者与反馈 endpoint 有若干未配置项；本机 build number 取决于 release manifest。 |
| Updates / Release Notes | `ui.update.check/notes` 使用 Update 服务与缓存公告 | PARTIAL | 此功能不等同于本轮发行包升级验证；签名/更新执行能力受真实发布配置约束。 |
| Feedback | `ui.about.feedback` 入口遵守本机产品配置 | BLOCKED | `feedback.baseUrl` 为空；当前不编造 URL 或发送反馈。 |
| Website | About 显示已配置的 GitCode / GitHub 项目链接 | PARTIAL | 官方网站配置为空，界面如实显示“未配置”。 |
| First Run | `ui.onboarding.status/start/completeStep/skipStep/finish/testProvider/setModel` | PARTIAL | 可在没有 QQ/DSH/移动端时完成本机引导；真实 Provider 测试依赖 Owner 凭据。 |
| Close / tray / window | WebView2 Rust Host、tray、窗口偏好、close-to-tray 和恢复 | PARTIAL | 自动化覆盖窗口创建、托盘、关闭隐藏、恢复及偏好；多屏、各 DPI、拖拽/贴靠行为待人工验收。 |

## 安全与交付边界

| 检查点 | 当前事实 | 状态 |
| --- | --- | --- |
| 正式 UI 方向 | 仅 01 Harbor；没有其他 UI 方案或方向混搭 | READY |
| Renderer 到 Core | Typed、allowlisted、bounded `ui.*` projection；敏感字段不回传给 React | READY |
| WebView 网络面 | 本地 `resources/desktop-ui`、`https://cetamesh.localhost`、CSP 与导航限制；生产不启动 UI HTTP/Vite server | READY |
| WebView2 用户数据 | Wry `WebContext` 将可变 profile 放在 `<user-data-dir>/webview2`；候选验收确认默认 exe 旁目录不存在且安装树不变 | READY |
| egui | 默认产品 UI 已是 Harbor/WebView2；`--ui=legacy` 与 egui 模块仍保留 | PARTIAL |
| 视觉一致性 | 用户截图被定义为唯一参考，代码合同覆盖组件和页面入口 | PARTIAL | 代码方向为 01 Harbor；运行中的窗口、五张截图、七页布局、键盘和滚动尚未人工对照。 |
| 性能 / 长列表 | Chat 每页最多 200 条；VirtualList 将加载的历史限制在窗口内渲染 | PARTIAL | 100/200/500 条自动 fixture 分别只挂载 10/101、10/201、10/501 行；动态测量、稳定 ID、锚点与底部窗口通过。未做真实浏览器 DOM 内存/耗时基准或人工滚动。 |
| 发行包 / 安装升级 | 最终干净 feature HEAD 的 release candidate、manifest、SBOM 与候选安装生命周期 | PARTIAL | 最终候选的 build/sourceCommit/hash 记录在 `FINAL_PRODUCTION_CLOSURE.md`；代码签名、公开再分发所需许可证材料和 Owner 视觉验收仍是公开发布前置条件。build-1057 已过时，不得作为最终候选分发。 |

## 对应合同

- `scripts/test-desktop-ui-v2-production.mjs` 已登记在 `scripts/run-all-tests.mjs`。
- 合同覆盖 Harbor 入口、Typed UI bridge、生产 WebView 限制、Memory、MCP、模型密钥不落 React state、About 元数据、Agent 状态、Chat 上下文与 Plugin 安装/更新映射。
- 自动化合同不代替视觉对照、真实 Provider / QQ / MCP Gateway 测试或安装包人工验收。
