# CetaMesh Desktop — Architecture and Red Lines

> Status: UX v2 production implementation uses the Owner-selected **01 Harbor** presentation. The
> Core, named-pipe protocol, installer and security boundaries remain authoritative; see
> `UI_SOURCE_OF_TRUTH.md` for the selected desktop visual direction and `PROJECT_STATE.md` for work status.

## Product model

- **CetaMesh Desktop** is a native Windows app. Primary product areas: **Chat / Tasks / Memory /
  Workspace**; secondary areas: Settings / Diagnostics / Advanced (engineering surfaces).
- **Task != Agent Session.** A CetaMesh Task owns its own id, rev, status and workspace
  reference. A DSH (or future) Agent session is an attachable execution reference only.
- **Agent Provider != Model Provider.** Providers implement a contract; DSH is the first Agent
  Provider. Model selection lives with the chat/provider configuration.
- **QQ / OneBot is a Channel Adapter, never the Core.** The independently authored OneBot v11 transport lives in `src/channel/qq/onebot-client.js`; the restricted SnowLuma SDK is not embedded. Compatible external gateways are installed independently, and Core services initialize without requiring that channel or DSH readiness.
- Desktop and Mobile are independent CetaMesh Nodes; Device Mesh is a separate protocol layer.

## Process composition

The desktop shell starts one Node worker with `--worker`. `src/core-dispatch.js` sends that
mode directly to `src/app/core-worker.js`, which calls `src/app/bootstrap.js` and owns the
Core services, Owner IPC and data IPC. `src/app/service-container.js` owns service wiring,
`src/app/ipc-runtime.js` owns the existing UI IPC method routing, and the application lifecycle
closes registered services. Core constructs an optional DSH API client without starting DSH;
construction succeeds without QQ or a ready DSH provider. The DSH Agent Provider owns its
Session Follow reader and Core cursor cache. Task staging still imports through Capability Broker.

`src/bridge.js` remains a separate, exclusive Legacy QQ/Social compatibility entry. It takes
the same StateDir owner lease before starting its old services, so it cannot run concurrently
with the desktop Core on one data directory. It still composes Core services internally and
must not be described as an independent QQ Connector until M4 ownership transfer is approved
and verified. The legacy DSH path remains exclusive to this compatibility host.

```text
Desktop shell → `--worker` → `src/app/core-worker.js`
                              └─ `src/app/bootstrap.js` → service container → IPC runtime
Explicit Legacy entry → `src/bridge.js` (exclusive StateDir lease)
                              ├─ compatibility Core bootstrap and IPC
                              └─ legacy QQ/Social integration → `src/channel/qq/` adapter
```

## Layers

```
Renderer (01 Harbor React / TypeScript)     desktop-ui/src/app/HarborApp.tsx
        |  typed `ui.*` bridge DTOs over WebView IPC
Rust Host (WebView2, tray, lifecycle)        desktop-shell/src/webview_ui.rs, webview_policy.rs
        |  versioned JSON over a per-instance named pipe
Composition root / Runtime services       src/app, src/desktop, src/task, src/memory, src/workspace,
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
| Desktop UI projection | `src/desktop/ui-service.js` | exact `ui.*` route table, bounded safe DTOs and change events; no renderer access to generic Core responses |
| Reference preview | `src/desktop/reference-preview.js`; `desktop-ui/src/app/ReferenceViewer.tsx` | source-bound readonly files and docked tabs; separate native child for public HTTPS pages |
| Tasks | `src/task/` | persistent tasks, revisions, attention; agent attach/detach never changes task id |
| Memory | `src/memory/` | policy-gated memory runtime + store |
| Workspace | `src/workspace/` | root canonicalization and path containment (`boundary.js`) |
| Agent Provider | `src/agent/` | provider contract + DSH adapter + registry |
| Continuity | `src/continuity/` | context monitor, rollover, handoff packets |
| Extensions | Runtime: `src/extension/`; packages and fixtures: `extensions/` | The only canonical Extension runtime; manifest review, static scan and sandboxed `vm` host. |
| Device Mesh | `src/mesh/` | identity/trust, capabilities, transport and approval |
| Channels | `src/channel/` | Channel Adapter registry (QQ/SnowLuma entry lives here) |
| Settings / About / Update | `src/settings`, `src/about`, `src/update` | product settings, build provenance, signed-manifest update checks |
| Config boundary | `src/config/` | one fail-closed config loader/updater for Core, MCP and local services |
| Logging | `src/logging/` | mandatory redaction (text + field level) |
| Control / IPC | `src/control/` | named-pipe protocol, method families, privilege model |
| Desktop renderer | `desktop-ui/` | 01 Harbor React 19 / TypeScript / Vite app; bundled locally for offline WebView2 use |
| Native host | `desktop-shell/` | WebView2 presentation, exact bridge allowlist, supervisor, installer/uninstaller, tray and UI preferences; `--ui=legacy` is an explicit fallback |

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
| QQ must not be a Core dependency | The service-container import closure excludes SnowLuma SDK, QQ runtime and Social adapters; Core injects only an optional DSH API client and starts no DSH process. Tests: `test-composition-boundary`, `test-service-container`, `test-dsh-connector-m3`. |
| Secrets must not reach logs | `src/logging/redact.js` (mandatory `createRedactingSink`, text + field rules). Test: `npm run test-system` (includes bearer-token regression). |
| Extensions must not execute downloaded code freely | Static scan forbids `child_process`/`fs`/dynamic import/`new Function`; the host runs code in `vm.createContext` with no host `require`/`process`/`Buffer`/fs/net; high-risk permissions need explicit review approval. Tests: `npm run test-extension`. |
| Legacy reserved modes stay out of the product flow | No `reserved`/`reserved2` references in `src/desktop`, `src/agent`, `src/memory`, `src/task`, `src/workspace`, `src/continuity`; they remain only in the legacy QQ adapter surfaces (Advanced). Test: `test-architecture`. |
| Docs must not claim missing features | `PROJECT_STATE.md` is the authoritative status source; this audit marks unverified items explicitly. UX v2 uses the Rust-hosted WebView2 shell; no Tauri/Electron runtime or production localhost server is allowed. |

## Native shell boundary

- The shell starts and supervises the Core (`Supervisor`), connects to the per-instance named pipe
  and never speaks HTTP for management operations.
- WebView2 loads the bundled `resources/desktop-ui/` assets under the `https://cetamesh.localhost`
  app origin. Renderer calls are limited to typed `ui.*` DTOs and native picker/external-link routes;
  production CSP denies remote navigation and network connections. `--dev-ui-url` is accepted only
  by debug builds at `http://127.0.0.1:5173`; `--ui=legacy` remains an explicit migration fallback.
- The system tray owns show/hide/restart/logs/quit plus live Core status and "needs attention".
  Closing the window hides to the tray by default; Core and running tasks keep going. Only the
  explicit quit path stops Core.
- Window preferences and theme/zoom are persisted in `state/desktop-ui.json` (atomic replace);
  a corrupt preference file falls back to defaults without blocking startup.
- `main_webview.rs` owns the main child WebView's physical client bounds. The host resynchronizes
  them on resize, move and DPI changes, and forwards parent focus. This deliberately avoids Wry
  0.55.1's shared parent auto-resize subclass, which is removed when a reference child is dropped.
  The opt-in `test-main-webview-smoke` checks the actual WebView2 controller and container after
  preview destruction, resize, maximize, restore and a second resize; enable it with
  `WHALEBRIDGE_TEST_REFERENCE_BROWSER=1` through `npm test`.

### Docked reference viewer

The Harbor renderer owns up to eight ephemeral reference tabs and the resizable dock.
`ui.preview.open/read/close` resolve a persisted message reference or Task/Artifact identity
through Core. New messages retain `sourceWorkspaceId`; legacy local references without that
attribution fail explicitly instead of borrowing the current workspace. Text is limited to
2 MiB, supported raster images to 10 MiB, and base64 chunks to 64 KiB raw bytes. Handles expire
after two minutes and revalidate source authority and file identity on each read. HTML and SVG
are never executed as local web pages; unsupported formats retain the existing system-open policy.

`reference_browser.rs` owns one active, incognito child WebView with no application IPC,
host objects or internal resource protocol. The main renderer CSP remains unchanged. Native
URL policy validates navigation and all resource request source kinds, rejecting local literal
addresses and privileged schemes. Popups, downloads, permissions and file pickers are disabled.
This policy is not a DNS or operating-system network sandbox. The child hides for renderer
overlays and host dialogs, and is destroyed on tab/route closure. Generation-scoped source,
title, error and authoritative navigation-history events update the renderer toolbar.

Regression entry points are `npm test -- --suite test-reference-preview --suite test-reference-viewer`
and opt-in `test-reference-browser` / `test-reference-browser-smoke` through the same test runner.

The main page is an inline-size query container: cards, settings and plugin controls respond to
the available content pane, including a docked viewer, rather than only the outer window width.
Narrow reference switching requires an active tab; closing the final tab always restores the
page. `test-responsive-layout` measures Chromium geometry and mounts the production sidebar hook;
enable its local browser fixture with `WHALEBRIDGE_TEST_UI_MOTION=1` through `npm test`.

# M4.4 Core Channel runtime boundary (2026-10-18)

The formal `--worker` composes Core without importing or running Legacy Bridge.
Core Channel Service explicitly starts the optional `--qq-connector` child from
the same SEA executable. Inherited bounded stdio carries only Channel commands;
the child never receives Owner IPC credentials or constructs Core stores.

Ingress is account-bound and allowlisted, then durably accepted into the Channel
delivery records using the existing Storage Primitive. Each trusted Core
consumer has an independent cursor and acknowledgement. In-flight work becomes
outcome-unknown after restart; only Owner evidence can authorize replay. These
records are domain delivery/receipt state, not a second subscription bus: existing
Core UI events notify observers and existing Agent Event Journal remains intact.

All product QQ writes use Core Capability Broker, Approval and the sole QQ
Runtime sender. Runtime retains the existing account lease and durable send
ledger. Bionic is a separately managed policy child using Channel read/send
facades; its existing Social implementation is reused from bridge.js without
creating transport, Core or IPC listeners. Legacy-exclusive remains a compatible,
mutually exclusive host. Existing unscoped Social data blocks Bionic ownership
switching until Owner-reviewed M5 inventory and Dry Run; no migration is automatic.
