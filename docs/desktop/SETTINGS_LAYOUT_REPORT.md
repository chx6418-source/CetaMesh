# 设置竖向分类与紧凑标题栏

2026-10-22，Owner确认效果图后实施。工作树`D:\GIT- CetaMesh\comm-repair`，功能分支`codex/app-icon-refresh`，沿用此前未提交界面修改。

## 改动

- SettingsLayout将全部11项设置分类改为带图标的竖向导航，右侧显示原有设置内容；选中项使用aria-current，按钮支持Tab及Enter/Space。类别保留常规、模型、Agent、插件与MCP、记忆、工作区、设备、外观、隐私与安全、更新、高级。
- 标题改为“设置”，字段按组放入圆角卡片，保存按钮统一“保存设置”并提供保存中反馈；原Core schema、locked字段、敏感字段过滤、draft/changes/revision、恢复阻断和保存后的Host退出行为同步保持原逻辑。
- 进入Settings只显示最左图标栏，隐藏工作区列表及无效展开按钮；不修改全局折叠偏好，离开设置后沿用此前状态。
- 删除整条Harbor/本地Core/WebView2底栏及31px网格占位，主区延伸到底部。
- 标题栏高度40px，品牌字20px，左边距16px，窗口按钮宽44px；仍使用既有拖动/最大化/关闭/边缘缩放动作，不改Host协议及权限。
- 720px以下分类仍保持竖向，以较窄列适配；本轮未完成独立窄屏原生验收。

## 验证

- 新增test-settings-layout并登记统一npm test聚合，先验证缺少布局模块而失败；更新窗口尺寸预期后确认旧48px样式失败，再实现。
- `npm test -- --suite test-settings-layout --suite test-window-chrome --suite test-sidebar-layout --suite test-ui-motion --suite test-desktop-ui-v2-production --suite test-chat-composer-layout --suite test-chat-context-card --suite test-error-hygiene`：8 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT。
- `npm run build:ui`：TypeScript/Vite通过；既有bundle体积警告仍存在。
- 浏览器真实生产SettingsPage、SettingsLayout、WorkspaceSidebar、WindowChrome配合模拟settingsClient/hostClient验收；没有连接真实Core，没有保存真实用户数据。
- 11项分类x均88px、y从68px起每45px递增；标题栏实测40px，主区底部720px等于720px视口；footer数量0、workspace-panel数量0。
- 模拟常规开关false→true，点击保存调用模拟客户端并显示成功；外观分类切换及浅/深主题通过。这不等于真实IPC持久化验收。
- 截图和本地临时验收入口存于仓库外`D:\GIT- CetaMesh\comm-evidence`，构建日志settings-layout-build.log。临时服务结束后停止。

## 交付边界

源文件主要为HarborApp.tsx、SettingsLayout.tsx、settings-layout.css、harbor.css及WorkspaceSidebar.tsx；回归为test-settings-layout、test-window-chrome、test-sidebar-layout及聚合登记。

未提交、打包、合并、推送或安装。已有RC1116文件及校验值未修改；真实Windows/WebView2拖动/缩放、窄屏与其他发布门禁仍需验收。RELEASE_BLOCKED保持不变。
