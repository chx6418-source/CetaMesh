# CetaMesh Desktop 核心架构核查（2026-10-04）

本报告基于 D:\GIT-QQ-BRIDGE 当前工作树。历史交接和阶段性 README 只提供线索，完成状态以源码与测试为准。

| 范围 | 当前实现 | 状态 |
| --- | --- | --- |
| Shell、Core 启停与退出 | Rust native_main.rs / supervisor.rs 选择 Node 源码或 SEA，监管 worker 健康、退出码与重启，stdin 监控父进程 | 已有；本轮 Windows smoke 复验 |
| Shell ↔ Core IPC | Rust ipc_client.rs 与 Node ipc-protocol.js，v1 长度前缀 JSON、1 MiB 上限、握手、请求 ID、超时、结构化错误；事件只有 core.ready | 请求/响应已有；通用事件订阅尚未实现 |
| 原生 Chat/Agent | 本轮新增 native_ui.rs 对话页 + desktop-chat-service.js + 私有 chat.start/status/cancel；DSH follow 片段与最终消息回传 | 简单单会话闭环已验证；工具审批/多会话 UX 待接入 |
| Provider、模型和密钥 | 通过现有 DSH settings、模型目录与默认模型；Core 复用 dsh-auth.js 凭据，原生 UI 不读/显示密钥 | 配置已有；无独立桌面密钥库 |
| Memory | bridge.js socialV2 状态和 API，上一轮记忆插件复用既有授权读写 | 核心已有；桌面通用 Memory UI 尚无 |
| 平台连接边界 | SnowLuma/QQ 在 bridge.js，DSH 使用 dsh-client.js；本轮桌面对话只依赖 DSH，不经过 QQ | 部分完成；无多平台统一 adapter |
| Windows 构建 | Rust eframe/egui、Node SEA；无 Web UI 发行资源 | 本轮构建和隔离运行通过；未做真实模型 UI 人工交互 |

本地 git origin 指向 https://github.com/chx6418-source/whalebridge.git；未配置 https://github.com/chx6418-source/CetaMesh.git。远端读取报 schannel SEC_E_NO_CREDENTIALS，因此不能判定开源仓库当前分支、提交或代码内容。没有推送或上传。

本轮优先补齐桌面对话，是因为 Native UI 此前只有管理入口，用户无法从桌面直接发起并查看 Agent 回合。新增的 chat.* 保持私有 pipe、协议版本 1 和 Rust 后台工作线程；Core 不把长模型回合放在同步 IPC 中，而由 UI 短轮询状态。每轮最多 5 分钟，提示词最多 4000 字，结果最多 16000 字，历史最多 20 条，避免超过 IPC 1 MiB 帧。会话与有限记录保存在 state/desktop-chat.json，旧配置不变。

异常恢复：Core 重启后的未完成回合显示 interrupted，拒绝自动重发；用户在 DSH 恢复后执行“取消当前回合”，再继续输入。取消请求先显示 cancelling，待在途提示提交结束后才发送 session/cancel。取消成功后下一轮创建新 DSH 会话以隔离迟到事件；取消失败保持可重试状态。模糊提交失败或 5 分钟超时也标为 interrupted，阻止自动重发。当前没有为桌面会话接入 DSH $events 的工具审批和提问，所以复杂 Agent 任务可能停在等待交互，后续须处理。真实 DSH 模型会话与可视化点击测试尚未完成。
