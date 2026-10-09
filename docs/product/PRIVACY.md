# CetaMesh 隐私说明

CetaMesh Desktop 是**本地优先**的桌面应用：模型调用与数据默认发生在你自己的机器上。

## 我们收集什么

**默认不收集任何东西。** CetaMesh 没有内置遥测、没有自动崩溃上报、没有使用统计。不联网也能正常使用（除你主动发起的模型调用、联网搜索、检查更新）。

## 数据存在哪里

- 会话、任务、Memory、Workspace、设置、引导进度等：本机数据目录下的 `state/` 与业务目录。
- Model Provider API Key：本机 `state/provider-keys.json`（仅本机可读，界面只显示掩码）。
- 更新公告缓存：本机 `state/update-notes.json`（只存渲染后的纯文本公告）。

## 反馈（只有你主动提交时）

- 反馈**先写入本地队列**（`state/feedback/outbox.json`）；网络不可用或反馈服务未上线时不会丢失，也不会阻塞软件。
- 是否附加**诊断信息**由你显式勾选；不勾选就不附带。
- 诊断信息是白名单结构：产品名/版本、Build ID/Commit/构建时间、平台与架构、最近错误码（只有枚举码，没有错误消息）、Provider 是否已配置 Key（布尔值）、插件数量、少量安全设置项。
- 诊断信息**绝不包含**：API Key 与任何凭据、token/session/cookie/配对密钥、聊天内容（消息正文、prompt、回复）、Memory 内容、文件正文与路径、private key。
- 安全漏洞反馈（类型选「安全漏洞」）走**最小 metadata**：不自动附加任何诊断日志，并给出官方安全联系入口，见 [SECURITY.md](SECURITY.md)。

## 官方入口配置状态

官方网站、反馈服务地址、安全联系入口来自发行配置 `release-config.json`。未配置时界面显示「未配置」，CetaMesh 不会用其它地址替代。
