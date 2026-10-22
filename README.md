# CetaMesh

**连接 AI Agent、任务、记忆、插件和设备的智能协作网络。**

CetaMesh 希望让不同 AI 工具能够接续任务、传递经授权的上下文，并在桌面与移动设备之间协同工作。项目采用本地优先架构，目前仍处于开发与测试阶段；部分连接、同步及第三方集成能力尚不稳定。

[English](README.en.md) · [项目简介](README.zh-CN.md) · [官网](https://cetamesh.com)

## 项目结构

- **Desktop（仓库根目录）**：src/（Core）、desktop-shell/（Rust 原生外壳）、desktop-ui/（React/WebView2 UI）、plugins/ 与 extensions/。
- **Mobile（apps/mobile/）**：独立的 React Native 应用，包含 Android、iOS 和原生模块。
- **共享协议**：docs/protocol/ 与 fixtures/pairing/；packages/ 为后续经过验证的跨端公共模块预留。
- **独立构建发布**：Windows 安装包与 Android APK 不共享依赖安装目录、签名或版本发布流程。

桌面端不要求手机连接才能使用，移动端也不要求桌面端在线。设备信任不等于能力授权，记忆和任务数据不应在未获批准的情况下自动同步。

## 本地开发与验证

环境：Node.js 22.13+；桌面原生编译还需要 Windows 与 Rust 工具链；Android 构建需要对应 Android SDK、JDK 与 Gradle 环境。

Desktop（在仓库根目录）：

~~~sh
npm ci
npm --prefix desktop-ui ci
npm test
npm run build:ui
~~~

Mobile（在仓库根目录）：

~~~sh
npm --prefix apps/mobile ci
npm --prefix apps/mobile test
~~~

原生构建命令、CI 与发布前置条件见 [统一工程指南](docs/MONOREPO.md)、[桌面构建说明](docs/desktop/BUILD_AND_RELEASE.md) 和 [移动端 README](apps/mobile/README.md)。自动化测试通过不代表真机、真实外部 Agent 或签名发布已全部验收。

## 功能与限制

Desktop 以 Chat、Tasks、Memory、Workspace 为核心，逐步提供 Agent 调用、权限受控的工具/插件和 Device Mesh；Mobile 提供独立聊天、记忆、任务及设备能力。具体实现状态、缺失项和已知限制请查阅 [PROJECT_STATE](PROJECT_STATE.md)、[桌面已知限制](docs/desktop/KNOWN_LIMITATIONS.md)。

## 第三方软件与开源

CetaMesh 自身代码使用 [GPL-3.0-only](LICENSE)。第三方组件按其各自许可证授权，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

**不随仓库或安装包分发 SnowLuma 主程序和受限 SDK/MCP。** CetaMesh 的 QQ 通道通过独立实现的 OneBot 协议客户端与用户自行安装、合法使用的兼容服务通信。对第三方程序的使用须分别遵守其许可与平台条款；其他第三方材料仍需持续审核。

## 参与项目

- [中文开源说明](OPEN_SOURCE.zh-CN.md) · [贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md)
- [开发与构建](docs/MONOREPO.md) · [架构说明](docs/desktop/ARCHITECTURE.md) · [插件开发](docs/plugin-development/README.md)
- [变更记录](CHANGELOG.md) · [源码来源说明](docs/migration/SOURCE_PROVENANCE.md)

早期 UI 备选稿、历史修复报告与调试证据不属于正式开源发布内容，已保留于私有归档。正式运行的 UI 和构建测试源码不受该归档影响。
