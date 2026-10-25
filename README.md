# CetaMesh

**让不同 AI 工具与设备之间的协作更连贯。**

CetaMesh 是一个正在开发的、本地优先的 AI 协作工作台。它将聊天、任务、记忆、Agent、工具与设备连接放在同一套可管理的体系中，目标是减少切换模型或工具时反复交代背景、重复安排任务的成本。

它不只是一个聊天界面，也不是把多个模型塞进同一个窗口：**任务由 CetaMesh 管理，Agent 可以作为执行者参与；记忆与设备能力则必须遵守各自的授权边界。**

[English](README.en.md) · [官网](https://cetamesh.com) · [项目指南](docs/PROJECT_GUIDE.md) · [参与贡献](CONTRIBUTING.md)

> **开发中 / 预稳定阶段。** 当前已有 Desktop 与 Mobile 工程、自动化测试和部分可用功能，但跨工具接续、真实设备协作、第三方连接与正式签名发布仍在持续完善中。不要把架构目标或测试通过等同于所有功能已在真实环境完成验收。

## 为什么做 CetaMesh？

在一个 AI 工具里讨论需求、换一个工具写代码、再用第三个 Agent 检查结果——工具之间往往不知道此前完成了什么，也不能自然共享任务状态和必要的上下文。

CetaMesh 希望逐步解决这个问题：

- **聊天只是入口。** 用户可以直接询问问题，也可以把较长的工作组织成任务。
- **任务独立于 Agent 会话。** 更换执行工具时，任务本身、进度和工作区不应随某次会话结束而消失。
- **记忆可控。** 本地信息、任务上下文和授权共享范围应明确区分。
- **设备各自独立。** 手机和电脑不必一直互相连接；连接与信任也不意味着自动开放全部权限。

以上是产品方向，其中部分跨工具、跨设备场景仍处于协议、实现或验证阶段。

## 目前包含什么？

| 领域 | 当前实现与边界 |
| --- | --- |
| **Chat** | Desktop 支持配置 Model Provider 后直接聊天；Mobile 提供独立的聊天、会话与附件基础能力。实际请求会使用用户选择的模型服务。 |
| **Tasks / Workspace** | Desktop 包含任务、工作区、执行引用与接续相关运行时；Mobile 具备本地任务、审批和 Action Center 基础。复杂 Agent 端到端执行仍依赖具体集成与授权。 |
| **Memory** | 两端均有本地记忆能力；跨作用域读取、跨设备同步不能绕过授权。 |
| **Agents / Tools** | Desktop 有 Agent Broker、工具与权限管理，包含 DSH、Codex、ZCode 等适配代码；存在适配器不代表相关外部软件在所有环境都已可用。 |
| **Plugins** | 提供插件/扩展的声明、验证和权限边界；插件市场、发布服务及隔离强度仍有待完善。 |
| **Device Mesh** | 包含设备身份、配对、信任与协议基础；真实手机和桌面的完整跨设备协作尚不能宣称全部验收。 |

## 平台与仓库结构

```text
CetaMesh/
├── src/                  # Desktop Core：Chat / Agent / Task / Memory 等
├── desktop-shell/        # Windows 原生桌面宿主（Rust）
├── desktop-ui/           # 桌面界面（React / WebView2）
├── plugins/ extensions/  # 桌面插件与扩展
├── apps/mobile/          # 独立 React Native App（Android / iOS 源码）
├── docs/                 # 架构、协议、开发与用户文档
└── .github/workflows/    # Windows 与 Android 独立 CI
```

**Desktop 是当前统一仓库的主体，Mobile 完整位于 `apps/mobile/`。** 两者各自管理依赖、权限、版本和发布产物；iOS 有源码，但原生构建和真机验证不能用 Android CI 结果代替。

## 获取与体验

- [GitHub Releases](https://github.com/chx6418-source/CetaMesh/releases)：查看已公开的构建产物及其说明。历史 Windows RC 安装包**不等于稳定版**，签名、兼容性与安全提示请以对应版本说明为准。
- [GitCode 国内仓库](https://gitcode.com/ygdnn/CetaMesh)：项目的国内代码及发布入口之一。两处仓库的发布内容与更新节奏不一定同步。
- [官网](https://cetamesh.com)：产品介绍和相关文档。

目前无法保证所有平台都有可直接安装的公开稳定版本。Android Standalone APK 可由 CI 构建，CI 使用的临时测试签名不等于正式发布签名。

## 从源码开始

需要 Node.js **22.13+**。Desktop 原生构建需要 Windows 与 Rust 工具链；Android 构建需要 JDK、Android SDK/NDK；iOS 原生构建需要 macOS/Xcode。

```sh
# Desktop：仓库根目录
npm ci
npm --prefix desktop-ui ci
npm test
npm run build:ui

# Mobile：独立安装与验证
npm --prefix apps/mobile ci
npm --prefix apps/mobile test
```

开发运行、Windows 安装包与 Android APK 构建请参考 [统一开发指南](docs/MONOREPO.md)、[Desktop 构建说明](docs/desktop/BUILD_AND_RELEASE.md) 和 [Mobile README](apps/mobile/README.zh-CN.md)。以上命令不代表已经构建正式发行安装包。

## 安全、许可与参与

CetaMesh 源码采用 [GPL-3.0-only](LICENSE)；第三方组件受各自许可约束，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。CetaMesh 不分发 SnowLuma 主程序或受限 SDK/MCP，QQ 互操作需要用户自行安装和依法使用独立网关。

- [当前项目状态](PROJECT_STATE.md) · [已知限制](docs/desktop/KNOWN_LIMITATIONS.md) · [变更记录](CHANGELOG.md)
- [产品与工程指南](docs/PROJECT_GUIDE.md) · [插件开发](docs/plugin-development/README.md) · [协议文档](docs/protocol/UNIFIED_PAIRING_V1_1.md)
- [开源说明](OPEN_SOURCE.zh-CN.md) · [贡献指南](CONTRIBUTING.md) · [安全漏洞报告](SECURITY.md)

欢迎提 Issue、参与测试和提交 PR。由于项目仍在演进，请优先根据真实代码、已确认的验收结果和具体平台限制判断功能可用性。
