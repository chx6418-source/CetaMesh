# PRODUCT_SERVICES_REPORT — CetaMesh 1.0 上线前产品化任务 D

> Product Services / Onboarding / Feedback
> 分支：`codex/session-20261009-2145-rules-confirm`（隔离工作区 `.worktrees/2026-10-09-2145`）
> 基线：本地 `main` = `ce83264`（**未 push**，等 Owner 指示）
> 交付日期：2026-10-09

## 0. 结论摘要

补齐了公开发布所必需的三类产品入口，并且全部有测试与边界约束：

1. **About**：产品事实（版本 / Build ID / Commit / 平台 / 架构 / 开发者 / 官网 / GitCode / GitHub /
   许可证 / 隐私说明 / 安全说明 / 诊断信息）全部由 **package.json + build-info.json + release-manifest.json +
   release-config.json** 驱动，**代码里没有写死版本**；没有配置的字段如实返回 `null` 并带 `configured`/`readiness`
   标记，绝不编造官网或邮箱。
2. **更新公告**：manifest 新增可选 `title`，检查器在「有新版」和「已最新」两条分支都带回
   `title / publishedAt / notes`；公告经**纯文本安全渲染**（去 script/style/标签、丢弃非 http(s) 链接目标、
   控制字符与长度有界），并缓存到 `state/update-notes.json`，About 页**离线**也能显示「最近一次更新公告」。
3. **Feedback**：五类反馈（Bug / 功能建议 / 体验问题 / 安全漏洞 / 其它）+ 标题/描述/复现步骤/联系方式；
   `FeedbackService` 先落**本地 Outbox**（反馈服务未上线或不可用时绝不阻塞软件），失败按指数退避重试
   （30s → 上限 6h，共 10 次），4xx 视为不可重试；endpoint 来自官方发行配置；**安全漏洞类型强制最小 metadata、
   不自动附加日志**，并给出官方安全联系入口。
4. **诊断附件**：白名单结构 + 既有 redaction 二次脱敏 + 32 KiB 上限；API Key / token / 聊天内容 / Memory /
   文件正文 / private key **没有进入 payload 的路径**，且 `feedback.previewDiagnostics` 让用户先看到会发什么。
5. **First Run Onboarding**：7 步（欢迎 → 配置 Provider → 测试连接 → 选默认模型 → 可选 Agent →
   可选 Integration → 完成）。完成条件只有「Provider 可用 + 模型选定」，**不要求 QQ / DSH / 移动端 / Agent / 扩展**，
   并有测试证明缺这些服务时仍能走完。
6. **Provider 配置体验 + Empty State**：普通用户只看「服务商 / API Key / 模型」，工程字段收进 advanced；
   四类必需空状态文案（先添加一个模型 / Codex 未安装 / 插件已关闭 / 需要审批）与技术错误码映射集中在一张表里，
   技术串只进 `detail`，产品文案恒为中文人话。

按任务要求「不要大改最终 UI」，本轮**未改桌面壳（Rust）代码**；UI 接线所需的 IPC 契约见 §4。

---

## 1. 交付物

### 1.1 新增模块

| 文件 | 作用 |
| --- | --- |
| `release-config.json` | 官方发行配置：开发者 / 官网 / GitCode / GitHub / 许可证 / 隐私与安全文档 / 反馈 endpoint |
| `src/product/release-config.js` | 发行配置加载 + 归一化（非 https 视为未配置、损坏如实报 `lastError`）+ 安全联系入口推导（GitHub 私密漏洞报告） |
| `src/product/diagnostics.js` | 诊断快照白名单构造、`sanitizeDiagnostics` 二次脱敏、`minimalDiagnostics`、对用户公开的包含/排除策略 |
| `src/product/error-registry.js` | 最近错误码有界环（**只存枚举码，不存消息**，避免把用户数据带进诊断） |
| `src/product/empty-states.js` | 空状态/友好错误文案表 + 技术码映射表（`message` 恒为产品文案，技术串只进 `detail`） |
| `src/product/provider-view.js` | Provider 配置视图（基础字段 / 高级字段分离）+ 配置指引 + 连接测试失败文案表 |
| `src/product/service.js` / `index.js` | `product.*` 服务与公共入口 |
| `src/feedback/types.js` | 五类反馈、字段校验与长度上限、稳定 id |
| `src/feedback/outbox.js` | 本地 Outbox（Storage Primitive 持久化、队列上限、退避计算、损坏文件另存备查） |
| `src/feedback/transport.js` | 反馈发送通道（https-only、超时、可重试/不可重试/deferred 三态、从不抛错） |
| `src/feedback/service.js` / `index.js` | `FeedbackService`：提交 / 列表 / 重试 / 清理 / 诊断预览 / 配置 |
| `src/onboarding/steps.js` | 7 个步骤定义（含「可选」标注）、必填顺序校验、下一个步骤 |
| `src/onboarding/store.js` | 引导进度持久化（损坏不阻断、拒绝静默覆写、reset 是唯一重建入口） |
| `src/onboarding/service.js` / `index.js` | 引导状态机 + 连接测试 + 默认模型 + 可选 Agent/Integration |
| `src/update/notes.js` | 更新公告安全渲染（纯文本契约 `format='plain-text'`） |
| `src/update/notes-cache.js` | 已验签公告的本地缓存（`state/update-notes.json`） |
| `docs/product/PRIVACY.md` / `SECURITY.md` | About 页要展示的隐私说明与安全说明（含漏洞报告通道） |
| `scripts/test-product-services.mjs` | About / 更新公告 / 诊断脱敏 / 反馈离线队列与重试 / 新 IPC 命名空间验收 |
| `scripts/test-onboarding.mjs` | 首次运行引导验收（含「无 QQ/DSH/移动端也能完成」） |
| `scripts/test-product-copy.mjs` | 空状态文案、技术码映射、Provider 基础/高级字段、连接失败文案验收 |

### 1.2 修改模块

| 文件 | 改动 |
| --- | --- |
| `src/about/build-info.js` | 增加平台/架构描述、开发者、官网/GitCode/GitHub、许可证/隐私/安全说明、发布清单读取、发行配置完整度 |
| `src/about/service.js` | 新增 `about.update`（离线公告 + 下载源 + 更新状态）与 `about.diagnostics`（与反馈同一份脱敏实现） |
| `src/update/manifest.js` | 归一化新增可选 `title`（缺失保持 `null`，不编造） |
| `src/update/checker.js` | 「已最新」分支也带回公告字段（该清单此刻已验签，无需再联网） |
| `src/update/service.js` | 每次检查落公告缓存（成功/失败都落）、新增离线 `update.notes`、能力声明 `canShowAnnouncementOffline` |
| `src/app/service-container.js` | 装配 `releaseConfig` / `errorRegistry` / `notesCache` / `product` / `feedback` / `onboarding` |
| `src/app/ipc-runtime.js` | 新增 `feedback.` / `onboarding.` / `product.` 路由；失败方法记录错误码（供诊断） |
| `src/control/ipc-protocol.js` | 私有方法族前缀白名单同步三个新命名空间（否则会在协议层被拒） |
| `scripts/run-all-tests.mjs` | 登记三个新测试套件（不登记会被孤儿检测直接 FAIL） |
| `PROJECT_STATE.md` | Active Work 记录本分支与交付 |

---

## 2. 逐节实现与验收映射

| 任务书要求 | 实现位置 | 验收 |
| --- | --- | --- |
| §一 About：产品名/版本/Build ID/Commit/平台/架构/开发者/官网/GitCode/GitHub | `src/about/build-info.js`、`release-config.json` | `test-product-services`：版本 = package.json、平台/架构、开发者与官网未配置不编造、GitCode/GitHub、许可证、隐私/安全说明可用 |
| §一 更新：当前/最新版本、公告、检查更新、下载源、更新状态 | `src/about/service.js`（`about.update`）+ `src/update/service.js`（`update.notes`/`update.check`） | 离线读取缓存公告、下载源优先级 `[gitcode, github]`、状态 `update_available` / `up_to_date` / `error` |
| §一 许可证/隐私/安全/诊断信息 | `about.info.legal`、`about.diagnostics`、`docs/product/*` | 隐私/安全说明读自文档；安全联系入口 https；诊断与反馈同一口径 |
| §一 不写死版本、读 build/release manifest | `package.json` + `build-info.json` + `release-manifest.json` | `test-product-services`：`build-info.json` 提供 Build ID/Commit、发布清单读取、缺失时如实不可用 |
| §二 公告 version/title/publishedAt/notes | `src/update/manifest.js`、`checker.js`、`notes.js` | 公告四字段齐全；`UP_TO_DATE` 分支同样带公告 |
| §二 不做 HTML 远程注入，Markdown/纯文本安全渲染 | `src/update/notes.js` | 断言 `notes`/`text` 不含 `<script`、不含 `javascript:`，保留可读文本，声明 `plain-text` |
| §三 全局反馈 + 五类类型 + 字段 | `src/feedback/types.js`、`service.js` | 类型 5 种；标题/描述/复现步骤/联系方式；缺标题报 `FEEDBACK_INVALID` |
| §三 安全漏洞单独提示「不要公开提交敏感漏洞」 | `service.js` `securityChannel()` | 安全反馈返回 `notice`（含「不要公开提交」）与官方联系 URL |
| §四 诊断附件可勾选 + 白名单内容 | `src/product/diagnostics.js` | 诊断含版本/平台/Build ID/最近错误码/Provider 与插件状态 |
| §四 禁止包含 Key/token/聊天/Memory/文件正文/private key，必须 redaction | 同上 + `src/logging/redact.js` | 断言以上六类内容不出现在附件里；白名单字段内凭据字样也被二次脱敏 |
| §五 FeedbackService + endpoint 来自官方发行配置 | `src/feedback/service.js`、`release-config.json` | endpoint 未配置时 `configured:false`，不编造地址 |
| §五 网站未上线时允许本地 Outbox | `src/feedback/outbox.js` | 离线提交进入队列、落盘、返回用户可读提示；`endpoint` 未配置时条目保持 `queued` |
| §五 上线后自动/用户确认重试 | `service.js` `flushDue` / `retry` | 5xx → 退避等待（未到点不重发）→ 到点重试成功；4xx → `failed` 不再重试 |
| §五 不因反馈服务器不可用阻塞软件 | `transport.js` 从不抛错 + `submit` 先入队 | 断言离线提交 `sent=false` 且仍返回结构化结果与 `message` |
| §六 安全类型不自动附加日志、最小 metadata、官方安全入口 | `service.js` `resolveDiagnostics()` | 传 `attachDiagnostics:true` 也被强制为 `minimal`，且不含 `recentErrorCodes` |
| §七 7 步首次启动流程 | `src/onboarding/steps.js`、`service.js` | 步骤定义 7 步、必填顺序强制、可选可跳过、`finish` 拒绝未完成 |
| §七 不要求 QQ / DSH / Mobile 才能进入 | `steps.js` 完成条件 + 全链路注入可选 | `test-onboarding`：**只给 stateDir、不注入任何服务**也能完成引导 |
| §八 Provider 页区分普通用户与 Advanced | `src/product/provider-view.js` | `basic = [provider, apiKey, model]`，`advanced` 来自真实 `describeFields()` 且全部非必填 |
| §八 测试连接 | 复用既有 `src/providers/secrets.js#test` + `onboarding.testProvider` | 成功/401/网络失败/HTTP 500/缺 Key 五条路径均有测试与友好文案 |
| §九 空状态明确文案（四类必需） | `src/product/empty-states.js` | 四条必需文案逐字断言；技术错误码映射到同一张表 |
| §九 不要只显示技术错误 | `emptyStateForError` | `message` 恒为产品文案，原始技术串只出现在 `detail` |
| §十 八个验收点 | 三个新测试套件 | 见 §5 |

---

## 3. 安全设计要点

1. **诊断白名单 + 二次脱敏**：`buildDiagnostics` 只从允许字段构造 payload；随后 `sanitizeDiagnostics` 再按同一白名单重建并让所有字符串过 `redactText`。即使调用方把整个设置对象或错误对象塞进来，也只有白名单字段会被读取。
2. **只存错误码**：`createErrorRegistry` 只记录枚举码（`TOOL_DENIED` 等），不记消息；IPC dispatch 失败时集中记录，供 `about.diagnostics` / 反馈附件使用。
3. **反馈通道 https-only**：发行配置里非 https 的 endpoint 直接视为未配置（`INSECURE_ENDPOINT`），避免把诊断信息明文外发。
4. **安全漏洞最小化**：`security` 类型在服务层被强制为 `minimalDiagnostics`（产品名/版本/平台/架构），**不自动附加日志**，并返回官方安全联系入口（显式配置优先，否则由 `repositories.github` 推导私密报告入口）。
5. **引导进度不落凭据**：`sanitizeStepData` 丢弃任何 `key/secret/token/password/credential` 字段；测试断言进度文件里搜不到测试用 API Key。
6. **损坏文件策略区分对待**：引导进度（用户进度）损坏时**拒绝静默覆写**并如实上报，重置需用户显式 `reset`；反馈队列（可丢的待发件）损坏时**另存 `.corrupt-*` 备查**后从空队列继续，保证用户当前这条反馈仍能提交。
7. **不新增裸 `catch`、不新增 `setInterval`**：`test-error-hygiene` 通过（自动重试改为「提交/手动重试时冲一次到期条目」，不引入常驻定时器）。

---

## 4. IPC 契约（UI 后续接线用）

新增/扩展的方法（`ipc-protocol.js` 前缀白名单与 `ipc-runtime.js` 路由均已登记）：

| 方法 | 用途 |
| --- | --- |
| `about.info` | About 页全部产品事实（含 `developer` / `links` / `legal` / `platform` / `release` / `readiness`） |
| `about.update` | 更新区块：当前版本 + 最近一次公告（离线）+ 下载源 + 上次检查状态 |
| `about.diagnostics` | 已脱敏诊断 + 对用户公开的包含/排除策略 |
| `update.notes` | 离线读取最近一次更新公告缓存 |
| `feedback.config` | 类型、长度上限、endpoint 是否已配置、官方安全入口、诊断策略、队列统计 |
| `feedback.submit` / `feedback.list` / `feedback.retry` / `feedback.remove` / `feedback.clear` | 反馈全生命周期（提交永不阻塞） |
| `feedback.previewDiagnostics` | 提交前预览"将要发出去的诊断附件" |
| `onboarding.status` / `start` / `completeStep` / `skipStep` / `finish` / `reset` | 首次运行引导状态机 |
| `onboarding.testProvider` / `setModel` / `connectAgent` / `enableIntegration` | 引导内的动作（连接测试失败返回结构化中文原因） |
| `product.providerView` / `providerFieldGuidance` | 设置页的「基础三项 + 高级折叠」渲染数据 |
| `product.emptyState` / `product.emptyStateForError` / `product.providerTestFailure` | 空状态与技术错误的用户语言 |

桌面壳接线方式沿用既有 `ApiCall::Family`（`native_ui.rs`）即可，无需改动 IPC 客户端。

---

## 5. 测试与验证

新增三个套件（均已登记 `scripts/run-all-tests.mjs`，未登记会被孤儿检测 FAIL）：

| 套件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `scripts/test-product-services.mjs` | 74 | About 构建/发行事实、更新公告安全渲染 + 离线缓存、诊断 redaction、反馈离线队列 / 退避重试 / 队列上限 / 损坏恢复、安全反馈最小 metadata、三个新 IPC 命名空间可达、失败方法写入错误码环 |
| `scripts/test-onboarding.mjs` | 31 | 无 QQ/DSH/移动端/Agent/扩展完成引导、必填顺序、可选跳过、进度持久化、连接测试五条失败路径、默认模型写入设置、损坏文件处理与 reset |
| `scripts/test-product-copy.mjs` | 38 | 四条必需空状态、技术码映射、技术串与产品文案分离、Provider 基础/高级字段、连接失败文案、`product.*` 服务 |

全量聚合器（`node scripts/run-all-tests.mjs`，等价 `npm test`）在本工作区的实测结果：

```
PASS 69 · FAIL 1 · NOT_RUN_ENVIRONMENT 9
```

- 唯一的 FAIL 是 `desktop/cargo:test`，**与本分支无关**（本分支 `desktop-shell/` 零改动），
  16 项 Rust 用例在本会话受限令牌下无法在用户 TEMP 建目录；证据与复现见 §6.5。
- 三个新套件全部 PASS；其余 Node 套件（含 `test-system-pages` / `test-ipc-runtime` / `test-error-hygiene` /
  `test-service-container` / `test-workspace-*`）全部 PASS，说明新增命名空间与装配没有回归。
- 本仓库测试唯一入口是 `npm test`；新增套件已登记 `scripts/run-all-tests.mjs`（未登记会被孤儿检测判 FAIL）。

---

## 6. 未做与后续

### 6.1 桌面壳 UI 未接线（按任务约束）

任务明确「不要大改最终 UI」，且 About 一节写的是「UI 后续需要」。因此本轮只交付**后端服务 + IPC 契约 + 文案数据**，
没有改 `desktop-shell/`（`git status` 可验证：本分支 `desktop-shell/` 零改动）。后续会话按 §4 的契约新增
About / Onboarding / Feedback 页面即可，不需要再动服务层。

### 6.2 发行配置里有四个字段需要发行方填写

`release-config.json` 目前是「结构完整、值待填」：

- `developer`（开发者显示名）、`website`（官方网站）—— 未填时 About 显示「未配置」，**不编造**；
- `security.contact`（官方安全联系入口）—— 未填时回落到由 `repositories.github` 推导的 GitHub 私密漏洞报告；
- `feedback.endpoint`（反馈服务地址）—— 未填时反馈全部留在本地队列（网站 API 尚未上线，这正是预期状态）。

### 6.3 更新公告发布仍是手工步骤

`releases/stable.json` 由 `scripts/sync-gitcode-release.mjs` 生成（本轮未改）；清单现在支持可选 `title`，
发布时带上它 About 才能显示公告标题（否则 UI 回落到版本号）。

### 6.4 自动重试没有常驻定时器

遵循仓库错误卫生基线（`setInterval` 计数只减不增），自动重试发生在「用户提交下一条反馈」或「点重试」时冲一次到期条目。
若后续希望"后台自动补发"，建议由桌面壳的既有生命周期钩子触发 `feedback.retry`，而不是在 Core 里起定时器。

### 6.5 环境限制（与本分支无关，如实记录）

- **`cargo:test`（唯一 FAIL，16/147 项）**：本会话受限令牌下，Rust 测试二进制在用户 TEMP
  （`C:\Users\Administrator\AppData\Local\Temp`）下建目录得到 `ACCESS_DENIED`。
  对照实验：把 `TEMP/TMP` 指向工作区内目录后，同样两个 target 变成 **145 passed / 2 failed**，
  只剩 2 项需要写 `HKCU\Software\WhaleBridgeTest\...` 注册表的 installer 用例如实被拒。
  本分支未改任何 Rust 文件（`git diff --stat ce83264 -- desktop-shell` 为空），非受限环境（CI / Owner 本地）不受影响。
  另注：把 `TEMP` 放进工作区会让 `test-workspace-*` 的「非 repo 工作区」判定反向失效
  （临时目录落进了本仓库），因此正式口径使用默认 TEMP，并如实记录这一项 FAIL。
- **`test-continuity-rollover` / `test-continuity-auto-rollover`**：依赖 `output/` 目录（gitignored），
  全新 worktree/clone 不含该目录时会 `ENOENT` 失败。这是**既有脆弱性**（本分支未改这两个脚本）；
  本工作区创建 `output/` 后两者均 PASS。建议后续把这两个脚本改为自建目录（`fs.mkdirSync(dir, { recursive: true })`）。
- **NOT_RUN_ENVIRONMENT**：`test-mcp-exec` / `test-onebot-connection`（缺真实 SnowLuma 网关）、
  `test-mcp-web-search`（未开 `WHALEBRIDGE_TEST_NETWORK`）、`test-core-dist` / `test-release-candidate` /
  `test-process-extension-sea`（缺发行产物）、`test-desktop-shell` / `test-desktop-install`（缺 debug 桌面壳）。

---

## 7. 交付流程（按 `docs/development/GIT_WORKFLOW.md`）

1. 已完成：分支 `codex/session-20261009-2145-rules-confirm` 上的实现 + 测试 + 报告；
2. **待 Owner 确认**本轮结果；
3. 确认后：合并到本地 `main` → 在 `main` 上复跑 `npm test` → 删除工作分支与隔离 worktree（`.worktrees/2026-10-09-2145`）；
4. 全程 **不 push**（除非 Owner 明确要求）。
