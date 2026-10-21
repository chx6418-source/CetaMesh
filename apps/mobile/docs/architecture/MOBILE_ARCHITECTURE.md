# CetaMesh Mobile — Architecture Record

Current implemented phase: M8. This record covers the M0–M8 foundation. The
phase-specific records remain useful for detail: [M4 Capability Runtime](M4_CAPABILITY_RUNTIME.md),
[M3 Identity/Pairing](M3_IDENTITY_PAIRING.md), [M2 Local Memory](M2_LOCAL_MEMORY.md)
and [M1 Standalone Chat](M1_STANDALONE_CHAT.md). The M5–M8 implementation and
verification record is [M5_M8_IMPLEMENTATION.md](../acceptance/M5_M8_IMPLEMENTATION.md).

This document records implemented contracts, not future Agent, Marketplace,
Social or Cloud functionality. Deferred features remain deferred.

## Dependency direction

```text
Feature
  ↓
Runtime interface
  ↓
Domain / Provider / Repository boundary
  ↓
Infrastructure and platform implementation
```

Feature code receives service/runtime ports and can use `CapabilityRuntime`. It
does not import concrete Android or iOS providers. Runtime code does not bind
to SQLite, transport providers or UI; protocol and domain contracts remain
React Native-independent.

## Current boundaries

- `src/app/` owns composition, bootstrap and navigation; it is the only place
  that assembles concrete providers and repositories.
- `src/features/` renders UI through Runtime/service ports. It does not import
  `src/native`, `src/data` or concrete providers.
- `src/runtime/` owns Session, Chat, Task, Event, Memory, Capability, Identity,
  Sync, Inbox, Voice and Extension orchestration. Runtime interfaces keep
  Provider, Repository and Native implementations replaceable.
- `src/domain/` contains platform-independent Task, Memory, Device, Capability,
  Sync, Model, Inbox, Voice and Extension contracts.
- `src/providers/` contains network, model, push, voice and Desktop/mesh ports;
  HTTPS/WebSocket implementations are bounded and trust-aware.
- `src/native/` contains Kotlin/Swift capability providers and New Architecture
  adapters. UI and Model code never call Android/iOS APIs directly.
- `src/data/` contains the SQLite adapter, schema version and additive
  migrations. M5–M8 state is durable in SQLite: Tasks, events, approvals,
  Sync Queue, mesh objects, Offline Inbox and installed extension metadata.
- `src/protocol/` contains the platform-independent CetaMesh envelope, pairing
  and Device Mesh validators; it is independent of React Native and providers.
- `src/security/` contains secure-storage and local Permission Policy ports.
  API keys/private keys are references or secure-store values, never ordinary
  business rows.
- `src/shared/` contains CetaError, structured logging, redaction and utility
  contracts.

## M5–M8 runtime boundaries

- Task is CetaMesh-owned. `ExecutionRef` carries replaceable Provider/Session
  metadata; changing either never changes `taskId`.
- Push contains opaque IDs only. Opening a Push event reads local/trusted state.
- Memory sync accepts only explicitly authorized `my-devices` objects and
  authorizes scope before retrieval or reconciliation. Task sync carries state,
  attention and artifact metadata, never chat transcripts.
- Trusted transport requires active trust, matching peer identity/role/protocol
  and capability-manifest version. Presence/reachability never grants trust.
- Remote Capability goes through trust → local Permission Policy → optional
  approval → local Capability Runtime → Native Provider.
- Share, Quick Memory and Voice first land in a durable local-only Offline
  Inbox. Background catch-up is bounded and never starts a permanent WebSocket
  or recording session.
- Extensions are declarative or remote-contract data. Manifest validation,
  permission inspection, content hashing, security report and transactional
  lifecycle run before installation. Base packages and user overlays use
  separate records.

## Cross-phase constraints

- The mobile app starts without Desktop, DSH, QQ, or any external chat platform.
- No UI, Model, Task or Extension module directly calls native system APIs.
- Unknown capabilities default to DENY and every capability invocation is
  policy/audit mediated.
- No boundary provides unrestricted shell, dynamic code execution, downloaded
  JavaScript, executable plugins or unrestricted native bridges.
- Memory is Local Only unless the user explicitly authorizes the supported mesh
  scope. Secrets are redacted from logs and Push/protocol metadata.
- Future platform differences belong in Kotlin/Swift providers behind the
  public capability interface; iOS is not a rewrite target.
