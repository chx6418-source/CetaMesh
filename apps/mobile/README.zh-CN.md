# CetaMesh

[English](README.md) | **简体中文**

**CetaMesh** 是一个以本地优先（local-first）为原则的 AI 节点与协作运行时。它希望把对话、长期记忆、任务、工具、设备能力和外部模型服务连接到同一套可控的协作体系中，而不是让某一个模型、平台或中心服务器成为系统唯一核心。

> 当前公开仓库首先提供 **CetaMesh Mobile** 源码基线。移动端本身就是一个独立的 CetaMesh Node，本地能力不要求依赖 Desktop、QQ、DSH 或中心服务器。

CetaMesh 仍处于积极开发阶段。在稳定版本发布前，接口、协议和产品行为都可能调整。

## CetaMesh 想解决什么

CetaMesh 不只是一个聊天客户端。长期目标是构建由多个独立节点组成的协作网络，让手机、电脑、Agent、模型服务和外部平台能够在明确的信任边界、权限边界、工作区范围和记忆授权下协同工作。

当前 Mobile 基线已经包含以下主要能力：

- **聊天（Chat）**：可配置模型服务、会话、推理选项、流式输出、附件、停止/重试和真实 Token Usage 处理。
- **本地记忆（Memory）**：离线创建、检索、编辑、置顶和删除；长期记忆写入需要显式确认。
- **任务与审批（Tasks & Approvals）**：由 CetaMesh 自己持有任务状态、执行引用、注意事项、审批和 Action Center 流程。
- **Device Mesh 基础能力**：设备身份、配对、信任元数据、能力声明、在线状态与同步协议基础。
- **Capability Runtime**：对相机、麦克风、文件/照片、通知、二维码和远程能力请求进行权限控制。
- **插件与扩展基础**：支持声明式扩展和远程传输扩展，并进行校验、权限审查和生命周期管理；当前不提供“下载后直接执行任意 JavaScript / Shell / Native 代码”的隐藏路径。
- **Android / iOS 原生桥接**：React Native 共享产品代码，敏感原生能力通过 Kotlin / Swift Provider 接入。

## 核心设计原则

CetaMesh 当前坚持以下架构原则：

1. **本地优先。** 本地聊天状态、记忆、任务状态和设备身份在没有 CetaMesh 云服务时仍应可用。
2. **Task 不等于 Session。** 任务属于 CetaMesh；模型 Provider 的会话只是可替换的执行引用。
3. **信任不等于授权。** 已受信任的设备也不能自动获得本机敏感能力的执行权限。
4. **能力声明不等于能力授权。** 一个节点可以声明自己具备某项能力，但调用仍需经过本地策略。
5. **记忆先授权、后检索。** 记忆范围和授权应在检索、排序或同步之前确定。
6. **原生访问必须受边界约束。** 产品功能不应直接绕过 Capability Runtime 访问任意系统 API。
7. **不提供隐式任意代码执行。** 当前扩展体系不会自动下载并执行任意脚本、Shell 命令或不受限原生代码。

## 当前公开仓库状态

当前公开仓库的根目录是 **CetaMesh Mobile** 源码基线。

主要技术栈：

- React Native
- TypeScript
- Kotlin（Android 原生能力）
- Swift / Objective-C++（iOS 原生桥接）
- SQLite（本地结构化数据）

项目目前属于 **pre-stable / 预稳定阶段**。自动化检查覆盖 TypeScript、ESLint、架构边界、单元/集成测试和 Android 构建验证；硬件相关能力和跨设备互操作仍需要持续进行真机验证。

详细实现状态请查看 [PROJECT_STATE.md](PROJECT_STATE.md)。

## 目录结构

```text
.
├── android/                 Android 工程与原生能力 Provider
├── ios/                     iOS 工程与原生能力 Provider
├── src/
│   ├── app/                 应用启动与组合
│   ├── data/                SQLite、Repository 与迁移
│   ├── domain/              平台无关领域模型与接口
│   ├── features/            产品功能与 UI
│   ├── native/              React Native 原生 Provider 适配
│   ├── protocol/            配对与 Device Mesh 协议
│   ├── providers/           模型、网络、更新与桌面适配器
│   ├── runtime/             Chat / Task / Memory / Capability / Sync Runtime
│   ├── security/            能力、记忆与附件安全策略
│   ├── shared/              UI、国际化、错误、工具与日志
│   └── test/                自动化测试
├── docs/                    架构、协议、安全与验收文档
├── PROJECT_STATE.md         当前实现与验证状态
├── AGENTS.md                面向编码 Agent 的仓库规则
└── LICENSE                  GNU GPL v3
```

## 快速开始

### 环境要求

- Node.js **22.11+**
- npm
- Android Studio + Android SDK（Android 构建）
- macOS + Xcode + CocoaPods（iOS 原生构建）

安装依赖：

```bash
npm ci
```

运行完整仓库检查：

```bash
npm run check
```

该命令会执行 TypeScript 检查、ESLint、架构边界检查和 Jest 测试。

### Android

启动 Metro：

```bash
npm start
```

运行开发版：

```bash
npm run android
```

只构建 Debug APK：

```bash
npm run android:debug
```

### iOS

在 macOS 上：

```bash
bundle install
cd ios
bundle exec pod install
cd ..
npm run ios
```

iOS 源码已经存在于仓库中，但原生验证应与 Android CI 结果分开看待。

## 模型服务与隐私

CetaMesh **不会内置模型 API Key**。

用户自行配置第三方模型服务凭据，凭据应通过平台安全存储保存。发起模型请求时，对话内容会发送给用户选择的 Provider；仅仅配置模型 Provider 并不意味着本地 Memory 会自动上传。

使用第三方模型服务前，请自行确认其隐私、数据保留、价格和使用条款。

## 安全

CetaMesh 的敏感设备操作通过 Capability Runtime 和 Permission Policy 进行显式路由。未知能力默认拒绝，设备已经配对或受信任也不代表自动拥有敏感执行权限。

发现安全漏洞时，请不要把漏洞细节、真实密钥或 PoC 直接发布到公开 Issue。请按照 [SECURITY.md](SECURITY.md) 的流程报告。

## 文档入口

- [当前项目状态](PROJECT_STATE.md)
- [移动端架构](docs/architecture/MOBILE_ARCHITECTURE.md)
- [协议 v1](docs/protocol/PROTOCOL_V1.md)
- [移动端安全说明](docs/security/MOBILE_SECURITY.md)
- [移动端验收状态](docs/acceptance/MOBILE_ACCEPTANCE.md)
- [开源政策（英文）](OPEN_SOURCE.md)
- [开源协议与使用规范（中文）](OPEN_SOURCE.zh-CN.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)

## 参与贡献

欢迎参与 CetaMesh 的开发。提交代码前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

建议保持 Pull Request 聚焦，避免把无关重构混入同一个 PR；行为变化应增加或更新测试，并在提交前运行：

```bash
npm run check
```

## 开源协议

除文件或第三方组件另有声明外，本仓库中的 CetaMesh 源代码以 **GNU General Public License v3.0 only（GPL-3.0-only）** 发布。

具有法律效力的完整条款请以 [LICENSE](LICENSE) 为准。关于修改、再分发、商业使用、贡献、第三方依赖和品牌标识的项目级说明，请阅读 [OPEN_SOURCE.zh-CN.md](OPEN_SOURCE.zh-CN.md)。

## 项目阶段说明

CetaMesh 目前仍是积极开发中的开源项目，并不是已经完成独立安全审计的成熟生产平台。对敏感数据、设备权限、模型服务配置、远程能力和跨设备功能有较高要求的场景，请自行评估当前版本和构建结果。
