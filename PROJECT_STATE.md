# CetaMesh — 当前项目状态

更新日期：2026-10-23。

## 正式仓库与平台

- 官方公开仓库：https://github.com/chx6418-source/CetaMesh
- 2026-10-21：Desktop + Mobile 的已审查源码快照合并到公开 main，提交 `350c1fc4ec8d21d9ae7ac80285979c588c007e99`。
- 2026-10-22：公开文档与旧设计清理 PR #4 合并到 main，提交 `1235d1526757a503182489d44c32e9dffd6db79b`。
- Desktop 主工程位于 `src/`、`desktop-shell/`、`desktop-ui/`；Mobile 位于 `apps/mobile/`。两端各自保留运行时、依赖、权限和发布过程。
- 原桌面端及移动端私有仓库保留独立历史。公开仓库只导入审核过的源码快照，没有合入完整私有 Git 历史。

## 已有代码与安全边界

- Desktop 具备直连 Model Provider 的聊天、任务、工作区、记忆、Agent Broker、Capability Broker、插件与 Device Mesh 基础。
- Mobile 具备独立的 Chat、Memory、Tasks、设备身份和权限能力，并包含 Android 与 iOS 原生工程。
- 授权与信任是两回事。配对不自动开放工具、记忆读取或远程执行；跨设备同步还需要专门授权与验证。
- SnowLuma 主程序和受限 SDK/MCP 不包含在正式公开源代码及其打包输入中；可选 QQ 连接基于独立 OneBot 实现。
- 现有 GitHub Releases 包含 Windows 候选构建，但不等于稳定发行；历史更新入口仍需兼容。

## 已验证及未完成的门禁

- 公开仓库清理 PR #4 在合并前的最终 Windows/Android CI 均通过；该验证只对应当时的源码提交。
- Android CI 构建并检查包含 JS Bundle 的 Standalone Release APK，使用临时测试签名。
- 真实 Android/iOS 设备能力、Desktop↔Mobile 配对与任务接续、第三方 Provider 真实工作流、代码签名、更新验签与完整第三方二进制许可仍需按版本和环境独立验收。
- 不应把源码存在、模拟测试通过或 Android CI 通过当作 iOS 和全功能上线的证据。

## 当前开发工作

- 公开介绍校准 PR #5 已合入 main（33b10b3）；本轮保留其内容，并在该公开历史上同步已确认的 Desktop UI 与 Agent 源码快照。
- 下一阶段应优先解决真实终端验证、外部 Agent 接入稳定性和发行门禁，避免为当前用户造成已全部稳定可用的印象。

[项目主页](README.md) · [统一开发与构建](docs/MONOREPO.md) · [桌面限制](docs/desktop/KNOWN_LIMITATIONS.md) · [移动端指南](apps/mobile/README.zh-CN.md)

## Desktop 源码同步（2026-10-23）

- 补齐上一轮遗漏的 GitHub 公开仓库同步；本轮以公开 main 的 33b10b3 为基线，保持独立公开历史。
- 包含绿色应用图标、紧凑标题栏、图标侧栏和记忆入口、竖向设置、任务卡片、输入区与动效，以及有条件的八项 Agent 注册/RPC/ACP/SDK/API 适配。各 Provider 仍按真实能力与权限门槛决定可用性。
- Mobile、公开介绍、文档清理、独立 OneBot、SDK/MCP 排除与现有更新入口保持。详细实现边界见 [Agent 接入状态](docs/desktop/AGENT_INTEGRATION_STATUS.md)。
- 实际公开快照经统一入口选择31项测试：30 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT；唯一跳过项为缺少新产物的 Agent SEA。前端 TypeScript/Vite 构建通过，独立导出边界审查无 Critical/Important/Minor 发现。未重新运行全部测试、Cargo 或 Mobile 测试；共享协议与 Mobile 源码未变。真实账号、原生安全和正式安装验收仍单独保留。
