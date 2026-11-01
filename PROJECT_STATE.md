# CetaMesh — 当前项目状态

更新日期：2026-11-01。

## Workspace 增量可靠性治理（2026-11-01，开发分支）

- 保留既有 Workspace/Task ID、JSON 存储、Broker 和 Diff 组件；[维护契约](docs/desktop/WORKSPACE.md)明确状态所有者与恢复边界。
- 批量成果导入一次保存注册表元数据，仍保留逐文件审计；不可逆 UTF-8 转换在导入前拒绝，不损坏二进制原件。
- 未确认导入/提交保留证据并封锁相关目录树，其他不重叠项目继续可用；旧审批兼容接口重查策略，已知未执行与未知结果分别处理，持久化失败不能擦除执行围栏。
- 修复 StateDir 受管 Git Worktree 被安全过滤为空的实际故障，来源核验仅允许准确受管子树；秘密、路径与导入审批边界保留。
- 任务列表使用真实服务器分页，项目版本提示真实总数/截断，普通导航隐藏无关任务隔离目录；打开项目可进入该项目任务，专业 Git 入口继续保留。
- 源码、真实本地 Git/文件系统与隔离 Core IPC 验证独立记录；模型、外部 Agent、原生窗口与发行验收不得互相冒充。Defender RELEASE HOLD 和未发布状态不变。

## 正式仓库与平台

- 官方公开仓库：https://github.com/chx6418-source/CetaMesh
- 2026-10-21：Desktop + Mobile 的已审查源码快照合并到公开 main，提交 `350c1fc4ec8d21d9ae7ac80285979c588c007e99`。
- 2026-10-22：公开文档与旧设计清理 PR #4 合并到 main，提交 `1235d1526757a503182489d44c32e9dffd6db79b`。
- Desktop 主工程位于 `src/`、`desktop-shell/`、`desktop-ui/`；Mobile 位于 `apps/mobile/`。两端各自保留运行时、依赖、权限和发布过程。
- 原桌面端及移动端私有仓库保留独立历史。公开仓库只导入审核过的源码快照，没有合入完整私有 Git 历史。

## 已有代码与安全边界

- Desktop 具备直连 Model Provider 的聊天、任务、工作区、记忆、Agent Broker、Capability Broker、插件与 Device Mesh 基础。
- Mobile 具备独立的 Chat、Memory、Tasks、设备身份和权限能力，并包含 Android 与 iOS 原生工程。
- 授权与信任是两回事。配对不自动开放工具、记忆读取或远程执行；跨设备同步还需要专门授权与验证。
- SnowLuma 主程序和受限 SDK/MCP 不包含在正式公开源代码及其打包输入中；可选 QQ 连接基于独立 OneBot 实现。
- 现有 GitHub Releases 包含 Windows 候选构建，但不等于稳定发行；历史更新入口仍需兼容。

## 已验证及未完成的门禁

- 公开仓库清理 PR #4 在合并前的最终 Windows/Android CI 均通过；该验证只对应当时的源码提交。
- Android CI 构建并检查包含 JS Bundle 的 Standalone Release APK，使用临时测试签名。
- 真实 Android/iOS 设备能力、Desktop↔Mobile 配对与任务接续、第三方 Provider 真实工作流、代码签名、更新验签与完整第三方二进制许可仍需按版本和环境独立验收。
- 不应把源码存在、模拟测试通过或 Android CI 通过当作 iOS 和全功能上线的证据。

## 当前开发工作

- 公开介绍校准 PR #5 已合入 main（33b10b3）；本轮保留其内容，并在该公开历史上同步已确认的 Desktop UI 与 Agent 源码快照。
- 下一阶段应优先解决真实终端验证、外部 Agent 接入稳定性和发行门禁，避免为当前用户造成已全部稳定可用的印象。

[项目主页](README.md) · [统一开发与构建](docs/MONOREPO.md) · [桌面限制](docs/desktop/KNOWN_LIMITATIONS.md) · [移动端指南](apps/mobile/README.zh-CN.md)

## Desktop 源码同步（2026-10-23）

- 补齐上一轮遗漏的 GitHub 公开仓库同步；本轮以公开 main 的 33b10b3 为基线，保持独立公开历史。
- 包含绿色应用图标、紧凑标题栏、图标侧栏和记忆入口、竖向设置、任务卡片、输入区与动效，以及有条件的八项 Agent 注册/RPC/ACP/SDK/API 适配。各 Provider 仍按真实能力与权限门槛决定可用性。
- Mobile、公开介绍、文档清理、独立 OneBot、SDK/MCP 排除与现有更新入口保持。详细实现边界见 [Agent 接入状态](docs/desktop/AGENT_INTEGRATION_STATUS.md)。
- 实际公开快照经统一入口选择31项测试：30 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT；唯一跳过项为缺少新产物的 Agent SEA。前端 TypeScript/Vite 构建通过，独立导出边界审查无 Critical/Important/Minor 发现。未重新运行全部测试、Cargo 或 Mobile 测试；共享协议与 Mobile 源码未变。真实账号、原生安全和正式安装验收仍单独保留。

## Desktop 当前修复（2026-10-23）

- 统一侧栏折叠和会话工具按钮，收紧聊天标题、输入区及任务卡片；记忆列表采用可读摘要、横向操作与折叠原文，保留原始存储内容。
- 新增右侧多标签引用查看面板：工作区／交付物只读文件预览与独立原生网页视图，权限及网络边界见 [Desktop 架构](docs/desktop/ARCHITECTURE.md#docked-reference-viewer)。
- 修复 DSH Follow 初始化序号、已结束任务的聊天配置解绑及工作区快照对依赖／缓存目录的处理；仍保留工作区写入归属、审批和快照大小限制。
- 修复 Codex 原生策略检查对无关键名的误报；策略无法验证时仅将该 Provider 标记为不可用，Core 可继续启动，执行与授权检查仍拒绝未经验证的策略。
- 补齐菜单退出及布局反馈动效，统一时长与缓动，并遵循系统减少动态效果设置。
- 开发者显示为 chx6418-source，GitHub 入口指向公开 CetaMesh 仓库。更新页明确显示缺少可信公钥或清单的原因；签名校验继续强制执行，尚未配置的更新服务不视为可用。
- 本轮合并不包含新版安装包或正式发行。真实账号工作流、已安装版本的原生视觉验收及 Mobile 验证仍按各自门禁处理。

## Desktop 窗口尺寸修复（2026-10-25）

- 关闭独立网页预览后，Wry 0.55.1 的子视图析构会移除主窗口自动缩放回调，导致后续最大化时主界面停留在旧尺寸。主视图现改为显式维护物理客户区尺寸的子 WebView，响应尺寸、位置和 DPI 变化，并保留焦点转交。
- 原生回归先复现窗口 1375×900、主视图仍为 1200×800 的失败，再验证预览销毁、缩放、最大化、还原及再次缩放。测试同时检查原生容器、WebView2 控制器和实际窗口状态，避免仅凭前端 resize 事件判断成功。
- 修复版完整应用的最大化与还原已在当前 Windows 桌面观察通过；独立数据目录中的网页预览、壳生命周期、相关权限／UI 契约及 Rust 单元测试通过。跨显示器 DPI 切换尚未实机验证。

## Desktop 内容区适配修复（2026-10-25）

- Agent 卡片按内容定高、按可用宽度自动分列，DSH 连接设置默认折叠；关于页信息卡保持独立高度并允许长构建标识换行。
- 设置页取消居中大留白，保留竖向分类；设置和插件控件随内容区宽度调整，包含停靠查看面板压缩页面的情形。窄窗口默认收起工作区列表，保留展开入口，并在切换页面后收起覆盖层。
- 修复没有活动引用时，窄窗／高缩放误隐藏主页面的问题；只有实际打开引用时才启用引用与正文切换，关闭最后一个引用恢复页面。
- 浏览器回归覆盖 480–1600px 的 23 组窗口／内容区、真实挂载侧栏及引用关闭可见性。完整原生应用的相关页面在常规及 160% 应用缩放下核对，外部 Agent 联通和跨显示器 DPI 仍独立验收。

## Desktop 父子任务反馈修复（2026-10-25）

- 父任务存在未结束子任务时，卡片与详情明确显示依赖原因，禁用启动／继续，并提供子任务查看和返回父任务入口。执行前只读核对最新版本和依赖，Core 的执行归属与父子任务围栏保持强制。
- 任务操作错误显示在对应任务详情中，避免成为工作列表的全局加载错误；异步查看任务与动作回复尊重新的选择或关闭操作。
- 父子任务围栏、版本冲突及界面回归通过；原生演示验证仅查看独立父子任务，核对后两者仍待启动、未附加 Agent、无执行记录。

## Desktop 启动与任务快照修复（2026-10-25）

- StateDir 所有权增加与锁摘要绑定的进程出生身份，避免 PID 被其他程序复用后误阻止启动；保留旧锁格式、重复实例互斥和未知身份时的保守拒绝。
- Git 工作区快照保留已跟踪与未忽略的新文件，固定任务开始时的忽略规则，排除之后新生成的构建输出与嵌套仓库；忽略规则变化不能掩盖基线文件的删除。512 MiB、凭据过滤、审批和工作区围栏继续生效。
- 回归覆盖进程锁竞争与身份不明、快照上限、延后构建输出、嵌套忽略／否定规则、空目录新文件与子仓库；源码检查和打包后进程验证按各自阶段运行。

## Desktop Agent 安装状态修复（2026-10-25）

- Gemini、OpenCode、Qwen 与 Claude 分别报告桌面客户端安装证据、CLI 安装状态及 Agent 连接就绪状态，包含已验证安装布局和 Claude Windows Store 安装。检测结果可刷新，读取失败保留未知。
- 已安装客户端但连接未验证时显示“已安装 · 待接入”，不再误报未安装；桌面客户端存在不会自动通过 CLI 协议、SDK、原生权限或任务执行验证。

## Desktop 原生 Agent 逐次审批接入（2026-10-25）

- 按 Owner 选择新增显式 native-permissions 模式，声明无 OS 沙箱；原有 native/isolated 门禁不变。原生工具（含读取）逐次审批，成果导入另行审批，运行时及策略变化、取消和未确认退出保留原有执行围栏。
- OpenCode 随包 CLI 与 Qwen Code 0.26.1 接入生产配置、独立 profile、原生权限及任务装配；新增 Gemini/Qwen 官方 npm Windows shim 映射。Gemini 0.65.0 真实 ACP 请求缺少完整工具参数，保持 native_input_unverified，不开放任务执行。
- Claude 使用固定 SDK 0.3.308 与独立原生 Claude Code 运行时；增加全部工具 PreToolUse 审批和工具 ID 重放防护。桌面 GUI 不视为编码 CLI，未导入桌面登录；真实 CLI 与账号执行仍需单独验收。
- 四项连接设置可填写运行时、Node、模型和 HTTPS API；凭据按 Provider 保存在独立 Secret Store。配置凭据不等于认证已验证。损坏的可选配置保留原数据并显示不可用，不再阻止 Core 启动。
- 本地真实 CLI 验证采用隔离测试目录与合成模型服务；不调用付费模型，也不代表外部账户认证。发行与完整回归结果按本轮实际产物单独报告；具体版本边界见 [Agent 接入状态](docs/desktop/AGENT_INTEGRATION_STATUS.md)。

- 新 Agent 冷启动时明确保留 requiresTask 结构契约；首次聊天、目录资格和删除会话均按任务归属处理，不再受启动时未就绪描述影响。

## 开发工具与附件源码集成（2026-10-30）

- 复用既有Task/Workspace/Broker，新增Git页面、任务分支/Worktree、精确提交和GitHub/GitCode固定API连接；高风险操作先审批。
- Chat新增受控分块附件、原图与模型图、视觉能力门禁、历史/重试及ZIP导入；DeepSeek Flash真实多图输入已验证。
- 仿生聊天修复ready聚合与官方persona前缀；真实QQ收发、当前候选Native/Guest和本分支云端安装包仍需独立验收。Defender RELEASE HOLD保留。
- 功能、限额和边界见 [开发工具与附件](docs/development/DEVELOPER_TOOLS_AND_ATTACHMENTS.md)。源码测试与Chromium验收不等于已安装版本更新或正式发布。

## Desktop 全局界面与原生窗口统一（2026-10-31）

- 沿用 Harbor Token 与组件，整理 Chat 用量/工具调用、Task 协作与结果抽屉、Memory 来源与 Scope、Agent 配置、Plugins/MCP 分页、可搜索设置及设备只读状态。
- Git 与 Task 共享 Unified/Split Diff；文件选择仍是受控提交范围。没有既有授权执行器的暂存操作明确不可用，不新增 Git 权限或 Runtime。
- Windows 使用同色原生标题栏、系统按钮和缩放边框；原生宿主声明后不再重复绘制网页标题栏。Windows Snap、DPI、系统操作与源码/浏览器验收分别记录，不能据静态构建推定全部通过。
- 设计规则见 [Harbor UI conventions](docs/desktop/UI_DESIGN_GUIDE.md)。本地开发和隔离 Debug 验收不更新已安装版本，不解除 Defender RELEASE HOLD。

## Desktop 启动诊断追加（2026-10-31）

- 在现有全局 Harbor UI 和原生 Windows Shell 上加入统一只读启动检查与 PASS / DEGRADED / BLOCKED 门禁。关键数据预检先于领域恢复，损坏原文件不自动覆盖；平台工具派发继续经过既有 Capability Broker 和审批。
- 正常界面、设置/关于和异常启动页复用统一诊断及官方反馈入口。Core 不可用时保留原生本地报告、导出和浏览器反馈；不自动上传诊断资料。
- 默认检查不创建付费模型回合、外部 Agent 会话、QQ 消息、软件安装或 VM。可选能力明确标识 DEGRADED / NOT_RUN，真实执行及正式发布仍按独立环境与安全门槛验收。Defender RELEASE HOLD 不变。

## 核心协议开发规范整合（2026-10-31）

- 新增 [CP 协议索引与实现映射](docs/protocol/README.md)，纳入 CP-000..090、17 类产品分类、组合侧车 ADR 和契约草案，统一保持 PROPOSED。这不是新 wire 版本或运行时能力发布。
- 开发验证入口 `npm run contracts:validate` 与已注册 `test-protocol-proposals` 覆盖 10 份 Schema、26 个原始正反例及图/权限/旧 Manifest 边界。工具只读，不装配子插件、不签发授权、不迁移数据。
- 现有 Agent/Task/Memory/插件、Desktop/Mobile 配对字节与独立发布保持原事实源；启动诊断已实现部分不重复开发。组合安装、通用 Pub/Sub、App/OS Host 与 Memory Backend 仍按协议索引记录待实施；原生 Simulation 的有限实现范围及迁移缺口见下节。Defender RELEASE HOLD 不变。

## Native Simulation 基础与项目协作（2026-11-01）

- 新增原生角色资产库、房间、五类场景和有界发言调度；通过现有 Model Runtime 生成回复，不以 QQ、SnowLuma 或 DSH 为启动前提。Chat 提供普通聊天、仿真聊天和项目协作入口。
- 角色全文、原始字节 Hash、版本、正反/多轮范例、行为偏好和检索来源受控保存；旧文件与社交历史保持原样，私有会话不自动迁移。Memory 复用房间/角色 Scope，模型推断需确认。
- 讨论只创建待授权 Task；隔离 Worktree、真实 Managed 执行、测试请求授权与逐次审批、独立结果核验继续由既有系统负责。模型说完成不能使房间显示交付。
- 实际配置模型已验证单角色多轮、三角色有界讨论和隔离 Git 项目的文件修改/真实测试/Task 核验闭环。原始角色提示投影与新版的同模型自动对照已有证据，完整旧版人格迁移仍待 Owner 人工保真评审。
- 中断请求不重放，未知用量保留预留与不确定标记；显式恢复只开启新轮次，不抹去旧操作。容量、上下文、价格估计及迁移限制见 [Native Simulation](docs/desktop/SIMULATION.md)。本地开发验证不更新已安装版本，不解除 Defender RELEASE HOLD。

## 可选 OneBot 通道与专属集成退役（2026-11-01）

- SnowLuma 专属安装、检测、进程控制、插件卡片、配置与 MCP 注册已从当前产品入口移除。旧插件、服务及工具 ID 明确退役，不自动映射为其他集成；不卸载或终止用户的外部网关、QQ 程序。
- 通用 OneBot v11 WebSocket/HTTP 适配保留，`onebot` 默认关闭且端点为空。Owner 显式配置并允许连接、启用 `cetamesh-onebot` 后，仍需明确发起连接；MCP Server `onebot` 与工具权限单独检查。配置、连接、认证和可发送状态分别报告，插件启用不代表就绪。
- 旧 `config.snowluma` 不作为连接授权。可信 Owner UI 可预览并确认端点迁移，按原始文件字节 Hash 校验并备份原始字节；迁移后保持关闭、令牌为空，不覆盖已有 OneBot 配置。令牌需重新输入，保存和迁移不建立连接。
- 角色卡、当前角色、社交记忆和历史会话数据未在本次退役中迁移或删除。`whale-chat` / `whale-chat-v2` 的四份预设文件仅修订工具命名空间及对应说明；原版备份与 Hash 对照保存在私有开发归档，完整人格迁移仍待 Owner 保真评审。
- 原生 Simulation 继续独立于外部通道及 DSH。CP-080 保持 PROPOSED，当前实现不新增 wire 版本、不授予额外能力；真实网关、当前安装版本与发布安全门禁仍需独立验收，Defender RELEASE HOLD 不变。

## Chat 模型与运行观测界面（2026-11-01）

- Composer 使用紧凑的模型/推理与上下文/用量浮层，复用现有组件；工具和Agent活动只由真实事件生成摘要，详细回执分页展开。
- 请求上下文来自Model Runtime当次有效预算，包含来源、窗口、输出预留与压缩观测；估算与实际、最近请求与累计消耗分别标记，未知数据不填零。配额与重置时间无观测来源时保持未知。
- 每模型能力目录只声明适配器实际支持的推理参数和视觉/工具能力；配置变更继续检查运行中回合、Task/Agent Session恢复记录及已有授权。未知副作用不因清除Chat活动绑定而失去保护。
- 可选模块降级入口位于Harbor正常布局行，避免覆盖Composer；核心异常的BLOCKED启动与运行中冻结门禁保持。
