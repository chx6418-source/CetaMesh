# AGENT_CONTEXT — 鲸桥控制台前端 · 结构化上下文说明书
# 文档性质: 多智能体协作唯一事实源 (Single Source of Truth)
# 解析约定: 本文档全篇为缩进式 KEY: VALUE 结构（YAML 兼容）；`[强制]` 前缀条目违反即任务不合规；禁止凭空补充未列出的约束
#
# SUPERSEDED（2026-10-05）：本文件描述的是**旧版 Web 控制台前端**（海盐苏打）的事实源，
# 属历史协作记录。当前产品是 CetaMesh Desktop（原生 Rust/egui 桌面壳 + Node Core），
# 产品事实源为 PROJECT_STATE.md 顶部 CURRENT STATE 与 docs/desktop/ARCHITECTURE.md；
# 不要把本文件的 UI/控制台状态当作桌面产品的当前状态。§A 的开发日志仅具历史价值。

meta:
  doc_version: "1.0"
  doc_date: "2026-09-12"
  doc_scope: "WhaleBridge 前端控制台 UI（海盐苏打 Soda Gummy）"
  doc_maint_rule: "每次需求落地合并后，执行 Agent 必须增量更新本文件 §2/§3/§6 对应字段"
  read_order: "§1 → §6 → §3 → §5 → §2 → §4"

# ================================================================
# §1 项目基础元数据 [MODULE=METADATA]
# ================================================================
metadata:
  project.name: "鲸桥控制台（WhaleBridge · DeepSeek Harness × SnowLuma）"
  project.repo: "D:/GIT-QQ-BRIDGE (git main 分支)"
  project.origin: "2025-08（桥接本体）；前端 UI 重设计启动：2026-09-12"
  baseline.commit_before_ui: "3eff47e（本次 UI 工作前的最后基线）"
  baseline.head: "043f1d4（feat: 参考SnowLuma风格美化控制台令牌登录页）"
  baseline.stack: "Node.js 桥接进程（src/bridge.js，端口 3100）+ 纯前端单文件控制台（public/console.html，由 design-demos/src/console/part1-3 组装）"
  red_line.backend_zero_change: "[强制] src/bridge.js 仅允许「静态呈现层」变更（已批准先例：401 无令牌入口页改为读取 public/token-login.html）；禁止任何 API 行为/令牌校验/会话流程/数据结构变更"
  red_line.mock_first: "[强制] UI 效果验证默认全量 Mock（design-demos 全系 + 独立组件验证）；public/console.html 已接真实 API，但其 UI 迭代仍须先经 Mock/预览通道验证，后端零改动红线不变"
  red_line.no_backtrack: "[强制] 后续 Agent 读取本文件即可生成合规任务，禁止要求人工回溯历史对话记录"
  runtime.production: "http://127.0.0.1:3100（需控制台令牌，config.json consoleToken / state/console-token）"
  runtime.preview: "node design-demos/src/console/serve.mjs → http://127.0.0.1:4173（design-demos 静态预览）"

# ================================================================
# §2 历史迭代全轨迹 [MODULE=HISTORY]（全部发生于 2026-09-12）
# ================================================================
history:
  - step: T1
    date: "2026-09-12"
    action: "生成 10 套风格 Demo（design-demos/，索引 index.html）"
    result: "交付选型"
  - step: T2
    date: "2026-09-12"
    action: "用户筛选：最终选定 F4 海盐苏打（软糖拟物×糖果玻璃融合）"
    result: "进入落地开发"
    deprecated_and_archived: ["F1 莓莓软糖 fusion-1-berry", "F2 薄荷软糖 fusion-2-mint", "F3 蜜桃软糖 fusion-3-peach", "F5 午夜软糖 fusion-5-midnight", "原始参考 ref-soft-ui(06)", "原始参考 ref-candy-glass(10)"]
    archive_path: "design-demos/archive/（已加入 .gitignore，禁止入库）"
  - step: T3
    date: "2026-09-12"
    action: "落地开发：重写 public/console.html（四模块分区 + 真实 API 对接 + Mock 数据双通道）"
    result: "commit 1ab78af"
  - step: T4
    date: "2026-09-12"
    action: "迭代：固定侧边栏/顶栏、字体统一、自定义下拉接管（beautifySelect）、等高排版、空输出框自动隐藏、401 授权弹窗重构"
    result: "commit 95d4607（含此前损坏的 part2/part3 的修复）"
  - step: T5
    date: "2026-09-12"
    action: "迭代：模型选择卡通栏双列、绑定行四列对齐、动态下拉接管、预设行排版"
    result: "commit ade71dc"
  - step: T6
    date: "2026-09-12"
    action: "修复：恢复发送参数卡音量增益滑条（此前被误写为隐藏占位）并接入真实 /api/fileSend"
    result: "commit 84e26f3"
  - step: T7
    date: "2026-09-12"
    action: "新增：请求日志页实时会话状态卡（ss-*）+ 活动日志结构化重构（工具栏/筛选/搜索/暂停/清空）+ 头像方形化（13px）"
    result: "commit e7fb833"
  - step: T8
    date: "2026-09-12"
    action: "修复：移除主题切换全局渐变（theme-anim），消除毛玻璃快速切换的模糊残影"
    result: "commit 24afa47"
  - step: T9
    date: "2026-09-12"
    action: "新增：无令牌登录入口页 public/token-login.html（参考 SnowLuma 登录页），bridge.js 401 分支改为读取该文件（静态呈现层变更，已批准）"
    result: "commit 043f1d4"
  - step: T10
    date: "2026-09-12"
    action: "指令：侧边栏动画回退到「优化动效」完成态 → 滑动胶囊机制整体移除"
    result: "已在 95d4607 之后的源文件中执行，随下次提交固化"
  - step: T11
    date: "2026-09-13"
    action: "[后端·非 UI] 修复「工具图片识别失效」：会话被绑定成文本模型 deepseek-v4-flash，DSH 把图片替换为 [image unavailable: … does not declare image input]（AI 只能回「看不到/一片黑」）→ 桥接默认模型改为 deepseek-flash（DeepSeek-V41-Flash，官方目录声明 text+image）；新建会话仍强制 selectModel 绑定；绑定到不声明图像输入的模型时打告警，并在 /api/images/message 回带说明，避免再次静默失效"
    result: "src/bridge.js（DEFAULT_MODEL / ensureSessionModel / resolveModelImageSupport / imageCapabilityNote）、src/mcp-snowluma-safe.js（透传 note）、config.json、config.example.json、scripts/test-vision-media.mjs、scripts/probe-model-bind.mjs（新增自检）"
    scope_note: "本条为后端模型配置修复（用户直接下达），非前端 UI 迭代；red_line.backend_zero_change 对 UI 任务继续生效"
  - step: T12
    date: "2026-09-13"
    action: "[后端+控制台] 新增「QQ 官方卡片查看」能力：新增 src/qq-card.js（json/ark/xml/lightapp/miniapp 卡片段提取 + 完整原始内容 + 结构化字段解析纯函数）；bridge.js 接入卡片缓存（按会话有界、单独落盘 state/social-v2-cards.json）、消息记录卡片摘要（hasCard/cardCount/cardKinds/cardHint）、GET /api/socialV2/card-message 端点、socialV2.tools.getCardMsg 开关与 toolMap 提示词；mcp-snowluma-safe.js 新增 qq_get_card_msg（**常驻注册 + 执行期读 config.json**，实现开关即时生效无需重启）；控制台「Agent 预设 → 工具开关」新增 qq_get_card_msg 独立开关；whale-chat-v2 preset 增加卡片工具协议条目与用途速查"
    result: "src/qq-card.js（新增）、src/bridge.js、src/mcp-snowluma-safe.js、public/console.html、design-demos/src/console/part2.html、dsh/agent-presets/whale-chat-v2/agent.cordis.yml、config.json、config.example.json、scripts/test-card.mjs（新增，65 项断言全通过）、README.md、RULES.md、docs/PROJECT_GUIDE.md"
    scope_note: "本条为后端工具能力 + 控制台单点开关新增（用户直接下达），未触碰 red_line.backend_zero_change 所保护的 API/令牌/会话行为；控制台仅按既有 v2-tool-item 模式新增一个复选框"
    discovered_issue: "public/console.html 与 design-demos/src/console/part1-3 **已漂移**：重跑 assemble.mjs 会丢失生产控制台的 500+ 行较新功能——见 §6.anchors.assembler_warning"
  - step: T13
    date: "2026-09-13"
    action: "[后端·根因修正] 用户反馈「工具无法查看 QQ 官方卡片内容」。抓取真实群消息（OneBot get_group_msg_history）后确认：QQ 官方机器人卡片**根本不是 json/ark 段**，而是 `markdown` + `inline_keyboard` 两个消息段（raw_message 形如 [CQ:markdown][CQ:inline_keyboard]）。T12 的实现只覆盖 json/ark/xml，因此这类卡片完全没被识别：AI 只看到 [markdown][inline_keyboard] 占位、卡片插图（markdown 里的 ![#宽 #高](https://qqbot.ugcimg.cn/…)）也没进图片管线。修正：src/qq-card.js 增加 `parseBotMarkdown`（去模板头 [](/%7B%22version%22…)/图片转占位并抽 URL/链接与 @提及还原）与 `parseInlineKeyboard`（按钮 label/type/data/style 结构化）、`buildBotMarkdownCard`（markdown+按钮合并为一张卡）、`extractCardMediaFromSegments`（插图进入媒体管线、过滤 ≤64px 装饰图标）；bridge.js 的 segmentsToText 渲染 markdown 正文与 [按钮:…]、extractMediaFromSegments 接入卡片插图；新增 `fetchRawMessageByRef`/`backfillMessageCache`（缓存未命中时用 get_msg 按需回源，归属校验与 resolveReplyInfo 一致）+ 启动后 `backfillRecentCardsV2`（回填历史卡片元数据）；/api/status 增加 cardSegments/cardToolEnabled 能力自描述"
    result: "src/qq-card.js、src/bridge.js、src/forward.js、dsh/agent-presets/whale-chat-v2/agent.cordis.yml、scripts/test-card.mjs（99 项断言，含真实抓包 payload 夹具 + 桥接正向端到端检查）、README.md、RULES.md、docs/PROJECT_GUIDE.md"
    scope_note: "T12 的结论「工具无法查看卡片」由本条修正；T12 的控制台开关、端点、MCP 工具、即时生效机制均保留不变"
    verification: "解析层用真实抓包 payload 验证通过；图片 URL 已验证可直接抓取（safeFetchBuffer 取回 PNG/JPEG）；桥接进程需重启后由 `npm run test-card` 自动完成正向端到端确认（/api/status.cardSegments 含 markdown 时才会执行，避免把「没重启」误判为回归）"
  - step: T14
    date: "2026-09-13"
    action: "[控制台·滚动稳定性] 修复两个刷新/开关页面时的滚动偏移：①「页面持续刷新视口向下漂移」——根因有三：终端 open() 里 `inputEl.focus()` 会把命令输入框滚进视野（实测每次刷新把视口从 400 拽到 782=底部）、浏览器自带滚动恢复按「锚点元素」找位置（模块内容一变就落到 367 这类锚点偏移，实测 400/700 都被拉成 367）、轮询重渲染期间的滚动锚定会改写 window.scrollY。修法：focus({preventScroll:true})、`html{overflow-anchor:none}`、`history.scrollRestoration='manual'` + 自持位置（滚动写 sessionStorage consoleScrollY，加载后 rAF/350ms 两次还原，切换模块仍回顶部）。②「终端页面反复开关内容上下跳变」——根因：每次 /api/terminal/open 都新建 cmd（前端从不回传已记住的会话 id），页面一刷新内容就整段消失；SSE 首帧以 `t` 推送整段回滚缓冲，与 open() 预填内容重复追加；append()/backlog 无条件滚到底把用户翻看的回滚区顶走；SSE onerror 里 `forget()` 丢掉会话 id，网络抖一下就换新会话。修法：前端回传 id + 服务端 `/api/terminal/open` 复用存活会话（返回 reused/buffer/cwd）、流首帧改为 `{snapshot,cwd}` 由前端「替换」而非追加、`#termScreen`/`#rtScreen` 统一「跟随底部」规则（nearBottom 40px 内才自动滚底，内容相同不重写 DOM）、断线只重连不丢 id（1.5s 后带 id 重开，服务端真没了才新建）"
    result: "public/console.html（html overflow-anchor、滚动位置自持、终端 screenEl/rtScreen 的 showScreen/rtAppend/nearBottom、focus.preventScroll、listen() 首帧与 onerror）、src/bridge.js（/api/terminal/open 支持复用、/api/terminal/stream 首帧 snapshot+cwd）"
    verification: "浏览器实测（真实桥接 3100 + 沙箱实例 3199 双端）：4 个模块 × 200/400/700 三档滚动位置刷新后逐一对上（含终端页 400 不再变 782）；带内容会话刷新后 termSession 不变、内容长度与标记数完全保留、无重复；终端面板上翻后执行新命令 scrollTop 保持 60 不动、回到底部后继续跟随。沙箱内单点验证服务端协议：同 id 复用得 `reused:true`+回滚内容、无效 id 才新建、流首帧为 `{snapshot,cwd}`"
    scope_note: "服务端复用需重启桥接生效（前端已向后兼容：旧后端首帧仍走 `t`，靠 firstFrame 去重避免重复）；沙箱验证用的临时实例与 stub OneBot 已删除，未触碰运行中的用户桥接与 QQ"
  - step: T15
    date: "2026-09-13"
    action: "[样品阶段·未落地] 令牌登录页视觉优化 + 两套过渡动画：按用户要求「先出 10 份样品演示视频、选定后再落地」，新建 design-demos/login-proposals/（不动 public/token-login.html）。10 套方案共用一套骨架（assets/base.css 结构+主页面示意 / assets/chrome.js 注入登录卡片与主页面 DOM / assets/stage.js 驱动 enter·to-app·app-live 三个状态类 + ?take=1 隐藏操作提示 + ?enter=<ms> 录屏起帧延迟），每套 pNN.html 只写自己的 token、光源层与两段动画：p01 柔雾浮起、p02 软糖按压（涟漪遮罩）、p03 糖果玻璃（三层错位推进）、p04 分层绽放（光环+径向擦除）、p05 霓虹苏打（深色，主页面同步深海配色）、p06 纸感折页（3D 翻页）、p07 极光漂流（mask 波纹）、p08 气泡上浮（气泡膨胀覆盖）、p09 柔光浮雕（光源旋转）、p10 终端脉冲（扫描线+窗口最大化展开）。功能框架原样保留（#t / #eye / #go / #err 与空值校验、Enter 提交），样品不真跳转，演示落点是同页主页面示意"
    result: "design-demos/login-proposals/{index.html（画廊：10 段视频 + 光影/入场/转场说明 + 单页打开/下载）、p01–p10.html、assets/{base.css,chrome.js,stage.js,bubbles.js}、videos/pNN-*.webm（10 段，1280×800@30fps≈5.6s，ffmpeg 重封装补 Duration 以便拖动进度）、serve.mjs（端口 4174，含 webm/mp4 MIME 与 Range）}；design-demos/index.html 增加入口链接"
    verification: "逐页渲染自检（10 页卡片可见、主页面隐藏、功能元素在位、p08 气泡 13 个）；10 段视频用浏览器录制 API 生成后逐段抽帧核对（入场中段/落定/转场中/主页面落点），并对 10 套登录画面做了横向对照；ffmpeg 重封装后 duration=5.6s 且 seekable 全部可拖动"
    scope_note: "本阶段刻意不落地：生产文件 public/token-login.html、public/console.html 均未改动（red_line.backend_zero_change 未触碰）。录屏格式为 WebM（本机 ffmpeg 无 libx264，未另出 MP4；画廊用 <video> 内联播放）。视频约 12MB 二进制，未提交（如需入库或加 .gitignore 待用户定）"
  - step: T16
    date: "2026-09-13"
    action: "[样品阶段·未落地] 用户选定方案 09，要求：①入场只做细节小优化；②转场按「不同卡片如同湖面涟漪般依次上浮」基于方案 9 再出 10 套变体（其余样品不动）。做法：把方案 9 的材质与入场抽成共享 assets/emboss.css（含 4 处细节优化：内容错开 0.78/0.86/0.94/1.02 → 0.60/0.68/0.76/0.84 收到 1.4s 内、光源旋转 1.5s→1.15s、卡片补一道极淡斜向柔光扫过、输入框加「压入回弹」微动作、底纹落定后极缓呼吸），p09.html 改为引用该文件且保留原转场；新增 assets/ripple.js 作为涟漪编排器——转场开始时按「卡片中心到点击处的距离 ÷ --wave-speed」写 --rise-delay（波前度量支持 --wave-axis: radial/y/diag/order），并注入 .ripple-lake 三个涟漪环 span；涟漪动画默认 animation-play-state: paused，body.to-app 时才 running，保证 delay 从转场那一刻起算而不是页面加载时就走完（这个坑实测会让涟漪完全消失）。10 个变体 p09-t01…t10 只写各自的波前参数、涟漪环外观与 riseTxx 关键帧：01 涟漪原波（圆形波前，建议默认）、02 同心双波（第二道波追上时略沉再落定）、03 横向波前（自上而下逐排）、04 对角风纹（45° 推进 + 落定前轻微倾斜回摆）、05 浮标缓起（波速六成、起得高、阴影先散后收）、06 水滴弹起（压扁→弹起→顶边白边闪）、07 镜光水波（主页面水下焦散 + 卡片表面反光扫过）、08 层叠上浮（固定顺序、每张 120ms，侧栏→顶栏→页头→三卡）、09 压入回弹（先凹陷内阴影压住 150ms 再翻外阴影弹起）、10 静水浮升（不画涟漪环，只有水位缓升 + 最慢最无过冲）"
    result: "design-demos/login-proposals/{assets/emboss.css（新增，方案9材质+入场+转场骨架）、assets/ripple.js（新增，涟漪编排器）、p09.html（改为共享材质 + 入场优化）、p09-t01…p09-t10.html（10 变体）、videos/p09-soft-emboss.webm（按优化后入场重录）、videos/p09-t01…t10-*.webm（10 段新视频，≈6.4s）、index.html（画廊改为 §1 首轮 10 案 + §2 涟漪 10 变体两区）}"
    verification: "浏览器实测编排：t01 的 --rise-delay 按距离算出 0→353ms 共 13 档，转场 420ms 时近处卡片 opacity 0.97-0.99、远处 0.43-0.53（依次上浮成立）；t08 延迟为 0/120/240…1440ms，420ms 时只有前 3-4 项可见、其余为 0（层叠节奏成立）；两者结束时卡片全部可见、主页面可见、登录舞台隐藏。11 段视频逐段抽帧核对（p09 优化后入场、4 个变体的涟漪中段 4 帧横向对照），ffmpeg 重封装后 duration≈6.34-6.37s 且可拖动；画廊 20 段视频全部 readyState≥2、无 Infinity duration"
    scope_note: "仍属样品阶段，未落地生产文件；服务端/桥接零改动。变体中 05/10 时长更长（1.25s/张），录屏尾帧留了约 1.6s 观察落定"
  - step: T17
    date: "2026-09-13"
    action: "[正式落地] 用户定版：方案 09「柔光浮雕 Soft Emboss」+ 涟漪变体 10「静水浮升」。① public/token-login.html 全量重写为该设计：低对比 neumorph 材质（同色系、无描边无玻璃、双光源明暗差、卡片前后两圈浮雕底纹、内凹输入框、凸起按钮），入场动画（光源旋转落定 → 卡片浮起 + 一道极淡柔光扫过 → 内容依次上浮 → 输入框压入回弹 → 底纹极缓呼吸），提交转场（卡片压入水面 + 水位/环境光下沉 600ms，写入 sessionStorage.loginArrive 后跳转）；功能框架与原先一致（#t / #eye / 空值校验 / Enter 提交 / location.href='/?token='）。② public/console.html 新增落场段：head 里极早读一次 loginArrive 标记并给 <html> 打类（卡片从第一帧就是未浮起态，避免闪一下），启动时按「离屏幕中心的距离」给当前模块 .card 与 .nav-btn 写 --arrive-delay（上限 760ms），叠加一层 .arrive-tint 水色薄雾，2.4s 后移除类/薄雾/内联变量，全部清理干净。③ 方案管理：未选中的样品（design-demos/login-proposals/，含 24MB 视频）加进 .gitignore，仅作本机参考资料保留、不入库"
    result: "public/token-login.html（重写）、public/console.html（CSS arriveRise/.arrive-tint + head 标记脚本 + 启动编排）、.gitignore（忽略 design-demos/login-proposals/）、design-demos/index.html（入口链接标注「本机参考资料，不入库」）、AGENT_CONTEXT §6 login_page 锚点更新"
    verification: "真实浏览器走完整流程（localhost:3100 未授权 → 登录页）：入场截图确认（浮雕卡片 + 两圈底纹 + 内凹输入 + 凸起按钮）；点登录后 260ms 截图确认卡片已压入水面（leaving 类在位、内容淡出）、环境光滤镜实测由 brightness(1) 平滑降到 0.955（伪元素上的 transition 不生效，改用 keyframes 后才动）；跳转后控制台 html.login-arrive 在位、.arrive-tint 在位、14 个元素（当前模块卡片 + 导航）拿到 0→429ms 的距离延迟、动画中段可见前几项 opacity≈1.00 而末几项 0.95（依次浮升成立）；2.4s 后类/薄雾/内联变量全部清空、控制台数据正常（DSH 在线、模块 models）"
    scope_note: "桥接后端零改动（红线未触碰）；两个前端文件随请求即时生效、无需重启桥接。样品仍可用 node design-demos/login-proposals/serve.mjs（4174）预览，但已不进版本库"
  - step: T18
    date: "2026-09-13"
    action: "[落地优化·主题联动] 针对已落地的「卡片如湖面涟漪依次上浮」做主题深度联动与衔接优化：① 配色同源——登录页新增 :root[data-theme=light|dark|warm] 三套 token，直接照搬 console.html 同名字段（--accent/--accent-2/--accent-soft/--accent-shadow/--text*/--shadow-c1/c2/--err），浮雕材质与双光源阴影全部改用这些 token（只新增 --emboss-base/--emboss-surface 两个底色），于是登录页与控制台在三个主题下是同一套配色；② 主题抢在首帧——登录页在 <style> 前读 localStorage.consoleTheme 定 data-theme，控制台在 <style> 后立刻设 data-theme（原先要等主脚本，深色/护眼用户会先看到一瞬浅色底）；③ 波前改为匹配功能模块排布——落场不再按「离屏幕中心距离」，改为先把当前模块 .card 与 .nav-btn 按视觉行分桶（26px 容差）再按行内左→右排序，行距自适应（ROW_BUDGET 880ms ÷ 行数，夹在 58~110ms），行内再 55ms 微错开，于是按「侧栏水岸 → 顶栏 → 页头 → 卡片逐行」推进且每行都有独立时刻（实测 14 项 14 个不同延迟）；④ 粒子元素——两页各加一套「水汽」粒子（≤20px、低透明度、blur .6px，用 var(--accent) + var(--shadow-c2)/var(--edge-hi) 取主题色），登录页从卡片下沿浮起 10 颗、控制台每张卡片浮起时下沿放 3 颗（最多 8 张卡 24 颗），共用同一套微光径向渐变与上浮淡出关键帧；⑤ 消断点——跨页时控制台在 head 里给根元素垫一层主题底色（仅落场时设、2.6s 后连同薄雾/粒子/内联变量一起清掉），消除跳转瞬间闪白；落场薄雾也改用 var(--accent-soft)（深色下不再是一层突兀浅蓝）"
    result: "public/token-login.html（三套主题 token + 材质/阴影/按钮全部 token 化 + leaving 水汽粒子 + 主题早读）、public/console.html（head 早读主题与标记 + 落场按模块排布排波前 + .arrive-mote 粒子 + 与主题同源的薄雾/底色）"
    verification: "三主题实测：切主题后登录页与主页面 token 完全一致（dark bg rgb(19,26,46)/card #171f36/accent #8ba4ff；warm #e8ecdf/#eef1e6/#6a7fae；light #e9eefb/#eef2fc/#5b7cfa）并截图核对；深色下登录页收尾截图可见卡片压入 + 水汽升起；落场实测浅色 14 项延迟 0/73/146/219/292/365/438/511/584/657/730/785/803/876ms 全部不同、中段透明度由 0.98 递减到 0.00 的水波；薄雾取 var(--accent-soft)、粒子取 var(--edge-hi)+var(--accent)（深色下即 #8ba4ff）；2.6s 后类/薄雾/粒子/内联变量/内联底色全部清空；回归：主题三按钮切换正常、普通刷新不播落场且 T14 滚动自持仍准（250/620 精确保持）"
    scope_note: "仅前端两文件。主题 token 在登录页是手动同步（登录页没有共享样式文件的通道），改主题色时需两处一起改，文件注释已标注。桥接后端零改动"
  - step: T19
    date: "2026-09-13"
    action: "[回退] 用户要求「回退到上次改动」→ 撤销 T18（转场主题联动那版），public/token-login.html 与 public/console.html 都还原到 T17 落地的状态：登录页回到固定浅色浮雕配色（不再跟随 consoleTheme，head 里没有主题早读）、退场不再放水汽粒子；控制台的落场恢复为「按离屏幕中心距离排序 + 固定蓝色薄雾（rgba(120,150,235,.13)）」，去掉 T18 的行分桶排布、自适应行距与水汽粒子、去掉 head 里的主题早读与防闪白底色。T18 的实现留档在 public/token-login.html.bak-t18 与 public/console.html.bak-t18（已被 .gitignore 的 *.bak-* 覆盖，不入库），若要恢复本轮优化，把这两个文件覆盖回去即可。"
    result: "public/token-login.html（还原）、public/console.html（还原：head 脚本 / 落场 CSS / 落场 JS 三段）、public/*.bak-t18（新增，T18 留档，未入库）"
    verification: "回退后实测：把 localStorage.consoleTheme 设成 dark 再进登录页，html 无 data-theme、底色仍是 rgb(233,238,251)/卡片 rgb(238,242,252)（不再跟随主题）；退场 leaving 无水汽粒子；落场延迟恢复为中心距离排序（429/405/384/367/355/346/0/2/303/608/760…，远端封顶 760ms）、薄雾为固定 rgba(120,150,235,.13)、无粒子、无内联底色；2.6s 后类/薄雾/内联变量清理干净，控制台数据正常；主题切换按钮与 T14 滚动自持不受影响"
  - step: T20
    date: "2026-09-13"
    action: "[主题联动·第二版] 用户重新要求「转场全程与主页面主题体系深度联动 + 增加主题颜色渐变效果 + 全流程无断点」，并**不再要求粒子元素**。做法（在 T19 回退后的基线上重做，并升级）：① 配色同源——登录页加回三套 :root[data-theme=light|dark|warm] token，照搬 console.html 的 --bg / --accent / --accent-2 / --accent-soft / --accent-shadow / --text* / --shadow-c1/c2 / --err，浮雕材质与双光源阴影全部 token 化（只留 --emboss-base/--emboss-surface 两个底色）；② 主题抢在首帧——登录页在 <style> 前读 consoleTheme，控制台在 <style> 后立刻设 data-theme；③ 节奏匹配模块排布——落场波前按视觉行分桶（26px 容差）+ 行内左→右排序，行距自适应（880ms ÷ 行数，58~110ms），行内 55ms 微错开；④**新增跨页主题色渐变接力**——两页共用同一条渐变（`linear-gradient(152deg, var(--accent-soft) 0%, transparent 44%, var(--accent-soft) 100%)`，background-size 190% 190%）：登录页收尾把 ::after 渐变层推到 opacity .55 / background-position 0% 100%，同时底色淡到 var(--bg)（= 控制台的 --bg，两页底色对齐）；控制台 .arrive-tint 从**完全相同的梯度、尺寸、相位、透明度**出发，继续推到 100% 0% 并淡出（1.7s）——于是跨页那一下看到的是同一种颜色在同一个方向继续流动，没有接缝；⑤ 防闪白——控制台 head 里在落场时给根元素垫上主题底色（清理时移除）。粒子元素按本轮要求未加回。"
    result: "public/token-login.html（三套主题 token + 材质/阴影/按钮 token 化 + body::after 渐变接力层 + 收尾底色改为 var(--bg) + 主题早读）、public/console.html（head 早读主题与标记 + 防闪白底色 + 落场按模块排布排波前 + .arrive-tint 改为同相位渐变接力）"
    verification: "三主题实测「收尾态 → 落场首态」逐项对齐：light 收尾底色 rgb(238,242,252) = 控制台 --bg ✓ 渐变层两边同为 `152deg, rgba(91,124,250,.13)…` 且收尾 opacity .53/位置 2.8% 97.2%、落场从 0% 100% 继续推并降到 .07→0 ✓；dark 底色两侧同为 rgb(19,26,46)、渐变为 rgba(139,164,255,.16) ✓；warm 收尾底色 rgb(234,237,224) 与控制台 --bg 完全一致 ✓；三主题下 14 个元素都是 14 个互不相同的延迟（行分桶+自适应行距生效）并截图核对；2.6s 后类/渐变层/内联变量/内联底色全部清空、控制台数据正常（DSH 在线）；回归：主题三按钮切换正常且不留内联底色、普通刷新不播落场、T14 滚动自持精确（250/620）"
    scope_note: "仅前端两文件；桥接后端零改动。主题 token 在登录页是手动同步（登录页无共享样式通道），文件注释已标注。T18 的旧版留档 public/*.bak-t18 保留未删（已 gitignore）"
  - step: T21
    date: "2026-09-13"
    action: "[优化·按用户录屏] 用户发来一段 7.4s 屏幕录制（1524×970）只说「优化」。用 ffmpeg 抽帧（fps=1.6 网格 + 2.6/3.1/4.2s 单人帧）后定位到三个问题：① 渐变接力层用了三段渐变（accent-soft → transparent → accent-soft）+ background-size 190% + 动画 background-position，在视口里切出一条生硬的横向色带（2.6/3.1/4.2s 三帧都在，y≈690 与 y≈965 处有明显边界）；② 整页被这层薄雾盖成灰白发糊（连已经浮起来的卡片也是灰的）；③ 卡片从 opacity 0 起跳 + 总错开 880ms + 单张 1.25s，落场前 1s 内下半屏是一大片空白，像没渲染完。修法：① 接力层改成单一方向的柔和径向渐变 `radial-gradient(130% 92% at 50% 106%, var(--accent-soft), transparent 60%)`，推进改用 transform（translateY 10%→0 / 0→-8%）而不是改 background-position —— 结构上不可能再出色带；② 强度从 opacity .55 降到 .42、时长从 1.7s 收到 1.05s；③ 卡片起始透明度 0 → 0.3（版面始终「在」，只是没浮到位）、总预算 880→520ms、行内错开 55→40ms、行距自适应 58~110 → 45~95ms、单张时长 1.25→0.95s、清理 2600→2200ms。"
    result: "public/console.html（.arrive-tint 换成径向渐变 + transform 推进、arriveRise 起始 .3/时长 .95s、ROW_BUDGET 520 / COL_STEP 40 / ROW_STEP 45~95、清理 2.2s）、public/token-login.html（body::after 接力层换成同一条径向渐变 + translateY 10%→0、opacity 收到 .42、时长 .6s、跳转仍 620ms 对齐）"
    verification: "优化后实测（1524×900 视口）：落场中段截图 —— 侧栏与上半卡片已清晰、下半卡片以 0.3 起步可见（无空白）、渐变色带消失；14 项延迟收敛到 0/45/90/…/540ms，落场开始约 0.95s 时 tint opacity 已到 0.04、约 1.5s 时全部卡片 opacity ≥0.99 且 tint 归零；登录页收尾中段截图 —— 渐变层 opacity .36、位移 12.9px 继续归零、底色 rgb(237,241,252) 正朝控制台 --bg 收敛；对照 T20 的旧帧（2.6s 仍整页发糊 + 下半屏空白 + y≈690 硬色带）三项问题均消除。另注：IAB 的 tab 录制在跨页导航时会自动 cancel，所以这次的回归改用定时截图核对，没有产出视频"
    scope_note: "仅前端两文件；桥接后端零改动。用户录屏里看到的问题与我上一轮（T20）引入的渐变层实现方式直接相关，本条即是针对它的修正"
  - step: T22
    date: "2026-09-13"
    action: "[按用户明确口径重做转场配色] 用户口径：「令牌登录页颜色不变，在进入主页面转场动画之间加入颜色渐变。在点击登录后，登录页面从右下角开始渐变成主页主题的背景色」——即撤回 T20 把登录页整体主题化的做法（登录页在任何主题下都保持自己的浅色浮雕配色），主题色只在点击登录后的那一段渐变里带进来，且渐变起点是右下角。做法：① 登录页删掉三套 :root[data-theme=*] token 与 head 里的主题早读，全部恢复为固定浅色取值（与 T17 一致）；② 新增 `.morph` 层：以右下角为圆心的一颗软边圆（`width/height: 240vmax` + `border-radius: 50%` + `radial-gradient(closest-side, var(--morph-bg) 56%, transparent 100%)`），`transform-origin: 100% 100%` 从 `scale(0)` 放大到 `scale(1)`（0.64s）—— 半径随缩放线性增长，看到的是从右下角稳稳推过来的一道渐变（不像 background-size 那样前 40% 就把整页盖住）；目标色 `--morph-bg` 由脚本按 `localStorage.consoleTheme` 注入（light #eef2fc / dark #131a2e / warm #eaede0），跳转定在 640ms 与铺满对齐；③ 控制台彻底删掉 `.arrive-tint` 薄雾层（登录页收尾已经把主题底色铺好，控制台首帧就是同一底色，少一层就不会发糊），落场只保留卡片按模块排布依次上浮（0.3 起步 / 0.95s / 波前 520ms），清理收到 2.0s。"
    result: "public/token-login.html（去掉主题 token 与早读、新增 .morph 右下角渐变层、跳转 640ms）、public/console.html（删除 .arrive-tint 及其创建/清理、注释同步）"
    verification: "深海主题实测（1280×800）：登录页底色仍 rgb(233,238,251)、无 data-theme（颜色不变 ✓），`--morph-bg` = #131a2e；点击登录 140ms 截图可见深色自右下角带着软边向页面推进（浅色卡片被覆盖中）；约 0.4s 后整页为该主题底色，随后控制台以同底色出现、卡片由 0.3 依次浮起、无薄雾无发糊（连续两帧截图核对，深色下清晰）；浅色主题下同样流程通过（--morph-bg #eef2fc，视觉上几乎无感，属预期）；回归：落场 2.0s 后类/内联底色/内联变量全部清空、控制台数据正常、主题三按钮切换正常、普通刷新不播落场且 T14 滚动自持精确（250/620）"
    scope_note: "仅前端两文件；桥接后端零改动。登录页自此与主题解耦（固定配色），主题色只在右下角渐变里出现 —— 若以后想让登录页也跟随主题，可参照 T20/T21 的留档（public/*.bak-t18）"

  - step: T23
    date: "2026-09-13"
    action: "[新增·湖面涟漪主题背景渐变 + 与登录动画融合] 用户口径：以参考图 1（登录页背景）为渐变**起始基底**，参考图 2/3/4 分别为三组渐变**目标结束背景**，做出「起始→第二/三/四张」三组主题背景渐变动画，过渡要带**自然的湖面涟漪扩散质感**；先出 **5 版不同参数**方案，选定 1 版后与已落地的登录动画**融合**，融合必须**保留原登录动画完整效果、不做任何修改**。做法：① 新建 `design-demos/bg-ripple/`（引擎 + 画廊 + 定格对照 + 单版全屏 + 本机服务 + 工具链），不碰生产文件。② 背景配方不靠肉眼调色：参考图 2/3/4 就是控制台三个主题的 `.bg-decor` 画布（linear 130deg 三段 + 三个 `blur(72px)` 光斑 + 顶部薄雾），直接把 `public/console.html :root[data-theme=*]` 的真实 token 写成配方；起始基座照抄登录页 `body` 背景（linear 150deg + 左上白光 + 右下冷光）。四套背景用 2D canvas 按 CSS 层叠顺序 1:1 复刻后烘成纹理（纯平滑渐变，长边压到 640–900px 再放大，观感无损）。③ 涟漪质感放在一张 WebGL 片元着色器的**遮罩**里：波前推进 p + 双频叠加波列（跟随波前的同心明暗环，相位同样吃噪声、再用斑驳调制打散，避免等高线感）+ 噪声有机扰动 + 波面折射位移（沿波前法线微位移，像透过水波看背景）+ 波峰亮线 + 水面微光；涟漪包络取 `sin(πp)`，起落两端归零 → 过渡首尾都是干净的静止色。双波源版本两道波前相遇自然干涉。④ 5 版只差参数与时间轴：V1 涟漪原波（同心圆 · 右下起波 · 标准衰减）、V2 静水深流（大波长 · 慢衰减 · 中下起波）、V3 风纹横波（横向波前 · 自下而上 · 蛇形摆动）、V4 镜面焦散（密波 11 · 强折射 · 明显波峰亮线）、V5 满月潮汐（双源干涉 · 长周期 · 收尾阻尼回弹）；时间轴均为「每组都从起始基座出发 → 停留 → 涟漪回落 → 间隔」，`setTime(ms)` 可确定性定位（截图/逐帧/定格对照都靠它）。⑤ 选定 **V1**（与现 `.morph` 退场同向、最自然、不与登录卡片抢视觉），融合方式为**纯新增**：`tools/fuse-login.mjs` 从冻结基线 `tools/fixtures/token-login.baseline.html` 生成 `public/token-login.html` = 基线 + 4 个标记块（`bg-ripple:css/markup/engine/init`），块外零字符改动；引擎因桥接只服务两个固定 HTML（无静态资源通道）只能内联。⑥ 降级：无 WebGL / `prefers-reduced-motion` 时整层移除或保持透明，登录页回落到自身背景。"
    result: "design-demos/bg-ripple/{ripple-bg.js（引擎唯一事实源）、index.html（5 版画廊 + 统一时间轴）、compare.html（5 版 × 3 组渐变定格对照）、view.html（单版全屏 ?v/?t/?hud）、serve.mjs（4175，支持 ROOT/PORT 覆盖）、README.md、tools/{fuse-login.mjs、check-fusion.mjs、sample-colors.mjs、png.mjs、compare-bg.mjs、fixtures/token-login.baseline.html}}；public/token-login.html（融合，+29505 字符纯新增）；design-demos/index.html（入口链接）"
    verification: "① 起步基底一致性：`compare-bg.mjs` 逐像素比对「静止基座渲染帧 vs 登录页自身背景」（1280×800，排除卡片与 620/420px 浮雕底纹及其 60px 投影区域，计 470464 像素）→ 平均最大通道差 1.37、峰值 7/255、>6 的像素占比 0.00%（差异来自 canvas 与 CSS 渐变的光栅化取整 + 抖动），即静止时两者视觉一致。② 融合合规：`check-fusion.mjs` 两条硬校验 PASS —— 剥离 4 个标记块后与基线**逐字节相同**（原动画零改动）、内联引擎与 `ripple-bg.js` **逐字节相同**（无漂移）。③ 融合页实测（1280×800）：入场仍完整播放（t=384ms 卡片 opacity .657/scale .977/translateY 15.97px、底纹 .634、内容 0；t≈2.05s 全部落定）；涟漪背景独立推进（停留 · soda → 涟漪回落 · 起始基座）；空值提交仍报「请输入控制台访问令牌」且不离开；填令牌后 body.leaving、卡片 `sink` 动画、`.morph` scale(0)→0.573→铺满、640ms 跳转全部照旧。④ 逐版截图核验：5 版 × 3 组渐变在 45%/70% 定格下的涟漪质感横向对照（V4 焦散最"水光"但起波点在画面中心、与卡片抢视觉；V2 收尾最柔；V1 最自然且与退场同向）。"
    scope_note: "生产文件只动了 `public/token-login.html` 一个（且仅新增）；`public/console.html` 与 `src/*` 零改动。融入的涟漪层只在背景：静止=登录页自身背景，运行=三组主题背景之间做涟漪过渡，主题次序固定 A 苏打 → B 深海 → C 护眼，不读 localStorage.consoleTheme；运行时可用 `window.__loginRipple` 暂停/定格/换版/调强度。引擎改动后必须重跑 `fuse-login.mjs` 同步内联副本，否则 `check-fusion.mjs` 会失败。"

  - step: T24
    date: "2026-09-13"
    action: "[定版收敛 + 细节/流畅度优化] 用户口径：「选择 V1 涟漪原波，优化一下细节和流畅度，其它方案删掉」。① **删掉其它方案**：`ripple-bg.js` 从 `VARIANTS[5]` 收敛为单个 `PRESET`，并删掉只有 V2–V5 用到的机制——双波源干涉（uOrigin2/uDual/uRMax2）、横向/对角波前（uMode/uSway 与 fY/fDiag 分支）、`setVariant` 换版接口，改为 `configure(patch)` 微调；lab 侧删掉 `compare.html`（5×3 定格对照）与 `view.html`，合并为单页 `index.html`（全屏预览 + 参数面板 + `?t/?hud/?mix`）。② **细节与流畅度**：先量了帧率——1920×1080 与 3840×2160 两档 rAF 间隔 p50/p90/p99 全为 16.7/16.7/16.8ms（vsync 锁满 60fps），所以瓶颈不在帧率而在**动效本身**；查出并修掉一个真实物理问题：原 `waveSpeed` 是绝对常数，波列在 field 上的行进速度只有波前速度的 **1/8**，涟漪环几乎是"停在原地被波前甩开"；改为**同源同速**——`waveRate = span ÷ inDur × travel`（travel=0.85 = 波峰略慢于波前，真实水面就是这个关系），波列与波前一起向外跑。同时补三项水体质感细节：**频散**（边界柔和度与波峰线宽度随距离增加 = 高频先被水吃掉）、**耗散**（涟漪环额外乘 `exp(-field*0.35)`，越远越弱）、包络改 `sin(πp)^0.85`（"落水"那一下更利落）。节奏由 4.32s/组放宽到 4.80s/组（停留 1.0→1.1s、静息 0.42→0.80s 让每组之间有呼吸），整轮 14.4s。性能与稳定性：渲染面积封顶 2.4M 像素（4K 自动降采样）、`.ripple-bg` 加基座兜底背景（画布出首帧前不闪白）、构造期首帧不再回调 `onPhase`（原来会在 `bg = new RippleBg(...)` 赋值完成前调用，页面回调里读 `bg.playing` 必崩——实测就是这个错）。③ **融合层细节**：登录页改为**延迟起波**——入场动画（约 1.5s）落定后才 `play()`，入场期间画面是纯净基座、不与背景动效抢注意力；`serve.mjs` 改为静态根只暴露 lab 目录 + `/public/token-login.html` 一条白名单路由（不再把仓库根挂成静态目录）。"
    result: "design-demos/bg-ripple/ripple-bg.js（收敛为单 PRESET + 同源同速波列 + 频散/耗散 + 面积封顶 + configure()）、index.html（单页预览，替代原 index/view/compare 三页）、serve.mjs（白名单路由）、README.md、tools/fuse-login.mjs（init/延迟起波 + CSS 兜底色）、public/token-login.html（由基线 + 标记块重新生成）"
    verification: "`check-fusion.mjs` 两条硬校验仍 PASS（剥离标记块 == 基线逐字节、内联引擎 == ripple-bg.js 逐字节；融合后 37913 字符，内联引擎 23358 字符，比收敛前少 4.2KB）。静止基座一致性复测（改着色器后重跑）：平均最大通道差 1.12、峰值 5/255、两边平均色同为 #e9eefa、差值>6 占比 0.00%（优于收敛前的 1.37/7）。延迟起波实测：t=550ms 卡片 opacity .958 / 底纹 .815 且 `playing=false`（p=0，纯净基座）→ t=1265ms 入场落定、涟漪仍未启动 → t=1982ms 起波并扩散到 p=0.555 → t=3506ms 到达「停留 · soda」。新波列质感逐帧核对（t=330/620/980）：涟漪环随波前一起向外推进、远处更糊更弱，不再是等高线般的静止同心圈。"
    scope_note: "生产文件仍只动 `public/token-login.html`（且仅标记块内新增）；`public/console.html`、`src/*` 零改动。已删除的 4 版参数与机制不再存在于代码（参数记录见 T23）。lab 预览统一到 4175（原 4176 是临时对照用的仓库根服务器，已关闭）。`window.__loginRipple.pause()` 若在加载后 1.5s 内调用，会被延迟起波的定时器覆盖——只影响开发调试，页面正常流程无影响。"

  - step: T25
    date: "2026-09-14"
    action: "[按用户口径改落点 + 主题联动] 用户口径：「登录页面不要渐变动画，只在进入主页面时出现。且渐变动画未能与主题背景进行很好的联动要优化」（附 26s 录屏）。看录屏确认问题：登录页待机时在**自顾自轮播三套主题背景**（4s 处正轮到护眼绿），而实际落地的控制台是苏打浅色——动画与主题毫无关系。做法：① **登录页整层撤掉**：`public/token-login.html` 从融合态还原为基线（T22 状态），一点涟漪都不留；② **落点移到控制台落场**：涟漪改在「进入主页面」时播一次，**起始 = 登录页 `.morph` 退场已经铺满的那个主题底色 `--bg`**（跨页零色差，不需要再用参考图 1 的复合背景，否则深色用户会在落场瞬间被一层浅色盖住），**目标 = 当前主题自己的 `.bg-decor` 画布**（`RippleBg.THEME_MAP`：light→soda / dark→deep / warm→warm）——主题是哪个就扩散到哪个，这就是「联动」；③ 引擎加 `mode: 'once'`（扩散完回调 `onDone`，不做回落与循环）+ 纯色基座配方（`from: { solid }`）+ 主题映射表；lab 页改为两模式：①进入主页面（可切三主题验证联动）②三组渐变循环（保留最初那三组「起始图→第 N 张目标图」的演示）；④ 融合方式仍是**纯新增标记块**，但这次改在 `public/console.html`（4 块：css/markup/engine/init），图层排在 `.bg-decor` 之后同为 `z-index:-1`（同级按文档顺序绘制 → 盖住主题画布、仍在所有内容之下，毛玻璃面板取景不会被浅色底冲淡）；默认 `display:none`，只有 `html.login-arrive` 才显示，普通刷新根本不参与渲染；扩散落定 `onDone` 即 `destroy()` + 移除画布交还给控制台自己的画布；另加 `MutationObserver` 监听 `data-theme`，落场期间切主题立刻收尾。"
    result: "public/console.html（融合落场涟漪，+28151 字符纯新增）、public/token-login.html（还原基线，0 涟漪）、design-demos/bg-ripple/{ripple-bg.js（once/loop3 双模式 + THEME_MAP + 纯色配方）、index.html（两模式 lab）、serve.mjs（+ /public/console.html 白名单）、README.md}、tools/{fuse-console.mjs（替代 fuse-login.mjs）、check-fusion.mjs（三条校验）、fixtures/console.baseline.html（新增，冻结控制台基线）}"
    verification: "① 三主题联动实测：light → `from solid:#eef2fc / to soda`、dark → `solid:#131a2e / deep`、warm → `solid:#eaede0 / warm` 全部命中。② 落场时间轴（1440×900，light）：p=0.12@346ms → 0.62@685 → 0.87@1013 → 0.98@1340 → 1.0@1666 → 画布已撤@1992（hasCv=false）→ login-arrive 类被控制台自身清理@2321（控制台原有 2s 清理时序未受影响）。③ 撤层无痕（落定后「带画布」vs「撤画布」逐像素）：平均最大通道差 **0.001**、峰值 **2/255**、两边平均色完全相同（dark #212a45 / warm #eef1e5）—— 烘焙复刻与原 CSS 画布几乎逐像素一致，交还瞬间看不出。④ `check-fusion.mjs` 三条 PASS：控制台剥离标记块 == 基线逐字节、登录页 == 基线逐字节、内联引擎 == ripple-bg.js 逐字节。⑤ 登录页回归：确认已无 `bg-ripple` 任何痕迹（文件大小回到 13618 B = 基线）。"
    scope_note: "生产文件动了两个：`console.html`（纯新增）与 `token-login.html`（还原到基线，即撤销 T23 的融合）；`src/*` 零改动。桥接无需重启（两个 HTML 都是请求时读盘）。**环境备注**：本轮想用 IAB 走真实 3100 登录→落场做端到端，但 IAB 里 `http://127.0.0.1:3100/?token=<正确令牌>` 一律返回 401（`curl` 同 URL 200、逐项二分请求头也复现不出），属这台机器上 IAB 的既有怪异行为，与本次改动无关（用户自己的录屏证明真实登录流程正常）；落场验证改用本机 4175 静态预览（同套 HTML + 注入 loginArrive 标记）完成。"

  - step: T26
    date: "2026-09-14"
    action: "[按用户录屏修断层 + 末端与主题图不符] 用户口径：「动画逻辑时不时出现断层，且动画末尾的图像与主题图像不符。后三张图片是对应主题的背景图，基于此进行调整使其动画与主题不会有画面冲突。做完后要充分检验检查输出结果，要多次，确认没有问题后再完成最后修改」（附 4 段录屏 + 三张 2560×1440 官方主题背景图）。定位方法：把四段录屏逐帧抽帧算「相邻帧平均通道差」曲线（不靠肉眼），第 4 段在 t=1.1s 出现 6.72 的孤立尖峰（前后只有 0.1–0.35）＝一次硬跳变，正是「落场动画末端 vs 主题底图」的接缝。根因三个：① **光斑层 inset 符号写反**：`.bg-decor::before` 的 `inset:-22%` 是向外扩张（盒子左上角在 `ins*W` 负坐标），复刻时写成 `-ins*view.w` → 整层被平移 0.44W/0.44H，导致我烘的目标背景**顶部区域**与真实主题画布不符（底部却几乎一致，所以早前在 1440×900 的小样本比对没暴露）；用用户给的官方主题图做基准逐格比对，顶部行差 9–24、底部只有 1–2，证据确凿。② **中途重烘**：ResizeObserver 只要视口尺寸变就重烘纹理，控制台加载后滚动条出现/消失会让宽度变 ~0.4%，正在播的涟漪背景被换成另一张纹理 → 观感就是「时不时断层」。③ **抖动噪声带时间项**：`hash21(gl_FragCoord.xy + uTime)` 每帧变化，落定后画面仍在极轻微闪烁（逐帧差尾部停在 0.15 不归零）。修法：① 改为 `ctx.drawImage(b, ins*view.w - pad, ins*view.h - pad)`，并把光斑层画布改为「扩张盒 + pad」、用 `translate(pad,pad)` 让光斑百分比定位以扩张盒为原点；② 纹理只在**宽高比变化 >2%** 时重烘（画布像素尺寸照旧跟随视口，纯缩放等比、无需重烘）；③ 抖动改用不含时间项的静态 `hash21(gl_FragCoord.xy)`（消色带效果不变，落定后彻底静止）；另顺手加固：MutationObserver 只在**主题真的变了**时才收尾（同值重写不算切换，避免被控制台自身启动时的同值写入误触）、落场纹理 longSide 640→1024 提高末端保真度。"
    result: "design-demos/bg-ripple/ripple-bg.js（光斑层定位修正 + 宽高比阈值重烘 + 静态抖动）、tools/fuse-console.mjs（主题同值防御 + longSide 1024）、public/console.html（重新生成，+28910 字符纯新增）、README.md / AGENT_CONTEXT.md"
    verification: "① **落定帧 vs 官方主题图**（用户给的 2560×1440，逐像素、与控制台同参数 longSide 1024）：平均通道差 苏打 **1.08** / 深海 **1.05** / 护眼 **0.96**，峰值 6/6/5，>2 的像素占比 5.9%/5.9%/2.2%（修复前为 6.13/2.70/3.43，顶部行差 9–24）。② **撤层无痕**（2560×1440，落定后「带画布」vs「撤画布」整幅比对，三主题各一轮）：平均差 **0.866 / 0.866 / 0.845**，>6 的像素占比 **0.01%**（仅一处 ~370 像素的 UI 元素在两次截图间变化），两边平均色完全相同（#e2e6fb / #e2e6fb / #eaeee5）。③ **本层逐帧平滑度**（确定性步进 100ms，读回画布）：差值呈平滑钟形 0.666→4.857（峰在 300–400ms）→**1500ms 时 0.002**，无尖峰；且 `setTime(1500)` 连续三次渲染结果完全一致 → **落定后画面彻底静止**（修复前尾部停在 0.15）。④ **真实落场时序**（2560×1440，dark/light 各一轮，rAF 帧间隔探针）：**p50 16.7 / p95 16.8 / max 16.8ms，>25ms 的长帧 0 个**，画布像素尺寸全程稳定在 2062（无中途重烘）。⑤ **三主题 × 多轮落场**：峰值 p 均为 1.0、画布撤除时刻 1504/1508/1506ms、`data-theme` 写入次数 **0**、控制台自身的 2s 清理照常执行。⑥ `check-fusion.mjs` 三条硬校验 PASS（控制台剥离标记块 == 基线逐字节、登录页 == 基线逐字节、内联引擎 == ripple-bg.js 逐字节）。"
    scope_note: "生产文件仍只有 `public/console.html`（标记块内纯新增）与 `public/token-login.html`（保持基线原样）；`src/*` 零改动。**录屏复检法**（抽帧 → 相邻帧差值曲线 → 找孤立尖峰）本轮证明比肉眼可靠，已记入 §5 可复用。**环境限制**：IAB 的 `tab.recording.start` 在这台机器上失败（`browser screenshot activity capture failed for guest`），所以最终端到端验证改用「页面内 rAF 帧间隔探针 + 确定性步进曲线 + 官方主题图逐像素基准」三重替代；IAB 对 3100 带令牌请求固定 401 的问题依旧存在（curl 同 URL 200），真实落场仍需用户在自己浏览器里确认。"

  - sop_id: "SOP-03"
    title: "动画/转场出现「断层」或末端与目标图不符（已闭环 · 抽帧复检法）"
    symptom: "用户报「动画时不时断层」「末端图像与目标图不符」，但截图看不出问题"
    root_cause: "本类问题多为**逐帧级**的接缝：纹理中途被换（重烘）、层被中途撤掉、末端帧与真实底图差几个色阶"
    steps:
      - "STEP-1 [复检] 用浏览器 <video> + canvas 逐帧抽帧（0.1~0.25s 步进，64×36 缩略），算相邻帧平均通道差曲线；**孤立尖峰**（远高于相邻帧）就是断层时刻，据此定位"
      - "STEP-2 [定位] 用 DOM 探针（MutationObserver + setInterval 采样 层是否存在/进度/类名）确认那一刻是「层被撤」「主题被重写」还是「纹理重烘」"
      - "STEP-3 [基准] 拿外部基准图（如设计给的 2560×1440 主题底图）与自绘层做**逐格差值网格**（8×4），把差异定位到具体区域（顶部/边缘/中部）——只看整体平均值会漏掉局部系统性错误"
      - "STEP-4 [修复] 视口尺寸变化只在**宽高比变化 >2%** 时重烘；同值写入不当作状态切换；末端帧必须与目标底图逐像素对齐后再撤层"
      - "STEP-5 [回归] 确定性步进（setTime 逐帧读回画布）确认曲线平滑且末端归零（完全静止）；再用 rAF 帧间隔探针确认真实播放无长帧"
      - "STEP-6 [排除页面级原因] 孤立尖峰也可能是**页面重排**而非动画：查该时刻的滚动条是否出现/消失（`.clientWidth` 变化 = 内容宽度变）、页面高度是否跨过一屏临界点。控制台这类「异步数据到齐改高度」的页面，建议常驻滚动条槽（本机实测 `scrollbar-gutter:stable` **无效**，要用 `overflow-y:scroll`；控制台自定义滚动条轨道已透明，常驻槽位视觉无变化）"
      - "STEP-7 [排除时钟被饿死] 用**逐点背景采样**（每 0.05s 取内容区几个分散点的颜色）判断是「波前扫过」（各点先后变）还是「瞬间切换」（各点同一帧变）。后者且稳定停在**起始色**，通常是动画时钟按帧累加、而页面首屏把主线程堵住 1–2s 导致 rAF 被饿死 → 动画"没被看见地"停在起点。修法：**动画时钟等第一帧真正到达才起算**；落定撤层改为**淡出**而不是硬切；这一层的显隐不要挂宿主会摘掉的类名"
      - "STEP-8 [必须看屏幕] 任何「背景层/画布层」问题，**只读画布内部像素（drawImage）或只看动画差值都会假阳性**：本仓库实测过「画布内部内容完全正确、屏幕上却只剩 CSS 兜底色」。做法：① 把宿主内容 `visibility:hidden` 做隔离观测，只看背景层；② 对截图取点并与**基准图**（设计给的主题底图）逐点比对；③ 再撤掉该层截图对照，确认屏幕颜色确实来自这一层而不是宿主或兜底色。"
      - "STEP-9 [查层叠与合成] 若隔离观测显示「屏幕上是兜底色/纯色」而内部像素正常：查该层的 `z-index` 与宿主的**根背景**。负 z 层若被宿主的 `body { background }` 盖住（Chromium 实测行为），内容等于没画 —— 修法是把底色从 `body` 挪到 `html`（`html{background:var(--bg)}` + `body{background:transparent}`），并给画布 `preserveDrawingBuffer: true`。`translateZ(0)`/`will-change` 无效。"
    acceptance:
      - "ACC-1 相邻帧差值曲线无孤立尖峰；末端差值归零"
      - "ACC-2 落定帧 vs 基准图 平均通道差 ≤2、峰值 ≤8（**必须取自屏幕截图**，不能取画布内部像素）"
      - "ACC-3 撤层前后整幅平均差 ≤1 且平均色一致（现为 300ms 淡出后撤层）"
      - "ACC-4 rAF 帧间隔 p95 ≤17ms 且 >25ms 长帧为 0"
      - "ACC-5 加载全过程中 `clientWidth`/关键元素左边距恒定（无滚动条导致的整页位移）"
      - "ACC-6 人为堵住主线程 1.5s 时，动画仍从起点平滑播完（不出现"先冻住、末尾突跳"）；普通刷新不产生该层"
      - "ACC-7 隔离观测（隐藏宿主内容）下，屏幕背景取点与基准主题图一致；撤层后明显不同 —— 证明屏幕颜色确实来自该层"
    status: "CLOSED（T26 光斑层符号 + 宽高比阈值重烘 + 静态抖动；T27 常驻滚动条槽；T28 首帧起算 + 淡出撤层；T29 修「负 z 层被 body 背景吞掉」+ 看屏幕的验收口径）"

  - step: T27
    date: "2026-09-14"
    action: "[再修一次断层：常驻滚动条槽] 用户口径：「依然有BUG，如视频，定位问题做出修改，多次检查」（附 2 段录屏 6.6s / 7.3s）。同样先用逐帧差值曲线复检：**落场动画本身已经平滑**（3.3→4.0s 差值 6.14→5.95→3.94→1.81 单调收敛，窗口内无孤立尖峰，说明 T26 的末端不符已修好），但两段视频在动画结束 1–2s 后各出现**一次孤立硬跳**（4.7s:7.29 / 5.0s:7.15，前后邻居都是 0.00–0.08）。抽取该时刻前后帧比对：整页**横向位移约 10px**（侧栏左边缘从 x=0 变到 x≈12）、滚动条消失，同时刻"运行模式 × Agent 预设绑定"里的下拉从「加载中…」变成「router-standard（当前配置）」——即**控制台自己的异步数据到齐后页面高度跨过「一屏」临界点，滚动条消失导致整页重排**；因为时间点紧跟在落场动画之后，最容易被当成动画的 bug。修法：在涟漪的标记 CSS 块里加 `html { overflow-y: scroll }` 常驻滚动条槽（控制台本来就自定义了 `::-webkit-scrollbar`——轨道透明、只滚时才画滑块，所以常驻槽位视觉无变化）。**先验证过 `scrollbar-gutter: stable` 在这台浏览器上无效**（隔离页面实测：短内容时 clientWidth 仍为满宽 1440，没有预留槽位），所以改用 `overflow-y: scroll`（实测三种内容高度下 clientWidth 恒为 1425）。"
    result: "design-demos/bg-ripple/tools/fuse-console.mjs（CSS 标记块新增 `html { overflow-y: scroll }` 并写明缘由）、public/console.html（重新生成，+29158 字符纯新增）、README.md / AGENT_CONTEXT.md"
    verification: "① **滚动状态稳定性**（修复后实测，1440 视口）：`overflow-y=scroll` / `auto+超高内容` / `auto+短内容` / 样式表状态 四种下 clientWidth 全为 1430、侧栏左边距全为 0、卡片左边距全为 268 —— 整页不再位移（修复前 scrollable↔non-scrollable 之间 clientWidth 差 10px 且 `.bg-decor` 宽度也跟着变）。② **三主题落场回归**：峰值 p 均为 1.0、画布撤除 1451/1476/1484ms、`data-theme` 写入 0、`clientWidth` 全程只有一个值（2550，无中途变化）、rAF 帧间隔 p50/p95/max = 16.7/16.8/16.9ms 且长帧 0 个、p 曲线 0→0.16→0.30→…→1.0 单调平滑。③ **撤层无痕复测**（2560×1440，三主题）：平均通道差 0.867/0.913/0.847，平均色一致，>6 像素占比 0.01%（仅一处 UI 元素在两次截图间变化）。④ **落定帧 vs 官方主题图**（终检）：平均差 苏打 1.045 / 深海 1.084 / 护眼 0.961，峰值 6/6/5。⑤ `check-fusion.mjs` 三条硬校验 PASS。"
    scope_note: "生产文件仍只有 `public/console.html`（标记块内纯新增；本轮新增的是一条全局 `html{overflow-y:scroll}`，已在注释里写明它是为了消除数据加载期的整页横移）、`public/token-login.html` 保持基线；`src/*` 零改动。至此本轮反馈里的三类观感问题（末端不符 / 中途重烘 / 加载期整页横移）均已闭环。"

  - step: T28
    date: "2026-09-14"
    action: "[再修：背景先冻住、末尾突跳 —— 动画时钟被主线程饿死] 用户口径：「问题还在，如视频。定位解决」（附 20.4s 录屏：控制台→退出登录→再登录→滚动→再退出/登录 的循环）。这次的定位手段升级为**逐点背景采样**：对视频每 0.05s 采样内容区三个分散点（左上/左中/左边缘）的 R 通道，发现背景在 6.30–6.60s 恒定是**基座纯色 243**（= 参考图 1 基座 ≈ #eef2fc），**6.65s 一步跳到 223**（= 当前主题画布）并此后恒定 —— 三个分散点**同一时刻**变化 ⇒ 不是涟漪波前扫过（那会是先后变），而是一次**瞬间切换**。根因：动画时钟用「每帧累加 `dt`（单帧上限 64ms）」推进，而**控制台首屏要建大量 DOM + 发多个请求，把主线程堵住 1.5–2s**，rAF 被一起饿死 → `elapsed` 只走到 33ms → 画布长时间停在 p≈0（基座色）→ 主线程空出来后动画才播（且已经比卡片浮升晚了一大截），观感就是「背景先冻住、末尾猛地跳一下」，与用户从 T26 起的两次反馈都吻合。**复现**：载入控制台落场后立刻用 `while(performance.now()-t0<1500){}` 堵住主线程 1.5s，实测 `elapsed=33ms / p=0.07`、画布仍停在基座色 ✓ 与视频逐条对上。修法（三处加固，目标是在任何情况下都不出现硬切）：① **动画时钟等「第一帧真正到达」才起算**（`startTs` 在首个 rAF 帧里赋值，而不是 `play()` 时刻）—— 页面再忙，动画也一定是从 p=0 平滑播完，不会被"看不见地走完"；② **这一层的显隐只由接线脚本的内联样式控制，不再挂 `html.login-arrive` 类**（控制台会在落场 2s 摘掉那个类，若显隐依赖它，正在播/已落定待撤的这一层会被那一刻瞬间隐藏 → 正是"咔一下"的来源）；③ **落定改为淡出再撤层**（canvas `transition: opacity .3s` + `fadeOut()`，340ms 后 `destroy()` 并移除）—— 即便两层还剩一点色差，也是 300ms 渐变而不是硬切；④ 撤销上一版临时加的"页面忙 >3s 就直接落定"兜底（它本身也是一次硬切）。"
    result: "design-demos/bg-ripple/ripple-bg.js（tick 改为首帧起算 + play 记录 playTs）、tools/fuse-console.mjs（CSS 去掉 login-arrive 显隐依赖、加 transition:opacity、init 加 fadeOut/drop 分离）、public/console.html（重新生成，+30421 字符纯新增）、README.md / AGENT_CONTEXT.md"
    verification: "① **阻塞场景复现→修复**：堵主线程 1.5s（`elapsed=33ms/p=0.07`，画布停在基座色）；修复后同样阻塞下动画从 p=0 起平滑播完、落定 1500ms 起淡出、1823ms 撤层，无突跳。② **普通刷新（无落场标记）**：`rippleBg` 不在 DOM、`__arriveRipple` 未创建、html 无落场类 —— 这一层完全不参与，控制台画布正常。③ **三主题落场**：峰值 p=1、淡出起点 1507/1522/1529ms、撤层 1823/1821/1846ms、帧间隔 p50/p95/max=16.7/16.8/16.9ms 且长帧 0、落场类由控制台自身 2s 清理照常。④ **落定帧 vs 官方主题图**（终检）：平均差 苏打 1.045 / 深海 1.084 / 护眼 0.961，峰值 6/6/5。⑤ **本层逐帧平滑度**（确定性步进）：平滑钟形 1.37→5.82→…→**1500ms 时 0.006**，无尖峰，且落定帧连续渲染结果完全一致。⑥ `check-fusion.mjs` 三条硬校验 PASS。"
    scope_note: "生产文件仍只有 `public/console.html`（标记块内纯新增）与 `public/token-login.html`（基线原样）；`src/*` 零改动。至此四类观感问题闭环：末端与主题图不符（T26 光斑层符号）、中途重烘（T26 宽高比阈值）、加载期整页横移（T27 常驻滚动条槽）、**动画时钟被主线程饿死导致先冻后跳（T28 首帧起算 + 淡出撤层）**。"

  - step: T29
    date: "2026-09-14"
    action: "[真凶：负 z 层被 body 背景吞掉 —— 这一层其实一直是不可见的] 用户口径：「动画只在下方显示，上方无动画出现断层」。定位手段这次升级为**隔离观测**：先把控制台内容 `visibility:hidden`，只留背景层，再看屏幕像素 —— 结果发现：**我这层停在 p=0.936 时，整屏几乎都是基座纯色 `#131a2e`**（正好等于画布的 CSS 兜底色 `var(--bg)`），而**撤掉我这层**反而露出了 `.bg-decor` 的完整深海渐变；同时用 `drawImage` 读画布**内部**像素，却是正确的目标背景。⇒ 结论：**画布的 WebGL 内容从来没有被合成到屏幕上**，用户看到的"背景"一直只是它的 CSS 兜底色 —— 所以「上方没有动画」「末端与主题图不符」「断层」全部得到解释（之前几轮我一直在读画布内部像素、或只看卡片动画引起的差值，所以每轮都"验证通过"）。**根因**：画布用 `z-index:-1`，而控制台把底色写在 `body` 上（`body { background: var(--bg) }`）—— Chromium 会把这个背景当作普通元素背景绘制，正好盖住负 z 层；逐项实测：`z-index:0` → 可见 ✓；`z-index:-1` → 不可见 ✗；`transform:translateZ(0)` / `will-change:transform` 都无效 ✗；`overflow-y:scroll`、画布兜底背景均无关。**修法**（符合规范且视觉完全一致）：把底色从 `body` 挪到 `html`（`html{background:var(--bg)}`）并让 `body{background:transparent}` —— 根元素背景直接作为画布背景绘制、不再盖住负 z 层，负 z 层随之正常参与合成。另外把 `preserveDrawingBuffer` 默认改为 true（页面重绘时画布内容更稳）。"
    result: "design-demos/bg-ripple/tools/fuse-console.mjs（CSS 标记块新增 html 底色 + body 透明）、design-demos/bg-ripple/ripple-bg.js（preserveDrawingBuffer 默认 true）、public/console.html（重新生成，+31853 字符纯新增）、AGENT_CONTEXT.md"
    verification: "① **屏幕级**落定帧背景取点 vs 官方主题图：深海 左 #1a1f42/上 #252749/右 #152033/下 #1b2d43（官方 #1a2145/#262a4c/#172338/#1b2641，差 1–7）、苏打 左 #dbdcff/上 #e2defd/下 #cee9f2（官方 #d9deff/#e3e1ff/#cedef6，差 1–7）—— **基座纯色 #131a2e 已从屏幕上消失**，说明这一层真的显示出来了。② **隔离观测复测**：p=0.94 时整屏可见我的深海画布（左上蓝光/右下青绿），撤层后露出宿主 `.bg-decor`。③ **真实播放 + 中途注入 30 次强制重绘**：p 单调 0.27→0.47→0.64→0.78→0.87→0.94→0.99→1（1358ms），全程无中断、无冻住。④ `check-fusion.mjs` 三条硬校验 PASS。"
    scope_note: "生产文件仍只有 `public/console.html`（标记块内纯新增）与 `public/token-login.html`（基线原样）；`src/*` 零改动。**方法论教训（已写入 SOP-03 STEP-8 / ACC-7）**：这类"背景层"必须**看屏幕**（截图取点并与基准图比对），不能只读画布内部像素或只看动画差值——本轮前四次「验证通过」都是读内部状态造成的假阳性。"

  - step: T14
    date: "2026-09-20"
    action: "[仓库卫生·审计] 清理不应纳入管理的代码：① 删除过期控制台组装链 design-demos/src/console/{part1,part2,part3}.html + assemble.mjs（与生产页分叉，实测运行会把生产页 292,512 字符覆盖成 219,207 字符、丢失约 25%）；② 删除根目录过期副本 test-dsh-v2-wait.mjs（无引用，已被 scripts/test-v2-wait.mjs 取代）；③ 删除一次性本机迁移记录 docs/MIGRATION.md；④ 清理硬编码本机信息（src/local-services.js 的 C:\Users\<用户名>\.dsh 候选改为由 %USERPROFILE% 推导、src/mcp-qq-file-send.js 的 F:\Administrator\Music 示例、README 与控制台占位符、测试提示符）；⑤ 脱敏 scripts/test-card.mjs 中真实 QQ 号与群昵称；⑥ 修复测试隐式依赖真实服务端口（改为注入 127.0.0.1:9，否则开发机跑着 SnowLuma/dsh 时必然失败）"
    result: "删除：design-demos/src/console/{part1,part2,part3}.html、assemble.mjs、test-dsh-v2-wait.mjs、docs/MIGRATION.md；修改：src/local-services.js、src/mcp-qq-file-send.js、scripts/test-card.mjs、scripts/test-local-services.mjs、README.md、public/console.html、console.baseline.html"
    risk_audit: "跟踪文件无真实凭据；无「已 gitignore 但仍被跟踪」的文件；鉴权为全局闸门（除登录页外所有 /api 需 consoleToken）。已评估并**保留**：assets/project-intro.mp4（11.2MB，占跟踪体积 76%）——README 第 17 行引用中，且从工作区删除不减 git 历史、反而破坏文档，瘦身需 Releases/LFS 或重编码；src/pinyin-data.js（365KB 生成物）——生成脚本需 npm pack 取源、运行时不依赖任何 npm 包，刻意入库。遗留建议：/api/terminal/* 等价本机 RCE（建议二次确认或独立令牌）；src/mcp-host-server.js 的 pid 建议参数化传递"

  - step: T15
    date: "2026-09-20"
    action: "[安全加固] ① **令牌分离**：新增 src/bridge-privilege.js（纯函数策略）——控制台令牌=全权，服务令牌=数据面白名单；桥接启动生成 state/agent-token；同一鉴权入口按令牌**取值**判定权限级别；服务令牌仅可访问 /api/status、/api/authorize/read、/api/images/message、/api/send/*、/api/socialV2/*（剔除 config/reset/activity/states/wake/tool-log，feedback 仅 POST，路径先 URL 归一化防 ../ 绕过）；服务令牌**不换发会话 Cookie**（否则等于把数据面凭据升级成控制面）；控制台重置令牌时同步轮换服务令牌。mcp-snowluma-safe.js / mcp-host-server.js 改读 state/agent-token（不再首选控制台令牌）。② mcp-host-server.js 的 OneBot 端口与 pid 改为经环境变量 WHALEBRIDGE_ONEBOT_PORT / WHALEBRIDGE_PID 传入 PowerShell，不再拼进命令文本，并加 -NonInteractive"
    result: "src/bridge-privilege.js（新增）、src/bridge.js、src/mcp-snowluma-safe.js、src/mcp-host-server.js、scripts/test-bridge-privilege.mjs（新增，npm run test-privilege）、package.json、RULES.md（新增「桥接访问令牌（双令牌分离）」小节）"
    verification: "纯逻辑 25 项全通过（含 ../ 与反斜杠绕过、相对路径拒绝、控制面接口逐条拒绝）；端到端校验以 /api/status 的 tokenModel==='dual' 为开关自动执行（服务令牌打 /api/terminal/open、服务启停、/api/socialV2/config 必须 403，且响应不种 Cookie），未重启时打印跳过而非误报"

  - step: T16
    date: "2026-09-20"
    action: "[改名] 项目 `qq-bridge`（qq_bridge）更名为「鲸桥 WhaleBridge」：package.json name → whalebridge；两套 agent preset `qq-chat`/`qq-chat-v2` → `whale-chat`/`whale-chat-v2`（目录 git mv）；控制台插件 `qq-mode-console` → `whale-mode-console`，settings 命名空间 `qq-mode` → `whale-mode`（src/bridge.js 读取处同步）；MCP 注释标记 `# === qq-bridge MCP ... ===` → `# === whalebridge MCP ... ===`；环境变量 QQ_BRIDGE_PID / QQ_BRIDGE_ONEBOT_PORT / QQ_BRIDGE_TEST_LIVE → WHALEBRIDGE_*。**刻意保留**与平台绑定的命名：`qq_*` MCP 工具 id、src/qq-card.js、mcp-qq-file-send、state/qq-activity.log、本地 localStorage.qqbd-theme-* 等，避免破坏工具协议与用户既有本地状态。"
    result: "package.json、package-lock.json、README.md、README.en.md、RULES.md、AGENT_CONTEXT.md、docs/{PROJECT_GUIDE,DSH_SETUP}.md、roles/小鲸鱼.md、config.example.json、src/{bridge,local-services,dsh-client,safe-fetch,slang-learner,mcp-host-server}.js、scripts/{setup-dsh,test-local-services,test-bridge-privilege,test-stickers}.mjs、public/{console,token-login,dsh-monitor}.html、启动桥接.vbs、重启桥接.vbs、design-demos/bg-ripple/tools/fixtures/{console,token-login}.baseline.html（控制台唯一事实源，改名后必须重跑 fuse）"
    verification: "① `check-fusion.mjs` 三条硬校验全 PASS（先改基线，再重跑 `fuse-console.mjs` 重新生成 public/console.html，未手改生产页）；② `npm run test-privilege` 31/31 通过；③ `scripts/test-local-services.mjs` 40 通过 / 3 失败，该 3 项（Windows 下 spawn .cmd/.bat）已在**未改动的 HEAD 工作树上复现同样 3 项**，与本次改名无关；④ node --check 全部改动 JS 通过，package.json / config*.json JSON 解析通过；⑤ 全仓 grep 已无旧名残留（仅 setup-dsh.mjs 的 LEGACY 迁移块刻意保留）。setup-dsh.mjs 新增旧安装物清理（删 ~/.dsh 下 qq-chat* preset、qq-mode-console 插件链接与 profile 依赖、迁移 settings.yaml 的 qq-mode 命名空间），并修掉 Windows 上 spawn('dsh.cmd') 的 EINVAL（补 shell:true）。"
    scope_note: "[本机已执行] node scripts/setup-dsh.mjs 已把 whale-chat / whale-chat-v2 preset 与 whale-mode-console 插件装入 ~/.dsh 并清掉旧物；**需重启 DSH 后新 preset/插件才生效**（DSH 设置页的模式值已随 settings.yaml 迁移保留）。仓库目录仍是 D:\GIT-QQ-BRIDGE：改目录名后须重跑 setup-dsh.mjs 同步 MCP/插件的绝对路径，config.json 内绝对路径也要改；docs/DSH_SETUP.md 的 clone URL 已改为 .../WhaleBridge.git，需同步重命名 GitHub 仓库。"

  - step: T17
    date: "2026-09-20"
    action: "[桌面化阶段 2·统一路径层] 新增 src/app-paths.js，将只读资源根与可写数据根分离：WHALEBRIDGE_DATA_DIR 管理 config/state/用户角色/日志/缓存，WHALEBRIDGE_RESOURCE_DIR 管理 public/assets/tools/内置角色；未设置时两者均回退仓库根目录，源码模式布局不变。主桥、mcp-snowluma-safe、mcp-host-server、mcp-qq-file-send、mcp-bilibili、self-test、tts-prosody 全部接入统一路径。角色读取为用户目录优先、内置目录兜底；新建角色只写数据目录。"
    result: "src/app-paths.js、scripts/test-app-paths.mjs、src/{bridge,mcp-snowluma-safe,mcp-host-server,mcp-qq-file-send,mcp-bilibili,self-test,tts-prosody}.js、package.json、desktop-shell/README.md、DESKTOP_APP_WORKPLAN.tmp.md；另修 scripts/test-vision-media.mjs 在 Node 24/Windows 下强制 process.exit 导致的退出期 libuv 断言。"
    verification: "test-app-paths 通过；src 25 个 JS 语法通过；test-privilege 31/31、test-local-services 43/43、test-card 134/134、test-stickers 40/40、test-forward 25/25、test-md 15/15、test-vision 7/7、test-wait 全通过；控制台融合检查三项 PASS。"
    scope_note: "默认环境下所有路径仍与改造前完全一致；只有显式设置 WHALEBRIDGE_DATA_DIR/WHALEBRIDGE_RESOURCE_DIR 才分离。未迁移或删除任何现有用户数据；旧 qq-* 升级兼容规则未改。"

  - step: T18
    date: "2026-09-20"
    action: "[桌面化阶段 3·统一 Core/MCP 入口] 新增 src/core-entry.js，统一分派 --worker、--mcp snowluma/snowluma-host/web-search-safe/qq-file-send/bilibili、--self-test；新增 src/entrypoint.js 统一判断直接执行与错误出口。bridge 和五个 MCP 的顶层自动启动改为显式 run 函数，import 不再占用 stdio；原脚本直接执行保持兼容。setup-dsh 的新生成配置改为五个 MCP 共用 core-entry.js + --mcp mode，当前 ~/.dsh 未主动改写。"
    result: "src/{core-entry,entrypoint}.js（新增）、src/{bridge,mcp-snowluma-safe,mcp-host-server,mcp-web-search-safe,mcp-qq-file-send,mcp-bilibili,self-test}.js、scripts/{setup-dsh,test-core-entry,test-card}.mjs、package.json、desktop-shell/README.md、DESKTOP_APP_WORKPLAN.tmp.md。"
    verification: "五个统一 MCP 模式真实子进程 initialize/listTools/callTool 全通过；五个旧独立入口 initialize/listTools 全通过；--worker 在隔离 dataRoot/资源根/服务发现环境/临时端口启动成功并生成 agent-token 与 lock，随后正常退出；卡片 134/134、权限 31/31、本地服务 43/43、路径隔离继续通过。"
    scope_note: "npm start 与原 src/bridge.js、各 MCP 文件、src/self-test.js 直接入口均保留；协议错误走 stderr，MCP stdout 保持纯 JSON-RPC。未重启当前桥接或 DSH，未改写用户现有 ~/.dsh。"

  - step: T19
    date: "2026-09-20"
    action: "[桌面化阶段 4·Bundle 与 SEA 独立可执行文件] 新增打包链：esbuild 把 src/core-sea.js 打成单文件 CJS bundle（platform=node、Node 内置模块与 ws 可选加速 bufferutil/utf-8-validate 保持 external），再用 Node SEA 生成不依赖系统 Node.js 的 dist/core/WhaleBridgeCore.exe，资源以 exe 同目录 resources\\ 形式外置（public/roles/assets/dsh/plugins）。为让 SEA 与源码共用一套分派，把原 src/core-entry.js 的解析/分派抽到 src/core-dispatch.js：core-entry.js 仅保留 isMainModule 守卫（源码直接运行），新增 src/core-sea.js 作为打包入口无条件调用 runCore()——**刻意让 CJS bundle 中 import.meta 为空**，否则 bridge.js 与五个 MCP 顶层的 isMainModule 守卫会在 SEA 中全部成立、一次启动 bridge 加五个 MCP。src/app-paths.js 增加打包分支：node:sea 经 process.getBuiltinModule 探测，resourceRoot 默认 exe 同目录 resources\\，dataRoot 默认 %LOCALAPPDATA%\\WhaleBridge（exe 同目录存在 portable.flag 时改用 exe 同目录 data\\），并新增 --data-dir 参数（优先于 WHALEBRIDGE_DATA_DIR）。desktop-shell 新增 src/core_launch.rs：开发模式用 node src/core-entry.js、发布模式优先 exe 同目录或 resources\\ 下的 WhaleBridgeCore.exe，可用 --core-mode/WHALEBRIDGE_CORE_MODE、--core-command/WHALEBRIDGE_CORE_EXE 覆盖，并新增 `--print-core-command` 诊断输出。"
    result: "scripts/{build-core,test-core-dist,test-app-paths}.mjs、src/{core-dispatch,core-sea}.js（新增）、src/{core-entry,app-paths}.js、desktop-shell/src/{core_launch.rs（新增）,main.rs}、package.json（新增 iconv-lite 直接依赖与 build:core/test-core-dist 脚本，esbuild 0.25.12 / postject 1.0.0-alpha.6 固定版本 devDependencies）、.gitignore（/dist/、*.blob、sea-config.json）、desktop-shell/README.md、DESKTOP_APP_WORKPLAN.tmp.md。"
    verification: "build:core 产出 91.7MB WhaleBridgeCore.exe（bundle 3143KB，打包 12 个第三方包，全部为纯 JS，无 .node、无未解析裸模块依赖）；test-core-dist 全通过：--help/无参数/非法参数退出码与输出通道、--self-test（DSH 不可达时非零退出）、五个 MCP 模式真实 stdio initialize/listTools/tools/call、worker 在显式资源目录/自动发现资源目录/默认 %LOCALAPPDATA%/--data-dir/portable.flag 五种路径下 401 鉴权与 200 放行、agent-token 与 bridge.lock 落盘、首次启动生成 console-token 并可鉴权、401 页面与控制台页面内容确实来自 resources\\、进程树无 node.exe 且 worker 镜像为发行 exe、测试后无 WhaleBridgeCore.exe 残留。test-app-paths 扩展覆盖打包分支（resources 自动发现、%LOCALAPPDATA%、portable.flag、--data-dir 优先级）通过；cargo test 16/16 通过（core_launch 12 项 + 原有 4 项）；test-core-entry、test-card 134/134、test-privilege 31/31、test-local-services 43/43、test-stickers 40/40、test-forward 25/25、test-wait、test-vision 7/7、test-md、控制台融合检查三项 PASS、src+scripts 55 个 JS/MJS 语法检查、git diff --check 全部通过。"
    scope_note: "全程使用临时端口、临时数据目录、临时 HOME/LOCALAPPDATA/ProgramFiles 与无 node.exe 的 PATH；未连接或重启用户正在运行的桥接/QQ/DSH/SnowLuma，未改写 ~/.dsh 与真实 config.json。test-core-dist 刻意不调用 /api/shutdown——该接口会杀机器上任何命令行含 start.bat 的 cmd.exe 守护循环，会误伤用户正在运行的桥接（已列为阶段 6 风险）。已知遗留：exe 未做图标/版本资源/签名与杀软白名单验证；test-slang 的既有文案断言差异与本阶段无关，未改动。"

  - step: T20
    date: "2026-09-20"
    action: "[桌面化阶段 5·DSH 集成安装与迁移] 把 setup-dsh 从一次性脚本改造成可重复、可回滚、可迁移的集成安装器：新增 src/dsh-integration.js（计划/执行分离，无 import 副作用），scripts/setup-dsh.mjs 变为薄 CLI，并新增统一入口模式 `WhaleBridgeCore.exe --setup-dsh [profile]`。MCP 配置的 command 统一用 process.execPath，靠 args 前缀区分模式——开发模式为 node.exe + <仓库>/src/core-entry.js + --mcp <mode>，发布模式为 WhaleBridgeCore.exe + --mcp <mode>（不带入口脚本），从而同时解决阶段 4 记录的「setup-dsh 用 process.execPath，在 SEA 下会变成 Core exe」风险。归属判定落在 <DSH_HOME>/.whalebridge-integration.json：只有由本应用安装且此后未被改动的 preset 才会自动升级，用户改过或来源不明的一律保留并提示 --force-presets；用户自建 preset、用户自己的 MCP 条目、非链接的插件目录只报告不删除。旧配置迁移覆盖 qq-* preset/插件链接/settings 命名空间/profile 旧依赖与旧 bundle，以及把指向 src/mcp-*.js 的旧 MCP command/args 就地改成统一入口（不补标记块，避免与既有条目重复注册 MCP server）。执行前对所有将被触碰的路径做快照，失败逆序回滚；回滚干净则连备份目录一并删除。插件在开发模式链接回仓库、发布模式按版本释放到 <dataRoot>/runtime/<version>/whale-mode-console 再链接；构建产物新增 resources/product.json 供打包运行时读取版本号。"
    result: "src/dsh-integration.js（新增）、src/core-dispatch.js（新增 --setup-dsh 模式）、scripts/{setup-dsh,test-dsh-integration,test-core-dist,test-core-entry,build-core}.mjs、package.json（新增 setup:dsh / test-dsh-integration 脚本）、DESKTOP_APP_WORKPLAN.tmp.md（阶段 5 记录 + ADR-008/009）。"
    verification: "test-dsh-integration 17 项全通过：新装（preset/插件/MCP 块/package.json/mode.json/manifest）、幂等（重复执行零 effect 且目录树逐字节不变）、旧路径迁移（用本机真实旧配置 node.exe + src/mcp-*.js，迁移后五条全变 core-entry.js + --mcp <mode>，用户条目/uiskin-theme/disabled/超时全保留，再跑一次仍空操作）、无标记旧配置（只就地修本项目条目，用户 my-own-server 原样保留且不补标记块）、升级（未改动的自有 preset 自动更新）、用户改动保护（keep-user-modified + --force-presets 才覆盖）、回滚（注入故障后目录树与执行前完全一致）、发布模式（command=Core exe、args 仅 --mcp <mode>、插件版本化释放与链接切换、重复执行幂等）、旧命名清理（qq-chat/qq-mode-console/qq-mode 命名空间/profile 旧依赖全清且用户 liangshen preset 未动）、生成配置真实 stdio initialize+listTools 五个模式全通过、CLI --dry-run 零写入与重复执行幂等；test-core-dist 新增打包模式 --setup-dsh 用例通过；test-app-paths、test-core-entry、test-card 134/134、test-privilege 31/31、test-local-services 43/43、test-stickers 40/40、test-forward 25/25、test-wait、test-vision 7/7、test-md、cargo test 16/16、57 个 JS/MJS 语法检查、git diff --check 全部通过。"
    scope_note: "全程只操作临时 DSH_HOME/临时数据目录；**未改写用户真实的 ~/.dsh**（真实 cordis.patch.yml 仍是旧布局，mtime 与内容未变），未重启用户的桥接/DSH/SnowLuma。对真实配置的只读预演显示唯一需要的改动是 MCP 块更新；执行 node scripts/setup-dsh.mjs 即可迁移，但必须重启 DSH 才生效，交由用户择时执行。真实 DSH 会话内的 qq_* 工具调用属阶段 8 端到端验收；卸载流程属阶段 7。"

  - step: T21
    date: "2026-09-20"
    action: "[桌面化阶段 6·桌面启动器正式接入] 桌面壳真正接管 Core 生命周期。Rust 侧新增 desktop_paths.rs（数据目录优先级 --data-dir > WHALEBRIDGE_DATA_DIR > portable.flag > %LOCALAPPDATA%\\WhaleBridge，与 app-paths.js 同源；config.json 端口解析含 BOM/缺字段/损坏/缺失四种情况）与 supervisor.rs（spawn worker、HTTP 健康探针、退出码决策、退避重启、优雅停止、状态机），main.rs 接入窗口/托盘/状态页与退出编排：先建状态页窗口、健康后 navigate 到控制台，托盘菜单为 显示主窗口/系统浏览器打开/重启桥接/打开日志目录/退出，关闭窗口隐藏到托盘，退出时丢弃 worker stdin 触发优雅停机。Node 侧新增托管模式：WHALEBRIDGE_SUPERVISED=1 时 /api/shutdown 跳过「杀掉机器上所有 start.bat 守护循环」的全局清理（阶段 4 记录的跨实例误伤风险），stdin EOF 作为父进程存活凭据实现孤儿守卫；/api/restart 退出码从 0 改为 10（start.bat 因 10≠2 仍会重启，兼容不变），退出码契约 0/2/10/其它 由 cargo test 与 npm run test-desktop-supervisor 双重锁定。构建脚本 build.rs 生成 32×32 占位图标供托盘显示（发布前替换）。"
    result: "desktop-shell/src/{desktop_paths.rs,supervisor.rs}（新增）、desktop-shell/src/main.rs、desktop-shell/{build.rs,Cargo.toml}（tauri 加 tray-icon feature、serde_json 直接依赖）、desktop-shell/ui/status.html（新增）、src/bridge.js（托管模式/退出码 10/孤儿守卫）、scripts/{test-desktop-supervisor,test-desktop-shell}.mjs（新增）、package.json（新增 test-desktop-supervisor / test-desktop-shell / desktop:build:debug 脚本）、DESKTOP_APP_WORKPLAN.tmp.md（阶段 6 记录 + ADR-009/010/012）。"
    verification: "test-desktop-shell 12 项全通过（临时数据目录 + 临时端口）：--print-core-command 开发/发布选路与 consolePort 解析；--smoke-test worker 拉起 ~520ms 健康、日志与锁文件就位；重启链路 POST /api/restart → exit 10 → 壳 791ms 内换 pid（断言 <5000ms 以区分立即重启与异常退避）且 bridge 日志出现「重启桥接（exit 10）」、spawn_count=2；端口冲突 exit 2 → 不重启、退出码 4；GUI 真实创建窗口（标题「鲸桥 WhaleBridge」）并于就绪后切到控制台；孤儿守卫在进程级验证（taskkill /F 只杀壳 → worker 因 stdin 关闭自行优雅退出并释放锁，worker 日志留痕）；无残留进程。test-desktop-supervisor 5 项通过：托管契约、非托管默认不变、源码层面确认全局 start.bat 清理只在非托管分支。cargo test 27/27。回归：test-core-entry、test-app-paths、test-dsh-integration、test-core-dist、test-card 134/134、test-privilege 31/31、test-local-services 43/43、test-stickers 40/40、test-forward 25/25、test-vision 7/7、test-wait、test-md、59 个 JS/MJS 语法检查、git diff --check 全部通过；release 构建（含 tray-icon + LTO）成功。"
    scope_note: "全程使用临时数据目录与临时端口，未触碰用户正在运行的桥接（start.bat 守护 pid 22056 / 桥接 pid 32680 测试前后一致、3100 与 3001 仍在监听），未重启 DSH/SnowLuma。GUI 用例会短暂弹出真实窗口用于验证托盘与 WebView2 初始化，验证后立即结束进程。未做：托盘菜单项点击、WebView2 交互细节（缩放/复制/外链/同源弹窗）、WebView2 Runtime 缺失引导安装（归阶段 7）、正式图标与签名（归阶段 7）。"

  - step: T23
    date: "2026-09-20"
    action: "[桌面化阶段 7·安装器/迁移器/卸载器] 新增 Rust 侧 installer.rs（安装/修复/卸载的计划与执行：effect 列表 + 快照回滚 + install-manifest.json 归属清单）、migrate.rs（旧数据发现、JSON 校验、备份式迁移、外部工具路径告警）、install_cli.rs（WhaleBridge.exe --install/--repair/--uninstall/--migrate，全部根目录可注入），并接入 main.rs。安装器即桌面壳自身的模式，不新增二进制；从安装目录内卸载时自动复制自身到 %TEMP% 并以 --wait-pid 重新执行，由副本完成卸载并自删。卸载默认保留用户数据，--remove-data 显式删除并二次警告；--remove-dsh-integration 走 Core 新增的 --uninstall-dsh（src/dsh-integration.js 的 planDshRemoval/runDshRemoval：只删 manifest 记录且未被改过的 preset/插件副本与 MCP 条目，用户改过或自建的一律保留）。build-core.mjs 增加第 6 步产物审计：禁止项（config.json/state/日志/.node/.dll/SnowLuma/令牌凭据）、bundle 与 exe 的构建机绝对路径、以及用本机真实 config.json 的 consoleToken/accessToken 做凭据泄漏对照。"
    result: "desktop-shell/src/{installer.rs,migrate.rs,install_cli.rs}（新增）、desktop-shell/src/main.rs、src/{dsh-integration,core-dispatch}.js、scripts/{build-core,test-desktop-install,test-dsh-integration}.mjs、package.json（新增 test-desktop-install / desktop:install 脚本）、DESKTOP_APP_WORKPLAN.tmp.md（阶段 7 记录 + ADR-011/012/013/014）。"
    verification: "test-desktop-install 全生命周期通过（全部在临时沙箱：安装目录/数据目录/开始菜单/桌面/HKCU 键均注入临时目录）：新装（--dry-run 零写入；程序文件/resources/数据目录/两处快捷方式/HKCU 卸载项/安装清单全部就位）、幂等、升级（识别已安装版本、更新程序与 resources、用户 config.json 原样保留）、修复（补回被删的 Core exe 并刷新清单哈希）、迁移（候选只报告、state/roles 迁移、config 不覆盖、畸形 JSON 跳过、外部路径告警、敏感值不打印、旧目录保留）、卸载（保留数据）、重装（配置与数据继续可用）、卸载助手（从安装目录内也能完整卸载且自删）、彻底卸载（--remove-data 清空数据与安装目录）、无残留（无进程/无注册表键/%TEMP% 无助手副本）。cargo test 37/37（含安装生命周期、用户改动保护、失败回滚、SHA-256 标准向量、删除链接不跟随目标、迁移计划、参数解析）。test-dsh-integration 新增卸载用例通过。产物审计用注入 public/debug.log 与 public/state/sessions.json 验证会按预期失败，清理后重建通过且确认本机真实 consoleToken 未进入 bundle/exe。回归：test-core-dist、test-desktop-supervisor、test-desktop-shell、test-core-entry、test-app-paths、test-card 134/134、test-privilege 31/31、test-local-services 43/43、test-stickers 40/40、test-forward 25/25、test-vision 7/7、test-wait、test-md 全通过。"
    scope_note: "全程沙箱化，未在本机真实安装（真实安装会写 Program Files/开始菜单/HKCU，需用户决策）；用户正在运行的桥接（守护 pid 22056 / 桥接 pid 32680）与真实 ~/.dsh 未被触碰；测试产生的 HKCU\\Software\\WhaleBridgeTest\\* 与 %TEMP% 助手副本已清理。未做：WhaleBridge-Setup-x64.exe（ADR-013 说明：App ID 与签名主体未定、图标仍是占位图，启用 NSIS 只需声明式改动）、正式图标与签名、升级时替换正在运行的自身（与常规安装器一样需先退出程序）。"

  - step: T24
    date: "2026-09-20"
    action: "[桌面化阶段 8·发布候选] 新增 scripts/build-release.mjs（组装 dist/app 发布候选：release 桌面壳 + payload=dist/core；生成 INSTALL.txt、licenses/THIRD-PARTY.md 与 licenses/README.md、SHA256SUMS.txt、CycloneDX 1.5 最小 SBOM、release-manifest.json；并对产物做发行审计）与 scripts/test-release-candidate.mjs（用发行包跑真实配置的安装与运行）。desktop:build 改为经 scripts/build-desktop.mjs 调用 cargo 并注入 --remap-path-prefix，减少产物里的本机路径痕迹。installer.rs 的注册表写入失败时改为带上 reg.exe 的原始错误（原来被丢弃，故障不可诊断）。"
    result: "scripts/{build-release,test-release-candidate,build-desktop}.mjs（新增）、desktop-shell/src/installer.rs、desktop-shell/build.rs（注明路径字面量偏差）、package.json（新增 build:release / test-release-candidate，desktop:build 改走包装脚本）、DESKTOP_APP_WORKPLAN.tmp.md（阶段 8 记录 + §11.1/§11.2 状态更新）"
    verification: "build:release 产出 dist/app（95.7MB，13 个组件）；发行审计通过（payload 与 Core exe 无禁止文件/无构建机路径/与本机真实 config.json 对照无凭据泄漏），并记录 1 项已知偏差：WhaleBridge.exe 内含构建机仓库路径字符串（Tauri/Cargo 以字符串字面量写入，remap 与 strip 均无效，已实测），影响仅限暴露构建机目录布局。test-release-candidate 全通过：中文+空格路径（「鲸桥 发布 候选 测试\\程序 安装 目录」）安装成功；桌面壳拉起的是 WhaleBridgeCore.exe 而非 node，后代进程无 node.exe，控制台 401/200 正常；运行前后安装目录逐字节不变（只读）；强杀 Core 后 5947ms 内按退避自动拉起并恢复控制台（断言 ≥4000ms 以区分退避与立即重启）；第二次启动静默退出且仍只有一个 Core worker（单实例）；强杀壳后 Core 自行退出无残留（孤儿守卫在发行配置下有效）；卸载保留用户数据、无残留进程。回归：test-desktop-install、test-desktop-shell、test-desktop-supervisor、test-core-dist 全通过；用户服务 3100/3001 仍在监听，无残留进程与注册表键。稳定性复跑时孤儿守卫曾失败一次，据此为 src/bridge.js 的托管模式加了第二道保险（除 stdin EOF 外每 5 秒检查父进程是否存在），随后连续 4 次运行全部通过；bridge.js 改动后 test-desktop-supervisor / test-core-entry / test-privilege 31/31 / test-card 134/134 复跑通过。"
    scope_note: "全部沙箱化：安装/数据/开始菜单/桌面/HKCU 键均指向临时目录，未在本机真实安装、未触碰真实 ~/.dsh 与正在运行的桥接/SnowLuma。本机账号为普通用户（非提升），因此安装验收一律指向沙箱目录；这也确认了运行期不需要管理员权限。阶段 8 中无法自动化的项目已逐条列出原因并写入 workplan §11.2 与 release-manifest.json 的 notVerified：真实安装到本机、Windows 10 x64、四种模式/全部 MCP 工具/媒体/卡片/审批（需真实 QQ+DSH）、DSH/SnowLuma 重启恢复、托盘菜单点击与 WebView2 交互、代码签名与正式图标（无证书）。阶段 8 退出条件「发布清单无阻断项且用户确认候选版」尚未达成：自动化侧无阻断项，等待用户完成上述人工验收。"

  - step: T25
    date: "2026-09-20"
    action: "[桌面化阶段 9·文档收口] 新建 docs/DESKTOP_APP.md 作为桌面版正式文档（架构总览与工艺图、路径契约表、进程与退出码契约、托管模式语义、Node SEA 打包方式与三条硬约束、构建与发布步骤、DSH 集成要点、安装/迁移/卸载命令表、故障排查对照表、测试矩阵、14 条决策记录（ADR）汇总表、当前状态与未验证项），并在 docs/PROJECT_GUIDE.md 与 README.md 顶部加文档入口。**未删除 DESKTOP_APP_WORKPLAN.tmp.md**：阶段 8 的 6 项人工验收未完成，而原始要求是「整个项目真正完成时才删除该文件」，ADR-005 也写的是「开发和验收完成后」；已在 workplan 阶段 9 记录审计结论、不删除的原因与用户完成验收后的删除步骤。"
    result: "docs/DESKTOP_APP.md（新增）、docs/PROJECT_GUIDE.md、README.md、DESKTOP_APP_WORKPLAN.tmp.md（阶段 9 状态与审计结论）"
    verification: "独有信息审计：14 条 ADR 全部进入 DESKTOP_APP.md §10；退出码契约（§3）、路径优先级（§2）、SEA 的 import.meta 陷阱（§4）、安装/迁移/卸载（§7）、故障排查（§8）、测试矩阵（§9）均已落地；逐阶段实现细节由 AGENT_CONTEXT 的 T17~T24 与 git 历史覆盖。剩余未转移内容仅为「进行中的跟踪信息」（§11.2 人工验收表、§14 待办顺序），删除前需先并入 DESKTOP_APP.md §11。临时文档保留（76680 字节）。"
    scope_note: "本阶段只新增/更新文档，未改动任何代码与产物，也未执行删除。桌面版的正式文档现已足以维护产品；临时工作文档的删除被显式推迟到用户完成 6 项人工验收之后。"

  - step: T26
    date: "2026-09-21"
    action: "[真机缺陷修复·release 构建暴露的 7 个问题 + 第三方链路未决项] 用户在实际安装并运行 release 构建后暴露出一批只在「release 壳 + 打包 Core」组合下才出现的问题，逐条修复：(1) 导航白名单只允许控制台 origin，把 Tauri 自定义协议的自家状态页判成外链——窗口里被拦、同时弹系统浏览器；新增 is_app_internal_url() 放行 tauri.localhost/tauri://，外链交浏览器时写壳日志 [external]。(2) 壳是 GUI 子系统、Core 是控制台子系统，spawn 未加 CREATE_NO_WINDOW 导致每次启动弹黑框；在 supervisor::hidden() 里统一加标志并覆盖 shell 侧全部子进程。(3) 安装器生成的占位 config.json 与迁移「默认不覆盖」冲突，真实配置被静默跳过；新增 is_shipped_placeholder()，并在「运行中 exe 同目录」也查找 config.example.json。(4) 迁移回滚备份目录由安装目录推导 → %ProgramFiles% 不可写；改到数据目录 .whalebridge-backup。(5) HTTP 探测在 SnowLuma 启动期偶发超时导致重复拉起实例；新增纯 TCP 探测复用现有实例，且**不**据此判定 ready（否则盖掉「OneBot 尚未就绪」提示）。(6) DSH 拉起的 5 个 MCP 子进程锁住安装目录 Core 使升级失败且报错误导；计划阶段先做占用检测并给出可操作指引，新增 --stop-core（只结束可执行路径位于本安装目录的进程）。(7) 退出路径把停止 Core 丢给独立线程，进程可能先退出 → 孤儿 Core 攒到 5 个；改为同步停止。"
    result: "desktop-shell/src/{main.rs,supervisor.rs,installer.rs,install_cli.rs,migrate.rs}、src/{bridge.js,local-services.js}、scripts/{test-desktop-shell,test-desktop-supervisor}.mjs、docs/DESKTOP_APP.md（新增 §12 真机缺陷表 + §12.1 QQ 注入链路）、DESKTOP_APP_WORKPLAN.tmp.md（阶段 8 补充记录）。"
    verification: "逐条实测：导航修复后壳日志 [external] 计数为 0；Core 直接子进程无 conhost；占位配置被真实配置替换且目标与源逐字节一致；迁移在可写目录建备份并成功；SnowLuma 复用日志正确且失败时仍提示 OneBot 未就绪；占用检测输出明确指引、--stop-core 后安装成功；强杀壳后孤儿 Core = 0。自动化：cargo test 43/43（新增导航白名单回归、占用检测、release conhost 检查）；test-local-services 43/43；test-desktop-supervisor 全部通过（含错误页按启动方式区分指引、外链留痕断言）。未重跑全套（budget）：test-desktop-shell 的 GUI 用例需先退出用户正在运行的应用（单实例互斥量），已改为显式跳过并打印原因。"
    scope_note: "真机操作均在有备份的前提下进行：迁移前手工备份了数据目录、安装/迁移的自动回滚快照在 <data>\\.whalebridge-backup。为完成安装曾两次停止用户实例并停过一次 DSH（DSH 的 5 个 MCP 子进程会锁住 Core exe，不停无法覆盖安装）——已如实告知用户，DSH 需由其重启。未决项：QQ 进程注入 —— 日志确认 QQ 由 explorer 启动，而注入要求由 SnowLuma 自己拉起 QQ，且注入是 OneBot API 上线的必要步骤；该项目无法从代码侧修复，操作顺序与排查方向已写入 docs/DESKTOP_APP.md §12.1。"

  - step: T27
    date: "2026-09-22"
    action: "[正式应用图标·C4 浅色简洁苏打] 用户在 A/B/C 候选与多轮简化后确定 C4：保留 C 的双向连接鲸鱼构图，采用浅紫薄荷底和蓝青双色的克制苏打风格。新增可复现的 Windows 图标生成脚本，以选定 PNG 为唯一源，清理圆角外透明杂点并生成 16/20/24/32/40/48/64/128/256 九层 ICO、Tauri 标准 PNG 和界面品牌图；build.rs 移除阶段 1 的 32px 程序化占位图，EXE/窗口/托盘统一使用正式 icon.ico；安装向导、启动状态页、控制台和令牌登录页同步替换原 SVG/Q 占位标志。IExpress 不提供自定义外壳图标参数，新增 Win32 资源写入脚本在封装后、签名前替换安装器的全部 RT_GROUP_ICON，使单文件安装器也使用同一 C4。"
    result: "desktop-shell/icons/{source-c4.png,icon.ico,icon.png,32x32.png,128x128.png,128x128@2x.png}、desktop-shell/{build.rs,tauri.conf.json,README.md}、desktop-shell/ui/{whalebridge-icon.png,installer.html,status.html}、public/{whalebridge-icon.png,console.html,token-login.html}、design-demos/bg-ripple/tools/fixtures/{console.baseline.html,token-login.baseline.html}、scripts/{build-app-icons.ps1,set-exe-icon.ps1,test-app-icon.mjs,package-installer.mjs,test-installer-package.mjs}、package.json、README.md、docs/DESKTOP_APP.md、DESKTOP_APP_WORKPLAN.tmp.md、dist/app。"
    verification: "npm run test-app-icon 通过：C4 源图一致、PNG 尺寸正确、ICO 9 层均为 32bpp PNG 编码、安装器资源链与四个界面引用正确；npm run test-installer-package 通过并由 Windows 成功提取蓝青 C4 图标；融合链三条硬校验全部 PASS；cargo test 44/44；debug/release 桌面壳与 release 单文件安装器均可提取 C4，两个发布 EXE 的提取图标 SHA-256 完全一致；build:release 发行审计通过；最终 test-release-candidate 全链路通过（中文空格路径、无系统 Node、只读安装目录、崩溃恢复、单实例、孤儿守卫、卸载），无临时目录或测试进程残留，本机 5 个已安装 MCP Core 未受影响。"
    scope_note: "没有覆盖或删除任何设计候选；C4 原图保留在 output/imagegen，desktop-shell/icons/source-c4.png 是正式构建源。正式图标已完成，仍待版本资源、Authenticode 签名与真实 GUI 小尺寸人工观感验收。"

  deprecated_experiments:
    - id: "DEP-01"
      name: "侧边栏滑动激活胶囊（nav-ind）"
      reason: "选中态切换存在毛玻璃断层割裂感；多轮变体均无法达标"
      final: "整体回退，激活态恢复按钮自身渐变 + 即时切换"
    - id: "DEP-02"
      name: "胶囊毛玻璃透镜（backdrop-filter 跟随滑动）"
      reason: "移动中的玻璃效果过于突出"
      final: "随 DEP-01 回退"
    - id: "DEP-03"
      name: "滑动期毛玻璃消失/减弱（.sliding / nav-moving）"
      reason: "治标不治本，仍割裂"
      final: "随 DEP-01 回退"
    - id: "DEP-04"
      name: "切换期顶栏毛玻璃消失再恢复（body.glass-off）"
      reason: "误报与维护成本高，方向错误"
      final: "移除"
    - id: "DEP-05"
      name: "主题切换全局渐变（html.theme-anim）"
      reason: "毛玻璃元素逐帧重合成模糊层，快速切换产生整页残影"
      final: "commit 24afa47 移除"
    - id: "DEP-06"
      name: "圆形会话头像"
      reason: "用户指定改大圆角方形（13px）"
      final: "方形化"

# ================================================================
# §3 已落地风格基准库 [MODULE=STYLE_BASELINE]
# ================================================================
style_baseline:
  selected_style.name: "海盐苏打 Soda Gummy（F4）"
  selected_style.formula: "软糖拟物质感基底 × 糖果玻璃全局叠加"
  selected_style.color_ratio: "苏打蓝 4 : 薰衣草 3 : 冰薄荷 3"
  selected_style.themes: ["苏打 light(默认)", "深海 dark", "护眼 warm"]

  soft_ui_mandatory:  # 软糖拟物核心特征 [强制] 全组件全主题生效
    - "双层分层光影：底部浮雕投影(--shadow-c1) + 反向柔光层(--shadow-c2)"
    - "边缘柔化高光：inset 顶部 1.5px 高光(--edge-hi) + 底部暗缘(--edge-lo)"
    - "圆角体系：卡片 --radius 26px / 控件 --radius-s 16px / 胶囊 999px / 头像 13px"
    - "可点击控件按压反馈：scale(.92~.97) + 弹簧曲线回弹 var(--spring)"
    - "输入框/分段槽/开关轨道内凹，开关旋钮浮起"

  candy_glass_mandatory:  # 糖果玻璃核心特征 [强制] 全局叠加
    - "全页马卡龙渐变画布：--candy-a/b/c 三段渐变(--candy-angle) + --blob-1/2/3 柔焦光斑"
    - "顶栏/侧栏/卡片半透毛玻璃：backdrop-filter blur(--glass-blur) saturate(1.4~1.5)"
    - "低饱和糖果配色全链路；accent 双色渐变(var(--accent)→var(--accent-2))"
    - "主题切换即时生效，无全局过渡动画"

  design_tokens.source: "design-demos/bg-ripple/tools/fixtures/console.baseline.html 顶部 :root[data-theme=light|dark|warm]（唯一 token 定义处）；生产页 public/console.html 由 fuse-console.mjs 在该基线上叠加 4 个涟漪标记块生成"
  design_tokens.core: { accent: "#5b7cfa", accent2: "#7cc7f2", radius: "26px/16px/999px", spring: "cubic-bezier(.3,1.6,.5,1)", glass_blur: "20px(light/dark)/18px(warm)" }

  forbidden:  # 禁用设计反例 [强制]
    - "禁止重新引入滑动胶囊指示器（nav-ind）及其任何变体（透镜/托盘/sliding/nav-moving/glass-off）——见 §5 SOP-01"
    - "禁止主题切换全局渐变（html.theme-anim）——见 §5 SOP-02"
    - "禁止原生 prompt()/alert()/confirm()——必须使用 toast()/confirmBox()/promptModal()/连点两次确认(data-arm)"
    - "禁止圆角 < 12px 的控件造型与高饱和纯色 accent（低饱和糖果双色渐变为准）"
    - "禁止 DOM 中出现三连以上 $ 前缀（$$$()/$$$$(）与单 $ 链式 forEach（历史转义事故）"

# ================================================================
# §4 资产归档合规规则 [MODULE=ARCHIVE_COMPLIANCE]
# ================================================================
archive_compliance:
  archive_path: "[强制] design-demos/archive/"
  gitignore_rule: "[强制] .gitignore 必须包含 '/design-demos/archive/'（已配置于仓库根 .gitignore）"
  git_policy: "[强制] 归档目录内容禁止提交 Git 仓库；git check-ignore 验证通过后方可提交其他文件"
  archived_assets: ["fusion-1-berry.html", "fusion-2-mint.html", "fusion-3-peach.html", "fusion-5-midnight.html", "ref-soft-ui.html", "ref-candy-glass.html", "index.html(选型页快照)", "css/*.css(对应皮肤)"]
  archive_note: "全部为自包含 HTML，双击可预览；selected 皮肤保留于 design-demos/src/css/"

# ================================================================
# §5 已知缺陷修复执行 SOP [MODULE=SOP]
# ================================================================
sop:
  - sop_id: "SOP-01"
    title: "侧边栏胶囊滑动毛玻璃断层割裂（已闭环 · 作为同类动画缺陷的处理范式）"
    symptom: "滑动胶囊指示器在选中态切换过程中，毛玻璃高亮存在断层割裂感；多轮变体（透镜跟随/滑动期消失/顶栏联动）均产生新的突出或残影问题"
    root_cause: "毛玻璃(backdrop-filter)元素参与位移动画时需逐帧重合成；叠加全局过渡(theme-anim)或独立高亮态切换时产生视觉断档"
    steps:
      - "STEP-1 [复现] 录屏定位断层帧，确认涉及元素是否含 backdrop-filter"
      - "STEP-2 [决策] 依据 §3.forbidden 第 1 条：此类问题禁止再引入滑动胶囊变体，采用回退/简化策略"
      - "STEP-3 [执行] 侧边栏动画整体回退至基线行为（激活态=按钮自身渐变 + 即时切换），删除 nav-ind 相关 CSS/JS"
      - "STEP-4 [回归] node design-demos/bg-ripple/tools/check-fusion.mjs 三条硬校验 PASS"
    acceptance:
      - "ACC-1 快速连续切换导航 10 次，录屏逐帧检查：无残影、无割裂、无文字不可读"
      - "ACC-2 三主题（苏打/深海/护眼）各自验证通过"
      - "ACC-3 check-fusion.mjs 三条硬校验 PASS（控制台剥离标记块 == 基线逐字节、登录页未改、内联引擎 == 源）且页面 0 报错"
    status: "CLOSED（最终方案已落地于当前基线）"
  - sop_id: "SOP-02"
    title: "主题切换模糊残影（已闭环）"
    symptom: "快速连续切换主题时整页模糊拖影、残影叠加"
    root_cause: "html.theme-anim 全局颜色过渡迫使 backdrop-filter 元素逐帧重合成"
    steps:
      - "STEP-1 移除 html.theme-anim CSS 块与 JS 类挂载/摘除"
      - "STEP-2 主题切换回归即时生效"
    acceptance: ["ACC-1 切换后 120ms 内截图完全清晰", "ACC-2 快速连续切换 10 次无残影叠加", "ACC-3 body transitionDuration 为 0s"]
    status: "CLOSED（commit 24afa47）"
  reuse_rule: "后续任何『动画期间毛玻璃/玻璃质感异常』类缺陷，直接引用 SOP-01 的 STEP-1~4 与 ACC-1~3，无需重新确认"

# ================================================================
# §6 后续任务生成参考锚点 [MODULE=ANCHORS]
# ================================================================
anchors:
  file_map:
    console_source: "design-demos/bg-ripple/tools/fixtures/console.baseline.html（控制台唯一事实源：全部样式 + 设计 token + 四模块 DOM + 全部交互/API 逻辑）"
    console_production: "public/console.html（由 fuse-console.mjs 生成，勿手改；改完基线必须重跑 fuse + check-fusion）"
    assembler: "design-demos/bg-ripple/tools/fuse-console.mjs（基线 + 4 个标记块 → public/console.html，幂等）"
    assembler_warning: "[已闭环·2026-09-20·T14] 旧组装链 design-demos/src/console/{part1,part2,part3}.html + assemble.mjs **已删除**：它与生产页长期分叉，直接运行会把生产页从 292,512 字符覆盖成 219,207 字符（丢失约 25%），实测会丢退出登录、内嵌终端、服务面板、卡片工具开关等。控制台改动一律走「改 console.baseline.html → fuse-console.mjs → check-fusion.mjs（三条硬校验必须 PASS）」，不要再引入第二套组装链。"
    mock_data: "design-demos/src/data.js（Demo 用 Mock）"
    preview_server: "design-demos/src/serve.mjs（Design Demo 选型页静态预览，端口 4173）"
    login_page: "public/token-login.html（无令牌入口页，随改动即时生效，无需重启桥接）——「柔光浮雕 Soft Emboss + 静水浮升转场」：入场动画 + 提交后卡片压入水面（640ms）+ 主题色自右下角 .morph 铺满再跳转，控制台侧读 sessionStorage.loginArrive 做卡片依次浮升（见 public/console.html 的 login-arrive 段）。**该页不含任何涟漪/渐变背景动画**（T25 已还原为基线，check-fusion 硬校验）"
    console_arrive: "public/console.html 的「落场涟漪」段（T25 融合，4 个 bg-ripple 标记块）：从登录页进来时播一次湖面涟漪，起始 = 主题底色 --bg、目标 = 当前主题的 .bg-decor 画布（THEME_MAP）；图层在 .bg-decor 之后、z-index:-1，默认 display:none，只有 html.login-arrive 才显示，落定 onDone 即撤层交还。改引擎后必须重跑 tools/fuse-console.mjs 同步内联副本"
    bg_ripple: "design-demos/bg-ripple/（湖面涟漪主题背景渐变引擎，非生产入口）：ripple-bg.js=引擎唯一事实源（四套背景配方 + 纯色配方 + 涟漪遮罩着色器 + 定版 PRESET + once/loop3 双模式 + THEME_MAP + setTime 确定性定位）；index.html=两模式 lab（①进入主页面可切主题 ②三组渐变循环，?t/?hud/?mode/?theme）；serve.mjs=本机服务 4175（静态根只暴露本目录 + /public/token-login.html、/public/console.html 白名单）；README.md=参数表/工具/降级/实测数据；tools/fuse-console.mjs=融合生成器（基线 + 4 标记块 → public/console.html，幂等）；tools/check-fusion.mjs=三条硬校验（控制台零改动 + 登录页无涟漪 + 引擎一致）；tools/fixtures/{console,token-login}.baseline.html=融合前基线（勿手改）。T24 已删除其它 4 版参数与其机制"
  commands:
    assemble: "node design-demos/bg-ripple/tools/fuse-console.mjs → node design-demos/bg-ripple/tools/check-fusion.mjs（改控制台基线后必须执行，三条硬校验必须 PASS）"
    preview_static: "node design-demos/src/serve.mjs → http://127.0.0.1:4173（Design Demo 选型页）"
    login_samples: "node design-demos/login-proposals/serve.mjs → http://127.0.0.1:4174/（登录页 10 方案样品 + 演示视频；单页可加 ?take=1 隐藏提示、?enter=300 延迟入场便于录屏）"
    bg_ripple_preview: "node design-demos/bg-ripple/serve.mjs → http://127.0.0.1:4175/（涟漪 lab：①进入主页面可切三主题验证联动 ②三组渐变循环；/view 已合并进 index.html，用 ?mode/?theme/?t/?hud 切）。同端口可直接开被融合的两个生产页面：http://127.0.0.1:4175/public/token-login.html、http://127.0.0.1:4175/public/console.html（控制台需要 /api，静态服务下只能看版面与落场背景）"
    bg_ripple_fuse: "node design-demos/bg-ripple/tools/fuse-console.mjs [--dry]（重新生成 public/console.html）→ node design-demos/bg-ripple/tools/check-fusion.mjs（三条硬校验必须 PASS：控制台剥离标记块 == 基线 逐字节、登录页 == 基线 逐字节、内联引擎 == ripple-bg.js 逐字节）"
    production: "http://127.0.0.1:3100/?token=<consoleToken>（token 见 state/console-token）"
  interaction_rules:
    - { id: "R-INT-001", rule: "危险操作=连点两次确认", src: "part3 bindArm()/data-arm 属性", note: "静态按钮用 data-arm；动态行内删除用 confirmBox()" }
    - { id: "R-INT-002", rule: "反馈=toast(msg,{type,undo})", src: "part3 toast()", note: "禁止 alert/prompt/confirm" }
    - { id: "R-INT-003", rule: "动态行内删除=confirmBox(text) 确认弹窗", src: "part3 confirmBox()" }
    - { id: "R-INT-004", rule: "行内编辑=promptModal(title,value)", src: "part3 promptModal()" }
    - { id: "R-INT-005", rule: "401=authOverlay 登录卡（含眼睛切换）", src: "part3 requestToken()/authEye" }
    - { id: "R-INT-006", rule: "轮询 3s 且 document.hidden 时暂停", src: "part3 末尾 setInterval" }
    - { id: "R-INT-007", rule: "主题持久化 localStorage.consoleTheme；Demo 用 qqbd-theme-*", src: "part3 setTheme" }
    - { id: "R-INT-008", rule: "空输出框自动隐藏(.auto-show)", src: "part3 syncAutoShow()" }
  motion_rules:
    - { id: "R-MOT-001", rule: "弹簧曲线 var(--spring)=cubic-bezier(.3,1.6,.5,1)，仅用于按压/浮起等小幅动效", src: "part1 :root" }
    - { id: "R-MOT-002", rule: "模块入场 moduleIn .34s cubic-bezier(.22,.9,.36,1)", src: "part1 .module" }
    - { id: "R-MOT-003", rule: "按压微缩 scale(.92~.97)+回弹", src: "part1 各控件 :active" }
    - { id: "R-MOT-004", rule: "会话头像圆角 13px（方形化，用户指定）", src: "part1 .ss-avatar" }
    - { id: "R-MOT-005", rule: "[禁用] 主题切换全局渐变、滑动胶囊——见 §3.forbidden 与 §5", src: "AGENT_CONTEXT §3" }
  ui_rules:
    - { id: "R-UI-001", rule: "设计 token 唯一定义处=part1 :root[data-theme=*]（23 项标准 token + candy/blob/edge/shadow 扩展）", src: "part1 顶部" }
    - { id: "R-UI-002", rule: "圆角体系 26/16/999/13px；网格 12 列（c-4/5/6/7/8/12）", src: "part1 .grid" }
    - { id: "R-UI-003", rule: "糖果画布=--candy-a/b/c 渐变 + --blob-1/2/3 光斑", src: "part1 .bg-decor" }
    - { id: "R-UI-004", rule: "玻璃=blur(--glass-blur)+saturate(1.4~1.5)；玻璃面=--panel/--panel-solid/--glass-weak", src: "part1 卡片/顶栏/侧栏规则" }
    - { id: "R-UI-005", rule: "accent 双色渐变=linear-gradient(140deg, var(--accent), var(--accent-2))", src: "part1 按钮/导航激活" }
    - { id: "R-UI-006", rule: "API 协议=x-console-token 头；鉴权弹窗=authOverlay；?token= 自动登录", src: "part3 api()/requestToken()" }
    - { id: "R-UI-007", rule: "四模块路由=data-module(models/agents/logs/settings)+hash 深链", src: "part3 go()" }

# ================================================================
# §7 当前待办状态 [MODULE=OPEN_ITEMS]
# ================================================================
open_items:
  rename_pending: "[改名落地·T16] 需重启一次 DSH，whale-chat / whale-chat-v2 preset 与 whale-mode-console 插件才生效；插件 settings 命名空间已由 qq-mode 改为 whale-mode，若设置页模式值异常需重选一次。桥接进程会在下次读取 config.json 后使用 whale-chat* preset。"
  uncommitted: "T23–T25 未提交（用户未要求提交）：design-demos/bg-ripple/（新增目录，待入库）、public/console.html（T25 落场涟漪，纯新增）、public/token-login.html（T23 融合后又在 T25 还原为基线，最终态 = 基线原样）、design-demos/index.html、AGENT_CONTEXT.md；另有更早的 console.html / token-login.html 主题联动改动（T20–T22）同样未提交。提交前先跑 node design-demos/bg-ripple/tools/check-fusion.mjs 确认三条 PASS"
  known_stable: "本次提交已含：QQ 官方机器人卡片查看工具（markdown+inline_keyboard 卡片 / json 图文卡 / ark 活动卡）、控制台「Agent 预设 → 工具开关」独立开关（socialV2.tools.getCardMsg，开/关即时生效）、卡片插图进图片管线（qq_get_message_images 可看图）、按需回源 get_msg 与启动历史回填"
  pending_ops: "[部署] 后端卡片支持需重启一次桥接生效；重启后执行 npm run test-card 完成正向端到端确认（脚本会先检查 /api/status.cardSegments 是否含 markdown，未重启则跳过而非误报失败）。[无需重启] 涟漪落场是纯前端静态产物，刷新页面即生效"
