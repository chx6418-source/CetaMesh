# AGENT_CONTEXT — QQ 桥接控制台前端 · 结构化上下文说明书
# 文档性质: 多智能体协作唯一事实源 (Single Source of Truth)
# 解析约定: 本文档全篇为缩进式 KEY: VALUE 结构（YAML 兼容）；`[强制]` 前缀条目违反即任务不合规；禁止凭空补充未列出的约束

meta:
  doc_version: "1.0"
  doc_date: "2026-09-12"
  doc_scope: "qq-bridge 前端控制台 UI（海盐苏打 Soda Gummy）"
  doc_maint_rule: "每次需求落地合并后，执行 Agent 必须增量更新本文件 §2/§3/§6 对应字段"
  read_order: "§1 → §6 → §3 → §5 → §2 → §4"

# ================================================================
# §1 项目基础元数据 [MODULE=METADATA]
# ================================================================
metadata:
  project.name: "QQ 桥接控制台（qq-bridge · DeepSeek Harness × SnowLuma）"
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
    action: "[后端+控制台] 新增「QQ 官方卡片查看」能力：新增 src/qq-card.js（json/ark/xml/lightapp/miniapp 卡片段提取 + 完整原始内容 + 结构化字段解析纯函数）；bridge.js 接入卡片缓存（按会话有界、单独落盘 state/social-v2-cards.json）、消息记录卡片摘要（hasCard/cardCount/cardKinds/cardHint）、GET /api/socialV2/card-message 端点、socialV2.tools.getCardMsg 开关与 toolMap 提示词；mcp-snowluma-safe.js 新增 qq_get_card_msg（**常驻注册 + 执行期读 config.json**，实现开关即时生效无需重启）；控制台「Agent 预设 → 工具开关」新增 qq_get_card_msg 独立开关；qq-chat-v2 preset 增加卡片工具协议条目与用途速查"
    result: "src/qq-card.js（新增）、src/bridge.js、src/mcp-snowluma-safe.js、public/console.html、design-demos/src/console/part2.html、dsh/agent-presets/qq-chat-v2/agent.cordis.yml、config.json、config.example.json、scripts/test-card.mjs（新增，65 项断言全通过）、README.md、RULES.md、docs/PROJECT_GUIDE.md"
    scope_note: "本条为后端工具能力 + 控制台单点开关新增（用户直接下达），未触碰 red_line.backend_zero_change 所保护的 API/令牌/会话行为；控制台仅按既有 v2-tool-item 模式新增一个复选框"
    discovered_issue: "public/console.html 与 design-demos/src/console/part1-3 **已漂移**：重跑 assemble.mjs 会丢失生产控制台的 500+ 行较新功能——见 §6.anchors.assembler_warning"
  - step: T13
    date: "2026-09-13"
    action: "[后端·根因修正] 用户反馈「工具无法查看 QQ 官方卡片内容」。抓取真实群消息（OneBot get_group_msg_history）后确认：QQ 官方机器人卡片**根本不是 json/ark 段**，而是 `markdown` + `inline_keyboard` 两个消息段（raw_message 形如 [CQ:markdown][CQ:inline_keyboard]）。T12 的实现只覆盖 json/ark/xml，因此这类卡片完全没被识别：AI 只看到 [markdown][inline_keyboard] 占位、卡片插图（markdown 里的 ![#宽 #高](https://qqbot.ugcimg.cn/…)）也没进图片管线。修正：src/qq-card.js 增加 `parseBotMarkdown`（去模板头 [](/%7B%22version%22…)/图片转占位并抽 URL/链接与 @提及还原）与 `parseInlineKeyboard`（按钮 label/type/data/style 结构化）、`buildBotMarkdownCard`（markdown+按钮合并为一张卡）、`extractCardMediaFromSegments`（插图进入媒体管线、过滤 ≤64px 装饰图标）；bridge.js 的 segmentsToText 渲染 markdown 正文与 [按钮:…]、extractMediaFromSegments 接入卡片插图；新增 `fetchRawMessageByRef`/`backfillMessageCache`（缓存未命中时用 get_msg 按需回源，归属校验与 resolveReplyInfo 一致）+ 启动后 `backfillRecentCardsV2`（回填历史卡片元数据）；/api/status 增加 cardSegments/cardToolEnabled 能力自描述"
    result: "src/qq-card.js、src/bridge.js、src/forward.js、dsh/agent-presets/qq-chat-v2/agent.cordis.yml、scripts/test-card.mjs（99 项断言，含真实抓包 payload 夹具 + 桥接正向端到端检查）、README.md、RULES.md、docs/PROJECT_GUIDE.md"
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

  design_tokens.source: "design-demos/src/console/part1.html 顶部 :root[data-theme=light|dark|warm]（唯一 token 定义处）"
  design_tokens.core: { accent: "#5b7cfa", accent2: "#7cc7f2", radius: "26px/16px/999px", spring: "cubic-bezier(.3,1.6,.5,1)", glass_blur: "20px(light/dark)/18px(warm)" }

  forbidden:  # 禁用设计反例 [强制]
    - "禁止重新引入滑动胶囊指示器（nav-ind）及其任何变体（透镜/托盘/sliding/nav-moving/glass-off）——见 §5 SOP-01"
    - "禁止主题切换全局渐变（html.theme-anim）——见 §5 SOP-02"
    - "禁止原生 prompt()/alert()/confirm()——必须使用 toast()/confirmBox()/promptModal()/连点两次确认(data-arm)"
    - "禁止圆角 < 12px 的控件造型与高饱和纯色 accent（低饱和糖果双色渐变为准）"
    - "禁止 DOM 中出现三连以上 $ 前缀（$$$()/$$$$(）与单 $ 链式 forEach（历史转义事故，assemble.mjs 已有守卫）"

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
      - "STEP-4 [回归] node design-demos/src/console/assemble.mjs 断言通过"
    acceptance:
      - "ACC-1 快速连续切换导航 10 次，录屏逐帧检查：无残影、无割裂、无文字不可读"
      - "ACC-2 三主题（苏打/深海/护眼）各自验证通过"
      - "ACC-3 assemble.mjs 三重断言（id 完整性/关键标记/语法）通过且页面 0 报错"
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
    console_css: "design-demos/src/console/part1.html（全部样式 + 设计 token）"
    console_html: "design-demos/src/console/part2.html（四模块 DOM + 弹窗）"
    console_js: "design-demos/src/console/part3.html（全部交互/API 逻辑）"
    assembler: "design-demos/src/console/assemble.mjs（组装 + 三重断言）"
    assembler_warning: "[重要·2026-09-13 实测] public/console.html **当前不是** part1-3 的可复现产物：生产控制台含大量未回移植到 part1-3 的较新功能（退出登录 nav-logout、内嵌终端、会话管理模块、user-select 规则、interpolate-size 等，约 500+ 行）。直接运行 assemble.mjs **会覆盖并丢失**这些功能（实测产物 226KB vs 生产 248KB）。修改控制台时：以 public/console.html 为生产事实源直接编辑，并把对应改动**同步**回 part1/2/3 作为参考源，**不要贸然重跑 assemble**；若要恢复组装链，需先做一次 part1-3 ← public/console.html 的全量回移植。"
    mock_data: "design-demos/src/data.js（Demo 用 Mock）"
    preview_server: "design-demos/src/console/serve.mjs"
    login_page: "public/token-login.html（无令牌入口页，随改动即时生效，无需重启桥接）——已落地「柔光浮雕 Soft Emboss + 静水浮升转场」：入场动画 + 提交后卡片压入水面/水位下沉（600ms）再跳转，控制台侧读 sessionStorage.loginArrive 做卡片依次浮升（见 public/console.html 的 login-arrive 段）"
  commands:
    assemble: "node design-demos/src/console/assemble.mjs（改 part1/2/3 后必须执行并确认 ✓）"
    preview_static: "node design-demos/src/console/serve.mjs → http://127.0.0.1:4173"
    login_samples: "node design-demos/login-proposals/serve.mjs → http://127.0.0.1:4174/（登录页 10 方案样品 + 演示视频；单页可加 ?take=1 隐藏提示、?enter=300 延迟入场便于录屏）"
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
  uncommitted: "无"
  known_stable: "本次提交已含：QQ 官方机器人卡片查看工具（markdown+inline_keyboard 卡片 / json 图文卡 / ark 活动卡）、控制台「Agent 预设 → 工具开关」独立开关（socialV2.tools.getCardMsg，开/关即时生效）、卡片插图进图片管线（qq_get_message_images 可看图）、按需回源 get_msg 与启动历史回填"
  pending_ops: "[部署] 后端卡片支持需重启一次桥接生效；重启后执行 npm run test-card 完成正向端到端确认（脚本会先检查 /api/status.cardSegments 是否含 markdown，未重启则跳过而非误报失败）"
