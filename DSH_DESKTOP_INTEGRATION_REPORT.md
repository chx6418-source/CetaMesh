# DSH Desktop Application Integration Report

Date: 2026-10-11

## Git delivery

- Base HEAD: `aec93a04a3b2b418f9345250e7fa190bdabef79c`
- Final implementation HEAD: `7a92356d11a6f2f6e01640e121c2a888e534e07e`
- Branch: `codex/dsh-desktop-integration-v1`
- Worktree: `C:\Users\Administrator\.codex\worktrees\dsh-desktop-integration-v1\GIT-QQ-BRIDGE`
- The later delivery commit contains only this report and the current-state note in `PROJECT_STATE.md`.

## Product and Provider status

DeepSeek Harness is a built-in product integration with stable ID `cetamesh-dsh` / `dsh`. Desktop application state and DSH Agent Provider health are separate fields. The existing DSH Provider continues through Agent Broker and its current DSH runtime; it is not hosted in `ProcessExtensionHost`.

The integration service supplies `plugins.list`, `plugins.get`, `plugins.settings`, `integrations.list`, `integrations.get`, and the DSH Desktop `status`, `refresh`, `open`, and `settings` actions. `agent.list` also carries a small Desktop summary for the DSH row. Provider readiness continues to come from Agent Broker health; an installed or running Desktop app does not make the Provider ready.

The DSH settings view keeps Desktop state, Agent state, Workspace boundary, and Continuity status distinct. `agents.defaultAgentProvider` is stored in Settings and affects newly created Chat sessions; existing sessions retain their provider selection. `auto` remains the default.

## Detection and launch

Windows detection checks the exact Desktop process image name, uninstall registration, App Paths, Start Menu shortcuts, and standard install locations. Status is cached for 30 seconds and can be explicitly refreshed. A user-initiated open probes current process state again, merges concurrent open requests, and holds a short startup grace window so a stale process list cannot cause duplicate launches.

Launching uses the discovered executable directly with `shell: false`, hidden window handling, detached stdio, and an allowlisted operating-system environment. If process state cannot be verified, CetaMesh fails closed instead of launching another copy. CetaMesh does not download or install DSH; the install guide opens the [official DeepSeek download page](https://www.deepseek.com/en/download/).

The `dsh` CLI is detected separately from the Desktop App. The live machine probe found the CLI available at the per-user npm command location and reported version `0.1.5-rc.1`. Desktop status reported `running`, `installed=true`, and version `0.2.0-rc.2`; the executable was found under `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`.

The live probe reports Desktop and CLI only. It does not infer DSH Agent Provider readiness from either result. At runtime, the Provider status is supplied independently by the current Agent Broker health call.

## Public API and security boundary

The reviewed [official Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md) describes the app-owned Desktop/Host lifecycle and authenticated application APIs, but does not document a third-party Agent execution or Desktop-control contract. DSH Desktop Agent Control is therefore recorded as `NOT_SUPPORTED_BY_PUBLIC_API`. CetaMesh does not connect to a private Host port, read cookies or credentials, inspect private Electron state, automate DevTools, or inject a renderer.

The adapter uses direct process and Windows application-registration checks. Child processes receive only a small environment allowlist; CetaMesh secrets are not inherited. Existing DSH Agent work remains under Task, Workspace, Capability Broker, and Continuity contracts.

## Verification

- `$env:WHALEBRIDGE_TEST_CARGO='1'; npm test`: **85 PASS, 0 FAIL, 10 NOT_RUN_ENVIRONMENT** across 95 suites.
- Registered Rust suites: `cargo:check` PASS, `cargo:test` PASS.
- DSH integration category in verbose mode: **7 PASS, 0 FAIL, 0 NOT_RUN_ENVIRONMENT**; the new DSH Desktop suite reports **13 PASS** and confirmed the live versions and running state above.
- `git diff --check`: PASS.

The 10 environment-gated skips were `test-console` (legacy bridge), `test-core-dist` and `test-process-extension-sea` (Core build), `test-desktop-install`, `test-desktop-shell`, and `test-installer-productization` (shell-debug), `test-mcp-exec` and `test-onebot-connection` (gateway), `test-mcp-web-search` (network), and `test-release-candidate` (release build). They were not counted as passes.

## Limits

- Desktop discovery is implemented for Windows. Unsupported platforms return a graceful unavailable state.
- No minimum Desktop version range is pinned yet. Detected versions are shown; an unverified version remains openable.
- When the Desktop process is already running, the action avoids a duplicate launch and reports that state; it does not claim to focus the existing window.
- Agent Provider readiness still depends on the CetaMesh DSH runtime and is not tested by Desktop discovery.
