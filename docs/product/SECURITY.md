# CetaMesh 安全说明

## 报告安全漏洞

**请不要在公开 issue / 群聊 / 社交平台披露漏洞细节。**

官方安全通道（按优先级）：

1. `release-config.json` 中 `security.contact` 配置的地址（发行方指定的安全联系入口）；
2. 未配置 contact 时，使用 GitHub 私密漏洞报告：仓库 `security` 标签页 → *Report a vulnerability*（由 `repositories.github` 确定性推导，见 `src/product/release-config.js`）。

报告时请尽量包含：受影响版本（About 页的 Version / Build ID / Commit）、平台与架构、复现步骤、影响范围。**不要在报告里粘贴真实 API Key 或他人数据**；我们不需要它们也能定位问题。

## 安全漏洞入口（软件内只有入口）

CetaMesh Desktop 不在软件内收集或上传漏洞报告。「反馈」页的**安全漏洞**入口单独显示提示：

> 安全问题请通过官方安全反馈页面提交，不要在公开 Issue 中披露敏感漏洞。

点击后用系统默认浏览器打开官方网站的 `/security` 页面（站点根与路径来自发行配置 `release-config.json`）。
该链接只附带 `version` / `build` / `platform` 三个非敏感字段，**不带**日志、诊断信息、聊天内容、
文件路径、插件配置或任何凭据；软件也不会自动上传日志。

浏览器打不开时会提示「无法打开浏览器，请稍后访问 CetaMesh 官方网站。」，不影响软件其它功能；
若官方页面尚未配置，则如实提示「官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。」。

## 支持的版本

安全修复面向**当前发布通道（stable）的最新版本**。已停止支持的旧版本请先升级再验证。

## 我们的处理方式

1. 收到报告后确认复现；
2. 评估影响并在修复版本中解决；
3. 与你约定披露时间后再公开说明（默认在你同意后进行）。

## 范围

本地运行时（Core / 桌面壳 / 桥接）、设备配对（HTTPS + 一次性 token + 签名 transcript）、能力与审批边界（capability broker）、反馈入口与诊断信息的数据最小化（软件内不收集反馈、不自动上传日志）。第三方模型服务商（如各 Provider 的 API）本身的问题请直接联系对应服务商。
