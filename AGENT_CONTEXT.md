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
    assembler: "design-demos/src/console/assemble.mjs（组装 + 三重断言，改源文件后必须执行）"
    mock_data: "design-demos/src/data.js（Demo 用 Mock）"
    preview_server: "design-demos/src/console/serve.mjs"
    login_page: "public/token-login.html（无令牌入口页，桥接重启后生效）"
  commands:
    assemble: "node design-demos/src/console/assemble.mjs（改 part1/2/3 后必须执行并确认 ✓）"
    preview_static: "node design-demos/src/console/serve.mjs → http://127.0.0.1:4173"
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
  uncommitted: "本文件（AGENT_CONTEXT.md）为新增，待用户确认后提交"
  known_stable: "main HEAD=043f1d4 已含：登录页美化 + 会话状态卡 + 全部布局/动效修复"
