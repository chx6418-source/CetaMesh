# CetaMesh Desktop UX v2 — 01 Harbor Fidelity Checklist

Status key: **Implemented** describes the current source; **Automated** describes the
repository checks that ran; **Visual acceptance** requires a manual screenshot comparison.
An automated source/contract test does not establish pixel-level fidelity.

| Owner reference | Required composition | Implementation and automated evidence | Visual acceptance |
| --- | --- | --- | --- |
| Chat — `屏幕截图 2026-10-11 194017.png` | Harbor shell, workspace switcher, Chat/Work/Agents/Plugins navigation, recent sessions, Settings/About, global search, central conversation, compact activity/progress, approval, composer and right task/memory/artifact context. | `desktop-ui/src/app/HarborApp.tsx` and `harbor.css`; real session, task, memory, approval and artifact DTOs use the typed `ui.*` bridge. `test-desktop-ui-v2-production`, `test-desktop-chat-product`, and the real-window portion of `test-desktop-shell` passed in the aggregate run. | **NOT_RUN** — no screenshot comparison was completed. |
| Settings — `屏幕截图 2026-10-11 194033.png` | Spacious content area and section rail; appearance choices; behavior; privacy/security; notifications. | Harbor Settings uses Core settings description/get/update routes; active theme is read and saved as `general.theme`, then applied through Harbor tokens. `test-product-services`, `test-desktop-ui-v2-production`, and `test-desktop-shell` passed in the aggregate run. | **NOT_RUN** — no screenshot comparison was completed. |
| About — `屏幕截图 2026-10-11 194045.png` | Brand card, version/build, developer, update status and project links. | About/version/link/update data comes from the desktop projection and existing product services; validated product links open through the Rust system-browser route. `test-product-services`, `test-feedback-links`, and `test-desktop-ui-v2-production` passed in the aggregate run. | **NOT_RUN** — no screenshot comparison was completed. |
| Plugins — `屏幕截图 2026-10-11 194112.png` | Permission notice, search/category filters, two-column catalog, install/review states, built-in integrations and MCP. | Catalog, Extension, integration and MCP DTOs are projected by `src/desktop/ui-service.js`; risk-bearing install/enable operations keep the existing review/approval path. `test-plugin-center`, `test-extension-runtime`, `test-mcp-registry`, `test-desktop-ui-v2-production`, and `test-desktop-shell` passed in the aggregate run. | **NOT_RUN** — no screenshot comparison was completed. |
| Agents — `屏幕截图 2026-10-11 194124.png` | Agent counts, availability/setup filters, search, DSH/Codex/ZCode cards and the sensitive-operation policy. | Agent inventory and health come from the typed projection; unavailable capabilities remain explicit states. `test-agent-provider`, `test-managed-agent-provider`, `test-desktop-ui-v2-production`, and `test-desktop-shell` passed in the aggregate run. | **NOT_RUN** — no screenshot comparison was completed. |

## Cross-screen implementation checks

- **Selected direction:** 01 Harbor only. Directions 02–05 are not shipped as UI variants.
- **Production asset path:** Harbor is built to `desktop-ui/dist` and bundled by the release builder under `resources/desktop-ui`; the production host uses `https://cetamesh.localhost` and does not start a UI HTTP server.
- **Renderer boundary:** the renderer calls typed, bounded `ui.*` DTO routes; origin checks, method allowlists, payload limits, CSP and secret-safe projections remain in the host/Core boundary.
- **Native lifecycle:** the window, WebView2, tray, close-to-tray default, geometry/zoom preference persistence and Core supervision remain native responsibilities. `test-desktop-shell` exercised create, close-to-tray, restore, stored zoom and geometry.
- **Theme ownership:** Harbor uses Core `general.theme`; the old shell theme field remains for egui fallback and legacy IDs normalize to the supported `paper` value.
- **Accessibility and states:** shared Harbor tokens/primitives, keyboard search, focus treatment, loading/error/empty states and reduced-motion styling are present in source. This run did not manually inspect those states in a rendered window.

## Acceptance boundary

The aggregate tests establish source contracts, Core integration and native window lifecycle behavior. They do **not** establish pixel-level screenshot fidelity, every page's visual spacing at multiple DPI scales, every empty/error state, or real external-provider behavior. Those remain manual acceptance items.
