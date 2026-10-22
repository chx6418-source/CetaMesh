# CetaMesh Desktop 1.0.0-rc.2 · Build1116

本地候选安装包，包含2026-10-22 Owner已确认的桌面界面调整；不是Stable发布，不自动上传或覆盖用户安装。

## 本轮更新

- 使用Owner提供的绿色CetaMesh图标，覆盖程序、任务栏、托盘与安装器。
- 标题栏改为放大的纯文字CetaMesh，统一主题配色，删除侧栏重复品牌及原全局顶栏。
- 聊天任务上下文改为输入框上方的折叠卡片，聊天恢复完整宽度。
- 简化输入区：大圆角、附件“＋”、工作区/Agent文字菜单、模型选择和圆形发送/停止按钮。
- 输入内容自动增高，保留Enter发送、Shift+Enter换行与IME组合输入保护。
- Settings、关于和本地用户固定在侧栏底部，上方区域独立滚动。
- 增加统一的活泼动效，覆盖页面、卡片、按钮、菜单、抽屉、弹窗、展开项、加载与结果反馈；支持减少动态效果。

## 验收边界

本轮界面交互已使用生产组件和合成数据进行浏览器验证。真实安装后的WebView2标题区拖动/双击/缩放、多显示器、真实Windows减少动态效果切换和真实外部Agent链路仍需独立验收。

Staging不等于操作系统沙箱，外部Agent仍使用已选择的原生安全策略；平台Capability Broker、Owner审批和工作区授权未在本轮放宽。

旧WebView2不支持的details高度动画与部分原生dialog退出效果会回退即时切换。Windows原生Snap Layout的最大化按钮悬停面板尚未实现。

RC构建的实际源码提交、clean状态、产物大小与哈希以该Build的build-info.json、release-manifest.json及SHA256SUMS.txt为准；测试结果以本轮RC构建验收记录为准。整体发布状态继续保持RELEASE_BLOCKED，签名及其他发布门禁完成后再另行决定Stable发布。
