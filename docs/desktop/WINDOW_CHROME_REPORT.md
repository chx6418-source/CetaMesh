# 标题区简化验收记录

日期：2026-10-22。分支：`codex/app-icon-refresh`；基线：`bc6a923ec73b07c51ca2b4251245f6ad454142a7`。

## Owner 已确认的界面

- 标题栏只显示较大的 CetaMesh 文字，不显示旁边的品牌图标。
- 删除侧栏重复品牌区和全局搜索、连接状态、主题按钮、面包屑整行；主内容上移。
- 保留工作区选择器、导航、内容操作、Settings 主题选择，以及程序/任务栏/托盘的绿色图标。

实现采用 48 CSS px 标题区、23px 字号和现有深浅主题变量。仅移除全局搜索的 UI 与相关已无消费者的组件；Core 搜索协议未修改。

## Host 边界与交互

`app.windowAction` 仅通过现有可信来源和桥接白名单接收固定动作：状态、拖动、最小化、最大化切换、关闭和八方向缩放。拒绝未知动作、多余键、路径和进程参数。动作在 Host 事件线程操作当前窗口，不调用 Core 权限接口。

窗口使用应用标题区而非系统文字标题栏，仍设置真实窗口标题和绿色 window icon。移动超过4 CSS px 才开始原生拖动，避免按下立即进入原生捕获而干扰 DOM 双击。双击切换最大化/还原，边缘缩放调用 tao 的原生窗口操作。关闭投递 WM_CLOSE，继续既有 CloseRequested 的隐藏到托盘/退出确认/保存几何/正常关闭 Core 流程。

## 本次新运行的验证

| 验证 | 结果 |
| --- | --- |
| `npm --prefix desktop-ui run build` | PASS，TypeScript + Vite；存在已有 bundle 大小提示 |
| `npm test -- --suite test-window-chrome --suite test-error-hygiene --suite test-app-icon --suite test-desktop-ui-v2-production --suite test-desktop-architecture` | 5 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT |
| 设置 `WHALEBRIDGE_TEST_CARGO=1` 后运行 `npm test -- --suite cargo:test --verbose` | PASS，Rust 200 passed / 0 failed |
| `npm run desktop:build:debug` | PASS，完整 Windows Host 链接成功；已有 dead-code 警告 |
| 本地浏览器打开前端 dist | 已观察真实渲染：纯文字标题、无重复品牌/全局顶栏、侧栏从工作区选择器开始。无 Core 桥接，页面如实显示离线，未操作真实用户数据 |

新测试含真实 React 标题组件 SSR、实际 typed Host 请求/错误回复、拖动手势阈值与静止双击序列，以及 Rust 非法参数拒绝。独立审查指出“按下立即拖动”风险，已按移动阈值方案修正；随后独立定向复核通过，未发现新增的重要问题。该复核确认代码路径，不替代真实 WebView2 GUI 验收。

## 仍未验证与交付边界

真实 WebView2 窗口的拖动/缩放、双击、最小化/最大化、托盘和退出确认尚未做本轮 GUI 验收；浏览器布局、SSR、Rust 单测与可执行文件链接不能替代它们。Windows 11 原生 Snap Layout 的最大化按钮悬停面板没有实现，不能宣称与系统标题栏全部行为一致。

本轮没有退出或覆盖真实安装，没有操作真实 Task/Workspace/凭据数据，没有提交、合并或推送。保留已有图标修改。版本文件仍为上一阶段 Build1115；既有 Build1115 安装包不包含本次标题区，不能作为本次 UI 的安装交付物。后续打包应使用新 Build，避免覆盖已有产物。
