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
| Chat | `ui.chat.sessions.*`、`ui.chat.history`、`ui.chat.send`、`ui.chat.stop/retry/continue`；`ui.events.next` 投递更新 | PARTIAL | Core 合同实测创建会话、读取历史；历史单次最多 200 条。真实 Provider 回合、100/500 条长历史性能基准尚未执行。 |
| 模型选择 | `ui.chat.catalog`、`ui.chat.config.set`、`ui.onboarding.setModel`；API key 仅在密码输入控件和单次 IPC 参数中短暂存在 | PARTIAL | 没有真实凭据回合；高级 Base URL / reasoning / timeout 配置没有完整 UI/API。 |
| Streaming | `chat.streaming` / `chat.updated` 由 Chat service 经 composition root 进入 UI event bus | PARTIAL | 事件接线合同通过；本轮没有外部模型回合、长消息、多工具并行或持续流性能验收。 |
| 附件 | Renderer 通过 Rust 文件选择边界，Chat service 附件上限与桥接 DTO 约束生效 | PARTIAL | 本轮没有选取真实文件并向 provider 发送的 E2E；不支持任意路径读取。 |
| Tool Calling | 运行时走现有 Capability Broker / provider 能力 | PARTIAL | 没有真实 provider + gateway 的完整工具回合；QQ 高风险工具仍按既有权限策略。 |
| Approval | `ui.approvals.list/decide`、`approval.pending/resolved`；Chat 右侧收到刷新后的审批数据 | PARTIAL | 本轮没有真实高风险工具触发到用户逐次批准的端到端回合。 |
| Tasks / Work | `ui.task.overview/get/create/pause/resume/cancel`、`task.updated/deleted` | PARTIAL | Core 合同实测创建、读取任务及更新事件；真实长任务、故障恢复及多 Agent 工作负载未手工运行。 |
| Workspace | Task/Workspace 元数据走 Core；文件选择和打开边界留在 Rust Host | PARTIAL | Artifact DTO 目前只有 id/kind/label/createdAt；没有安全的 `artifact.open` 能力。 |
| Context Panel | Chat 右侧读取当前 Chat 的 Task 状态、Memory 结果、Approval 列表和 Artifact 元数据；订阅事件并轮询刷新 | PARTIAL | DTO 来自 Core；Artifact 不展示路径或任意 `ref`，且没有安全的打开动作。真实运行期负载与视觉密度未手工验收。 |
| Artifact 元数据 | Chat 上下文展示列表、空状态与脱敏详情 | PARTIAL | 不展示内部 `ref` / 路径；因为 Core 尚无安全打开动作，不能打开产物。 |
| Memory | `ui.memory.overview/get/create/update/pin/delete`、`memory.updated`；完整 Memory 通过 Chat 上下文“查看全部”进入，不占主导航 | READY | Core 合同实测创建、更新；页面可编辑、固定、删除。Owner 视觉验收仍待执行。 |
| Agents | `ui.agent.list/health` 与 Agent 注册表 | PARTIAL | 本机真实 Registry 快照（2026-10-12 20:19 CST）：Codex ready（`codex-cli 0.162.0-alpha.17.2`）；DSH Agent unavailable（`not_connected`）；检测到 ZCode，但外部 Agent 控制不受支持。此为单机健康快照，未执行 Agent 任务。 |
| DSH Desktop / DSH Provider | 桌面应用安装状态和 Agent Provider 健康状态分别显示 | PARTIAL | 本机快照：DSH Desktop 已安装（`0.2.0-rc.2`）、未运行；DSH Agent 为 unavailable（`not_connected`）。桌面安装状态与 Provider 可用状态独立报告；未执行 DSH Agent 任务。 |
| Plugins 目录 | `ui.plugins.catalog/status/detail/refresh`；全部、精选、已安装、可更新筛选；“Update Available”映射为 update | PARTIAL | Core 返回的截图仅为数量，没有安全本地图片 URL；远程图片不注入特权 WebView。 |
| Plugin 安装 / 更新 | `ui.plugins.stage/install`；安装和更新均经过包审核 / 权限复核；已安装包更新进入 Extension update 流程 | PARTIAL | 未在本轮下载并安装一个真实远端目录包。 |
| Plugin 专属设置 | Integration 设置走 `ui.plugins.integration.settings/manage` | PARTIAL | 普通 Extension 的独立设置 schema / 页面未提供。 |
| 内建 Integration / Bionic | Plugin Center 连接列表显示 Bionic；53 个工具可查看与逐项开关，危险工具继续受 Capability Broker 保护 | PARTIAL | 46 个已恢复、5 个部分支持、2 个退役进程控制工具不支持；工具清单与设置接线有合同覆盖，真实 QQ / Agent Gateway 未连接。 |
| MCP | `ui.mcp.list/tools/manage/config.get/config.update`；可启停/启动/停止/重启，配置投影脱敏 | READY | 不提供任意 env/args 编辑；本轮未连接真实 MCP Gateway。 |
| Devices | Settings 可见设备相关本地偏好 | PARTIAL | 没有完整设备注册表、配对状态列表或真实移动端互操作验收。 |
| Settings — Models | Provider / model 目录与默认选择接入设置服务 | PARTIAL | 高级模型字段和真实 Provider 凭据验证缺失。 |
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
| 性能 / 长列表 | Chat 历史请求有上限，避免无界 IPC/渲染 | PARTIAL | 当前历史单次上限 200；100/500 条、长 Markdown 和密集工具事件的时间/内存基准未执行，500 条目前没有单次历史 DTO 支持。 |
| 发行包 / 安装升级 | Formal `build:release` build-1057、release audit、SBOM 与候选安装生命周期已通过 | PARTIAL | 私有候选包已验证；仍需代码签名、公开再分发所需许可证材料及 Owner 的视觉验收，因此尚不能标记为公开发布就绪。 |

## 对应合同

- `scripts/test-desktop-ui-v2-production.mjs` 已登记在 `scripts/run-all-tests.mjs`。
- 合同覆盖 Harbor 入口、Typed UI bridge、生产 WebView 限制、Memory、MCP、模型密钥不落 React state、About 元数据、Agent 状态、Chat 上下文与 Plugin 安装/更新映射。
- 自动化合同不代替视觉对照、真实 Provider / QQ / MCP Gateway 测试或安装包人工验收。
