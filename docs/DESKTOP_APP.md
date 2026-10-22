# 鲸桥 WhaleBridge 桌面版 —— 架构、构建与运维

**历史兼容文档**：本页记录早期 WhaleBridge 的桌面化过程，其中旧 Web、运行时及安装指令可能已过时；当前工程与发布以 docs/desktop/ARCHITECTURE.md、docs/desktop/BUILD_AND_RELEASE.md 和 README.md 为准。

本文件原用于记录桌面版（鲸桥 WhaleBridge for Windows）的架构、进程与退出码契约、
安装/迁移/卸载、构建与发布步骤、故障排查、以及桌面化过程中的决策记录（ADR）。

面向使用者/运维者的快速上手在 [README.md](../README.md)；DSH 端安装见 [DSH_SETUP.md](DSH_SETUP.md)；
内核业务逻辑见 [PROJECT_GUIDE.md](PROJECT_GUIDE.md)。

---

## 1. 架构

```text
WhaleBridge.exe（Rust + eframe/egui 原生桌面与安装器）
  ├─ 启动并监管 Core worker（进程句柄、IPC 就绪握手、退避重启）
  ├─ 原生管理窗口 → 当前用户实例专属 Windows 命名管道
  └─ --install / --repair / --uninstall / --migrate / --installer-ui

WhaleBridgeCore.exe（Node SEA：宿主 node.exe + 注入的 bundle）
  ├─ --worker / --mcp ... / --setup-dsh / --uninstall-dsh
  ├─ 版本化 IPC：JSON 帧 + 4 字节 little-endian 长度前缀
  └─ 回环 HTTP：Agent/DSH 程序化数据 API，不承载产品 UI

resources\（只读，随 exe 分发）
  roles\ assets\ dsh\ plugins\ config.example.json product.json
```

- WhaleBridge 的产品窗口和安装向导不依赖 HTML、WebView、系统浏览器或浏览器自动化。
- Worker 的回环 HTTP 监听仍服务既有 Agent/DSH 程序 API；桌面管理流量走命名管道，
  native UI 模式下 HTTP 控制令牌会被拒绝。
- QQ、DSH、SnowLuma 都是**外部服务**；其程序化 API、OneBot/RPC/WebSocket 集成继续保留。
- 目标机器不需要安装 Node.js / Rust / 任何开发工具。原控制台的功能尚未全部迁移，见 §13。
- 开发模式与发布模式共用同一套源码与同一批测试；`src/core-dispatch.js` 是唯一 Core 分派入口。

## 2. 路径契约

| 用途 | 解析优先级 |
|---|---|
| 可写数据目录 | `--data-dir` > `WHALEBRIDGE_DATA_DIR` > exe 同目录 `portable.flag`（便携） > `%LOCALAPPDATA%\WhaleBridge` |
| 只读资源目录 | `WHALEBRIDGE_RESOURCE_DIR` > exe 同目录 `resources\` > exe 同目录 |
| 安装目录 | 显式 `--install-dir` > 安装器沿用卸载注册表中的 `InstallLocation` > `%LOCALAPPDATA%\Programs\WhaleBridge`；已安装程序的卸载/修复默认使用自身目录 |

- 源码模式（`node src/core-entry.js`）下资源根与数据根都是仓库根，行为与桌面化之前完全一致。
- **安装目录运行期只读**：配置、state、日志、令牌一律写数据目录（有测试断言安装目录逐字节不变）。
- 数据目录内容：`config.json`、`state\`（会话、模式、角色状态、令牌、锁）、`roles\`（用户角色）、
  `logs\`（`worker.log`、`desktop-shell.log`）。

## 3. 进程与退出码契约

| 退出码 | 含义 | 启动器动作 | 产生者 |
|---:|---|---|---|
| 0 | 正常结束（控制台「关闭主程序」/ 启动器要求退出） | 不重启，窗口显示"已停止"+ 托盘可重启 | `/api/shutdown`、SIGINT/SIGTERM、孤儿守卫 |
| 2 | 已有实例在运行 / 端口被占用 | 不重启，显示原因与日志路径 | 锁文件、`EADDRINUSE` |
| 10 | 请求重启 | 立即重新拉起 | `/api/restart` |
| 其它 | 异常退出 | 退避重启 5/10/20/30 秒封顶；连续 5 次后放弃并提示 | 崩溃、配置错误 |

- `start.bat` 守护循环"除 2 之外都重启"，因此退出码 10 对既有 BAT/VBS 启动方式完全透明。
- **托管模式**：桌面壳以 `WHALEBRIDGE_SUPERVISED=1` 启动 worker。此时
  1. `/api/shutdown` **不执行**"杀掉机器上所有 `start.bat` 守护循环"的全局清理
     （那会误伤用户另外用 `start.bat` 跑着的实例），只退出本进程；
  2. worker 把 stdin EOF 与父进程存活检查（每 5 秒）当作孤儿守卫，壳被强杀后自行优雅退出。
- 桌面壳只管理自己拉起的子进程句柄，**从不按进程名或命令行模糊查杀**。

## 4. Core 打包方式（Node SEA）

```text
src/core-sea.js --esbuild--> dist/core/build/core.bundle.cjs（单文件 CJS）
                --node --experimental-sea-config--> core.blob
                --postject--> dist/core/WhaleBridgeCore.exe（宿主 node.exe + 注入 blob）
resources\（public/roles/assets/dsh/plugins）外置，不嵌入 blob
```

关键约束（改动前务必读）：

1. **CJS bundle 里 `import.meta` 必须是空的**。bundle 内所有模块共享同一份 `import.meta`，
   若让它解析成 exe 自身路径，`src/bridge.js` 与五个 MCP 文件顶层的 `isMainModule` 守卫会在
   SEA 中全部成立，一次启动 bridge 加五个 MCP。因此分派在 `src/core-dispatch.js`，
   打包入口 `src/core-sea.js` 无条件调用 `runCore()`。
2. **新增依赖必须能被 esbuild 静态解析**；禁止运行期 `require(变量)` 或动态 `node_modules` 解析。
   构建脚本的 bundle 审计会把未打包的裸模块依赖直接判为失败。
3. `resources\` 里的 `product.json` 让打包后的 Core 能读到自己的版本号（安装目录里没有 package.json）。
4. 宿主 node.exe 是 Node.js 官方产物，随包再分发需要附 MIT 许可证文本
   （见 `licenses/THIRD-PARTY.md` 的"再分发前必须补齐"）。

## 5. 构建与发布

```bash
npm install
npm run build:core              # 1) Bundle + SEA → dist/core/WhaleBridgeCore.exe + resources/（默认排除产品 HTML）
npm run desktop:build           # 2) release 桌面壳（含安装器）
npm run build:release           # 3) 组装 dist/app 发布候选 + SBOM/许可证/哈希 + 发行审计
npm run test-release-candidate  # 4) 用发行包在沙箱里跑真实配置
```

`dist/app/` 结构见 [README.md](../README.md) 的「发布候选（RC）」。普通用户双击
`WhaleBridge-Setup-x64.exe`，在鲸桥风格的窗口里点击“立即安装”即可；默认安装到
首次安装默认到 `%LOCALAPPDATA%\Programs\WhaleBridge`，不需要管理员权限；检测到已有鲸桥时安装器沿用原安装位置以便升级。命令行仍可用于诊断：

```powershell
dist\app\WhaleBridge.exe --install --dry-run     # 先看计划
dist\app\WhaleBridge.exe --install               # 默认路径仍为 Program Files
dist\app\WhaleBridge.exe --install --install-dir "%LOCALAPPDATA%\Programs\WhaleBridge"
```

`npm run build:core` 的发行审计会在以下情况**直接失败**：resources 里混入 `config.json`、
`state/`、日志、`.node`/`.dll`、SnowLuma 相关文件、令牌或凭据；bundle/exe 含构建机绝对路径；
产物里出现本机真实 `config.json` 的令牌。

`npm run build:release` 另有一处**已知偏差**记录在 `release-manifest.json` 的 `knownDeviations`：
`WhaleBridge.exe` 内含构建机仓库路径字符串（Tauri/Cargo 以字符串字面量写入，`--remap-path-prefix`
与 `strip` 均无效）。正式发布建议改到 CI 的干净工作目录构建。

发布前仍待完成：版本资源、Authenticode 签名与时间戳、补齐许可证文本。正式图标已经采用
C4「浅色简洁苏打」方案，并接入应用 EXE、单文件安装器、窗口、托盘、安装向导、启动状态页和控制台。
单文件安装器由 Windows 自带 IExpress 生成；封装后、签名前由 `scripts/set-exe-icon.ps1` 写入同一组
Windows 图标资源，安装窗口由桌面壳提供，与控制台保持同一视觉风格。

## 6. DSH 集成

见 [DSH_SETUP.md](DSH_SETUP.md)。要点：

- 五个 MCP 都指向统一入口；开发模式写 `node + src/core-entry.js --mcp <mode>`，
  发布模式写 `WhaleBridgeCore.exe --mcp <mode>`。
- 归属记录在 `<DSH_HOME>\.whalebridge-integration.json`（内容哈希）：只有"由本应用安装且此后
  未被改动"的 preset 才会自动升级；用户改过的、或来源不明的一律保留并提示 `--force-presets`。
- 卸载走 `WhaleBridgeCore.exe --uninstall-dsh`：只删本应用拥有的 preset/插件副本与 MCP 条目，
  用户自建内容与改动一律保留。
- 修改集成后**必须重启 DSH** 才生效。

## 7. 安装 / 迁移 / 卸载

`WhaleBridge.exe` 同时是安装器与卸载器：

| 操作 | 命令 | 行为 |
|---|---|---|
| 安装/升级 | `--install` | 复制程序与 resources；首次生成 `config.json`；建快捷方式与卸载项；注册 DSH 集成 |
| 预演 | `--install --dry-run` | 只打印计划，不写任何文件 |
| 修复 | `--repair` | 补齐缺失/被改动的程序文件并刷新安装清单；保留数据与配置 |
| 迁移 | `--migrate --from <旧目录>` | 校验 JSON、默认不覆盖、外部工具路径只告警、旧目录保留 |
| 卸载 | `--uninstall` | 删程序/快捷方式/注册表项；**默认保留用户数据** |
| 彻底卸载 | `--uninstall --remove-data --remove-dsh-integration` | 再删数据目录并移除 DSH 集成 |

- 卸载只删除 `install-manifest.json` 记录且**内容未被改动**的文件；你放进安装目录的东西会被保留并提示。
- 从安装目录内卸载时，程序会复制自身到 `%TEMP%` 由副本完成卸载（运行中的 exe 无法删除自己），
  副本完成后自删。
- `--remove-data` 会永久删除配置、state 与令牌，且不备份。

## 8. 故障排查

| 现象 | 排查 |
|---|---|
| 窗口显示"已有实例在运行/端口被占用" | 同一数据目录只能有一个实例；确认端口是否被别的程序占用，或改用 `--data-dir` |
| 窗口显示"配置加载失败" | 数据目录下的 `config.json` 缺失或格式错误；对照 `resources\config.example.json` 修正 |
| 桥接反复异常退出 | 看 `<数据目录>\logs\worker.log` 与 `state\bridge.log`；连续 5 次后启动器会停止自动重启 |
| 关掉窗口后程序还在跑 | 这是设计行为：关闭窗口=隐藏到托盘；托盘菜单「退出」才真正结束 |
| 关掉窗口后 QQ 没反应 | 检查托盘图标（可能被折叠）；用托盘的「显示主窗口」或「重启桥接」 |
| DSH 看不到 `qq_*` 工具 | 确认已 `--setup-dsh`（或 `npm run setup:dsh`）并**重启 DSH** |
| 控制台打不开/白屏 | `whalebridge-desktop.exe --smoke-test` 可无窗口验证 Core 能否拉起与探活 |
| 想确认启动器选了哪个 Core | `whalebridge-desktop.exe --print-core-command`（debug 构建可看 stdout，release 看日志） |

诊断命令：`--print-core-command`（选路与端口）、`--smoke-test`（无窗口跑一遍拉起→就绪→停止）、
`--smoke-test --supervise-seconds N`（保持监管，便于观察重启）。

## 9. 测试矩阵

```bash
# 桌面化相关
npm run test-release-candidate   # 发行包真实配置：无 Node/中文空格路径/只读安装目录/崩溃恢复/单实例/孤儿守卫
npm run test-app-icon            # C4 源图、PNG 尺寸、9 层 ICO、安装器资源链与各界面引用
npm run test-installer-package   # IExpress 单文件载荷 + Windows 可提取的蓝青 C4 图标
npm run test-desktop-install      # 安装全生命周期（沙箱）
npm run test-desktop-shell        # 启动器进程监管（含 GUI 窗口创建）
npm run test-desktop-supervisor   # 托管 worker 契约（退出码/孤儿守卫）
npm run test-core-dist            # 发行 Core 烟测（五个 MCP stdio、worker、setup-dsh）
npm run test-dsh-integration      # DSH 集成安装/迁移/卸载
npm run test-core-entry           # 统一入口与五个 MCP 模式
npm run test-app-paths            # 路径层（含打包分支）
npm run desktop:test              # Rust 单元测试
# 业务回归
npm run test-card / test-privilege / test-local-services / test-forward /
npm run test-stickers / test-vision / test-wait / test-md
```

## 10. 决策记录（ADR）

桌面化的关键决定，按时间顺序：

| # | 决定 | 要点 |
|---|---|---|
| 1 | 采用方案 A | Windows 安装版；桥接不依赖目标机 Node；DSH/SnowLuma 外置 |
| 2 | 使用独立桌面窗口 | 不以默认浏览器为主 UI；浏览器入口保留为诊断路径 |
| 3 | Rust + Tauri/Wry + WebView2，不用 Electron | 复用现有本地控制台；体积与升级面可控 |
| 4 | 新标识与旧集成兼容 | 新装用 `whale-*`；升级识别并迁移 `qq-*`；工具名/API/state 格式不变 |
| 5 | 临时工作文档最终删除 | 有效内容转入正式文档后删除 `DESKTOP_APP_WORKPLAN.tmp.md` |
| 6 | esbuild + Node SEA，资源外置 `resources\` | 见 §4；bundle 审计失败即构建失败 |
| 7 | 打包运行时目录默认值 | 资源取 exe 同目录 `resources\`；数据取 `%LOCALAPPDATA%`；`portable.flag` 切换便携 |
| 8 | DSH 集成归属模型 | 内容哈希判定归属；绝不覆盖/删除用户内容 |
| 9 | Core 退出码契约与托管模式 | 见 §3；托管模式跳过全局守护清理 |
| 10 | 关闭窗口隐藏到托盘 | 托盘「退出」才结束；改回"关闭即退出"只需改窗口事件与文案 |
| 11 | 安装器即桌面壳自身 | 不新增二进制；`--install/--repair/--uninstall/--migrate` |
| 12 | 安装归属清单与卸载助手 | `install-manifest.json` + `%TEMP%` 副本自删 |
| 13 | 安装器不再依赖 NSIS | Windows 自带 IExpress 打包；Tauri 安装页显示鲸桥品牌界面 |
| 14 | 卸载策略 | 只删本应用拥有的内容；默认保留数据；`--remove-data` 显式删除 |

完整背景、验证记录与逐阶段实现细节保留在 `DESKTOP_APP_WORKPLAN.tmp.md`
（临时工作文档，桌面化验收全部完成后删除）。

## 11. 当前状态与未验证项

本节前述自动化验证记录属于原 Tauri/WebView2 发行基线，不代表新原生版本已经完成相同验收。
本次去网页化迁移的即时状态见 §13。

**尚未完成（必须由使用者在真实环境验收）**：

1. 真实安装到本机（写 Program Files/开始菜单/HKCU，需管理员或改用用户目录）；
2. Windows 10 x64（现有验证只在 Windows 11）；
3. 四种模式与全部 MCP 工具在真实 QQ + DSH 会话中的端到端表现；
4. 图片、文件、音频、卡片与风险审批；
5. DSH/SnowLuma 重启恢复；
6. 原生窗口的托盘/可访问性体验（当前尚无托盘实现）；
7. 版本资源、Authenticode 签名与时间戳（正式 C4 图标已完成）。

## 13. 去网页化迁移（当前状态）

本节覆盖并取代本文件较早的 Tauri/WebView2“当前架构”描述。旧页面和 Tauri 源码仅作为迁移历史留在仓库，
Cargo 的正式 binary target 明确指向 `src/native_main.rs`，不依赖 Tauri/Wry；默认 Core/release/安装器构建
过滤并审计产品 HTML。已在仓库外临时目录生成并验证 no-web release candidate；仓库中的旧 `dist/app`、`output/`
仍保留，未被这次验证覆盖。

已落地并可自动验证的边界：

- 原生 eframe/egui 主窗口与原生安装向导；桌面壳可在 Cargo 离线模式下通过 `cargo check`。
- Worker 用 `WHALEBRIDGE_UI_PIPE` 建立长度前缀 JSON IPC；壳用 `core.ready` + `core.ping` 握手决定 Ready，
  IPC 有版本号、1 MiB 帧限制、超时和响应 ID 校验。
- 管理流量使用命名管道；IPC 只接受 ControlService 内登记的方法。终端能力改为 `runtime/config/paths/services`
  四项只读诊断白名单。native UI 模式下 HTTP console token 被拒；根路径只返回 JSON，不提供网页。
- 当前原生 UI 具备概览/重启、角色 CRUD 与模式、安全通知设置、全局运行策略（模式、Owner、私聊/群 allow/deny）、
  本地 SnowLuma/DSH 服务发现/选择/安装/启停、模型目录与默认模型、Preset 列表/绑定、审批/提问与风险卡片审批队列、
  黑话配置、会话列表与社交状态切换、活动记录/本机日志只读查看、白名单诊断。模型与 Preset 只通过固定字段投影，默认值只影响未来新建会话。
- 默认 release 构建排除产品 HTML；Core 和壳的产物扫描拒绝页面资源/标记。

仍未达到“一次性全功能替代”验收：

- 原控制台仍有功能尚未迁移：发送参数、实时事件订阅、reserved/reserved2 的完整维护与记忆、贴纸、文件/音频/Kugou 等。
  审批/提问与风险卡片审批已迁入原生队列，并通过 `pending.list` / `pending.decide` 使用固定字段；服务管理与模型/Preset 的已迁移部分也不再依赖网页。
- 没有系统托盘、完整设置迁移页或 Core 事件订阅页；诊断项只有只读摘要。
- 命名管道的 Windows 用户 SID/DACL 尚未在真机审计。实现依赖 Windows 默认安全描述符，发布前应显式核对 ACL；
  并发连接/重启、中文 IME/缩放/键盘/复制粘贴、安装器与实际服务端到端均需真机验收。
- Node IPC、ControlService、策略测试通过；Rust 59 项单测与临时目录构建通过。真实 Node Core 命名管道烟测覆盖 `core.ready`、
  `role.list`、策略读写、活动/日志读取、默认模型读取、Supervisor 重启、HTTP 管理令牌拒绝、端口冲突与无孤儿进程；需要显示窗口的 UI 用例和 release 子进程检查
  按环境限制跳过。最新隔离 no-web release candidate（含审批/提问 native IPC）还通过了中文/空格安装路径、无系统 Node、只读安装目录、崩溃恢复、单实例、孤儿守卫与卸载保留数据检查。
- 这只是仓库外的可发布候选验证，不等同于真实用户机最终验收；旧 `dist/app`、旧 GUI 可执行文件或旧验收记录仍不能当成新原生发行物。

---

## 12. 真机使用中发现的缺陷与修复（2026-09-20 ~ 2026-09-21）

自动化测试用的是 **debug 构建 + node 源码模式**，而用户跑的是 **release 构建 + 打包 Core**。
下面这些缺陷只在真机组合下暴露，逐条记录根因、修复与验证状态，避免后人重踩。

| # | 现象 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | 每次启动弹出浏览器窗口，打开 `http://tauri.localhost/status.html` 并报 DNS 错误 | 壳的导航白名单只允许控制台 origin，把自家状态页（Tauri 自定义协议）判成"外部链接"：窗口里被拦掉、同时被交给系统浏览器 | `is_app_internal_url()` 把 `tauri.localhost` / `tauri://` / `about:blank` 视为内部导航；外链交给浏览器时写入壳日志 `[external]` | ✅ 实测 `[external]` 为 0；`test-desktop-shell` 新增「启动过程不得有任何 `[external]` 记录」断言；`main.rs` 恢复并扩充了导航白名单单元测试 |
| 2 | 启动时弹出一个深色控制台窗口（标题是 exe 路径） | `WhaleBridgeCore.exe` 是控制台子系统程序（Node SEA 即 node.exe），release 的壳是 GUI 子系统程序，Windows 会为控制台子进程**新建**控制台窗口 | shell 侧所有子进程 spawn 统一加 `CREATE_NO_WINDOW`（`supervisor::hidden()`） | ✅ 实测 Core 无 `conhost.exe` 子进程；仅 debug 构建会继承控制台，因此新增了 release 专项检查并打印进程树 |
| 3 | 装完应用后用默认令牌登录不了、QQ 设置不生效 | 安装器在数据目录生成了 `config.example.json` 的**占位副本**，而迁移"默认不覆盖已存在文件"→ 真实配置被静默跳过 | `is_shipped_placeholder()`：与随包 `config.example.json` 逐字节相同的目标文件允许被真实配置替换；示例文件在「安装目录」与「**运行中 exe 同目录**」两处查找（普通用户不会带 `--install-dir`） | ✅ 单元测试覆盖；真机迁移输出「用真实配置替换安装器生成的占位 config.json」，目标配置与源逐字节一致 |
| 4 | `--migrate` 报「快照失败：拒绝访问」 | 回滚备份目录由**安装目录**推导，而它是 `%ProgramFiles%`（普通用户不可写） | 备份改到**数据目录** `<data>\.whalebridge-backup\`（与 DSH 集成侧同名） | ✅ 单测 + 真机迁移成功 |
| 5 | 重启桥接后 SnowLuma 越攒越多（WebUI 端口 5104→5105→5106） | HTTP 探测在 SnowLuma 启动期偶发超时 → 判成"没在运行" → 再拉起一个；注入失败的链路也随之瘫痪 | 增加**纯 TCP 探测**（配置端点有人监听即复用，不再拉起第二个）。**注意不能因此判定 ready**——SnowLuma 先占端口、注入成功后才真正服务 API，早先误判成 ready 会盖掉更有用的「OneBot 尚未就绪」提示 | ✅ 实测复用日志正确（且失败场景下仍提示 OneBot 未就绪）；本地服务 43/43 通过 |
| 6 | 升级安装失败，只提示「另一个程序正在使用此文件」 | DSH 按 `cordis.patch.yml` 拉起的 5 个 `WhaleBridgeCore.exe --mcp ...` 子进程长期存活，锁住安装目录里的 Core | 计划阶段先做占用检测并给出可操作指引（先退 DSH / 用 `--stop-core`）；`--stop-core` 只结束**可执行路径位于本安装目录**的进程，不按名字模糊查杀 | ✅ 真机实测：占用时输出明确指引；`--stop-core` 后安装成功 |
| 7 | 强杀/正常退出后残留多个 `WhaleBridgeCore.exe`（曾攒到 5 个） | 退出路径把停止动作丢给了**独立线程**，进程可能在它跑完前就退出；孤儿守卫只覆盖"壳被强杀"场景 | 退出时改为**同步**停止（`shutdown()` 有界：丢弃 stdin 后最多等 5 秒，再按本子进程 taskkill） | ⚠️ 强杀路径已验证「孤儿 Core = 0」；**托盘「退出」的优雅路径需人工点一次确认**（无法自动化点击托盘菜单） |

### 12.1 未解决的第三方链路问题：QQ 进程注入

真机日志确认的因果链：

```text
QQ 由 explorer（桌面快捷方式）启动
  → SnowLuma「进程注入」失败：connect ETIMEDOUT \\.\pipe\mojo.<pid>.control
  → OneBot API（http://127.0.0.1:3000）始终不就绪       ← 注入正是让 OneBot 上线的那一步
  → 桥接连不上 QQ
```

**注入要求 QQ 由 SnowLuma 自己拉起**（它要接管那个实例的 Mojo 管道）。因此正确操作顺序是：
完全退出 QQ（含托盘残留）→ 在 SnowLuma 网页控制台「进程注入」页点「加载」→ 由 SnowLuma 拉起并登录 QQ → OneBot 就绪 → 桥接自动连上。

若点「加载」仍超时，属于 SnowLuma ↔ QQ 之间的问题，本项目无法从代码侧修复，常见原因：
QQ 未完全退出（拉到旧实例）、QQ 与 SnowLuma 权限级别不一致、QQ 版本与注入方式不兼容、
以及当前使用的是 **SnowLuma Lite**（目录 `SnowLuma-v1.14.14-win-x64-lite`）——Lite 是否支持进程注入
需对照 SnowLuma 官方说明确认。

**待办（前端改动，需走控制台基线流程）**：给控制台加一个「退出指定 QQ 实例并交给 SnowLuma 重新注入」
的按钮（按进程句柄精确退出，不按进程名查杀）。注意 `public/console.html` 是生成产物，
旧主题生成器、HTML 演示和涟漪背景实验已经移到私有设计归档，不再是正式产品 UI 的构建入口。
当前界面代码请在 desktop-ui/ 和 desktop-shell/src/theme/ 修改，按现行测试与发布流程验收。
