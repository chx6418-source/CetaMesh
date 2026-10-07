# CetaMesh Desktop Session 3 Implementation Plan

> Required sub-skill: superpowers:executing-plans. This plan follows the user-provided Session 3 specification.

**Goal:** Separate Core service composition and IPC dispatch from the legacy QQ runtime, isolate DSH lifecycle, close audits and documentation, and verify the Release Candidate.

**Architecture:** Move existing service construction into a plain JavaScript container and wire the existing worker entry to an object-based IPC runtime. Keep domain behavior and IPC framing unchanged. Isolate DSH health polling in a provider lifecycle, and move only the SnowLuma client connection/base transport behind a thin QQ adapter.

**Tech stack:** Node.js ESM, the repository's unified test runner, Rust/Cargo, native desktop release scripts.

**Spec:** The user-provided CetaMesh Desktop Technical Debt Consolidation Plan, Session 3, in this task.

## Global constraints

- Branch refactor/core-composition-v1 begins at local main aaff6bf490c95f77e64aed3ebef61f8dbdeb6fba.
- Follow Extract → Wire → Test → Remove duplicate wiring. Do not do a Big Bang rewrite or add a DI framework.
- Core construction must not import bridge.js or require QQ, OneBot, SnowLuma readiness, Social runtime, or DSH readiness.
- Preserve IPC protocol and existing method families. Do not do D8 branding work.
- Register every new scripts/test-*.mjs in scripts/run-all-tests.mjs; use npm test as the supported suite entry.
- Do not push. Merge only after owner confirmation, then delete the work branch.
- Preserve plugins/whale-mode-console and tracked history.

## Execution status

- Tasks 1–6 are implemented on the work branch. The D6 audit found no prototype files from the listed paths in the active tree; D9 found no production `unwrap`/`expect` in the audited user-controlled flows.
- `npm test` passes 65 suites with 0 failures; 8 environment suites are not run. `desktop:check` passes and `desktop:test` passes 109 tests. The requested focused suites passed.
- Task 7 remains open until the clean-tree Core, Desktop Release, Release package, and Release Candidate commands finish.

## Review focus

- Core construction succeeds without DSH or QQ and does not start external providers.
- A DSH outage leaves Model Chat, Task, Memory, Workspace, Extension, Workshop, IPC and Desktop available.
- IPC methods keep their existing target service, privilege and error behavior.
- DSH start/stop is idempotent, clears and unreferences its timer, and reports the five required states.
- User-controlled installer/migration paths return errors instead of panicking.
- Native Release continues to reject connections to 127.0.0.1:3100.

## Task 1 — Core Service Container

Create src/app/service-container.js, src/app/bootstrap.js and scripts/test-service-container.mjs; update src/agent/service.js, src/bridge.js and scripts/run-all-tests.mjs.

- Add and register a failing test that constructs Core services in an isolated state directory without a DSH API, and checks Model/Chat/Task/Memory/Workspace/Capability/Extension/Workshop services exist without probing a provider.
- Move the existing constructors in dependency order into createCetaMeshServices(options = {}). Make DSH Agent Provider registration optional when no DSH API is injected.
- Wire the existing bridge entry through bootstrap and destructure its service object; keep legacy handlers and Core service behavior unchanged.
- Run focused Core/service tests. Commit refactor(core): extract service composition root.

## Task 2 — Desktop IPC Runtime

Create src/app/ipc-runtime.js and scripts/test-ipc-runtime.mjs; update src/bridge.js and scripts/run-all-tests.mjs.

- Test every existing method family, params forwarding, special execute/executeOwner/executeMemory calls, and control fallback with PRIVILEGE_CONSOLE; verify red before implementation.
- Move dispatch and UI pipe setup out of bridge.js into createDesktopIpcRuntime({ services, system, log }); preserve pipe protocol, pipe name, 16-connection limit and error behavior.
- Replace positional service arguments with services/system objects. Run protocol, workspace IPC, desktop architecture and control tests.
- Commit refactor(ipc): extract desktop ipc runtime.

## Task 3 — DSH Provider Lifecycle

Create src/providers/dsh/lifecycle.js and scripts/test-dsh-lifecycle.mjs; update src/bridge.js and scripts/run-all-tests.mjs.

- Test unknown/ready/unavailable/recovering/stopped, refresh notifications, idempotent start, stop/clear, default 5000 ms interval, timer unref and probe recovery; verify red first.
- Move DSH poll ownership and readiness/failure state out of bridge.js. Retain queue flushing and mode-change side effects through lifecycle notifications.
- Ensure Model Chat and Core construction do not require DSH ready. Run DSH integration, model selection, standalone model and container suites.
- Commit refactor(dsh): isolate provider lifecycle.

## Task 4 — Legacy QQ Adapter

Create src/channel/qq/runtime.js, src/channel/qq/transport.js and scripts/test-qq-runtime.mjs; update src/bridge.js and scripts/run-all-tests.mjs.

- Test client injection, incoming private/group event forwarding, connection readiness/single-flight connect, and send/request forwarding; verify red first.
- Move only SnowLuma client creation, event hookup and connection readiness behind the adapter. Keep Social v2, Slang, Stickers, Cards and Kugou in bridge.js.
- Route existing QQ calls through a thin transport preserving payloads and current policy checks. Run card and channel suites plus Core tests.
- Commit refactor(channel): establish legacy qq boundary.

## Task 5 — Extension and Rust Audits

Audit plugins/cetamesh-*, src/desktop-plugin-host.js, src/desktop-plugin-storage.js, src/mcp-desktop-utilities.js, plugins/whale-mode-console, desktop-shell/src/installer.rs and desktop-shell/src/migrate.rs.

- Verify tracking, references and deprecation evidence before moving/removing any prototype. Preserve whale-mode-console and tracked history.
- Record src/extension/ and extensions/ as the only canonical Extension runtime. Remove only confirmed deprecated prototypes from active production locations.
- Audit production user-path, filesystem, registry, migration, install and uninstall errors. Change only confirmed unwrap/expect panic hazards; retain tests/invariants with reasons in the report.
- Run extension and Rust suites. Commit Rust fixes only if the audit finds production hazards.

## Task 6 — Documentation and Report

Create docs/development/GIT_WORKFLOW.md and TECH_DEBT_CONSOLIDATION_REPORT.md; update CAPABILITY_COVERAGE.md, docs/desktop/ARCHITECTURE.md and PROJECT_STATE.md.

- Document branch → commit → tests → merge → verify → delete branch; prohibit reset/reflog as normal handoff mechanics.
- Define Capability Broker as authority for the generic Capability Plane. Record QQ MCP adapter-specific and Mesh trust/pairing control planes as direct exceptions; new generic capabilities must be Brokered.
- Correct only stale architecture comments touched by this work.
- Report base/final HEAD, Sessions 1–3, D1–D14 statuses, test evidence, RC Build ID/SHA256 or NOT_RUN_ENVIRONMENT, and limitations.

## Task 7 — Full Regression and RC

- Run npm test, npm run desktop:check and npm run desktop:test, then the requested focused architecture/security/release/DSH/Extension/Workshop/Continuity suites.
- Produce a clean commit and run build:core, desktop:build, build:release and test-release-candidate.
- Verify Native Release has no HTTP listener and 127.0.0.1:3100 is unreachable. Record build ID and SHA256.
- Leave merge and branch deletion for owner confirmation.
