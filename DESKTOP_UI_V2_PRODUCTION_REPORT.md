# CetaMesh Desktop UX v2 Production Report

Date: 2026-10-12
Owner-selected visual direction: **01 Harbor**
Review state: implementation is on an isolated branch and awaits Owner review.

## Delivered architecture

The production desktop entry now renders the selected Harbor React 19 / TypeScript / Vite UI in the existing Rust WebView2 shell. The implementation keeps the Node/SEA Core, service container, per-instance named-pipe protocol, installer, supervisor, system tray, workspace boundary and Capability Broker. The egui UI is still available only through the explicit `--ui=legacy` fallback.

The renderer is organized around Chat, Work, Memory, Agents, Plugins, Settings, About and onboarding. It uses real, bounded desktop DTOs through `src/desktop/ui-service.js` and `desktop-ui/src/bridge/typed-client.ts`; it does not read Core files or receive generic Core objects. Chat context exposes task, memory, approval and artifact metadata. Task creation now projects the Task Runtime's actual DTO and publishes its update event. Bionic is listed with its 53 individually managed tools. Plugin, integration and MCP actions continue through existing review and permission rules.

In production the Rust host serves the bundled `desktop-ui/dist` files from the `resources/desktop-ui` payload under `https://cetamesh.localhost`. The host validates message source and exact method names, caps bridge payloads, denies remote navigation, popups and downloads, and sets a restrictive CSP. Production has no renderer HTTP server or remote asset dependency. The Vite origin is a debug-only option.

The host now loads and atomically saves `state/desktop-ui.json` for zoom, close behavior and window geometry, while retaining the v1 theme field for the egui fallback. Legacy shell theme identifiers normalize to the supported `paper` value; Harbor's active theme is instead read from Core `general.theme`. The host restores logical position/size, applies WebView2 zoom, saves geometry during normal use and exit, and preserves the default close-to-tray behavior. Core and running tasks continue when the window is hidden.

## Verification evidence

| Command / suite | Result |
| --- | --- |
| `npm ci --offline --prefix desktop-ui` | PASS — locked renderer dependencies installed; 0 reported vulnerabilities. |
| `npm run build:ui` | PASS — TypeScript and Vite production bundle built after the final source change (JS 490.94 kB / gzip 150.50 kB; CSS 37.34 kB). Vite reported the React Router `use client` directive warning only. |
| `$env:WHALEBRIDGE_TEST_CARGO='1'; npm test` | PASS — latest run: 96 suites: **91 PASS, 0 FAIL, 5 NOT_RUN_ENVIRONMENT**. Includes Harbor projection contracts, Core DTO checks, Cargo check/tests, desktop shell, installer package/productization and `test-desktop-install`. |
| Desktop lifecycle portion of `test-desktop-shell` | PASS — real window/title and tray creation, persisted preferences, close-to-tray, restore through the running instance, stored 110% zoom and geometry restoration. |
| `test-desktop-install` / `test-installer-productization` | PASS in the aggregate run against the built debug shell and Core; the lifecycle suite exercised install, upgrade, repair, migration and uninstall in its isolated test sandbox. |

The five `NOT_RUN_ENVIRONMENT` suites were `test-console` (legacy bridge), `test-mcp-exec` (gateway), `test-mcp-web-search` (network), `test-onebot-connection` (gateway), and `test-release-candidate` (release distribution artifact). They are not counted as passing. The release candidate is still pending at this report stage.

## Not verified in this run

- Manual pixel comparison of the five supplied screenshots, the Work/Memory walkthrough, renders at the requested resolutions and true Windows DPI scales, keyboard navigation, and loading/error/empty-state review were **NOT_RUN**. The app has not yet been visually accepted in a running production window; no visual acceptance claim is made. See `UI_V2_VISUAL_ACCEPTANCE.md` for the full matrix.
- `npm run build:core`, `npm run desktop:build`, `npm run build:release` and the release-candidate suite are **pending for the final source commit**. The release builder records a source commit and requires a clean worktree; the next step is a branch commit followed by the clean release build and isolated installer candidate run. Until those finish, this report does not claim a production installer result.
- Real OneBot, SnowLuma, external MCP execution and real provider credentials were not exercised by the environment-gated suites.
- 100/500 message performance, long Markdown rendering and dense tool-event timing were not measured; the current single history DTO is bounded at 200 messages.
- Capability completeness and known Core/configuration gaps are recorded in `UI_V2_PRODUCTION_PARITY.md`; artifact open is not exposed, feedback has no configured base URL, some advanced provider / Extension settings are partial, and code-signing plus redistribution license material are still required before public distribution.

## Review and integration

- Worktree: `C:\Users\Administrator\.codex\worktrees\desktop-ui-v2-production\GIT-QQ-BRIDGE`
- Branch: `feature/desktop-ui-v2-production`
- Base: `2b2e0d98cea97b979290417d9fc3fe4623cd780c`
- Integration status: source verification is complete; release / installer acceptance is pending. No push, merge, or branch/worktree deletion has been performed. Keep the branch for Owner review. Merge and cleanup remain gated on the Owner's explicit confirmation.

See `UI_FIDELITY_CHECKLIST.md` for the screenshot-by-screenshot implementation and acceptance matrix.
