# M4.4 Channel Runtime Implementation Plan

**Goal:** Transfer QQ transport to a Core-managed optional Connector and make inbound delivery and outbound authorization authoritative in Core.

**Architecture:** Core Channel Service owns durable delivery records and independent consumer acknowledgements, using the existing Storage Primitive and UI notification mechanism. A child launched from the same SEA executable exposes a bounded stdio Channel protocol, without Owner credentials. Existing QQ Runtime retains transport, leases and send ledger. Bionic owns policy lifecycle through a Channel facade; Legacy-exclusive remains mutually exclusive.

**Spec:** Owner M4.4 request and WHALEBRIDGE_DECOUPLING_M4_3_REPORT.md.

## Constraints

No real user data migration, configuration overwrite, new Core/Task/Memory/Broker, permission relaxation, push or publication. Unknown effects require reconciliation. Legacy Social ownership may remain blocked only at a documented data ownership boundary.

## Tasks

- [x] Add production Channel delivery tests: durable ingress, identity validation, three independent consumers, failure isolation and restart uncertainty. Implement these in Channel Service with bounded durable journal and trusted consumer registration.
- [x] Add Connector protocol and lifecycle tests before implementation. Use inherited stdio with bounded frames, command whitelist, single child, actual health, orderly stop and EOF cleanup. Add SEA mode and test it without system Node or repository resources.
- [x] Bind all QQ media actions to a Core Capability entry. Retain final Runtime policy, account identity and send ledger checks. Verify unauthorized/approval/allowlist/lease failures before gateway IO.
- [x] Transfer Social execution to a Bionic lifecycle using a Channel facade and existing policy; retain one social writer and legacy data formats. If actual ownership requires migration, implement the safe gate and document the exact boundary.
- [x] Run npm test, Core/UI builds, desktop check/test/build, release packaging and RC verification. Increment Build, commit source before packaging, then commit evidence report. Final npm: 112 PASS / 0 FAIL / 7 environment skips; Rust: 198 PASS; Release: 9 PASS; packaged SEA Channel: 1 PASS. Build 1081 sourceCommit bb6343483d04c65cd88104c9e9c76d23df656afb. Real QQ E2E remains pending.

## Review focus

Connector stdout is an untrusted external event source, never an Owner command. Stale child messages must be rejected. In-flight consumer work at restart is uncertain. A crash after send can never permit an automatic resend. Stop cannot release a live sender lease prematurely. Existing user social data cannot be silently reset or rewritten under a second writer.
