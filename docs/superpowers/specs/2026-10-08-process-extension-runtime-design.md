# Extension Process Runtime Production Closure — Design

**Date:** 2026-10-08
**Branch:** `feature/process-extension-runtime-v1`

## Goal

Promote `ProcessExtensionHost` from a transport contract and fixture to the production host for installed ordinary JavaScript Extensions. Each Extension gets its own Node child process. The existing VM host remains available for explicitly trusted builtin/development use. Process isolation provides fault and crash separation; it is not an OS sandbox and does not claim Windows Sandbox or AppContainer protection.

## Constraints

- Do not modify Device Mesh, Update Source, or Theme System.
- Use `process.execPath`, `shell: false`, a package-scoped working directory, an explicit environment allowlist, and stdio pipes.
- Do not pass Core, Memory Runtime, Workspace Runtime, provider credentials, console/agent tokens, Git/AWS credentials, or an unrestricted filesystem/network wrapper into Extension code.
- Keep filesystem, memory, and network access mediated by the existing Capability Broker and policy.
- Reuse the current frame vocabulary: `invoke`, `result`, `error`, `cancel`, `ping`, `pong`, and `shutdown`. Do not introduce a second IPC protocol.
- Memory Packs remain data-only and keep their current Base + Overlay semantics.
- Manifest permissions `shell`, `native`, `process`, and `download` remain denied.
- Persistent JSON continues through `src/storage/json-file.js`.

## Architecture

### Host selection

Installed executable Extensions use a `ProcessExtensionHost` by default. A trusted builtin/development path may explicitly inject the existing `VmExtensionHost`; trust is determined by host-side registration/configuration, never by a manifest claim. Memory Packs continue to use `createMemoryPackHost` and never start an executable Worker.

### Worker process and transport

Add `src/extension/process-worker.js` as trusted bootstrap code. The Core launches it with `spawn(process.execPath, [workerEntry], { shell: false, cwd: versionedPackageRoot, env: allowlistedEnv, stdio: ['pipe', 'pipe', 'pipe'] })`. The package root is the fixed working directory. The inherited environment is discarded; only the minimum runtime variables (such as `PATH`, `TEMP`, `TMP`, and `SystemRoot` where required) and non-secret CetaMesh Extension metadata are set. In particular, `NODE_OPTIONS`, `NODE_PATH`, credentials, and provider secrets are omitted.

The Worker reads the already-validated installed manifest and entry from its package directory. It runs Extension source in the existing restricted VM-style context: no `process`, `require`, `Buffer`, raw `fs`, or direct network API is exposed to Extension code. This remains best-effort in-process containment, not a security boundary against a hostile VM escape.

The stdio transport uses newline-delimited JSON frames. Stdout carries protocol frames only; stderr is bounded diagnostic output. Each frame is capped at 2 MiB and the existing 16 in-flight limit remains. A malformed, oversized, unknown, or directionally invalid frame is a protocol violation: fail pending calls, mark the host crashed, and terminate that Worker without throwing through Core.

### Existing protocol as bidirectional RPC

Core-to-Worker invocation keeps the current shape: Core sends `invoke`; Worker replies with `result` or `error`. A Worker request for a host capability uses the same `invoke` frame in the reverse direction. Core validates the frame and routes the request through the existing Extension actor, Capability Broker, and policy, then sends a matching `result` or `error`. Frame IDs correlate requests independently in each direction. Cancellation uses `cancel` frames and rejects the matching pending call; shutdown closes pending work and the child. Startup readiness uses the existing `ping`/`pong` frames.

The Worker exposes only the existing narrow host adapters to Extension code. Filesystem, memory, and network adapter calls travel to Core through this RPC path and then through the Capability Broker. Extension-scoped key/value storage remains a narrow host-mediated adapter limited to that Extension's namespace.

### Lifecycle and failure handling

Track Worker states `starting`, `healthy`, `running`, `unresponsive`, `crashed`, and `stopped`. A successful startup ping moves to `healthy`; active calls move to `running`; completion returns to `healthy`. A missed health/invoke deadline becomes `unresponsive`; an exit, malformed frame, oversized frame, or protocol violation becomes `crashed`. Explicit disable or shutdown ends at `stopped`. Core observes exit/error events, rejects in-flight requests, and does not allow a Worker exception to escape its IPC handler.

Automatic recovery is bounded to three restarts in a rolling five-minute window per Extension. Once exhausted, persist `disabled_due_to_crash` in the Extension registry and require an explicit user Restart action. Manual restart clears the disabled state and starts a fresh Worker; the restart counter resets only after five continuously healthy minutes. Disable, update, rollback, remove, and Core shutdown send `shutdown`, wait for a short bounded grace period, then kill the child if needed.

### Install, review, update, rollback, and remove

Keep the current manifest validation, source scan, permission review, and registry as authoritative. Updates are staged in a unique version staging directory; the staged package is validated and scanned before activation. A permission delta is reviewed against the previous installed permissions. Any newly added permission requires a fresh Owner approval token matching the staged manifest fingerprint.

Preserve the current package and registry entry until the new version is complete. Atomically move the staged package into its immutable version directory, then atomically switch the registry pointer using the existing JSON Storage Primitive. If validation, review, package move, or registry write fails, remove the staged version and leave the prior entry and running version intact. Retain the prior version needed for rollback.

Add an explicit rollback operation using the retained previous version. Revalidate the retained package before switching. If rollback adds any permission relative to the currently active version, require a new Owner review. A successful rollback switches the registry pointer atomically and preserves the version being rolled back from as the next rollback target. Remove shuts down the Worker before deleting registry/package state; the existing keep-files option remains available.

### Plugins UI

Extend the current Plugins page without redesigning it. Load the existing extension overview and show the lifecycle label `Enabled`, `Disabled`, `Running`, `Crashed`, or `Needs Review`, with process health available in details. Add Restart, Disable, and Remove controls wired to the Extension service. Permission review remains explicit before an install/update that adds permissions. An Extension that has exhausted crash recovery remains visibly disabled due to crash until Restart is requested.

### Memory Packs and executable restrictions

Memory Packs stay data-only, do not launch a Worker, and retain Base + Overlay behavior. Existing manifest and source-scan denials for shell execution, native modules, arbitrary process access, and downloaded executables remain in force; introducing a child-process host does not grant any new executable permission.

## Acceptance and tests

Extend the existing registered `scripts/test-process-extension-host.mjs` suite so tests spawn a real child process. Cover normal and parallel invocations, timeout, cancel, oversized/malformed/protocol-violating frames, non-zero crash, bounded restart and restart exhaustion, shutdown, absence of parent secrets, package-scoped cwd, brokered capability success, broker permission denial, failed update rollback, explicit rollback, and new-permission re-review. Keep tests registered through `scripts/run-all-tests.mjs`; do not create an unregistered test script.

Run `npm test` after implementation. Environment-dependent suites may report `NOT_RUN_ENVIRONMENT` as defined by the unified runner. Update `EXTENSION_PROCESS_RUNTIME_REPORT.md` with the transport, security boundary, lifecycle, tests, and any remaining limitations. The report must not describe ProcessExtensionHost as an OS sandbox.

## Out of scope

Device Mesh, Update Source, Theme System, arbitrary native executable support, redesigning the Plugins page, and changing Memory Pack data semantics.
## Design refinements

These details resolve implementation ambiguities found during self-review:

- The host sends at most one heartbeat ping every 10 seconds and allows 3 seconds for pong. A missed heartbeat marks the Worker unresponsive and starts bounded recovery. An invocation timeout alone rejects that call and sends cancel; it does not crash a Worker that still answers heartbeat probes.
- Both complete frames and unterminated stdout line buffers are capped at 2 MiB. The Worker may request only adapter operations represented by its installed manifest permissions. Core sends accepted requests through the existing Extension actor, Capability Broker, and policy; the Broker remains authoritative for allow/deny decisions.
- Registry updates must be transactional in memory as well as on disk. If the JSON Storage Primitive write fails, restore the prior in-memory registry entry before returning the error.
- The Plugins page displays Needs Review for the selected install/update review row, keyed by Extension id, while Owner approval is pending. The installed version and status remain unchanged until approval and atomic switch succeed.
- Tests also cover heartbeat recovery, registry write failure, and the review/status UI transition.
## Release and isolation amendments

The following release and isolation requirements refine the architecture above and are mandatory:

1. **SEA worker entry.** Do not assume `process.execPath` is `node.exe`. Add `--extension-worker` to the Core dispatcher. In source development, the Node executable can launch the worker entry; in a formal Release build, `process.execPath` is the Core SEA executable and it handles `--extension-worker` itself. The SEA bundle must include the Worker bootstrap path. A separate shipped Worker executable is acceptable only as an equivalent alternative; the selected design is the Core SEA mode.
2. **Formal SEA E2E.** Add a registered release integration suite that builds/uses `dist/core/WhaleBridgeCore.exe`, launches it in `--extension-worker` mode through the real ProcessExtensionHost stdio transport, invokes an Extension, and verifies protocol, brokered capability flow, and shutdown. A Node-source-only child test does not satisfy this acceptance criterion. Gate the suite on the existing `core-dist` availability and document the build command needed to run it.
3. **Empty environment allowlist.** Construct the Worker environment as a new empty object and add only explicitly selected runtime variables (`PATH`, `TEMP`, `TMP`, `SystemRoot` when required) and non-secret CetaMesh Extension metadata. Never copy/spread `process.env` and then remove known secret keys. Exclude `NODE_OPTIONS`, `NODE_PATH`, provider keys, tokens, Git/AWS credentials, and all unlisted variables.
4. **Fixed Extension cwd.** Set cwd to the canonical Extension-specific versioned runtime/package root owned by the Extension store, such as the package root for the active `id/version`. Reject roots outside the store or roots that escape through symlinks. Do not use a user-selected workspace, source import directory, or Core's cwd.
5. **Bound reverse capability requests.** The Worker transport is bound at construction to one Extension id, active version, and manifest fingerprint; do not accept an Extension id from a Worker frame. Before dispatching a reverse `invoke`, require that the capability is declared in that installed manifest and present in the active registry's reviewed/approved grants. Then create the Extension actor from that same registry entry and pass the request through Capability Broker and policy. A stale Worker, undeclared capability, missing grant, or changed active fingerprint fails closed.
6. **Whole process-tree shutdown.** Graceful `shutdown` is followed by termination of the entire child process tree if the grace period expires or the protocol fails. Use platform process-tree/group termination with shell-free OS process invocation; do not leave descendants orphaned. The Windows release path must terminate descendants as well as the SEA Worker PID.
7. **Stable restart reset.** Keep the maximum of three automatic restarts in a rolling five-minute window. Reset the restart counter only after the Worker has remained healthy continuously for five minutes. A crash before that stable window retains the prior count; exhaustion persists `disabled_due_to_crash` until explicit Restart.
8. **Security wording.** All design, build, UI, and report documentation must say that ProcessHost plus the restricted VM is process/fault isolation only. It is not Windows Sandbox or AppContainer and must not be described as either.
### Clarifications to earlier examples

The generic spawn example in the Worker section applies to source development. Release mode resolves a different argument vector: the same Core SEA executable is launched with --extension-worker, and the SEA bundle dispatches to the Worker bootstrap. No production path assumes the executable is node.exe.

An explicit Restart clears the disabled state and starts one Worker, but it does not erase recent automatic restart attempts. Only five uninterrupted healthy minutes reset the automatic restart counter. If a manually restarted Worker crashes before that stable window, the earlier count still applies.
