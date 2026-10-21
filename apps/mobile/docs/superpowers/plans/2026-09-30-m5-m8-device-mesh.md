# CetaMesh Mobile M5–M8 Device Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the v1.1 M5–M8 implementation track on top of the existing M0–M4 mobile foundation, while preserving independent-node operation and the security boundaries that forbid arbitrary code execution.

**Architecture:** Use feature-oriented Clean Architecture with a local-first SQLite object/event store. Domain contracts and protocol schemas stay React-Native-independent; runtimes own orchestration; repositories/providers own persistence and transport; UI consumes runtimes only. Native and remote capabilities are mediated by the existing Capability Runtime and local Permission Policy.

**Tech Stack:** React Native 0.87 New Architecture, TypeScript, SQLite/Nitro SQLite with Node SQLite test adapters, Kotlin/Swift provider boundaries, HTTPS/WebSocket ports, Jest, ESLint, TypeScript.

**Spec:** `docs/roadmap/CETAMESH_MOBILE_CODEX_WORKPLAN_v1.1.md` and `docs/architecture/M3_M8_ARCHITECTURE_IMPROVEMENTS_v1.0.md`.

## Global Constraints

- `PROJECT_STATE.md` is the source of truth for completed, blocked, and pending work.
- Process one `TASK-ID` at a time; do not implement Deferred functionality early.
- Mobile remains an independent Node and must work while Desktop is offline.
- Advertisement never grants permission; unknown capabilities default to DENY.
- Trust and presence are separate; reachability and last-seen data never authenticate a peer.
- Task state is CetaMesh-owned; Provider and Session are replaceable Task subresources.
- Memory scope authorization happens before retrieval, ranking, or synchronization.
- Remote Capability requests are finally authorized by the device executing the capability.
- Secrets/private keys use secure storage and never ordinary SQLite or logs.
- M8 extensions are declarative or remote-contract data only; no downloaded JS, executable, unrestricted shell, or unrestricted native bridge.
- Unexecuted native/device checks are recorded as `NOT_RUN_ENVIRONMENT` or `PENDING_NATIVE_VERIFICATION`, never PASS.

## Review Focus

- A stale or reachable peer must not become trusted: covered by Device Mesh metadata and transport tests.
- A replayed, expired, cancelled, or already-consumed approval must not invoke a provider: covered by Approval Runtime tests.
- An event or sync object with an unknown type, wrong scope, stale revision, or duplicate id must have no unsafe side effect: covered by protocol/sync/reconciliation tests.
- Offline share/voice/memory input must survive process restart without implicit upload: covered by Offline Inbox persistence and recovery tests.
- An extension with undeclared permissions, a changed high-risk permission, malformed pack, or failed install must not execute or partially install: covered by extension validation/transaction tests.

### Task 1: Device Mesh v1.1 foundation (M3-005–M3-009)

**Files:**
- Create: `src/domain/device/NodeRole.ts`, `src/domain/device/DeviceCapabilityAdvertisement.ts`, `src/domain/device/DeviceHealth.ts`
- Modify: `src/domain/device/DeviceTrust.ts`, `src/protocol/ProtocolEnvelope.ts`, `src/data/migrations/AppMigrations.ts`, `src/data/repositories/SqliteTrustRepository.ts`
- Create: `src/protocol/DeviceMeshProtocol.ts`, `src/runtime/identity/DeviceMeshRuntime.ts`, `src/test/device-mesh-protocol.test.ts`, `src/test/device-health.test.ts`
- Modify: `scripts/check-architecture-boundaries.cjs`, `src/test/architecture-boundaries.test.ts`

**Interfaces:**
- Produces validated `NodeRole`, `CapabilityAdvertisement`, `CapabilityManifest`, `TrustMetadata`, `DeviceHealth`, and bounded handshake payloads for M4/M6.
- `DeviceMeshRuntime.getHealth(deviceId)` is read-only and never changes trust or probes arbitrary URLs.

- [ ] Write RED tests for role fail-closed validation, bounded advertisement, trust/presence separation, and bounded health diagnostics.
- [ ] Implement protocol-neutral validators and additive trust metadata migration; preserve M3-001–004 pairing behavior.
- [ ] Run targeted tests and `npm run check`; commit `feat(m3): add node mesh metadata and health foundation`.

### Task 2: Capability Descriptor, Manifest, Policy, and Audit (M4-001–M4-005)

**Files:**
- Modify: `src/domain/capability/Capability.ts`, `src/runtime/capability/CapabilityRouterRuntime.ts`, `src/security/CapabilityPolicy.ts`, `src/app/bootstrap/assembleServices.ts`, `src/app/bootstrap/createServices.ts`
- Create: `src/domain/capability/CapabilityManifest.ts`, `src/domain/capability/CapabilityAudit.ts`, `src/runtime/capability/CapabilityManifestRuntime.ts`, `src/test/capability-manifest.test.ts`, `src/test/capability-audit.test.ts`

**Interfaces:**
- `CapabilityDescriptor` includes risk, availability, approval policy, provider id, and input/output schema versions while retaining existing providers.
- `CapabilityRequest` carries caller, device, task, scope, target, and expiry metadata.
- `CapabilityAuditSink.record(event)` receives IDs and redacted metadata only.

- [ ] Write RED tests for manifest aggregation, unknown deny, caller/scope policy decisions, and audit payload redaction.
- [ ] Implement additive descriptor/policy/runtime changes and wire audit emission without allowing Feature/Provider bypasses.
- [ ] Run `npm run check`; commit `feat(m4): add capability manifest policy and audit contracts`.

### Task 3: Task model, ExecutionRef, event log, approvals, and needs attention (M5-001–M5-006)

**Files:**
- Create: `src/domain/task/Task.ts`, `src/domain/task/ExecutionRef.ts`, `src/domain/task/TaskEvent.ts`, `src/domain/task/Approval.ts`, `src/domain/task/NeedsAttention.ts`
- Create: `src/data/repositories/SqliteTaskRepository.ts`, `src/data/repositories/SqliteApprovalRepository.ts`, `src/runtime/task/TaskRuntime.ts`, `src/runtime/task/ApprovalRuntime.ts`, `src/runtime/event/EventLogRuntime.ts`
- Modify: `src/data/migrations/AppMigrations.ts`, `src/domain/task/index.ts`, `src/runtime/task/index.ts`, `src/runtime/event/index.ts`, `src/runtime/session/MobileServices.ts`, `src/app/bootstrap/assembleServices.ts`
- Create: `src/test/task-runtime.test.ts`, `src/test/approval-runtime.test.ts`, `src/test/task-repository.test.ts`

**Interfaces:**
- `TaskRuntime.create/update/appendEvent/get/list` preserves `taskId` across provider/session changes.
- `ApprovalRuntime.request/decide/expire/cancel/replay` supports `deny`, `approve-once`, `expired`, and `cancelled`; a consumed nonce/revision is idempotent.
- Repository data is SQLite-backed and survives close/reopen.

- [ ] Write RED tests for Task-first lifecycle, provider/session replacement, event idempotency, approval expiry/replay, and attention aggregation.
- [ ] Implement migrations, repositories, runtimes, and composition.
- [ ] Run targeted tests and `npm run check`; commit `feat(m5): add task and approval runtimes`.

### Task 4: Push foundation and Task/Approval UI (M5-007–M5-008)

**Files:**
- Modify: `src/providers/push/index.ts`, `src/runtime/session/MobileServices.ts`, `src/app/bootstrap/assembleServices.ts`
- Create: `src/runtime/task/PushAttentionRuntime.ts`, `src/features/tasks/TaskScreen.tsx`, `src/features/approvals/ActionCenterScreen.tsx`, `src/test/task-ui.test.tsx`, `src/test/push-foundation.test.ts`
- Modify: `src/app/bootstrap/MobileApp.tsx`, `src/app/bootstrap/AppBootstrap.tsx`, `src/features/tasks/index.ts`, `src/features/approvals/index.ts`

**Interfaces:**
- Push payloads contain only opaque IDs and event kind; `PushAttentionRuntime.open()` fetches trusted/local details.
- UI renders Task progress/phase/provider/session/context/approvals/questions/artifact metadata through service ports.

- [ ] Write RED tests for push redaction, task-focused rendering, action aggregation, and no direct provider/native imports.
- [ ] Implement minimal clean UI and push port; do not introduce a global store.
- [ ] Run `npm run check`; commit `feat(m5): add task attention surfaces`.

### Task 5: Trusted transport and handshake (M6-001–M6-005)

**Files:**
- Create: `src/providers/network/TrustedHttpClient.ts`, `src/providers/network/WebSocketClient.ts`, `src/providers/desktop/MeshHandshakeProvider.ts`, `src/runtime/sync/TrustedTransportRuntime.ts`, `src/runtime/sync/SyncQueueRuntime.ts`
- Modify: `src/domain/device/DeviceTrust.ts`, `src/protocol/DeviceMeshProtocol.ts`, `src/data/migrations/AppMigrations.ts`, `src/runtime/sync/index.ts`, `src/app/bootstrap/assembleServices.ts`
- Create: `src/test/trusted-transport.test.ts`, `src/test/sync-queue.test.ts`

**Interfaces:**
- Transport bootstrap requires trusted device, protocol version, peer role, and current manifest version before connection.
- `SyncQueueRuntime.enqueue/next/ack/fail/deadLetter` persists idempotent event IDs and bounded retry/backoff state.
- HTTP/WebSocket implementations expose platform-neutral ports; no raw SQLite-file sync.

- [ ] Write RED tests for trust re-check, body/frame bounds, timeout/cancel, safe redirect, reconnect/backoff, resume cursor, and queue state transitions.
- [ ] Implement ports/providers and durable queue migration with secret-safe logging.
- [ ] Run `npm run check`; commit `feat(m6): add trusted transport and sync queue`.

### Task 6: Mesh sync, remote capability, health, and reconciliation (M6-006–M6-010)

**Files:**
- Create: `src/runtime/sync/MemorySyncRuntime.ts`, `src/runtime/sync/TaskSyncRuntime.ts`, `src/runtime/sync/ReconciliationRuntime.ts`, `src/runtime/capability/RemoteCapabilityRuntime.ts`, `src/domain/sync/SyncObject.ts`, `src/domain/sync/index.ts`
- Modify: `src/runtime/sync/index.ts`, `src/runtime/capability/CapabilityRuntime.ts`, `src/security/CapabilityPolicy.ts`, `src/data/repositories/SqliteMemoryRepository.ts`, `src/data/repositories/SqliteTaskRepository.ts`
- Create: `src/test/sync-reconciliation.test.ts`, `src/test/remote-capability.test.ts`

**Interfaces:**
- Memory sync accepts only `my-devices` and authorizes scope before conflict resolution.
- Task sync transfers task/progress/phase/ExecutionRef/session-change/context/checkpoint/attention/artifact metadata, not transcripts.
- Remote invocation goes trusted node → local policy → optional approval → local provider; unknown events are no-op errors.

- [ ] Write RED tests for scope denial, duplicate events, stale revisions, deleted objects, trust removal, provider/session changes, and remote policy denial.
- [ ] Implement bounded event/object codecs, reconciliation, health/presence states, and local-policy invocation.
- [ ] Run `npm run check`; commit `feat(m6): add scoped mesh sync and reconciliation`.

### Task 7: Share, Quick Memory, Voice, and Offline Inbox (M7-001–M7-003, M7-006–M7-007)

**Files:**
- Create: `src/domain/inbox/InboxItem.ts`, `src/domain/inbox/ShareIngress.ts`, `src/domain/voice/VoiceCapture.ts`, `src/providers/voice/index.ts`, `src/runtime/inbox/OfflineInboxRuntime.ts`, `src/runtime/voice/VoiceRuntime.ts`
- Modify: `src/native/share/index.ts`, `src/native/microphone/MicrophoneRecordProvider.ts`, `src/data/migrations/AppMigrations.ts`, `src/runtime/session/MobileServices.ts`, `src/app/bootstrap/assembleServices.ts`
- Create: `src/test/offline-inbox.test.ts`, `src/test/voice-runtime.test.ts`, `src/test/share-ingress.test.ts`

**Interfaces:**
- `OfflineInboxRuntime.accept/retry/fail/list` persists URL/text/image/file references and never drops failed input.
- Voice is a bounded foreground capability producing an audio artifact; transcription uses a provider abstraction and can be cancelled.
- Model source abstraction exposes `cloud`, `desktop-node`, `local-network`, and `on-device` without implementing GGUF.

- [ ] Write RED tests for offline restart recovery, local-only Quick Memory, share validation, voice cancellation, bounded artifacts, and no implicit upload.
- [ ] Implement runtime/provider boundaries and migration; reuse Capability Runtime for microphone/file/photo access.
- [ ] Run `npm run check`; commit `feat(m7): add mobile-native inbox and voice foundations`.

### Task 8: Action Center and bounded background catch-up (M7-004–M7-005)

**Files:**
- Create: `src/runtime/event/ActionCenterRuntime.ts`, `src/runtime/sync/BackgroundCatchupRuntime.ts`, `src/test/action-center.test.ts`, `src/test/background-catchup.test.ts`
- Modify: `src/features/approvals/ActionCenterScreen.tsx`, `src/features/home/index.ts`, `src/app/bootstrap/assembleServices.ts`, `src/runtime/session/MobileServices.ts`

**Interfaces:**
- Action Center aggregates approvals, questions, blocked/completed tasks, and security events with stable IDs.
- Background catch-up runs only bounded resume/push-triggered work and resumes persisted Sync Queue/Inbox; it never assumes a permanent background WebSocket or recording session.

- [ ] Write RED tests for deterministic aggregation, deduplication, resume recovery, and bounded work budget.
- [ ] Implement runtime and UI integration.
- [ ] Run `npm run check`; commit `feat(m7): add action center and catch-up runtime`.

### Task 9: Safe extension contracts and Memory Pack reader (M8-001–M8-004)

**Files:**
- Create: `src/domain/extension/ExtensionManifest.ts`, `src/domain/extension/ExtensionPermission.ts`, `src/domain/extension/MemoryPack.ts`, `src/domain/extension/RemotePlugin.ts`, `src/domain/extension/Workflow.ts`, `src/domain/extension/index.ts`
- Create: `src/runtime/extension/ExtensionValidationRuntime.ts`, `src/runtime/extension/MemoryPackReader.ts`, `src/runtime/extension/RemotePluginRuntime.ts`
- Create: `src/test/extension-validation.test.ts`, `src/test/memory-pack.test.ts`, `src/test/remote-plugin.test.ts`

**Interfaces:**
- Manifest supports the five v1.1 types and rejects arbitrary-code/runtime values.
- Permissions map only to known capabilities; extension code never receives native, DB, secure-storage, raw WebSocket, or unrestricted filesystem handles.
- `.cetamemory` parsing is bounded, third-party untrusted, read-only, and never system instruction or implicit cross-scope write.

- [ ] Write RED tests for schema bounds, unknown permissions, code/executable rejection, pack trust, and remote-only execution.
- [ ] Implement pure validators/readers and capability mapping.
- [ ] Run `npm run check`; commit `feat(m8): add safe extension contracts`.

### Task 10: Transactional extension lifecycle and security report (M8-005–M8-008)

**Files:**
- Create: `src/domain/extension/SecurityReport.ts`, `src/domain/extension/ExtensionRepository.ts`, `src/runtime/extension/ExtensionInstallRuntime.ts`, `src/runtime/extension/ExtensionLifecycleRuntime.ts`, `src/data/repositories/SqliteExtensionRepository.ts`
- Modify: `src/data/migrations/AppMigrations.ts`, `src/runtime/extension/index.ts`, `src/app/bootstrap/assembleServices.ts`
- Create: `src/test/extension-install.test.ts`, `src/test/extension-lifecycle.test.ts`

**Interfaces:**
- Install flow is validate → hash → publisher metadata → permission inspect → compatibility → security report → transactional install; any failure rolls back.
- Update permission diff marks new high-risk permissions as requiring fresh confirmation.
- Lifecycle supports install/enable/disable/update/rollback/remove and separates base package from user overlay.

- [ ] Write RED tests for rollback, hash/metadata report, permission escalation, state transitions, and overlay isolation.
- [ ] Implement repository/runtime with no executable payload path.
- [ ] Run `npm run check`; commit `feat(m8): add transactional extension lifecycle`.

### Task 11: Integration gate and state documentation

**Files:**
- Modify: `PROJECT_STATE.md`, `AGENTS.md`, `README.md`, `docs/acceptance/M5_M8_IMPLEMENTATION.md`, `docs/architecture/MOBILE_ARCHITECTURE.md`
- Create: `src/test/m5-m8-gates.test.ts`

- [ ] Run targeted regression tests, `npm run check`, Android CI-compatible checks, and JS bundles where available.
- [ ] Record each TASK-ID, exact commands/results, native and peer checks as pending where environment cannot run them, and all Deferred items.
- [ ] Run a final read-only architecture/security review; commit `docs: record M5-M8 implementation gates`.

