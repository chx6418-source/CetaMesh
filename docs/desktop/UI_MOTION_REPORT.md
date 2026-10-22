# 全局活泼动效验收记录

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
