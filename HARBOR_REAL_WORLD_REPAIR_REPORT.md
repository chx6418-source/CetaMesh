# Harbor Real-World UX & Runtime Repair Report

日期：2026-10-13

实现提交：`8de0c4ebc475fe9e8b4657ce1137f7b602266634`

基线：`be3bb42490d6b46314c5f0296bd00e9986f42263`
分支：`codex/harbor-real-world-ux`

## 已交付

- 修复 Harbor 聊天发送体验：发送后立即显示本地用户消息，接入流式增量更新和消息回执对账，并补齐工具活动与 Agent 活动状态；刷新会话时回传最近工具活动。
- 接入实时 Agent 健康状态；界面区分 `available` 与 `eligible`，对工作区边界未验证的 DSH Agent 显示配置不完整并阻止不安全调用。Agent 活动卡记录所选 Agent 的运行、结束、失败和停止状态。
- 接通 Desktop Integration Registry 与现有本地服务管理器，提供 SnowLuma 配置和动作入口；向 UI 投影脱敏后的服务状态，令牌只暴露是否已配置。MCP 内置服务状态按内置启动路径呈现。
- 补齐本地插件包导入入口和集成动作的 WebView IPC allowlist，保持已有 Capability Broker 执行边界。
- 收敛 Harbor Settings、Context Panel、Recent Sessions 与输入控件体验；完善选择状态和减少动态效果偏好。
- 修复安装器完成态仍持有运行接收端、导致完成页无法正常退出的问题，并增加 Rust 回归测试。修复桌面测试子进程继承输出管道导致测试已通过但进程不退出的问题。
- Build Number 从 1058 提升至 1059。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run version:validate` | PASS，`1.0.0-rc.2` / Build 1059 |
| `npm run desktop:build` | PASS，Release Desktop 壳构建完成 |
| `WHALEBRIDGE_TEST_CARGO=1 npm test` | PASS 95 · FAIL 0 · `NOT_RUN_ENVIRONMENT` 4（共 99 suites） |
| Cargo check / tests（由统一测试入口执行） | PASS |
| RC 安装与运行测试（由统一测试入口执行） | PASS |
| `SHA256SUMS.txt` 全量校验 | PASS |
| RC 发行审计（禁止项、构建机路径、凭据） | PASS |
| 最终代码审查 | PASS，无剩余 Critical / Important 项 |

## RC 产物

- 目录：`artifacts/rc/1.0.0-rc.2/build-1059`
- 安装器：`CetaMesh-Setup-1.0.0-rc.2-build1059-x64.exe`（41.1 MB）
- RC 目录：143.1 MB
- `sourceCommit`：`8de0c4ebc475fe9e8b4657ce1137f7b602266634`
- `dirty`：`false`
- 安装器 SHA-256：`49cbbe92d48acc82b4b19a9db4a0e8ccf358d4db851726149459895fdf8d813f`

旧的 Build 1059 产物（来源提交 `2238bca`）已保留为 `build-1059-initial-2238bca`，新 RC 未覆盖旧文件。

## 未完成的环境验收

- 全量测试中的 4 项为 `NOT_RUN_ENVIRONMENT`：旧桥接、MCP gateway、联网搜索和 OneBot gateway 未在本机提供。
- 未进行可交互的 Harbor 窗口人工视觉验收；当前会话没有可用的浏览器或原生窗口供检查。
- RC manifest 记录：未签名（Windows 会显示来源提示）、未在 Windows 10 x64 验证、未在真实 QQ / DSH 会话验证四种模式及全部 MCP 工具，也未验证 DSH / SnowLuma 重启恢复。
- DSH Agent 的 live workspace boundary 标记为未验证，因此没有放宽安全边界来执行真实 Agent 会话。
