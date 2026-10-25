# CetaMesh Mobile — Codex 开发工作文档 v1.1

> 2026-09-30 架构改进版。适用仓库：`chx6418-source/cetamesh-mobile`。
>
> M0–M2 沿用 v1.0 和 `PROJECT_STATE.md` 的完成记录；M3–M8 由本文件修订。
> M3-001～M3-004 已完成，不重新开发，只做增量 Device Mesh 强化。
>
> 核心：Mobile 是独立 Node；Task 属于 CetaMesh；Memory 属于 CetaMesh；Capability 必须绑定 Caller + Scope；Android-first；Native 未验证不得伪造 PASS。

---

# Gate 规则

从 M3 起拆为：

- `Mx-I`：Implementation Gate
- `Mx-V`：Native / Device Verification Gate

允许 `M4-I PASS / M4-V PENDING_NATIVE_VERIFICATION` 后继续 M5-I。

M9 Private Beta 前，所有 Android 必要 Native Verification 必须清零。iOS 当前可保持 `ARCHITECTURE_COMPATIBLE / VERIFICATION_DEFERRED`。

---

# M3 — Identity, Pairing & Device Mesh Foundation

现状：M3-001 Device Identity、M3-002 Protocol Envelope、M3-003 QR、M3-004 Pairing 已完成实现/自动测试。不要重做。

## TASK-M3-005 — Node Role Model

增加 Provider-neutral Role：

- `mobile-node`
- `desktop-node`
- `server-node`

预留 `channel-adapter`、`agent-provider`。

Acceptance：
- Role 进入可信设备公共元数据。
- 未知 Role fail-closed / unsupported。
- Role 不替代 Permission。
- 有 Protocol Test。

## TASK-M3-006 — Device Capability Advertisement

Pairing 后设备声明：

- node identity
- node role
- capability id
- capability version
- availability

M3 只声明，不执行 M4 能力。

Acceptance：
- schema validate；
- count/body bounded；
- unknown capability 不自动授权；
- Advertisement != Authorization。

## TASK-M3-007 — Trust / Transport Metadata

设备记录增加：

- `trustState`: trusted / revoked / stale / needs_repair
- `transportType`: lan / private-relay / cloud-relay / unknown
- pairedAt
- lastSeenAt
- peerRole
- endpoint

Trust 与 Presence 必须分离；Last Seen 不参与认证；Metadata 不保存 Secret。

## TASK-M3-008 — Connection Health / Reachability

只读诊断：

- paired
- trusted
- reachable
- lastSeen
- transport
- protocolVersion
- peerRole
- capabilityCount
- lastErrorCode

Reachability 必须 timeout bounded、不能泄密、不能升级 Trust、不能变成 arbitrary URL probe。

## TASK-M3-009 — Device Mesh Protocol Notes

协议文档明确：

`Pairing establishes trust → Advertisement describes capability → Authorization controls invocation → Transport carries events → Sync reconciles state`

五层不得混用。

## Gate M3-I

- M3-001～004 保持通过；
- Role/Advertisement/Trust/Diagnostics 完成；
- Unknown Capability 默认拒绝；
- `npm run check` PASS。

## Gate M3-V

Android：CI assembleDebug、hardware key、QR lifecycle、controlled HTTPS pairing、no retry/replay、real peer pairing。

---

# M4 — Capability Runtime & Mobile Capability Manifest

目标：把 Native API 变成可声明、可授权、可审计的 CetaMesh Capability。

## TASK-M4-001 — Capability Descriptor v1

字段至少：

- id
- version
- risk: low / medium / high / critical
- platforms
- availability
- approvalPolicy: none / ask / allow-once
- providerId
- inputSchemaVersion
- outputSchemaVersion

Unknown Capability 默认 deny。

## TASK-M4-002 — Mobile Capability Manifest

聚合：

`deviceId + role + manifestVersion + capabilities[]`

供本机 UI、Pairing Peer、未来 M6 Sync 使用。

Manifest 不是 Permission Table。

## TASK-M4-003 — Capability Runtime

Request 必须包含：

- requestId
- caller
- taskId?
- deviceId
- capabilityId
- scope
- target?
- expiresAt?

所有 Provider 只能通过 Runtime 调用。

## TASK-M4-004 — Capability Permission Policy

计算至少考虑：

`caller + device + task + capability + scope + target + risk + grant`

结果只允许：

- deny
- ask
- allow-once

第一版不做高风险永久授权。

## TASK-M4-005 — Capability Audit Events

至少：

- requested
- denied
- approval_required
- started
- completed
- failed

Audit 不记录敏感 payload 原文。

## TASK-M4-006～009 — Native Providers

- M4-006 `camera.capture`
- M4-007 `microphone.record`
- M4-008 `file.pick` / `photos.select`
- M4-009 `notification.send`

Camera/Mic 必须支持 permission lifecycle、cancel、foreground/background policy、bounded output、temp cleanup、no implicit upload。

## Gate M4-I

- Manifest 可生成；
- UI/Provider 不能绕过 Runtime/Policy；
- Unknown Capability deny；
- Audit 不泄密；
- unsupported 路径明确；
- `npm run check` PASS。

## Gate M4-V

Android 真机验证 Camera、Mic、Picker、Notification、Permission Denied、Cancel、Background lifecycle。

---

# M5 — Task Runtime, Approval & Agent-neutral Control

目标：Mobile 控制 CetaMesh Task，而不是某个 Agent 私有 Session。

## TASK-M5-001 — Task Model v2

Task 至少包含：

- taskId
- goal
- status
- phase
- progress
- source
- workspaceRef?
- providerExecutionRef?
- checkpointRef?
- revision
- timestamps

Agent Name / Session ID 不得成为 Task 生命周期基础。

## TASK-M5-002 — Provider-neutral ExecutionRef

字段：

- providerId
- executionId
- sessionId?
- state
- contextUsage?

ExecutionRef 是 Task 子资源。

## TASK-M5-003 — Task Event Log

至少：

- task.created
- started
- progress
- blocked
- paused/resumed
- completed/failed/cancelled
- provider_changed
- session_changed

必须能表达“Task 没变，Session 已换”。

## TASK-M5-004 / 005 — Approval Model + Runtime

字段至少：

- approvalId
- taskId
- executionRef?
- requestedBy
- capability
- scope
- target
- risk
- reason
- expiresAt
- status
- nonce/revision

支持 Reject / Approve Once / Expire / Cancel / Replay Reject。

## TASK-M5-006 — Questions / Needs Attention

统一：

- question.required
- approval.required
- task.blocked
- agent.needs_attention

## TASK-M5-007 — Push Foundation

Push 只唤醒/提醒，不承载敏感完整 Task 状态；点击后走可信同步通道取详情。

## TASK-M5-008 — Task / Approval UI

以 Task 为主显示 Progress、Phase、Provider、Session、Context、Approvals、Questions、Artifacts Summary。

## Gate M5-I

- Task 与 Session 分离；
- Provider 切换不改变 Task ID；
- Approval replay 无副作用；
- Expired Approval 不可执行；
- Push 不泄密；
- Needs Attention 可聚合；
- `npm run check` PASS。

---

# M6 — Trusted Device Sync & Mesh Transport

目标：已 Pair 设备组成可信 Mesh，但任何 Node 离线后仍可独立运行。

## TASK-M6-001 — Trusted Transport Bootstrap

建连前验证：

`Device Trust + Protocol Version + Node Role + Current Capability Manifest`

不能只凭 Endpoint。

## TASK-M6-002 — HTTPS Client

支持 auth、timeout、cancel、bounded body、certificate error、安全 redirect、secret redaction。

## TASK-M6-003 — WebSocket Client

支持 reconnect、backoff、heartbeat、sequence、resume cursor、bounded frame、schema validation、trust re-check。

## TASK-M6-004 — Mesh Handshake

交换：

- protocolVersion
- deviceId
- nodeRole
- capabilityManifestVersion
- supportedEventVersions
- syncCursor

## TASK-M6-005 — Sync Queue

状态：

`pending / sending / acked / failed / dead-letter`

必须有 idempotent event ID、retry budget、backoff、持久化、duplicate side-effect protection。

## TASK-M6-006 — Memory Sync v1

第一版只允许 `my-devices`。

Memory 必须验证：

`memoryId + ownerId + scopeType + scopeId + revision + source + policy`

先 Authorization，再 Conflict Resolution。

## TASK-M6-007 — Task Sync v1

同步：

- Task
- Progress / Phase
- ExecutionRef
- Session Change
- Context Usage
- Checkpoint Ref
- Needs Attention
- Artifact Metadata

不把完整 Agent Transcript 当作 Task State。

## TASK-M6-008 — Remote Capability Invocation

`Trusted Node → Capability Request → Local Policy → Approval → Provider → Result`

远端 Advertisement 不能绕过本地 Policy。

## TASK-M6-009 — Device Health / Presence

状态：

`online / offline / degraded / stale / revoked`

Presence != Trust。

## TASK-M6-010 — Conflict / Reconciliation

明确处理 revision conflict、duplicate event、stale update、deleted object、scope change、trust removed during sync。禁止 silent overwrite。

## Gate M6-I

- Desktop offline 时 Mobile 独立；
- Trust removed 后 Transport 失效；
- Unknown Event 无副作用；
- Event dedupe；
- Memory scope enforcement；
- Task provider/session changes 可表达；
- Remote Capability 走本地 Policy；
- 不同步 SQLite 文件；
- `npm run check` PASS。

## Gate M6-V

真实 Desktop Peer E2E：pairing、handshake、reconnect、memory sync、task sync、approval、remote capability、revoke trust。

---

# M7 — Mobile-native UX, Share, Voice & Background

目标：发挥手机随身入口和传感器能力，不做 Desktop 缩小版。

## TASK-M7-001 — Share to CetaMesh

URL / Text / Image / File → Chat / Memory / Task Inbox。

失败必须本地安全暂存，不丢输入。

## TASK-M7-002 — Quick Memory

首页 `+ Memory` 支持 text / photo / voice note，默认 local-only。

## TASK-M7-003 — Voice Capture

语音进入 Chat / Memory / Task Note；转写走 Provider Abstraction，不要求本地 ASR。

## TASK-M7-004 — Mobile Action Center

统一展示：

- Approval
- Question
- Task Blocked
- Task Completed
- Security Event

## TASK-M7-005 — Background Catch-up

实现 app resume sync、push-driven refresh、bounded background work、interrupted queue recovery。不得假设长期后台 WebSocket。

## TASK-M7-006 — Offline Inbox

Share / Quick Memory / Task Note 离线进入 Local Inbox，用户可见 Pending，可在策略允许时同步。

## TASK-M7-007 — Model Source Abstraction Preparation

只预留：

- cloud
- desktop-node
- local-network
- on-device

本阶段不实现 GGUF。

## Gate M7-I

- Share 失败不丢数据；
- Quick Memory offline 可用；
- Voice cancel 正确；
- Action Center 聚合事项；
- Resume 恢复 Sync Queue；
- App 被杀后 Pending Inbox 可恢复；
- `npm run check` PASS。

---

# M8 — Safe Mobile Extension Runtime

目标：扩展生态，但不允许手机任意下载代码执行。

## TASK-M8-001 — Extension Manifest v1

字段至少：

- id / name / version / type / publisher
- platforms / runtime
- permissions / capabilities
- networkAccess
- inputSchema / outputSchema
- minimumProtocolVersion

Type：

- declarative-tool
- memory-pack
- remote-plugin
- workflow
- ui-extension

不支持 arbitrary-code plugin。

## TASK-M8-002 — Extension Permission Model

所有权限映射到 Capability。

Extension 不得直接获得 Native Module、SQLite Handle、Secure Storage、Raw WebSocket、Unrestricted Filesystem。

## TASK-M8-003 — Memory Pack Reader

`.cetamemory` 包含 manifest、memories、entities、relations、license、signature metadata。

第三方 Pack：

- origin = third_party
- trust = untrusted

不得成为 System Instruction、执行代码或自动跨 Scope 写用户 Memory。

## TASK-M8-004 — Remote Plugin Contract

逻辑运行 Desktop / Server；Mobile 只负责 schema UI、capability mediation、task/event transport。

## TASK-M8-005 — Import Transaction

流程：

`validate → hash → publisher metadata → permission inspect → compatibility check → security report → install transaction`

失败必须 rollback。

## TASK-M8-006 — Security Report

展示 source、publisher、signature state、permissions、capabilities、data scope、network access、platform support、risk。

## TASK-M8-007 — Update / Permission Diff

更新时比较旧/新权限；新增高风险权限必须重新确认。

## TASK-M8-008 — Extension Lifecycle

支持 install / enable / disable / update / rollback / remove。用户 Overlay 与 Base Package 分离。

## Gate M8-I

- 无 arbitrary-code execution；
- 未声明权限不能调用；
- Extension 不能绕过 Capability Runtime；
- Memory Pack 不能成为 system instruction；
- Remote Plugin 不能直接获得 native bridge；
- Import failure rollback；
- Permission escalation 重新确认；
- `npm run check` PASS。

---

# 当前推荐施工顺序

1. M3 Android CI Recovery
2. M3-005 Node Role
3. M3-006 Capability Advertisement
4. M3-007 Trust / Transport Metadata
5. M3-008 Health / Reachability
6. M3-009 Protocol Notes
7. M4 Capability Descriptor / Manifest / Policy
8. M4 Native Providers
9. M5 Task / Approval / Needs Attention
10. M6 Trusted Sync / Mesh Transport
11. M7 Mobile-native UX
12. M8 Safe Extension Runtime

不要重新执行 M3-001～004。

---

# Codex 补充规则

1. `PROJECT_STATE.md` 是真实完成状态。
2. 本文件是 M3～M8 的目标与顺序。
3. 新任务不得把已完成 M3-001～004 改回 TODO。
4. 每个 TASK 独立实现、测试、更新状态。
5. Native 未验证必须记录，但不阻止后续 Implementation Track。
6. Advertisement != Permission。
7. Trust != Presence。
8. Session != Task。
9. Memory Search 之前先 Scope Authorization。
10. Remote Capability 最终由被调用设备本地 Policy 决策。

---

# 与 Desktop 的协调点

未来协议只需要协调：

- Node Role
- Capability Advertisement / Manifest
- Trusted Handshake
- Task Event
- Memory Sync
- Approval
- Remote Capability
- Device Presence

Mobile 不等待 Desktop 实现完成。先 Schema + Mock Peer + Automated Test，再做真实 E2E。

---

# 仍然 Deferred

- Mobile 本地 DSH/Codex
- unrestricted shell
- arbitrary downloaded JS/plugin
- Marketplace
- Social / QQ
- Workshop 本地开发
- Mobile IDE
- complex Memory Graph
- full cloud account system
- NFC / Bluetooth 深度能力
- on-device GGUF model
