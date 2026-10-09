# CetaMesh 安全说明

## 报告安全漏洞

**请不要在公开 issue / 群聊 / 社交平台披露漏洞细节。**

官方安全通道（按优先级）：

1. `release-config.json` 中 `security.contact` 配置的地址（发行方指定的安全联系入口）；
2. 未配置 contact 时，使用 GitHub 私密漏洞报告：仓库 `security` 标签页 → *Report a vulnerability*（由 `repositories.github` 确定性推导，见 `src/product/release-config.js`）。

报告时请尽量包含：受影响版本（About 页的 Version / Build ID / Commit）、平台与架构、复现步骤、影响范围。**不要在报告里粘贴真实 API Key 或他人数据**；我们不需要它们也能定位问题。

## 安全漏洞类型的反馈

CetaMesh 的「反馈」入口支持类型 = 安全漏洞。选择该类型时：

- **不会自动附加日志或诊断信息**（只有产品名、版本、平台/架构这类最小 metadata）；
- 会同时展示官方安全联系入口，鼓励走上面的私密渠道；
- 该反馈仍会先落入本地队列，反馈服务不可用时不阻塞软件。

## 支持的版本

安全修复面向**当前发布通道（stable）的最新版本**。已停止支持的旧版本请先升级再验证。

## 我们的处理方式

1. 收到报告后确认复现；
2. 评估影响并在修复版本中解决；
3. 与你约定披露时间后再公开说明（默认在你同意后进行）。

## 范围

本地运行时（Core / 桌面壳 / 桥接）、设备配对（HTTPS + 一次性 token + 签名 transcript）、能力与审批边界（capability broker）、反馈与诊断的数据最小化。第三方模型服务商（如各 Provider 的 API）本身的问题请直接联系对应服务商。
