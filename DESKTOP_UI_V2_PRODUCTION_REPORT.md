# CetaMesh Desktop UX v2 Production Report

Date: 2026-10-12
Owner-selected visual direction: **01 Harbor**
Review state: implementation is on an isolated branch and awaits Owner review.

## Current closure addendum (2026-10-13)

Task 1 history paging is committed as `75f549f1ee90943362de27e93c49fe1f83cdbb12`. Task 2 Harbor Chat virtualization is committed as `d1b114834b8f88ace439b1f4aff0e0353bcdc56e`.

| Current check | Result |
| --- | --- |
| `npm run build:ui` | PASS — TypeScript and Vite; JS 529.28 kB / gzip 161.88 kB, CSS 39.59 kB. The >500 kB chunk warning is recorded as non-blocking; gzip remains 161.88 kB. |
| `npm test -- --category architecture --category runtime` | PASS — 44 suites, 0 FAIL, 0 NOT_RUN_ENVIRONMENT. |
| `npm test` | PASS — standard run: 98 suites, 92 PASS, 0 FAIL, 6 NOT_RUN_ENVIRONMENT (four real external environments plus the Cargo opt-in suites). Final `$env:WHALEBRIDGE_TEST_CARGO='1'; npm test`: 98 suites, 94 PASS, 0 FAIL, 4 NOT_RUN_ENVIRONMENT (legacy bridge, production Gateway, and network). Cargo is included and passes in this final run. The first full attempt had one 600-second desktop-shell timeout after its contract assertions logged success; the isolated desktop run and both final full reruns passed. |
| `cargo check --manifest-path desktop-shell/Cargo.toml` | PASS — existing Rust dead-code warnings only. |
| `cargo test --manifest-path desktop-shell/Cargo.toml` | PASS — 187 passed, 0 failed. |
| Chat 100/200/500 fixture | PASS — 10/101, 10/201, 10/501 initial rows; 10 bottom rows in each fixture; streaming row visible; dynamic measured heights update virtual totals. |

Manual browser/window comparison, requested dimensions and DPI, keyboard/accessibility walkthrough, manual scroll behavior and real DOM memory remain **NOT_RUN_ENVIRONMENT** because `interactive browser/window inspection unavailable in current execution environment`. Automated evidence does not imply visual PASS. Real Provider credentials and production gateways remain environment-gated. `feedback.baseUrl` is empty, so feedback links remain disabled/BLOCKED.

The exact final source HEAD, version/build, artifact SHA256, release audit, Cargo/desktop/Core build results and release-candidate verification are recorded in `FINAL_PRODUCTION_CLOSURE.md` in the retained detached build checkout. Build-1057 is historical and must not be distributed. The candidate remains unsigned and is not public-release ready until signing and redistribution-license requirements are satisfied.

## Delivered architecture

The production desktop entry now renders the selected Harbor React 19 / TypeScript / Vite UI in the existing Rust WebView2 shell. The implementation keeps the Node/SEA Core, service container, per-instance named-pipe protocol, installer, supervisor, system tray, workspace boundary and Capability Broker. The egui UI is still available only through the explicit `--ui=legacy` fallback.

The renderer is organized around Chat, Work, Memory, Agents, Plugins, Settings, About and onboarding. It uses real, bounded desktop DTOs through `src/desktop/ui-service.js` and `desktop-ui/src/bridge/typed-client.ts`; it does not read Core files or receive generic Core objects. Chat context exposes task, memory, approval and artifact metadata. Task creation now projects the Task Runtime's actual DTO and publishes its update event. Bionic is listed with its 53 individually managed tools. Plugin, integration and MCP actions continue through existing review and permission rules.

## Local Agent Registry observation

At 2026-10-12 20:19 China Standard Time, the product Agent Registry `agent.list` was queried with the active local source configuration. The probe performed provider health/readiness checks and local DSH Desktop detection only.

| Provider | Observed state | Evidence |
| --- | --- | --- |
| DSH Agent | Unavailable (`not_connected`) | The loopback `settings/describe` health check could not connect. No DSH Agent task was run. |
| DSH Desktop | Installed, not running; version `0.2.0-rc.2` | Desktop detection is reported independently from Agent readiness. |
| Codex | Ready (`codex-cli 0.162.0-alpha.17.2`) | Local CLI compatibility and login-state checks passed. No Codex task was run. |
| ZCode | Unavailable (`unsupported_external_control`) | The desktop app is detected, but the product has no supported external Agent control interface. |

This is a single-machine health snapshot, not Agent task, Chat provider, gateway, or multi-session acceptance. No Agent task or external Agent action was executed.

In production the Rust host serves the bundled `desktop-ui/dist` files from the `resources/desktop-ui` payload under `https://cetamesh.localhost`. The host validates message source and exact method names, caps bridge payloads, denies remote navigation, popups and downloads, and sets a restrictive CSP. Production has no renderer HTTP server or remote asset dependency. The Vite origin is a debug-only option.

The host now loads and atomically saves `state/desktop-ui.json` for zoom, close behavior and window geometry, while retaining the v1 theme field for the egui fallback. Legacy shell theme identifiers normalize to the supported `paper` value; Harbor's active theme is instead read from Core `general.theme`. The host restores logical position/size, applies WebView2 zoom, saves geometry during normal use and exit, and preserves the default close-to-tray behavior. WebView2's mutable browser profile lives at `<user-data-dir>/webview2`, so the installed program directory stays read-only. Core and running tasks continue when the window is hidden.

## Verification evidence

| Command / suite | Result |
| --- | --- |
| `npm ci --offline --prefix desktop-ui` | PASS — locked renderer dependencies installed; 0 reported vulnerabilities. |
| `npm run build:ui` | PASS — TypeScript and Vite production bundle built for build-1057 (JS 490.94 kB / gzip 150.50 kB; CSS 37.34 kB). Vite reported the React Router `use client` directive warning only. |
| `npm run desktop:build` | PASS — release Rust/WebView2 shell built with the user-data profile fix; Cargo emitted 15 existing warnings, no errors. |
| `npm run build:release` | PASS — formal clean-source `1.0.0-rc.2-build1057+f822667`, `dirty=false`; 142.9 MB package, SHA256SUMS, manifest and SBOM generated; 139 SBOM components; release audit found no forbidden files, build-machine paths or credentials. |
| `$env:WHALEBRIDGE_TEST_CARGO='1'; npm test` | PASS — latest run: 96 suites: **92 PASS, 0 FAIL, 4 NOT_RUN_ENVIRONMENT**. Includes Harbor projection contracts, Core DTO checks, Cargo check/tests, desktop shell, installer lifecycle and the formal release-candidate suite. |
| Desktop lifecycle portion of `test-desktop-shell` | PASS — real window/title and tray creation, persisted preferences, close-to-tray, restore through the running instance, stored 110% zoom and geometry restoration. |
| `test-desktop-install` / `test-installer-productization` | PASS in the aggregate run against the built debug shell and Core; the lifecycle suite exercised install, upgrade, repair, migration and uninstall in its isolated test sandbox. |
| `test-release-candidate` | PASS — formal build-1057 installed in a Chinese/spaced sandbox path with no system Node; Core IPC was healthy and `consolePort` refused connections; Harbor WebView2 ran from the installed Microsoft Runtime, stored its profile in the user data directory, and left the install tree unchanged. Crash recovery/backoff, single instance, Core orphan exit, uninstall and user-data preservation all passed. |

The four `NOT_RUN_ENVIRONMENT` suites were `test-console` (legacy bridge), `test-mcp-exec` (gateway), `test-mcp-web-search` (network), and `test-onebot-connection` (gateway). They are not counted as passing.

## Not verified in this run

- Partial manual capture: the isolated build-1057 fresh install opened the real Harbor first-run flow in WebView2. The observed full window capture is 1282 × 831 pixels (including its title bar) and is saved locally at `C:\Users\Administrator\.codex\visualizations\2026\10\11\01a12a6d-a0d3-7022-a6db-5eb120800fcc\harbor-first-run-window-1282x831-build-1057.jpg`. It proves only that the installed app rendered its first-run screen; it is not a reference comparison or a passed page acceptance.
- Manual visual acceptance remains **NOT_RUN** for the five supplied reference screenshots, Chat/Work/Memory/Agents/Plugins/Settings/About, requested client-area sizes, true Windows DPI scales, keyboard navigation, and loading/error/empty states. First Run requires a real provider API key and successful connection before the main pages are reachable; no credential was entered and no mocked provider success was used. See `UI_V2_VISUAL_ACCEPTANCE.md` for the matrix and capture limits.
- Real OneBot, SnowLuma, external MCP execution and real provider credentials were not exercised by the environment-gated suites.
- 100/500 message performance, long Markdown rendering and dense tool-event timing were not measured; the current single history DTO is bounded at 200 messages.
- Capability completeness and known Core/configuration gaps are recorded in `UI_V2_PRODUCTION_PARITY.md`; artifact open is not exposed, feedback has no configured base URL, some advanced provider / Extension settings are partial, and code-signing plus redistribution license material are still required before public distribution.

## Review and integration

- Worktree: `C:\Users\Administrator\.codex\worktrees\desktop-ui-v2-production\GIT-QQ-BRIDGE`
- Branch: `feature/desktop-ui-v2-production`
- Base: `2b2e0d98cea97b979290417d9fc3fe4623cd780c`
- Integration status: formal release build and isolated installer candidate acceptance are complete on the feature branch. No push, merge, or branch/worktree deletion has been performed. Keep the branch for Owner review. Merge and cleanup remain gated on the Owner's explicit confirmation.

Only `artifacts/rc/1.0.0-rc.2/build-1057` is the verified candidate from this turn. The earlier build-1056 package was produced before the updated shell binary was rebuilt and is superseded; do not distribute it.

See `UI_FIDELITY_CHECKLIST.md` for the screenshot-by-screenshot implementation and acceptance matrix.
