# 了解 CetaMesh

CetaMesh 是一个**本地优先的 AI 协作工作台**。它把聊天、Agent、任务、工作区、记忆和设备能力组织在一套有明确权限边界的体系中，尝试让用户不必每次切换模型或工具时都从头介绍项目进度。

本文面向初次了解或尝试 CetaMesh 的用户；具体构建命令和代码边界参见 [项目主页](../README.md)、[统一工程指南](MONOREPO.md) 与 [Desktop 架构](desktop/ARCHITECTURE.md)。

> **仍在开发中。** CetaMesh 已有可运行的模块与自动化测试，但复杂 Agent 工作流、跨设备接续及部分外部服务连接仍需真实环境验证。本文区分产品目标与已经存在的功能。

## 从一次提问到一项任务

你可以先把 CetaMesh 当作本地聊天工具：配置自己的 Model Provider，在电脑或手机上与模型对话。

当事情需要多步骤完成时，CetaMesh 的 Task、Workspace 和 Agent 运行时提供承载任务、工作文件和执行状态的基础。长期目标是让任务可以在不同 Agent/工具之间有条件地交接，而不完全依赖某一条聊天会话的上下文。

**注意：** 这是持续实现与验证中的协作方向，不意味着任意两个第三方 AI 工具都已经支持无缝互换，也不意味着跨端同步会自动执行。

## Desktop 和 Mobile 的关系

| 平台 | 现有形态 | 重要说明 |
| --- | --- | --- |
| **Desktop** | Windows 原生宿主、Chat、Task/Workspace、Memory、Agent Broker、权限与插件相关服务 | 直接 Model Provider 聊天无需 DSH；具体 Agent 的可用性取决于外部安装、配置和授权 |
| **Mobile** | React Native Android 应用与 iOS 工程；本地聊天、记忆、任务和 Device Mesh 基础 | 不需要桌面端持续在线；真机跨端协议与同步仍需分场景验收 |

代码位置：Desktop 位于仓库根目录的 `src/`、`desktop-shell/` 与 `desktop-ui/`；Mobile 完整位于 `apps/mobile/`，有独立的 `package.json` 和原生构建环境。

## 如何开始

### 1. 获取已有构建

[GitHub Releases](https://github.com/chx6418-source/CetaMesh/releases) 可查看现有历史构建；[GitCode](https://gitcode.com/ygdnn/CetaMesh) 是国内代码及发布入口之一。请阅读每个构建的说明：部分 Windows 候选包未签名，Android 测试 APK 也不能视作正式发行版。

### 2. 从源码验证

安装 Node.js 22.13+。在统一仓库根目录：

```sh
npm ci
npm --prefix desktop-ui ci
npm test
npm run build:ui

npm --prefix apps/mobile ci
npm --prefix apps/mobile test
```

构建 Windows 原生程序需 Rust/Windows 工具链；Android 需 JDK、SDK 和 NDK；iOS 需 macOS/Xcode。命令和发行产物目录以 [工程指南](MONOREPO.md)、[桌面构建](desktop/BUILD_AND_RELEASE.md) 与 [Mobile 指南](../apps/mobile/README.zh-CN.md) 为准。

### 3. 配置模型和外部 Agent

- 普通聊天可以选择用户自己配置的模型服务，不必先安装 DSH、QQ 或其他 Agent 应用。
- Agent 功能需要相应的 Provider、工具和明确授权。仓库出现 DSH/Codex/ZCode 适配代码不等于电脑上已安装或自动连接成功。
- QQ/OneBot 是可选通道；外部网关由用户独立安装和管理，CetaMesh 不分发 SnowLuma 主程序或受限 SDK。

DSH 细节见 [集成说明](integrations/DSH.md) 和 [DSH 配置](DSH_SETUP.md)。早期 WhaleBridge 以 QQ↔DSH 桥接为主，那只是 CetaMesh 的历史来源及可选集成的一部分，**不是当前整个产品的定义**。

## 数据、记忆与信任

- 聊天消息在调用外部模型时会发送到用户选定的 Provider；请根据所使用服务的政策判断数据处理方式。
- 本地 Memory 的记录、检索、跨工作区访问、共享和同步应有独立授权边界。
- 设备配对只建立身份与信任基础，不自动开放摄像头、文件、Shell、记忆或远程执行。
- 插件与外部 Agent 不能因为“已连接”就绕过 Capability 与用户审批。

## 目前尚待完善

真实 Windows 安装与升级、IME 与界面细节，Android/iOS 真机能力、跨设备任务与记忆的完整互操作，第三方 Provider 的环境兼容性，以及安装包签名与旧版本更新通道，都需要分别看待。具体清单参见 [当前状态](../PROJECT_STATE.md)、[桌面已知限制](desktop/KNOWN_LIMITATIONS.md) 和 [移动端验收](../apps/mobile/docs/acceptance/MOBILE_ACCEPTANCE.md)。

## 开源与参与

[LICENSE](../LICENSE) 为 GPL-3.0-only；第三方组件不因此自动变成 GPL。欢迎通过 [贡献指南](../CONTRIBUTING.md) 参与代码、文档与测试，通过 [安全说明](../SECURITY.md) 负责任地反馈安全漏洞。插件开发可从 [SDK/扩展文档](plugin-development/README.md) 开始。

CetaMesh 的目标是**让协作变得可接续、可授权、可理解**。当前项目优先完善稳定性和可验证的功能，再逐步扩大工具与设备之间的连接。
