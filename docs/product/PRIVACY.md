# CetaMesh 隐私说明

CetaMesh Desktop 是**本地优先**的桌面应用：模型调用与数据默认发生在你自己的机器上。

## 我们收集什么

**默认不收集任何东西。** CetaMesh 没有内置遥测、没有自动崩溃上报、没有使用统计，也**不会自动上传日志**。
不联网也能正常使用（除你主动发起的模型调用、联网搜索、检查更新）。

## 数据存在哪里

- 会话、任务、Memory、Workspace、设置、引导进度等：本机数据目录下的 `state/` 与业务目录。
- Model Provider API Key：本机 `state/provider-keys.json`（仅本机可读，界面只显示掩码）。
- 更新公告缓存：本机 `state/update-notes.json`（只存渲染后的纯文本公告）。
- 诊断信息：只在本机「About」页展示，**不写入任何上传队列**。

## 反馈：软件只提供入口，不在软件内收集

CetaMesh Desktop **没有**应用内反馈表单、没有 Bug 提交、没有漏洞上传，也没有本地待发队列。
「反馈」页只有四个入口，点击后用**系统默认浏览器**打开官方网站的对应页面：

| 入口 | 打开的官方页面 |
| --- | --- |
| 反馈与建议 | `/feedback` |
| Bug 反馈 | `/feedback?type=bug` |
| 功能建议 | `/feedback?type=feature` |
| 安全漏洞 | `/security`（请勿在公开 Issue 中披露敏感漏洞） |

链接只会附带三个非敏感字段（例如 `?version=1.0.0&build=1052&platform=windows`）：

- `version`：产品版本；
- `build`：Build ID；
- `platform`：平台（windows / macos / linux）。

**绝不会**附带：API Key 或任何凭据、token / session / cookie / 配对密钥、聊天内容、Memory 内容、
用户文件路径、插件配置、设备密钥（device secret）、日志正文。白名单写死在代码里，发行配置也无法扩大它。

是否在官网页面上提交、提交什么内容，由你在浏览器里自行决定 —— 那一步与 CetaMesh 客户端无关。

## 官方入口配置状态

官方网站、反馈与安全页面路径来自发行配置 `release-config.json`。未配置时界面如实提示
「官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。」，CetaMesh 不会用其它地址替代；浏览器打不开时
提示「无法打开浏览器，请稍后访问 CetaMesh 官方网站。」，不影响软件其它功能。
