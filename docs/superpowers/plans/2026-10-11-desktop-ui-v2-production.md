# CetaMesh Desktop UX v2 Production Plan

## Goal and fixed decisions

Ship the Owner-selected **01 Harbor** UI shown in `UI_SOURCE_OF_TRUTH.md` as the sole production Desktop product UI. The five Owner screenshots are the page-level visual source. Keep the existing Node/SEA Core, Rust Host, Named Pipe IPC, service container, lifecycle, installer, and security boundaries. Replace the `egui` presentation with WebView2 + React 19 + TypeScript + Vite. Production must load bundled local assets and expose no localhost HTTP server. Do not implement or combine directions 02–05.

The implementation is authorized. Keep all work on `feature/desktop-ui-v2-production`; do not push, merge to `main`, or delete the branch before explicit Owner confirmation. Preserve all other worktrees and their dirty state.

## Phase 0 — source and branch contract

- Reconfirm branch, HEAD, worktree list, merge state, and status before edits.
- Keep `UI_SOURCE_OF_TRUTH.md` as the layout and token mapping.
- Add this implementation plan and a bounded Active Work record to `PROJECT_STATE.md`.
- Never use the older prototype's sample data or selector as production state.

## Phase 1 — secure WebView2 host and typed bridge

- Adapt the existing Rust Host to select WebView2 by default, retain only a temporary explicit legacy fallback, and allow the Vite origin only in debug builds.
- Package the Vite production bundle as the canonical local resource; keep production free of TCP listeners, HTTP servers, and Vite dependencies at runtime.
- Enforce trusted-origin navigation, deny popups/downloads/remote frames, set a restrictive CSP, and use native external-browser and file-picker routes.
- Define bounded, typed request/response/event DTOs. Rust validates source, method allowlist, request size, event names, payloads, and each projection. Never forward generic Core objects or secret values.
- Route only through existing Core IPC services. Bind actor/Owner identity at the Host/Core boundary. Retain Core capability approval and Workspace enforcement.
- Use provider/runtime notifications for event delivery. Do not add a global 500 ms poll. If an existing service cannot notify, expose a scoped subscription or report the precise unavailable state.

## Phase 2 — Harbor shell and Chat vertical slice

- Replace the design-direction chooser and mock dataset with a persistent Harbor AppShell matching the screenshot geometry: workspace sidebar, Chat/Work/Agents/Plugins navigation, recent sessions, bottom Settings/About, top breadcrumb/search/status/theme, footer, and responsive center/right context panes.
- Add shared tokens, accessible primitives, SVG icon set, Chinese locale resources, focus/keyboard behavior, loading/error/empty states, and reduced-motion behavior.
- Connect chat sessions/history/catalog/status/send/stop/retry and supported model selection to existing services. Keep streaming and long-list rendering bounded.
- Render sanitized Markdown/code, attachments via Rust native picker, compact expandable tool activity, Agent/Task progress, real artifacts, and real approval state/actions. Do not invent supported actions.

## Phase 3 — Work and Memory

- Implement Harbor task list/detail and task context card using Task Runtime, workspace metadata, artifact DTOs, activity, and only supported pause/resume/cancel actions.
- Implement saved knowledge/preferences and details/search using Memory Runtime; keep internal scope, link, and object identifiers in secondary detail.

## Phase 4 — Agents, Plugins, MCP, and integrations

- Implement the screenshot's Agents summary, filter/search, DSH/Codex/ZCode cards, and clear Ready/Needs setup/Not installed/Unavailable states. Show DSH Desktop installation separately from DSH Agent readiness.
- Implement the two-column Plugin Center catalog, search/categories/installed/updates, plugin details and secondary settings against Plugin Center, Extension, Integrations, Bionic Chat Tools, and MCP services.
- Gate absent backend operations honestly. Keep risky installation, permission changes, and tool invocation under current Capability Broker approval.

## Phase 5 — Settings, About, Update, First Run, native integration

- Match screenshot Settings and About layouts; integrate existing settings description/update, About, release manifest, update checker/notes, onboarding, and approved external links.
- Keep secret fields masked; never project paths, provider secrets, agent tokens, private keys, MCP secrets, or plugin secrets.
- Add native file/folder dialog and safe drag/drop attachment flow. Keep system window chrome and lifecycle behavior.
- Make feedback/bug/feature/security entry points open only validated HTTPS product URLs in the system browser with the version/build/platform allowlist.

## Phase 6 — tests, packaging, and evidence

- Add bridge/UI/asset/security regression suites first and register every new `scripts/test-*.mjs` in `scripts/run-all-tests.mjs`.
- Use only the repository's `npm test` test entry. Run the requested UI type/build checks, `desktop:check`, `desktop:build`, `build:release`, and release candidate checks where the clean-commit and Windows environment permit. Do not claim unavailable native DPI/installer/real-provider paths passed.
- Capture Harbor screenshots at the requested resolutions/scales where possible and record manual-only acceptance separately. Verify long chat, keyboard navigation, loading/empty/error, external navigation, redaction, CSP, no-HTTP, and packaged assets.
- Add `UI_FIDELITY_CHECKLIST.md` and `DESKTOP_UI_V2_PRODUCTION_REPORT.md` with the complete backend/UI/integration/tested matrix and real blockers.
- Retire production egui only after all specified parity gates are proven; otherwise leave it as a documented temporary fallback and report the blocker rather than falsely claiming removal.
- Verify final branch status, HEAD, diff, root `npm test`, and release evidence before reporting. Keep the branch for Owner review. Merge/delete only after the Owner confirms.

## Acceptance gates

1. The five supplied screenshots are recognizably and consistently implemented in Harbor tokens and geometry, with production state replacing prototype labels/data.
2. Chat, approvals, tasks, memory, agents, integrations, plugins, MCP, settings, about, update, onboarding, and feedback links are connected to existing services or shown as explicitly unavailable.
3. Renderer access is narrow, typed, origin-bound, bounded, secret-safe, and cannot navigate privileged content to remote sites.
4. Release startup is offline and local-asset-only; no UI HTTP listener or dev server ships in production.
5. Installer, tests, reports, and residual limitations are accurately recorded on the isolated branch.
