# CetaMesh 1.0 Agent Provider Expansion Report

Date: 2026-10-09
Branch: `codex/multi-session-setup`

## Result

CetaMesh now registers DSH, Codex, and ZCode through the existing Agent Broker and exposes one provider catalog/status/configuration contract. Task-bound sessions require both a Task and its registered Workspace. Providers without a verified Workspace boundary fail closed.

| Provider | Local discovery | Boundary and continuation |
|---|---|---|
| DSH | Registered whether its transport is connected or not. The stable DSH transport and event protocol remain in place. | The Task adapter binds `session/create` to a Task-specific staging copy. Staged changes are reconciled and written to the authoritative Workspace through `workspace.apply` in Capability Broker, with Owner approval. Fresh Session rollover closes the prior DSH staging session. |
| Codex | Inspected the installed `codex-cli 0.162.0-alpha.2` binary using `--version`, `--help`, `exec --help`, `exec resume --help`, and `login status`. The inspected CLI supports the required JSON execution and resume interfaces. | Runs from Task-specific staging with a Codex permission profile scoped to that stage, network disabled, and no `danger-full-access`. Changes reach the authoritative Workspace only through Capability Broker approval. Resume is used when the inspected CLI supports it; Continuity can always create a Fresh Session. |
| ZCode | `zcode` CLI is absent. The official Z.ai ZCode desktop application is detected at the standard Windows install path. | Registered as `available: false`, `reason: unsupported_external_control`, `externalControl: false`. No speculative CLI, private protocol, IPC, or fake session behavior is added. If the desktop application is absent, the reason is `not_installed`. |

## Shared CLI lifecycle

`src/agent/cli-agent-process.js` owns executable discovery, version and health probes, process start, stdin send, process-tree cancellation, shutdown, working directory, minimal environment, output capture, and timeout. Provider-specific flags, protocols, parsing, and session behavior stay in their provider implementations.

The installed Codex CLI was checked before choosing flags. The first real-binary help check exposed incorrect placement of exec-only flags; arguments were moved after `exec`, and the corrected fresh/resume argument ordering was checked against the installed CLI with help-only invocations. The complete permission-profile override set also parsed successfully with `--strict-config` and `--help`; this check did not start a model turn.

The Codex permission profile uses the documented custom-profile mechanism and stage-scoped workspace roots. It sets network access off, denies environment-file reads, and avoids full-access mode. See [Codex permissions](https://learn.chatgpt.com/docs/permissions) and [Codex configuration basics](https://developers.openai.com/zh-Hans/docs/config-file/config-basic).

`CliAgentProcess` passes an allowlisted runtime environment. CetaMesh process secrets are not inherited. Codex keeps authentication in its own `CODEX_HOME`/CLI configuration rather than receiving CetaMesh credentials.

## Workspace and Capability Broker

`src/workspace/staging.js` creates a bounded copy outside registered Workspace roots for each Task session. It excludes `.git`, CetaMesh state/data roots, nested or other registered Workspaces, credential directories, common private-key files, and `.env` files. It rejects symlinks, oversized snapshots, and conflicting changes to the authoritative Workspace.

Codex and Task-bound DSH report staged changes to the Capability Broker. `workspace.apply` validates the Task/Workspace binding, safe relative paths, sensitive paths, hashes, and conflicts. Writes, additions, and deletions require Owner approval before `WorkspaceService` applies them. Unknown or unsupported Workspace boundaries are denied by Agent Broker and the Task assignment path.

The provider catalog includes `id`, `displayName`, `available`, `version`, `capabilities`, `workspaceBoundary`, `supportsFreshSession`, `supportsResume`, `contextUsage`, and `health`. `agent.list`, `agent.status`, `agent.health`, and `agent.configure` are available through Agent Service. Chat routes Task-bound providers through Task assignment. Changing providers on an existing Task goes through Continuity Fresh Session; direct assignment cannot silently reuse a session from a different provider.

## Continuity

Continuity remains the source of Task checkpoints and session handoff. A Fresh Session creates a new Task-bound provider session and fresh staging copy; resume support is optional. Workspace reconciliation records differences against checkpoint facts. Rollover releases staged session resources after the new session is attached.

## Verification

The new acceptance suite covers the provider catalog, graceful unavailable states, Task/Workspace binding, missing Task rejection, staged Workspace isolation, sensitive-file exclusion, Owner-approved imports, stale changes, fake CLI execution, environment-secret isolation, send/cancel/timeout, Codex resume, Continuity Fresh Session, provider switching, DSH staging cleanup, `turn.failed` handling, and crash recovery.

Run tests only through the repository aggregate (`npm test`). Verification completed:

- Feature branch: **66 passed, 0 failed, 8 NOT_RUN_ENVIRONMENT** across 74 suites.
- Local `main` merge candidate: **74 passed, 0 failed, 9 NOT_RUN_ENVIRONMENT** across 83 suites, including the Product Context and model tool-calling suites already on `main`.
- The skipped suites require local external services, network opt-in, or build artifacts unavailable in this checkout; the aggregate records them separately and exits successfully.
- Core + architecture: **24/24 passed**.
- Runtime: **23/23 passed**.
- Security: **9/9 passed**.

## Operational limits

- The real Codex binary, help, authentication status, argument parser, and permission-profile configuration were inspected locally. A live inference turn was not started; execution behavior is covered by the fake CLI fixture.
- ZCode desktop control remains unavailable until Z.ai documents a supported external Agent API or CLI. Official documentation describes desktop installation and user-facing remote control; this implementation does not infer an app-to-app control protocol. See [ZCode installation](https://zcode.z.ai/en/docs/install) and [ZCode Remote Control](https://zcode.z.ai/en/docs/remote-control).
- DSH's existing transport and event protocol are preserved. The Task adapter limits copied/imported data to the selected Workspace. Any stronger DSH server-side path confinement still depends on the DSH runtime honoring the supplied `cwd`; CetaMesh does not claim an OS sandbox for that remote runtime.
