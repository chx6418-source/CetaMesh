# CetaMesh Desktop v1 — Architecture and Red Lines

> Status: Desktop v1 **Release Candidate** (`1.0.0-rc.1`). Authoritative evidence lives in
> `PROJECT_STATE.md`; this document explains the shape and the invariants the code must keep.

## Product model

- **CetaMesh Desktop** is a native Windows app. Primary product areas: **Chat / Tasks / Memory /
  Workspace**; secondary areas: Settings / Diagnostics / Advanced (engineering surfaces).
- **Task != Agent Session.** A CetaMesh Task owns its own id, rev, status and workspace
  reference. A DSH (or future) Agent session is an attachable execution reference only.
- **Agent Provider != Model Provider.** Providers implement a contract; DSH is the first Agent
  Provider. Model selection lives with the chat/provider configuration.
- **QQ / SnowLuma is a Channel Adapter, never the Core.** The product runtime has no SnowLuma
  imports; the adapter is optional at run time and appears under Diagnostics/Settings.
- Desktop and Mobile are independent CetaMesh Nodes; Device Mesh is a separate protocol layer.

## Layers

```
UI (egui native shell)                      desktop-shell/src/native_ui.rs, *_ui.rs, app_shell.rs
        |  versioned JSON over a per-instance named pipe
Runtime / Application services              src/desktop, src/task, src/memory, src/workspace,
                                            src/agent, src/continuity, src/settings, src/about,
                                            src/update, src/extension, src/mesh, src/channel
        |
Domain contracts                            src/*/types.js (pure, no IO)
        |
Providers / Repositories                    DSH API client, JSON stores, workspace boundary
        |
Native / Infrastructure                     Node SEA Core, Rust supervisor/installer, Win32 tray
```

## Module map

| Area | Location | Notes |
| --- | --- | --- |
| Chat | `src/desktop/chat-service.js` | sessions, streaming, stop/retry, attachments; Agent Provider optional |
| Tasks | `src/task/` | persistent tasks, revisions, attention; agent attach/detach never changes task id |
| Memory | `src/memory/` | policy-gated memory runtime + store |
| Workspace | `src/workspace/` | root canonicalization and path containment (`boundary.js`) |
| Agent Provider | `src/agent/` | provider contract + DSH adapter + registry |
| Continuity | `src/continuity/` | context monitor, rollover, handoff packets |
| Extensions | `src/extension/` | manifest review, static scan, sandboxed `vm` host, no host fs/process |
| Device Mesh | `src/mesh/` | identity/trust, capabilities, transport and approval |
| Channels | `src/channel/` | Channel Adapter registry (QQ/SnowLuma entry lives here) |
| Settings / About / Update | `src/settings`, `src/about`, `src/update` | product settings, build provenance, signed-manifest update checks |
| Config boundary | `src/config/` | one fail-closed config loader/updater for Core, MCP and local services |
| Logging | `src/logging/` | mandatory redaction (text + field level) |
| Control / IPC | `src/control/` | named-pipe protocol, method families, privilege model |
| Native shell | `desktop-shell/` | eframe UI, supervisor, installer/uninstaller, tray, UI prefs |

## Data locations

- Install directory (`%LOCALAPPDATA%\Programs\WhaleBridge`): application files + `resources/`.
  Read-only at run time; the release test asserts it stays byte-identical while running.
- Data directory (`%LOCALAPPDATA%\WhaleBridge`): `config.json`, `settings.json`, `state/`,
  logs. Upgrade and uninstall preserve it unless `--remove-data` is passed explicitly.
- UI preferences (`state/desktop-ui.json`): theme, zoom, close behavior, window geometry; written
  atomically by the shell only. Task / Memory / Workspace data never flows through this file.
- User Workspace roots: user-chosen directories outside the data directory. Uninstall never
  deletes them, including `--remove-data` (covered by the installer lifecycle test).

## Red lines and enforcement

| Red line | Enforcement / evidence |
| --- | --- |
| UI must not bypass the Runtime | `scripts/test-desktop-architecture.mjs`; UI modules contain no Core data-file names and no process control beyond opening the log directory in Explorer. Attachments are a bounded, user-initiated drag & drop read. |
| Agent must not access the disk arbitrarily | Workspace tools resolve user paths through `src/workspace/boundary.js` (lexical + realpath containment, forbidden roots); runtime tests: `npm run test-workspace`. |
| Trust must not become Permission | Agent/extension capabilities require declared permissions plus explicit grants/approval (`src/extension/review.js`, `src/extension/host.js`, task/agent approval paths); tests: `test-extension`, `test-task`, `test-mesh`. |
| Task must not depend on an Agent Session | `src/task/runtime.js` keeps `currentAgent` as an optional attachment; detach sets it to `null` without touching task identity. Tests: `npm run test-task`. |
| QQ must not be a Core dependency | Product runtime has zero SnowLuma imports; the adapter only appears in `src/channel/registry.js` and diagnostics placement. Test: `test-architecture` + `test-core-entry`. |
| Secrets must not reach logs | `src/logging/redact.js` (mandatory `createRedactingSink`, text + field rules). Test: `npm run test-system` (includes bearer-token regression). |
| Extensions must not execute downloaded code freely | Static scan forbids `child_process`/`fs`/dynamic import/`new Function`; the host runs code in `vm.createContext` with no host `require`/`process`/`Buffer`/fs/net; high-risk permissions need explicit review approval. Tests: `npm run test-extension`. |
| Legacy reserved modes stay out of the product flow | No `reserved`/`reserved2` references in `src/desktop`, `src/agent`, `src/memory`, `src/task`, `src/workspace`, `src/continuity`; they remain only in the legacy QQ adapter surfaces (Advanced). Test: `test-architecture`. |
| Docs must not claim missing features | `PROJECT_STATE.md` is the authoritative status source; this audit marks unverified items explicitly. Tauri/WebView shell files were removed once confirmed unused. |

## Native shell boundary

- The shell starts and supervises the Core (`Supervisor`), connects to the per-instance named pipe
  and never speaks HTTP for management operations.
- The system tray owns show/hide/restart/logs/quit plus live Core status and "needs attention".
  Closing the window hides to the tray by default; Core and running tasks keep going. Only the
  explicit quit path stops Core.
- Window preferences and theme/zoom are persisted in `state/desktop-ui.json` (atomic replace);
  a corrupt preference file falls back to defaults without blocking startup.
