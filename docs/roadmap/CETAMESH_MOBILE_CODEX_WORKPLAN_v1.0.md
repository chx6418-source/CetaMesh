# CetaMesh Mobile — Codex 开发工作文档 v1.0

> **用途**：给 Codex / DSH / 其他编码 Agent 使用的移动端主施工文档。  
> **目标**：从空目录开始独立开发 CetaMesh Mobile；不阻塞 Desktop；Android 优先，iOS 从架构第一天起保持兼容。  
> **状态**：规划基线。开始编码后，任务状态与验证结果必须持续维护。  
> **产品原则**：Mobile 是独立的 CetaMesh Node，不是 Desktop 的遥控器。

---

# 0. Codex 必读规则

1. 开工前完整阅读本文件和 `PROJECT_STATE.md`。
2. 每次只处理一个 `TASK-ID`，除非任务明确要求批量变更。
3. 修改前先检查依赖任务是否已完成。
4. 不跨阶段“顺手实现”未来功能。
5. 不为了架构漂亮做无关重构。
6. 不复制 Desktop UI / Runtime 代码到 Mobile。
7. UI 不得直接调用 Android/iOS 系统 API。
8. 所有设备能力必须经过 `Capability Runtime`。
9. 所有持久化必须经过 Repository / Data 层。
10. 所有跨设备数据必须经过 Protocol / Sync 层。
11. 所有高风险能力默认拒绝，必须显式授权。
12. API Key、Token、设备私钥不得进入源码、普通日志或普通 SQLite 表。
13. Android 优先，但公共接口不得使用 Android-only 命名。
14. iOS 暂未实现的能力必须返回明确 `unsupported`，不得伪造成功。
15. 任务完成后必须运行该任务要求的测试。
16. 测试失败不得标记 `DONE`。
17. 接口或协议变化必须同步文档。
18. 不实现任意下载代码并在手机本地执行的插件机制。
19. Mobile 启动不得依赖 QQ、SnowLuma、DSH 或 Desktop。
20. 任何未声明 Capability 默认 `DENY`。

---

# 1. 产品定义

CetaMesh Mobile 是一个可以独立运行的移动智能端，同时又可以在绑定 Desktop 后加入 CetaMesh Device Mesh。

独立运行应支持：

- 模型聊天与多会话
- 模型切换与推理强度切换
- 图片 / 文件输入
- 基础长期记忆
- 本地任务
- 手机设备能力
- Push / Notification
- Share to CetaMesh
- Camera / Microphone

与 Desktop 连接后增加：

- Desktop Task 查看
- Agent Task 状态
- Owner Approval
- Agent 切换控制
- Memory 同步
- Artifact / 文件传输
- Device Capability 暴露
- Remote Task 创建
- Agent Continuity 控制

Mobile **不是**：

- Desktop WebView 壳
- QQ 客户端
- DSH 客户端壳
- 远程 Shell
- 手机 IDE
- 任意动态代码执行容器

---

# 2. 核心原则

## 2.1 双轨开发

```text
Desktop Track                  Mobile Track
─────────────                  ────────────
Foundation                     Mobile Foundation
Standalone Chat                Standalone Chat
Memory Runtime                 Mobile Memory
Agent Runtime                  Device Capability
Plugin Lab                     Share / Approval
Workshop                       Mobile Extensions
```

共享：

```text
CetaMesh Protocol
Identity Model
Task Model
Memory Model
Capability Model
Event Model
```

不共享 UI。

## 2.2 Tasks belong to CetaMesh, not to agents

Mobile 展示的是 `Task`，不是某个 Agent 的私有 Session。

## 2.3 Memory belongs to CetaMesh, not to agents

Mobile Memory 必须支持 Scope / Policy，至少包括：

- Local Only
- My Devices

后续扩展：

- Workspace
- Project
- Cloud Sync

## 2.4 Sessions are disposable; progress is persistent

复杂任务的事实来源是：

- Task State
- Checkpoint
- Progress
- Artifact
- Memory Reference

而不是某个 Agent Session 的完整聊天历史。

---

# 3. 技术栈基线

## 应用层

- React Native
- TypeScript
- React Native New Architecture
- Android 优先
- iOS 保持兼容

## 原生能力层

Android：Kotlin  
iOS：Swift

仅在以下能力需要时下沉原生：

- Camera
- Microphone
- Location
- NFC
- Bluetooth
- Push
- Share Sheet
- Background Task
- Secure Key Storage
- File Provider

## 本地数据

- SQLite：正式业务数据
- Android Keystore / iOS Keychain：Secret / 私钥
- App Cache：临时文件
- 简单 KV：仅 UI 偏好

## 网络

- HTTPS：同步 / 配置 / 文件 / Pairing
- WebSocket：实时事件 / Chat Stream / Task / Approval
- Push：后台通知
- Resume Catch-up Sync：恢复时补齐状态

## 协议

长期目标包：

```text
@cetamesh/protocol
```

独立仓库第一阶段可先放：

```text
src/protocol/
```

---

# 4. 推荐仓库与目录

初期独立仓库：

```text
cetamesh-mobile
```

目标目录：

```text
cetamesh-mobile/
├── android/
├── ios/
├── src/
│   ├── app/
│   │   ├── navigation/
│   │   ├── bootstrap/
│   │   └── providers/
│   ├── features/
│   │   ├── home/
│   │   ├── chat/
│   │   ├── tasks/
│   │   ├── memory/
│   │   ├── devices/
│   │   ├── approvals/
│   │   ├── discover/
│   │   └── profile/
│   ├── runtime/
│   │   ├── session/
│   │   ├── chat/
│   │   ├── task/
│   │   ├── memory/
│   │   ├── capability/
│   │   ├── event/
│   │   ├── identity/
│   │   └── sync/
│   ├── domain/
│   │   ├── model/
│   │   ├── task/
│   │   ├── memory/
│   │   ├── capability/
│   │   ├── identity/
│   │   └── device/
│   ├── providers/
│   │   ├── model/
│   │   ├── network/
│   │   ├── push/
│   │   └── desktop/
│   ├── native/
│   │   ├── camera/
│   │   ├── microphone/
│   │   ├── location/
│   │   ├── nfc/
│   │   ├── bluetooth/
│   │   ├── share/
│   │   └── secure-storage/
│   ├── data/
│   │   ├── database/
│   │   ├── migrations/
│   │   ├── repositories/
│   │   └── cache/
│   ├── protocol/
│   ├── security/
│   ├── shared/
│   │   ├── ui/
│   │   ├── hooks/
│   │   ├── errors/
│   │   └── utils/
│   └── test/
├── docs/
│   ├── architecture/
│   ├── protocol/
│   ├── security/
│   └── acceptance/
├── scripts/
├── package.json
├── tsconfig.json
├── README.md
├── AGENTS.md
└── PROJECT_STATE.md
```

禁止长期演变成只有：

```text
screens/
components/
utils/
```

---

# 5. 软件架构

采用：

> **Feature-oriented Clean Architecture + Local-first + Event-driven Runtime**

调用链：

```text
UI
 ↓
Use Case / Runtime
 ↓
Domain Interface
 ↓
Repository / Provider
 ↓
Infrastructure
```

聊天：

```text
ChatScreen
 ↓
SendMessage
 ↓
ChatRuntime
 ↓
ModelProvider
 ↓
Concrete Provider
```

设备能力：

```text
Feature / Model Tool
 ↓
CapabilityRuntime
 ↓
PermissionPolicy
 ↓
NativeCapabilityProvider
 ↓
Kotlin / Swift
```

---

# 6. Mobile Runtime

## 6.1 Chat Runtime

负责：

- 创建消息
- 模型请求
- Streaming
- Tool 请求
- Session 上下文
- 错误恢复

不负责：

- 保存 API Key
- 直接写 SQLite
- 直接调用 Camera
- 直接访问 Desktop

## 6.2 Session Runtime

每个会话独立保存：

```ts
type ChatSessionConfig = {
  mode: "smart" | "chat";
  modelProviderId: string;
  modelId: string;
  reasoning: "fast" | "standard" | "high" | "max";
  memoryScope?: string;
};
```

Mobile v0.1 暂不实现 Social / Owner Agent / Workshop。

## 6.3 Task Runtime

```ts
type Task = {
  id: string;
  title: string;
  status:
    | "queued"
    | "running"
    | "paused"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  source: "mobile" | "desktop" | "cloud";
  progress?: number;
  phase?: string;
  createdAt: string;
  updatedAt: string;
};
```

Task 不绑定具体 Agent 名称。

## 6.4 Memory Runtime

第一阶段：

- Working Memory
- Chat Memory
- User Memory
- Task Memory
- Mobile Local Memory

后续：

- Workspace Memory
- Social Memory
- Knowledge Memory
- Skill Memory
- Memory Graph
- Memory Pack

## 6.5 Event Runtime

```ts
type CetaEvent =
  | { type: "chat.message.created"; payload: unknown }
  | { type: "task.updated"; payload: unknown }
  | { type: "memory.created"; payload: unknown }
  | { type: "device.connected"; payload: unknown }
  | { type: "approval.required"; payload: unknown };
```

## 6.6 Capability Runtime

统一能力名：

```text
camera.capture
camera.scanDocument
microphone.record
location.current
nfc.read
nfc.write
bluetooth.scan
bluetooth.connect
photos.select
file.pick
share.receive
share.send
notification.send
```

禁止公共接口使用 `androidCameraCapture` 一类名称。

---

# 7. Model Provider

统一接口：

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}
```

必须支持：

- Provider Registry
- Streaming
- Abort
- Timeout
- Reasoning 参数
- 统一错误
- Secure Credential Reference

API Key 不得进入普通聊天数据库。

---

# 8. Smart 模式

Mobile v1 先做：

```text
Simple
→ Model

Tool Needed
→ Model + Capability
```

绑定 Desktop 后再扩展：

```text
Complex Project
→ Desktop Task
→ Agent Broker
```

预留：

```ts
type ExecutionTarget =
  | { kind: "model" }
  | { kind: "mobile-capability" }
  | { kind: "desktop-agent" };
```

---

# 9. Memory 设计

```ts
type MemoryRecord = {
  id: string;
  kind: "working" | "chat" | "task" | "user" | "local";
  scope: string;
  content: string;
  source?: MemorySource;
  importance?: number;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};
```

默认 Policy：

```text
local-only
```

用户明确开启后才能：

```text
my-devices
```

新 Memory 不得默认上传 Cloud。

---

# 10. 本地数据库

SQLite 至少包含：

```text
settings
model_providers
chat_sessions
chat_messages
memories
tasks
task_events
devices
capability_grants
sync_queue
```

要求：

1. 有 `schema_version`。
2. 每次 Schema 修改有 Migration。
3. 禁止升级时删表重建。
4. 测试 DB 与真实 DB 分离。
5. Secret / Device Private Key 不进入普通表。

---

# 11. Secure Storage

安全存储内容：

- Model API Secret
- Device Private Key
- Refresh Credential
- Pairing Credential

Android 使用 Keystore；iOS 使用 Keychain。

日志禁止输出这些值。

---

# 12. Device Identity

必须区分 User Identity 和 Device Identity。

```ts
type DeviceIdentity = {
  deviceId: string;
  deviceName: string;
  platform: "android" | "ios";
  publicKey: string;
  createdAt: string;
};
```

私钥只保存在安全存储。

---

# 13. Desktop Pairing

标准流程：

```text
Desktop
 ↓
显示 QR
 ↓
Mobile 扫码
 ↓
一次性 Pairing Token
 ↓
交换 Device Public Key
 ↓
用户确认
 ↓
建立 Device Trust
```

Pairing Token 必须：

- 短时有效
- 一次性
- 不包含永久 Secret
- 使用后失效

不得要求普通用户手工输入永久 API Key。

---

# 14. Sync 架构

禁止同步整个 SQLite 文件。

采用：

> Object + Event Sync

```json
{
  "protocol": "cetamesh",
  "version": 1,
  "type": "memory.created",
  "objectId": "mem_123",
  "revision": 1
}
```

必须设计：

- event id
- object id
- revision
- timestamp
- ack
- retry
- deduplication
- conflict handling

---

# 15. 网络与前后台

HTTPS：

- Pairing
- 历史同步
- 配置
- Artifact
- 文件
- Catch-up

WebSocket：

- Chat Stream
- Task Progress
- Approval
- Device State
- Realtime Event

Push：

- Approval Required
- Agent Need Attention
- Task Completed
- Device Security Event

Foreground：WebSocket + realtime sync  
Background：Push + OS background task  
Resume：Catch-up Sync

不得假设 App 永久保持 WebSocket。

---

# 16. Mobile UI

第一阶段主导航：

```text
Home
Chat
Tasks
Memory
Devices
Me
```

后续：

```text
Discover
Approvals
```

不要照搬 Desktop 的完整 Workspaces / Agents / Plugin Lab / Security Console。

---

# 17. Chat 页面

必须提供：

```text
Mode
Model
Reasoning
```

第一版 Mode：

```text
Smart
Chat
```

不暴露 WhaleBridge 历史模式：

```text
reserved
reserved2
closed-agent
```

---

# 18. Memory 页面

第一版：

```text
Recent
Chat
User
Task
Local
```

必须支持：

- 查看
- 搜索
- 编辑
- 删除
- Pin
- 查看来源

后续再加 Relations / Graph / Memory Pack。

---

# 19. Share to CetaMesh

支持系统分享：

- URL
- Text
- Image
- File

进入 CetaMesh 后用户选择：

```text
Send to Chat
Save to Memory
Create Task
```

---

# 20. 首批 Capability

## Camera

M4 至少实现：

```text
camera.capture
```

后续：

```text
camera.scanDocument
camera.scanQr
```

## Microphone

M4 至少：

```text
microphone.record
```

后续：

```text
voice.chat
speech.transcribe
```

## File / Photos

```text
file.pick
photos.select
```

## Notification

```text
notification.send
```

所有能力必须通过 Capability Runtime + Permission Policy。

---

# 21. Approval

绑定 Desktop 后：

```text
Desktop Agent
 ↓
approval.required
 ↓
Push
 ↓
Mobile
 ↓
Approval Detail
```

Approval Detail 至少显示：

- Task
- Agent / Provider
- Capability
- Target
- Risk
- Reason
- Expiration

第一版按钮：

```text
Reject
Approve Once
```

高风险权限第一版不做“永远允许”。

---

# 22. Mobile Extension 方针

第一阶段禁止任意动态下载代码执行。

未来允许：

## Declarative Tool

- Schema
- HTTP Definition
- Workflow
- UI Metadata

## Memory Pack

数据型 `.cetamemory`。

## Remote Plugin

逻辑运行 Desktop / Server；Mobile 提供 UI + Capability。

## Native Extension

必须进入正式 Android/iOS 构建与发布流程。

---

# 23. 安全红线

以下任何一项违反都视为 BLOCKER：

1. Model / Agent 直接获得原生系统对象。
2. Capability 绕过 Policy。
3. 未知 Capability 被允许。
4. API Key 存入普通 SQLite。
5. Device Private Key 可导出。
6. Pairing Token 长期有效或可重放。
7. WebSocket payload 未做 Schema 校验。
8. Sync Event 可重复执行副作用。
9. 外部 URL 不检查 scheme。
10. 文件导入可任意读取设备文件系统。
11. 日志打印 Secret。
12. Debug 构建自动放宽危险权限。
13. 后台无提示持续录音。
14. Memory 默认跨设备或上传云端。
15. Mobile 暴露 unrestricted shell。
16. Mobile 接受 Desktop 发来的任意命令字符串并执行。
17. 插件绕过 Capability Runtime。
18. WebView 暴露 unrestricted native bridge。

---

# 24. Error Model

```ts
type CetaErrorCode =
  | "network_unavailable"
  | "timeout"
  | "unauthorized"
  | "permission_denied"
  | "unsupported"
  | "invalid_protocol"
  | "provider_error"
  | "storage_error"
  | "sync_conflict"
  | "cancelled"
  | "unknown";
```

UI 不根据错误字符串猜类型。

---

# 25. Observability

关键对象统一携带：

```text
traceId
taskId
sessionId
deviceId
eventId
```

日志默认不记录：

- 完整消息正文
- API Key
- Pairing Secret
- Device Private Key
- 文件原文
- Memory 原文

---

# 26. 测试层级

逐步建立：

```text
Unit
Runtime
Repository
Protocol
Native Bridge
Integration
E2E
Manual Device Acceptance
```

真机不能完全由 Emulator 替代，尤其：

- Camera
- Microphone
- Push
- Share
- Background
- Bluetooth/NFC（未来）

---

# 27. M0–M9 总路线

```text
M0 Bootstrap
M1 Standalone Chat
M2 Local Memory
M3 Device Identity & Pairing
M4 Mobile Capabilities
M5 Tasks & Approval
M6 Desktop Sync
M7 Share / Voice / Mobile UX
M8 Mobile Extension Runtime
M9 Private Beta
```

---

# 28. M0 — Bootstrap

## TASK-M0-001 — Initialize React Native Project

**Status:** TODO  
**Priority:** P0  
**Depends:** none

Required：

- React Native + TypeScript
- Android / iOS 工程
- typecheck / lint / test
- Android Debug 可启动

Do Not：

- 不做 Chat
- 不做 Desktop Pairing
- 不做插件

Acceptance：

- [ ] Android Debug Build 成功
- [ ] iOS 工程结构完整
- [ ] TypeScript 通过
- [ ] Test runner 可执行

---

## TASK-M0-002 — Create Architecture Skeleton

**Status:** TODO  
**Depends:** TASK-M0-001

建立本文件规定的目录边界与最小 Dependency Wiring。

Acceptance：

- [ ] Runtime / Domain / Data / Native / Protocol 分层存在
- [ ] Feature 不直接依赖 Native 实现
- [ ] 能通过 typecheck

---

## TASK-M0-003 — Error + Logging Foundation

**Status:** TODO  
**Depends:** TASK-M0-002

实现：

- CetaError
- Structured Logger
- traceId
- Secret Redaction

Acceptance：

- [ ] Secret redaction 有测试
- [ ] Runtime 不抛裸字符串错误
- [ ] UI 能展示标准错误

---

## TASK-M0-004 — SQLite Foundation

**Status:** TODO  
**Depends:** TASK-M0-002

实现：

- DB bootstrap
- migration engine
- schema_version
- test DB

Acceptance：

- [ ] 新建 DB 成功
- [ ] Migration 可验证
- [ ] 测试 DB 隔离
- [ ] 不使用 destructive reset 作为升级方案

### Gate M0

```text
Build PASS
Typecheck PASS
Lint PASS
Unit PASS
DB Migration PASS
```

---

# 29. M1 — Standalone Chat

目标：

> 不安装 Desktop、不安装 DSH、不使用 QQ，只配置模型 Provider，即可稳定多轮聊天。

## TASK-M1-001 — Model Provider Interface

建立 ModelProvider / Registry / ModelInfo / ChatRequest / ChatChunk。

支持：

- stream
- abort
- timeout
- provider error

## TASK-M1-002 — Secure Provider Credential

实现 API Secret write/read/delete，必须走 Secure Storage。

## TASK-M1-003 — Chat Session Repository

SQLite：

```text
chat_sessions
chat_messages
```

支持 create / rename / archive / delete / list / pagination。

## TASK-M1-004 — Chat Runtime

实现：

```text
send
stream
cancel
retry
```

## TASK-M1-005 — Chat UI

提供：

- Session List
- New Chat
- Model
- Reasoning
- Mode
- Streaming
- Stop
- Retry

## TASK-M1-006 — Attachment Foundation

支持 Image Picker / File Picker 的安全输入链。

### Gate M1 — Standalone Alpha

- [ ] Fresh install 可用
- [ ] Desktop 不存在仍可用
- [ ] DSH 不存在仍可用
- [ ] API Key 安全保存
- [ ] 多轮聊天
- [ ] Streaming
- [ ] 重启后 Session 保留
- [ ] Model / Reasoning 独立保存
- [ ] Secret 不进入日志或 SQLite

---

# 30. M2 — Local Memory

## TASK-M2-001 — Memory Schema

实现 working / chat / user / task / local，以及 scope / source / importance / confidence / timestamps。

## TASK-M2-002 — Memory Repository

CRUD + Search。第一版使用 metadata / keyword / simple ranking，不急着引入复杂 Vector DB。

## TASK-M2-003 — Memory Runtime

支持 save / search / pin / update / delete。

## TASK-M2-004 — Chat Memory Extraction

```text
conversation
 ↓
candidate memories
 ↓
policy / user confirmation
 ↓
long-term
```

第一版默认保守。

## TASK-M2-005 — Memory UI

Recent / Type Filter / Search / Edit / Delete / Pin / Source。

### Gate M2

- [ ] Chat Memory 可产生
- [ ] 用户能看到系统记住什么
- [ ] 用户能修改和删除
- [ ] Pin 不被自动修改
- [ ] 默认 scope = local-only

---

# 31. M3 — Device Identity & Pairing

## TASK-M3-001 — Device Identity

生成 deviceId + key pair；私钥放 Secure Storage。

## TASK-M3-002 — Protocol Envelope v1

```ts
type ProtocolEnvelope = {
  protocol: "cetamesh";
  version: 1;
  id: string;
  type: string;
  timestamp: string;
  payload: unknown;
};
```

所有 payload 必须 schema validate。

## TASK-M3-003 — QR Pairing Scanner

Camera QR 扫描。

## TASK-M3-004 — Pairing Flow

```text
Scan
Validate
Exchange Key
Confirm
Persist Trust
```

### Gate M3

- [ ] Token 会过期
- [ ] Token 不可重复
- [ ] Device 与 User Identity 分离
- [ ] 私钥不可导出
- [ ] 删除信任后连接失效

---

# 32. M4 — Mobile Capabilities

## TASK-M4-001 — Capability Runtime

```ts
interface CapabilityProvider {
  listCapabilities(): CapabilityDescriptor[];
  invoke(request: CapabilityRequest): Promise<CapabilityResult>;
}
```

## TASK-M4-002 — Capability Policy

支持：

```text
deny
ask
allow-once
```

## TASK-M4-003 — Camera

实现 `camera.capture`。

## TASK-M4-004 — Microphone

实现 `microphone.record`。

## TASK-M4-005 — File / Photos

实现 `file.pick` / `photos.select`。

## TASK-M4-006 — Notification

实现 `notification.send`。

### Gate M4

- [ ] UI 不能绕过 Capability
- [ ] Runtime 不能绕过 Policy
- [ ] 未知 Capability deny
- [ ] OS deny → permission_denied
- [ ] 未实现平台 → unsupported

---

# 33. M5 — Tasks & Approval

## TASK-M5-001 — Task Runtime

实现 list / detail / status / progress / events。

## TASK-M5-002 — Approval Model

最少字段：

```text
approvalId
taskId
requestedBy
capability
target
risk
reason
expiresAt
status
```

## TASK-M5-003 — Approval UI

支持 Reject / Approve Once。

## TASK-M5-004 — Push Foundation

统一 Push Provider，底层分别接 Android / iOS。

### Gate M5

- [ ] Push 能打开正确 Approval
- [ ] 过期审批不可提交
- [ ] response 重放不触发二次执行
- [ ] 高风险信息清晰显示

---

# 34. M6 — Desktop Sync

## TASK-M6-001 — HTTPS Client

支持 auth / timeout / retry / cancellation / certificate error。

## TASK-M6-002 — WebSocket Client

支持 reconnect / backoff / heartbeat / sequence / resume cursor。

## TASK-M6-003 — Sync Queue

```text
pending
sending
acked
failed
```

## TASK-M6-004 — Memory Sync

第一版只做 `my-devices`。

## TASK-M6-005 — Task Sync

Mobile 可查看：

- Desktop Task
- Progress
- Agent Provider
- Session / Context 状态（若协议提供）
- 按权限 Pause / Cancel

### Gate M6

- [ ] Desktop offline 时 Mobile 不崩
- [ ] Mobile offline 事件可恢复
- [ ] Event dedupe
- [ ] Revision conflict 有明确处理
- [ ] 不同步 SQLite 文件

---

# 35. M7 — Share / Voice / Mobile UX

## TASK-M7-001 — Share to CetaMesh

系统分享 URL / Text / Image / File 到 Chat / Memory / Task。

## TASK-M7-002 — Quick Memory

首页 `+ Memory`，先支持 text / photo。

## TASK-M7-003 — Voice Capture

语音输入可进入 Chat / Memory。

## TASK-M7-004 — Background Catch-up

实现 resume sync / push-driven refresh / safe background job。

### Gate M7

- [ ] Share 链路可用
- [ ] Share 失败不丢数据
- [ ] Quick Memory 离线可保存
- [ ] Resume 后状态自动补齐

---

# 36. M8 — Mobile Extension Runtime

第一版只做安全扩展。

## TASK-M8-001 — Declarative Tool Manifest

字段至少：

```text
id
name
version
type
permissions
inputSchema
outputSchema
```

## TASK-M8-002 — Memory Pack Reader

预留 `.cetamemory`，只读数据。

## TASK-M8-003 — Extension Import

```text
validate
hash
permission inspect
install
```

## TASK-M8-004 — Security Report

展示 source / signature / permissions / data access / network access / risk。

### Gate M8

- [ ] 无任意代码执行
- [ ] Memory Pack 不能成为 system instruction
- [ ] 未声明权限无法调用
- [ ] 导入失败不留下半安装状态

---

# 37. M9 — Private Beta

必须完成：

```text
Standalone Chat
Memory
Device Identity
Pairing
Capability
Tasks
Approval
Desktop Sync
Share
Push
Security Baseline
Crash Recovery
```

通过后再邀请少量真实用户测试。

---

# 38. Android-first 策略

Android 可领先实现 M0–M4，但共享接口必须从第一天跨平台。

应该：

```text
Capability
  ├── AndroidCameraProvider
  └── IOSCameraProvider
```

不要：

```text
AndroidCapability
AndroidTask
AndroidMemory
```

---

# 39. iOS 接入 Gate

iOS 不要求与 Android 同速，但在 M4 完成前至少具备：

- App bootstrap
- Secure Storage
- SQLite
- Chat
- Device Identity
- Protocol
- Capability abstraction

否则 Android 实现容易锁死架构。

---

# 40. 第一版明确不做

DEFERRED：

- 在手机本地运行完整 DSH / Codex
- unrestricted shell
- arbitrary-code plugin
- 完整 Marketplace
- Social / QQ
- Workshop 本地开发
- Mobile IDE
- Kubernetes
- 复杂 Vector DB
- 复杂 Memory Graph UI
- 全量 Cloud 同步
- 多 Agent 本地编排
- 支付
- 公共账号体系
- 蓝牙/NFC 深度能力（M4 后另立计划）

---

# 41. Codex 每次任务流程

```text
1. Read this file
2. Read PROJECT_STATE.md
3. Select first unblocked TODO
4. Inspect related code
5. Write short implementation plan
6. Modify only required scope
7. Run specified tests
8. Fix failures
9. Update docs if interface changed
10. Update PROJECT_STATE.md
11. Mark TASK DONE only after verification
```

不得一次执行多个阶段。

---

# 42. PROJECT_STATE.md 推荐格式

```md
# CetaMesh Mobile Project State

Current Phase: M0
Current Gate: M0

Active Task:
- TASK-M0-001

Completed:
- none

Blocked:
- none

Last Verification:
- not run

Known Risks:
- none

Next Task:
- TASK-M0-001
```

Task 状态仅允许：

```text
TODO
IN_PROGRESS
BLOCKED
DONE
DEFERRED
```

`DONE` 必须记录 Verification。

---

# 43. Definition of Done

任一任务完成至少满足：

- Build / 编译通过
- Typecheck 通过
- 相关 Unit Test 通过
- 相关 Integration Test 通过
- Error Path 有覆盖
- Security Boundary 没有被绕过
- 文档同步
- 无 Secret
- 无无关 TODO
- 无无关大范围格式化
- `git diff` 范围符合任务

---

# 44. 推荐统一脚本

项目建立后逐步补齐：

```text
npm run typecheck
npm run lint
npm test
npm run test:unit
npm run test:runtime
npm run test:protocol
npm run test:data
npm run android:debug
npm run android:test
npm run check
```

最终 `npm run check` 应聚合：

```text
typecheck + lint + unit + runtime + protocol + data
```

---

# 45. Protocol 兼容规则

1. 所有 Envelope 带 `version`。
2. 未知字段尽量忽略。
3. 未知事件不得执行副作用。
4. 未知 Capability 必须拒绝。
5. Breaking Change 升 Protocol Version。
6. Database Schema Version 与 Protocol Version 分离。

---

# 46. 三个关键里程碑

## Milestone A — Standalone Alpha

```text
安装 App
↓
配置模型 Provider
↓
创建 Chat
↓
选择 Model / Reasoning
↓
多轮聊天
↓
保存 Session
↓
创建 Memory
↓
重启后全部保留
```

此时不存在 Desktop / DSH / QQ 仍应成立。

## Milestone B — Device Node Alpha

```text
Desktop 显示 QR
↓
Mobile 扫描并绑定
↓
Desktop 请求 Mobile Capability
↓
Mobile Approval
↓
用户同意
↓
返回 Camera / File / Device Result
```

## Milestone C — Private Beta

```text
Standalone Chat
+ Memory
+ Tasks
+ Pairing
+ Approval
+ Share
+ Camera
+ Microphone
+ Desktop Sync
+ Push
```

---

# 47. 最终验收原则

### A. 独立

没有 Desktop 仍能使用基础 Chat / Memory。

### B. 协同

连接 Desktop 后自然加入 Task / Memory / Device Mesh。

### C. 安全

Model / Agent 永远不能绕过 Capability / Permission。

### D. 可扩展

增加 iOS、NFC、Bluetooth、Memory Pack、Remote Plugin 时不需推翻 Runtime。

---

# 48. Codex 首次启动指令

可直接给 Codex：

> 阅读 `CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md`。这是本项目的权威施工文档。  
> 从 `TASK-M0-001` 开始，每次只处理一个满足依赖条件的 TODO。  
> 不跨阶段，不实现 Deferred 功能。  
> 所有原生设备能力必须经过 Capability Runtime，所有持久化必须经过 Repository，所有 Secret 必须进入系统安全存储。  
> Android 优先，但公共接口从第一天保持 iOS 兼容。  
> 每次完成任务后运行规定测试并更新 `PROJECT_STATE.md`；测试失败不得标记 DONE。

---

# 49. M0 完成后最低文档集合

```text
AGENTS.md
PROJECT_STATE.md
CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md

docs/architecture/MOBILE_ARCHITECTURE.md
docs/security/MOBILE_SECURITY.md
docs/protocol/PROTOCOL_V1.md
docs/acceptance/MOBILE_ACCEPTANCE.md
```

其中：

- 本文件负责“下一步做什么、按什么顺序做”。
- `PROJECT_STATE.md` 负责“现在做到哪里”。
- `MOBILE_ARCHITECTURE.md` 只描述“当前已经落地的真实架构”。

不要把未来计划和当前事实混写。

---

# 50. 总施工顺序

```text
M0 Bootstrap
   ↓
M1 Standalone Chat
   ↓
M2 Local Memory
   ↓
M3 Identity + Pairing
   ↓
M4 Mobile Capability
   ↓
M5 Task + Approval
   ↓
M6 Desktop Sync
   ↓
M7 Share + Voice + Background
   ↓
M8 Safe Extension Runtime
   ↓
M9 Private Beta
```

Android 可以领先；iOS 不得被架构性遗忘。Desktop 不因 Mobile 开发暂停。

两端最终通过：

```text
Identity
Task
Memory
Capability
Event
Protocol
```

汇合。

---

# 51. 最终目标架构

```text
                        CetaMesh Ecosystem

             ┌────────────────┴────────────────┐
             │                                 │
      CetaMesh Desktop                  CetaMesh Mobile
             │                                 │
     Desktop Runtime                     Mobile Runtime
             │                                 │
   Agent / Workspace / MCP             Chat / Memory / Task
             │                                 │
        Desktop Capability             Mobile Capability
             │                                 │
             └───────── CetaMesh Protocol ─────┘
                              │
                     Identity / Event
                     Task / Memory
                     Capability / Device
```

**Mobile 与 Desktop 是两个独立发展的 CetaMesh Node。**
