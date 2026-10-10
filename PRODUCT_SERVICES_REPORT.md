# PRODUCT_SERVICES_REPORT — CetaMesh 1.0 上线前产品化任务 D（含反馈修正）

> Product Services / Onboarding / Feedback
> 当前分支：`codex/session-20261010-feedback-links`（隔离工作区 `.worktrees/2026-10-10-feedback-links`）
> 基线：本地 `main` = `cc201ee`（任务 D 首版已合并；**未 push**，等 Owner 指示）
> 首版交付：2026-10-09（分支 `codex/session-20261009-2145-rules-confirm`，已合并）
> 反馈修正：2026-10-10（本分支）

## 0. 结论摘要

补齐了公开发布所必需的产品入口，并且全部有测试与边界约束：

1. **About**：产品事实（版本 / Build ID / Commit / 平台 / 架构 / 开发者 / 官网 / GitCode / GitHub /
   许可证 / 隐私说明 / 安全说明 / 诊断信息）全部由 **package.json + build-info.json + release-manifest.json +
   release-config.json** 驱动，**代码里没有写死版本**；没有配置的字段如实返回 `null` 并带 `configured`/`readiness`
   标记，绝不编造官网或邮箱。
2. **更新公告**：manifest 新增可选 `title`，检查器在「有新版」和「已最新」两条分支都带回
   `title / publishedAt / notes`；公告经**纯文本安全渲染**（去 script/style/标签、丢弃非 http(s) 链接目标、
   控制字符与长度有界），并缓存到 `state/update-notes.json`，About 页**离线**也能显示「最近一次更新公告」。
3. **反馈入口（修正后）**：**只提供入口**——反馈与建议 / Bug 反馈 / 功能建议 / 安全漏洞四项，点击用
   **系统默认浏览器**打开官方网站对应页面（概念路径 `/feedback`、`/feedback?type=bug`、
   `/feedback?type=feature`、`/security`）。站点根与路径来自发行配置，域名只有一个来源；
   链接 query **只带 version / build / platform** 三个非敏感字段。
   软件内**没有** FeedbackService、本地 Outbox、反馈表单、Bug 提交、漏洞上传，也不自动上传日志。
   浏览器打开失败只提示「无法打开浏览器，请稍后访问 CetaMesh 官方网站。」，不影响软件任何其它功能。
4. **诊断信息**：白名单 + 既有 redaction 构造，**只在本机 About 页展示**（用户可自行复制）；
   没有任何上传通道。API Key / token / 聊天内容 / Memory / 文件正文 / private key 没有进入快照的路径。
5. **First Run Onboarding**：7 步（欢迎 → 配置 Provider → 测试连接 → 选默认模型 → 可选 Agent →
   可选 Integration → 完成）。完成条件只有「Provider 可用 + 模型选定」，**不要求 QQ / DSH / 移动端 / Agent / 扩展**，
   并有测试证明缺这些服务时仍能走完。
6. **Provider 配置体验 + Empty State**：普通用户只看「服务商 / API Key / 模型」，工程字段收进 advanced；
   四类必需空状态文案（先添加一个模型 / Codex 未安装 / 插件已关闭 / 需要审批）与技术错误码映射集中在一张表里，
   技术串只进 `detail`，产品文案恒为中文人话。

交付**后端服务 + IPC 契约 + 原生桌面壳页面**三层；UI 与 Core 之间只走既有 IPC 命名空间，
没有引入任何新的传输、WebView 或数据收集路径。

### 0.1 修订记录（2026-10-10）：反馈功能修正

按产品决定，**移除了首版实现的"软件内反馈收集"整套能力**，改为纯入口：

| 已删除（不再实现） | 替代 |
| --- | --- |
| `src/feedback/**`（`FeedbackService` / 本地 Outbox / 发送通道 / 类型校验） | `src/product/feedback-links.js`：按发行配置构造四个官方入口 URL |
| `feedback.submit` / `.list` / `.retry` / `.remove` / `.clear` / `.config` / `.previewDiagnostics` IPC | `product.feedbackLinks`（只读） |
| 软件内反馈表单 / Bug 提交 / 漏洞上传 UI 与状态 | Feedback 页改为四个入口按钮 + 安全提示 + 「链接携带什么」透明说明 |
| 诊断附件（可勾选随反馈发送）与 `sanitizeDiagnostics` / `minimalDiagnostics` | 诊断仅本机展示（About 页），`buildDiagnostics` 保留白名单构造 |
| 自动上传日志（任何形式） | 无任何上传通道；链接只带 version / build / platform |

新增的边界与保证：

- 域名/路径**只来自** `release-config.json`（`feedback.baseUrl`，缺省回落 `website` + `feedback.paths`），
  代码与页面里没有第二个域名来源；
- query 白名单写死在代码里（`FEEDBACK_ALLOWED_QUERY_KEYS = ['version','build','platform']`），
  配置无法扩大；值层还有**形状白名单**，形状不合法就整体丢弃（不注入、也不残留片段）；
- 只允许 `https://` 且无凭据的 URL 交给系统浏览器（`desktop-shell/src/external_link.rs`），
  该模块被架构守卫单独盯住（只能启动 `explorer.exe`）。

---

## 1. 交付物

### 1.1 新增模块

| 文件 | 作用 |
| --- | --- |
| `release-config.json` | 官方发行配置：开发者 / 官网 / GitCode / GitHub / 许可证 / 隐私与安全文档 / **反馈入口站点根与页面路径** |
| `src/product/release-config.js` | 发行配置加载 + 归一化（非 https 视为未配置、站点内路径校验、损坏如实报 `lastError`）+ 安全联系入口推导 |
| `src/product/feedback-links.js` | 反馈入口：四个入口 URL 构造、query 白名单与形状校验、安全提示与失败/未配置文案 |
| `src/product/diagnostics.js` | 诊断快照白名单构造 + 对用户公开的包含/排除策略（只在本机展示） |
| `src/product/error-registry.js` | 最近错误码有界环（**只存枚举码，不存消息**） |
| `src/product/empty-states.js` | 空状态/友好错误文案表 + 技术码映射表（`message` 恒为产品文案，技术串只进 `detail`） |
| `src/product/provider-view.js` | Provider 配置视图（基础字段 / 高级字段分离）+ 配置指引 + 连接测试失败文案表 |
| `src/product/service.js` / `index.js` | `product.*` 服务与公共入口（含 `product.feedbackLinks`） |
| `src/onboarding/steps.js` | 7 个步骤定义（含「可选」标注）、必填顺序校验、下一个步骤 |
| `src/onboarding/store.js` | 引导进度持久化（损坏不阻断、拒绝静默覆写、reset 是唯一重建入口） |
| `src/onboarding/service.js` / `index.js` | 引导状态机 + 连接测试 + 默认模型 + 可选 Agent/Integration |
| `src/update/notes.js` | 更新公告安全渲染（纯文本契约 `format='plain-text'`） |
| `src/update/notes-cache.js` | 已验签公告的本地缓存（`state/update-notes.json`） |
| `desktop-shell/src/product_ui.rs` | UI 纯逻辑：About / 公告 / 反馈入口 / 引导的 JSON→视图解析 + 文案兜底 + 技术码→用户语言（11 个单测） |
| `desktop-shell/src/external_link.rs` | **唯一**允许"用系统默认浏览器打开官方页面"的模块（https-only 校验；4 个单测） |
| `docs/product/PRIVACY.md` / `SECURITY.md` | About 页展示的隐私说明与安全说明（含漏洞报告通道） |
| `scripts/test-product-services.mjs` | About / 更新公告 / 诊断本机展示 / 新 IPC 命名空间验收 |
| `scripts/test-feedback-links.mjs` | 反馈入口验收：URL 构造、query 白名单、无软件内收集、兜底文案、IPC |
| `scripts/test-onboarding.mjs` | 首次运行引导验收（含「无 QQ/DSH/移动端也能完成」） |
| `scripts/test-product-copy.mjs` | 空状态文案、技术码映射、Provider 基础/高级字段、连接失败文案验收 |

### 1.2 修改模块

| 文件 | 改动 |
| --- | --- |
| `src/about/build-info.js` | 平台/架构描述、开发者、官网/GitCode/GitHub、许可证/隐私/安全说明、发布清单读取、发行配置完整度 |
| `src/about/service.js` | `about.update`（离线公告 + 下载源 + 更新状态）与 `about.diagnostics`（本机展示） |
| `src/update/manifest.js` | 归一化新增可选 `title`（缺失保持 `null`，不编造） |
| `src/update/checker.js` | 「已最新」分支也带回公告字段（该清单此刻已验签，无需再联网） |
| `src/update/service.js` | 每次检查落公告缓存（成功/失败都落）、离线 `update.notes`、能力声明 `canShowAnnouncementOffline` |
| `src/app/service-container.js` | 装配 `releaseConfig` / `errorRegistry` / `notesCache` / `product` / `onboarding`（**不再有 feedback 服务**） |
| `src/app/ipc-runtime.js` | 新增 `onboarding.` / `product.` 路由；**移除 `feedback.`**；失败方法记录错误码（供诊断） |
| `src/control/ipc-protocol.js` | 私有方法族前缀白名单同步（去掉 `feedback.`，保留 `onboarding.` / `product.`） |
| `desktop-shell/src/app_shell.rs` | `AppPage::{About, Feedback, Onboarding}` 纳入 SECONDARY 导航（7 项）+ 页面说明 |
| `desktop-shell/src/native_ui.rs` | 三个页面渲染、按页面懒加载、事件归位；**Feedback 页改为入口列表**；统一错误条改为"用户语言优先 + 技术细节折叠" |
| `desktop-shell/src/native_main.rs` | 注册 `mod product_ui;` / `mod external_link;` |
| `desktop-shell/src/theme/qa.rs` | 截图计划从 11 张扩到 14 张（新增 About / Feedback / Onboarding 页） |
| `scripts/run-all-tests.mjs` | 登记新增测试套件（不登记会被孤儿检测直接 FAIL） |
| `scripts/test-desktop-architecture.mjs` | 架构守卫纳入 `product_ui.rs` 与 `external_link.rs` |
| `PROJECT_STATE.md` | Active Work 记录分支与交付 |

---

## 2. 逐节实现与验收映射

### 2.1 反馈修正后的要求（本次）

| 要求 | 实现位置 | 验收 |
| --- | --- | --- |
| 只提供反馈入口：反馈与建议 / Bug 反馈 / 功能建议 / 安全漏洞 | `src/product/feedback-links.js`、`native_ui.rs#show_feedback_page` | `test-feedback-links`：四个入口 id/标签顺序、security 单独一类；`product_ui` 单测覆盖解析 |
| 点击用系统默认浏览器打开官网对应页面 | `external_link.rs`（`explorer.exe`）+ 页面按钮 | `external_link` 单测（https-only、拒绝凭据/控制字符、长度上限、非法 URL 不 spawn）；架构守卫断言只启动 `explorer.exe` |
| 实际 URL 来自官方产品配置 / Release Manifest，域名不散落硬编码 | `release-config.json` → `release-config.js` → `feedback-links.js` | 断言 `feedback.baseUrl` 优先、缺省回落 `website`；页面/代码里无第二处域名；路径 `//host`、绝对 URL、含空格一律拒绝 |
| 允许 query：version / build / platform | `FEEDBACK_ALLOWED_QUERY_KEYS` + `safeQueryValue` | 断言链接参数键恰为白名单（+ 页面自带 `type`）；污染值形状不合法则整体丢弃 |
| 禁止：API Key / Token / Chat / Memory / 用户路径 / 插件配置 / Device secret / 日志正文 | 白名单构造（其它字段无入口） | 断言链接与结果里不含上述内容（含污染输入） |
| 安全漏洞入口单独提示 + 进入 Security 页 | `SECURITY_NOTICE` + `/security` 路径 | 断言提示原文与 `/security` URL |
| 浏览器打开失败提示「无法打开浏览器，请稍后访问 CetaMesh 官方网站。」 | `BROWSER_OPEN_FAILURE_MESSAGE` + 页面 notice | 断言文案原文；打开失败只提示、不改其它状态 |
| 不因反馈服务不可用影响使用 | 无任何网络/后台任务；仅本地构造 URL | 结构断言：`src/feedback` 不存在、容器无 `feedbackService`、`feedback.*` IPC 不可用 |

### 2.2 首版要求（仍然有效）

| 要求 | 实现位置 | 验收 |
| --- | --- | --- |
| About：产品名/版本/Build ID/Commit/平台/架构/开发者/官网/GitCode/GitHub | `src/about/build-info.js`、`release-config.json` | `test-product-services`：版本 = package.json、平台/架构、开发者与官网未配置不编造、许可证、隐私/安全说明可用 |
| 更新：当前/最新版本、公告、检查更新、下载源、更新状态 | `about.update` + `update.notes` / `update.check` | 离线读取缓存公告、下载源优先级 `[gitcode, github]`、状态 `update_available` / `up_to_date` / `error` |
| 不写死版本、读 build/release manifest | `package.json` + `build-info.json` + `release-manifest.json` | Build ID/Commit 来自 `build-info.json`；发布清单读取；缺失时如实不可用 |
| 公告 version/title/publishedAt/notes + 不做 HTML 注入 | `src/update/manifest.js`、`checker.js`、`notes.js` | 四字段齐全；`UP_TO_DATE` 分支同样带公告；`notes`/`text` 不含 `<script` 与 `javascript:` |
| 诊断信息（本机展示；禁止明文 Key/token/聊天/Memory/文件正文/私钥） | `src/product/diagnostics.js` + `src/logging/redact.js` | 断言六类内容不出现；白名单字段内凭据字样被脱敏；策略向用户明示 |
| 7 步首次启动流程；不要求 QQ / DSH / Mobile | `src/onboarding/*` | 步骤定义 7 步、必填顺序强制、可选可跳过；只给 `stateDir` 也能完成 |
| Provider 页基础/高级分离；测试连接 | `src/product/provider-view.js` + `providers.secrets#test` | `basic = [provider, apiKey, model]`；成功/401/网络/500/缺 Key 五条路径 |
| 空状态四类必需文案；不要只显示技术错误 | `src/product/empty-states.js` + 统一错误条 | 四条文案逐字断言；`message` 恒为产品文案，技术串只进 `detail` |

---

## 3. 安全设计要点

1. **反馈不收集任何数据**：入口只是 URL；链接里只有 version / build / platform（形状白名单校验），
   其它字段（Key/token/聊天/Memory/路径/插件配置/device secret/日志）在构造层就没有入口。
2. **域名单一来源**：`release-config.json` 的 `feedback.baseUrl`（缺省回落 `website`）+ `feedback.paths`；
   路径必须是站点内绝对路径（拒绝 `//host`、绝对 URL、空白/控制字符），非 https 一律视为未配置。
3. **打开外部链接只有一条路**：`external_link.rs` 校验 https + 无凭据 + 长度有界后交给 `explorer.exe`；
   架构守卫断言 UI 侧只能启动这一个进程，且未引入 WebView。
4. **诊断白名单**：`buildDiagnostics` 只从允许字段构造快照，字符串再过 `redactText`；只在本机展示。
5. **只存错误码**：`createErrorRegistry` 只记录枚举码，不记消息；IPC dispatch 失败时集中记录。
6. **引导进度不落凭据**：`sanitizeStepData` 丢弃任何 `key/secret/token/password/credential` 字段；
   测试断言进度文件里搜不到测试用 API Key；损坏时拒绝静默覆写，`reset` 是唯一重建入口。
7. **不新增裸 `catch`、不新增 `setInterval`**：`test-error-hygiene` 通过；反馈修正后软件内**没有任何**
   后台发送/重试任务。

---

## 4. IPC 契约（原生 UI 已按此接线；保留给后续页面/插件参考）

| 方法 | 用途 |
| --- | --- |
| `about.info` | About 页全部产品事实（含 `developer` / `links` / `legal` / `platform` / `release` / `readiness`） |
| `about.update` | 更新区块：当前版本 + 最近一次公告（离线）+ 下载源 + 上次检查状态 |
| `about.diagnostics` | 已脱敏诊断快照 + 对用户公开的包含/排除策略（本机展示） |
| `update.check` / `update.notes` / `update.config` / `update.capabilities` | 检查更新与离线公告 |
| `product.feedbackLinks` | **反馈入口（修正版）**：四个官方 URL + 安全提示 + 未配置/打开失败文案 + query 白名单 |
| `product.providerView` / `providerFieldGuidance` | 设置页的「基础三项 + 高级折叠」渲染数据 |
| `product.emptyState` / `product.emptyStateForError` / `product.providerTestFailure` / `product.copy` | 空状态与技术错误的用户语言 |
| `onboarding.status` / `start` / `completeStep` / `skipStep` / `finish` / `reset` | 首次运行引导状态机 |
| `onboarding.testProvider` / `setModel` / `connectAgent` / `enableIntegration` | 引导内的动作（连接测试失败返回结构化中文原因） |

**已移除**：`feedback.*` 全部方法（协议层前缀白名单与路由同步删除；调用会得到 `METHOD_NOT_FOUND`）。

桌面壳接线沿用既有 `ApiCall::Family`，无需改动 IPC 客户端。

---

## 5. 测试与验证

新增/更新四个套件（均已登记 `scripts/run-all-tests.mjs`）：

| 套件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `scripts/test-feedback-links.mjs` | 40 | 四个入口与标签顺序、URL 精确构造、query 白名单与形状校验、污染值被整体丢弃、禁止字段缺失、未配置/失败文案、路径越界拒绝、无 `src/feedback`、容器无 FeedbackService、`feedback.*` 不可用、IPC 可达 |
| `scripts/test-product-services.mjs` | 49 | About 构建/发行事实、更新公告安全渲染 + 离线缓存、诊断白名单与脱敏、`onboarding.`/`product.` IPC 可达、失败方法写入错误码环 |
| `scripts/test-onboarding.mjs` | 31 | 无 QQ/DSH/移动端/Agent/扩展完成引导、必填顺序、可选跳过、进度持久化、连接测试五条失败路径、损坏文件处理与 reset |
| `scripts/test-product-copy.mjs` | 38 | 四条必需空状态、技术码映射、技术串与产品文案分离、Provider 基础/高级字段、连接失败文案 |

全量聚合器（`node scripts/run-all-tests.mjs`，等价 `npm test`）在**未构建任何产物**的工作区（与全新 clone 相同）实测：

```
PASS 70 · FAIL 3 · NOT_RUN_ENVIRONMENT 7
```

- 三个 FAIL **全部是环境原因，与本分支无关**：
  - `desktop/cargo:test`：本会话受限令牌下 Rust 测试二进制无法在用户 TEMP 建目录（见 §6.5）；
  - `environment/test-mcp-exec` 与 `environment/test-onebot-connection`：这两个套件的探针是
    "本机 3000 端口是否有网关"。本机**恰好**有另一个会话起的服务在 `127.0.0.1:3000` 监听，
    于是它们从 `NOT_RUN_ENVIRONMENT` 变成真实运行并失败（它们需要的是配置完整的真实 SnowLuma 网关）。
    上一轮同一分支的同一份代码在网关未监听时记为 `NOT_RUN`（9 项）。
- 四个产品面套件全部 PASS（含新增的 `test-feedback-links`）；其余 Node 套件（`test-system-pages` /
  `test-ipc-runtime` / `test-error-hygiene` / `test-service-container` / `test-workspace-*` /
  `test-desktop-architecture` 等）全部 PASS。

### 5.1 原生桌面壳（Rust）验证

| 项目 | 结果 |
| --- | --- |
| `cargo check --manifest-path desktop-shell/Cargo.toml` | 通过（无 error；warning 均为仓库既有项） |
| `cargo test --manifest-path desktop-shell/Cargo.toml` | **161 passed · 2 failed**（基线 145 passed · 2 failed；本分支 +16 项：`product_ui` 11 + `external_link` 4 + `app_shell` 1） |
| 新增单测覆盖 | About 解析、公告视图、**反馈入口视图（含未配置兜底）**、URL 校验（https-only/凭据/控制字符/长度）、四类文案与错误码映射、首次运行判定、步骤与顺序解析 |
| `node scripts/test-desktop-shell.mjs`（本轮重新构建 debug 壳 + `dist/core` 后复跑） | **全部通过**：IPC 握手、策略读写、重启换进程、单实例冲突、真实原生窗口（标题「CetaMesh」）、系统托盘隐藏/恢复、强杀后无残留进程、无孤儿进程 |
| 那 2 项失败的 Rust 用例 | `installer::tests::{install_then_repair_then_uninstall_keeps_data, uninstall_keeps_user_modified_files_and_reports_them}`：需要写 `HKCU\Software\WhaleBridgeTest\...` 注册表，被本会话受限令牌拒绝；与本分支无关 |

### 5.2 原生 UI 视觉验收（debug 截图）

`--screenshot-dir` 是仓库既有的 debug-only 截图能力（release 构建不含）。任务 D 把它从
"10 个主题 + 1 张 Settings" 扩为 **14 张**：新增 `12-soda-about` / `13-soda-feedback` / `14-soda-onboarding`
（`theme/qa.rs` 的 `ShotSpec` 从 `settings: bool` 改为 `page: QaPage`，驱动真实导航后截图）。固定 1280×800：

| 截图 | 结论 |
| --- | --- |
| `12-soda-about.png` | About 页渲染正常：页头 + 版本/构建说明、更新卡片、诊断卡片；Core 未就绪时显示加载态而不是空白或崩溃 |
| `13-soda-feedback.png` | Feedback 页（修正后）渲染正常：四个入口按钮、安全漏洞单独提示、以及「链接携带的信息」透明说明 |
| `14-soda-onboarding.png` | Onboarding 页渲染正常：引导说明（明确不要求 QQ / DSH / 移动端）、步骤区、当前步骤区、完成按钮与缺项提示 |

**截图发现并修复的真实缺陷**：产品页从 12 个增加到 15 个后，1280×800 下侧边栏装不下整列导航，
最后几项被裁掉（`Settings` 鼠标点不到）。修法是把侧边栏内容放进 `egui::ScrollArea::vertical()`
（不动导航分组、不缩小字号硬塞）；重跑截图可见滚动条生效、所有页面可达。

注：截图模式在 Core 就绪前就开始拍摄，因此展示的是"数据未到达"的加载态；数据填充后的解析与文案
由 `product_ui` 的 11 个单测（真实 JSON payload）与 `test-product-services` / `test-feedback-links` 覆盖。

---

## 6. 未做与后续

### 6.1 桌面壳 UI 已接线

`AppPage::{About, Feedback, Onboarding}` 三个原生页面接在既有 SECONDARY 导航下，交互全部走既有
`ApiCall::Family` IPC 通道；未引入 WebView。`scripts/test-desktop-architecture.mjs` 的守卫覆盖
`product_ui.rs`（UI 纯逻辑）与 `external_link.rs`（唯一允许启动 `explorer.exe` 的外部链接模块）。

仍建议由人做一次 Windows 手工点按（截图只覆盖 1280×800 的静态渲染，不覆盖点击后的浏览器行为）。

### 6.2 发行配置里有四个字段需要发行方填写

`release-config.json` 目前是「结构完整、值待填」：

- `developer`（开发者显示名）、`website`（官方网站）—— 未填时 About 显示「未配置」，**不编造**；
- `feedback.baseUrl`（反馈入口站点根）—— 未填时回落 `website`；两者都没有时反馈页显示
  「官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。」，入口按钮为禁用态；
- `security.contact`（官方安全联系入口）—— 未填时回落到由 `repositories.github` 推导的 GitHub 私密漏洞报告。

### 6.3 更新公告发布仍是手工步骤

`releases/stable.json` 由 `scripts/sync-gitcode-release.mjs` 生成（本轮未改）；清单支持可选 `title`，
发布时带上它 About 才能显示公告标题（否则 UI 回落到版本号）。

### 6.4 反馈没有任何后台任务

修正后反馈 = 本地构造 URL + 打开浏览器，**没有**发送、重试、队列或定时器；
`setInterval` 基线保持不变。

### 6.5 环境限制（与本分支无关，如实记录）

- **`cargo:test`**：本会话受限令牌下，Rust 测试二进制在用户 TEMP
  （`C:\Users\Administrator\AppData\Local\Temp`）建目录得到 `ACCESS_DENIED`（聚合器口径 **147 passed / 16 failed**）。
  对照实验：把 `TEMP/TMP` 指向工作区内目录后变成 **161 passed / 2 failed**，只剩 2 项需要写
  `HKCU\Software\WhaleBridgeTest\...` 注册表的 installer 用例如实被拒。非受限环境（CI / Owner 本地）不受影响。
  另注：把 `TEMP` 放进工作区会让 `test-workspace-*` 的「非 repo 工作区」判定反向失效
  （临时目录落进了本仓库），因此正式口径使用默认 TEMP，并如实记录这一项 FAIL。
- **`test-desktop-shell`（原生壳自检）同样受该限制**：默认 TEMP 下壳无法创建日志目录（os error 5）而失败；
  把 `TEMP/TMP` 指向工作区内目录后**全部通过**（首版验收记录，见 §5.1 注释）。
- **`test-continuity-rollover` / `test-continuity-auto-rollover`**：依赖 `output/` 目录（gitignored），
  全新 worktree/clone 不含该目录时会 `ENOENT` 失败。这是**既有脆弱性**（本分支未改这两个脚本）；
  本工作区创建 `output/` 后两者均 PASS。
- **NOT_RUN_ENVIRONMENT**：`test-mcp-exec` / `test-onebot-connection`（缺真实 SnowLuma 网关）、
  `test-mcp-web-search`（未开 `WHALEBRIDGE_TEST_NETWORK`）、`test-core-dist` / `test-release-candidate` /
  `test-process-extension-sea`（缺发行产物）、`test-desktop-shell` / `test-desktop-install`（缺 debug 桌面壳）。

---

## 7. 交付流程（按 `docs/development/GIT_WORKFLOW.md`）

1. 已完成：分支 `codex/session-20261010-feedback-links` 上的反馈修正 + 测试 + 文档；
2. **待 Owner 确认**本轮结果；
3. 确认后：合并到本地 `main` → 在 `main` 上复跑 `npm test` → 删除工作分支与隔离 worktree
   （`.worktrees/2026-10-10-feedback-links`）；
4. 全程 **不 push**（除非 Owner 明确要求）。
