# 全局活泼动效验收记录

## 最新修正：动效一致性（2026-10-22）

Owner指出“操作状态”、插件搜索/页签和“＋”动效不协调。以下结果更新初版中关于独立标题/卡片入场、错峰和悬停位移的描述；本轮修改尚未提交、打包或安装，不在RC1116中。

### 复现与修正

使用真实SearchInput、Tabs和IconButton及生产CSS，在独立本地合成页面读取computed style：page-frame为cm-page-enter，page-heading为cm-heading-enter，卡片和操作状态Surface为cm-card-enter，但普通h2和plugins-controls没有动画。说明多层入场与缺失覆盖并存。输入区附件加号还有90度旋转，通用按钮含整体缩放/位移。

- 页面统一opacity入场，标题/工具栏/卡片共同淡入；不对页面祖先添加transform，避免破坏fixed抽屉的视口定位。
- 后加载的plugin-approval-inbox整区淡入，包含操作状态标题；移除内层卡片独立入场及错峰。
- 图标按钮保持本体不位移，图标悬停缩放1.12；附件加号不再旋转成“×”。普通按钮保留1px悬停反馈，导航/会话/选项不再横移。
- 搜索图标增加focus-within颜色过渡，保留原translateY(-50%)居中。
- 页签统一550字重，提供非选中项悬停和按下反馈；避免选择状态字重变化导致宽度跳动。
- 抽屉、菜单、展开、加载及系统减少动态效果规则保留。

### 新鲜验证

- test-ui-motion新增断言先在旧规则失败，再修复。7项统一npm test定向聚合PASS/0 FAIL/0 NRE：ui-motion、sidebar-layout、chat-context-card、chat-composer-layout、desktop-ui-v2-production、window-chrome、error-hygiene。
- npm run build:ui通过；原有大bundle警告仍存在。
- 浏览器修复后computed style：仅page-frame为cm-page-enter，标题/工具栏/普通卡片均不另起动画；操作状态只有外层cm-region-enter，内部标题和Surface不另起动画。
- 三个Tabs切换前后宽度均为76、59.625、61.45px，字重均550；无选择导致的宽度变化。
- 加号悬停：按钮transform=none，图标matrix(1.12,0,0,1.12,0,0)；搜索聚焦后图标颜色rgb(117,147,123)，居中矩阵仍为matrix(1,0,0,1,0,-8)。
- 复现入口在仓库外comm-evidence/motion-repair-preview.mjs，构建日志motion-repair-build.log。使用合成数据，不连接真实Core；未更改Windows设置，未声称已安装WebView2动态验收完成。

2026-10-22；分支 `codex/app-icon-refresh`。Owner 选择“更明显位移、缩放和轻弹性”后实施，保留此前所有图标、标题区、任务卡片、输入区和侧栏修改。

## 范围与实现

新增 `desktop-ui/src/theme/motion.css`，在正式 Harbor 样式之后加载。快交互140ms、常规210ms、面板300ms、页面320ms，使用统一 easing 和轻微过冲曲线。

| 区域 | 动效 |
| --- | --- |
| 页面与标题 | 页面淡入，标题向上进入；main仅以页面ID为key，实时消息更新不更换页面容器 |
| 内容卡片 | 短距离入场，前几张有30/60/90ms分段延迟；可交互卡片轻微悬停提升 |
| 按钮、导航、会话、标签页、链接 | 色彩/边框/阴影过渡，合适控件的悬停位移与按压缩放；触摸设备不套用鼠标悬停位移 |
| 菜单、选择器、工作区菜单、输入区设置 | 淡入、轻缩放；选择器箭头随展开旋转 |
| 抽屉 | 使用现有motion/react依赖的AnimatePresence进行进入/退出；useIsPresent使退出层立即inert，动画完成后卸载 |
| 原生dialog | 打开/关闭与遮罩过渡，仍使用showModal/close；支持相关离散CSS过渡的引擎呈现完整效果 |
| 任务卡片、工具明细、高级设置 | 现代引擎通过原生details-content高度/透明度过渡；保留原生键盘与open状态语义 |
| 进度、加载、运行状态、结果提示、附件 | 真进度宽度过渡，加载呼吸，轻量提示/附件入场，不制造虚假执行进度 |
| 深浅主题 | 主要表面的背景与文字色平滑过渡 |

不动画逐字流式正文，不对测量中的虚拟列表行缩放，不给虚拟历史内的卡片/错误提示重复入场。不使用全局transition:all或永久will-change。

## 验证

`npm test -- --suite test-ui-motion --suite test-chat-composer-layout --suite test-chat-context-card --suite test-desktop-ui-v2-production --suite test-desktop-chat-virtualization --suite test-error-hygiene --suite test-window-chrome`：7 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT。

`npm --prefix desktop-ui run build`：TypeScript/Vite通过。生产JS约716.7KB（gzip223.4KB），相比启用motion之前约584.7KB（gzip179.7KB）增加；现有bundle体积提示仍存在，本轮不做无关构建切分。

独立浏览器合成页使用生产组件完成：

- 抽屉打开后可交互；关闭过程中DOM仍存在且inert=true，变换非零；随后DOM完全移除。
- 原生dialog成功打开和关闭；最终过渡时长实际读取为0.21s/0.3s。
- 任务卡片原生展开后显示内容，details-content存在高度和透明度过渡。
- 模拟减少动态效果页复用生产CSS的reduce规则，并在测试页模拟matchMedia；读取加载animationName=none、按钮transitionDuration=0s，抽屉opacity=1/transform=none且仍可操作。该模拟没有改变真实Windows设置。

## 边界

旧WebView2若不支持interpolate-size、allow-discrete或details-content选择器，details高度和部分原生dialog退出效果回退即时切换；不阻塞操作。减少动态效果的通用规则与可选details-content伪元素分开，避免旧引擎因不认识该伪元素而丢弃整个通用降级规则。不声称所有菜单均有退出动画，条件卸载的普通菜单保留即时关闭。

真实Windows系统偏好切换、已安装Host/WebView2、多显示器和低性能设备体验尚未做本轮原生E2E。未连接真实Core/模型，未修改Task/Memory/权限或用户数据；未安装升级、提交、合并、推送或打包。旧Build1115安装包不包含本轮动效。
