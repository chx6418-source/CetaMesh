# INSTALLER_PRODUCTIZATION_REPORT — CetaMesh Windows Installer 产品化

**日期：** 2026-10-11（上线冲刺 · Windows Installer Productization）
**分支：** `feature/installer-productization-v1`
**范围红线（遵守）：** 未改动 Model Runtime / Agent Runtime / Task / Memory / Capability Broker / Device Mesh / Extension Runtime / 主题业务逻辑 / Chat 产品逻辑；未重写安装系统（计划 / 快照 / 回滚 / 清单引擎保持原样）；未更换安装技术栈（继续使用自研 egui 安装器 + IExpress 单文件包装）；未 push。

## 1. Git 基线与最终版本

| 项 | 值 |
| --- | --- |
| Base HEAD | `371a76c`（本地 `main`：`docs(state): 记录 UI v1 合并完成与工作分支清理`） |
| 最终源码 HEAD | `3214370`（5 个提交，见 §13；本报告提交另计） |
| 分支 | `feature/installer-productization-v1`（独立 worktree，`D:\cetamesh-wt\installer-productization`） |

## 2. Before / After：安装流程与体验

**Before（工程样品形态）** —— 单页面板：

```
CetaMesh  |  Windows 原生安装向导
[安装设置]
  安装位置（可修改）：[________________________]      ← 只能手工复制完整路径
  数据目录（monospace 原始路径）
  [状态行]
[安装进度]  ← 原始 CLI 输出行滚动显示（spawn 输出 / 路径细节）
[错误：一行红字]
[退出] [立即安装]        →  [确认安装 modal]  →  安装
```

问题：工程面板观感；无浏览按钮（必须复制粘贴路径）；无版本/已安装信息；进度是原始输出流；错误只有一行文字；无阶段、无诊断导出。

**After（正式安装体验）** —— 单窗口分步向导：

```
┌───────────────────────────────────────────────┐
│ CetaMesh  Intelligent Collaboration   第 2 步 / 共 4 步 │
│ 连接模型、Agent、工具、记忆和设备的智能协作网络          │
│ 欢迎 › 安装位置 › 安装选项 › 安装                        │
│                                               │
│  [当前步骤卡片]                                 │
│                                               │
│                      [后退] [取消] [继续]        │
└───────────────────────────────────────────────┘
```

| 步骤 | 内容 |
| --- | --- |
| 1 欢迎 | 全新安装：`CetaMesh <版本>` + 简介 + 安装体积 + 支持 Windows 10/11 x64 + 免管理员说明；**升级**：`更新 CetaMesh <新版本>` + 当前版本 + 即将更新版本 + 既有安装位置 + “保留个人数据”说明 |
| 2 安装位置 | `安装到：[路径输入] [浏览…]` + 即时校验（✓ 可以安装 / ⚠ 目录不可写 / ⚠ 磁盘空间不足 / ⚠ 路径无效 / ⚠ 与安装程序重叠）+ 所需空间/可用空间 + 改位置时的“不会迁移既有数据”提示 |
| 3 安装选项 | ☑ 创建桌面快捷方式　☑ 添加到开始菜单（含卸载入口，固定）　☑ 安装完成后启动 CetaMesh；折叠「高级选项」：数据目录、DSH 集成 |
| 4 安装 | 阶段清单（准备安装文件 / 安装应用文件 / 创建快捷方式 / 注册系统信息 / 完成配置，● 当前 / ✓ 已完成 / ○ 未到）+ 不确定进度条（不造假百分比）+ “正在完成安装，请勿关闭窗口” |
| 失败 | 「安装未完成」（回滚后明说“已恢复到安装前状态”）+ [重试] [查看详细信息] [复制诊断信息] [关闭] + 日志路径 |
| 5 完成 | 「CetaMesh 已安装」+ 版本 + 安装位置 + ☑ 启动 CetaMesh + [完成] |

主题：固定 **CetaMesh Setup Theme** = Paper 规范 + **强制减少动态**（`ReduceMotion::On`，无漂移/涟漪），与桌面壳正式视觉体系一致；窗口 720×560 逻辑点（min 680×520），首帧自动居中。

## 3. Folder Picker（原生文件夹选择器）

- 「浏览…」调用 **rfd 0.15（既有依赖）** 的 `pick_folder()`：Windows 上即 **IFileDialog + FOS_PICKFOLDERS** 系统对话框（不是自研浏览器、不是 WebView）。
- 在工作线程中打开，UI 不冻结；取消选择保留原值；选择后立即重新校验。
- 路径输入框始终可手工编辑（键盘可用，不依赖鼠标）。

## 4. Install Location（安装位置规则）

- 全新安装默认：**`%LOCALAPPDATA%\Programs\CetaMesh`**（per-user，免管理员 / 不触发 UAC；目录品牌为 CetaMesh）。
  命令行默认值与向导对齐（`install_cli::default_install_dir`），无法确定 LOCALAPPDATA 时退回 `%ProgramFiles%\CetaMesh`。
- **升级复用原位置**：`find_existing_install()` 依次探测 ① 注册表卸载项 `InstallLocation`（下载到任意目录的安装包也能识别既有安装）② 安装包自身所在目录 ③ 默认目录；命中必须“目录存在 + 安装清单可读”，版本以安装清单为准（注册表 DisplayVersion 兜底）。向导预填既有目录，用户不改动则原地升级。
- 兼容性不回退：中文 / 空格 / Unicode / 非 C 盘 / 长路径（引擎沿用 PathBuf 全链路；RC 回归继续覆盖中文+空格路径）。
- 数据目录名保持 `%LOCALAPPDATA%\WhaleBridge` 不变（内部兼容路径；重命名会孤立既有用户数据）。

## 5. 子进程审计：Before / After

安装路径上的**每一个控制台子系统子进程**都要 `CREATE_NO_WINDOW`，否则 GUI 安装器会给它们新开黑窗。

| 子进程 | 触发场景 | Before | After |
| --- | --- | --- | --- |
| `reg.exe` ×N（export / add / delete / query） | 卸载注册表项读写、回滚备份 | **裸启动 → 每次一个黑框** | `supervisor::hidden()` |
| `powershell.exe` ×2–3（WScript.Shell 建 .lnk） | 开始菜单 / 桌面快捷方式 | **裸启动 → 黑框** | `hidden()` + `-WindowStyle Hidden` + **30s 有界超时** |
| `WhaleBridgeCore.exe --setup-dsh` | DSH 集成注册（默认开启） | **裸启动 → 黑框**（Node SEA 是控制台程序） | `hidden()`（stdout/stderr 仍捕获进日志） |
| `powershell.exe`（Expand-Archive 展开 payload 压缩包） | 单文件安装包首次安装 | 已隐藏（`hide_console`） | 统一走 `hidden()` + `-WindowStyle Hidden`（纳入审计） |
| `WhaleBridge.exe --install`（向导驱动的安装子进程） | 向导点击“安装” | 未设标志（release 子是 GUI 子系统无黑框；debug 暴露） | `hidden()`（统一） |
| `tasklist.exe`（卸载助手等待 PID） | 安装目录内卸载 | 已 hidden | 不变 |
| `taskkill.exe /PID … /T /F`（supervisor 超时兜底） | 运行期 Core 强杀 | 已 hidden | 不变 |
| `powershell.exe`（版本化停止占用进程） | `--stop-core` | 已 hidden | 不变（向导友好关闭流程完成后作为引擎兜底） |

审计机制（新增，默认零开销）：
- `supervisor::hidden()` 在设置 `WHALEBRIDGE_INSTALLER_SPAWN_LOG` 时记录每次 spawn（program/hidden）；生产运行不写文件。
- 新回归 `scripts/test-installer-productization.mjs`：安装期间 **12/12 次 spawn 全部 `hidden=true`**（覆盖 reg.exe 与 powershell.exe）。
- 静态红线：`installer.rs / install_cli.rs / native_installer_ui.rs / migrate.rs` 中不允许出现裸 `Command::new("reg.exe"|"powershell.exe"|"cmd"|"taskkill"…)`（回归测试逐文件扫描，本轮抓出并修复了测试辅助代码里的 2 处遗留）。

## 6. Removed Shell Commands / Remaining + Why

**已消除**：
- 裸启动的 `reg.exe`（8 处）与 `powershell.exe`（快捷方式、展开）——全部改为隐藏执行。
- 快捷方式创建的无限等待——改为有界（30s）超时。
- 源码中不存在 `cmd.exe` 调用（文件复制/目录/删除/rename 全部是 Rust `std::fs`；卸载助手自删除的注释明确记录了历史上 cmd del 的转义陷阱）。

**仍然保留（均隐藏 + 无 profile + 非交互 + 有界时间）**：
| 命令 | 为什么保留 |
| --- | --- |
| `powershell.exe`（WScript.Shell 建 .lnk） | 避免为快捷方式引入 COM（IShellLink）代码路径；`--repair` 可重建 |
| `powershell.exe`（Expand-Archive） | 单文件安装包内 payload 为 ZIP；替换为 Rust 解压需引入 zip 依赖（本轮不做依赖变更） |
| `powershell.exe`（Get-CimInstance / Stop-Process） | 只按“可执行文件位于本安装目录内”精确匹配结束进程；无法用纯 Rust 无依赖实现 |
| `reg.exe` | 注册表读写；Rust 无内置注册表 API（windows-sys 需额外 feature + SAFETY 代码），本轮保持隐藏调用 |
| `tasklist.exe` / `taskkill.exe` | 既有卸载等待与 Core 兜底终止；已隐藏 |

## 7. UAC 行为与 Per-user / Machine-wide 策略

- **默认 per-user 安装**（`%LOCALAPPDATA%\Programs\CetaMesh`）：普通用户直接安装，**不触发 UAC**。
- 用户手动选择受保护目录（如 `C:\Program Files\…`）时：目录校验会先提示“目录不可写”，安装失败时给出“以管理员身份运行”的可操作提示；**绝不隐藏、绝不绕过 Windows UAC**，需要 Machine-wide 时由系统正常授权。
- 未做“自动提权重启”：避免临近上线改变既有单实例 / 数据目录语义。

## 8. Fresh Install / Upgrade / Uninstall / Rollback

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| Fresh Install | **PASS** | `test-desktop-install`（沙箱：文件/resources/数据目录/快捷方式/注册表/安装清单）+ 新套件沙箱安装 |
| Upgrade | **PASS** | `test-desktop-install`：升级识别既有版本、替换程序与 resources，config / 设置 / Memory / Tasks / Workspace metadata / Provider secrets **字节级保留**；新套件：`--detect-install` 复用既有目录（版本取自安装清单） |
| Uninstall | **PASS**（默认保留用户数据） | `test-desktop-install`：程序文件/快捷方式/注册表项清除，用户数据与配置完整保留；彻底卸载需显式 `--remove-data` |
| Rollback | **PASS** | 引擎快照回滚（既有）；新套件注入中途失败（桌面目录被文件占用）：退出码非 0、输出含“回滚”、此前删除的 Core **回到不存在状态**、数据目录无残留 |
| 运行中的应用 | 友好关闭 | 安装前检测本安装目录内进程 → 提示「CetaMesh 正在运行」[关闭并继续]/[取消] → 先发 **QuitRequest 命名事件**（应用按托盘“退出”流程优雅停止 Core 并退出）→ 20s 超时后才按路径精确强杀；引擎侧 `--stop-core` 兜底 |

## 9. High DPI 与 Accessibility

- **High DPI**：全部布局使用逻辑点 + egui 原生缩放；窗口 720×560（min 680×520）在 125% / 150% / 200% 下布局不崩（egui 自动缩放；未在本机自动化覆盖全部档位 —— 见已知限制）。
- **Accessibility**：Tab 焦点导航（egui 标准）；Enter 在欢迎/完成页推进（输入框聚焦时不拦截）；**Esc** 安全关闭（安装进行中不响应，防误触）；路径可完全用键盘编辑；错误文本高对比（Paper 规范正文对比度目标 5.5:1）；阶段状态用文字 + 符号（●/✓/○）而非仅颜色。

## 10. No-console-window Verification（回归证据）

`scripts/test-installer-productization.mjs`（已登记 `run-all-tests`，requires `shell-debug`）：

1. **运行期 spawn 审计**：真实执行一次完整安装（沙箱），`WHALEBRIDGE_INSTALLER_SPAWN_LOG` 记录 **12 次 spawn 全部 `hidden=true`**（覆盖 `reg.exe`、`powershell.exe`）。
2. **窗口枚举**：安装全程每 25ms 扫描一次可见 `ConsoleWindowClass` 顶层窗口 —— **未出现任何新的控制台窗口**（与安装前基线集合对比）。
3. **静态红线**：安装器 4 个源文件不存在裸启动控制台程序的写法。
4. **GUI 冒烟**：安装向导窗口真实启动（标题「CetaMesh 安装程序」）并可正常关闭。
5. 既有 `test-desktop-shell` 继续覆盖运行期（Core 拉起 / 重启 / 孤儿守卫）无黑窗语义；`test-desktop-install` 覆盖全生命周期。

## 11. Tests 汇总

| 项 | 结果 |
| --- | --- |
| `cargo check`（desktop:check 同源） | **PASS**（14 warnings 均为既有未使用字段/方法 + 本轮已清理 1 处） |
| `cargo test`（desktop:test 同源） | **PASS · 175 通过 / 0 失败**（含新增：既有安装发现 ×3、reg query 解析、阶段映射、目录校验 ×2、默认目录 ×2） |
| `npm test`（聚合，含新套件） | **PASS 84 · FAIL 0 · NOT_RUN_ENVIRONMENT 4**（exit 0；NOT_RUN：test-console / test-mcp-exec / test-onebot-connection / test-mcp-web-search，均为环境性如实跳过） |
| `scripts/test-installer-productization.mjs` | **PASS · 9/9**（见 §10） |
| `scripts/test-desktop-install.mjs` | **PASS**（新装/幂等/升级/修复/迁移/卸载/重装/卸载助手/彻底卸载/无残留） |
| `npm run build:release` | **PASS**（`WhaleBridge-Setup-x64.exe` 40.5 MB；禁止项 / 构建机路径 / 凭据审计通过） |
| `npm run test-release-candidate` | **PASS · 8/8**（真实单文件安装器：中文+空格路径安装 / 隔离 PATH 无系统 Node / 运行期只读安装目录 / consolePort 拒连 / 崩溃恢复 5.7s / 单实例 / 孤儿守卫 / 卸载保留用户数据） |

## 12. Known Limitations

1. **卸载仍没有 GUI**：开始菜单「卸载 CetaMesh」→ CLI 静默卸载（引擎保证默认保留用户数据；彻底删除需显式参数）。做成向导需要正确处理“卸载器自删 + 运行中进程”时序，列为后续专项（本轮不冒险改卸载入口）。
2. **IExpress 自解压窗口**：单文件安装包由 Windows IExpress 宿主解包（系统 GUI，不是控制台）；`FriendlyName` 已从「WhaleBridge Setup」改为「CetaMesh 安装程序」。
3. **PowerShell / reg.exe 仍有隐藏调用**（见 §6 理由）；彻底去 PowerShell 需要引入 COM/注册表代码路径。
4. **§37 人工验收（真实双击走一遍）** 需要有人在有交互的机器上执行：双击 Setup → 欢迎 → 浏览 → 选 `D:\应用\CetaMesh`（中文+非 C 盘）→ 安装 → 全程无黑框 → 完成 → 启动。自动化已覆盖 GUI 启动/关闭、全生命周期 CLI、无控制台窗口审计与回滚；真实鼠标/键盘路径与全部 DPI 档位为本轮未覆盖项。
5. **未签名**：沿用既有 RC 说明（首次运行仍有 Windows 信任确认）。
6. 数据目录名保持 `WhaleBridge`（内部兼容；不改名以保护既有用户数据）。

## 13. 提交记录

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `208d56a` | feat(installer): redesign CetaMesh setup experience（五步向导 / 主题 / 文件夹选择 / 校验 / 阶段进度 / 错误面板 / 友好关闭） |
| 2 | `bf22e93` | fix(installer): suppress helper consoles; reuse upgrade location; graceful quit request（hidden 统一 + spawn 审计 + [stage] 标记 + 注册表发现既有安装 + CetaMesh 默认目录 + QuitRequest 事件） |
| 3 | `5a58887` | test(installer): cover native setup release behavior（新专项套件并登记） |
| 4 | `6a283be` | fix(test): align shell suite with the single-theme (纸面) convergence |
| 5 | `3214370` | feat(installer): brand the setup experience as CetaMesh（IExpress FriendlyName + INSTALL.txt） |

> 提交 4 说明：`test-desktop-shell` 等待的「主题已应用：深色」契约在 `77353ea`（主题收敛为唯一纸面）后失效——legacy `dark` 有意回落为纸面（浅色）。该失败在基线 `371a76c` 上稳定复现（与本轮改动无关，属 main 上的既有回归）；按当前产品行为更新断言（并保留缩放/几何/元数据不变式），修复后套件通过。
