# Agent integration status

Updated: 2026-10-25. This page describes the current Desktop source and verification boundaries. It does not establish general runtime availability or a new signed release.

## Registered providers

| Provider | Current implementation | Availability boundary |
| --- | --- | --- |
| DSH | Existing staged Provider retained | Requires its configured runtime and task authorization |
| Codex | Existing exec transport stays default; App Server adapter added | App Server requires a verified version/schema and native policy; old sessions are not blindly migrated |
| Claude | Optional pinned official SDK resource and supervised Core runner | Real executable/native policy and formal SEA execution remain unverified |
| Gemini CLI | Shared ACP adapter and independent discovery | Exact installed version, launch contract and native policy must be verified |
| OpenCode | Shared ACP adapter and independent discovery | Compatible runtime and native policy must be verified |
| Qwen Code | Shared ACP adapter and independent discovery | Compatible runtime and native policy must be verified |
| ZCode | Protocol presence is recognized; execution unavailable | Exact external control, version, approval and workspace contract unverified |
| WorkBuddy | Fixed-origin, bounded private API client | Real OAuth/account authorization and local Workspace execution remain unavailable |

Registration is not execution permission. The existing Broker/Registry, Owner approvals, Workspace identity and Capability-mediated imports remain authoritative. Staging is a working copy, not an operating-system sandbox.

Desktop-client installation is reported separately from CLI installation and Agent readiness.
Bounded local binary checks and the Claude Windows Store package query identify supported
installation forms; discovery errors remain unknown. Installed clients with unverified
connectors display an installed/pending state. A desktop executable is never launched as
an assumed CLI, and installation evidence does not satisfy protocol, SDK or native-policy gates.

## Protocol and recovery

- JSON-RPC framing is protocol-specific, bounded and UTF-8 strict. Missing real token usage remains unknown.
- Cancellation acknowledgement is distinct from terminal confirmation. Unconfirmed process exit retains ownership and staging for recovery.
- Event replay keeps a rolling bounded history and reports cursor expiry explicitly.
- Native permission requests default to denial without trusted approval. Import approval remains separate.
- New ACP snapshot failures use ACP_STAGING_READ_FAILED. The legacy Codex STAGING_READ_FAILED stop-proof meaning is preserved; restarting into the old default does not release unconfirmed native ownership.
- The optional Claude resource is pinned and hash checked. A future SEA gate requires an explicitly selected artifact with matching source/executable metadata; old release artifacts cannot stand in for the new code.

## Desktop UI included in this source update

The maintained Harbor interface includes the supplied green application mark, compact window chrome, icon navigation with a collapsible workspace list and Memory entry, vertical Settings categories, compact operation history, feedback-link layout, an inline task card, a simpler composer and consistent motion respecting reduced-motion preferences.

## Public repository scope

This update is a reviewed Desktop source snapshot on the existing public main history. Mobile source, current introductions and documentation cleanup remain preserved. Private development history, internal repair reports, raw evidence, old design galleries and restricted SnowLuma SDK/MCP are not imported. Existing OneBot interoperability and public bundle exclusion checks remain intact.

Verification on this public snapshot: 31 selected registered suites returned 30 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT (the explicitly gated new SEA). TypeScript/Vite passed; independent export review found no issues. These are targeted checks, not a new full-suite, Cargo, Mobile or installed-runtime acceptance run. Real Agent accounts, native enforcement, formal new SEA and installed product acceptance remain separate evidence gates. No new Release or installation is implied.
