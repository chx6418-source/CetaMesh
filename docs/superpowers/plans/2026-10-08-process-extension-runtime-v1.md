# Process Extension Runtime V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Run installed ordinary JavaScript Extensions in isolated child processes with brokered capabilities, bounded recovery, transactional lifecycle operations, a minimal Plugins page, and a real Core SEA end-to-end test.

**Architecture:** A trusted Worker bootstrap runs inside a child process and executes Extension source in the existing restricted VM context. Source development launches the worker entry through Node; Release launches the Core SEA executable with the new --extension-worker mode. The existing frame vocabulary is used in both directions, and host capability requests are bound to the active Extension registry record before entering the Capability Broker.

**Tech Stack:** Node.js ESM, node:child_process, node:vm, Node SEA, JSON Storage Primitive, Rust/egui native shell, existing unified npm test runner.

**Spec:** docs/superpowers/specs/2026-10-08-process-extension-runtime-design.md

## Global Constraints

- Production Release must not assume process.execPath is node.exe; Core SEA accepts --extension-worker.
- Build Worker environment from an empty object and add only an explicit allowlist; never spread process.env.
- Fix cwd to the canonical active Extension id/version package root owned by the Extension store.
- Bind reverse capability invokes to the host-bound Extension id, active version/fingerprint, manifest declarations, and reviewed grants before calling the existing Capability Broker.
- Preserve the existing frame kinds and enforce a 2 MiB maximum frame, bounded line buffering, and at most 16 in-flight calls.
- Terminate the whole process tree on shutdown timeout or protocol failure.
- Allow at most three automatic restarts in five minutes; reset the count only after five continuous healthy minutes.
- Preserve Memory Pack data-only Base + Overlay semantics and all existing denials for shell, native, process, and downloaded executables.
- ProcessHost plus the restricted VM is fault/process isolation only; it is not Windows Sandbox or AppContainer.
- Do not modify Device Mesh, Update Source, or Theme System.
- Route all tests through npm test and register every new scripts/test-*.mjs file in scripts/run-all-tests.mjs.

## Review Focus

- Release launch args select Core SEA --extension-worker, not a Node-only path: the registered SEA E2E must launch dist/core/WhaleBridgeCore.exe and invoke through ProcessExtensionHost.
- Host environment contains only allowlisted values when the parent has fake provider, console, Git, AWS, NODE_OPTIONS, and NODE_PATH values: test the env builder and actual Worker launch.
- Reverse invoke cannot spoof another Extension id, use an undeclared capability, reuse a stale version/fingerprint, or exceed reviewed grants: test each denial before Broker dispatch.
- Shutdown and protocol-fault cleanup terminate descendants as well as the Worker PID: spawn a test descendant and assert the whole tree exits.
- Update/rollback write failures and permission additions preserve the active version unless a fresh approval and atomic switch succeed: test rollback, owner review, and registry-write failure.

---

### Task 1: Worker bootstrap and Core SEA dispatch

**Files:**
- Create: src/extension/process-worker.js
- Modify: src/core-dispatch.js
- Modify: scripts/test-core-entry.mjs
- Test: scripts/test-process-extension-host.mjs

**Interfaces:**
- Consumes: createVmExtensionHost({ manifest, source, storage, capabilityExecutor, timeoutMs }) and the existing version-1 frame vocabulary.
- Produces: parseCoreArgs(["--extension-worker"]) returns { mode: "extension-worker" }; runCore dispatches to exported runExtensionWorker().
- Worker stdin accepts bounded newline-delimited JSON frames. It handles host invoke/result/error/cancel/ping/pong/shutdown and sends only existing frame kinds on stdout. Worker diagnostics use stderr.

- [x] Write failing assertions for --extension-worker argument parsing and Worker frame routing.
- [x] Run npm test and confirm the new assertions fail in the unified runner.
- [x] Implement runExtensionWorker() using the existing VM host and a reverse-invoke callback that writes frames to stdout.
- [x] Run npm test and confirm worker dispatch and protocol tests pass.
- [x] Commit the Worker bootstrap and dispatch changes.

### Task 2: Spawn transport, empty environment, fixed cwd, and process-tree cleanup

**Files:**
- Create: src/extension/process-transport.js
- Create: src/extension/process-tree.js
- Create: src/extension/worker-env.js
- Modify: src/extension/process-host.js
- Test: scripts/test-process-extension-host.mjs

**Interfaces:**
- Produces: buildExtensionWorkerEnv({ parentEnv, metadata }) starts from an empty object and copies only PATH, TEMP, TMP, required SystemRoot, and approved non-secret CetaMesh metadata by explicit key lookup.
- Produces: resolveExtensionWorkerLaunch({ packaged, execPath, workerEntry }) returns Node plus workerEntry in source mode and Core SEA plus ["--extension-worker"] in packaged mode.
- Produces: createProcessTransport({ packageRoot, extensionId, version, launch }) returns send(frame), onMessage(handler), alive(), close(), and killTree().
- ProcessHost accepts an injected transport for focused fixtures; production construction creates the real child transport. The child cwd is the canonical package root for the active Extension id/version and is checked to remain under the Extension store.

- [x] Add failing tests for explicit environment allowlisting, launch resolution, fixed package cwd, and real child invoke/parallel invoke.
- [x] Add failing tests for partial-line and full-frame size limits, malformed frames, timeout, cancel, and process-tree cleanup.
- [x] Run npm test and confirm those new transport assertions fail.
- [x] Implement the shell-free spawn transport with stdio pipes, bounded stdout/stderr handling, and platform process-tree termination.
- [x] Extend ProcessHost to fail pending calls and close the whole process tree on protocol violation, shutdown timeout, or child exit.
- [x] Run npm test and confirm transport and real Node child tests pass.
- [x] Commit the process transport and host changes.

### Task 3: Runtime selection, bound Broker calls, health, and bounded recovery

**Files:**
- Modify: src/extension/runtime.js
- Modify: src/extension/service.js
- Modify: src/app/service-container.js only if an explicit trusted-VM registration hook is needed
- Modify: src/extension/process-host.js
- Test: scripts/test-extension-runtime.mjs
- Test: scripts/test-extension-capability.mjs
- Test: scripts/test-process-extension-host.mjs

**Interfaces:**
- Runtime selects createMemoryPackHost for Memory Packs; an explicit host-side isTrustedVmExtension(entry) predicate may select VmExtensionHost; other installed code Extensions select ProcessExtensionHost.
- ProcessHost is bound at construction to extensionId, active version, and manifest fingerprint. A reverse invoke is accepted only when the current registry entry still matches, the capability is declared by its manifest, and its permission is in the reviewed grants. The host constructs the actor from that active entry and calls broker.execute; the frame cannot supply an actor or extensionId.
- overview() returns persisted Extension status plus runtimeState and health fields. restart({ id }) clears disabled_due_to_crash for one explicit start but does not reset automatic restart history.
- Runtime states are starting, healthy, running, unresponsive, crashed, and stopped. Automatic recovery allows three restarts per five minutes; five continuous healthy minutes reset the counter.

- [ ] Add failing tests for VM trust selection, ordinary Extension process selection, and unchanged Memory Pack routing.
- [ ] Add failing Broker tests for declared and granted capability success, undeclared capability denial, missing grant denial, stale fingerprint denial, and Extension-id spoof denial.
- [ ] Add failing tests for health transitions, heartbeat misses, three automatic restarts, exhaustion, stable-window counter reset, and explicit Restart.
- [ ] Run npm test and confirm the new runtime assertions fail.
- [ ] Implement runtime host selection and host-bound Broker dispatch.
- [ ] Implement health state, heartbeat, stable-window restart accounting, persistent disabled_due_to_crash, and restart service method.
- [ ] Run npm test and confirm runtime, Broker, and real child suites pass.
- [ ] Commit runtime selection and recovery changes.

### Task 4: Transactional install, permission review, update, rollback, and remove

**Files:**
- Modify: src/extension/installer.js
- Modify: src/extension/store.js
- Modify: src/extension/review.js only if the review summary must expose the permission delta
- Modify: src/extension/runtime.js
- Modify: src/extension/service.js
- Test: scripts/test-extension-runtime.mjs
- Test: scripts/test-extension-capability.mjs

**Interfaces:**
- Installer adds rollback({ id, approval }) and retains the immediately previous immutable package version. Runtime review({ sourceDir }) records a transient pending review candidate keyed by manifest id; overview() exposes it for the Plugins page and candidates clear after successful install/update or explicit cancellation.
- Extension service exposes ext.rollback and ext.restart.
- store.put(entry) restores the prior in-memory entry if JSON Storage Primitive persistence fails; persistent writes remain in src/storage/json-file.js.
- update stages and validates before switching the active registry entry. Added permissions require a fresh matching Owner review. Failed stage, review, package move, or registry write preserves the previous package and active registry entry.
- Successful rollback atomically activates the retained version; permission additions relative to the active version require fresh Owner review.

- [ ] Add failing tests for version staging, new-permission re-review, update switch failure, registry write failure, explicit rollback, and rollback permission escalation.
- [ ] Run npm test and confirm the new lifecycle assertions fail.
- [ ] Implement transactional registry mutations and staged immutable version activation.
- [ ] Implement explicit rollback and ensure active Workers are shut down/rebuilt only around successful registry switches.
- [ ] Run npm test and confirm lifecycle and permission review tests pass.
- [ ] Commit installer and store lifecycle changes.

### Task 5: Minimal Plugins page

**Files:**
- Modify: desktop-shell/src/native_ui.rs
- Modify: scripts/test-system-pages.mjs
- Test: desktop-shell Rust unit tests, run through npm test

**Interfaces:**
- Add a Plugins area and operations for extension overview refresh, review, restart, disable, rollback if surfaced, and remove. Add one package source-path field and Review Package action that calls ext.review and shows risk and permission delta; only an explicit subsequent install/update action can switch the active version.
- The page reads ext.overview and displays Enabled, Disabled, Running, Crashed, and Needs Review. Needs Review is shown for an install/update review row keyed by Extension id; the installed version remains active until approval and atomic switch.
- Restart invokes ext.restart; Disable invokes ext.disable; Remove invokes ext.uninstall. Refresh after each completed operation.

- [ ] Add failing Rust/UI assertions for status mapping and the Restart, Disable, Remove actions.
- [ ] Run npm test and confirm the new UI assertions fail.
- [ ] Implement the status list and controls in the existing Plugins page without changing the overall navigation or page design.
- [ ] Run npm test and confirm the desktop tests pass.
- [ ] Commit the Plugins page changes.

### Task 6: Formal Core SEA E2E, release documentation, and report

**Files:**
- Create: scripts/test-process-extension-sea.mjs
- Modify: scripts/run-all-tests.mjs
- Modify: docs/desktop/BUILD_AND_RELEASE.md
- Create: EXTENSION_PROCESS_RUNTIME_REPORT.md
- Test: scripts/test-process-extension-host.mjs
- Test: scripts/test-process-extension-sea.mjs

**Interfaces:**
- Register test-process-extension-sea.mjs in run-all-tests.mjs as a release suite requiring core-dist, with a 600000 ms timeout. Availability detection honors WHALEBRIDGE_DIST_DIR as well as dist/core.
- The SEA E2E uses dist/core/WhaleBridgeCore.exe as the ProcessHost child with --extension-worker, exchanges real stdio frames, invokes an Extension and a Brokered capability, checks shutdown, and asserts the process tree is gone. It does not substitute Node source mode for the SEA executable.
- The release guide documents npm run build:core followed by npm test for the SEA suite. The final report records launch mode, allowlist, cwd, capability binding, restart/cleanup policy, lifecycle, tests, and limitations.

- [ ] Add failing assertions for SEA-mode launch selection and aggregator registration.
- [ ] Add the SEA E2E that launches the built Core SEA Worker through the real ProcessExtensionHost transport.
- [ ] Run npm run build:core, then npm test, and confirm the SEA E2E fails until SEA dispatch is implemented.
- [ ] Implement any missing SEA packaging/dispatch wiring and update release documentation.
- [ ] Run npm run build:core, then npm test. Confirm all runnable suites pass and the SEA suite runs rather than being skipped.
- [ ] Write EXTENSION_PROCESS_RUNTIME_REPORT.md and verify it clearly states ProcessHost plus VM is not Windows Sandbox or AppContainer.
- [ ] Commit the SEA E2E, test registry, release guide, and final report.

