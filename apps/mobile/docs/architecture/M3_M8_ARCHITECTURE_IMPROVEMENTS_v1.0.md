# CetaMesh Mobile 架构改进研究摘要 v1.0

> 日期：2026-09-30
>
> 本文记录 OpenClaw、Mint、AnythingLLM Mobile、OwnOrbit、Argos、Alethe 等公开项目对 CetaMesh Mobile M3～M8 的直接启发。详细跨端研究保存在 Desktop 主仓库的 competitive architecture review 中。

## 1. 结论

以下能力已经不足以单独形成差异：

- Mobile Chat
- Memory
- MCP / Plugins
- Multi-model
- Agent remote control
- Session resume
- Camera / Location tools
- Share Sheet

CetaMesh Mobile 后续重点应是：

```text
Peer Device Mesh
+
Task-owned State
+
Capability Manifest
+
Scope-aware Permission
+
Trusted Sync
+
Mobile-native UX
```

## 2. OpenClaw

值得吸收：

- typed protocol
- role/scope handshake
- capability advertisement
- device pairing
- node diagnostics
- context usage metrics

不照搬：

- Single Gateway owns all state
- Mobile must depend on Gateway

CetaMesh 保持 Independent Node。

## 3. Mint

值得吸收：

- Git checkpoint
- task-isolated branch
- rollback
- verification capabilities
- OS-level sandbox
- explicit approval

这些主要影响 Desktop/Workshop，但 Mobile 需要能显示这些 Task/Approval 状态。

## 4. AnythingLLM Mobile

重要事实：

> 独立 Mobile Runtime、React Native、本地/云模型、Memory、Share、Background Job 已经有成熟公开实现。

因此 CetaMesh Mobile 的差异不能只是“脱离 Desktop 也能聊天”。

后续应强调：

```text
Mobile Task
↕
Desktop Task
↕
Memory
↕
Capability
↕
Agent Provider
```

## 5. OwnOrbit

吸收：

- QR pairing
- reachability diagnostics
- trust state
- transport state
- private-network-first

Devices 页面应区分 Trust 与 Presence。

## 6. Argos / Alethe

Argos 说明 Agent Control Plane / ACP 已出现。

Alethe 说明 Claude Code ↔ Codex Context Packet Handoff 已出现。

所以 CetaMesh 必须坚持：

```text
Task != Session
```

并让 Mobile 展示 Task，而不是绑定具体 Provider Session。

## 7. M3 改进

增加：

- Node Role
- Capability Advertisement
- Trust State
- Transport Metadata
- Reachability / Connection Health
- Device Mesh Protocol Layering

原则：

```text
Pairing establishes trust.
Advertisement describes capability.
Authorization controls invocation.
Transport carries events.
Sync reconciles state.
```

## 8. M4 改进

Capability Descriptor 必须有：

- version
- risk
- platforms
- availability
- approval policy
- provider
- schema version

并生成 Mobile Capability Manifest。

Advertisement 不等于 Permission。

## 9. M5 改进

Mobile 控制的是 CetaMesh Task。

Task 需要 Provider-neutral ExecutionRef。

必须能表示：

```text
Task stays the same.
Provider may change.
Session may change.
```

Approval 绑定 Task + Capability + Scope，不绑定某个 UI Session。

## 10. M6 改进

Trusted Mesh Transport：

- trust re-check
- protocol role
- capability manifest
- object/event sync
- memory scope enforcement
- task sync
- remote capability invocation
- presence/health
- reconciliation

Remote Capability 最终由被调用设备本地 Policy 决策。

## 11. M7 改进

强化真正的 Mobile UX：

- Share to CetaMesh
- Quick Memory
- Voice
- Action Center
- Background Catch-up
- Offline Inbox

不要照搬 Desktop 页面。

## 12. M8 改进

允许：

- declarative tool
- memory pack
- remote plugin
- workflow
- UI extension

禁止：

- arbitrary downloaded code
- unrestricted native bridge
- direct secure storage / raw DB access

所有扩展权限映射到 Capability。

## 13. 五条长期原则

1. A Node may be offline without ceasing to be a CetaMesh Node.
2. A Task may outlive every session that worked on it.
3. Capability is granted to a caller in a scope, never globally implied.
4. Memory retrieval is an authorization decision before it is a ranking problem.
5. Workspace reality outranks agent narrative.

## 14. 实施方式

不重做已完成 M3-001～004。

按照：

```text
M3 CI Recovery
→ M3-005～009
→ M4
→ M5
→ M6
→ M7
→ M8
```

继续开发。

Native Verification 可与 Implementation Track 分离，但 M9 前必须完成 Android 必要真机验收。
