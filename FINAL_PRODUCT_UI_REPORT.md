# FINAL_PRODUCT_UI_REPORT.md — CetaMesh Desktop UI v1（方案 01/02/04 融合）

> 2026-10-11 · 分支 `feature/product-ui-v1`（基于 main `bdf6cc6`）。
> 本文是 UI v1 重构的交付报告：信息架构、真实接线、安全边界、验证证据。

## 0. 结论（TL;DR）

- Owner 从 5 套探索方案中选定 **02（Chat 主结构）+ 01（导航与信息层级）+ 04（卡片/设置交互）**，
  本轮融合为唯一的 **CetaMesh Desktop UI v1**，全部接真实 Core 功能，**无 Mock**。
- 一级导航从 15 项收敛为 **5+2**：对话 / 工作 / 记忆 + 智能体 / 插件 + 设置 / 关于。
- Chat 成为第一入口：首屏 = 聊天历史 / 消息区 / Composer；工具、Agent、模型全部**渐进披露**。
- 安全红线未动：Capability Broker / Task / Workspace / Agent / Memory / Approval / Extension
  ProcessHost 的调用面与审批流保持原样，UI 只新增了对既有 IPC 契约的消费。

## 1. 信息架构（融合规则 → 落地）

| 融合来源 | 取了什么 | 落地在 |
| --- | --- | --- |
| 方案 01 | 分组侧栏（产品/能力/应用）+ 用户语言导航 + 关于页自然入口 | `show_sidebar`（`native_ui.rs`）、`app_shell.rs` 的 `PRIMARY/SECONDARY/nav_label` |
| 方案 02 | Chat 双栏主结构：历史列 + 消息区 + 底部 Composer；上下文小字 | `show_chat_page` 重写（`egui::Panel` 左列 + 底部 Composer 面板） |
| 方案 04 | 首页能力表达、卡片化状态、设置单页锚点分区 | Chat 空状态四卡、智能体/插件卡片、`show_settings_page` 分区锚点 |
| 主题 | **收敛为唯一的「纸面」主题**（方案 01 的暖纸底 + 鼠尾草点缀 + 哑光卡片），其余九个主题全部移除，历史偏好值自动回落 | `theme/themes.rs` 只剩 `PAPER`；`ui_prefs::ThemePreference` 收敛为 `System/Paper`；设置页主题选择器移除 |

### 1.1 导航映射（旧 → 新）

| 旧（15 项） | 新去向 |
| --- | --- |
| Chat | **对话**（一级，第一入口） |
| Work（Tasks/Workshop） | **工作**（一级；内含 任务 / 提案（Owner 审阅）/ 工作空间 三 tab） |
| Memory | **记忆**（一级） |
| Agents（旧=工程 tab 容器） | **智能体**（一级；改为 `agent.list` 产品目录卡） |
| Plugins（旧=仅扩展包审查） | **插件**（一级；插件/工具/MCP 目录 + 扩展包二级入口） |
| Settings | **设置**（二级；单页分区 + 锚点） |
| About | **关于**（二级；Feedback 四入口在页内） |
| Home（Core 状态/日志/诊断） | 设置 → 高级 → 状态与日志（旧控制台） |
| Social + Roles/ModelsPresets/Pending | 设置 → 高级 → 渠道控制台（审批队列在「审批 / 问题」tab） |
| Connections | 设置 → 高级 → 服务连接 |
| Security | 设置分区「安全通知」直嵌 |
| Devices（Mesh 配对） | 设置 → 高级 → 设备与连接（Mesh 配对独立页） |
| Workspaces | 工作 → 工作空间 tab（独立页变体移除） |
| Feedback | 关于页四入口（浏览器打开官网） |
| Onboarding | 保留（首启自动进入，不在导航） |

## 2. Chat 页（第一优先）

- **首屏三要素**：聊天历史列（今天/更早/已归档分组，`chat.sessions.list` 真实数据 +
  `updatedAt` 毫秒分组）、消息区（`chat.history` 真实回包；用户/CetaMesh 气泡区分、
  usage 透传、错误与停止状态如实显示）、Composer（`well` 输入 + 动作行）。
- **空状态**：大标题「让零散想法，有一个去处。」+ 说明句 + 能力四卡
  （直接回答 / 使用工具 / 创建任务 / 交给 Agent）。首屏无 Provider / Model / Reasoning。
- **渐进披露**（Composer 动作行，均为真实 `chat.config.set`）：
  - `＋ 附件`：拖拽文本文件（既有 `accept_chat_drops` 能力，上限提示不变）；
  - `工具`：弹层显示 `plugins.overview` 真实计数（已启用工具 X/Y · MCP 运行中 A/B）+ 跳转插件页；
  - `Agent`：Auto（Smart 路由）/ 禁用 / 显式 Provider（catalog.agentProviders）；
  - `模式 · 普通/路由`：`chat` / `smart`（CHAT_MODES）；
  - 右下角「当前模型 · …」小字：模型 Provider / 模型 / 目录外模型 ID / 推理力度弹层（原会话配置行收入）。
- **发送/停止/重试/继续**：流式回合沿用 `chat.send/stop/retry/continue` 与 IME 安全 Enter 规则。

## 3. 真实功能接线（任务 B 服务面首次进入 UI）

| 页面 | 数据源（IPC） | 动作（IPC） |
| --- | --- | --- |
| 智能体 | `agent.list`（available/health/version/capabilities/workspaceBoundary/supportsResume） | 卡片「设为对话 Agent」→ `chat.config.set(agentProvider)`；刷新 → `agent.list` |
| 插件·插件 tab | `plugins.list` / `plugins.get`（含 toolCount/enabledToolCount/工具行） | `plugins.enable/disable`、`plugins.tool.toggle`、`plugins.tool.toggleAll` |
| 插件·工具 tab | `tools.list`（53 工具目录：来源/权限/可用） | 带插件来源的工具可直接开关 |
| 插件·MCP tab | `mcp.list` / `mcp.get` / `mcp.tools`（真实发现） | `mcp.enable/disable/start/stop/restart` |
| 插件·扩展包 | 既有 `ext.review/install/update` 流程原样保留（二级入口） | 不变 |
| 设置·设备 | `mesh.*` / `channel.*`（原样嵌入 + 独立页入口） | 配对/信任/撤销等不变 |
| 设置·高级 | 旧控制台各 tab（状态/日志/审批…） | 不变 |
| 关于/反馈 | `about.*` / `update.*` / `product.feedbackLinks`（既有） | 不变 |

**审批边界**：所有 `plugins.*/mcp.*` 管理动作走 Capability Broker。回包 `status=pending`
时 UI **不自动批准**，提示「到 设置 → 高级 → 审批与问题 处理」；审批队列本体不变。

## 4. 安全红线核查（未改变）

| 红线 | 本轮情况 |
| --- | --- |
| Capability Broker | UI 新增动作全部经既有 broker 契约（`integration.plugin.manage` / `integration.mcp.manage`）；pending 不绕过 |
| Task / Workspace | `task.*` / `workspace.*` 调用面未动；Work 页只是重组呈现 |
| Agent | `agent.*` 只读消费 + 复用 `chat.config.set`；未新增会话创建路径 |
| Memory | `memory_ui.rs` 未改，页面挂载不变 |
| Approval | 审批队列 UI 原样（渠道控制台容器内），无自动批准 |
| Extension ProcessHost | `ext.*` 流程原样收进插件页二级 |
| QQ/DSH 非核心依赖 | 未触碰 `src/`；桌面壳不 import SnowLuma SDK 不变 |

## 5. 实现清单

- `desktop-shell/src/app_shell.rs`：PRIMARY/SECONDARY 5+2、`nav_label()` 中文导航名、
  LegacyTab 归属收敛（Roles/ModelsPresets/Pending → 渠道控制台容器）、Workspaces 变体移除（并入 Work tab）。
- `desktop-shell/src/agent_ui.rs`（新增）：`agent.list` 解析 + 四态卡（就绪/需要设置/未安装/暂不可用）。
- `desktop-shell/src/integrations_ui.rs`（新增）：plugins/tools/mcp 目录解析、二级详情、
  管理动作、pending 审批守卫。
- `desktop-shell/src/native_ui.rs`：侧栏分组、路由（Agents 产品页）、快捷键 1–7 新映射、
  Chat 页重写（历史列/气泡/Composer/弹层）、Work 三 tab、设置单页锚点分区 + 高级入口、
  `Area::AgentCatalog/Integrations` + `Operation::AgentList/IntegrationsCall` + 回包分发。
- `desktop-shell/src/theme/qa.rs`：截图计划收敛为 **9 张**（唯一纸面主题 × 每个产品页）。
- **主题收敛（Owner 追加决定：只保留方案 01 纸面样式）**：
  - `theme/themes.rs` 重写：十主题 → 唯一 `PAPER` 配方（暖纸 #f1f0ea 底 + 鼠尾草 #75937b 点缀 + 墨色 #2e3630 文字；哑光阴影、圆角 18/12、单枚极淡草绿光斑）；`spec_for` 对任何偏好（含 system_dark）都返回纸面。
  - `ui_prefs.rs`：`ThemePreference` 只剩 `System/Paper`；旧存档里的 `soda/deep/…` 解析时一律回落 `Paper`（`parse` 兼容 + `resolve` 兜底），其它偏好项不受影响。
  - `native_ui.rs`：主题选择器（含 `theme_choice` 卡片）整体移除，外观分区改为静态「主题：纸面 · 浅色」；品牌 "C" 字标从蓝丝带改为鼠尾草渐变；相关测试全部重写（对比度门禁、样式断言、过渡引擎无操作断言）。
  - `theme/mod.rs` 过渡引擎保留（页面浮升/涟漪/首次应用仍用），跨主题插值测试改为"唯一主题下重放是无操作"。
  - accent 相比探索稿加深一档（#7d9b82 → #75937b）以满足白字 3:1（AA Large）；正文辅助色 text_2/text_3 按壳内 ≥4.5:1 标准加深。
- **Bug 修正与打磨（Owner 截图反馈后）**：
  - **蓝色「Chat」胶囊的根因**：那不是新 UI 画出来的——新代码里导航激活项用 `paint_button(Primary)`，颜色全部来自当前主题（纸面=鼠尾草渐变），标签也全是中文 `nav_label()`；英文 "Chat" + 蓝渐变只能由 **UI v1 之前的旧构建**（旧安装版/主检出目录的旧 exe，Soda 主题 + 英文标签）画出。反馈当时机器上正运行着一个旧实例（WhaleBridge.exe pid 25276）。**处置：新构建无法复现，无需改码；运行新 exe 即可（注意先退出旧实例）。**
  - 修真 bug：Composer「模式」chip 在无活动会话时因 `config.mode` 为空串显示成「模式 ·」——`chat_mode_label("")` 现按 Core 缺省显示「普通」。
  - 打磨：accent_2 渐变端点加深到中鼠尾草 `#8fae94`（胶囊文字全程 ≥3:1）；Composer 输入井提亮（white 0.72 → 0.78）。
  - 复验：`WHALEBRIDGE_INSTANCE_SUFFIX=qa2` 隔离实例重截 9/9 张（不干扰正在运行的旧实例），「模式 · 普通」/ 鼠尾草胶囊 / 纸面卡全部确认。
- 测试同步：`app_shell` 导航断言、快捷键槽位、QA 计划数、`scripts/test-owner-agent-mode.mjs`
  导航契约（12 个用户语言标签 + 对话必须是第一主导航）；新增 `agent_ui`（3）/`integrations_ui`（4）单测。

## 6. 验证（本机实测）

| 命令 | 结果 |
| --- | --- |
| `cargo check`（desktop-shell） | **0 error**；剩余 11 条 warning 全部为 main 既有（task_ui/workshop_ui/mesh_ui/theme/tray 的 dead_code） |
| `cargo test` | **150 passed / 17 failed**；17 个失败全部为 `create temp dir: PermissionDenied (os code 5)` 的会话 TEMP/HKCU 环境限制（installer/migrate/ui_prefs/install_cli/desktop_paths；其中 2 个是本轮新增的纸面偏好落盘测试，同类环境限制，正常环境/CI 会通过） |
| 改动模块定向测试 | `app_shell`(4) `agent_ui`(3) `integrations_ui`(4) `theme`(全部，含纸面对比度门禁) **全绿** |
| `npm test` | 三轮见 §6.1；最终除环境限制套件外全 PASS |
| `npm run desktop:build` | release **成功**（`Finished release profile [optimized] … 57.55s`，11 条既有 dead_code warning）；debug 构建成功（供 QA 截图） |

### 6.1 npm test 三轮明细

| 轮次 | 结果 | FAIL 明细与处置 |
| --- | --- | --- |
| 第 1 轮 | PASS 76 · FAIL 2 · NOT_RUN 9 | `test-owner-agent-mode`（旧导航断言，已按 UI v1 契约更新，单跑 PASS）+ `desktop/cargo:test`（TEMP 限制） |
| 第 2 轮 | PASS 77 · FAIL 3 · NOT_RUN 7 | 上条已修复并转 PASS；新增 `test-desktop-install`/`test-desktop-shell` FAIL——`desktop:build --release` 清掉了 `dist/core` 产物所致 |
| 修复后 | `npm run build:core` 后 `test:desktop`：`test-desktop-install` **PASS**、`cargo:check` **PASS** | `test-desktop-shell` 与 `cargo:test` 保持同签名失败（见下） |

`test-desktop-shell` / `cargo:test` 的失败签名统一为**会话沙箱限制**：
`创建日志目录失败 …\Temp\whalebridge-desktop-test-*…：拒绝访问。 (os error 5)` 与
`create temp dir: PermissionDenied (os code 5)`（16 个 cargo 失败全部同类，集中在
installer/migrate/ui_prefs/install_cli/desktop_paths）。**同一份壳代码在第 1 轮全量中
`test-desktop-shell` 是 PASS 的**，两轮之间壳代码零改动（仅改了一个测试脚本与文档），
故为本会话对 TEMP 目录创建的沙箱限制，与 PROJECT_STATE 既有记录（"cargo:test 的本会话
TEMP 限制"、"HKCU 注册表限制"）同类，不是代码回归。按仓库 NOT_RUN_ENVIRONMENT 精神如实记录。

### 6.2 安装包（Owner 索取）

- `npm run desktop:build`（release）+ `npm run build:release`：**成功**，产出 RC 目录 `dist/app/`（140.7 MB）：
  - `WhaleBridge-Setup-x64.exe`（40.5 MB，一键安装器）+ `WhaleBridge.exe`（6.4 MB，安装/卸载同体）；
  - `payload/`（Node SEA 的 `WhaleBridgeCore.exe` 93.2 MB + resources）+ `INSTALL.txt`；
  - `build-info.json` = **1.0.0-rc.2+ca3be2a（dirty=false，包含全部 UI v1 / 纸面主题 / bug 修复提交）**；
  - `SHA256SUMS.txt`（27 条，逐条复验**全部一致**）、`release-manifest.json`、`sbom.json`、第三方许可清单；
  - 发行审计（禁止项 / 构建机路径 / 凭据泄漏）**通过**；`WhaleBridge.exe` 二进制内含「纸面工作台」UI 标记（已验证）。
- **沙箱内安装验证受限**：`test-release-candidate` 与手动 `--install --install-dir <可写目录>`
  都被本会话沙箱拦在 TEMP 目录创建 / HKCU 注册表 / 开始菜单（`os error 5`，§6.1 同类已知限制；
  文件复制阶段本身正常，失败后自动回滚并保留备份）。包完整性已按 SHA256SUMS 逐条验证；真机安装请在
  Owner 桌面会话直接运行安装器（默认装到 `%ProgramFiles%\WhaleBridge`，覆盖安装前建议退出旧实例，
  需要时用 `--stop-core`）。

### 6.3 补充 bug 修复（Owner 截图二：胶囊右上角白弧）

- **根因**：`paint_button` 的顶部高光边（rim）是一圈圆角描边被裁剪到按钮上半部——圆角处必然露出一截
  白色弧线。这是糖玻璃（GUMMY）主题的高光语言，但 Primary 按钮的白色 rim 没有跟随阴影档位，哑光
  主题（纸面）也在画；浅色纸底上这截弧线被 Owner 截图抓个正着（两张截图——蓝色旧版与绿色纸面——
  右上角的同款白弧，同一个根源）。
- **修复**：rim 按 `spec.shadow.card_rim` 门控——哑光主题（`card_rim=false`）整条跳过；若未来恢复
  糖玻璃主题，rim 自动回来。复验截图（`output/uiv1-qa3/` 9/9）胶囊已是干净鼠尾草渐变，无白弧；
  发送按钮同步生效。
- 安装包重出：**1.0.0-rc.2+ca3be2a（dirty=false）**，SHA256SUMS 27 条复验一致。

### 6.4 补充 bug 修复（Owner 视频一：悬停的"白色贴纸圈"）

- **根因**：`page_button` 悬停分支同样带糖玻璃语言——浮起 + 软阴影 + `edge_hi` 描边。
  纸面主题的 `edge_hi` 是 85% 白，悬停「工作/记忆」时画出一个白底白圈的胶囊（视频 0–4s）。
- **修复**（`0ff0632`）：悬停语言按 `spec.shadow.card_rim` 门控——糖玻璃保留原样；哑光主题
  （纸面）只画纸色加深一档的软填充（`tokens.hover`），**无阴影、无描边**，对齐方案 01 的安静悬停。
- 安装包同步重出：**1.0.0-rc.2+0ff0632（dirty=false）**，SHA256SUMS 27 条复验一致，发行审计通过。

## 7. 视觉验收

debug 壳 `--screenshot-dir output/uiv1-qa` 生成 **9/9 张**（1280×800；唯一的纸面主题 × 每个产品页：01-home / 02-settings / 03-about / 04-feedback / 05-onboarding / 06-work / 07-memory / 08-agents / 09-plugins）。已逐张人工核验：

- **纸面主题整体**：暖纸底（#f1f0ea）+ 极淡草绿光斑、纸片卡 + 柔描边、哑光投影、鼠尾草激活态（侧栏胶囊/发送按钮/品牌 "C" 字标），与方案 01 探索稿气质一致。
- 侧栏：产品 / 能力 / 应用 三组、中文标签、纸面着色的激活态。
- 对话首页：历史列（＋新对话 / 加载态）、空状态大标题 + 能力四卡、Composer 动作行（＋附件 / 工具 / Agent / 模式）+ 右下角当前模型。
- 设置：外观分区显示静态「主题：纸面 · 浅色」+ 缩放/关闭行为/动效控件；五分区锚点正常。
- 工作 / 智能体 / 插件 / 记忆 / 关于：目录加载态与 Core 不可用横幅如实呈现（QA 环境无 worker 属预期真实状态）。

## 8. 已知边界 / 后续

- 智能体页 v1 为只读目录 + 「设为对话 Agent」；`agent.createSession` 的 Task 绑定流程
  仍走任务页（未在卡片上开新入口），避免绕过 Task/Workspace 边界。
- `tools.invoke` / `mcp.invoke` 未在 UI 暴露（目录与开关已接）；工具执行统一仍由
  对话/Agent 通道发起，避免 UI 直调工具绕过对话上下文。
- 旧控制台（Home/Social/Connections/Security 容器）功能原样保留，仅从一级导航撤出。
- 交付流程：本分支未合并 main（等 Owner 确认）；未 push。
