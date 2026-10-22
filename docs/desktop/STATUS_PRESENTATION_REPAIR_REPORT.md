# 插件操作状态与反馈排版修复

- 原因：历史审批操作逐项常驻；Renderer 额外 slice(-8) 会截掉较早的重要状态。反馈标题/说明共用行内布局，长 URL 查询参数直接显示。
- 修复：完成/取消/拒绝历史默认折叠，展开列表最高 280px；运行中、等待、失败及未知结果直接显示。移除 Renderer 截断，保留 Core 提供的记录。反馈标题与说明分行，域名简显，点击仍传完整 HTTPS URL；无 URL 禁用。
- 验证：6 个定向 npm suites PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT；build:ui PASS（既有 bundle 大小与 use client 提示）。SSR 回归覆盖 11 条混合状态及长 URL。浏览器真实组件合成数据验证默认折叠、展开 7 条、280px 高度上限。
- 证据：D:/GIT- CetaMesh/comm-evidence/status-presentation-implemented.png。
- 边界：未提交、打包或安装；未修改用户数据和审批权限；既有 RC1116 不包含本次修改。
