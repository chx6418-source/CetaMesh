# CetaMesh Mobile

**独立运行、本地优先的移动端 CetaMesh 节点。**

Mobile 位于 CetaMesh [公开统一仓库](../../README.md) 的 `apps/mobile/`，不是公开仓库根目录，也不是必须依赖 Desktop 的远程控制界面。Android 为当前主要构建与测试平台；iOS 工程已包含在源码中，但仍需要独立的原生编译与真机验收。

[English](README.md) · [CetaMesh 项目介绍](../../README.md) · [统一开发说明](../../docs/MONOREPO.md)

## 当前能力与边界

- **Chat**：配置外部模型、创建会话、流式响应、附件及基础使用量显示。模型调用需要用户自己的服务配置。
- **Memory**：离线管理本地记忆；记录、检索和授权操作不应等同于自动跨设备分享。
- **Tasks / Approvals**：CetaMesh 自己管理任务与审批状态，外部执行会话是可替换的引用。
- **Device Mesh**：设备身份、二维码配对、信任与协议基础；配对不等于授予工具使用权限。
- **原生能力**：Kotlin/Swift 桥接相机、文件、密钥及设备功能，须经过 Capability/Permission 策略。
- **插件基础**：声明式扩展与受控远程能力；不允许隐式下载执行任意 JavaScript、Shell 或 Native 程序。

这些能力并不意味着所有跨端同步、真实 Agent 调用或原生权限流程都已经完成端到端测试。具体状态见 [移动端验收说明](docs/acceptance/MOBILE_ACCEPTANCE.md) 与 [PROJECT_STATE](PROJECT_STATE.md)。

## 本地开发

从统一仓库根目录进入 Mobile 工程：

```sh
cd apps/mobile
npm ci
npm test
```

`npm test` 包含 TypeScript、ESLint、架构约束、Jest 和产物卫生检查。Android 需要 Node.js 22.11+、JDK 17、Android SDK 37、Build Tools 37.0.0、NDK 27.1.12297006 等工具。

```sh
# 开发模式：先在一个终端运行 npm start（Metro）
npm run android             # 开发版
npm run android:debug       # Debug APK

# 发布候选包：JS Bundle 内置，不依赖 Metro
npm run build:android:release
```

Android CI 会编译并验证 Standalone Release APK，使用一次性测试签名，并上传工作流产物。**CI APK 不等于已经正式签名的公开稳定版本**；不同测试签名之间可能无法覆盖升级。

iOS 原生构建需要 macOS、Xcode 与 CocoaPods；现有 Android 验证不能替代 iOS 验证。

## 隐私与设备授权

本地记忆默认留在设备内；模型请求发送给用户选定的 Provider。设备配对、能力声明与“是否允许读取或同步某段记忆”是不同的决定，敏感操作必须由本机策略授权。

## 文档与参与

- [架构](docs/architecture/MOBILE_ARCHITECTURE.md) · [安全边界](docs/security/MOBILE_SECURITY.md) · [配对协议](docs/protocol/UNIFIED_PAIRING_V1_1.md)
- [统一仓库说明](../../docs/MONOREPO.md) · [项目贡献](../../CONTRIBUTING.md) · [漏洞报告](../../SECURITY.md)
- [GPL-3.0-only 许可证](../../LICENSE) · [第三方声明](../../THIRD_PARTY_NOTICES.md)

CetaMesh 仍处于预稳定开发阶段，功能、协议和界面可能随着验证结果继续调整。
