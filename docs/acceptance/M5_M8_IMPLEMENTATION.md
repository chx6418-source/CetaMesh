# CetaMesh Mobile M5–M8 Implementation Acceptance

Status: implementation complete; native and live-peer acceptance pending
environmental execution.

This record covers the approved M3 Device Mesh improvements and M4–M8 work
implemented in the dedicated `cetamesh-mobile` repository. The original
`whalebridge` repository was not modified.

## Delivered scope

| Track | Delivered foundation | Status |
| --- | --- | --- |
| M3-005–009 | Node roles, capability advertisement, trust/transport metadata, bounded health/reachability and mesh handshake validation | DONE |
| M4-001–006 | Capability descriptors/manifest, deny-by-default local policy, audit events, camera/microphone/file/photos/notification routes | DONE for code and automated verification |
| M5-001–008 | Task model v2, stable Task identity, ExecutionRef, event log, approvals, questions/needs-attention, opaque Push payloads, Task and Action Center UI | DONE |
| M6-001–010 | Trusted HTTP/WebSocket ports, handshake checks, durable Sync Queue, scoped Memory sync, metadata-only Task sync, local-policy remote capability, presence and reconciliation | DONE |
| M7-001–007 | Share and Quick Memory local inbox, Voice/Transcription ports, bounded recovery, Action Center and model-source abstraction | DONE |
| M8-001–008 | Declarative/remote extension contracts, untrusted read-only Memory Packs, remote-only plugins, SHA-256 hash/security report, transactional lifecycle, permission diff/re-confirmation, base/overlay isolation | DONE |

## Security gates

- Task identity is independent of Provider and Session. Provider/session changes
  produce events and preserve `taskId`.
- Push accepts only event kind and opaque identifiers; opening a Push reads
  trusted/local state and never trusts Push text as task content.
- Capability grants are matched to request caller, device, task, scope and
  target before a Provider can run. Unknown capabilities default to DENY.
- Memory scope authorization runs before Memory retrieval or conflict
  reconciliation. Default Memory behavior remains Local Only.
- Remote capabilities require trusted peer metadata and are finally routed
  through the local Permission Policy and Capability Runtime.
- Task sync excludes transcripts and raw chat content. Mesh sync does not copy a
  SQLite database file.
- Extensions accept only declarative or remote-contract data. Manifest/package
  validation rejects scripts, code, executables, native modules, shell and
  other executable payload paths. Memory Packs are third-party, untrusted and
  read-only.
- Failed extension persistence rolls back the new or previous record. High-risk
  permission additions require explicit fresh confirmation. Base and
  user-overlay records are isolated by source.
- Logs, audit events and Push payloads carry identifiers and bounded metadata,
  not API keys, tokens, private keys, complete messages, file bodies or Memory
  text.

## Automated verification

The final local repository gate is:

```text
npm run check
```

It runs TypeScript, ESLint, architecture-boundary checks and the in-band Jest
unit suite. The final run result is recorded in `PROJECT_STATE.md` with the
exact suite/test count. Dedicated regression coverage includes:

- Task/approval/event idempotency, expiry, replay and attention aggregation;
- Push redaction and Task-first UI rendering;
- trusted transport bounds, handshake identity/role/version checks and queue
  recovery/dead-letter state;
- Memory scope denial before retrieval, Task metadata-only sync, duplicate /
  stale / conflicting revisions, presence separation and remote capability
  policy denial;
- offline Inbox persistence/restart recovery, Share validation, Voice
  cancellation/provider abstraction and bounded artifacts;
- deterministic Action Center aggregation and bounded catch-up;
- extension schema/code rejection, Memory Pack trust/read-only behavior,
  remote-only plugin transport, SHA-256 content hash, failed-install rollback,
  SQLite migration/reopen, permission escalation and overlay isolation;
- malformed payloads map to CetaError rather than leaking raw TypeError paths.

## Environment limits

The following are not claimed as PASS in this workspace:

- fresh Android Debug APK compilation/install/start for the M5–M8 tree;
- iOS Xcode/CocoaPods compilation or device execution;
- Android/iOS OS permission prompts, physical camera/microphone behavior,
  notification delivery and Push provider delivery;
- a real Desktop/Server peer handshake, live HTTPS/WebSocket sync or
  end-to-end cross-device Memory/Task interoperability.

Existing Android CI/APK static acceptance from the M4 native baseline remains
documented in `PROJECT_STATE.md`. It does not prove device execution or live
peer interoperability. The correct state for unavailable checks is
`NOT_RUN_ENVIRONMENT` or `PENDING_NATIVE_VERIFICATION`.

## Explicitly not implemented

M5–M8 does not add DSH/Codex/Claude Code/Shell Agent execution on Mobile,
unrestricted shell, downloaded code, plugin executable loading, Social,
Marketplace, Cloud account/login, payment, Memory Graph, full Bluetooth/NFC
workflows, complex Push orchestration, or a Desktop dependency for standalone
Chat/Memory/Task use.
