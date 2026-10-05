# CetaMesh Desktop — PROJECT_STATE

## UX 收尾 — 2026-10-05（切模型 / 工作区选择器 / Provider API Key）

- **模型与思考强度切换**：Chat 页现在渲染 `Area::Chat` 的错误反馈（`MODEL_BIND_FAILED`、参数错误不再“无反应”）；新增“自定义模型”输入 + 应用按钮，DSH 模型目录不可用时也能切换；保存成功后刷新会话列表使下拉立即反映新配置。
- **工作区添加**：表单新增“浏览…”原生目录选择器（`rfd` 0.15.4，本地缓存离线编译）；选中目录自动填入根目录，名称留空时自动取目录名，不再需要手动复制路径。
- **Provider API Key**：新增 `src/providers/secrets.js` —— `state/provider-keys.json`（0600、原子替换、损坏 fail-closed、界面只返回掩码 hint），支持可选 https `baseUrl`；IPC 家族 `providers.secrets.list/set/delete/test`；设置 → 模型与 Preset 新增管理区（保存 / 删除 / 测试）。测试用 Key 访问该 Provider 的 `/models`，只返回状态与固定文案，绝不回显 Key。
- 边界：Key 目前用于本地保存与连通性测试；若 DSH 支持按 provider 注入 Key，再接入真实模型调用。目录选择器为阻塞式原生对话框。
- 验证：`test-provider-secrets` 6/6、`test-control-service`、`test-core-entry`、`test-privilege` 24/24、`test-system` 108/108、`test-architecture` 8 组、chat-product 11 组、`cargo test` 86/86 全部 PASS。

### 产物（commit `ca0eefa`）

- `dist/app-1.0.0-rc.1-final`（buildId `1.0.0-rc.1+ca0eefa`，dirty=false）；
  单文件安装包 `dist/CetaMesh-Setup-1.0.0-rc.1.exe`，41,938,944 字节，
  SHA256 `3A165B5AE22B748BE002B5856B169D9CB0BB2F43FE5A58A91E02A13D10296B23`；
  WhaleBridge.exe `C7B901A2473EA0EF1473ADF5FA3B29344966C7E3659382842767338EF2E40A0A`；
  WhaleBridgeCore.exe `40C6037A3F4D564518ABA2D2629129FF9E0B5469F8182CB875E73B6CB8E80377`。
- 本机安装已升级到 `ca0eefa` 并启动（用户数据保留）；RC 回归（凭据/Core/安装包/GUI/发布候选/Rust）全部 PASS。

## 模式重构 — 2026-10-05（social / workshop，已获用户批准）

| 模式 | 最终形态 |
| --- | --- |
| `chat` | 不变 |
| `closed-agent` | 不变（owner 私聊 + 完整工具） |
| `social` | 由 `reserved2` 改名，行为不变；`reserved2` 为旧别名自动迁移 |
| `workshop` | 新增独立模式：以 closed-agent 为基（owner 私聊 + 完整工具），不启用 social 回合/睡眠/发言工具 |
| `reserved` | 弃用：不再出现在 UI/选择中；旧值自动迁移为 `chat` |

### 已实现

- `src/bridge.js`：`VALID_MODES = chat / closed-agent / social / workshop`；`MODE_MIGRATIONS`（reserved→chat、reserved2→social）接入 `refreshMode`（本地 mode.json 与 DSH settings 两路）、持久化策略读取、`/api/mode` 校验；`workshop` 与 closed-agent 同为 owner 私聊权限；`modePreset` 支持 `workshopPreset`（默认 `router-standard`，即 closed-agent 同款完整工具面）；preset 绑定新增 `workshop` 槽；社交 V2 门禁与日志文案全部由 reserved2 改为 social。
- `src/control/control-service.js`：`CONTROL_MODES`、`PRESET_BINDING_TARGETS`、`migrateLegacyMode`，policy.update / normalize 对旧值内存迁移。
- `desktop-shell/src/native_ui.rs`：运行策略下拉与校验改为 4 个新模式；Preset 目标新增 Workshop（标签“工作坊”）；绑定读写覆盖 social/workshop。
- 旧别名兼容：`reserved2` / `reserved` 在 bridge 与 ControlService 读取时自动迁移，写盘使用新值；遗留数据夹具（migrate.rs / dsh-integration / desktop-install）保留以验证兼容。

### 验证（本机）

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `node scripts/test-control-service.mjs` | PASS | 含 reserved→chat、reserved2→social 迁移断言与 workshop 绑定 |
| `npm run test-core-entry` / `test-dsh-integration` | PASS | worker/MCP/DSH 集成 |
| `cargo test` | PASS | 86/86（含 UI 模式列表与绑定测试） |
| `npm run test-architecture` | PASS | 8 组红线（产品运行时不得出现 reserved 字样） |
| `test-card` / `test-forward` / MCP 套件 | PASS | 兼容 live 旧 bridge 与原生 403 文案 |

### 未完成 / 边界

- 一代 reserved 仿真引擎代码仍保留但不可达（旧值已在内存迁移为 chat）；物理删除列为后续清理，避免本阶段大重构。
- DSH settings 命名空间中的旧值需要一次显式模式写入才会改写；运行时读取已按新模式工作。
- workshop 默认沿用 DSH 内置 `router-standard`（与 closed-agent 同完整工具面）；专用 `cetamesh-workshop` preset 包待明确要挂载的工具清单后再内置。

### 产物与本机验证（commit `9f394ae`）

- 交付：`dist/app-1.0.0-rc.1-final`（buildId `1.0.0-rc.1+9f394ae`，dirty=false）；
  单文件安装包 `dist/CetaMesh-Setup-1.0.0-rc.1.exe`，41,934,848 字节，
  SHA256 `8776A13EC6951CE195DA7BF734A1CA674A6F588DB9F7C0F73693E053F4F7EE46`；
  WhaleBridgeCore.exe `5579C33B3F315B48DEF3CF7B7BB1665743E2B5E8CFBA0D634B87D8BB49DE35C8`。
- 本机安装已升级到 `9f394ae`（--stop-core，用户数据保留）并启动；`/api/status` 返回
  `mode=social`，证明旧 `state/mode.json` 的 `reserved2` 已在运行时迁移。
- 回归：架构 8 组、ControlService 迁移断言、core-entry、dsh-integration、desktop-shell（GUI）、
  installer-package、release-candidate、cargo 86/86 全部 PASS。

## 补丁 — 2026-10-05 窗口排版与安装体验修复（commit `dc45fb1`）

用户反馈：主窗口排版被裁切/遮挡；安装包被 Windows Defender 报 `Trojan:Win32/Bearfoos.A!ml`。

### 修复内容

- **排版**：`NativeUi::ui()` 从嵌套 `horizontal_top + vertical + ScrollArea` 改为真正的
  `egui::Panel::left` / `Panel::top` / `CentralPanel` 布局；侧栏按钮按可用宽度渲染，窄于 1040px
  时切换为顶部紧凑导航，标题/描述/Core 状态在窄屏自动分行。实拍 1194×818 与 965×678 两种窗口
  均无裁切（截图存于 `output/layout-default.png`、`output/layout-small.png`）。
- **测试实例隔离**：新增 `WHALEBRIDGE_INSTANCE_SUFFIX`（仅测试设置），单实例互斥量与“再次启动恢复”
  事件按后缀命名；`test-desktop-shell` 与 `test-release-candidate` 使用独立命名空间，用户的应用
  运行中也能完成 GUI/安装验收。
- **可执行文件元数据**：`desktop-shell/whalebridge.rc` 增加 VERSIONINFO（ProductName
  `CetaMesh Desktop`、ProductVersion `1.0.0-rc.1`、CompanyName `CetaMesh`、OriginalFilename 等）；
  架构测试新增第 8 组断言，防止元数据或版本同步回退。
- **安装版本显示**：此前 `install-manifest.json` 的 `version` 为 `0.0.0`（旧安装显示
  `0.0.0 → 0.0.0`）。本次升级后新清单写入 `1.0.0-rc.1`，向导显示 `0.0.0 → 1.0.0-rc.1`；注册表
  `InstallLocation` 也修正回用户目录 `%LOCALAPPDATA%\Programs\WhaleBridge`，后续升级不再回退到
  Program Files。

### 验证（本机真实运行）

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `cargo test` | PASS | 86/86 |
| `npm run test-architecture` | PASS | 8 组（含新的产品元数据断言） |
| `npm run test-desktop-shell` | PASS | 用户应用运行中完成 GUI + Stage 13 + 孤儿守卫 |
| `npm run test-release-candidate` | PASS | 沙箱安装/启动/崩溃恢复/单实例/卸载（带实例后缀） |
| `npm run test-desktop-install` / `test-installer-package` | PASS | 全生命周期与单文件安装器守卫 |
| 排版实拍 | PASS | 默认/小窗口截图无裁切、无遮挡 |
| Defender 定向扫描（新 `WhaleBridge.exe`，禁用自动处置） | PASS | `found no threats`；最近告警记录均为 12:39–12:42 的旧构建 |

### 交付与安装状态

- 产物：`dist/app-1.0.0-rc.1-final`（buildId `1.0.0-rc.1+dc45fb1`，dirty=false）；
  单文件安装包 `dist/CetaMesh-Setup-1.0.0-rc.1.exe`，41,934,848 字节，
  SHA256 `5E13F004C5A11E93A2872DC8D546212CEA12C965BCB02FD84FFBBBC6CE536113`；
  WhaleBridge.exe `C81F4CC60F12FD416339C24EAA636299F688D4E84D0251B4E0DA8DB8AB47833F`；
  WhaleBridgeCore.exe `4A65DD8BAFA51A8DD536E0BE4A50B3B901D23ED3B61805EDDF596C85E802C7DA`。
- 本机安装已用 `--install --install-dir %LOCALAPPDATA%\Programs\WhaleBridge --stop-core` 升级到
  `dc45fb1`：用户数据保留（`config.json` 哈希不变），应用已重新启动。

### 仍未完成

- 代码签名与微软误报正式复审（当前新增元数据后本地 Defender 扫描干净，但未签名仍是长期风险）；
  DSH 重启后才会应用新的 MCP 配置。

## Current authoritative snapshot — 2026-10-05（阶段 15：CetaMesh Desktop v1 Final Audit）

### 结论：Desktop v1 = RELEASE CANDIDATE（不是 COMPLETE）

18 个模块与 8 条架构红线全部逐项核对，并补齐了一个真实缺口（见下）；但仍有未验证项（干净 VM 整体验收、已安装 UI 人工走查、真实 QQ 全模式、跨设备 Mesh 真链路、代码签名），按阶段 15 判定规则必须写 **RELEASE CANDIDATE**。

| 项 | 值 |
| --- | --- |
| Branch | `main` |
| 源码提交（产物 build-info 指向） | `d66effe5e6609d38f04b9fc513b5d29c8985b13c` (`d66effe`，release commit) |
| 本记录提交 | 紧随 `d66effe` 的 docs 提交 |
| Version / Build ID | `1.0.0-rc.1` / `1.0.0-rc.1+d66effe`（`dirty=false`，2026-10-05T05:13:58Z） |
| Installer | `dist/app-1.0.0-rc.1-final/WhaleBridge-Setup-x64.exe`，41,930,752 字节 |
| Installer SHA256 | `4EC60C2AAA97EFFD8415ED413B8982A8C18E3C53E3DDA1BEFEFCE394AAE667C9` |
| WhaleBridge.exe SHA256 | `F107686EEDB2D0D15EE9A1C3BCF27586B48294DC76307A5058E1AAF6383BA7B5` |
| WhaleBridgeCore.exe SHA256 | `4A65DD8BAFA51A8DD536E0BE4A50B3B901D23ED3B61805EDDF596C85E802C7DA` |
| 产物目录 | 26 文件 / 138.2 MB（`dist/` 为 gitignored 交付目录） |

### 终审发现并修复的真实缺口

- `src/control/ipc-protocol.js` + `src/bridge.js` 的 **chat.* / continuity.* IPC 方法族接线此前只存在于未提交工作区**。在提交树 `6716e55` 上运行 `test-ipc-protocol` 得到 `continuity.evaluate → METHOD_NOT_FOUND`，等于“文档声称 Chat/Continuity 存在，但提交代码未接线”。
- 处理：对工作区接线做全量回归（IPC / Chat / Continuity / Core entry / privilege / DSH integration / system 全部 PASS）后纳入 release 提交 `d66effe`，并在新提交上重建 RC、复跑关键套件（全部 PASS）。新增 `npm run test-architecture` 防止 UI/Runtime/Provider 红线回退。

### 清理（确认无引用后删除）

- 删除 Tauri/WebView 时代死代码：`desktop-shell/src/main.rs`、`tauri.conf.json`、`ui/index.html`、`ui/installer.html`、`ui/status.html`、`ui/whalebridge-icon.png`；图标流水线不再生成废弃 PNG，图标测试改为校验当前原生发行面。
- 删除未使用的 `NativeUi::show_product_placeholder`（编译警告 7 → 6）。
- 修正 7 个只能在开发者本机通过的过时/环境依赖测试：root config.json 回退 config.example.json（wait/vision/forward/stickers）、默认值来源改为 `src/config`（card）、文案断言对齐现提示词（slang）、自动创建 `output/`（chat product）。
- 新增文档：`docs/desktop/ARCHITECTURE.md`、`BUILD_AND_RELEASE.md`、`KNOWN_LIMITATIONS.md`；`DESKTOP_V1_PLAN.md` 标记为历史文档；README 与 `desktop-shell/README.md` 更新为当前产品状态。

### 模块终审（18/18）

| 模块 | 状态 | 关键证据 |
| --- | --- | --- |
| Chat | PASS | `src/desktop/chat-service.js` + IPC 接线；chat-product 11 组、test-ipc-protocol、RC payload DSH 回合 |
| Tasks | PASS | `src/task/`；test-task 90/90 |
| Memory | PASS | `src/memory/`；test-memory 85/85 |
| Workspace | PASS | `src/workspace/boundary.js`；test-workspace 47/47 + workspace-ipc |
| Model Provider | PASS | 模型目录/默认值 + 凭据保持；test-agent 真机段、test-system |
| Agent Provider | PASS | `src/agent/` 契约 + DSH 映射；test-agent 23 + 真机 PASS |
| Persistent Task | PASS | rev / attention / agent attach；test-task |
| Agent execution | PASS | 真实 DSH 回合 completed（“收到”），RC payload self-test |
| Approval | PASS | pending / 审批 / 风险卡；test-system + test-task + test-mesh |
| Capability | PASS | 能力声明 + 权限/沙箱边界；test-extension + test-agent |
| Context Rollover | PASS | continuity monitor/rollover；test-continuity-rollover 6 组 |
| Agent Handoff | PASS | handoff packet / sequence；test-continuity-rollover |
| Extension | PASS | 静态扫描 + vm 沙箱 + review；test-extension 87/87 |
| Device Mesh | PASS（本机） | test-mesh；跨设备真链路 `PENDING_NATIVE_VERIFICATION` |
| Settings | PASS | test-system 108/108（持久化 / 锁定项 / 归位） |
| Updates | PASS（fail-closed） | 签名必验 + 版本比较（含预发布修复）；test-system |
| Diagnostics | PASS | 活动/日志/诊断 + 强制脱敏；test-system |
| Installer | PASS | 安装/升级/修复/迁移/卸载/重装全生命周期；外部 Workspace 安全 |

### 架构红线（`npm run test-architecture` 7 组 PASS + 人工核对）

| 红线 | 结论 |
| --- | --- |
| UI 绕过 Runtime | 未发现：UI 仅走 IPC；唯一直接文件读取是用户拖入的有界文本附件，唯一进程启动是 Explorer 打开日志目录 |
| Agent 任意访问磁盘 | 未发现：workspace boundary 词法 + realpath 收敛，禁止盘根/系统目录 |
| Trust 自动变 Permission | 未发现：能力必须声明权限并获得显式批准 |
| Task 依附 Agent Session | 未发现：`currentAgent` 可空且 task id 不变 |
| QQ 成为 Core 必需依赖 | 未发现：产品运行时零 SnowLuma 引用，仅 Channel Adapter 注册表 |
| Secret 进入日志 | 未发现：强制脱敏 + bearer token 回归 |
| Extension 任意执行下载代码 | 未发现：静态扫描 + `vm.createContext`，无 host `require`/`process`/fs/net |
| reserved 残留正式产品流程 | 未发现：仅 QQ Adapter 的 Advanced 工程面保留 |

### 最终测试矩阵（本机真实运行）

- Node 产品/架构：architecture 7 组、system 108/108、config 69/69、agent 23+真机、memory 85/85、task 90/90、workspace 47/47、extension 87/87、mesh（跨设备 `PENDING_NATIVE_VERIFICATION`）、chat-product 11 组、continuity 6 组、ipc-protocol、control-service、workspace-ipc、local-services 36/36、app-paths、md/wait/vision/forward/card/slang/stickers、no-web、mcp-safe/host/web-search 全部 PASS。
- Core/桥接：core-entry（五 MCP + worker + 损坏配置 fail-closed）、privilege 24/24、dsh-integration 全生命周期 PASS；core-dist 功能段全部 PASS（全局无残留断言因用户实例运行 `NOT_RUN_ENVIRONMENT`）。
- 桌面/发行：desktop-supervisor PASS、desktop-install 全生命周期 PASS、installer-package PASS、release 构建审计 PASS、RC payload self-test PASS；desktop-shell 非 GUI 段 PASS（GUI 单实例被用户实例占用 `NOT_RUN_ENVIRONMENT`）。
- Rust：`desktop:check` PASS；`desktop:test` 86/86 PASS。
- TypeScript / lint：`NOT_APPLICABLE`（仓库无 TypeScript 源码与 lint 工具链）。

### NOT_RUN_ENVIRONMENT

- 干净 Windows VM / 新镜像整体验收：本机非全新镜像。
- 已安装 UI 人工走查、托盘鼠标交互、GUI 单实例用例、release-candidate 安装后启动：本机已安装的 CetaMesh 正在运行并持有单实例互斥量（PID 28884 + Core 34520），未关闭用户应用。
- 真实 QQ（SnowLuma）全模式工具链路与 live 探针（test-console / test-onebot-connection / test-mcp-exec）。
- 跨设备 Device Mesh 真链路；代码签名 / 安装包签名。

### 已知问题

- 未签名；Update 检查默认关闭（未配置签名公钥，fail-closed）；Node.js 许可证文本待补；`WhaleBridge.exe` 含构建机仓库路径（known deviation）；Provider secrets 以本地 JSON 存储而非系统密钥链。
- 6 个既有 dead-code/未用字段编译警告保留（属于解析数据保真，不做无意义删除）。

### 是否满足 Desktop v1 发布条件

- 作为 **Release Candidate：满足** —— 可安装、可升级、可卸载，用户数据/Workspace/密钥边界与 Core/UI 运行时均通过自动化验收。
- 作为 **COMPLETE v1.0.0：不满足** —— 需先完成干净 VM 人工走查、真实 QQ 全模式、跨设备 Mesh 验证与代码签名。

---

## （历史）2026-10-05 快照 — 阶段 14：Windows Release / Desktop v1 RC

本快照取代下方阶段 13 快照。本阶段产出可安装的 **CetaMesh Desktop v1 Release Candidate**。

### Release artifact（真实产物）

| 项 | 值 |
| --- | --- |
| Version | `1.0.0-rc.1` |
| Commit SHA | `35261e9e4a575fe1386d63438b3dce513ddbd2a5` (`35261e9`) |
| Build ID | `1.0.0-rc.1+35261e9`（干净树，`dirty=false`） |
| Built At | `2026-10-05T04:33:02.819Z`（北京时间 12:33） |
| Installer | `dist/app-1.0.0-rc.1/WhaleBridge-Setup-x64.exe`，41,914,368 字节（40.0 MB） |
| Installer SHA256 | `82EB7C41C4164D051794EDC8E2B1CF91A574BEA210C5724507B08FC19C008343` |
| WhaleBridge.exe SHA256 | `0249304a8b460577dd2bacd381e18f59bb880acf2b8d132e580fe589e19f251f` |
| WhaleBridgeCore.exe SHA256 | `fbbac7d34ccdb09d5ab50e87cab45ea2a1fe692a154510de39b36ea0cedf1669` |
| RC 目录 | `D:\GIT-QQ-BRIDGE\dist\app-1.0.0-rc.1`（26 个文件，138.1 MB；`dist/` 为 gitignored 交付目录） |

构建方式：在 `%TEMP%` 以 commit `35261e9` 创建干净 worktree（排除并行会话的未提交文件），junction 复用 node_modules，依次执行 `build:core` / `desktop:build` / `desktop:build:debug` / `build:release`；产物 `build-info.json` 记录 `dirty=false`；构建后临时 worktree 已删除。

### 安装器与分发内容

- 单文件安装器 `WhaleBridge-Setup-x64.exe`（Windows 自带 IExpress，含 C4 图标；构建中间文件不进入发布目录）。
- 安装后：`%LOCALAPPDATA%\Programs\WhaleBridge\WhaleBridge.exe`（桌面壳/卸载器）、`WhaleBridgeCore.exe`（Node SEA）、`resources\`（只读资源）、`build-info.json`、`install-manifest.json`；开始菜单与桌面快捷方式 + HKCU 卸载项；用户数据目录 `%LOCALAPPDATA%\WhaleBridge`（config.json + state）。
- 运行不依赖开发目录 / `npm start` / 源码路径 / 开发终端 / 手动启动 Core：发行验收在 PATH 无 `node.exe` 的隔离环境完成，由桌面壳自动拉起 Core。
- 命令行（高级）：`--install` / `--repair` / `--uninstall` / `--migrate`；只有 `--remove-data` 才会删除数据目录。
- 卸载语义：默认只删程序文件、快捷方式与注册表项，完整保留用户数据；`--remove-data` 为显式危险操作；`--remove-dsh-integration` 另行显式。

### 升级保留（真实断言）

沙箱中“先装 v1 → 写入用户数据 → 用 v2 payload 覆盖安装”后，字节级断言保留：

- `config.json`、`settings.json`（Provider secrets 哨兵）、`state/task-store.json`（Tasks）、`state/memory-store.json`（Memory）、`state/workspace-metadata.json`（Workspace metadata）、`state/continuity/handoff.json`。
- 程序文件与 `resources` 正常升级；`install-manifest.json` 哈希刷新；修复 / 迁移 / 重装 / 卸载 / 彻底卸载全部通过。
- JSON 数据存储无 SQL 数据库；“数据库 migration”在本项目等价于配置/设置/状态的兼容迁移：统一配置服务旧别名迁移与 `--migrate` 旧数据迁移均有测试覆盖。

### 已执行验收（真实 Windows 本机）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| install | PASS | RC 沙箱安装（中文+空格路径）；安装器全生命周期测试 |
| launch | PASS | 已安装 `WhaleBridge.exe` 拉起 release Core；子进程无 `node.exe`；安装目录运行期只读 |
| Chat / Agent | PASS | 安装包 `payload\WhaleBridgeCore.exe --self-test`：真实 DSH 回合 completed，回复“收到”（PATH 无 node） |
| restart | PASS | worker 强杀后 5.8s 退避自动拉起；单实例；壳强杀孤儿守卫 |
| upgrade | PASS | 见“升级保留” |
| uninstall | PASS | 默认保留数据；`--remove-data` 只删数据目录；数据目录之外的用户 Workspace 原样保留 |
| Memory / Task / Mesh / Extension | PASS（源码提交） | `test-memory` 85/85、`test-task` 90/90、`test-mesh`（跨设备真链路 `PENDING_NATIVE_VERIFICATION`）、`test-extension` 87/87 |
| 安装包 / 发布候选 | PASS | `test-installer-package`、`test-release-candidate` 全绿 |
| `cargo test` | PASS | 86/86 |
| `npm run test-system` | PASS | 108/108（含预发布版本比较修复） |

### NOT_RUN_ENVIRONMENT / 未验证

- **干净 Windows 全新环境（VM/新镜像）整体验收：NOT_RUN_ENVIRONMENT**。本机不是全新镜像；本轮为真实 Windows 上的隔离沙箱安装/升级/卸载与真实进程验收。
- 已安装 UI 的 Chat / Memory / Workspace / Task 手工交互走查：**NOT_RUN_ENVIRONMENT**（无 UI 自动化；Computer Use 不可用）。安装级验证的是 Core 启动、API、数据保留与元数据安全。
- 真实 QQ 全模式 MCP 工具链路（SnowLuma）与 DSH 重启恢复：**NOT_RUN_ENVIRONMENT**（未改动外部服务）。
- 代码签名 / 安装包签名：未执行（无证书）；未签名安装器会触发 Windows 来源提示。
- 第三方许可证文本：Node.js 运行时许可证文本需在公开发布前补齐（`licenses/README.md` 已列明）。

### 已知问题（发布前）

- 未签名（安装器与两个 exe），SmartScreen 警告预期。
- Update 检查默认关闭（未配置签名公钥，fail-closed）；RC 不含自动更新。
- `WhaleBridge.exe` 内含构建机仓库路径，审计记录为 known deviation（不含凭据/用户数据）。
- 构建源码为 commit `35261e9`；本文件记录产物的提交在其后（docs commit），产物 `build-info.json` 记录的是 `35261e9`。

### 下一阶段入口

人工在干净 VM 完成 UI 走查 + 真实 QQ 全模式验收；补齐 Node LICENSE 与代码签名后转正式 `v1.0.0`。

---

## （历史）2026-10-05 快照 — 阶段 13：Desktop UX / Windows 完整性

本快照取代下方 2026-10-04 D1 快照。本阶段把原生桌面壳从“功能齐全”推进到“可长期使用”：系统托盘、关闭语义、窗口/主题/缩放偏好、快捷键与中文输入安全、崩溃重启安全，并完成一次真实 Windows 冒烟。

### 本机验收环境（真实记录，不推断）

| 项 | 值 |
| --- | --- |
| OS | Windows 11 23H2，build 22631.6199（`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的 ProductName 仍为 Windows 10 Pro，属系统遗留值） |
| DPI / 缩放 | AppliedDPI=120（125%） |
| IME | `0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}`（微软拼音）+ `0409:00000409`（美式键盘） |
| 构建 | `npm run desktop:build:debug` → `desktop-shell/target/debug/whalebridge-desktop.exe`（35,481,600 字节，SHA256 `9E94DD98A85F922C6E92BE757F77D5CCCC5A557CC12CBD2E7388EE293B98309F`） |
| 运行数据 | 冒烟全部使用唯一临时目录；未触碰用户 config.json / DSH / SnowLuma |

### 阶段 13 落盘内容

- **系统托盘**（`desktop-shell/src/tray.rs`，tray-icon 0.23.1，本地缓存离线解析）：菜单含 显示主窗口 / 隐藏到托盘 / Core 状态（实时）/ 需要处理（任务与审批计数，有需要时变为可点击）/ 重启 Core / 打开日志目录 / 退出 CetaMesh（停止 Core 与任务）；左键单击切换显示/隐藏；使用 EXE 内嵌图标（资源 ID 1），加载失败时有确定性回退图标。
- **关闭语义显式化**：默认“关闭主窗口 = 隐藏到托盘，Core 与任务继续运行”；Settings → 外观与窗口 可切换为“退出应用并停止 Core”。只有托盘“退出”、Ctrl+Q 或显式退出选项会走退出确认（列出正在生成的回复、未发送草稿、待处理任务），确认后停止 Core。
- **再次启动 = 从托盘恢复**：第二个实例通过命名事件唤醒既有实例并恢复主窗口（`Local\CetaMesh.Desktop.ShowWindow`），不会留下第二个进程。
- **窗口偏好持久化**（`desktop-shell/src/ui_prefs.rs`）：`state/desktop-ui.json` 保存 主题（跟随系统/浅色/深色）、缩放（0.8–1.6）、关闭行为、窗口几何（位置/尺寸/最大化）；原子写入（同目录临时文件 + rename），缺失/损坏/非法值一律回退默认且不阻塞启动。UI 只写这一个文件，不触碰 Task / Memory / Workspace 元数据。
- **主题与可访问性**：深/浅色调色板与全局样式，跟随 OS 或手动选择；缩放支持 Ctrl+0 / Ctrl+= / Ctrl+- 与设置页按钮，启动时应用；窗口最小 900×620，宽度 < 1040 时侧边栏折叠为顶部紧凑导航；进入 Chat 自动聚焦输入框，对话框支持 Esc 关闭。
- **快捷键**（F1 可查看列表）：Ctrl+1…Ctrl+7 切换 Chat/Tasks/Memory/Workspace/Settings/Diagnostics/Advanced；Ctrl+, 打开 Settings；Ctrl+Q 退出确认；Esc 关闭对话框；Enter 发送、Shift+Enter 换行。
- **中文输入 / IME 安全**：仅当输入框获得焦点、未按 Shift、且本帧没有 IME preedit/commit 事件时 Enter 才发送（`should_send_on_enter` 纯函数 + 5 组单测），确认候选词不会误发；提示文案说明该行为。egui/winit 原生处理 IME 组合，本机已安装微软拼音。
- **剪贴板与错误态**：输入框原生复制/粘贴；消息气泡提供“复制”；错误框新增“复制错误”；加载态（spinner + 文案）与空态沿用各页面既有实现。
- **崩溃 / 重启安全**：UI 被强杀后 Core 通过孤儿守卫退出；重启 UI 后 Task/Memory/Workspace 哨兵文件与 config.json 字节不变（真实冒烟断言）。Core worker 异常或 IPC 不可用时，页面顶部出现红色恢复横幅：重启 Core / 重新检查 / 打开日志目录。

### 阶段 13 验证（本机实测）

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `cargo test --offline --manifest-path desktop-shell/Cargo.toml` | PASS | 86 passed（含新增 ui_prefs 4、tray 1、主题 1、快捷键/IME 2） |
| `npm run desktop:check` | PASS | 0 error（7 个既有 dead-code/未用项 warning） |
| `npm run test-desktop-shell` | PASS | 进程监管契约 + 真实窗口 + Stage 13 场景全部通过 |
| Stage 13 真实窗口冒烟 | PASS | 真实窗口创建、系统托盘创建（Shell_NotifyIcon）、关闭→隐藏到托盘且 Core/worker 继续运行、再次启动→从托盘恢复、UI 强杀重启→元数据字节不变、无残留进程 |
| 主题/缩放/几何启动应用 | PASS | 冒烟以 dark + 110% + 已保存几何重启，日志确认“主题已应用：深色 / 界面缩放已应用：110% / 窗口几何已恢复” |
| 单实例唤醒 | PASS | 第二个实例退出码 0 且主窗口恢复（真实冒烟） |

### 未验证 / PENDING_NATIVE_VERIFICATION

- **Computer Use 在本会话不可用**（无 `node_repl` 工具、插件缓存中无 `@oai/sky`），因此纯视觉/鼠标走查未自动化：托盘图标的真实鼠标点击（菜单各项）、托盘菜单退出确认、深色主题观感、紧凑布局观感、中文 IME 候选窗交互均需人工确认。
- 人工验收脚本：F1 查看快捷键；Ctrl+2 / Ctrl+1 切换页面；Settings → 外观与窗口 切换深色与缩放；拖动窗口到不同显示器后重启验证几何恢复；点击托盘图标左键隐藏/恢复、右键菜单逐项验证（含“退出”确认）；在 Chat 输入框用微软拼音输入候选词并确认不会误发送。
- 多显示器：本机为单显示器 + 125% DPI；跨屏几何恢复逻辑有单测（允许负坐标、拒绝非法值），但未在双屏环境实测。
- 未做 release 安装包 / 更新链路验收；本阶段只构建 debug 壳。

### 下一阶段入口

按 roadmap 继续（例如 TASK-D1-002 Named Pipe Security Audit）；本阶段的托盘、窗口偏好与退出语义作为后续所有桌面功能的基础设施复用。

---

## （历史）2026-10-04 快照 — TASK-D1-001 Unified Config Service

本快照取代下方 D0 快照。本阶段完成 roadmap **TASK-D1-001**：统一配置服务（Unified Config Service）。

### 本阶段落盘内容

- 新增 `src/config/`（四文件）：
  - `loader.js`：BOM 容错读取、fail-closed（缺失/损坏/根非对象 → `ConfigError`，错误文案与旧 `readJsonSafe` 一致）、`readRawConfigOrEmpty`（MCP"未配置"语义）、`atomicWriteConfig`（临时文件+rename，0600）。
  - `migrate.js`：旧 config → 规范配置的逐字段等价移植（旧 `loadConfig` 的默认值、`allow.privates/group` 别名、`ownerQQ`/白名单规范化、`socialV2.tools` 与 `sticker.collect` 深度合并），导出 `DEFAULT_MODEL` / `normalizeOwnerQQ` / `normalizeIdList`。
  - `schema.js`：Zod 4 校验契约（`validateRawConfig` 只做诊断不改写）、`SECURITY_DEFAULTS`、`assertSecurityInvariants`（迁移不得把未显式开启的安全开关升级为 true）。
  - `service.js`：`createConfigService({ configFile })` → `load / readRaw / updateSection(merge|replace) / writeFile`。
- `src/bridge.js`：`loadConfig()` 改为薄封装委托 `migrateLegacyConfig(readRawConfig(CONFIG_FILE, { required: true }))`，删除约 290 行内联合并逻辑；`DEFAULT_MODEL` / `normalizeOwnerQQ` 改从 config 模块导入（运行期控制台直接改写 `cfg` 的行为不变）。
- 4 个 MCP 模块（`mcp-snowluma-safe` / `mcp-qq-file-send` / `mcp-bilibili` / `mcp-host-server`）的重复 raw 读取统一到 `readRawConfigOrEmpty`（行为等价：读不到按 `{}`，使用点 `!== true` / `=== false` 自行 fail-closed）。
- `package.json`：新增 `test-config` 脚本。
- 附带修复：esbuild 构建曾告警的 `src/bridge.js` 重复 `collect` 键已消除（迁移实现用单次显式合并达成相同最终结果）。

### 本阶段验证（本机实测）

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `npm run test-config`（`scripts/test-config-service.mjs`） | `PASS` | 黄金参照等价测试：内嵌迁移前 `loadConfig` 原文副本（git d35dbfe 行 329-619 提取），7 组夹具（空/最小/旧别名/socialV2 局部覆盖/全量/错误类型/未知字段）全部 deepEqual；另覆盖 loader fail-closed、BOM、orEmpty、schema 诊断、service 读写、ownerQQ 非法值、安全不变量 |
| 真实 `config.json` 新旧迁移输出 deepEqual | `PASS` | 一次性验证脚本（未入库）：对仓库当前真实配置，新旧实现输出完全一致 |
| `npm run test-core-entry` | `PASS` | worker 隔离数据目录启动成功——新 `loadConfig` 在 worker 模式实跑通过；五个 MCP 模式 initialize/listTools/callTool 通过 |
| `npm run test-privilege` | `PASS` | 24/24；运行中桥接端到端部分 fetch failed 自动跳过（该部分 `NOT_RUN_ENVIRONMENT`） |
| `npm run self-test` | `PASS` | 本机 DSH（127.0.0.1:3080）在线：探活/建会话/prompt/回合 completed/回复正常。注意 self-test 不经过 loadConfig，模型链路验证与配置改造相互独立 |
| `npm run test-app-paths` | `PASS` | 路径解析回归 |
| `esbuild`（ESM bundle `src/core-sea.js`） | `PASS` | 0 告警（duplicate collect-key 告警已消失） |
| Release / SEA 产物重建 | `NOT_RUN_ENVIRONMENT` | 本阶段未重建 dist/ 与 RC；安装器不受影响（无 Rust 改动） |

### 边界与已知问题

- **控制台 30+ 处写路径未迁移**：仍按原样直接读改写原始文件（保留未知字段）。`ConfigService.updateSection / writeFile` 已就绪并测试，逐个迁移是后续小阶段。
- `src/local-services.js` 安装期仍直写 `config.json`（snowluma/dsh 两个字段补丁）——后续迁移。
- `migrateLegacyConfig` 按等价性要求**原样保留**非布尔的安全开关值（如字符串 `'true'`）；fail-closed 由使用点 `=== true` 保证，类型异常由 `validateRawConfig` 诊断。二者配合即红线语义。
- schema 为诊断性校验，不因新增未知字段阻断启动（宽松透传）。

### 并发工作记录

本阶段执行期间（约 20:05–20:10），另一会话在同一工作区并行修改了本阶段未触碰的文件：`desktop-shell/*`（`native_ui.rs` 等）、`src/control/ipc-protocol.js`（新增 `chat.*` 方法族）、新增 `src/desktop/`（含 `chat-service.js`）、`desktop-shell/src/chat_ui.rs`、`src/memory/`、`scripts/test-desktop-chat-product.mjs` 与 `scripts/test-memory-runtime.mjs`，并在 `src/bridge.js` 追加了 17 行 chat 接线，`package.json` 追加 `test-memory` 脚本。按所有者说明，这属于按当前目标（CetaMesh Desktop v1 完整产品，含 Chat / Memory）正常推进的项目工作；下文 D0 快照中"不得恢复重建"的注释是旧阶段规则，已被当前目标取代。

本阶段对这些并行改动**未验证、未纳入提交**：`src/bridge.js` 采用部分暂存（`git apply --cached` 仅暂存配置相关 hunk），并行改动完整保留在工作区，由其所属会话自行提交与验证。另发现异常目录 `%SystemDrive%/`（疑似环境变量展开错误产生），未处置，留待其产生方清理。

另：同会话在分支 `codex/d1-unified-config-service` 提交了统一配置服务设计文档（`docs/superpowers/specs/2026-10-04-unified-config-service-design.md`）。与本实现的主要分歧，供后续对齐：① 该设计要求 MCP 读配置失败时"拒绝工具动作"，本实现沿用现行行为（按"未配置"空对象 + 使用点 fail-closed，能力被拒但进程可读），语义更宽松；② 该设计要求管理接口全部改走配置服务并做候选文档 schema 校验，本实现按最小边界暂缓（写路径迁移列为后续小阶段）。

### 下一阶段入口

- 按 roadmap：**TASK-D1-002 Named Pipe Security Audit**（当前用户 SID/ACL、未授权拒绝、协议版本/超大帧/超时拒绝 + 自动测试）。
- 小型后续（可先做）：把控制台写路径逐个迁移到 `ConfigService`；`local-services.js` 安装期写入接入。
- Persistent Task v1 / Context Rollover / Agent Handoff 维持搁置（见下方第 20 节禁扩建清单）。

---

## 阶段 06 — Agent Provider v1（2026-10-04）

把 DSH 从"写死的特殊系统"变成第一个标准 Agent Provider；**Agent Provider != Model Provider**，
保持两个独立概念（Model Provider 仍在 `control-service` 的 `model.*` 与 `chat-service` 的
`config.provider/model`，Agent Provider 决定"任务由哪种 Agent Runtime 执行"）。

### 落盘内容

- 新增 `src/agent/`（四文件）：
  - `agent-provider.js`：领域契约。`AGENT_PROVIDER_METHODS` = createSession / send / cancel /
    status / contextUsage / checkpoint / resume / handoff / capabilities / closeSession +
    扩展方法 follow / selectModel / health；`defineAgentProvider()` 为未实现方法**自动填充显式
    unsupported 桩**（抛 `AGENT_UNSUPPORTED`），`capabilities()` 同时列出 supported / unsupported；
    `AGENT_EVENT_PROTOCOL_DSH = 'dsh-session-events'` 标识会话事件流协议。
  - `dsh-agent-provider.js`：DSH 映射，复用现有 `src/dsh-client.js`（注入 bridge 共享的
    `NodeApiClient` 实例，不重写、不新建第二套 DSH 通道）。端点映射以真实调用与对运行中
    DSH 的探测为准：createSession→session/create(+selectModel)、send→session/prompt、
    cancel→session/cancel、status→session/list 投影、contextUsage→session/list 的
    tokenUsage/contextPressure、resume→session/list 存在性校验、closeSession→workspace/archiveSession、
    follow→session/follow 流、health→settings/describe。传输层失败统一归类
    `PROVIDER_UNAVAILABLE`（DSH 未启动的优雅降级依据）。
  - `service.js`：Provider 注册表 + `agent.*` 私有方法族（与 chat./memory./task. 同一接入模式，
    经桌面命名管道）；`createDefaultAgentService` 组合内置 DSH Provider，bridge 只导入这一个符号
    （避免与 continuity 侧同名的窄接口 provider 冲突）。
  - `index.js`：层入口。
- `src/control/ipc-protocol.js`：私有方法族前缀白名单追加 `agent.`。
- `src/bridge.js`：`createDefaultAgentService({ api, defaults: cfg.dsh..., log })` 接线；
  `startUiIpcServer` 增加 `agentService` 参数与 `agent.*` dispatch 分支。
- `src/desktop/chat-service.js`：会话新增可选 `config.agentProvider`（默认 `null` = 普通模型）。
  选择后回合经标准契约执行（agent.createSession / agent.send / agent.cancel），事件流协议
  经 `eventProtocol === 'dsh-session-events'` 校验后才允许选择；`chat.catalog` 返回
  `agentProviders` 列表供 UI 渲染"执行方式"选择。**不改变默认路径**：不选 Provider 时
  行为与阶段 03 完全一致（直连 DSH）。
- `package.json`：新增 `test-agent` 脚本。

### 验收（本机实测，`npm run test-agent`）

| 段 | 状态 | 说明 |
| --- | --- | --- |
| A 契约 | `PASS` | unsupported 自动填充与显式拒绝（checkpoint/handoff）；prompt 内容归一化 |
| B DSH 映射（mock api） | `PASS` | B1–B8：每个契约方法调用的端点与 payload 形状逐项断言；DSH 的 unsupported 精确等于 `['checkpoint','handoff']`（实测 DSH 无 session/checkpoint 端点，HTTP 404；handoff 无跨 Provider 协议）——不得为接口完整伪造能力 |
| C 优雅降级 | `PASS` | C2 mock 不可达 + **C3 真实死端口（127.0.0.1:9）**：health 返回 available:false；create/status/send/cancel/contextUsage/resume 全部结构化失败 `PROVIDER_UNAVAILABLE`，进程不崩 |
| E Chat 集成 | `PASS` | E1 catalog 暴露 agentProviders；E2 Agent 路径经 agent.createSession/send（不直连 DSH）；E3 不选 Provider 时保持直连 DSH（回归不变）；E4 未知 Provider / 事件协议不兼容均被拒 |
| D 真机验收（DSH 在线） | `PASS` | D1 createSession → D2/D3 send + follow 进度（turn/end completed，16 事件）→ D4 status + contextUsage（pressure=10488）→ D5 cancel（受理 + running 15s 内回落）→ D6 resume（新 provider 实例重挂既有会话）→ D7 closeSession（归档受理 ×2；实测归档后会话仍可能在 session/list 出现，按真实语义断言） |
| 单元/映射段合计 | `PASS` | 23 通过，0 失败；真机段 `PASS`（本机 DSH 127.0.0.1:3080 在线） |
| `npm run test-core-entry` | `PASS` | worker 隔离数据目录实跑含 agent 接线的 bridge 启动；五个 MCP 模式通过 |
| `npm run test-privilege` | `PASS` | 24/24（真实端到端部分仍 `NOT_RUN_ENVIRONMENT`） |

真机段会经本机 DSH 创建/取消/归档真实会话（测试自建的会话在 D 段末尾归档）。

### 边界与已知问题

- **UI 选择器未落 Rust**：数据面已就绪（`chat.catalog.agentProviders` + `chat.config.set` 的
  `agentProvider`），Rust 侧 Chat UI 是并发会话的后续工作，避免与其未提交 WIP 交织。
- **continuity 侧存在两套 DSH provider**：`src/continuity/provider.js` 的窄接口版
  （createContextSession/sendPrompt/cancel/archiveSession/estimateTokens）与本层全契约版并存；
  已知差异：窄接口版 `archiveSession` 报告"不支持单会话归档"，但实测 `workspace/archiveSession`
  可用（本层 closeSession 基于它）。后续应由 continuity 委托到本层收敛，属跨阶段重构。
- Task ↔ Agent 执行接线（PROJECT_STATE §7「resume/start 时按 currentAgent 调用 Agent Provider」）
  现在具备了统一抽象基础，接线本身未做。
- `follow` 不经一元 IPC 暴露（有状态 async iterable），进程内消费方直接持有 provider。

### 下一阶段入口

- Rust Chat UI 补"执行方式：Normal Model / Agent Provider"选择器（消费 `chat.catalog.agentProviders`）。
- continuity 窄接口 provider 委托到 `src/agent/`（消除双实现）。
- Task ↔ Agent Provider 接线（`task.start`/`task.resume` 按 `currentAgent` 调用 agent.*）。

---

## 阶段 12 — Desktop 系统页面（2026-10-04）

把此前散落的工程配置整理成成熟产品设置：Settings / About / Update / Diagnostics / 日志脱敏。

### Settings（10 个分区，可持久化）

`src/settings/` —— General / Models / Agents / Memory / Workspace / Devices / Extensions /
Security / Updates / Advanced。每项都有类型、默认值与描述，UI 只负责渲染。

**锁定项**表达的是「这不是偏好，而是产品的安全姿态」—— 可见、可理解，但改不动
（试图关闭返回 `LOCKED_SETTING`）：

| 锁定项 | 含义 |
| --- | --- |
| `security.redactLogs` | 日志脱敏始终开启 |
| `memory.requireConfirmationForLongTerm` | 长期记忆必须经用户确认 |
| `devices.requireApprovalForRemoteCapabilities` | 远程能力请求必须本地批准 |
| `extensions.requireReviewApproval` | 扩展高风险权限必须显式批准 |

损坏的 `settings.json` **不阻断启动**：解析失败回落默认值并如实上报 `lastError`。

### About

`src/about/` —— CetaMesh / Edition / Version / Build(commit, buildTime, buildId) / Runtime(node,
v8, platform, arch, packaged) / License / Repository。

「Version 与构建版本一致」不是文案承诺而是**算出来的**：版本只从 `package.json` 读，
同时从 `desktop-shell/Cargo.toml` 读桌面壳版本做交叉核对，输出 `versionConsistent`。
commit 优先取 `build-info.json`（发布构建写入），开发态可回退 git，两者都没有就报 `unknown`**绝不编造**。
顺带补齐了 `package.json` 的 `license`（GPL-3.0-only，与 LICENSE 一致）与 `repository`。

### Update（安全更新流程）

`src/update/` —— 支持 check / version compare / release notes / 下载链接与安装器接力：

- **签名必验**：清单必须用配置的 Ed25519 公钥验签通过才被采信；**没有配置公钥就一律不信任**
  （fail-closed，而不是「先装上再说」）。验签对象是**发布出来的那个对象**，不是归一化结果。
- **客户端不内嵌任何 Token**：检查走公开地址 + 用户可配公钥，不需要凭据。
- **不静默执行安装程序**：本模块**没有** `download` / `execute` / `install` / `run` 任何入口
  （测试断言它们不存在），只产出「有新版 + notes + 下载链接 + 需要用户确认的安装器接力信息」。
- 下载地址必须是 https，且主机命中设置里的允许列表，否则拒绝。
- 通道不匹配 / 版本不更新 / 低于 minVersion / 非 2xx / 非 JSON / 超时 / 网络错误，全部返回**结构化结果**，
  从不抛给调用方；构造更新服务时**不发起任何网络请求**（惰性）。

### Diagnostics 归位

`src/settings/pages.js` 把归位变成可断言的数据：产品主区只有 chat/tasks/memory/workspace，
原工程页面全部移到 diagnostics 或 advanced ——

| 工程页面 | 归入 |
| --- | --- |
| Core status / DSH service / SnowLuma / IPC / Logs | diagnostics |
| Whitelists / Runtime policy | advanced |

`engineeringPlacement()` 输出不变量与越界列表，UI 与测试直接消费。

### 日志默认脱敏

`src/logging/redact.js` —— 默认禁止输出：API key / Token / Pairing secret / Private key /
完整敏感 prompt / Credential（外加 cookie）。两层：

- **文本层**：正则命中即替换，保留「哪一类被抹掉」的标记，便于排查而不泄漏原值；
  **单遍处理**——每条规则的产物先换成不含字母数字的占位符，跑完再还原。
- **字段层**：按 key 名判定（prompt / messages / token / privateKey …）整体替换为摘要（只报长度），
  因为「完整敏感 prompt」无法靠正则识别。

`createRedactingSink({ enabled: false })` 会被拒绝（`REDACTION_REQUIRED`）：脱敏不是偏好。

### 已验证（本机实跑）

| 检查 | 结果 |
| --- | --- |
| `npm run test-system` | `PASS` 102/102 |
| `npm run desktop:test`（cargo test） | `PASS` 76/76 |
| `npm run desktop:check` | `PASS` 0 error |
| `npm run test-mesh` / `test-extension` / `test-task` / `test-memory` / `test-config` | `PASS` 86/86、87/87、90/90、85/85、69/69 |
| `npm run test-core-entry` | `PASS`（用本次接线版本启动真实 worker） |
| `npm run test-privilege` | `PASS` 24/24 |

验收项对应：**Settings 重启持久化**（新实例读回同一份，revision 保持）；
**About Version 与构建版本一致**（`versionConsistent === true`，且两个版本源都取自真实文件）；
**Update 网络异常时不影响主应用启动**（构造不联网、check 返回结构化错误、离线时 Settings/About 照常可用）。

### 本阶段发现并修复的两个真实缺陷

1. **验签对象错误**：最初对「归一化后的清单」验签，而归一化会补齐 `minVersion: null` 等字段，
   导致发布侧与客户端对「签的是什么」产生分歧 —— 合法清单也会被判 `SIGNATURE_INVALID`。
   改为对**发布出来的原始对象**验签（归一化是它的确定性函数）。
2. **Bearer token 泄漏**：`Authorization: Bearer <jwt>` 里，通用的 token 规则先匹配到
   `Authorization: Bearer`，只抹掉 `Bearer` 这个词，**真正的 JWT 留在日志里**。
   修复：把 Bearer 规则提前，并把测试从「包含 [REDACTED:token]」加强为「原值必须消失」，
   否则这个漏法仍然会通过断言。同一轮还修了「后一条规则命中前一条输出」导致的类别标错。

### 未纳入本次提交

- **Rust 侧页面挂载未提交**：`native_ui.rs` / `native_main.rs` 目前仍在被并行会话高频修改
  （本阶段执行期间又新增了 `continuityService` 接线），HEAD 的 `native_main.rs` 至今没有
  `mod app_shell;`，`native_ui.rs` 也不引用任何页面模块。因此 Settings 分区、About、Update、
  Diagnostics 归位的**后端与 IPC 已入库并可调用**，但把它们渲染成页面仍需等这批改动一并提交。
  本阶段已交付 5 个 UI 模块（memory_ui / task_ui / mesh_ui 及本阶段的系统页规划）处于同一状态。

### 已知问题

1. 更新检查默认**不可用**：未配置签名公钥时一律不信任（这是有意的安全默认），
   因此开箱状态下 Update 页会显示「未配置公钥，已停用」。发布流程需要生成密钥对并把公钥写进设置。
2. 没有自动更新执行：即使检查到新版也只给链接与 sha256，安装由用户手动完成（阶段要求如此）。
3. Settings 目前只作用到本模块自身（更新配置、脱敏开关等），尚未反向驱动旧 `config.json`；
   两者仍是并存的：config.json 是 WhaleBridge 时代运行时配置，settings.json 是 CetaMesh 产品设置。
4. `startUiIpcServer` 的位置参数已到 9 个，亟需改成表驱动（本阶段已把三个系统服务合并为一个对象，
   算是局部止血）。
5. 脱敏是「尽力而为」：无法靠正则识别的裸密钥（没有键名的随机串）不会被抹掉。

### 下一阶段入口

- 把 5 个 UI 模块一次性挂进 `native_ui.rs`（待并行会话提交 Chat/导航/连续性之后）。
- 发布流程：生成更新签名密钥、产出 `build-info.json`、把公钥写入默认设置。
- Settings 反向驱动运行时（模型默认值、脱敏级别真正作用到 Core 日志）。
## 阶段 11 — Device Mesh Desktop（2026-10-04）

让 Desktop 成为**标准 CetaMesh Node**：有身份、能被配对、能被信任、能被授权、能被撤销。
Desktop 不是 Mobile 的遥控器——它自己就是一个对等节点。

### 已完成（本次提交内容）

- `src/mesh/`（新增）：
  - `types.js`：Node Role（desktop/mobile/server/edge）、Trust 状态（pending/trusted/blocked）、
    Presence（unknown/online/offline）、Transport（loopback/pipe/tcp/relay）、协议版本与 7 项能力清单。
  - `identity.js`：**Device Identity** = Ed25519 密钥对 + 由公钥派生的稳定 node id
    （`node_<sha256(spki)[:32]>`，对端可独立复算）。私钥单独存 `identity.key`（0600），重启后身份不变。
  - `trust.js`：信任库。**trust 与 grants 分离**——已信任的节点默认没有任何能力；
    撤销信任 = 置 blocked + 清空全部授权。Disconnect 只清在线状态，不动信任与授权。
  - `capabilities.js`：Capability Manifest（本节点对外声明什么）。声明 != 授权。
  - `protocol.js`：信封结构/版本/时效/重放校验 + 签名，以及**远程能力请求授权链**（纯函数，可穷举）。
  - `node.js`：MeshNode —— createInvite / pair / trust / block / grant / revoke / disconnect /
    removeTrust / touch / handleEnvelope / approvals / decideApproval / audit / status。
  - `service.js` / `index.js`：`mesh.*` 方法白名单（含页面聚合 `mesh.snapshot`）。
- `src/channel/`（新增）：**Channel Adapter 定位**。把 QQ（OneBot v11 / SnowLuma）显式声明为
  `kind: 'channel-adapter'` 且 `coreDependency: false`，并提供可断言的不变量
  `channel.independence().coreGatedByChannels === false`。`channel.*` 方法族。
- `desktop-shell/src/mesh_ui.rs`（新增）：Devices / Mesh 区域（挂在 Settings 页顶部），
  展示 Device / Role / Trust / Transport / Last seen / Capabilities / Status / Last error，
  以及本节点身份、Channel Adapter 状态、配对邀请码、逐次审批。
- `scripts/test-mesh-runtime.mjs`（新增）：验收测试。
- Core 接线：`ipc-protocol.js` 增加 `mesh.*` / `channel.*` 路由；`bridge.js` 创建
  `createMeshService` / `createChannelService` 并接入 dispatch。
- `package.json`：新增 `test-mesh`。

### 授权链（Trusted != Authorized）

远程能力请求按固定阶段判定，每一步失败都返回带 `stage` 的决策，便于审计与 UI 展示卡在哪一步：

```text
1. protocol     信封结构 / 协议版本 / 时间偏移 / 重放 nonce
2. trust        对端存在 + trust===trusted + 签名有效（用对端公钥验签）
3. availability 能力在本节点清单内且当前可用
4. policy       该能力已显式授予该对端  ← Trusted != Authorized 的落点
5. approval     需要审批的能力必须有已批准请求（否则 pending_approval）
```

实现顺序把 **protocol 放在最前**（而不是按需求列表的 Trust 在前），因为「信任谁」必须先知道
「这条消息在语法上是谁发的、有没有被篡改」；这是有意偏离并在此说明。

### 已验证（本机实跑）

| 检查 | 结果 |
| --- | --- |
| `npm run test-mesh` | `PASS` 86/86 |
| `npm run desktop:test`（cargo test） | `PASS` 76/76（含本阶段 `mesh_ui` 3 项单测） |
| `npm run desktop:check` | `PASS` 0 error |
| `npm run test-extension` / `test-task` / `test-memory` / `test-config` | `PASS` 87/87、90/90、85/85、69/69 |
| `npm run test-core-entry` | `PASS`（用本次接线版本启动真实 worker） |
| `npm run test-privilege` | `PASS` 24/24 |

`test-mesh` 用**两个真实 MeshNode 实例在进程内互发信封**（协议、签名、信任、授权、审批、在线判定
全部真跑，只有 transport 是 loopback）覆盖：身份派生与重启不变；配对（邀请码一次性 / 过期 / 禁止自配对，
且配对成功只得到 pending）；未信任与未配对一律拒绝；**已信任但未授权在 policy 阶段被拒**；
授权后仍需逐次审批；批准放行 / 拒绝生效 / 审批不可重复决定；协议版本不符、载荷篡改（签名失败）、
过期消息、错误收件人、未知能力、重放 nonce、能力不可用、已拉黑对端 —— 各自命中正确的 stage；
Presence 心跳与 TTL 离线；Disconnect 不动信任与授权；Remove Trust 置 blocked 并清空授权；
零对端时 Core 仍 ready；Channel 出错不影响 Core；QQ 工具名仍在源码中（未删能力）；重启持久化；IPC 往返。

### PENDING_NATIVE_VERIFICATION（不要伪造跨设备 PASS）

- **真实跨设备链路未实现也未验证**：单机环境没有第二台 CetaMesh Node，
  `pipe` / `tcp` / `relay` 三种传输只在词表里声明，实际只支持 `loopback`（进程内）。
  本阶段的全部结论**只覆盖本机协议语义**，不代表两台设备之间能互通。
- Devices / Mesh 区域的视觉交互：未做真机目视确认。

### 未纳入本次提交

- **Rust 侧页面挂载未提交**：`desktop-shell/src/mesh_ui.rs` 已入库并单测通过，
  但把它挂到 Settings 页所需的 `native_ui.rs`（`Area::Mesh` / `Area::Channel` / `Operation::MeshCall` /
  `show_settings_page`）与 `native_main.rs`（`mod mesh_ui;`）改动目前与并行会话在制的 Chat UI /
  产品导航位于同一批未提交改动里（HEAD 的 `native_main.rs` 连 `mod app_shell;` 都还没有），
  单独提交会连带引用未跟踪的 `chat_ui.rs` / `app_shell.rs`。
  当前工作区里这些改动是**完整且已通过** `cargo check`(0 error) 与 `cargo test`(76/76) 的，
  属提交顺序问题而非代码缺口；等 Chat/导航一起提交后即可入库。

### 已知问题

1. 跨设备执行未接线：授权通过后，除 `mesh.presence` / `mesh.manifest` 由本节点直接处理外，
   其余能力返回 `executor_not_wired` —— 授权链是真的，远程执行器还没有。
2. 无端到端加密与会话密钥协商；信封只做签名（完整性 + 身份），不做加密（机密性）。
3. 重放防护是 10 分钟窗口内的 nonce 集合，重启后清空（跨重启重放未覆盖）。
4. 无 NAT 穿透 / 中继；`relay` 只是词表占位。
5. `startUiIpcServer` 已经累积到 7 个位置参数，产品方法族分派值得改成表驱动（技术债）。

### 下一阶段入口

- 真实跨设备传输：先实现 `tcp`（本机双进程即可验证）再谈 `relay`；补端到端加密与密钥协商。
- 远程执行器接线：把 chat / memory / task / workspace / extension 的真实执行接到授权链之后。
- Rust 页面挂载随 Chat/导航一并提交，然后做 Devices 区域的真机目视验收。
## 阶段 10 — Desktop Extension v1（2026-10-04）

本地扩展体系：只做 Local Import 与生命周期，**不做市场服务器**。

### 已完成（本次提交内容）

- `src/extension/`（新增）：
  - `types.js`：7 种扩展类型（tool / external-api / workflow / memory-pack / channel-adapter /
    agent-adapter / ui）；权限表带风险等级；**shell / native / download / process 登记为 risk:'forbidden'
    ——永久不可授予**；id / 版本 / scope.paths / network.hosts 归一化（拒绝绝对路径与目录穿越）。
  - `manifest.js`：manifest 校验（`extension.json` / `manifest.json`）。声明 network 必须给 hosts、
    声明 filesystem.* 必须给 scope.paths，否则 fail-closed；fingerprint 作为批准凭据的锚点。
  - `scan.js`：入口源码静态预检。**先按词法剥掉注释再匹配**（否则正常文档注释会被误判），
    require / ESM import / 动态 import / child_process / exec|spawn / process / fs 等一律拒绝安装。
  - `review.js`：Permission Review 文档（权限 / 风险 / 能力 / 网络白名单 / scope + fingerprint + token）；
    能力不得声明未在 permissions 里出现过的权限；`enforced` 如实标注哪些权限运行期真的会被注入。
  - `host.js`：受限执行宿主。上下文里**不存在** require / module 加载器 / process / Buffer / fs / net /
    child_process；`codeGeneration:{strings:false,wasm:false}` 关掉上下文内的 eval 与 new Function；
    只有被授予的权限才注入对应能力；network 必须命中 manifest 白名单（并复用 safe-fetch 的 SSRF 防护）；
    每次调用有墙钟超时。
  - `store.js`：已安装注册表 + 扩展私有存储（按扩展 id 命名空间隔离）。
  - `installer.js`：Local Import → manifest 校验 → 源码预检 → Review → 批准 token → 复制进受管目录 → 落库；
    update 强制版本递增，且**新增权限必须重新批准**；uninstall 删除受管目录、不碰用户来源目录。
  - `runtime.js`：enable / disable / invoke / logs；重启后按注册表**惰性重建宿主**，让「启用」跨重启生效。
  - `service.js` / `index.js`：`ext.*` 方法白名单。
- `extensions/`（新增两个验收扩展）：
  - `cetamesh-hello-tool`：无敏感权限的简单 Tool（仅 log；纯计算能力 `hello.greet`）。
  - `cetamesh-http-meta`：需要明确 Permission 的扩展（log + storage + network，网络白名单 example.com）。
- Core 接线：`ipc-protocol.js` 增加 `ext.*` 路由；`bridge.js` 创建 `createExtensionService` 并接入 dispatch。
- `package.json`：新增 `test-extension`。

### 已验证（本机实跑）

| 检查 | 结果 |
| --- | --- |
| `npm run test-extension` | `PASS` 87/87 |
| `npm run test-task` / `test-memory` / `test-config` | `PASS` 90/90、85/85、69/69 |
| `npm run test-core-entry` | `PASS`（用本次接线版本启动真实 worker） |

覆盖：两个扩展的 安装 → 启用 → 调用 → 禁用 → 卸载 全链路；review 风险分级与批准凭据
（未批准 → APPROVAL_REQUIRED，凭据不符 → REVIEW_MISMATCH）；四项禁止权限全部被拒；
5 类源码违规被预检拒绝且注释不误伤；能力声明未授权权限被拒；manifest 校验（无 hosts / 非法 id /
非法版本 / entry 穿越 / scope 穿越 / 未知类型）；vm 上下文遏制（require / process / fetch / storage
均为 undefined，eval 与 new Function 均被禁用）；网络主机白名单与非 http(s) 协议拒绝；
Update 的版本与权限提升检查；重启持久化与惰性重建；卸载清受管目录并保留来源目录；`ext.*` IPC 往返。

### 未验证 / 未纳入本次提交

- **桌面扩展管理页未做**。本阶段「只做」清单是生命周期，原文亦明确「不要求本阶段实现复杂插件 UI」。
  因此 Permission Review 目前由 `ext.review` 提供、且 `ext.install` **强制要求 review token**——
  「没审查过就装不上」在 API 层已经成立，只是还没有渲染到桌面页面上。
- 视觉 / 真机：`PENDING_NATIVE_VERIFICATION`。

### 已知问题

1. **vm 是遏制（containment），不是安全沙箱**。真正的隔离边界应当是「独立进程 + OS 级限制」，本阶段未做。
   `codeGeneration` 关闭 + 无 require/process + 无 fs/net 已挡住常见逃逸路径，但同进程执行的残余风险仍在。
2. 无代码签名 / 来源校验；只支持本地目录导入，不做任何下载，因此「任意下载 JS 后执行」在数据流上不存在。
3. `filesystem.*` / `memory.*` 权限目前**只有声明与审查面**，宿主尚未注入对应能力（review 的 `enforced=false` 已如实标注）。
4. 扩展为单文件入口（上下文里没有 require，因此不能自行拆分模块）。
5. 不做市场服务器，只保留 source metadata / publisher / version 字段。

### 下一阶段入口

- 桌面扩展管理页：需要同时在 `app_shell.rs` 的导航里加一项，再在 `native_ui.rs` 挂页面。
- 真隔离：把扩展宿主移到子进程并做权限降级；补齐 filesystem / memory 权限的实际注入。
- 来源校验（摘要 / 签名）与更新通道。
## 阶段 07 — Persistent Task v1（2026-10-04）

**冻结已由所有者显式解除**：本阶段按所有者直接指令实施 Persistent Task v1，
取代此前「Persistent Task v1 / Context Rollover / Agent Handoff 维持搁置」的记录。

核心原则落地：**Task 属于 CetaMesh，不属于 Agent Session**。
一个 Task 可先后绑定多个 Agent Provider 的 Session，更换 Provider 只追加 `agentHistory`，任务 id 永不改变。

### 已完成（本次提交内容）

- `src/task/`（新增）Persistent Task 运行时：
  - `types.js`：8 个状态 `queued|running|waiting|blocked|paused|completed|failed|cancelled`；
    **显式迁移表** `TASK_TRANSITIONS`（终态不可再迁移）；`ATTENTION_STATUSES` 定义 Needs Attention。
  - `store.js`：原子写（临时文件 + rename、0600）+ 每任务 `rev` 的显式冲突检测；损坏 fail-closed。
  - `runtime.js`：生命周期（start/pause/resume/wait/block/complete/fail/cancel）、
    Agent Provider 绑定与切换、Checkpoint、Completed/Pending Work、Artifacts、Decisions、
    Memory References、Acceptance Criteria、Progress、`overview` 页面聚合。
  - `service.js` / `index.js`：`task.*` 方法白名单。
- `desktop-shell/src/task_ui.rs`（新增）：Tasks 产品页——Task list / Create / Open / Pause / Resume /
  Cancel / Status / Progress / Needs Attention / Artifacts / History + Agent Provider 绑定/更换 + Checkpoint。
- `scripts/test-task-runtime.mjs`（新增）：验收测试。
- Core 侧接线（本提交一并纳入）：`src/control/ipc-protocol.js` 增加 `memory.*` / `task.*` 私有方法族路由；
  `src/bridge.js` 创建 `createMemoryService` / `createTaskService` 并接入 UI 命名管道 dispatch。
  这两处提交的是「HEAD + 本会话改动」，把并行会话在制 Chat 接线完整留在工作区。
- `package.json`：新增 `test-task` 脚本。

### 已验证（本机实跑，全部 PASS）

| 检查 | 结果 |
| --- | --- |
| `npm run test-task`（`scripts/test-task-runtime.mjs`） | `PASS` 90/90 |
| `npm run desktop:test`（cargo test） | `PASS` 73/73（含本阶段 `task_ui` 3 项与阶段 04 `memory_ui` 3 项单测） |
| `npm run desktop:check`（cargo check） | `PASS` 0 error（桌面壳恢复可编译） |
| `npm run test-memory` | `PASS` 85/85 |
| `npm run test-config` | `PASS` 69/69 |
| `npm run test-core-entry` | `PASS`（含用本次「HEAD+本会话接线」版本启动真实 worker） |
| `npm run test-privilege` | `PASS` 24/24 |

`test-task` 覆盖验收项：**新建**（17 个 Task Domain 字段齐备 / Goal 必填 / 验收标准归一化）、
**修改**（rev 递增、过期 rev → `TASK_CONFLICT`、缺 rev → `REVISION_REQUIRED`、冲突后数据未破坏）、
**执行**（queued→running 并绑定 Provider/Session，重复执行幂等且不递增 rev）、
**暂停 / 恢复**、**重启恢复**（Task/Goal/Status/Progress/Checkpoint/Agent History/Workspace/rev/
Work/Artifacts/Decisions/MemoryRefs 全部保留）、**更换 Agent Provider**（id 不变、history 追加、
上一 Session 标记 detached、任务总数不变）、**失败**（failure.reason、解绑 Agent、终态）、
**取消**、**完成**（Progress=100、result.summary、终态），外加非法迁移拒绝、Needs Attention、
`task.overview` 聚合、Service 层方法白名单与 `task.*` 的 IPC 端到端往返。

### 未验证 / 未纳入本次提交

- **Tasks 页接线未提交**：`desktop-shell/src/native_ui.rs`（`Area::Task` / `Operation::TaskCall` /
  `TaskUi` 字段 / `show_tasks_page`）与 `desktop-shell/src/native_main.rs`（`mod task_ui;`）已在工作区就位，
  且随 `cargo check` / `cargo test` 一起通过；但它们与并行会话在制 Chat UI 位于同一批 hunk，
  单独提交会连带引用未跟踪的 `desktop-shell/src/chat_ui.rs`。故 `task_ui.rs` 已入库、
  **页面上线随 Chat 提交一并完成**；当前提交状态下 Tasks 页仍是占位页。
- Tasks 页视觉交互：`PENDING_NATIVE_VERIFICATION`（需真机运行桌面壳）。
- 真实 Agent 执行链路（Task 驱动某个 Provider 实际干活）：未接线、未验证；本阶段只做 Task 领域与运行时。

### 已知问题

1. 按阶段要求**有意不做**：cron 调度、云端任务编排、多 Agent 自动编排。`resume` 只改状态与绑定，
   不会自动去启动某个 Agent 去执行。
2. `agentHistory` 上限 100 条、Artifacts/Decisions/MemoryRefs 上限 200 条，超出后丢弃最旧项。
3. Task 与 Workspace 目前只是 ID 关联（`workspaceId`），没有 Workspace 安全边界 enforcement——
   与 PROJECT_STATE 第 9 节的 Workspace 现状一致。
4. 工作区存在字面目录 `%SystemDrive%/`（并行会话命令变量未展开的副产物），非本阶段产生，未处置。

### 下一阶段入口

- Tasks 页上线：随 Chat UI 合并后提交 `native_ui.rs` / `native_main.rs`，并做真机视觉验收。
- Task ↔ Agent 执行接线：`resume`/`start` 时按 `currentAgent` 调用 Agent Provider（需先有统一 AgentProvider 抽象）。
- Context Rollover / Agent Handoff：本阶段只落地了 Checkpoint 与 Agent History 两个基座，
  迁移/接力运行时仍未实现。
## 阶段 05 — Workspace v1（2026-10-04）

建立真正属于 CetaMesh 的 Workspace，作为 Agent 与工具访问文件系统的**安全边界**。
本节记录本阶段实际落盘与验证；验证只对本机实跑负责。

### 已完成（本次提交内容）

- 新增 `src/workspace/`（五文件）：
  - `boundary.js`（安全核心）：`canonicalizeRoot`（拒绝盘符根 / Windows / Program Files / ProgramData / 用户主目录及其祖先作为 root；UNC/设备路径、NUL 拒绝）+ `resolveInside`（词法 contain 校验 → 逐段 Win32 特例检查 → 存在部分 realpath 复检）。拒绝面：`../` 穿越、绝对路径逃逸、junction/symlink 逃逸（realpath 复检）、8.3 短名（realpath 归一）、`.. ` 尾部空格段（Win32 会改写语义）、保留设备名（con/nul/com1…含带扩展名形式）、UNC/`\\?\`、NUL、超长路径。root 内 junction 指向 root 内仍允许（不误伤）。
  - `registry.js`：工作区清单（`state/workspaces.json`，原子写复用阶段 01 的 `atomicWriteConfig`）。create/list/get/rename/remove/open/updateSettings + recentFiles/artifacts/activity 记录。**remove 只从清单移除登记，绝不删除用户目录**（测试断言目录保留）。commit 审批请求（10 分钟过期、remove 时级联清理）。
  - `tools.js`：`workspace.read`（截断/二进制 base64）、`workspace.write`（createDirs、写入前父目录 realpath 复验收窄 TOCTOU）、`file.search`（子串 + glob、跳过 `.git`/`node_modules`、**不跟随逃逸 junction**、条数与深度上限）、git 三动词 `status` / `diff` / `commit`（execFile 参数数组，无 shell；**代码中不存在 reset --hard / clean / push 的任何构造路径**）、`test.run`（只执行工作区设置登记的 testCommand，cwd 强制为 root）。
  - `service.js`：IPC 方法白名单 `workspace.*`（create/list/open/rename/remove/info/settings/read/write/file.search/git.status/git.diff/git.commit/test.run/pending.list/pending.decide）。git.commit 按工作区策略：`allow` 直通 / `approval`（默认）进入待审批，由 `workspace.pending.decide` 显式批准后才执行 / `deny` 拒绝。`workspace.info` 聚合 git 状态、最近文件、产物、活动流、待审批、Task 关联位（Persistent Task 冻结中显示未启用）。
  - `index.js`：统一出口。
- `desktop-shell/src/workspace_ui.rs`（新）：Workspace 产品页（清单/新建/重命名/从清单移除/设置/工具动作/commit 审批/最近文件/产物/Agent 活动/任务关联位）。镜像 `memory_ui.rs` 契约：只维护状态与 `WorkspaceAction` 意图，IPC 由 `native_ui.rs` 下发；含 3 个单元测试。`native_ui.rs` 接线（Area/Operation/字段/初始化/页面/响应刷新型链）与 `native_main.rs` 的 `mod` 声明。
- `scripts/test-workspace-runtime.mjs`（服务层验收，47 项）+ `scripts/test-workspace-ipc.mjs`（IPC 端到端，11 项）+ `package.json` 的 `test-workspace` 脚本。

### 本阶段验证（本机实测）

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `node scripts/test-workspace-runtime.mjs` | `PASS` | 47/47：正常读写/搜索/git 全流程 + 全部 escape case（`../`、多级穿越、绝对路径、junction 读写逃逸、`.. ` 尾部空格、UNC/`\\?\`、NUL、保留设备名读写、盘符相对路径）+ Windows 行为（大小写不敏感、8.3 短名归一、危险 root 拒绝）+ 清单生命周期（remove 不删目录、Recent Workspaces 最近打开排序）+ commit 三策略（allow/approval 批准与拒绝/deny）+ test.run（成功/失败码/cwd 断言） |
| `node scripts/test-workspace-ipc.mjs` | `PASS` | 11/11：真实 Core worker + 真实命名管道（`\\.\pipe\…`）往返；`workspace.*` 经 bridge.js 接线可达；`../` 与绝对路径逃逸在 IPC 层返回 `BOUNDARY_ESCAPE` 错误帧；清单持久化在隔离 data-dir |
| `cargo test`（desktop-shell） | `PASS` | 79 passed（含 workspace_ui 3 项单元测试） |
| `cargo check` | `PASS` | 0 error；0 warning（本阶段文件）；既有 warning 6 项（`show_product_placeholder` 全页面实现后成为死代码等，未处置） |
| `node scripts/test-ipc-protocol.mjs` | `PASS` | 协议帧/版本/错误帧回归 |
| `npm run test-core-entry` | `PASS` | worker 隔离数据目录启动 + 五个 MCP 模式；本次 worker 启动同时覆盖新增 workspace 服务构造 |
| `npm run test-privilege` | `PASS` | 24/24；运行中桥接端到端部分 fetch failed 自动跳过（`NOT_RUN_ENVIRONMENT`） |
| 真机视觉验收（Workspace 页交互） | `PENDING_NATIVE_VERIFICATION` | 单元测试覆盖状态机与解析；未做人工视觉走查 |
| `git.commit` 之外的危险 git 操作 | `PASS`（静态） | 源码中不存在 `reset --hard` / `clean` / `push` 构造路径（评审项，非运行断言） |

### 边界与已知问题

- **TOCTOU（如实记录）**：`realpath` 校验与实际 open 之间存在窗口；写入路径通过"写前父目录 realpath 复验"收窄，彻底解决需要 openat2 风格支持，超出本阶段。
- `test.run` 执行的是 owner 在工作区设置里登记的**整串命令**（cmd 语义），这是产品设计（工作区自带测试入口），不是任意命令注入面；但拥有工作区设置写权限即等于拥有该工作区内的命令执行权。
- 工具仅暴露 read/write/file.search/git.status/diff/commit/test.run 七类；`workspace.write` 不提供删除/移动动词（避免破坏性文件操作进入本阶段）。
- Workspace 页的 Task 关联位为占位（Persistent Task 冻结中）。

### 与并行会话的交织（如实记录）

- `src/bridge.js` / `src/control/ipc-protocol.js` 的 workspace.* 接线（import、`startUiIpcServer` 参数、dispatch 分支、服务构造、`workspace.` 方法族透传）由本阶段实际编写并在工作区验证（test-workspace-ipc 11/11）；由于两文件当时与并行会话的未提交改动交织，本提交采用索引级部分暂存（`git hash-object` + `update-index --cacheinfo`，等价于既有 `git apply --cached` 做法）**仅提交本阶段的接线 hunk**，并行改动原样留在工作区由其自行提交。
- `native_ui.rs` 的 Area/Operation/字段/初始化/页面接线已被并行提交（`14c6a70`）携带入库；本提交补其响应刷新型链的最终版本。

### 下一阶段入口

- roadmap `TASK-D1-002` Named Pipe Security Audit（SID/ACL、未授权拒绝、超大帧与版本拒绝 + 自动测试）。
- Workspace 后续小步：Workspace 页真机视觉验收；`workspace.write` 的 artifact 登记联到产物面板；Task 关联位在 Persistent Task 解冻后接线。

## 阶段 04 — Desktop Memory v1（2026-10-04）

本轮由并行会话完成 **统一 Memory 运行时**（roadmap 未编号；与 D1-001 配置服务、产品级 Chat 并行施工）。
本节的验证只对本机实跑负责。

### 已完成（本次提交内容）

- `src/memory/`（新增）统一 Memory Runtime：
  - `types.js`：类型 `working|chat|user|task|workspace`；Scope `global|workspace|task|chat|user`；
    来源 `user|chat-candidate|qq-adapter|system`；`LONG_TERM_TYPES` 显式标出需用户确认的类型。
  - `store.js`：原子写 + 每记录 `rev` 的 revision/冲突检测。**只对外暴露按授权分区的检索原语**
    `scanAuthorized(scopeKeys, predicate)`，不提供「取全量再过滤」的入口——授权先于检索由结构保证。
  - `policy.js`：`authorize` 产出检索过滤器（已授权 scopeKey + 允许类型）。Agent 默认只读 `working`/`chat`、
    只写 `working`；写长期类型在策略层直接拒绝（`LONG_TERM_REQUIRES_CONFIRMATION`）；`confirm`/`admin` 仅限用户主体。
  - `runtime.js`：固定顺序 authorize → retrieve → rank；CRUD / 搜索 / Pin / stats；
    Chat 候选两阶段——`proposeCandidate` 只登记候选（不产生记忆），`confirmCandidate` 由用户确认后才落库并记录
    `confirmedAt`/`confirmedBy`/`origin.candidateId`。
  - `adapters/qq.js`：旧 QQ/socialV2 记忆**只读**适配器（`activeTopic→chat`、`pendingThought→working`、
    `memberImpression→user`），稳定 `origin.ref` 保证幂等导入，从不改写 `social-v2.json`。旧 QQ 记忆数据与工具保留不动。
  - `service.js` / `index.js`：`memory.*` 方法白名单 + `memory.overview` 页面聚合查询；主体固定为 `user:desktop`，
    IPC 调用方不能自带 principal。
- `desktop-shell/src/memory_ui.rs`（新增）：Memory 产品页——查看 / 搜索 / 过滤 / 创建 / 编辑 / 删除 / Pin /
  来源 / 更新时间 / Scope / rev，含待确认候选区。仅维护状态并返回调用意图，不直接持有 CoreApi。
- `scripts/test-memory-runtime.mjs`（新增）：验收测试。
- `package.json`：新增 `test-memory` 脚本。

### 已验证（本机实跑）

| 检查 | 结果 |
| --- | --- |
| `npm run test-memory` | `PASS` 85/85 |
| `memory_ui.rs` 独立类型检查（`rustc --test --emit=metadata`） | `PASS`（0 error / 0 warning） |

`test-memory` 覆盖：CRUD；search 命中/排序/pinned 优先；scope 过滤；**授权先于检索的可证明性**
（受限 Agent 的 `meta.scanned` 只等于已授权分区条数，未授权分区既不读也不计数）；未知类型/未知 Scope 拒绝；
Agent 直接写长期记忆被拒、可写 `working`；Agent 不能删除、不能自行确认候选；候选 accept/reject 全路径；
候选不可重复确认；revision 冲突（过期 `expectedRev` → `MEMORY_CONFLICT`，缺 `expectedRev` → `REVISION_REQUIRED`，
冲突后数据未被破坏）；重启持久化（记录/id/rev/候选状态一致）；QQ 适配器只读（导入前后 `social-v2.json` 字节一致）
与幂等（二次导入 0 新增/4 跳过）；`memory.*` 的 IPC 端到端往返。

### 未验证 / 未纳入本次提交

- **IPC 接线未提交**：`src/control/ipc-protocol.js`（`memory.*` 路由）、`src/bridge.js`（`createMemoryService` +
  dispatch 分支）、`desktop-shell/src/native_main.rs`（`mod memory_ui;`）三处改动已在工作区就位并复核在位，
  但它们与并行会话的在制 Chat 接线**位于同一批 hunk**，单独提交会连带提交 `src/desktop/chat-service.js` 的引用，
  而该文件当前未跟踪，会让提交处于不可构建状态。故留给两侧工作合并后再提交。
  因此**本次提交的 Memory 运行时暂时不能从桌面壳直接调用**（Node API 与测试可用）。
- `cargo check` / `cargo test` 整体：`FAIL`，但与本阶段无关——`desktop-shell/src/native_ui.rs` 与 `chat_ui.rs`
  当前处于并行会话的编辑中间态（缺 `NativeUi.chat` 字段、缺 `Area::Chat`/`Area::ChatStatus`、
  第 1744 行 Rust 字符串内引号未转义）。剔除这些后，138 个错误中**引用本阶段符号的错误数为 0**。
- `memory_ui.rs` 的 3 个 Rust 单测：`BLOCKED`（整体构建不可用；且本会话进程内无 `link.exe`，无法单独链接）。
- Memory 页视觉交互：`PENDING_NATIVE_VERIFICATION`。真实 DSH / 真机链路：未跑。

### 已知问题

1. `rank` 为确定性启发式（pin > 命中质量 > 新鲜度 > 类型权重），不含向量检索——按阶段要求有意不做向量库平台化。
2. QQ 适配器为显式调用导入，未做后台自动同步。
3. 控制台尚未接入 Memory 页所需的写路径迁移（沿用 D1-001 的边界）。
4. 工作区存在字面目录 `%SystemDrive%/`（疑似环境变量未展开的副产物），非本阶段产生，未处置。

### 下一阶段入口

- 合并接线后重跑 `cargo check` / `cargo test`，并对 Memory 页做真机视觉验收。
- Memory 后续：按 workspace/task 维度的细粒度授权、长期记忆 Consolidation、
  以及在 Chat 回合中调用 `proposeCandidate` 的接线（候选→确认→落库链路已可用）。

## D0 snapshot — 2026-10-04（TASK-D0-001/002 基线快照，被上方快照取代）

This snapshot supersedes older status notes below. The repository is Desktop / Windows only; Mobile is a separate project.

### Repository and working tree

- Audit start: branch `main`, HEAD `90def05` (`docs(desktop): D0 基线复验记录（TASK-D0-001/002）`), four local commits ahead of `origin/main@1b8ef61`. The earlier local commits include the installer `--remove-data` fix (`05a6c99`) and the explicit Chat-loop revert (`34b321d`).
- The only configured remote is `origin` → `https://github.com/chx6418-source/whalebridge.git`. No `CetaMesh` remote is configured. No fetch, push, or upload was performed.
- At audit start tracked files were clean. Existing untracked paths are preserved and excluded from this work: `desktop-shell/native-spike/`, `output/`, five `plugins/cetamesh-*` directories, `scripts/test-desktop-plugin-helpers.mjs`, `scripts/test-desktop-plugins.mjs`, `src/desktop-plugin-host.js`, `src/desktop-plugin-storage.js`, and `src/mcp-desktop-utilities.js`.
- `AGENTS.md` is absent. `RULES.md` and `README.md` retain WhaleBridge / QQ bridge era context. `docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md` is a plan, not evidence of implementation.

### Actual implementation status

| Area | Source inspection | Verification |
|---|---|---|
| Desktop Shell | Native Windows Rust `eframe/egui` UI; currently an administration console | Cargo check/test and shell smoke ran; visual interaction is `PENDING_NATIVE_VERIFICATION` |
| Core and lifecycle | Node.js ESM Core; source worker and Node SEA executable; Rust supervisor starts, restarts, stops, and waits for readiness | Core entry, supervisor, and SEA worker tests ran as listed below |
| IPC | Windows Named Pipe; v1 little-endian length-prefixed JSON, requests/responses, events, structured errors, version checks | Rust tests, Node IPC test, and shell smoke `PASS` |
| Chat / Agent | No mature independent CetaMesh Chat product page; DSH client/session APIs exist, but no generic AgentProvider contract | Chat loop from `d632720` was reverted by `34b321d`; it is not current functionality |
| Model Provider | DSH model catalog, default model, and presets exist; no generic Model Provider or credential store | Generic provider flow not verified |
| Memory | Primarily QQ/Social Memory tools and storage; no unified authorized Memory Runtime | Product-level cross-session/task/workspace memory not implemented or verified |
| Workspace | DSH workspace API concepts exist; no CetaMesh-owned file security boundary | Product-level isolation not implemented or verified |
| Tasks / Continuity | Internal service tasks exist; no CetaMesh Persistent Task, Context Rollover, or Agent Handoff runtime | Deferred: the earlier explicit instruction not to start Persistent Task v1 remains in force |
| Capability / Approval | Legacy roles/policy and approval/question/risk queues exist; no unified Capability, Permission, Approval, Audit, and Workspace Scope engine | Only legacy module regression coverage ran |
| Channels / MCP | QQ/SnowLuma adapters and MCP host/dispatch exist; they are adapters, not the Core center | Core entry, DSH integration, and privilege tests ran |
| Plugins / Device Mesh | No verified Desktop plugin install/execution system or Device Mesh protocol in tracked source | Untracked plugin drafts/declarations are not treated as runnable features |
| Installer / release | Native install, repair, migration, uninstall, SEA, and release scripts exist | Installer lifecycle and SEA/Core distribution tests ran; full Release Candidate remains unverified |

Security defaults confirmed in source: `allowAllWhenEmpty=false`, `snowluma.allowProcessControl=false`, and `socialV2.tools.clickCardButton=false`.

### Source checks and automated verification

`PASS` applies only to the command run on this machine; it does not imply external services, native visual interaction, or release coverage.

| Check | Status | Result and boundary |
|---|---|---|
| `npm run test-privilege` | `PASS` | 24 passed, 0 failed; live end-to-end portion did not run because fetch failed (`NOT_RUN_ENVIRONMENT`) |
| `npm run test-core-entry` | `PASS` | Core entry, MCP modes, and temporary worker startup |
| `npm run test-dsh-integration` | `PASS` | Install/repair/migration/rollback/idempotence and DSH config snapshot preservation |
| `npm run test-desktop-supervisor` | `PASS` | Supervisor lifecycle |
| `npm run desktop:check` | `PASS` | Rust Desktop check |
| `npm run desktop:test` | `PASS` | Final run: 62 Rust tests, including remove-data uninstall transaction regression |
| `node scripts/test-control-service.mjs`; `node scripts/test-ipc-protocol.mjs` | `PASS` | Control service and Node IPC protocol |
| `npm run test-desktop-shell` | `PASS` | Core/Shell IPC, query/control, restart, shutdown, and conflict paths; existing instance held the single-instance lock, so interactive UI was not verified (`PENDING_NATIVE_VERIFICATION`) |
| `node scripts/test-desktop-install.mjs` | `PASS` | Final standalone run covered install, upgrade, repair, migration, preserve-data uninstall, full data removal, and reinstall. An earlier concurrent run once exited with stack overflow `3221225725`; subsequent isolated and parallel runs passed and did not reproduce it. This remains an intermittent observation, not a confirmed root-cause fix. |
| Core SEA build in a unique temporary output directory | `PASS` | Resource/executable audit passed; executable `--help` ran; existing `dist/` was not overwritten |
| `scripts/test-core-dist.mjs` against that temporary SEA output | `PASS` | PATH-isolated worker, data paths, MCP stdio, API authentication, DSH compatibility, and process cleanup; assertions now reflect the API-only/no-product-HTML Core contract |
| `npm run self-test` | `NOT_RUN_ENVIRONMENT` | It creates a DSH session and sends a prompt, so requires a live DSH/model and external session side effects; not launched |
| Release build / Release Candidate / installer package / icon checks | `NOT_RUN_ENVIRONMENT` | No fresh complete candidate was produced; existing ignored `dist/` was preserved, so there is no release verification claim |
| Native Windows UI visual operation | `PENDING_NATIVE_VERIFICATION` | Automated shell smoke is not a visual interaction check |

The Core build emitted a duplicate `collect` key warning in `src/bridge.js` and a Windows SEA injection signature warning. Neither failed the build. The earlier installer stack overflow was not reproduced; do not claim its cause is resolved.

### D0 changes in this stage

- `desktop-shell/src/installer.rs`: added a regression test ensuring successful `--remove-data` uninstall removes user data, the empty install directory, and the temporary backup.
- `scripts/test-desktop-install.mjs`: scoped registry cleanup to this run's unique test key and added opt-in preservation of the temporary directory for debugging.
- `scripts/test-core-dist.mjs`: asserts the current API-only SEA contract, checks resource trees contain no product HTML, and registers child-process exit listeners before killing processes.
- This file records the verified repository snapshot and test boundaries.

Only these three code/test files and `PROJECT_STATE.md` are candidates for this local commit. Pre-existing untracked paths remain excluded. Do not push.

### Next stage entry

Recommended: roadmap D1 Foundation / `TASK-D1-001`, first inventorying configuration readers/writers, data paths, sensitive fields, and callers, then defining the smallest backward-compatible Unified Config Service boundary. Do not start Persistent Task v1, Context Rollover, or Agent Handoff runtime until the user explicitly lifts the existing deferral. Candidate product order after that: Chat, Memory, Workspace security boundary, then AgentProvider, each with its own verifiable loop.

---

> 状态日期：2026-10-04  
> 仓库：`chx6418-source/whalebridge`  
> 产品名称：`CetaMesh`  
> 当前基线：`main@05a6c991c980ff951ea5f357699c657eb0b4c629`（D0 基线复验 + installer 栈溢出修复；本文件更新在其后的 docs 提交中）  
> 范围：**Desktop / Windows only**。Mobile 已独立到 `chx6418-source/cetamesh-mobile`，本文件不记录 Mobile 具体实现。

---

## 阶段 01 审计 — 2026-10-04（真实状态审计，基线 `main@d35dbfe`）

本节是「阶段 01：CetaMesh Desktop 真实状态审计」的产物，方法为打开实际代码取证（grep / 读文件 / 实跑测试），不按名字判断。它不重复上方快照，只补充证据位置与增量结论。v1 交付检查表见 `docs/desktop/DESKTOP_V1_PLAN.md`。

### 能力矩阵（17 项，证据为本机源码）

| 能力 | 标签 | 证据（file:line 为 2026-10-04 实测） |
| --- | --- | --- |
| Chat | PARTIAL | QQ↔DSH 桥接聊天全链路在 `src/bridge.js`（10003 行）；桌面 Chat 产品页不存在（`cdb3bd8` 已弃、`34b321d` revert）；`public/console.html`（324KB）为旧 Web 控制台遗留，发行构建不打包 |
| Session | IMPLEMENTED | QQ 会话↔DSH 会话映射 `state/sessions.json`（`bridge.js:120,624`）；DSH session API（`src/dsh-client.js:7-8` 端点速查） |
| Model Provider | PARTIAL | 模型目录/默认模型/preset 绑定（control 28 方法中 model.*/preset.*）；`settings/describe`×8、`selectModel`×4 实际调用；无通用 ModelProvider 抽象、无独立凭据库 |
| DSH | IMPLEMENTED | `src/dsh-client.js`：session/create\|prompt\|cancel\|list、selectModel、workspace/create\|rename\|list\|reset\|archiveSession、settings/describe、agentPresets/list、`$events/result`、remote.mux WS follow |
| Agent | PARTIAL | whale-chat / whale-chat-v2 preset + 角色注入 + `dsh/agent-presets/*/qq-tool-restrict.mjs` 工具收敛；**无 AgentProvider 抽象**（grep 0 命中） |
| Task | PARTIAL | 仅内部 service task；Persistent Task 无任何实现（grep 0）；**BLOCKED（所有者冻结）** |
| Memory | PARTIAL | `qq_memory_append/query/remove/clear`（`bridge.js:4992-5111`，socialV2 存储 + `v2ToolEnabled('memory')` 会话令牌门）；无统一 Memory Runtime、无跨会话/任务记忆 |
| Workspace | PARTIAL | DSH 侧 workspace API（create/rename/list/reset/archiveSession）；无 CetaMesh 自有文件安全边界 |
| Capability | MISSING | 无 Registry/Permission 引擎（grep 0）；未知能力默认拒绝的原则只在旧模块局部成立 |
| Approval | IMPLEMENTED | legacy 队列：`pending.list/decide`（`control-service.js:31-32,150-206`）+ ask_user 转发 + 风险卡逐次审批（`state/social-v2-cards.json`） |
| Security | IMPLEMENTED | 双令牌分离（`src/bridge-privilege.js` 收敛式白名单）、回复审计硬拦截（`src/sensitive.js`）、SSRF 防护（`src/safe-fetch.js`）、发送强制白名单；安全默认 `allowAllWhenEmpty=false` / `snowluma.allowProcessControl=false` / `socialV2.tools.clickCardButton=false`（源码证实） |
| IPC | IMPLEMENTED | `src/control/ipc-protocol.js` v1（4 字节长度前缀 JSON、1MiB 帧、30s 超时、结构化错误）；`control.execute` 28 方法白名单 + `core.ping`；事件仅 `core.ready` |
| Named Pipe | IMPLEMENTED | `desktop-shell/src/ipc_client.rs` + `supervisor.rs` + `core_launch.rs`；shell smoke PASS |
| Installer | IMPLEMENTED | `installer.rs` / `install_cli.rs` / `migrate.rs` / `native_installer_ui.rs`；安装/升级/修复/迁移/卸载/重装全生命周期测试 PASS |
| Update | MISSING | 无任何自动更新机制（auto-update/checkForUpdate grep 0）；仅有重装/修复路径 |
| QQ / Channel | IMPLEMENTED | SnowLuma OneBot v11 + `mcp-snowluma-safe/host` + 卡片风险审批；定位为 Channel Adapter，非 Core 中心 |
| Plugin | PARTIAL | DSH 侧 `plugins/whale-mode-console`（已跟踪）；桌面插件系统仅存在于**未跟踪草稿**（`src/desktop-plugin-*.js` 等），不作为已有能力 |

### 6 项“是否真有 Runtime”的确认

`AgentProvider` / `PersistentTask` / `rollover` / `handoff` / `Checkpoint` / `CapabilityRegistry` 在 `src/` 与 `desktop-shell/src/` 中 **grep 全部 0 命中**。Workspace 安全边界与统一 Memory Runtime 同样无 runtime。相关设计只存在于 `docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md` 与 roadmap（PLANNED，非实现）。Context Rollover / Agent Handoff / Persistent Task 运行时：**BLOCKED（所有者冻结）**。

### 旧四模式现存位置（只记录，本阶段不重构）

`chat` / `closed-agent` / `reserved` / `reserved2` 出现于：`src/bridge.js`(14 处)、`src/control/control-service.js`(3)、`desktop-shell/src/native_ui.rs`(5)、`README.md`(2)、`RULES.md`(2)。处置属 workplan TASK-D7-001，reserved* 去留需所有者决策。

### 代码与旧文档的不一致（增量补充）

- `AGENT_CONTEXT.md`（116KB，09-22）：WhaleBridge/QQ 时代内容；其“多智能体协作唯一事实源”自我定位已过时。**历史参考地位**（详见第 17 节）：`PROJECT_STATE.md` = 当前状态入口；`AGENT_CONTEXT.md` = WhaleBridge 历史实现资料。保留，不删除。
- `README.md` / `RULES.md` / `config.example.json`：品牌与结构仍是 WhaleBridge QQ 桥（与代码一致，但产品名已定 CetaMesh；全仓改名被 workplan 规则 13 明确暂缓）。
- `desktop-shell/README.md`：Tauri/WebView 描述为历史段落（文件头已注明以 Cargo/native_main.rs 为准）。
- `docs/DESKTOP_APP.md` / `DESKTOP_ACCEPTANCE.md`（09-23）：未反映 10-04 的 D0 复验与缺陷修复。
- roadmap / continuity spec：**规划文档，不构成实现证据**（上方快照已声明，此处重申）。
- `AGENTS.md` 不存在。

### 本阶段测试结果（2026-10-04 本机实跑，基线 `main@d35dbfe`）

| 测试 | 结果 |
| --- | --- |
| `npm run desktop:test` | PASS（62/62，含 `d35dbfe` 新增 remove-data 事务回归） |
| `npm run test-core-dist` | PASS（`d35dbfe` 改后复验） |
| `npm run test-desktop-install` | PASS（`d35dbfe` 改后复验） |
| `npm run test-privilege` | PASS（24/24） |
| `npm run test-core-entry` | PASS |
| `npm run test-dsh-integration` | PASS |
| `node scripts/test-control-service.mjs` | PASS |
| `node scripts/test-ipc-protocol.mjs` | PASS |
| `npm run test-desktop-shell` | PASS（视觉交互 PENDING_NATIVE_VERIFICATION） |
| `npm run self-test` | NOT_RUN_ENVIRONMENT（DSH 127.0.0.1:3080 拒绝连接，实测） |

### 技术债与风险

1. `src/bridge.js` 10003 行单体（模式/会话/审批/记忆/贴纸/TTS 混居）——D1-008 增量抽取对象，禁止一次性重写。
2. 配置系统：默认值内联于 `loadConfig()` 约 290 行 + 三个旁路读取者（`local-services.js` / `mcp-host-server.js` / `mcp-snowluma-safe.js` 执行期直读 config.json）——D1-001 统一入口待建。
3. 卸载回滚弱点仍在：data_dir 快照备份位于 data_dir 内部，中途失败触发回滚时备份会随数据目录先被删除（`d35dbfe` 回归测试只覆盖成功路径）。
4. 无自动更新通道（About/Update 缺失）。
5. 未跟踪插件草稿长期漂移：保留/删除需所有者决策（禁止 `git add -A`，提交只按文件）。
6. 本地 main 领先 origin/main 5 个提交未推送——推送时机由所有者决定。
7. 构建警告：`src/bridge.js` 重复 `collect` key、Windows SEA 注入签名警告（不阻塞，未修）。

### 推荐下一阶段

**D1 Foundation / TASK-D1-001 Unified Config Service**（入口与前置盘点见 `docs/desktop/DESKTOP_V1_PLAN.md` Stage B）。Persistent Task / Rollover / Handoff 冻结照旧。

---

## 0. 本文件用途

这是 CetaMesh Desktop 当前阶段的项目状态事实表，用于让后续 Agent / DSH / Codex / 开发者快速判断：

- 什么已经真正落到代码；
- 什么只有部分能力；
- 什么目前仅存在于设计文档；
- 哪些旧 WhaleBridge 机制仍在运行但不再代表最终产品方向；
- 下一步可以做什么；
- 当前明确**不做什么**。

本文件优先描述“当前仓库真实状态”，不把 roadmap、历史对话或架构愿景当作已完成功能。

### 事实来源优先级

当信息冲突时，按以下顺序判断：

1. 当前 `main` 中的实际代码；
2. 当前 `main` 中的自动化测试；
3. 当前正式文档；
4. `AGENT_CONTEXT.md` / 历史工作文档；
5. 旧 roadmap / 旧讨论。

项目真实状态以 **Git / 文件 / Tests / Build / Artifact** 为准，而不是 Agent 自述。

---

## 1. 当前总状态

CetaMesh Desktop 已经拥有较完整的 **Windows 原生运行、Core、安装、IPC、安全与旧 WhaleBridge/QQ 集成基础设施**。

但新的 CetaMesh 产品层：

```text
Chat
Tasks
Memory
Workspace
Agent Provider
Context Rollover
Agent Handoff
Device Mesh
```

仍处于“不完整、部分存在或仅文档规划”的状态。

因此当前 Desktop 不能描述为“CetaMesh 完整桌面产品已经完成”。

更准确的状态是：

```text
Windows Desktop 基础设施          已有较多实现
WhaleBridge / QQ / DSH 旧能力     已有较多实现
CetaMesh 新产品信息架构           未完成
Persistent Task                  未实现
通用 Workspace 安全边界           未实现完整产品闭环
通用 Memory                      未实现
统一 Agent Provider              未实现
Context Rollover Runtime         未实现
跨 Agent Handoff Runtime         未实现
```

---

## 2. 产品与仓库身份

### 已确定

- 产品名：`CetaMesh`
- 当前仓库名仍为：`whalebridge`
- 目标平台：Windows
- 主要技术栈：
  - JavaScript / TypeScript
  - Rust Desktop Shell
  - 云端模型 / Agent API
- 当前阶段不优先开源。
- 先完善产品、真机测试和真实闭环，再考虑公开生态。

### 旧名称 / 旧定位

历史名称：

- WhaleBridge
- Cetora
- WhaleMesh

旧定位曾以 QQ Bridge / 仿生聊天 / DSH + SnowLuma 控制台为中心。

这些历史能力可以继续复用，但不能再决定 CetaMesh 的核心架构。

---

## 3. 当前架构原则

### 3.1 CetaMesh Core 不绑定 QQ

QQ、Telegram、Discord、微信等应属于：

```text
Channel Adapter
```

而不是 CetaMesh Core 的入口。

### 3.2 Desktop 与 Mobile 独立

```text
CetaMesh Desktop
CetaMesh Mobile
```

是两个独立产品线 / Node。

未来可以通过 Device Mesh、Task Sync、Memory Sync、Capability 连接，但 Desktop 不依赖 Mobile，Mobile 也不是 Desktop Remote Controller。

### 3.3 Task 不等于 Agent Session

长期原则：

```text
A Task may outlive every session that worked on it.
```

目标关系：

```text
CetaMesh Task
  ├─ Agent Provider A
  │    └─ Session A1
  ├─ Agent Provider B
  │    └─ Session B1
  └─ ...
```

**注意：该原则当前主要存在于架构规划，Persistent Task Runtime 尚未实现。**

### 3.4 Workspace 是项目安全边界

长期原则：

```text
Workspace 内
→ 按 Capability + Approval 访问

Workspace 外
→ 默认禁止
```

不允许 Agent 默认获得整机文件、系统凭据、浏览器数据或任意 Shell 权限。

**注意：当前仓库还没有完成这一通用 Workspace 产品闭环。**

### 3.5 Memory 先授权，再检索

长期原则：

```text
Memory retrieval is an authorization decision
before it is a ranking problem.
```

### 3.6 Workspace reality outranks agent narrative

代码项目的真实状态优先由以下事实确定：

```text
文件
Git
Test
Build
Artifact
```

---

## 4. 已实现：Windows Desktop 基础设施

以下能力已经能在当前仓库代码中找到实际实现，而不是单纯 roadmap。

### 4.1 原生 Desktop Shell

当前 Desktop 已经从早期 Web 控制台方向迁移到 Windows 原生壳。

现有：

- Rust 桌面壳；
- 原生 `eframe/egui` UI；
- Core worker 生命周期管理；
- 单实例 / 进程监管；
- 崩溃后的退避重启；
- Desktop 与 Core 的 IPC；
- 安装 / 修复 / 迁移 / 卸载基础。

主要目录：

```text
desktop-shell/
src/core-entry.js
src/core-dispatch.js
src/control/
```

### 4.2 Core 打包

已有 Node SEA / bundle 相关构建链。

目标是不要求普通用户预装 Node.js。

相关脚本包括：

```text
npm run build:core
npm run desktop:build
npm run build:release
npm run test-release-candidate
```

### 4.3 Desktop ↔ Core IPC

当前已有命名管道 / 控制服务方向的实现。

管理面不应继续依赖旧 Web 控制台 HTTP token。

已有 ControlService 方法注册与固定字段投影。

### 4.4 安装与生命周期

已有：

- install
- repair
- migrate
- uninstall
- remove-data
- DSH integration setup / uninstall
- 安装归属记录
- 用户数据保留策略

### 4.5 DSH / SnowLuma 本地服务管理

已有：

- 本地服务探测；
- SnowLuma / DSH 启停；
- 路径 / 版本选择；
- 服务状态；
- DSH integration。

### 4.6 模型 / Preset / Session 管理基础

已有：

- 模型目录相关能力；
- 默认模型；
- DSH Agent Preset；
- Preset binding；
- Session 列表；
- Session phase 等既有管理能力。

注意：这些能力目前不等于新的 CetaMesh Chat / Task / Agent Provider 产品层。

---

## 5. 已实现：安全基础

### 5.1 双令牌模型

旧 Bridge 已有：

```text
console token
agent/service token
```

分离。

Agent 服务令牌只能访问收敛的数据面白名单，不能自动升级成控制面权限。

### 5.2 QQ Agent 工具收敛

旧 QQ Agent 模式已有较严格的工具和发送目标限制。

### 5.3 风险操作审批基础

现有 Desktop / Core 已有：

- pending queue；
- approval / question；
- 风险卡片审批；
- allow / reject 类能力。

这些可以为未来 CetaMesh Workspace / Agent Approval 复用，但目前还不是完整的通用 Agent 文件/命令审批系统。

---

## 6. Chat 当前状态

### 状态：**部分实现 / 产品层未完成**

已有底层：

- DSH Session；
- 模型与 Preset；
- QQ 会话；
- Session 列表与状态；
- 模型 / Agent 服务连接基础。

缺少新的 Desktop 独立 Chat 产品闭环，例如：

- 正式消息时间线；
- Composer；
- 会话创建 / 切换的成熟 UI；
- Chat 内模型切换；
- Chat / Agent 模式切换；
- Memory 注入；
- Tool 状态 UI；
- Attachment 产品体验；
- 与 Persistent Task 的明确关系。

结论：

```text
当前有“会话和模型基础”，
但还不能把它当作新的 CetaMesh Desktop Chat 已完成。
```

---

## 7. Tasks 当前状态

### 状态：**Persistent Task 尚未实现**

当前代码中存在一些内部 service task / async task 概念，但它们不是 CetaMesh Persistent Task。

当前没有完成统一的 Task 数据模型，例如：

```text
Task ID
Goal
Requirements
Status
Current Phase
Progress
Completed Work
Pending Work
Workspace
Artifacts
Decisions
Checkpoint
Acceptance Criteria
Agent History
```

也没有完成：

```text
Task 生命周期独立于 Agent Session
```

的 Runtime。

### 当前明确决定

> **现在先不开始 Persistent Task v1 构建。**

在用户明确重新启动该工作之前：

- 不创建 Task Runtime；
- 不创建 Task DB schema；
- 不重写现有 Session；
- 不引入 Multi-Agent Scheduler；
- 不因为 roadmap 已存在就自动施工。

---

## 8. Memory 当前状态

### 状态：**存在旧 QQ/social memory；通用 CetaMesh Memory 未实现**

已有旧能力包括：

```text
qq_memory_append
qq_memory_query
qq_memory_remove
qq_memory_clear
```

这些主要属于 QQ / socialV2 范围。

尚未完成统一 CetaMesh Memory：

```text
工作记忆
聊天记忆
长期记忆
项目记忆
人物记忆
群聊记忆
插件记忆
```

也尚未完成统一：

- Scope；
- Authorization；
- Task / Workspace 关联；
- Entity / Relation；
- Memory Association；
- Memory Pack / .cetamemory。

前期不要直接建设完整 Knowledge Graph。

---

## 9. Workspace 当前状态

### 状态：**存在 DSH workspace 相关能力，但通用 Workspace 安全产品未完成**

现有代码和 DSH API 中存在 `workspace/*` 能力。

但当前还没有完成统一 CetaMesh Workspace：

```text
Owner 创建 / 选择 Workspace
↓
明确根目录
↓
所有 Agent 文件访问在根目录内解析
↓
越界访问默认拒绝
↓
高风险操作进入审批
↓
Task / Agent Session / Artifact 均引用 Workspace ID
```

因此现在不能把 DSH workspace 直接等同于最终 CetaMesh Workspace。

---

## 10. Agent Provider 当前状态

> 更新（2026-10-04，阶段 06）：统一 AgentProvider 抽象**已落地**（`src/agent/`，DSH 为首个
> Provider，`agent.*` 方法族 + Chat 可选执行方式）。本节下方"未实现"描述指抽象落地前的状态，
> 保留作为 DSH 集成能力清单。

### 状态：**DSH 集成存在；统一 AgentProvider 抽象未实现**

当前已经有较深的 DSH 集成。

`src/dsh-client.js` 已知 DSH API 能力包括：

```text
session/create
prompt
selectModel
list
cancel
follow
workspace/create
workspace/rename
workspace/delete
...
```

但还没有统一的 CetaMesh Agent Provider 接口，例如：

```text
createSession
send
cancel
status
contextUsage
checkpoint
resume
handoff
capabilities
```

所以当前关系更接近：

```text
CetaMesh / WhaleBridge
   ↓
DSH integration
```

而不是：

```text
CetaMesh
   ↓
AgentProvider
   ├─ DSH
   ├─ Codex
   ├─ Claude Code
   └─ ...
```

---

## 11. Context Rollover 当前状态

### 状态：**架构文档已存在；Runtime 未实现**

已有正式规划：

```text
docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
```

目标流程：

```text
上下文接近阈值
↓
完成当前原子步骤
↓
Checkpoint
↓
Handoff Summary
↓
新 Session
↓
继续同一个 Task
```

但当前代码搜索未发现完整产品 Runtime。

因此：

```text
Context Rollover = planned, not implemented
```

不能在产品状态中标记为完成。

---

## 12. Agent Handoff 当前状态

### 状态：**架构规划存在；Runtime 未实现**

目标 Handoff Packet 应至少能描述：

```text
Task ID
Goal
Current Phase
Completed
Pending
Important Decisions
Known Problems
Relevant Files
Modified Files
Git State
Tests
Artifacts
Memory References
Next Action
Acceptance Criteria
```

代码项目还应包含：

```text
Branch
Commit SHA
Uncommitted Changes
Build Status
Test Status
Known Failures
```

当前没有完整落地。

---

## 13. 旧运行模式状态

当前代码仍明确存在：

```text
chat
closed-agent
reserved
reserved2
```

主要可在以下位置看到：

```text
src/control/control-service.js
desktop-shell/src/native_ui.rs
RULES.md
```

### 新方向

已确定：

- `reserved`：未来删除；
- `reserved2`：未来重命名，不作为最终产品术语；
- `closed-agent`：未来应按受控场景重新拆分；
- 不应让旧模式体系决定新的 CetaMesh 产品架构。

### 当前处理原则

暂不因为命名旧就立即大规模重写。

等新的 Chat / Task / Workspace / Agent Provider 边界明确后，再做迁移，降低回归风险。

---

## 14. Plugin 当前状态

### 已有

仓库已有：

```text
plugins/
MCP integrations
DSH plugin/preset integration
```

### 尚未完成

新的通用 CetaMesh Plugin Runtime / Registry / Marketplace 尚未完成。

当前阶段不要建设大型 Marketplace。

优先方向仍应是：

```text
Local Import
Manifest
Permission Review
Enable / Disable
Security Boundary
```

---

## 15. Channel / QQ 当前状态

QQ 已有较丰富历史能力，包括：

- OneBot / SnowLuma；
- 群聊 / 私聊；
- 卡片；
- 图片；
- 文件 / Sticker 等部分能力；
- socialV2；
- 安全发送白名单；
- Agent safe MCP。

但新的架构定位必须保持：

```text
QQ = Channel Adapter
```

而不是：

```text
QQ = CetaMesh Core
```

未来 Telegram / Discord / 微信等也应遵循 Adapter 模式。

---

## 16. UI 当前状态

当前原生 Desktop UI 已能承载不少管理功能，但整体仍偏：

```text
运行管理 / 配置 / WhaleBridge 控制台迁移
```

而不是最终：

```text
Chat
Tasks
Memory
Workspace
```

产品信息架构。

曾经存在的十主题、Logo 等视觉任务不应优先于产品闭环。

Logo 当前不继续设计。

---

## 17. 文档状态

### 当前正式 / 有价值文档

```text
docs/DESKTOP_APP.md
docs/DESKTOP_ACCEPTANCE.md
docs/DSH_SETUP.md
docs/PROJECT_GUIDE.md
docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md
```

### 历史文档

`AGENT_CONTEXT.md` 包含大量真实历史实施细节，仍有参考价值。

但它原本定义自己为“多智能体协作唯一事实源”，这个定位已经过时。

从本文件建立后：

```text
PROJECT_STATE.md
= 当前 Desktop 状态入口

AGENT_CONTEXT.md
= WhaleBridge 历史实现与旧 UI / QQ 细节资料
```

### Mobile 文档

仓库中仍存在旧：

```text
docs/roadmap/CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md
```

它属于历史时期 Desktop/Mobile 共仓的遗留文档。

当前 Mobile 已独立，不应继续在 Desktop 仓库中更新 Mobile 实现内容。

是否后续迁移 / 删除该历史文档，需要单独决策。

---

## 18. 已知验证边界

正式 Desktop 文档记录了大量自动化测试和隔离 release candidate 验证。

这些记录证明很多基础设施曾经通过测试，但不能自动等同于：

- 当前所有真机环境都通过；
- Windows 10 / Windows 11 全覆盖；
- 新 CetaMesh 产品层已验收；
- 所有 QQ / DSH / SnowLuma 真实组合都通过；
- 新 Agent / Task / Workspace 体系已完成。

涉及发布前仍应重新跑对应测试与真机验收。

---

## 19. 当前开发纪律

后续 Desktop 开发保持：

```text
小阶段
↓
代码落盘
↓
测试
↓
Checkpoint
↓
Git Commit
↓
Push
↓
更新 PROJECT_STATE
```

避免：

```text
长时间只存在于 Agent 会话
↓
最后统一落盘
```

尤其是 Agent / Workspace / Task 相关开发。

---

## 20. 当前禁止自动扩建的内容

除非用户明确启动，否则不要自行建设：

- Persistent Task v1；
- 大型 Multi-Agent Scheduler；
- 万能 Agent Runtime；
- 完整 Knowledge Graph；
- 完整 Plugin Marketplace server；
- 大量通用 Tool；
- 全磁盘 Agent 权限；
- 无限 Shell；
- 浏览器账户 / Secret 默认访问；
- Device Mesh 大规模同步；
- Desktop 与 Mobile 重新合仓。

---

## 21. 下一阶段候选，不代表已批准施工

以下只是候选顺序，不表示可以自动开始：

```text
A. 完善 PROJECT_STATE / 文档事实源
B. 核对 Desktop 原生 UI 与新产品导航的差距
C. 核对 Chat 独立产品闭环
D. 核对 Workspace 安全边界
E. 统一 Agent Provider 设计
F. Persistent Task v1
G. Context Rollover
H. 跨 Provider Handoff
```

当前用户已经明确：

> **先不开始 Persistent Task v1 构建。**

所以 F 以及依赖它的 G / H 不应自行启动。

---

## 22. 当前推荐读取顺序

新的 Agent 接手 Desktop 时建议按以下顺序：

```text
1. PROJECT_STATE.md
2. RULES.md
3. docs/DESKTOP_APP.md
4. docs/DESKTOP_ACCEPTANCE.md
5. docs/PROJECT_GUIDE.md
6. docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md
7. AGENT_CONTEXT.md（只用于历史细节）
8. roadmap（用于方向，不用于判断“已经实现”）
```

开始代码任务前必须再检查：

```text
git main HEAD
recent commits
target files
tests
current branch
```

不要只依赖本文档的日期状态。

---

## 23. 当前一句话状态

> **CetaMesh Desktop 已拥有较成熟的 Windows 原生运行、Core、DSH/QQ 集成与安全基础，但新的 CetaMesh Chat / Persistent Task / Memory / Workspace / Agent Provider / Context Rollover 产品层仍未完成；当前先整理真实状态，不启动 Persistent Task v1。**

---

## 24. 2026-10-04 本机基线验证记录（TASK-D0-001 / D0-002）

范围：Windows 10（10.0.22631 x64）开发机，`D:\GIT-QQ-BRIDGE`，分支 `main`。验证基线：`main@05a6c99`（本文件在其后的提交中更新）。

### 已验证（PASS）

| 测试 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test-privilege` | PASS | 24/24；运行中桥接的端到端部分由脚本自动跳过（本机桥接未运行） |
| `npm run test-core-entry` | PASS | worker + 五个 MCP 模式 |
| `npm run test-dsh-integration` | PASS | 隔离沙箱；真实 `~/.dsh` 字节级未触碰 |
| `npm run desktop:check` | PASS | cargo check 无警告错误 |
| `npm run desktop:test` | PASS | 61/61 |
| `npm run test-desktop-supervisor` | PASS | 孤儿守卫 / restart / shutdown 契约 |
| `npm run test-desktop-shell` | PASS | 首跑 FAIL 是 `target/debug` 旧 exe（09-22）与 09-23 源码不匹配；重建后通过 |
| `npm run test-desktop-install` | PASS | 先修复下述 P1 缺陷后全生命周期通过 |
| `npm run test-core-dist` | PASS | 无系统 Node 参与 |
| `npm run build:core` + `build:release` + `test-release-candidate` | PASS | 中文+空格路径 / 无系统 Node / 只读安装目录 / 崩溃恢复 / 单实例 / 孤儿守卫 / 卸载保留数据 |

### NOT_RUN_ENVIRONMENT

- `npm run self-test`：需要运行中的 DSH（`127.0.0.1:3080`），本机未启动（ECONNREFUSED）。真实模型链路仍未验证，不得记为 PASS。

### D0 期间发现并修复

- **P1：`--uninstall --remove-data` 必现栈溢出（0xC00000FD）**。备份目录建在 `data_dir/.whalebridge-backup/<stamp>/` 内部，而卸载计划对 `data_dir` 本身做快照，`snapshot_path → copy_dir` 的复制源包含复制目标，无限递归（并伴随备份树指数复制、磁盘占满风险）。修复：`copy_dir_excluding` 在快照复制时排除备份子树（`installer.rs`）。修复后 `test-desktop-install` 全生命周期 PASS。
- **已知遗留（未修，D1 候选）**：回滚路径中 `data_dir` 的快照备份位于 `data_dir` 内部——若卸载中途失败触发回滚，`remove_path(data_dir)` 会先删掉备份导致恢复不完整。需要把备份目录设计到被删树之外（涉及备份位置契约，非本阶段范围）。

### 基线清点结论（对照正文其余章节）

- 正文的架构 / 入口 / 安全默认描述与本机代码一致，无需改写；本节仅补充日期化验证记录。
- 安全红线复验：`test-privilege`（双令牌收敛）、RC 测试断言（HTTP console-token 管理调用被拒、根路径仅 JSON、PATH 无 node）均通过。
- `dist/core`、`dist/app` 已从当前源码重建；旧产物（09-21/22，缺 `noWebUi` 标记）曾让 `test-release-candidate` 首跑 FAIL——**产物过期会伪装成回归，先核对 `builtAt` 再下结论**。

### 历史事实（防止重复踩坑）

- 2026-10-04 17:47 的提交 `cdb3bd8`（native desktop chat loop）已于当日 18:00 被 reset 主动放弃；所有者已确认该方向作废：桌面 Chat 闭环（`src/desktop-chat-service.js`、`chat.*` IPC、`native_ui.rs` 对话页）与 desktop-utilities 插件接线（`--plugins` CLI、`mcp-cetamesh-desktop` 注册）均**不得恢复重建**。当日曾有一次错误恢复（`d632720`），已用 `34b321d` revert 撤销。
- 工作区存在未跟踪文件：`src/desktop-plugin-host.js`、`src/desktop-plugin-storage.js`、`src/mcp-desktop-utilities.js`、`plugins/cetamesh-*`、`scripts/test-desktop-plugin-*.mjs`、`desktop-shell/native-spike/`、`output/`。这些文件**保留原样：不接线、不引用、不删除、不作为开发基础**；其存在不代表已批准的产品方向。
- Persistent Task v1 等禁扩建清单照旧（见第 20 节）。

### 下一阶段入口

- D1 Foundation → **TASK-D1-001 Unified Config Service**（`src/config/`：Zod schema + 旧 config 迁移 + 损坏 fail-closed；验证 `test-core-entry` / `test-privilege` / `self-test`）。尚未开工。

---

## 阶段 03 — 产品级 Desktop Chat（2026-10-04）

目标：Chat 成为核心产品页面（对话列表 / 对话区 / Composer / 弱化配置），不再是管理控制台附属模块。实现为全新的 `src/desktop/chat-service.js` + `desktop-shell/src/chat_ui.rs`（未复用已弃用的 cdb3bd8 代码路径）。

### 已完成

- **ChatRuntime**（`src/desktop/chat-service.js`）：多会话（创建/重命名/归档/删除/列表）、每会话配置（provider=dsh、model、reasoning off|low|high|max、mode chat|smart）、回合状态机（streaming → done/cancelled/error）、流式（assistant/chunk 增量 + assistant/message 校准 + turn/end 定稿，不翻倍）、停止（session/cancel → cancelled，丢弃 DSH 会话隔离迟到事件）、重试（尾部 user 消息重发，不重复落盘）、继续（"继续"新回合）、usage 仅透传事件真实回传（缺失即 null，UI 显示"未知"，禁止伪造）、本地持久化 `state/desktop-chat/`（sessions.json + history/<id>.json）、防护（TURN_BUSY / 参数校验 / 附件 256K×8 上限）。
- **IPC 白名单**（`src/control/ipc-protocol.js`）：`chat.*`（与并行会话的 memory.* / task.* 融合）方法族经协议层放行、二级白名单在 chat-service。
- **接线**（`src/bridge.js`）：worker 内创建 ChatRuntime，dispatch 按 `chat.` 前缀分流；复用既有 DSH 客户端与 `model.catalog.list`（不造第二套 Provider Runtime）。
- **原生 UI**（`desktop-shell/src/chat_ui.rs` + `native_ui.rs` show_chat_page）：产品 Chat 页（导航第一位、默认页），会话下拉管理、消息流（user/assistant 帧、流式光标、错误/停止态、复制、usage 行）、Composer（多行、Enter 发送 Shift+Enter 换行、拖入文本文件作附件）、次级配置行（模型/reasoning/mode 下拉，Provider 只读显示）——工程配置不占页面中心。

### 已验证（本机实跑）

- `node scripts/test-desktop-chat-product.mjs`：**PASS（11 组）**——CRUD、发送+流式+usage 透传、usage 未知为 null、停止+partial+DSH 会话重置、异常 Provider+ECONNREFUSED+retry 恢复、空/异常模型目录不伪造、切换模型即时 selectModel、长输出 20×500 字完整定稿、重启后历史完整、TURN_BUSY/continue/参数校验、turn 异常结束 partial 落盘。
- `cargo test`：**PASS（73/73，含 chat_ui 2 项解析测试）**；`cargo check` 通过（并行会话的 memory/task 模块同树共存编译）。
- 回归：`test-core-entry` / `test-ipc-protocol` / `test-control-service` / `test-dsh-integration` 全 PASS。

### 未验证

- 真实 DSH 模型会话（self-test 仍 NOT_RUN_ENVIRONMENT，DSH 未运行）——真机发送/流式/停止/切换模型的端到端待人工验收（PENDING_NATIVE_VERIFICATION）。
- 原生窗口的视觉与交互（布局、滚动、拖拽手感）待人工确认。

### 已知问题 / 限制

- Smart 模式初期为会话元数据标注（工具面与 Chat 相同——DSH profile 既有的安全 MCP 工具，如 web-search-safe）；真正的能力网关待 D1-004/005 Capability/Permission。
- 会话独占假设：与 DSH 网页端并发使用同一会话时事件可能混流。
- 附件仅支持文本文件（拖拽入口）；图片附件待后续（DSH content 已支持 image block，链路未接）。
- Core 重启时在途回合无 interrupted 标记（历史如实归位为 awaiting-reply，可重试，不自动重发）。
- 本提交只含 Chat 自有文件与状态记录；`bridge.js` / `ipc-protocol.js` / `native_ui.rs` / `native_main.rs` 因与并行阶段 04（Memory）/07（Task）会话共享编辑，接线随其合并提交落库（当前工作树已验证全部编译与测试）。

### 下一阶段入口

- 真机人工验收桌面 Chat（启动 DSH → 原生窗口全验收项）→ D1-004 Capability Registry。Persistent Task 由并行会话按其阶段指令处理。

---

## 阶段 09 — Context Rollover 与 Agent Handoff（2026-10-04）

目标：长 Task 不依赖单个 Agent Session 上下文永久存在。实现为 `src/continuity/`（types/provider/monitor/runtime/service），构建在 Task Runtime（阶段 07）之上。

### 已完成

- **Context Monitor**（`monitor.js`）：per-session 使用跟踪；真实 usage（inputTokens/outputTokens）优先标记 `source:'usage'`，缺失时按字符估算（chars/token，标记 `estimated:true`）——不伪造真实数字。阈值带对齐 Continuity spec 第 5 节：normal<70 / prepare 70-78 / ready 78-85 / rollover 85-90 / forced 90-92 / emergency 92+，policy 可配置（单字段更新自动联动收敛 prepare<=rollover<=forced）。
- **AgentProvider 抽象**（`provider.js`）：注册表 + 接口（createContextSession/sendPrompt/cancel/archiveSession/estimateTokens）；DSH 为当前唯一实现（复用 worker 既有 NodeApiClient，不建第二套通道）；`archiveSession` 如实报告 DSH 无单会话归档端点（supported:false），由 detach+不复用实现"结束旧会话"语义。跨 Provider Handoff 走同一注册表，未来 Provider 零改动接入。
- **Handoff Packet**（`types.js` normalizePacket）：结构化字段齐全——taskId/goal/requirements/currentPhase/completedWork/pendingWork/decisions/workspace/relevantFiles/artifacts/checkpoint/acceptanceCriteria/previousAgent/reasonForHandoff；Coding 扩展段（branch/headSha/gitStatus/gitDiffSummary/testsRun/buildStatus/knownFailures）由调用方提供真实事实，缺失即 null/空数组，绝不编造。packet 按 sequence 递增落盘（state/continuity/handoff/<taskId>/）。
- **Rollover 编排**（`runtime.js`）：evaluate（none/checkpoint/rollover 三态）→ rollover（安全点检查钩子 canRollover → build packet → Task Checkpoint 落库 → cancel+archive 旧会话 → detachAgent → 新 Provider Session + 结构化 bootstrap（"不要重做已完成工作/从这里继续"，不携带聊天历史）→ attachAgent——**Task ID 不变** → rollover 历史落盘 + monitor 重置）。防重复执行：同 task 串行互斥（ROLLOVER_IN_FLIGHT）+ sequence 递增 + agentHistory 完整链。
- **IPC**：`continuity.*` 方法族（status/policy/context.record/evaluate/rollover/packet/history/providers），经 Named Pipe 白名单透传，错误 code 原样回传。

### 已验证（本机实跑）

- `node scripts/test-continuity-rollover.mjs`：**PASS（6 组）**——阈值带（70% 只 checkpoint 不切换）、模拟低阈值强制 rollover 后 Task ID/Workspace/Progress/completedWork/pendingWork/decisions/artifacts 全保留、新 Session bootstrap 含结构化恢复且明示不重做、并发互斥防重复执行、跨 Provider Handoff（alpha→beta）+ 未注册 Provider 明确拒绝、canRollover 不安全点拒绝、usage 与估算来源区分、policy 白名单。
- 回归：`test-ipc-protocol`（含 continuity 透传新用例）PASS、`test-core-entry` PASS、`test-task-runtime` PASS、`test-memory-runtime` PASS、`test-privilege` 24/24 PASS、`desktop:check` 通过（全树含并行会话改动编译）。

### 未验证 / 已知限制

- 真实 DSH 多轮长任务的端到端 rollover（DSH 未运行；fixture provider 验收）。bootstrap prompt 的模型实际执行效果待真机人工验收。
- 自动触发器未接入回合机：chat/task 回合结束 hook（context.record + evaluate 自动 rollover）为下一步；当前 rollover 由显式 API 触发（测试用低阈值模拟强制触发）。
- Workspace Reconciliation（D6-009）待 Workspace Runtime（D1-006 只建模）；packet 的 workspace facts 当前由调用方提供，文件级事实收集待 Workspace Runtime。
- `bridge.js` / `ipc-protocol.js` 的 continuity 接线与并行会话的 ext/mesh/channel 改动交织，随其合并提交落库（当前工作树已验证编译与全部测试）。

### 下一阶段入口

- 回合机 hook：chat-service 回合结束处上报 context.record 并在 rollover 带自动触发安全 rollover → D6-009 Workspace Reconciliation（依赖 Workspace Runtime）→ Work UI 上下文控制条（D6-013）。

## 最新进度：阶段 02 Desktop 产品外壳（2026-10-04）

### 基线与提交

- 阶段开始时仓库为 `main@ce46175`。并行工作期间共享分支前进至 `202df3b`；本轮最终验证以当时的 `main@202df3b` 源码为准，未回退或覆盖后来提交。
- 本阶段第一版状态记录先随本地提交 `202df3b` 进入历史，当时阶段 02 源码尚未提交。本阶段 `feat(desktop): establish CetaMesh product shell` 提交将收束阶段 02 源码、测试和本次更正后的状态记录；未推送远端。
- 共享工作区仍有阶段外的修改。本阶段仅提交桌面 Shell、安装器品牌、对应测试和 `PROJECT_STATE.md`；其它已修改或未跟踪文件保持原样，未暂存。

### 已完成

- 新增 `desktop-shell/src/app_shell.rs`：集中定义 Chat / Tasks / Memory / Workspace 主导航、Settings / Diagnostics / Advanced 次级导航、`NavigationState` 与旧管理页映射。
- `native_ui.rs` 建立统一侧边栏、顶部标题/Core 状态区、次级页内导航和真实页面路由。Chat、Tasks、Memory 接入现有页面；Workspace 是明确标注能力边界的占位页。Overview、Runtime、本地服务、Security、Logs 等旧管理功能保留并移入次级区域。
- 统一间距、标题层级、卡片与按钮样式，并提供加载、错误和空内容提示；主视觉不再使用大面积深蓝按钮。
- 桌面窗口、安装器标题与安装器可见品牌更新为 CetaMesh；开始菜单/桌面快捷方式采用 CetaMesh 名称，并迁移清理旧品牌快捷方式。原有 `WhaleBridge.exe`、Core 文件名、IPC/环境变量和卸载注册表路径作为内部兼容名称保留。

### 验证结果（本机 Windows）

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `cargo check --offline --manifest-path desktop-shell/Cargo.toml` | `PASS` | 成功；有 Chat/Task/Mesh 未使用字段警告。 |
| `cargo test --offline --manifest-path desktop-shell/Cargo.toml` | `PASS` | 76 passed，0 failed；包含新增导航路由测试。 |
| `cargo build --offline --manifest-path desktop-shell/Cargo.toml` | `PASS` | 原生 Desktop 可执行文件成功构建；有未使用字段警告。 |
| `npm run test-core-entry` | `PASS` | Core worker 与 MCP 入口检查通过。 |
| `npm run test-desktop-supervisor` | `PASS` | 孤儿回收、重启、关闭契约通过。 |
| `npm run test-desktop-shell` | `PASS` | IPC、重启、优雅退出及 GUI 本地冒烟通过；创建原生窗口并读取到标题 `CetaMesh`，Core IPC ready。测试结束无残留进程。 |
| `npm run test-desktop-install` | `PASS` | 新装、升级、修复、迁移、卸载、保留数据与重装全流程通过（沙箱目录）。 |
| `npm run test-system` | `PASS` | Settings / About / Update / Diagnostics / 脱敏验收，102 项通过。 |
| `node scripts/test-desktop-chat-product.mjs` | `PASS` | 11 组通过。 |
| `node scripts/test-memory-runtime.mjs` | `PASS` | 85 项通过。 |
| `node scripts/test-task-runtime.mjs` | `PASS` | 90 项通过。 |
| `git diff --check` | `PASS` | 无空白错误；仅有 Git 行尾转换提示。 |
| 原生 UI 手工视觉/逐项导航交互验收 | `PENDING_NATIVE_VERIFICATION` | 自动冒烟已启动新构建并验证窗口标题与 IPC；尚未完成人工视觉检查。 |

### 已知问题与下一步

- Workspace 页面当前只说明安全边界尚未实现，不提供文件访问能力；不能把占位页视为 Workspace Runtime。
- Chat/Task/Mesh 编译有少量未使用字段警告；不影响当前 check、test 或 build 结果。
- 下一步先完成人工视觉检查（侧边导航、次级页面、窗口尺寸与交互），再按后续已授权阶段推进 Workspace 安全边界。不要据本阶段记录宣称 Persistent Task、Capability 或 Workspace 全部完成。
