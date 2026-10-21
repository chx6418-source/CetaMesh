# 独立桌面应用迁移临时工作文档

> **ARCHIVED / SUPERSEDED（2026-10-05）**：本文件是历史开发工作台记录，不再是任何
> 当前状态的事实源。桌面产品已经发展为 CetaMesh Desktop（原生 Rust/egui 壳 + Node
> Core，Model Runtime / Agent Broker / Capability / Workshop / Memory v2 / Continuity
> 全链路），当前状态以 `PROJECT_STATE.md` 顶部 `CURRENT STATE` 为准；正式产品文档见
> `docs/DESKTOP_APP.md` 与 `docs/desktop/`。本文件从仓库根目录归档至 `docs/archive/`，
> 只保留阶段 0–10 的历史决策与验收记录价值。

> 文档性质：临时开发工作台，不是正式产品文档，不进入发布包。
>
> 生命周期：原桌面版开发与验收已由用户确认完成。本文件因新增“无网页原生化”后续计划而继续保留；后续计划完成、验收记录转入正式文档后再删除。
>
> 当前状态：原桌面版开发已验收；阶段 10 正在实施，10.0 验收门槛与 10.1 分批抽取仍未全部完成。
>
> 创建日期：2026-09-20
>
> 选定方案：方案 A —— Windows 安装版、独立桌面窗口、桥接本体不依赖目标电脑的系统 Node.js；DSH 与 SnowLuma 保持外部服务，由桌面应用发现和管理。
>
> 状态更新（2026-09-21）：用户确认阶段 0–9 原开发内容已完成验收。后续“完全不依赖网页”按阶段 10 独立规划，不能覆盖原阶段的历史记录。
>
> 阅读说明：阶段 0–9 的状态、勾选框及“待确认/未做”文字按原开发记录保留。它们不再表示原阶段等待验收；用户整体验收也不等于为每一条补造了单独的自动化或人工测试证据。阶段 10 是新的、尚未开始的工作范围。

---

## 0. 产品信息与剩余待确认项

工作区中的现有更名修改已经确定新品牌为 **鲸桥 WhaleBridge**。桌面化工作以该名称为准，不回退或覆盖现有更名修改。

| 字段 | 当前值 | 示例/约束 |
|---|---|---|
| 中文显示名 | `鲸桥` | 安装器、窗口标题、开始菜单显示 |
| 英文显示名 | `WhaleBridge` | Windows 文件属性、英文文档 |
| 产品短名 | `whalebridge` | 与当前 `package.json` 一致 |
| 主程序文件名 | `WhaleBridge.exe` | 正式桌面入口 |
| Windows App ID | `待确认` | 建议稳定 GUID 或经用户确认的反向域名，不随后续品牌文案变化 |
| 安装目录名 | `WhaleBridge` | 默认位于 `%ProgramFiles%` |
| 用户数据目录名 | `WhaleBridge` | 默认位于 `%LOCALAPPDATA%` |
| 安装包文件名 | `WhaleBridge-Setup-x64.exe` | 正式发行物 |
| 发布范围 | `待确认` | 自用 / 公开非商业 / 商业 |

### 0.1 更名兼容原则

现有工作区已经将 DSH 插件和 preset 从 `qq-*` 改为 `whale-*`。桌面应用迁移必须以新标识为规范，同时识别旧标识并提供兼容迁移：

- `whale-mode-console` 插件包名；
- `whale-mode` DSH settings namespace；
- `whale-chat`、`whale-chat-v2` preset ID；
- 新旧 DSH 配置块标记；
- `mcp-snowluma`、`mcp-snowluma-host` 等 MCP server ID；
- `state/*.json` 的既有字段名和文件名；
- DSH 中已经存在的会话、workspace 与模式值；
- 环境变量、HTTP API 路由和工具名称，除非另有兼容迁移层。

更名分成两层：

1. **品牌层**：统一使用“鲸桥 WhaleBridge”，覆盖窗口标题、安装器、图标、开始菜单、README、用户提示和 exe 文件属性。
2. **DSH 集成层**：新安装统一使用 `whale-mode*` / `whale-chat*`；升级时识别并迁移旧 `qq-mode*` / `qq-chat*`，不得让旧配置与新配置重复加载。
3. **稳定协议层**：MCP 工具名、HTTP API、状态文件格式和既有配置字段不因品牌更名随意变化；确需变化时必须双读并自动迁移。

---

## 1. 项目目标与硬约束

> 本节是阶段 0–9 的已验收目标基线。无网页原生化后的目标见阶段 10；如两者冲突，以阶段 10 与 ADR-016 为后续实现依据，原文保留作历史记录。

### 1.1 最终目标

交付一个标准 Windows 桌面应用：

- 通过 `WhaleBridge-Setup-x64.exe` 安装；
- 从开始菜单、桌面快捷方式或主程序 exe 启动；
- 启动时不出现命令提示符黑框；
- 使用独立桌面窗口承载现有登录页和控制台；
- QQ Bridge 主体在未安装系统 Node.js 的环境中仍可运行；
- 原有 Web 控制台功能、四种运行模式、MCP 工具、角色、状态、日志和子服务管理保持原样；
- DSH 与 SnowLuma 继续作为外部服务，桌面应用负责检测、启动、监控和打开对应页面；
- 支持从当前源码目录运行方式迁移配置和状态；
- 支持升级、修复和卸载；
- 卸载程序默认不删除用户配置、状态与聊天相关数据。

### 1.2 不在第一版范围内

- 不把完整 DSH 打进安装包；
- 在未取得书面授权前，不把 SnowLuma 二进制或专有原生组件打进安装包；
- 不重写现有控制台前端；
- 不更换 OneBot、DSH Web API 或 MCP 协议；
- 不借桌面化过程调整聊天策略、权限模型或角色行为；
- 不在打包迁移中顺带重构与打包无关的业务逻辑；
- 不删除或自动清理旧项目目录。

### 1.3 “功能保持原样”的定义

“保持原样”指业务能力和数据语义不回退，不要求继续保留 BAT/VBS 作为正式入口。下列能力必须通过验收：

- QQ 私聊、群聊收发及自动重连；
- DSH 会话创建、模型绑定、事件流、提问、审批和断线恢复；
- `chat`、`closed-agent`、`reserved`、`reserved2` 四种模式；
- 白名单、黑名单、owner 权限和令牌隔离；
- 图片、表情、引用消息、合并转发、官方机器人卡片；
- 风险按钮审批；
- 二代唤醒、潜水、未读消息、记忆、黑话、表情库；
- 文件、音频、TTS、FFmpeg、酷狗和 B 站能力；
- 安全 Web 搜索与抓取；
- 角色创建、切换、静默状态和持久化；
- SnowLuma、DSH 的检测、启动、停止、日志和应用窗口；
- 控制台鉴权、终端、活动日志和配置编辑；
- 单实例、正常退出、崩溃恢复和错误页面；
- DSH 重启期间消息排队，恢复后继续投递。

---

## 2. 目标架构

> 本架构描述阶段 0–9 已交付并验收的 WebView2 桌面版。后续原生化目标架构见阶段 10。

```text
WhaleBridge-Setup-x64.exe
        │
        └─ 安装
           ├─ WhaleBridge.exe               Windows GUI 启动器
           ├─ resources/
           │  ├─ bridge-core.exe            Node SEA 核心
           │  ├─ runtime-manifest.json
           │  └─ licenses/
           └─ 卸载器

WhaleBridge.exe
   ├─ 创建/激活单实例
   ├─ 启动 bridge-core.exe --worker
   ├─ 等待控制台健康检查
   ├─ 创建独立 WebView2 桌面窗口
   ├─ 加载 http://127.0.0.1:<consolePort>/
   ├─ 托盘与窗口生命周期管理
   └─ 监控 worker，异常退出后按策略重启

bridge-core.exe
   ├─ --worker                         主桥接进程
   ├─ --mcp snowluma                  QQ/MCP 工具
   ├─ --mcp snowluma-host             SnowLuma 主机工具
   ├─ --mcp web-search-safe           安全搜索工具
   ├─ --mcp qq-file-send              文件/音频工具
   ├─ --mcp bilibili                  B 站工具
   ├─ --setup-dsh [profile]           DSH 集成安装/修复
   ├─ --self-test                     自检
   └─ --diagnose                      发行版诊断
```

### 2.1 桌面窗口技术选型

阶段 1 采用 **Rust + Tauri 2/Wry + WebView2**：

- 当前开发机已有 Rust MSVC 工具链和所需依赖，不需要额外安装 .NET SDK；
- GUI 启动器体积和职责可控；
- 可以提供无黑框启动、托盘、单实例、窗口恢复和原生安装体验；
- 直接加载现有 `127.0.0.1` 控制台，不复制前端状态；
- 控制台依旧由原 Node HTTP 服务提供，浏览器访问模式仍可作为诊断后门；
- 外部网页、下载、OAuth/登录类链接默认交给系统浏览器；
- SnowLuma 和 DSH 的“应用窗口”仍由既有服务管理逻辑打开，除非后续明确要求统一嵌入。

进入实现前必须做一个最小 WebView2 原型，验证：

- 登录页 token/cookie 行为不变；
- 从登录页跳转控制台正常；
- WebSocket/SSE/轮询行为正常；
- 页面刷新、缩放、复制粘贴和下载行为可接受；
- 关闭窗口时是最小化到托盘还是退出，由产品决定；
- WebView2 Runtime 缺失时，安装器可引导安装或回退系统浏览器；
- 新窗口、`window.open`、外部链接和本地服务页面具有明确策略。

### 2.2 为什么不直接使用 Electron

第一版不选 Electron，原因仅限本项目适配性：

- 现有 UI 已是完整的本地 Web 控制台，无需再内置一套 Chromium 主进程业务；
- MCP 需要一个稳定的命令行/stdio 可执行入口，Node SEA 更直接；
- Electron 会显著增加安装体积和升级面；
- 桌面壳只需承担窗口、托盘、单实例和进程监控，WebView2 足够。

若 Tauri/Wry WebView2 原型无法满足登录、窗口管理或部署要求，再单独形成技术决策记录，不在实现中临时切换框架。

---

## 3. 目录与数据布局

### 3.1 安装目录：只读

> 下图为**安装后**的目标布局（阶段 7 落地）。阶段 4 已实现的**构建产物**布局为
> `dist\core\WhaleBridgeCore.exe` + `dist\core\resources\`，安装器只需把这两项搬到
> `%ProgramFiles%\WhaleBridge\`（Core 会自行发现同目录 `resources\`，两处布局无需改动代码）。

```text
%ProgramFiles%\WhaleBridge\
├─ WhaleBridge.exe
├─ resources\
│  ├─ bridge-core.exe
│  ├─ runtime-manifest.json
│  └─ licenses\
└─ uninstall.exe
```

运行期间不得把配置、日志、缓存或状态写入安装目录。

### 3.2 用户数据目录：可写

```text
%LOCALAPPDATA%\WhaleBridge\
├─ config.json
├─ state\
├─ roles\
├─ logs\
├─ cache\
├─ backups\
└─ runtime\
   └─ <app-version>\
      ├─ dsh-presets\
      └─ whale-mode-console\
```

### 3.3 路径解析优先级

1. `--data-dir <absolute-path>`；
2. 环境变量 `WHALEBRIDGE_DATA_DIR`；
3. exe 同目录存在 `portable.flag` 时使用便携数据目录；
4. 正式安装模式使用 `%LOCALAPPDATA%\WhaleBridge`；
5. 源码开发模式继续兼容仓库根目录。

### 3.4 资源分类

| 分类 | 处理方式 |
|---|---|
| 控制台 HTML、默认图片、配置模板 | 编入 SEA asset 或构建资源包，只读访问 |
| DSH preset、DSH 插件 | 首次运行按版本释放到用户 runtime 目录 |
| 默认角色 | 内置模板；首次运行复制到用户 roles，之后不覆盖 |
| 用户角色、配置、state、日志、缓存 | 永远位于用户数据目录 |
| SnowLuma、DSH | 外部安装，不进入第一版安装包 |

---

## 4. 进程与生命周期设计

### 4.1 GUI 启动器

职责边界：

- 使用 Windows mutex 保证 GUI 单实例；
- 第二次启动将已有窗口激活到前台；
- 使用匿名管道或命名管道启动和控制 worker；
- 保存 worker 进程句柄，不按名称或命令行模糊查杀；
- 等待 `/api/status` 或专用 `/healthz` 后显示主窗口；
- worker 非预期退出时记录原因并退避重启；
- 用户选择“退出应用”时先请求 worker 优雅退出，超时后只终止本实例子进程；
- 用户关闭窗口时默认行为必须由产品确认：退出或最小化到托盘；
- 托盘菜单至少包含：显示主窗口、打开系统浏览器、重启桥接、打开日志目录、退出。

### 4.2 Core 退出码约定

| 退出码 | 含义 | 启动器动作 |
|---:|---|---|
| 0 | 正常结束 | 不自动重启，除非明确收到“重启”请求 |
| 2 | 用户/控制台要求停止 | 不重启 |
| 10 | 用户/控制台要求重启 | 立即按正常流程重启 |
| 20 | 配置错误但错误页已启动 | 保持进程，显示错误页 |
| 其他 | 异常退出 | 记录并退避重启 |

最终退出码在实现时以测试锁定，避免继续依赖 BAT 守护语义。

### 4.3 重启退避

- 第一次异常退出：5 秒；
- 60 秒内连续失败：10、20、30 秒递增；
- 达到阈值后停止自动重启，桌面窗口展示可操作错误；
- 用户点击“重试”后清零退避；
- 不允许无限高速重启。

### 4.4 CLI/调试模式

正式入口无黑框，但必须保留调试能力：

- `bridge-core.exe --worker --console` 可在终端中运行；
- 提供开始菜单“诊断控制台”快捷方式；
- 原实时状态面板仅在真实 TTY 中启用；
- GUI 模式下日志继续进入文件和 Web 控制台。

---

## 5. Core/SEA 改造计划

### 5.1 统一入口

新增统一入口模块，将现有顶层执行改为显式函数：

```text
runBridge()
runSnowLumaMcp()
runSnowLumaHostMcp()
runWebSearchMcp()
runFileSendMcp()
runBilibiliMcp()
runSetupDsh()
runSelfTest()
```

要求：

- 导入模块不得自动连接 stdio 或启动 HTTP 服务；
- 每个模式只能启动自己的资源；
- MCP 模式不得向 stdout 输出非 MCP 协议文本；诊断写 stderr；
- `--help`、非法参数和版本信息具有稳定输出；
- 源码模式和 SEA 模式共用同一分派入口。

### 5.2 统一路径服务

新增单一 `app-paths` 模块，替代各文件独立使用 `import.meta.url` 推导根目录：

```text
installDir
resourceDir
dataDir
stateDir
rolesDir
logsDir
cacheDir
runtimeDir
isPackaged
isPortable
```

禁止业务模块重新定义自己的 `ROOT`。

### 5.3 Bundle

构建要求：

- 使用固定版本 esbuild；
- 目标为单个 CommonJS bundle；
- Node 内置模块保持 external；
- 第三方 JS 依赖按入口可达性打包；
- 可选原生依赖不得被静默带入；
- `iconv-lite` 必须改为明确直接依赖；
- 验证是否可移除未使用的 `@deepseek-ai/dsh-host-apiproxy`；
- 生成 bundle metafile，审计实际包含的包；
- 禁止把完整 `node_modules` 目录复制进发行版。

### 5.4 SEA

- 锁定准确 Node 版本与下载校验值；
- 构建 Windows x64 SEA；
- 只读资源通过 asset manifest 嵌入；
- 版本、commit、构建时间写入发行 manifest；
- 构建完成后运行所有 core 和 MCP smoke test；
- 发布前执行 Authenticode 签名和时间戳；
- 保存未签名/已签名哈希，防止流水线混淆。

---

## 6. DSH 集成迁移

> 本节描述目标设计。**6.1 / 6.2 / 6.3 已于阶段 5 实现**，实现细节、归属模型与验证记录见
> 「阶段 5」小节与 ADR-008；本节保留为设计依据与验收清单。

### 6.1 新 MCP 配置

不再写入 `node.exe + src/*.js`，改为：

```yaml
command: '<absolute-path-to-bridge-core.exe>'
args:
  - '--mcp'
  - 'snowluma'
```

其他 MCP server 使用相同 exe 和不同模式参数。

### 6.2 Preset 与插件

- 从内置资源按版本释放 `whale-chat`、`whale-chat-v2`；
- 复制到 DSH preset 目录时保留现有行为；
- `whale-mode-console` 释放到稳定 runtime 目录；
- profile `package.json` 继续注册兼容包名；
- 不依赖管理员权限创建目录 junction；
- 所有本应用管理的文件带 manifest 和内容哈希；
- 升级只更新本应用拥有的文件，不覆盖用户自建 preset；
- DSH 运行中更新集成后明确提示重启 DSH。

### 6.3 旧配置修复

识别并升级：

- 指向旧仓库 `src/mcp-*.js` 的 command/args；
- 指向旧 Node 安装的 command；
- 已失效的 `qq-mode-console` / `whale-mode-console` junction；
- 旧仓库移动导致的绝对路径失效；
- 已有 BEGIN/END 区块；
- 历史无标记但可确认属于本项目的配置。

不确定归属的配置只报告，不自动删除。

### 6.4 卸载策略

- 卸载器删除应用安装目录；
- 提示是否移除 DSH 集成；
- 移除 DSH 集成时只处理 manifest 记录的文件/区块；
- 默认保留 `%LOCALAPPDATA%` 数据；
- 用户明确选择“同时删除数据”时再次确认并列出目录；
- 不停止或卸载用户自己的 DSH、SnowLuma。

---

## 7. SnowLuma 与第三方许可门槛

### 7.1 第一版技术策略

- 不把 SnowLuma Lite/Full 二进制放入安装包；
- 保留检测已有安装、版本校验、启动、停止、日志与打开网页能力；
- 未安装时显示官方安装引导；
- 原自动下载/解压能力是否继续公开提供，必须在授权确认后决定；
- 未确认授权前，构建流水线加入断言，发现 SnowLuma `.node`、`.dll`、发行包或用户数据时直接失败。

### 7.2 发布前必须完成

- 确认 SnowLuma 官方二进制、SDK 的再分发/打包权限；
- 确认项目是自用、公开非商业还是商业发布；
- 生成第三方依赖许可证清单；
- 生成 SBOM；
- 确认应用名称和图标不构成官方 QQ、腾讯、DeepSeek 或 SnowLuma 产品的误导性背书。

---

## 8. 旧数据迁移

### 8.1 可迁移内容

- `config.json`；
- `state/` 全部运行状态；
- `roles/` 用户角色；
- 控制台令牌和 agent 令牌；
- 会话映射、模式、角色、黑话、表情库、卡片缓存；
- 文件发送、TTS、FFmpeg、酷狗配置；
- SnowLuma 与 DSH 自定义路径；
- 用户明确选择的日志。

### 8.2 迁移规则

- 自动扫描只能发现候选目录，不能静默覆盖；
- 迁移前显示来源和目标；
- 迁移前备份目标；
- JSON 必须先解析验证；
- 敏感配置不得进入日志；
- 旧目录保留；
- 迁移后重新安装/修复 DSH 集成；
- `fileSend.localDirs` 继续使用用户原授权路径；
- 对不存在的外部工具路径给出警告，不自动改成其他程序；
- 迁移失败可回滚到迁移前快照。

---

## 9. 安全要求

- WebView2 仅默认导航到本机受信控制台 origin；
- 非本机导航交给系统浏览器，禁止在高权限 WebView 中浏览任意网站；
- 保留现有 CSRF/origin、控制台 token 和 agent token 边界；
- GUI 启动器与 core 的 IPC 必须验证本用户、本实例和随机会话 token；
- 不通过命令行传递长期 token；
- MCP stdout 必须保持协议纯净；
- 更新、资源释放和迁移使用原子写入；
- 安装器和 exe 签名；
- 禁止以管理员权限运行日常主程序；仅安装阶段请求提升；
- 日志不记录凭据、完整 Cookie、DSH secret 或 QQ accessToken；
- 卸载和更新不得递归删除未验证的路径；
- 构建流水线扫描是否意外带入 `config.json`、`state/`、日志、SnowLuma 数据库和本机绝对路径。

---

## 10. 分段开发路线

每个阶段独立提交、独立验收。上一阶段未通过，不进入下一阶段。

### 阶段 0：产品标识、范围和基线冻结

状态：`基线已完成；其余产品选项采用可逆默认值`

任务：

- [x] 确认中文名“鲸桥”、英文名“WhaleBridge”和包名 `whalebridge`；
- [ ] 确认 Windows App ID；
- [x] 发布范围暂按公开非商业候选约束处理；
- [x] 关闭窗口暂按后续“最小化到托盘”设计，阶段 1 原型关闭即退出；
- [x] 开机启动暂按用户主动选择、不默认开启；
- [x] 记录当前 Node、DSH、SnowLuma 版本；
- [x] 在源码模式完成基线测试；
- [x] 保存测试结果，不提交真实配置和 state。

基线记录（2026-09-20）：

- Node `v24.19.0`、npm `11.17.0`、DSH `0.1.5-rc.1`、本机 SnowLuma Lite `1.14.14`；
- 全部改动 JS 语法检查通过；
- Markdown、等待、转发、权限（31/31）、本地服务（43/43）、卡片（134/134）、表情（40/40）及控制台融合检查通过；
- `test-slang` 有一项既有断言差异：测试要求字面量“深度联网考究”，实现为“深度考究”且已要求 `web_fetch`；该差异与桌面迁移和本次更名无关，暂不混入本阶段修改。

退出条件：名称和发行边界明确，源码基线无未解释失败。

### 阶段 1：WebView2 桌面壳原型

状态：`代码与自动化验证完成；原记录中的手工交互项由阶段 8 用户整体验收确认（2026-09-21）`

任务：

- [x] 新建最小 GUI 启动器；
- [x] 使用现有 Node worker（当前运行中的 `3100` 控制台）作为临时后端完成联调；
- [x] 配置 WebView2 直接加载本机登录页/控制台 URL；
- [x] 自动验证令牌登录、会话 Cookie、刷新和 API 鉴权链路；
- [ ] 手工验证缩放、复制粘贴与完整页面交互；
- [x] 实现外部链接交给系统浏览器、本机同源弹窗允许打开；
- [ ] 手工验证外链与同源弹窗实际行为；
- [x] 接入单实例并在第二次启动时激活主窗口；
- [x] 托盘和关闭最小化留到阶段 6，不纳入本原型退出条件；
- [x] 形成 WebView2 go/no-go 记录。

自动验证记录（2026-09-20）：

- `cargo check --offline` 通过；
- Rust 单元测试 4/4 通过，覆盖本机 URL 白名单、远程/非 HTTP 拒绝、同源导航和命令行覆盖；
- 调试版 `.exe` 成功创建 WebView2 主窗口，窗口标题为“鲸桥 WhaleBridge”；
- 双启动烟测通过：首实例继续运行，第二实例正常退出并激活首窗口；
- 现有控制台认证链路通过：令牌登录 200、会话 Cookie 存在、刷新 200、`/api/status` 200；
- Go：WebView2/Tauri 路线满足进入下一阶段的自动化门槛；发布前仍须补齐上述手工交互验收。

退出条件：不改业务代码即可在独立窗口完整操作现有控制台。

### 阶段 2：路径层重构

状态：`完成`

任务：

- [x] 增加统一 `src/app-paths.js`；
- [x] 开发模式保持仓库路径；
- [x] 增加临时 data-dir 和真实子进程环境变量测试；
- [x] 将 config/state/roles/log/cache 迁移到路径服务；
- [x] 将 public/assets/tools 访问迁移到资源服务；
- [x] 主桥、MCP、TTS 和 self-test 不再各自推导仓库根目录；
- [x] 原有核心回归继续通过。

路径契约：

- 未设置环境变量：`resourceRoot === dataRoot === 仓库根目录`，现有源码运行方式和文件位置不变；
- `WHALEBRIDGE_DATA_DIR`：指定 `config.json`、`state/`、用户角色、日志和缓存的可写根目录；
- `WHALEBRIDGE_RESOURCE_DIR`：可选指定 `public/`、`assets/`、`tools/` 和内置角色的只读根目录；
- 角色读取采用“用户角色优先、内置角色兜底”，同名用户角色可覆盖内置角色；新建角色只写用户数据目录；
- 内嵌终端和本地服务管理器在独立模式下以数据根目录为工作目录，不再要求安装目录可写。

验证记录（2026-09-20）：

- `test-app-paths` 通过：默认兼容、相对/绝对覆盖、子进程环境变量、临时目录隔离、角色合并与覆盖；
- 所有 `src/*.js` 共 25 个文件语法检查通过；
- 权限测试 31/31、本地服务 43/43、卡片 134/134、表情 40/40、转发 25/25、Markdown 15/15、等待逻辑全部通过；
- 视觉媒体测试 7/7 通过，并将 Node 24/Windows 下不安全的强制 `process.exit()` 改为 `process.exitCode`，消除通过后 libuv 退出断言；
- 控制台融合检查三项全部 PASS；
- `test-slang` 的既有文案断言差异仍按阶段 0 记录处理，与路径层无关。

退出条件：业务模块不再自行推导项目根目录，开发模式行为无回退。

### 阶段 3：统一 Core/MCP 入口

状态：`完成`

任务：

- [x] MCP 顶层执行改为显式 run 函数；
- [x] 新增统一参数分派 `src/core-entry.js`；
- [x] `node src/core-entry.js --worker` 工作；
- [x] 五个 `--mcp` 模式逐一完成 initialize/listTools/callTool；
- [x] stdout/stderr 协议测试；
- [x] 原 MCP 独立文件入口保持兼容；
- [x] 原 `npm start`、setup/self-test 命令保持可用。

统一入口：

```text
node src/core-entry.js --worker
node src/core-entry.js --mcp snowluma
node src/core-entry.js --mcp snowluma-host
node src/core-entry.js --mcp web-search-safe
node src/core-entry.js --mcp qq-file-send
node src/core-entry.js --mcp bilibili
node src/core-entry.js --self-test [DSH_BASE_URL] [PROMPT]
```

兼容策略：

- `src/bridge.js` 与五个原 MCP 文件仍可直接执行；
- 所有运行模块被 import 时不再自动启动进程或占用 stdio；
- `scripts/setup-dsh.mjs` 下次执行时会把五个 MCP 配置统一指向 `core-entry.js --mcp <mode>`；
- 本阶段没有主动改写当前用户的 `~/.dsh`，已运行的 DSH 配置继续使用旧独立入口也可正常工作；
- Core 参数错误统一写 stderr 并以非零退出码结束，MCP stdout 保持纯协议流。

验证记录（2026-09-20）：

- 五个统一 MCP 模式均通过真实子进程 `initialize → listTools → callTool`；
- 五个原独立 MCP 入口均通过真实 `initialize → listTools` 兼容验证；
- `--worker` 在隔离数据目录、隔离服务发现环境和临时本机端口成功启动，登录页返回 401、服务令牌与锁文件落入临时 dataRoot，随后在 5 秒内正常退出；
- `--help` 返回 0，未知 MCP 模式返回 1 且错误只写 stderr；
- 卡片常驻注册测试已改为直接调用显式 run 函数和内存传输，不再改写临时源码；卡片 134/134 通过；
- 权限 31/31、本地服务 43/43、阶段 2 路径隔离测试继续通过。

退出条件：单个 Node 入口覆盖 worker 和全部 MCP 进程。

### 阶段 4：Bundle 与 SEA 可行性

状态：`完成（发行自动化验证通过；图标/签名/杀软白名单与真机无 Node 环境留待阶段 7/8）`

任务：

- [x] 清理直接/传递依赖声明；
- [x] 生成单文件 CJS bundle；
- [x] 审计 bundle metafile；
- [x] 构建 `WhaleBridgeCore.exe`；
- [x] 无系统 Node 环境启动；
- [x] 逐个验证 MCP stdio；
- [x] 运行本地控制台和核心测试；
- [x] 记录 exe 体积、冷启动时间和内存（数据见下方验证记录）。

采用的打包路线（实施后记录）：

1. `esbuild` 把 `src/core-sea.js` 打成单文件 CJS bundle（`platform=node`、`format=cjs`、不压缩），
   Node 内置模块与 `ws` 的可选原生加速模块 `bufferutil` / `utf-8-validate` 保持 external；
2. `node --experimental-sea-config` 生成 SEA blob；
3. `postject` 把 blob 注入到当前 `process.execPath`（node.exe）的副本，得到
   `WhaleBridgeCore.exe`；
4. 只读资源以 exe 同目录 `resources\` 外置，不嵌入 blob。

不采用「全部资源嵌入 SEA asset」的原因：`public/`、`roles/` 目前以 `fs.readdirSync` /
`fs.readFileSync` 访问，且用户角色要与内置角色合并覆盖，改为 `sea.getAsset` 会把路径抽象
重新拆散；资源目录外置同样满足「用户无需安装 Node.js / Rust」的交付要求。

关键实现决定：

- **CJS bundle 中 `import.meta` 必须保持为空**。bundle 内所有模块共享同一份 `import.meta`，
  若让它解析为 exe 自身路径，`bridge.js` 与五个 MCP 文件顶层的
  `if (isMainModule(import.meta.url))` 守卫会在 SEA 中全部成立，一次启动 bridge 加五个 MCP。
  因此新增 `src/core-dispatch.js` 承载分派，`src/core-entry.js` 只保留源码模式守卫，
  `src/core-sea.js` 作为打包入口无条件调用 `runCore()`。构建脚本用
  `logOverride.empty-import-meta = silent` 静音这条**预期且必需**的警告，并在注释中说明。
- 打包模式路径规则：`node:sea` 经 `process.getBuiltinModule('node:sea')` 探测，避免依赖
  `import.meta`/`require`；`resourceRoot` 默认 exe 同目录 `resources\`（不存在则退回 exe 目录），
  `dataRoot` 默认 `%LOCALAPPDATA%\WhaleBridge`，exe 同目录存在 `portable.flag` 时改用
  exe 同目录 `data\`；`--data-dir` > `WHALEBRIDGE_DATA_DIR` > `portable.flag` > 默认目录。
  安装目录永不作为默认可写目录。
- `desktop-shell` 不硬编码 Core 路径：新增 `src/core_launch.rs` 解析「开发=node +
  src/core-entry.js」「发布=exe 同目录或 resources\ 下的 WhaleBridgeCore.exe」，可用
  `--core-mode` / `WHALEBRIDGE_CORE_MODE`、`--core-command` / `WHALEBRIDGE_CORE_EXE` 覆盖，
  并提供 `--print-core-command` 诊断输出。启动、健康检查与重启退避仍属阶段 6。

产物布局（实际）：

```text
dist\core\
  WhaleBridgeCore.exe        96,170,496 字节（91.7 MB）
  resources\                 只读资源 17 个文件
    public\ roles\ assets\ dsh\ plugins\ config.example.json
  runtime-manifest.json      版本、工具链、包清单、排除项、体积与 sha256
  build\                     中间产物：core.bundle.cjs(3143KB)、core.bundle.meta.json、
                             sea-config.json、core.blob
```

bundle 审计结果：308 个模块文件、12 个第三方包（zod 98、ajv 63、zod-to-json-schema 39、
iconv-lite 22、@snowluma/sdk 19、@modelcontextprotocol/sdk 16、ws 14、fast-uri 3、
ajv-formats 3、safer-buffer 1、fast-deep-equal 1、json-schema-traverse 1），
全部为纯 JS，无 `.node`、无 binding.gyp，external 仅剩 Node 内置模块与两个可选加速模块。
排除项：`public/*.bak-t18`（开发期备份）、`assets/project-intro.mp4`（11MB 演示视频，
Core 运行期不读取）。`assets/project-intro.mp4` 若阶段 7 的安装器需要展示可再放回。

验证记录（2026-09-20）：

- `npm run build:core`：约 6 秒完成；产物 91.7MB，sha256 记入 `runtime-manifest.json`；
  bundle 与 exe 中均不含构建机仓库绝对路径（SEA 内嵌脚本名使用相对名，异常堆栈不再泄漏
  `D:\GIT-QQ-BRIDGE\...`）。
- 构建可复现性：删除整个 `dist\` 后重新构建，产物 sha256 前缀仍为 `2c88c8b67de8046e`，
  与删除前**逐字节相同**（同一 Node 版本 + 同一 bundle 输入下 SEA blob 注入是确定性的）。
- `npm run test-core-dist` 全通过（隔离 PATH 只保留 `%SystemRoot%\System32;%SystemRoot%`，
  `where node` 提前验证解析失败；临时数据目录、临时端口、临时 HOME/LOCALAPPDATA/ProgramFiles）：
  - `--help` 退出码 0、只写 stdout；非法模式退出码 1、只写 stderr；无参数打印用法退出码 0；
  - `--self-test` 模式可用（DSH 不可达时按预期非零退出，未连接真实 DSH）；
  - 五个 MCP 模式真实 stdio：initialize / tools/list / tools/call 全部通过
    （snowluma 39 个工具、snowluma-host 1、web-search-safe 2、qq-file-send 5、bilibili 2）；
  - `--worker` 五种路径全部启动成功并验证 401 鉴权、带令牌 200、`/api/status` 鉴权边界：
    显式 `WHALEBRIDGE_RESOURCE_DIR`、自动发现 exe 同目录 `resources\`、
    默认 `%LOCALAPPDATA%\WhaleBridge`、`--data-dir`、`portable.flag`；
  - `state\agent-token` 与 `state\bridge.lock` 落盘；未配置 `consoleToken` 时首次启动生成
    `state\console-token` 且该令牌确实能通过鉴权；
  - 401 页面与控制台页面内容确实读自 `resources\public\`；exe 目录保持只读（不产生 `state\`）；
  - worker 进程镜像为发行 exe，后代进程 1 个（Windows 自带工具）且**无 node.exe**；
  - 测试结束后无 `WhaleBridgeCore.exe` 进程残留。
- `npm run test-app-paths`：新增打包分支覆盖（resources 自动发现、`%LOCALAPPDATA%`、
  `portable.flag`、`--data-dir` 与环境变量优先级）通过。
- `npm run desktop:test`：16/16 通过（新增 `core_launch` 12 项）。
- 回归：`test-core-entry`、`test-card` 134/134、`test-privilege` 31/31、
  `test-local-services` 43/43、`test-stickers` 40/40、`test-forward` 25/25、`test-wait`、
  `test-vision` 7/7、`test-md`、控制台融合检查三项 PASS、`src+scripts` 55 个 JS/MJS 语法检查、
  `git diff --check` 全部通过。
- 体积与性能（本机 Windows 11 x64、Node v24.19.0，测量脚本一次性使用，不入库）：
  - 发行 exe 91.7 MB（96,170,496 字节）；其中 bundle 仅 3143 KB，其余为宿主 node.exe；
  - `--help` 冷启动 113 ms（中位，3 次：109/113/114），源码模式 `node src/core-entry.js --help`
    为 208 ms——单文件 bundle 省掉 ESM 模块图逐文件解析，打包后启动反而更快；
  - MCP 模式 spawn 到 initialize 响应 106~112 ms；
  - worker spawn 到首个 401 响应 186~194 ms；稳定后工作集内存约 97.2~97.5 MB。
- 未做（如实记录）：未在真正没有 Node.js 的机器或干净虚拟机上运行（本机隔离 PATH 只证明
  运行期不解析 `node.exe`，进程树也无 node.exe）；exe 未加图标/版本资源/Authenticode 签名；
  未验证 Windows Defender 对「复制 node.exe + 注入 blob」这类产物的行为。

退出条件：干净 Windows 虚拟机中，core 和全部 MCP 无系统 Node 可运行。→ 本机自动化门槛已
通过；干净虚拟机与杀软白名单验证归入阶段 8（发布候选）执行。


### 阶段 5：DSH 集成安装与迁移

> 本阶段记录的是当时配置写入和隔离测试覆盖。其真实 DSH 会话验收已包含在用户对原开发范围的整体验收确认中；本注释不补造逐工具手工调用证据。

状态：`完成（自动化验证通过；原开发范围已由用户整体验收确认。真实 DSH 会话的逐工具结果未在本阶段单独留证，见下方历史说明）`

任务：

- [x] 版本化释放 preset/plugin；
- [x] 新 MCP command 指向 core exe；
- [x] 旧源码路径自动修复；
- [x] 幂等执行；
- [x] 失败回滚；
- [x] DSH 重启提示；
- [x] 生成配置下的 MCP stdio 握手与 `tools/list` 验证；真实会话逐工具结果未单独留证，纳入阶段 8 的用户整体验收。

实现结构：

```text
src/dsh-integration.js      集成逻辑（纯计划 + 受控执行），无 import 副作用
scripts/setup-dsh.mjs       薄 CLI：node scripts/setup-dsh.mjs [profile] [--dry-run|--force-presets|--no-plugin-install|--json]
WhaleBridgeCore.exe --setup-dsh [profile]   打包运行时的同一入口（发布安装包内没有 scripts/）
```

`src/core-dispatch.js` 新增 `--setup-dsh` 模式，`runSetupDshFromApp()` 依据
`isPackagedRuntime()` 与 `APP_PATHS` 推导资源目录、数据目录与 Core 启动方式，因此源码模式与
打包模式走的是同一份逻辑与同一批断言。

关键设计决定：

1. **Core 启动方式统一用 `process.execPath`，靠 args 前缀区分模式**：
   - 开发模式：`node.exe` + `<仓库>/src/core-entry.js` + `--mcp <mode>`；
   - 发布模式：`WhaleBridgeCore.exe` + `--mcp <mode>`（**不带**入口脚本）。
   这解决了阶段 4 记录的风险"setup-dsh 用 process.execPath，在 SEA 下会变成 Core exe"——
   变成本身就是正确行为。
2. **归属判定靠 manifest 里的内容哈希**（`<DSH_HOME>/.whalebridge-integration.json`）：
   - 由本应用安装且此后未被改动 → 允许升级；
   - 安装后被用户改过 → 保留并提示 `--force-presets`；
   - 来源不明（无 manifest 记录且与内置不一致）→ 保留 + 提示，绝不覆盖。
   首次迁移会把当前状态登记为归属基线，此后升级判定才生效。
3. **绝不删除归属不明的内容**：用户自建 preset（如 `liangshen`）、用户自己的 MCP 条目、
   非链接的插件目录一律只报告。
4. **无标记的旧 MCP 配置就地修复，不补标记块**：补标记块会与既有条目重复注册同一批 MCP
   server。就地改 command/args 已足够支撑后续升级；只有本来就带标记块的文件才整块替换。
5. **只有"没有任何实际改动"时才不写 manifest**：manifest 只记录持久事实（哈希、归属、
   版本、Core 启动方式），不记录本次 action，否则重复执行会因 action 从 install 变 unchanged
   而重写文件。
6. **链接删除绝不跟随**：junction / 目录符号链接用 `rmdir` 摘链接，只有真实目录/文件才递归删除，
   避免误删链接目标的全部内容。
7. **失败回滚干净退场**：执行前快照所有将被触碰的路径；失败时逆序恢复；回滚完全成功则连
   备份目录一起删除（失败的尝试不留痕迹），回滚不彻底才保留备份并在错误里给出路径。
8. **profile 名校验**：`^[A-Za-z0-9._-]{1,64}$`，因为 profile 名会进入目录名与命令行。

验证记录（2026-09-20，`npm run test-dsh-integration`，17 项全通过）：

- **新装**：preset / 插件链接 / MCP 块 / profile package.json / `state/mode.json` / manifest 全部落地，
  且原有注释与结构保留；
- **幂等**：重复执行 `effects.length === 0`，整棵 `DSH_HOME` 目录树逐字节不变（含链接目标）；
- **旧路径迁移**：用本机真实旧配置（`node.exe` + `src/mcp-*.js`，标记块后还有 `uiskin-theme`
  等用户条目）验证 —— 五条全部迁移为 `core-entry.js --mcp <mode>`，用户条目、`disabled: true`
  属性与 `toolCallTimeoutMs` 原样保留；迁移后再跑一次仍为空操作；
- **无标记旧配置**：只就地修复本项目 5 条，用户自己的 `my-own-server` 条目与其 command/args
  完全不变，且不添加标记块；
- **升级**：内置内容变化后，由本应用安装且未被改动的 preset 自动更新；
- **用户改动保护**：安装后手改 preset 内容 → 判定 `keep-user-modified`，内容保持不变；
  加 `--force-presets` 才覆盖；
- **回滚**：注入故障使第 2 个 effect 失败 → 抛错且目录树与执行前完全一致（含未创建路径、
  不含残留备份目录）；
- **发布模式**：五条配置的 `command` 都是 `WhaleBridgeCore.exe`、`args` 只有 `['--mcp', <mode>]`；
  插件按版本释放到 `<dataRoot>/runtime/<version>/whale-mode-console` 并链接；
  版本号变化时重新释放并自动切换链接；重复执行幂等；
- **旧命名清理**：`qq-chat` preset、`qq-mode-console` 链接、`settings.yaml` 的 `qq-mode:`
  命名空间、profile 里的旧依赖与旧 bundle 全部清理，而用户自己的 `liangshen` preset 未受影响；
- **生成结果可用**：按生成出的 command/args 真实启动五个 MCP，`initialize` + `tools/list`
  全部通过（snowluma 39、snowluma-host 1、web-search-safe 2、qq-file-send 5、bilibili 2 个工具）；
- **CLI**：`--dry-run` 零写入（连数据目录都不创建）；真实执行只动临时 `DSH_HOME`；
  重复执行 `effectCount === 0`；
- **打包模式（`npm run test-core-dist` 新增用例）**：`WhaleBridgeCore.exe --setup-dsh web`
  在隔离 `DSH_HOME` 下把旧配置迁移为 exe + `--mcp <mode>`，preset/插件/manifest 落地，
  重复执行输出"没有需要写入的改动"。

退出条件：新装、升级、重复修复和旧路径迁移均通过。→ 自动化门槛已通过。

编写时记录的未执行/未确认项（用户后来确认原开发内容整体验收完成；本段保留当时记录，不再作为当前阻塞）：

- **没有改动本机真实的 `~/.dsh`**。真实配置目前仍是旧布局（`node.exe` + `src/mcp-*.js`），
  对它的只读预演显示唯一需要的改动就是 MCP 块更新。执行
  `node scripts/setup-dsh.mjs` 即可迁移，但**必须重启 DSH 才生效**，因此交由用户择时执行。
- 真实 DSH 会话内的工具调用（在 QQ 里实际让 agent 调用 `qq_*` 工具）需要 DSH 重启 + 真实 QQ
  会话，属于阶段 8 的端到端验收项；本阶段用"按生成配置真实 stdio 握手并列出工具"覆盖了配置
  正确性这一层。
- 卸载流程（移除 DSH 集成）不在本阶段，见阶段 7。


### 阶段 6：桌面启动器正式接入

状态：`完成（自动化验证通过；原记录里的托盘/WebView2 手工交互项由阶段 8 用户整体验收确认，2026-09-21）`

任务：

- [x] 启动 core worker；
- [x] 健康检查后显示窗口；
- [x] 进程句柄监控；
- [x] 正常退出与异常重启；
- [x] 重启退避；
- [x] 托盘菜单；
- [x] 日志和诊断入口；
- [x] 端口冲突及配置错误 UI；
- [x] WebView2 Runtime 缺失处理（沿用系统 WebView2；缺失时的引导安装归阶段 7 安装器）。

实现结构：

```text
desktop-shell/src/
  main.rs           入口：参数、窗口、托盘、状态页注入、退出编排
  core_launch.rs    阶段 4：开发/发布模式的 Core 选路（未改动）
  desktop_paths.rs  数据目录优先级、config.json 端口解析、日志路径
  supervisor.rs     进程监管：spawn、健康检查、退出码决策、退避、优雅停止
desktop-shell/ui/
  status.html       启动中/失败/已停止的状态页（由壳注入状态后渲染）
src/bridge.js       托管模式：退出码 10、跳过全局守护清理、stdin 孤儿守卫
```

### 退出码契约（测试锁定）

| 退出码 | 含义 | 启动器动作 | 生产者 |
|---:|---|---|---|
| 0 | 正常结束（控制台「关闭主程序」/启动器要求退出） | 不重启，窗口显示"已停止"+ 托盘可重启 | `/api/shutdown`、SIGINT/SIGTERM、孤儿守卫 |
| 2 | 已有实例在运行 / 端口被占用 | 不重启，显示"已有实例或端口占用"并给日志路径 | `acquireLock()`、`EADDRINUSE` |
| 10 | 请求重启 | 立即重新拉起（不退避） | `/api/restart` |
| 其它 | 异常退出 | 按退避策略重启：5/10/20/30 秒封顶；连续 5 次后放弃并提示人工处理 | 崩溃、配置错误 |

**与既有 BAT/VBS 路径的兼容**：`start.bat` 的守护循环"除 2 之外都重启"，因此退出码从 0 改为 10
对 `/api/restart` 完全透明（10≠2 仍会重启）；`/api/shutdown` 仍以 0 退出，且非托管时照旧先杀掉
守护循环再退出，`关闭主程序` 的既有语义不变。

### 关键设计决定

1. **只管理自己的子进程**：壳保存 worker 的 `Child` 句柄，退出时丢弃其 stdin（触发孤儿守卫），
   超时才 `taskkill /PID <本子进程> /T /F`。全程不按进程名或命令行模糊查杀。
2. **托管模式去掉全局守护清理**：`WHALEBRIDGE_SUPERVISED=1` 时 `/api/shutdown` 跳过
   "杀掉机器上所有命令行含 start.bat 的 cmd.exe"（原实现在多实例/桌面场景会误伤用户另外用
   start.bat 跑着的实例）。这条是阶段 4 记录的风险，现已收敛。
3. **孤儿守卫用 stdin 而不是 Job Object**：worker 在托管模式下把 stdin 当父进程存活凭据；
   壳被任务管理器强杀时管道关闭 → worker 优雅退出并释放锁。相比 Windows Job Object，
   它不需要额外系统依赖，且能用真实进程行为验证（见验证记录）。
4. **窗口先起、后切控制台**：先创建状态页窗口（避免启动期无界面），健康后就地 `navigate`
   到控制台；失败则留在状态页显示原因、日志路径与控制台端口。
5. **关闭窗口 = 隐藏到托盘**（工作簿 §4.1 记录的默认设计）；托盘菜单：显示主窗口 /
   在系统浏览器中打开 / 重启桥接 / 打开日志目录 / 退出。「退出」才真正结束程序并停止 worker。
6. **数据目录与 worker 同源**：壳用与 `src/app-paths.js` 相同的优先级解析数据目录，并把它作为
   `WHALEBRIDGE_DATA_DIR` 注入 worker 环境，避免壳与 worker 对"数据在哪"产生分歧。
7. **日志**：worker 的 stdout/stderr 直接追加写入 `<数据目录>\logs\worker.log`（append 模式，
   重启不丢历史）；壳自身的状态流转写 `<数据目录>\logs\desktop-shell.log`。
   release 构建是 GUI 子系统没有 stdout，因此自检输出同时写入该日志。

验证记录（2026-09-20）：

- `npm run test-desktop-shell`（12 项全通过，全部使用临时数据目录 + 临时端口）：
  - `--print-core-command`：开发模式带入口脚本、发布模式 `args=["--worker"]`、
    数据目录优先级与 `consolePort` 解析正确；
  - `--smoke-test`：worker 拉起并在 ~520ms 内健康，worker/壳日志与锁文件就位；
  - **重启链路**：外部 `POST /api/restart` → worker 以退出码 10 退出 → 壳在 **791ms** 内换新
    pid 重新拉起（断言 <5000ms，用于区分"立即重启"与"异常退避重启"），bridge 日志出现
    `重启桥接（exit 10）`，自检计数 `spawn_count_after_supervise=2`；
  - **端口冲突**：端口被占用时 worker exit 2 → 壳判定"已有实例在运行/端口被占用"、
    不重启（`spawn_count=1`）、退出码 4；
  - **GUI**：真实创建窗口（标题「鲸桥 WhaleBridge」，说明托盘与 WebView2 初始化成功）、
    就绪后窗口切换到控制台且控制台由壳拉起的 worker 提供服务；
  - **孤儿守卫（进程级）**：`taskkill /F` 只杀壳、不连带子进程 → worker 仍存活 → 因 stdin
    关闭自行优雅退出，worker 日志出现 `启动器已退出（stdin 关闭）`、锁文件被释放；
  - 测试结束后没有 `whalebridge-desktop.exe` 残留进程。
- `npm run test-desktop-supervisor`（5 项）：`WHALEBRIDGE_SUPERVISED=1` 的托管契约——
  孤儿守卫、`/api/restart` 退出码 10、托管 `/api/shutdown` 退出码 0 且**跳过全局清理**
  （日志留痕），并断言非托管默认行为不变、源码层面 `/api/shutdown` 的全局清理只在非托管分支。
- `cargo test` 27/27：新增 `decide_restart` 退出码契约、退避序列 5/10/20/30 封顶、
  稳定 60 秒后失败计数清零、状态是否需要人工处理、健康探针（本地 TcpListener 真连）、
  数据目录优先级（`--data-dir` > 环境变量 > `portable.flag` > `%LOCALAPPDATA%`）、
  `config.json` 端口解析（含 BOM、缺字段、损坏、缺失四种情况）。
- 编写时未做：托盘菜单项的实际点击、WebView2 交互细节（缩放/复制/外链/同源弹窗）；用户后来于 2026-09-21 确认原开发内容整体验收完成，此处不补造逐项测试证据；
  WebView2 Runtime 缺失时的引导安装归阶段 7 安装器；图标仍是 32×32 占位图（`build.rs` 生成）。

退出条件：用户无需 BAT/VBS、终端或浏览器即可完成日常使用。→ 进程与窗口链路已自动化验证；
托盘交互曾列为人工验收项，阶段 8 后经用户整体验收确认关闭。


### 阶段 7：迁移器、安装器和卸载器

状态：`完成（安装引擎与全生命周期自动化验证通过；NSIS 安装包外壳按品牌/签名决策延后，见下）`

任务：

- [x] 安装目录和用户数据目录；
- [x] 开始菜单/桌面快捷方式；
- [x] 旧配置发现和确认迁移；
- [x] 迁移备份与回滚；
- [x] 修复安装；
- [x] 升级覆盖规则；
- [x] 卸载保留数据；
- [x] 可选移除 DSH 集成；
- [x] 构建时敏感文件排除检查。

实现结构：

```text
desktop-shell/src/
  installer.rs    安装/修复/卸载的计划与执行：effect 列表 + 快照回滚 + 安装清单归属
  migrate.rs      旧数据发现、校验、备份式迁移（不含覆盖）
  install_cli.rs  --install / --repair / --uninstall / --migrate 命令行
src/dsh-integration.js  planDshRemoval / runDshRemoval（卸载器复用，只删本应用拥有的内容）
scripts/build-core.mjs  发行产物审计：禁止项、构建机路径、本机凭据泄漏
```

安装布局（实际）：

```text
<安装目录>（默认 %ProgramFiles%\WhaleBridge）
  WhaleBridge.exe          桌面壳（同时也是安装器/卸载器：--install / --uninstall / --repair / --migrate）
  WhaleBridgeCore.exe      Core
  resources\               只读资源
  runtime-manifest.json
  install-manifest.json    安装清单：本应用装了哪些文件 + sha256（卸载只删清单内且未被改过的）
<payload>\                  安装来源：安装包解压出的 payload\（含 Core exe 与 resources\）
```

### 关键设计决定

1. **安装器 = 桌面壳自己的一个模式**，不额外引入安装器二进制：`WhaleBridge.exe --install`。
   卸载由同一个 exe 完成（`--uninstall`），开始菜单与注册表 `UninstallString` 都指向它。
2. **卸载助手**：从安装目录内运行时，exe 无法删除自己。此时自动复制自身到 `%TEMP%` 并以
   `--wait-pid <原 pid>` 重新执行，由副本等待原进程退出后完成卸载，最后自删。
3. **归属模型与 DSH 集成一致**：`install-manifest.json` 记录本应用放置的每个文件及其 sha256；
   卸载只删除"清单内且哈希未变"的文件；用户改过的、以及非本应用放置的文件一律保留并提示。
4. **升级与修复都刷新清单**：修复会重写文件，若不刷新清单，下次卸载会拿旧哈希误判成"用户改过"
   而拒绝删除（实测踩到过，已修）。
5. **绝不覆盖用户数据**：`config.json` 只在首次安装（目标不存在时）从 `config.example.json` 生成；
   升级、修复、重装都不碰它；`--remove-data` 是显式选项且会再次警告。
6. **迁移默认不覆盖**：目标已存在同名文件时保留目标并说明来源里也有一份；迁移前校验 JSON；
   畸形 JSON 跳过；外部工具路径（ffmpeg/DSH/SnowLuma/sessionCwd/localDirs）不存在时只告警不改写；
   敏感项只提示"包含 consoleToken"而不打印内容；旧目录保留不删。
7. **卸载后的空目录逐级清理**：删完文件后按深度倒序清理被删空的子目录（`resources\public` 等），
   最后才清安装目录本身——否则安装目录非空、删不掉（实测踩到过，已修）。
8. **构建时审计**：`build:core` 第 6 步扫描 resources 是否混入 `config.json`、`state/`、日志、
   `.node`/`.dll`、SnowLuma 相关文件、令牌/凭据文件；扫描 bundle 与 exe 是否含构建机绝对路径；
   并用本机真实 `config.json` 里的 `consoleToken`/`accessToken` 做"凭据是否被误打包"的对照检查。

### NSIS 安装包外壳：为什么延后

工作簿 §0 记录 `WhaleBridge-Setup-x64.exe` 是最终发行物，但 Windows App ID（当前仍是
`local.whalebridge.prototype`）与签名主体尚未确认，正式图标也还是占位图。现在启用 Tauri 的
NSIS 打包只能产出一个未签名、无正式品牌、装完仍需人工确认的安装包，收益低于风险。
安装器引擎、payload 布局（`payload\` → 安装目录）与计划/回滚机制都已就绪，
阶段 8/9 确定品牌与签名后只需：`bundle.active = true` + `targets: ["nsis"]` +
`installerHooks`（`customInstall` 调用 `WhaleBridge.exe --install --dsh-profile <profile>`，
`customUnInstall` 调用 `--uninstall`）+ 把 `dist/core` 映射进 `payload\`。

验证记录（2026-09-20，`npm run test-desktop-install`，全部在临时沙箱内）：

- **新装**：`--dry-run` 零写入；真实安装后程序文件 / resources / 数据目录（含首次 config.json）/
  开始菜单与桌面快捷方式 / HKCU 卸载项 / 安装清单全部就位，清单记录 ≥5 个文件哈希；
- **幂等**：重复安装不改变已就位内容；
- **升级**：换一份新 payload 后 `--install` 识别到已安装版本并更新程序与 resources，
  **用户改过的 config.json 原样保留**；
- **修复**：删掉 Core exe 后 `--repair` 补齐，安装清单同步刷新（哈希与磁盘一致）；
- **迁移**：候选发现只报告不修改；`--from` 迁移 state/roles 成功，已存在的 config.json 不覆盖，
  畸形 JSON 跳过，`sessionCwd` 不存在时告警，**敏感值不出现在输出里**，旧目录保留；
- **卸载（默认）**：程序文件/快捷方式/注册表项清除，数据目录与 state 完整保留；
- **重装**：程序重新就位，原配置与数据继续可用；
- **卸载助手**：从安装目录内运行 `--uninstall` 时改用 `%TEMP%` 副本完成，原 exe 被删除，
  数据保留，助手自身也被清理；
- **彻底卸载**：`--remove-data` 删除数据目录并清空安装目录；
- **无残留**：无卸载助手/桌面壳进程、无注册表键残留、`%TEMP%` 无助手副本。

其他验证：

- `cargo test` 37/37：新增安装生命周期（新装→加密检查→修复→卸载保留数据→重装→彻底卸载）、
  用户改动保护、失败回滚（注入故障后目录树与执行前一致）、SHA-256 标准向量、
  链接删除不跟随目标、快捷方式创建、迁移计划（不覆盖/畸形 JSON/敏感项/外部路径）、
  安装器参数解析。
- `npm run test-dsh-integration` 新增卸载用例：preset/插件/MCP 条目只删本应用拥有的，
  用户改过的 preset 与用户自建条目保留，重复卸载是空操作。
- `build:core` 产物审计：注入 `public/debug.log` 与 `public/state/sessions.json` 后构建
  **按预期失败**并逐条列出原因；清理后重新构建通过，并确认本机真实 `consoleToken`
  未出现在 bundle/exe 中。
- 回归：test-core-dist、test-desktop-supervisor、test-desktop-shell、test-core-entry、
  test-app-paths、test-card 134/134、test-privilege 31/31、test-local-services 43/43、
  test-stickers 40/40、test-forward 25/25、test-vision 7/7、test-wait、test-md 全部通过。

未做（如实记录）：

- 未产出 `WhaleBridge-Setup-x64.exe`（原因见上）；未在本机真实安装——测试全部沙箱化，
  真实安装会写 Program Files / 开始菜单 / HKCU，这一步需要用户决策；
- 正式图标、版本资源、Authenticode 签名与 Defender 验证；
- 升级时替换"正在运行的桌面壳 exe"仍不支持（安装器会跳过正在运行的自身，与常规 Windows
  安装器一样需要先退出程序）；自动更新不在本阶段范围。

退出条件：干净安装、覆盖升级、卸载、重装和旧数据迁移全部通过。→ 已在沙箱内全部通过；
真实机器上的安装/卸载与 NSIS 外壳归阶段 8/9（需先确认品牌与签名）。


### 阶段 8：全功能回归与发布候选

状态：`用户已确认原桌面版开发内容验收完成（2026-09-21）。本节未勾选项保留当时的验证分类和记录，不再表示阶段仍等待验收。`

> 下方勾选状态记录了编写时自动化测试和环境覆盖情况。用户已确认原开发内容验收完成；没有提供逐项新证据的项目仍按原文记为“未在当时自动化验证”，不推断其具体环境或发行条件已经测试。

任务：

- [ ] Windows 10 x64 —— **无法在本机验证**（本机为 Windows 11 22631，需要另一台机器）
- [x] Windows 11 x64（本机即 Win11，全部自动化用例都在此通过）
- [x] 无系统 Node（隔离 PATH；发行配置下核心与桌面壳均不解析到 node.exe）
- [x] 中文用户名与含空格路径（沙箱路径刻意使用「鲸桥 发布 候选 测试\程序 安装 目录」）
- [x] 普通用户权限（本机账号即非提升用户；运行期不需要管理员，安装目录保持只读）
- [x] DSH 缺失（本机 DSH 未运行，全部用例在 DSH 缺失状态下通过）
- [ ] DSH 存在且运行中 / 旧集成 —— 需要重启用户 DSH，属用户验收项
- [ ] SnowLuma Full/Lite/缺失/运行中 —— 启停用户服务属用户验收项（检测能力已有自动化测试覆盖）
- [ ] 四种模式（chat/closed-agent/reserved/reserved2）—— 需要真实 QQ + DSH 会话
- [ ] 全部 MCP 工具 —— MCP 侧已有真实 stdio initialize/tools-list/call 测试；
      在真实 DSH 会话里逐个调用属用户验收项
- [ ] 图片、文件、音频、卡片和审批 —— 需要真实 QQ 会话
- [ ] DSH/SnowLuma 重启恢复 —— 需要真实服务
- [x] 崩溃恢复和单实例（发行配置下端到端：强杀 Core → 5.9s 退避重启；第二次启动静默退出）
- [x] 迁移和升级（阶段 7 沙箱全生命周期 + 本阶段发行包安装/卸载）
- [ ] 安装包签名、许可证、SBOM 和哈希 —— SBOM/许可证清单/哈希已生成；
      **签名被阻塞：没有代码签名证书**

### 本阶段新增的产物与命令

```text
dist/app/                        发布候选（npm run build:release）
  WhaleBridge.exe                release 桌面壳（安装器/卸载器同体）
  payload/                       Core（Node SEA exe + resources\）
  INSTALL.txt                    安装/卸载/迁移说明（含普通用户的目录建议）
  licenses/THIRD-PARTY.md        第三方组件清单（含"再分发前必须补齐"）
  licenses/README.md             再分发注意事项
  SHA256SUMS.txt                 全部产物的 sha256
  sbom.json                      CycloneDX 1.5 最小 SBOM（13 个组件）
  release-manifest.json          版本/体积/哈希/审计结论/knownDeviations/notVerified
```

- `npm run build:release`：组装 RC + 生成 SBOM/许可证/哈希 + 发行审计。
- `npm run test-release-candidate`：用 RC 跑真实发行配置（见下）。
- `npm run desktop:build` 改为经 `scripts/build-desktop.mjs` 调用 cargo，注入
  `--remap-path-prefix` 以减少产物中的本机路径痕迹。

验证记录（2026-09-20，`npm run test-release-candidate`，全程沙箱 + 隔离 PATH）：

- **安装**：`--dry-run` 零写入；中文+空格路径下安装成功（程序、Core、resources 就位）；
- **运行**：桌面壳拉起的是 `WhaleBridgeCore.exe`（**不是 node**），控制台 401/200 正常，
  后代进程里没有任何 node.exe；
- **只读安装目录**：运行前后安装目录逐字节不变，运行数据全部落在用户数据目录；
- **崩溃恢复**：强杀 Core 后 **5947ms** 内按退避自动拉起新进程，控制台恢复可用
  （断言 ≥4000ms，用于确认走的是退避而不是立即重启）；
- **单实例**：第二次启动静默退出（退出码 0）并激活已有窗口，仍只有一个 Core worker；
- **孤儿守卫（发行配置）**：强杀壳后 Core 自行退出，无残留进程；
  > 稳定性复跑时本项曾失败一次（Core 未在 20s 内退出），据此给孤儿守卫加了第二道保险：
  > 除 stdin EOF 外每 5 秒检查一次父进程是否仍存在（`process.kill(ppid, 0)`），父进程消失即优雅退出。
  > 加保险后连续 4 次运行全部通过。
- **卸载**：程序清除、用户数据保留、无残留进程。

`npm run build:release` 的发行审计结果：

- payload 与 Core exe：无禁止文件、无构建机路径、无本机凭据（与真实 config.json 对照）；
- **已知偏差（已记入 release-manifest.json 的 knownDeviations）**：`WhaleBridge.exe` 内含一处
  构建机仓库路径字符串。Tauri/Cargo 把 crate 目录作为**字符串字面量**写进二进制，
  `--remap-path-prefix` 与 `strip` 都无法清除（已实测）。影响仅限暴露构建机的目录布局，
  不含用户数据或凭据；正式发布前随版本资源一并处理（例如改到 CI 的干净工作目录构建）。

### 必须由用户完成的验收（本阶段无法自动化，原因逐条列出）

| 项 | 为什么不能自动化 | 建议做法 |
|---|---|---|
| 真实安装到本机 | 会写 Program Files / 开始菜单 / HKCU，且本机是普通用户账号 | 先 `--install --dry-run`，再决定是否 `--install --install-dir <可写目录>` |
| Windows 10 x64 | 本机只有 Windows 11 | 在 Win10 机器上跑 `test-release-candidate` 与安装验收 |
| 四种模式 / 全部 MCP 工具 / 媒体 / 卡片 / 审批 | 需要真实 QQ 账号与 DSH 会话，且会操作用户的聊天 | 在测试群里按 §11.2 手工清单逐项确认 |
| DSH/SnowLuma 重启恢复 | 需要重启这两个真实服务 | 用户择时重启并观察桥接是否自动恢复 |
| 托盘菜单点击 / WebView2 交互 | 需要人工 GUI 操作 | 按 §11.2 手工清单确认 |
| 代码签名 / 版本资源 | 没有代码签名证书，版本资源尚未定稿；正式 C4 图标已于 2026-09-22 接入 | 确定签名主体后执行 |

未验证项同时写入 `dist/app/release-manifest.json` 的 `notVerified`，随发行物一起传递。

### 阶段 8 补充：真机使用中暴露的缺陷修复（2026-09-20 ~ 09-21）

用户在实际安装并运行 release 构建的过程中暴露了 7 个缺陷 + 1 个第三方链路问题。
完整表格（现象 / 根因 / 修复 / 验证状态）见 `docs/DESKTOP_APP.md` §12，此处只列要点：

> 以下“待人工确认/未决”是撰写时的调试记录。原开发范围后来由用户整体验收关闭；不据此宣称每项细节均单独验证或缺陷均按后续设计修复。若阶段 10 仍涉及相应能力，在新架构验收中重新检查。

- 修复并验证：导航把自家状态页误判为外链（会弹浏览器）、Core 分配控制台窗口（启动弹黑框）、
  迁移不认占位配置（真实配置被静默跳过）、迁移备份目录落在 `%ProgramFiles%`（拒绝访问）、
  SnowLuma 重复拉起（TCP 探测复用）、DSH 占用导致升级失败（占用检测 + `--stop-core`）；
- 修复但优雅路径待人工确认：退出时改为**同步**停止 Core（此前异步线程可能在进程退出前来不及跑，
  实测攒出过 5 个孤儿 Core）；强杀路径已验证「孤儿 Core = 0」；
- 未决：QQ 进程注入 —— 日志确认 QQ 由 explorer 启动，而注入要求由 SnowLuma 自己拉起 QQ；
  注入是 OneBot API 上线的必要步骤，因此该环节不通过时桥接必然连不上。操作顺序与排查方向见
  `docs/DESKTOP_APP.md` §12.1；待办是给控制台加「退出指定 QQ 实例并交给 SnowLuma 重新注入」按钮
  （前端改动，必须走基线 + `fuse-console.mjs` + `check-fusion.mjs` 流程）。

**暴露的测试盲区**（重要）：先前所有自动化测试都跑 **debug 构建 + node 源码模式**，
而 release 构建是 GUI 子系统、Core 是打包后的控制台程序 —— 上面第 1、2 条正是在这个组合下才出现。
已补 release 专项检查（打印 Core 直接子进程与完整后代、断言无 conhost），
但 `test-desktop-shell` 的 GUI 用例在「用户正开着应用」时无法运行（单实例互斥量），
需先退出应用再跑；这一点已在测试里做显式跳过并打印原因，避免误报失败。

退出条件：发布清单无阻断项，用户确认候选版。→ **用户确认原开发内容验收完成（2026-09-21）**。原始验证范围及限制保留作历史记录；新一轮无网页化有独立的阶段 10 验收标准。


### 阶段 9：文档收口和删除本文件

状态：`阶段 0–9 的正式文档收口已完成；因新增阶段 10，按用户要求继续保留本文件，待阶段 10 完成后再删除。`

任务：

- [x] 将最终架构写入正式项目指南 → 新建 `docs/DESKTOP_APP.md`（架构、路径契约、进程与退出码、
      SEA 打包约束、构建发布、DSH 集成、安装/迁移/卸载、故障排查、测试矩阵、决策记录、
      当前状态与未验证项），并在 `docs/PROJECT_GUIDE.md` 与 `README.md` 顶部加了入口；
- [x] 将安装、迁移和故障排查写入正式 README/docs → `docs/DESKTOP_APP.md` §7/§8 与
      `README.md` 的「安装与卸载」「发布候选」两节；
- [x] 将构建和发布步骤写入维护文档 → `docs/DESKTOP_APP.md` §5；
- [x] 确认本文件没有独有的必要信息 → 见下方审计结论；
- [ ] 删除 `DESKTOP_APP_WORKPLAN.tmp.md` —— **顺延到阶段 10 验收与文档迁移之后**；
- [ ] 阶段 10 完成后确认新架构、验收状态和运行维护信息已转入正式文档，再独立删除本文件。

审计结论（2026-09-20）：阶段 0–9 原开发范围中**必要**的内容已转入正式文档——14 条 ADR 全部进入
`docs/DESKTOP_APP.md` §10 的决策记录表；退出码契约、路径优先级、SEA 打包的 `import.meta` 陷阱、
安装/卸载语义、故障排查、测试矩阵均已在 §2~§9 落地；逐阶段实现细节属于开发历史，
`AGENT_CONTEXT.md` 的 T17~T24 步骤记录已覆盖其要点。阶段 8 的原始逐项验证记录仍保留在本文件中；
用户已于 2026-09-21 确认原开发内容验收完成。

**为什么现在不删除**：用户要求将无网页原生化方案整理进这份临时工作文档。为让后续阶段有统一的
实现、决策和验收跟踪位置，本文件继续保留；待阶段 10 完成且新内容转入正式文档后再按 ADR-005 删除。

阶段 10 完成后的删除步骤：

1. 将阶段 10 的最终架构、迁移结果、验收状态和遗留事项更新进正式文档；
2. `git rm DESKTOP_APP_WORKPLAN.tmp.md`（或先 `git add -A` 再在同一提交里删除），
   提交信息写明无网页原生化工作台收口；
3. 确认正式文档准确记录了哪些环境经过测试，未验证限制没有被误写为已验证。

退出条件：阶段 10 完成，临时工作文档中的必要信息已迁入正式文档并删除本文件。→ **未达成**（阶段 10 尚未开始）。

### 阶段 9 补充：正式应用图标落地（2026-09-22）

状态：`C4「浅色简洁苏打」已接入现有发行基线；阶段 10 原生 UI 继续复用同一品牌源图。`

- 选择结果：保留 C「双向连接」的双形结构，采用 C4 的浅紫薄荷底与蓝青双色；
- 正式源图：`desktop-shell/icons/source-c4.png`；候选原图继续保留在 `output/imagegen/`；
- `scripts/build-app-icons.ps1` 可复现生成 16/20/24/32/40/48/64/128/256 九层
  `icon.ico`、Tauri 标准 PNG、桌面内页与 `public/` 品牌图；
- `desktop-shell/build.rs` 已删除阶段 1 的程序化 32px 占位图，EXE、窗口和托盘统一使用正式 ICO；
- IExpress 无自定义图标参数，因此 `scripts/set-exe-icon.ps1` 在封装后、签名前替换全部
  `RT_GROUP_ICON` 资源；应用 EXE 与单文件安装器现使用同一 C4 图标；
- 安装向导、启动状态页、控制台和令牌登录页已替换原来的 SVG / `Q` 占位标志；控制台改动进入
  `design-demos/bg-ripple/tools/fixtures/` 唯一基线，并通过三条融合硬校验；
- 验证：`npm run test-app-icon`、`npm run test-installer-package` 通过，`cargo test` 44/44；release
  应用 EXE 与安装器提取图标的 SHA-256 完全一致，并已重建 `dist/app`；新的单文件安装器继续通过
  `npm run test-release-candidate` 的真实安装、启动、恢复、单实例、孤儿守卫与卸载全链路；
- 尚需人工确认：Windows 任务栏、托盘溢出区、桌面快捷方式在 100%/125%/150% 缩放下的实际观感；
  版本资源与 Authenticode 签名仍未完成。


### 阶段 10：原生 UI 与无网页化改造（后续计划）

状态：`实施中（按用户要求转为一次性交付目标；原生壳、IPC、安装向导与固定诊断已接通，现有核心管理页通过真实子进程 smoke；旧控制台其余功能、托盘、ACL 真机验收和新发行包仍待完成）。`

#### 10.1 目标与范围

将 WhaleBridge 的安装、首次配置、运行、状态监控、审批、设置和维护全部放入原生 Windows 应用。最终产品运行时不得依赖：

- WhaleBridge 自己的 HTML 页面或静态网页服务器；
- 系统浏览器或浏览器自动化；
- Tauri/Wry/WebView2、CEF、Electron 等网页渲染容器；
- 安装器、登录页、状态页或子服务监控页中的 HTML UI。

本计划中“无网页”指**不依赖网页用户界面**，不指删除后台网络协议。DSH RPC/WebSocket、SnowLuma OneBot HTTP/WebSocket、模型 API、下载和可选 `web_search`/`web_fetch` 仍是程序间或互联网数据接口，不要求人工打开网页。把这些后台协议也全部去掉，需要替换 DSH 与 SnowLuma 两套运行时，当前不纳入本次计划。

#### 10.2 建议架构

```text
WhaleBridge.exe（原生 Rust GUI，eframe/egui）
  ├─ 安装 / 修复 / 卸载模式：原生安装界面，复用现有 Rust 安装业务
  ├─ 主窗口：状态、配置、会话、提问、审批、日志、诊断、托盘
  └─ 本机 IPC 客户端
          │ Windows Named Pipe（版本化 JSON 请求、响应、事件）
          ▼
WhaleBridgeCore.exe（现有 Node SEA worker）
  ├─ ControlService：与传输方式无关的控制业务和权限校验
  ├─ Bridge：QQ/OneBot ↔ DSH 会话与社交业务
  ├─ DSH adapter：RPC、模型/凭据设置、提问/审批事件
  ├─ SnowLuma adapter：探测、账号/进程、注入和 OneBot 配置
  └─ Agent IPC：MCP 使用的单独低权限命名管道能力
          │ HTTP / WebSocket 后台接口
       ┌──┴─────────────────────┐
       ▼                        ▼
   SnowLuma                   DSH Headless Runtime
```

- **界面建议：**以 `eframe + egui` 做原生窗口，替换 Tauri/Wry。它与现有 Rust 安装和进程监管代码同语言，支持 Windows 原生窗口且不运行 WebView。先做一个短期技术验证，确认中文字体/IME、DPI、可访问性、日志表格、复制粘贴和托盘体验，再锁定具体渲染后端。
- **进程协议：**桌面端与 Core 用用户 SID 限定的 Windows Named Pipe。帧使用长度前缀 JSON，消息携带协议版本、请求 ID、方法名和结构化参数；状态变化、日志和审批通过订阅事件推送。每次连接进行协议版本协商，未知版本/方法拒绝执行。
- **能力分区：**UI 管理管道提供完整的本机管理命令；MCP 使用独立 Agent 管道，只开放现有 QQ/社交白名单数据能力。终端、安装、关闭应用、修改安全设置不得从 Agent 管道暴露。
- **业务抽取：**先从 `src/bridge.js` 的 HTTP 路由中抽出 `ControlService`，让 HTTP 适配器、命名管道适配器共用相同业务逻辑、权限判断、输入校验和错误结构；迁移期间保留旧控制台以便回滚。
- **Supervisor：**健康检查改为 Core IPC `ping`/版本握手，不再以控制台 HTTP 端口作为 worker Ready 条件。保留当前单实例、进程句柄监管、崩溃退避、孤儿守卫和退出码语义。
- **DSH：**继续以 headless 服务运行，通过现有 RPC/事件流创建会话、投递 prompt、选择模型、接收提问和审批；原生设置页通过 DSH settings/credentials/LLM RPC 配置本项目需要的 Provider、密钥、模型与 preset。身份认证由现有 `dsh-auth.js` 适配，不使用页面 DOM 或浏览器自动化。模式以 WhaleBridge state 为准，移除对 `whale-mode-console` 页面插件的运行依赖。
- **SnowLuma：**新增版本受控的管理 API 适配器和原生首次运行向导，承接协议同意、管理鉴权、密码设置、自动注入、QQ 进程加载/登录探测、OneBot HTTP/WS 配置、token 对齐及连接验证。优先走当前版本提供的管理 API；不支持的 SnowLuma 版本明确提示并停止自动写入，不以网页自动化或直接猜测内部文件格式兜底。
- **安装器：**复用 `installer.rs`、数据迁移、安装归属清单和卸载逻辑；把 `installer.html` 改成原生安装窗口，确保安装前、安装中和卸载中都不需要 WebView。

#### 10.3 迁移原则与旧范围处理

- 先抽业务服务，再接新 UI。禁止把当前数百个 HTTP 处理分支直接搬进 Rust GUI 或复制第二套业务实现。
- 以现有 `/api/*` 行为和状态文件为迁移基线；迁移时保持模式、白名单、角色、审批、会话映射、日志、黑话、记忆、表情、卡片风险策略和 MCP 工具语义。
- 所有读写权限和风险校验最终在 Core 的业务层执行，不能只依靠 GUI 隐藏按钮。
- `public/console.html`、`public/token-login.html`、`public/dsh-monitor.html` 与 `desktop-shell/ui/index.html`、`status.html`、`installer.html` 都属于迁移范围；设计样稿和历史 fixture 可以留在仓库，但不进入发行资源、不参与构建或运行。
- 原有“打开 SnowLuma 网页 / 打开 DSH WebUI”按钮改为原生配置/监控操作；常规流程不启动系统浏览器。用户主动点外部文档链接可作为非核心辅助功能，但任何必需设置都必须能在应用内完成。
- 原控制台任意命令终端具有较高权限。用户已选择将其替换为白名单诊断命令与只读日志，不保留任意 shell/ConPTY 执行；诊断动作限于应用状态、配置校验、服务连通性和路径/权限检查，不能执行任意命令或扩大到 Agent 管道。
- 已记录的“QQ 注入”控制台按钮待办改为原生 `SnowLumaAdapter` + 向导能力，不再扩充旧 HTML 控制台。
- 阶段 8 已有测试是旧 WebView2 架构的历史验收，不删除也不改写。阶段 10 逐项增加相应原生/IPC 覆盖，阶段完成后把正式文档里的 WebView2 当前架构改为历史迁移说明。

#### 10.4 分段实施

| 子阶段 | 工作内容 | 退出条件 |
|---|---|---|
| 10.0 范围冻结与技术验证 | 盘点 HTTP 路由→页面功能映射、安装器和所有 HTML 入口；固定控制命令/事件 schema；用 egui 做中文/DPI/IME/大日志原型；验证 Rust ↔ Node 命名管道和权限边界；确认终端是 ConPTY 还是受限诊断替代 | 一页架构 ADR、命令契约草案、可运行原型、明确终端范围 |
| 10.1 抽取 ControlService | 将 bridge.js 的控制路由拆为业务命令；HTTP 路由只保留解析、调用、响应；统一参数校验、权限、错误和审计 | 旧控制台仍可使用；Service 单独可调用；无权限操作在业务层拒绝 |
| 10.2 建立 IPC 与 supervisor | Core 提供版本化 UI 管道和限权 Agent 管道；桌面端连接/重连、请求关联、事件订阅；Supervisor 改 IPC 健康握手 | 可在不启动控制台 HTTP/网页服务器时拉起 worker、显示 Ready、断线重连和受控退出 |
| 10.3 原生桌面壳与安装器 | 用原生 Rust GUI 替换主窗口、启动状态窗口和安装页；复用安装器、迁移、修复、卸载、托盘和单实例逻辑 | 干净 Windows 安装不需要 WebView2；安装/主界面/状态窗口无 HTML 渲染 |
| 10.4 MVP 管理界面 | 实现仪表盘、SnowLuma/DSH 服务、QQ 连接、日志、模式、角色、静默、Owner/白名单、模型与 API Key、preset、诊断向导 | 首次安装可完成基础配置；真实 QQ 消息能到 DSH 并返回 QQ |
| 10.5 完整功能迁移 | 迁移会话、提问/审批、reserved2、黑话、记忆、表情、卡片按钮审批、文件/音频/酷狗、配置管理和数据导入；UI 订阅 Core 事件而非轮询页面端点 | 原桌面版功能清单逐项有原生操作及回归证据；高风险写操作继续二次确认 |
| 10.6 MCP 与高级运维迁移 | 让 MCP 通过限权 Agent 管道访问 Core；实现或确定命令终端替代；更新 DSH 集成安装和卸载脚本，兼容升级中的旧 HTTP MCP | MCP stdio 工具契约保持；Agent 无管理管道权限；数据 API 不再依赖 consolePort |
| 10.7 移除网页运行时并发行验收 | 删除旧控制台服务器/登录/监控页面路由、静态 HTML 发行资源、WebView2/Tauri/Wry依赖和控制台令牌；更新 SBOM、许可和安装审计 | §11.3 无网页验收矩阵通过；真实 QQ/DSH/SnowLuma 首次配置和升级迁移通过 |

**阶段 10.0 实施记录（2026-09-22）**

- 新建隔离原型 `desktop-shell/native-spike/`：使用 eframe/egui 的 Windows 原生窗口，包含中文输入框、复制按钮和 20,000 行虚拟滚动日志；不接入已验收的 Tauri 主程序。
- 原型协议：长度前缀（4 字节 little-endian）JSON；含版本、请求 ID、方法和参数；1 MiB 帧上限；客户端连接超时 3 秒。Node mock 验证 `ping`/`pong` 往返，`node desktop-shell/native-spike/test-pipe.mjs`（内部 `cargo run --locked`）输出 `IPC_SMOKE_OK`；`cargo fmt --check` 与 Node 语法检查通过。
- 依赖边界：Windows x64 目标的正常依赖树未发现 Tauri、Wry、WebView、Web 浏览器、CEF 或 Electron 依赖；本原型不包含已验收桌面壳的 Cargo 配置。
- 该结果只证明本机同用户进程的初步互通与原生窗口代码可构建，**不证明**命名管道 ACL、跨用户拒绝、Core 重启重连、Supervisor Ready 切换、DPI/IME 手工体验或最终框架选型。
- 当前未完成：需在实际窗口核验中文字体/IME、DPI、复制粘贴与大日志性能；确认 Windows 命名管道安全描述符与用户 SID；冻结终端方案。现有计算机使用工具未提供本机窗口枚举能力，因此此轮未做 UI 手工验收。根据用户“下一阶段”指示，已开始阶段 10.1 中与上述决策无耦合的控制面抽取；在 10.0 安全/体验门槛确认前不进入 10.2。

**阶段 10.1 首个切片（2026-09-22）**

- 新增 `src/control/control-service.js`，将角色设置域的 `GET /api/roles`、`POST /api/role`、`POST /api/role-mode` 分别抽为 `role.list`、`role.set`、`role.setMode`；Service 只依赖注入的角色列表/存在检查/名称清洗、状态读写和日志端口，不引用 HTTP/Node Request/Response。
- 旧 HTTP 适配器继续承担 JSON 解析、token/CSRF/Origin 校验与响应状态码；由中间件得出的可信 `privilege` 形成 actor，不能从请求体接受权限。稳定 Service 错误码由适配器映射为原 HTTP 状态码。
- 保留既有语义：角色名先清洗再检查；缺省、空或非字符串角色值清除当前角色；切换角色/静默模式均保留另一项状态；仅精确 `silent` 打开静默。Agent/MCP 白名单仍拒绝三个管理路由，Service 也独立拒绝非控制台 actor。
- 角色列表仍通过既有 `listRoles()` 注入，因此内置/用户角色并集、排序和 README 排除行为不变；文件创建 `POST /api/roles/create` 与全局运行模式 `POST /api/mode` 明确不在本切片内。
- 保留一项既有边缘行为：列表排除 `README.md`，但选择校验仍委托 `resolveRoleFile()`；如果该文件存在，仍可能直接选中列表不可见的 `README`。此处未借抽取改变已验收语义。
- 验证结果：`node --check src/bridge.js`、`node --check src/control/control-service.js` 通过；`node scripts/test-control-service.mjs` 角色设置用例通过；`node scripts/test-bridge-privilege.mjs` 25 通过、0 失败。该权限脚本的真实端到端 `fetch` 因当前未启动本地服务而跳过，尚未替代完整 HTTP 路由集成回归。
- 该切片不是阶段 10.1 完成：服务管理、全局模式配置及其它控制行为尚未抽取；尚未接入命名管道或启动真实 Core HTTP 路由做集成回归。

**阶段 10.1 第二切片（2026-09-22）**

- 将 `POST /api/roles/create` 抽为 `role.create`，与角色列表/选择/静默命令共用 `ControlService`；HTTP 路由现在仅负责 JSON 读取、命令调用及兼容响应。
- Service 保留原校验次序和可见语义：清洗角色名、拒绝空名/空内容/保留名 `README`、检查用户角色目录重名、trim 内容并补一个结尾换行；文件系统创建目录和原子写入通过适配层注入的窄端口完成。
- Agent/MCP 对 `POST /api/roles/create` 的拒绝已加入权限回归用例；ControlService 测试使用 fake 文件端口覆盖清洗后创建、内容格式、空名、空内容、README 和重名，并断言错误时不写文件、不记成功日志。
- 验证：`node --check` 两个模块、`node scripts/test-control-service.mjs` 与 `node scripts/test-bridge-privilege.mjs`（25 通过、0 失败）；真实 HTTP `fetch` 仍因没有运行本地桥接服务而跳过。未运行会改配置/发送真实 QQ 消息的综合 `test-console.mjs`。
- 角色管理域的四个操作（`role.list`、`role.create`、`role.set`、`role.setMode`）已抽取；阶段 10.1 仍未完成，其它控制域与真实 HTTP 集成回归尚待进行。

**阶段 10.1 第三切片（2026-09-22）**

- 将 `GET /api/security`、`POST /api/security` 抽为 `security.get`、`security.update`；HTTP 层仍负责鉴权、CSRF、JSON 解析与响应适配。
- 保留磁盘与当前进程配置的两段浅合并：更新先合并磁盘 `file.security` 并原子写完整 config，再将结果合并进内存 `cfg.security`；响应和日志使用内存合并结果。写盘失败时不更新运行时配置、不记成功日志。
- 保留 `interceptNotify` 兼容强制转换：布尔值原样保留，缺省保留磁盘原值，其它已提供值走 JavaScript `Boolean(value)`（因此字符串 `"false"` 为 `true`）；security 扩展字段及完整配置文件其它顶层字段均保留。
- Agent/MCP 对 GET/POST `/api/security` 的拒绝已加入权限测试。Service 测试覆盖 GET 默认值、磁盘/运行时字段分离合并、缺省值、true/false/null/0/空串/字符串/对象转换，以及持久化失败不改运行时/不记日志。
- `node --check` 相关模块、`node scripts/test-control-service.mjs`、`node scripts/test-bridge-privilege.mjs` 均通过；权限脚本的真实 HTTP `fetch` 因未启动本地服务而跳过。阶段 10.1 仍在进行，尚未抽取其它控制域或完成真实 HTTP 集成回归。

**阶段 10.1 第四切片（2026-09-22）**

- 将 `POST /api/slang/config` 抽为 `slang.updateConfig`；HTTP 继续负责认证、CSRF、JSON 解析和兼容响应。
- 保留配置字段合并与归一化：enabled/autoResearch 布尔语义、消息数/冷却/注入上限、preset/工作区标题清洗、阈值解析/去重/排序/默认值，以及未识别扩展字段。
- 仍先原子持久化磁盘配置，再合并到运行时 `cfg.slang`；仅当 learnerPreset 或 workspaceTitle 输入值相较旧运行时值改变时失效学习会话，并保留 preset 优先的 if/else-if 和日志顺序。
- Agent/MCP 对 POST `/api/slang/config` 继续拒绝。Service fake-port 测试覆盖字段边界、部分更新与未知字段、阈值规范化、preset/title 失效、持久化失败不更新运行时/不记日志。
- `node --check` 相关模块、`node scripts/test-control-service.mjs` 和 `node scripts/test-bridge-privilege.mjs` 通过；真实 HTTP `fetch` 因本地桥接服务未运行而跳过。阶段 10.1 仍在进行，其它控制域与 HTTP 集成回归尚待完成。

**阶段 10.1 第五切片（2026-09-22）**

- 将只读 `GET /api/sessions` 抽为 `session.list`；Service 注入会话映射和当前 ownerQQ，不依赖 HTTP，也不修改会话状态。
- 保留 `Object.entries(state.sessions)` 的插入顺序、返回结构 `{ sessions: [{ key, sessionId, owner }] }`，以及只有精确匹配 `private:${String(ownerQQ ?? '')}` 的私聊映射标记 owner 的语义；不额外排序、去重或改写 sessionId。
- HTTP 适配器继续做认证和响应；Agent/MCP 仍被白名单拒绝，权限测试已显式覆盖 `/api/sessions`。
- Service fake-port 测试覆盖 owner 私聊、群/其他私聊、未配置 owner 的情况，并确认查询不写状态、不产生日志。`node --check` 相关模块、ControlService 测试和权限回归通过；真实 HTTP `fetch` 因本地桥接未运行而跳过。
- 阶段 10.1 仍未完成：待抽取其它控制/查询路由并进行真实 HTTP 集成回归。

**阶段 10.1 第六切片（2026-09-22）**

- 将 `POST /api/social/state` 抽为 `social.setPhase`；保留兼容 HTTP 路由与 `active` / `idle` 参数、校验顺序、响应结构和日志。
- `active` 的时间戳、随机检查间隔、群聊活跃期限计算由 `ControlService` 执行，通过窄端口读配置/时间/随机数并更新原有内存状态对象，保留未触碰的扩展字段。
- `idle` 仍按既有顺序取消目标会话尚未触发的社交定时器、删除该会话状态和 silent context；不承诺中断已运行的 AI 请求，也不清理近期消息、摘要、prompt 队列等其它数据。
- 新命令仍仅允许 Console 权限；Agent/MCP 白名单明确拒绝此路由。fake-port 测试覆盖时间字段、群/私聊与 duration 禁用分支、清理范围/顺序、参数错误和授权。
- `node --check` 相关模块、`node scripts/test-control-service.mjs` 和 `node scripts/test-bridge-privilege.mjs` 通过（26 项权限/适配断言通过）；真实 HTTP fetch 因未启动本地 bridge 而跳过，没有触发 QQ 外部副作用。

#### 10.5 验收标准

阶段 10 最终验收至少满足：

1. 发布包不含 WhaleBridge UI HTML，依赖与进程树中不存在 WebView2、Wry、CEF、Electron 或浏览器自动化组件。
2. Windows 未安装 WebView2 Runtime、默认浏览器不可用时，安装、首次设置、启动、配置、审批、监控、升级和卸载仍可完成。
3. WhaleBridge worker 不监听 `consolePort`，浏览器无法访问应用管理 API；Supervisor Ready 完全使用 IPC 握手。
4. SnowLuma 从未配置环境可通过原生向导完成用户同意、QQ 注入和 OneBot 配置；DSH 从未配置环境可通过原生界面设置模型 Provider 与凭据；最终可用真实 QQ 消息完成端到端回复。
5. 旧版配置、`state/`、角色、会话映射和 DSH 集成可以安全迁移；已存在的用户配置和凭据不被静默覆盖。
6. UI 管理管道与 Agent 管道权限分开；卡片高风险按钮、发送白名单、Owner 和模式约束与既有业务规则一致。
7. 正式 README / `docs/DESKTOP_APP.md` / `docs/PROJECT_GUIDE.md` 更新为原生架构与安装步骤；旧 WebView2 决策明确归档为历史。

#### 10.6 主要风险与估算

- **功能量：**控制台约 325 KB、5000 多行，路由业务集中在 `src/bridge.js`；原生迁移需要先拆分控制面。以单人熟悉当前项目估计约 33–59 人日；如要保持任意命令终端能力并自行实现 ConPTY，额外约 4–8 人日。此估算不包含等待真实环境验收和第三方版本修复。
- **SnowLuma API 兼容：**管理接口和 EULA/登录流程需要做版本协商与适配测试。所有写配置调用需在当前服务版本上确认；不兼容时应清晰阻止并说明，不做 DOM 自动化或猜测性文件写入。
- **DSH 动态配置：**第一版只原生配置 WhaleBridge 所需的 Provider、凭据、模型和 preset；其它动态插件 schema 先只读或保留文档入口，避免做一个低质量通用 schema 表单器。更新脱敏设置使用 path mutation，避免误删未回传的 secret。
- **进程间权限：**命名管道需要验证用户 SID ACL、同名实例、重启、挂起恢复、消息长度上限和恶意/旧版客户端拒绝；MCP Agent 与 UI 不能共用同一权限令牌或能力集。
- **中文 UI 和可访问性：**必须验证中文字体/IME、系统缩放、键盘操作、复制粘贴、大量日志性能；这些是原 WebView2 方案中已有的成熟项，原生替换后要重新验收。
- **发行审计：**Core 保持 Node SEA、DSH 和 SnowLuma 外置；需新增发布规则，阻止 HTML 被打入资源、WebView2/Tauri 运行时依赖残留、consolePort 监听和打开浏览器调用。

#### 10.7 变更文件预期

- 桌面壳：`desktop-shell/Cargo.toml`、`desktop-shell/src/main.rs`、`supervisor.rs`、`installer.rs`、`tauri.conf.json`，并新增原生 UI、IPC 客户端和视图模块；最终 Cargo.toml 不再依赖 Tauri/Wry。
- Core：`src/bridge.js` 拆分出的 `src/control/*`、`src/transports/*`、`src/local-services.js`、`src/dsh-client.js`、`src/mcp-*.js`、`src/core-dispatch.js`、路径与发行构建脚本。
- 第三方接入：新增 SnowLuma 管理适配器/设置向导；DSH 原生配置/凭据和 Agent RPC 兼容层；迁移 `scripts/setup-dsh.mjs` 与 `dsh/agent-presets`/`plugins`。
- 清理范围：`public/*.html`、`desktop-shell/ui/*.html` 及旧页面服务器路由仅在阶段 10.7 删除；设计稿/fixtures 可保留为不参与构建的历史资料。
- 文档：更新 `README.md`、`README.en.md`、`docs/PROJECT_GUIDE.md`、`docs/DESKTOP_APP.md`，并在阶段结束后删除本临时文档。

---

## 11. 测试矩阵

### 11.1 自动测试

现有脚本至少全部纳入 CI：

```text
npm run self-test
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-card
npm run test-local-services
npm run test-privilege
npm run test-slang
npm run test-stickers
```

新增发行测试（阶段 4~8 已实现，状态如下）：

- [x] GUI 单实例（第二次启动静默退出且不影响已有实例）；
- [x] GUI 激活已有窗口（单实例插件回调 `show_main_window`；窗口标题已自动验证）；
- [x] WebView2 导航白名单（Rust 单元测试：仅本机 HTTP、外链交系统浏览器）；
- [x] worker 健康检查（HTTP 探针，真实端口）；
- [x] worker 正常停止（优雅停止 + 锁释放 + 无残留）；
- [x] worker 异常退出与退避（强杀 Core → 5947ms 内退避重启；退出码策略有单元测试）；
- [x] core 参数分派（`--help/--worker/--mcp/--setup-dsh/--uninstall-dsh/--self-test`）；
- [x] 每个 MCP 协议 smoke test（五个模式真实 stdio initialize/listTools/call）；
- [x] 只读安装目录（运行前后安装目录逐字节不变）；
- [x] data-dir 覆盖（`--data-dir` > 环境变量 > portable.flag > 默认，含打包分支）；
- [x] 资源释放和哈希（DSH manifest 内容哈希、安装清单哈希、SBOM/SHA256SUMS）；
- [x] DSH 集成幂等和回滚（重复执行零 effect；注入故障后目录树完全恢复）；
- [x] 旧数据迁移（发现→校验→不覆盖迁移→告警→旧目录保留）；
- [x] 安装、升级、修复、卸载（沙箱全生命周期 + 发行包真实配置）。

### 11.2 手工端到端验收

"自动化"列表示该项的**程序化部分**是否已有测试覆盖；"人工"列才是需要人确认的部分。
下表记录阶段 8 原验收清单编写时的状态；用户随后于 2026-09-21 确认原开发内容验收完成。逐项状态继续作为历史测试证据分类，不再作为阶段 8 的阻塞条件。

| 模块 | 验收场景 | 自动化 | 人工 |
|---|---|---|---|
| 桌面窗口 | 启动、登录、刷新 | ✅ 窗口创建、控制台 401/200、就绪后切换 | 缩放、复制粘贴、外链、同源弹窗未测 |
| 桌面窗口 | 托盘菜单、关闭窗口 | ✅ 关闭=隐藏到托盘、单实例、退出后无孤儿 | 托盘菜单点击未测 |
| QQ 链路 | 私聊、群聊、断线重连 | — | 未测（需真实 QQ） |
| DSH | 建会话、模型、回复、提问、审批 | MCP 侧 stdio initialize/list/call 已验证 | 未测（需真实 DSH 会话） |
| 模式 | chat/closed-agent/reserved/reserved2 | 模式读写逻辑已有测试 | 未测（需真实会话） |
| 媒体 | 图片、表情、转发、文件、音频 | 转发 25/25、表情 40/40、视觉 7/7 | 未测（需真实 QQ） |
| 卡片 | 查看、按钮、风险审批 | 卡片 134/134（含高风险默认关闭） | 未测（需真实卡片消息） |
| 社交二代 | 唤醒、潜水、未读、记忆、表情 | 等待/结束回合逻辑全部通过 | 未测（需真实会话） |
| 外部工具 | 搜索、抓取、B 站、酷狗、TTS | 搜索/抓取的安全边界已有测试 | 未测（需真实网络与账号） |
| 本地服务 | SnowLuma/DSH 检测、启动、日志 | 本地服务 43/43 | 启停真实服务未测 |
| 安全 | 权限、token、白名单、敏感拦截 | 权限 31/31、双令牌边界 | — |
| 持久化 | 重启、升级、迁移后状态一致 | ✅ 安装全生命周期 + 数据保留 | 真实环境升级未测 |
| 运维 | 崩溃恢复、诊断、修复、卸载 | ✅ 崩溃恢复/修复/卸载/单实例/孤儿守卫 | 真实机器安装未测 |

原阶段结论：程序化可验证的部分已覆盖；当时未自动化的项目集中在"真实 QQ/DSH 会话"与"GUI 交互"。
用户已确认原开发内容验收完成，但该整体确认不补造每个环境逐项实测的自动化证据。阶段 10 使用下方独立矩阵重新验收原生架构。

### 11.3 阶段 10 无网页原生化验收

本清单尚未执行，只有阶段 10.7 完成后才适用。它检查应用是否不依赖网页 UI，而不要求移除后台 HTTP/WebSocket 程序接口。

| 类别 | 自动化验收 | 人工验收 |
|---|---|---|
| 发布产物 | 安装包和 resources 不含 WhaleBridge UI HTML；依赖审计不含 Tauri/Wry/WebView2/CEF/Electron；旧页面生成步骤不进入构建 | 在未安装 WebView2 的干净 Windows 环境安装、启动、修复和卸载 |
| 窗口与安装器 | 所有产品窗口均为原生窗口；构建和启动不引用 `*.html`、`WebviewUrl` 或 WebView 类型 | 首次启动、DPI 缩放、中文 IME、字体、键盘导航、复制粘贴、托盘和错误提示 |
| 本机管理通道 | Supervisor 通过命名管道握手；Core 无 consolePort 监听；协议版本、消息长度上限、断线重连和旧客户端拒绝有测试 | 桌面壳关闭/重启、Core 崩溃恢复、单实例和用户切换场景 |
| 权限边界 | 管道按当前用户 SID 限定；UI 管理命令与 MCP Agent 命令分别授权；Agent 无法安装服务、执行终端命令或修改安全配置 | 从 DSH 实际拉起 MCP，逐项验证保留工具和越权拒绝 |
| 配置迁移 | 旧 `config.json`、`state/`、角色、会话映射、DSH 集成在临时数据目录中迁移；冲突时无静默覆盖 | 从当前安装/源码形态升级，确认账号配置、QQ 会话和角色不丢失 |
| SnowLuma / DSH | 管理适配器版本协商、参数校验、鉴权失败与不支持版本均有隔离测试 | 从未配置环境完成原生协议同意、QQ 注入、OneBot 设置、DSH Provider/凭据设置，并在真实 QQ/DSH 中收发消息 |
| 功能与安全 | 模式、角色、白名单、提问、审批、高风险卡片、黑话、记忆、表情、文件与媒体能力的业务契约回归 | 按功能清单抽样验收真实会话、审批闭环、服务重启恢复与媒体发送 |
| 终端 / 诊断 | 如使用 ConPTY，确认终端仅属于 UI 管理权限；否则确认白名单诊断覆盖旧常用场景 | 按阶段 10.3 冻结的终端范围验收，不得把旧任意命令能力转给 Agent |
| 发行业务 | 发行审计无网页 UI/WebView 依赖，无 consoleToken / 页面 Cookie 流程，无自动打开浏览器路径 | 普通用户权限安装、升级、迁移、数据保留、回滚和卸载 |

通过标准：表中每一项都记录自动化结果或明确的人工结果；真实服务链路和 GUI 交互没有通过代码推断为通过。

---

## 12. 每阶段提交与审查规则

- 一个阶段拆成若干小提交，禁止将路径重构、UI 重构和业务改动混在同一提交；
- 每个阶段开始前记录预期改动文件；
- 每个阶段结束时记录实际改动、测试结果和遗留项；
- 不提交真实 `config.json`、`state/`、日志、SnowLuma 数据和本机路径；
- 不把本临时文档加入最终发行包；
- 阶段间如需改变技术路线，先更新本文件中的决策记录，再修改代码；
- 发现原功能缺陷时先记录为独立问题，不在迁移提交中静默改变行为；
- 用户已有未提交修改必须保留，冲突时暂停并说明；
- 所有破坏兼容的改动必须有迁移逻辑和回滚方案。

### 阶段记录模板

```text
阶段：
开始日期：
完成日期：
目标：
预计修改：
实际修改：
测试命令：
测试结果：
未解决问题：
是否允许进入下一阶段：
对应提交：
```

---

## 13. 决策记录

### ADR-001：选择方案 A

- 状态：已确认
- 决策：Windows 安装版；Bridge 不依赖目标电脑系统 Node；DSH/SnowLuma 外置。
- 原因：兼顾功能完整、部署体验、升级边界和第三方组件风险。

### ADR-002：使用独立桌面窗口

- 状态：已确认
- 决策：正式入口使用桌面窗口，不以默认浏览器作为主要 UI。
- 影响：需要 GUI 启动器、WebView2 生命周期和导航安全策略；浏览器入口继续作为诊断兼容路径。

### ADR-003：使用 Rust + Tauri/Wry WebView2，不使用 Electron

- 状态：`阶段 0–9 已实施并经用户确认验收；未来架构由 ADR-016 提议取代。`
- 决策：使用 Rust/Tauri 2/Wry 的轻量 Windows GUI 壳承载现有本地 Web 控制台；Windows 渲染后端使用系统 WebView2。
- 回退条件：WebView2 原型无法满足现有登录、导航、窗口或部署需求。
- 注：本 ADR 是历史方案记录，不再约束阶段 10 的技术选型。

### ADR-004：WhaleBridge 新标识与旧 QQ Bridge 集成兼容

- 状态：已确认品牌，迁移规则待实现
- 决策：新安装使用 `WhaleBridge`、`whale-mode-console`、`whale-mode`、`whale-chat*`；升级时识别并迁移旧 `qq-mode-console`、`qq-mode`、`qq-chat*`。MCP 工具名、HTTP API 和 state 数据结构继续保持兼容。
- 原因：尊重现有更名成果，同时避免老用户的 DSH 配置、会话与模式在桌面版升级中失效或重复注册。

### ADR-005：临时工作文档最终删除

- 状态：已确认
- 决策：原阶段 0–9 开发验收完成后已将核心产品文档转入正式文档；因新增阶段 10，本文件暂时保留。阶段 10 验收结束、有效架构与结果转入正式文档后删除本文件。

### ADR-006：Core 打包使用 esbuild + Node SEA，只读资源外置为 `resources\`

- 状态：Go（已构建、已通过发行烟测）
- 决策：`esbuild`（单文件 CJS bundle）→ `node --experimental-sea-config`（blob）→
  `postject` 注入当前 node.exe 副本，得到 `WhaleBridgeCore.exe`；只读资源以 exe 同目录
  `resources\` 外置，不嵌入 SEA asset。
- 原因：Node SEA 只支持单文件入口，而本项目是多模块 ESM + 五个 MCP 模式；bundle 解决入口问题，
  资源外置避免把刚统一的路径抽象重新拆散（`public/`、`roles/` 依赖目录扫描与用户覆盖语义）。
  90MB 级宿主开销换来的是目标机零 Node.js 依赖，符合方案 A 的交付定义。
- 影响与约束：
  - 打包入口 `src/core-sea.js` 只 import 分派模块，不 import 带主模块守卫的 `src/core-entry.js`；
  - CJS bundle 内 `import.meta` 必须保持为空（见阶段 4 关键实现决定），构建脚本静音该警告并注释原因；
  - 后续新增依赖必须能被 esbuild 静态解析，禁止运行期 `require(变量)` 与动态 `node_modules` 解析；
    构建脚本的 bundle 审计会把未打包的裸模块依赖直接判为失败；
  - 宿主 node.exe 是 Node.js 官方产物，随包再分发时需附 MIT 许可证文本（阶段 7 生成许可证清单）。

### ADR-007：打包运行时资源与数据目录默认值

- 状态：已确认
- 决策：`node:sea` 经 `process.getBuiltinModule('node:sea')` 探测打包状态；打包运行时
  `resourceRoot` 默认 exe 同目录 `resources\`（不存在则退回 exe 目录），`dataRoot` 默认
  `%LOCALAPPDATA%\WhaleBridge`，exe 同目录存在 `portable.flag` 时改用 exe 同目录 `data\`。
  优先级：`--data-dir` > `WHALEBRIDGE_DATA_DIR` > `portable.flag` > 默认目录。
- 原因：DSH 以 `command` + `args` 启动 MCP，不会给子进程注入环境变量，因此 exe 必须能自行
  找到资源；安装目录可能只读，因此可写数据绝不能默认落在 exe 目录。
- 影响：源码模式行为不变（两个根仍是仓库根）；`--data-dir` 由 `src/app-paths.js` 在模块加载期
  解析，因此必须在任何模块读取 `APP_PATHS` 之前生效（已由 import 顺序保证）。

### ADR-008：DSH 集成的归属模型与"绝不覆盖用户内容"策略

- 状态：已确认
- 决策：`<DSH_HOME>/.whalebridge-integration.json` 记录本应用安装的文件与 preset 的内容哈希；
  只有"由本应用安装且此后未被改动"的 preset 才允许自动升级，用户改过的、或来源不明的一律
  保留并提示 `--force-presets`。归属不明的内容（用户自建 preset、用户自己的 MCP 条目、
  非链接的插件目录）只报告、不删除。
- 原因：DSH 的 preset 目录与 profile 补丁文件属于用户资产，升级不能出现"悄悄改掉用户东西"
  的行为；而首次迁移时并不存在历史哈希，因此首次运行只登记归属基线、不做覆盖判定。
- 影响：无标记的旧 MCP 配置采用"就地改 command/args"而非"整块替换"——补标记块会导致同一批
  MCP server 被注册两次；只有本来就带标记块的文件才走整块替换。

### ADR-009：Core 退出码契约与托管模式

- 状态：已确认（由 `cargo test` 与 `npm run test-desktop-supervisor` 锁定）
- 决策：退出码 0=正常结束（不重启）、2=已有实例/端口占用（不重启）、10=请求重启（立即重启）、
  其它=异常退出（退避重启，连续 5 次后放弃）。`WHALEBRIDGE_SUPERVISED=1` 表示生命周期由桌面
  启动器负责：跳过全局 start.bat 清理，并用 stdin EOF 作为父进程存活凭据。
- 原因：原实现的"退出码 0 = 请守护重拉"与"关闭主程序也退 0"耦合在一起，靠杀掉守护循环来区分；
  桌面场景没有守护循环，必须让两种意图在退出码上可区分。选择 10 而不是改动 0 的语义，
  是为了让既有 `start.bat`（除 2 之外都重启）无需修改即可继续工作。
- 影响：任何新增的"请求重启"路径都必须用 10；托管模式下不得再做跨实例的进程清理。

### ADR-010：关闭窗口隐藏到托盘

- 状态：已确认（工作簿 §4.1 记录的默认设计）
- 决策：关闭主窗口不退出程序，只隐藏到托盘；托盘菜单的「退出」才真正结束并停止 worker。
- 原因：桌面应用常驻托盘更符合使用习惯，且桥接是长驻服务；同时避免误关窗口导致 QQ 桥接中断。
- 影响：托盘图标与菜单成为必备交互路径；首次使用需要用户知道"关窗口≠退出"。若后续产品确认
  改为"关闭即退出"，只需改 `on_window_event` 与托盘文案。

### ADR-011：安装器是桌面壳自身的一个模式

- 状态：已确认
- 决策：不额外引入安装器二进制。`WhaleBridge.exe --install | --repair | --uninstall | --migrate`
  既是安装器也是卸载器；开始菜单与注册表 `UninstallString` 都指向它。
- 原因：安装逻辑（payload 布局、归属清单、DSH 集成注册）与桌面壳高度耦合，分成两个二进制会
  让"装哪一份 Core/资源"变成两套真相；同一个 exe 还能复用 `core_launch`/`desktop_paths`。
- 影响：终局仍需一个极薄的 NSIS 外壳负责"解压 payload + 调用 `--install` + 写开始菜单/注册表"，
  由它决定是否提权；安装逻辑本身已可独立测试。

### ADR-012：安装归属清单与卸载助手

- 状态：已确认
- 决策：`install-manifest.json` 记录本应用放置的文件与 sha256，卸载只删"清单内且哈希未变"的文件；
  从安装目录内卸载时自动复制自身到 `%TEMP%` 并以 `--wait-pid` 重新执行，由副本完成卸载并自删。
- 原因：与 DSH 集成的归属模型（ADR-008）保持一致，卸载器不能有"删掉用户自己放的东西"的行为；
  Windows 上运行中的 exe 无法删除自己，卸载助手是唯一不引入额外二进制又能自删的稳妥做法。
- 影响：卸载助手会短暂复制一份 exe（~10MB）到 `%TEMP%`，完成后自删（已有测试断言不留副本）。

### ADR-013：暂不启用 NSIS 打包（已由单文件安装器方案取代）

- 状态：由 ADR-015 取代
- 原决策：暂不使用 NSIS；保留 `bundle.active = false`，直接沿用 WhaleBridge 桌面壳中的安装引擎。
- 原因：安装逻辑与桌面壳共用同一套 payload 与归属清单，另一个独立 GUI 安装器容易形成两套行为。
- 影响：由 Windows 自带 IExpress 只负责封装，实际安装交由 Tauri 安装页与既有 Rust 安装引擎完成。

### ADR-015：单文件安装器采用鲸桥风格的 Tauri 安装页

- 状态：已实施
- 决策：`build:release` 生成 `WhaleBridge-Setup-x64.exe`；IExpress 负责单文件自解压，随后启动桌面壳的安装界面。
  默认安装到 `%LOCALAPPDATA%\\Programs\\WhaleBridge`，按当前用户安装，无需管理员权限。
- 原因：用户只需双击安装文件并点击一次即可完成；界面复用控制台的「海盐苏打」视觉 token，安装细节仍由现有引擎执行。
- 影响：构建 Windows 安装包无需额外安装 NSIS；封装后用 Win32 资源 API 写入 C4 图标且无需外部工具。
  未签名仍会触发 Windows 来源提示，代码签名仍待发行前处理。

### ADR-016：后续桌面版改为原生 UI，不依赖网页界面

- 状态：`迁移实施中（一次性交付目标）：正式 Cargo target 已指向 eframe/egui 原生入口，Tauri/Wry 已从 Cargo runtime dependencies 移除；命名管道 IPC、Supervised ready 握手、原生安装向导与受限诊断已接通，隔离 no-web release candidate 已构建并通过自动化安装/恢复检查；完整旧控制台功能、托盘、ACL 真机验收仍未完成。`
- 决策：以原生 Rust GUI（eframe/egui）替换 WhaleBridge 的产品 WebView/HTML 界面；将管理控制业务抽为 `ControlService`，桌面管理走命名管道 IPC，HTTP 只保留 Agent/DSH 程序化数据兼容面。
- 范围定义：“无网页”指产品安装、配置和运维不依赖 HTML UI、系统浏览器或 WebView。DSH 的 RPC/WebSocket、SnowLuma 的 OneBot HTTP/WebSocket 和模型 API 暂作为 headless 程序接口保留。
- 原因：当前桌面壳仍加载本地控制台，SnowLuma/DSH 的配置与首次设置也依赖页面交互。用户要求的目标必须包含主控制台、启动/状态页、安装器、SnowLuma/DSH 初始化和 MCP 通道，不能只替换主窗口。
- 迁移约束：用户已要求不按阶段逐片交付，工程内可按安全边界拆分，但最终一次性验收。管理 IPC 使用固定方法白名单，终端替换为 `runtime/config/paths/services` 只读诊断；native 模式禁用 HTTP console-token 控制路径。Agent/MCP 与桌面管理能力隔离。
- 影响：需重新实现原生配置表单、状态订阅、提问/审批与运维向导；旧版配置和状态格式尽量保持兼容。SnowLuma 管理 API 需版本协商，不能通过页面 DOM 自动化绕过兼容性问题。终端功能按阶段 10.3 先冻结范围，再决定 ConPTY 或白名单诊断替代。
- 取代关系：未来版本的主窗口和安装器不再采用 ADR-003/ADR-015 的 WebView 页面；现有已验收版本仍按原方案作为迁移来源和回滚基线。

### ADR-014：卸载策略（阶段 5 预留，阶段 7 实施）

- 状态：已实施
- 决策：卸载只移除 manifest 记录的本应用文件与标记块，默认保留 `%LOCALAPPDATA%` 数据；
  `--remove-dsh-integration` 走 `WhaleBridgeCore.exe --uninstall-dsh`（只删本应用拥有的
  preset/插件/MCP 条目，用户改过或自建的一律保留）；`--remove-data` 需显式指定并二次警告。
- 影响：`parseMcpEntries()` 与 `planDshRemoval()` 成为卸载 DSH 集成的基础能力。

---

## 14. 当前下一步

用户已确认阶段 0–9 开发验收完成，并要求去网页化工作不再分阶段交付，而是一次性落地。当前工作树已完成原生 UI/安装向导的架构切换与 IPC 基础、构建策略默认排除网页资源；尚未满足旧控制台全功能等价，不能将本方案标记为完成，也不能用旧 `dist/app` 作为新架构验收证据。

**当前实况**：native UI 已有概览/重启、角色 CRUD/模式、安全通知、全局运行策略（模式、Owner、私聊/群 allow/deny）、SnowLuma/DSH 本地服务发现/选择/安装/启停、模型目录与默认模型、Preset 列表/绑定、审批/提问与风险卡片审批队列、黑话配置、会话/社交阶段、活动与日志只读查看、固定白名单诊断；对应 ControlService 命令已接入真实命名管道。HTTP 管理令牌在 native 模式拒绝，HTTP API 仍供 Agent/DSH。任意命令终端按用户选择替换为安全诊断白名单。模型与 Preset 只投影固定字段，默认值只影响未来新建会话。

**下一步按完整验收一次性推进（以下仅为内部任务，不再逐阶段交付）**：

1. 将遗漏的旧控制台功能按固定 ControlService 方法迁入原生 UI：发送参数、实时事件订阅、reserved/reserved2 完整维护与记忆、贴纸、文件/音频/Kugou 等；审批/提问与风险卡片审批队列已接入。能力不可安全复用时明确限制，而不是放开任意命令或用猜测性文件写入。
2. 补原生事件订阅、托盘/启动关闭行为和安装引导；为管道配置/验证当前用户 SID 与 DACL，覆盖连接、重启、恶意帧、超时和多实例。
3. 清理旧 Tauri/WebView 源码不参与构建的歧义；README、PROJECT_GUIDE、DESKTOP_APP 与人工验收清单改为真实原生状态。
4. 当前自动验证记录（2026-09-23）：Rust 59/59、IPC/ControlService/no-web release policy 测试通过；真实 Node Core 子进程烟测通过 IPC ready、角色与策略读写、活动/日志/默认模型/挂起列表读取、Supervisor 重启、HTTP 管理请求拒绝、端口冲突及无孤儿进程。最新隔离 no-web release candidate（含审批/提问 native IPC）通过中文/空格安装路径、无系统 Node、只读安装目录、崩溃恢复、单实例、孤儿守卫与卸载保留数据检查。一次首次写策略的 smoke 曾发现可选 `state/mode.json` 缺失处理错误，已修复并复测通过。GUI 手工测试和 release 子进程窗口检查仍按环境跳过；发行包在真实用户机的配置、升级、迁移、卸载及真实 QQ/DSH/SnowLuma 端到端验收仍待完成。现有旧 `dist/app` 和 `output/` 均保留，不覆盖作验证。
5. 所有可程序化验收通过并将真实限制完整写入正式文档后，才按 ADR-005 判断是否删除本临时开发文档。
