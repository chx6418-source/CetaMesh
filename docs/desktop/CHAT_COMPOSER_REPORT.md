# 输入区样式与交互验证

2026-10-22，分支 `codex/app-icon-refresh`。Owner 已确认输入区效果图后实施。

## 修改

- `HarborApp.tsx` 的生产 `ChatComposer`：保留数据接口和回调；附件入口改为“＋”，工作区/Agent 改为文字摘要和可关闭设置菜单，模型置于右下，发送/停止改圆形按钮。
- `harbor.css`：28px 圆角、浅边框/轻阴影、透明模型控件；移除内层矩形焦点阴影，以外层圆角边框显示焦点；窄窗口下底部操作换行。
- 输入区使用实际内容高度，64～160px，超过上限内部滚动；窗口宽度变化后重新测量。Enter 发送、Shift+Enter 换行；IME 组合期间不发送。
- 原任务卡片保留在输入区上方。原工作区预检、Agent 可用性、附件选择与文本发送接口保留；原生选择器的审批与安全边界未修改。
- 注册新增 `test-chat-composer-layout.mjs` 到统一测试入口。

## 新运行的验证

`npm test -- --suite test-chat-composer-layout --suite test-chat-context-card --suite test-desktop-ui-v2-production --suite test-desktop-chat-virtualization --suite test-window-chrome --suite test-error-hygiene`：6 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT。

`npm --prefix desktop-ui run build`：TypeScript 与 Vite 构建通过；保留现有 bundle 大小提示。

生产组件在独立浏览器 React 合成测试页中完成以下操作：

- 空输入发送禁用；展开菜单、切换到测试工作区 B，切换 Agent 后摘要更新。
- 通过测试 Host 桩取得 `example.txt`，附件显示并随发送回调传递，未打开真实个人文件。
- 点击发送，合成回调收到文本、附件数量及选择的工作区；按钮变为停止，操作控件禁用；停止回调后可再次发送。
- Enter 触发发送；Shift+Enter 保留换行且结果仍为“尚未发送”。
- 长文本高度达到160px，scrollHeight346px，overflowY为auto；发送后恢复初始高度。
- 浅色/深色渲染检查通过；输入焦点的内层outline/box-shadow均为none，外层仍有焦点边框。

截图：`D:\GIT- CetaMesh\comm-evidence\composer-final-light.png`。该截图来自生产组件与合成数据，不能作为真实 Core 或安装后验收证据。

本轮没有修改或覆盖真实用户数据，没有连接真实模型，也没有退出或升级用户应用；未提交、合并、推送或生成新安装包。既有Build1115安装包不包含本轮输入区修改。
