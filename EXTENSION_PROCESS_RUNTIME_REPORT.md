# Extension Process Runtime Production Closure

**Branch:** `feature/process-extension-runtime-v1`
**Status:** implemented and verified
**Production Worker:** Core SEA `WhaleBridgeCore.exe --extension-worker`

## Result

Installed ordinary JavaScript Extensions now run in one independent child process per Extension through `ProcessExtensionHost`. Release mode starts the Core SEA executable with `--extension-worker`; development mode can start the Worker bootstrap with Node. Trusted builtin/development Extensions may still use `VmExtensionHost`. Memory Packs continue to use their data-only host.

The Worker and host reuse the existing version-1 frame vocabulary: `invoke`, `result`, `error`, `cancel`, `ping`, `pong`, and `shutdown`. There is no second IPC protocol.

## Process boundary and launch

- Release launch is resolved explicitly to the Core SEA executable plus `--extension-worker`. Production does not infer that `process.execPath` is `node.exe`.
- Each Worker is spawned with `shell: false`, stdio pipes, and a fixed canonical package root for the active Extension id and version. The path is checked against the Extension store and rejected when it traverses a symlink.
- The Worker environment is created as a new empty object. It includes only the minimum platform runtime values (`PATH`, `TEMP`, `TMP`, and Windows `SystemRoot` where needed) plus approved CetaMesh Extension metadata. The parent environment is never spread or copied and then scrubbed. The Worker also removes unexpected variables before loading package code.
- Provider keys, console and agent tokens, Git/AWS credentials, `NODE_OPTIONS`, `NODE_PATH`, Core objects, Memory Runtime, Workspace Runtime, unrestricted filesystem access, and network secrets are not passed to Extension code.
- Frames and partial line buffers are capped at 2 MiB. The host limits in-flight calls and transport queues; stderr diagnostics are separately bounded. Invalid, oversized, malformed, or directionally invalid frames fail the Worker closed.
- The Owner Review token includes a stable SHA-256 fingerprint of every package file and relative path. The same fingerprint is persisted with the active version, rechecked during staging and Worker startup, and checked on reverse capability calls so code changes cannot reuse an old manifest-only review.

## Capability boundary

Worker capability calls use the existing reverse `invoke` frame. The host ignores Extension identity supplied by a frame and binds each Worker to the active Extension id, version, package fingerprint, and manifest fingerprint. Before dispatch, the runtime verifies that the capability is declared and present in the currently approved grants, builds the Extension actor from the active registry entry, and sends the request through the existing Capability Broker and policy. Stale Workers, undeclared capabilities, and missing grants are denied.

Filesystem, memory, and network operations remain brokered. Extension-scoped private storage is separately namespaced and persisted through `src/storage/json-file.js`.

Invocation timeout and cancellation propagate through the Worker VM context, reverse IPC, and Capability Broker; pending reverse calls are aborted and removed when cancelled.

## Health and recovery

Runtime health reports `starting`, `healthy`, `running`, `unresponsive`, `crashed`, and `stopped`. Invocation deadlines send `cancel`; missed heartbeat deadlines mark a Worker unresponsive. Worker exit, nonzero crash, timeout escalation, or protocol violation rejects pending requests and is contained without throwing through Core.

Shutdown first sends the existing `shutdown` frame, waits for a bounded grace period, and terminates the whole process tree if necessary. Windows uses `taskkill /T /F`; Unix-like systems terminate the detached process group.

Automatic recovery allows at most three restarts per Extension in a rolling five-minute window. The counter resets only after five continuous healthy minutes. On exhaustion, `disabled_due_to_crash` is persisted until an explicit Restart. A manual restart does not erase recent automatic restart attempts.

## Extension lifecycle and permissions

The runtime supports review, install, enable, disable, update, rollback, restart, and remove. Updates stage and revalidate package contents, confirm the reviewed fingerprint, install the immutable version package, then atomically switch the registry record. The prior package is retained for rollback. Failed validation, package activation, registry persistence, or Worker startup restores the previous active version and Worker where possible.

Each update and rollback needs a current review candidate. Any newly added permission requires an Owner approval matching that candidate; previous grants cannot silently expand. Registry writes use the JSON Storage Primitive, and in-memory state is restored if persistence fails.

The existing Plugins page shows Enabled, Disabled, Running, Crashed, and Needs Review states and exposes Restart, Disable, and Remove actions. It also exposes a package source field with Review Package, then Install Extension or Update Extension after showing risk and permission changes. High-risk installs and updates that add permissions require a separate Owner approval checkbox tied to the review token.

## Memory Packs and executable requests

Memory Packs remain data-only and keep Base + Overlay behavior; they do not start a Worker. Requests for `shell`, `native`, `process`, or downloaded executables remain denied. A process host does not grant an Extension permission to launch arbitrary executables.

## Verification

- `npm run build:core` — passed after the review fixes; produced `dist/core/WhaleBridgeCore.exe` for release verification.
- `npm test` — **74 suites: 67 PASS, 0 FAIL, 7 NOT_RUN_ENVIRONMENT**.
- The registered Core SEA end-to-end suite ran against that rebuilt `WhaleBridgeCore.exe`, spawned it through the real `ProcessExtensionHost`, invoked an Extension, completed a brokered capability call, and verified clean shutdown.
- Process-host tests cover real child invocation and parallel invocation, timeout, cancellation, oversized and malformed frames, crash and exit, restart and restart exhaustion, shutdown, environment isolation, package-root cwd, process-tree cleanup, and Brokered capability allow/deny.
- Runtime tests cover host selection, bound reverse calls, health transitions, stable-window restart reset, explicit restart, transactional update/rollback, failed startup restoration, and fresh permission review.
- UI status and action tests, including Review/Install/Update request mapping and added-permission approval behavior, run through the desktop Rust test suite registered in `npm test` (114 Rust tests passed).
- Seven environment-dependent suites reported `NOT_RUN_ENVIRONMENT` because this machine lacks the required legacy bridge, shell debug runtime, external gateway/network, or release distribution. They are not counted as pass or fail.

## Security limitation

`ProcessExtensionHost` plus the restricted VM provides process and fault isolation with a narrow brokered API. It is **not Windows Sandbox and not AppContainer**. It is not an OS sandbox and does not claim protection against all operating-system-level access or a hostile escape from the VM.
