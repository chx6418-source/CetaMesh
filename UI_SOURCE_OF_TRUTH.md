# CetaMesh Desktop — production UI reference

Current product direction: **01 Harbor / 纸面工作台**. This is the selected production design, not a catalog of interchangeable legacy themes.

## Authoritative maintained source

1. desktop-ui/src/app/HarborApp.tsx and desktop-ui/src/app/harbor.css: actual desktop React/WebView2 UI and layout.
2. desktop-ui/src/theme/ and desktop-ui/src/main.tsx: live visual tokens, typography and bootstrapping.
3. desktop-shell/src/theme/: native Rust/egui theme, painting and transition logic.
4. Relevant product and architecture contracts in docs/desktop/ARCHITECTURE.md and tests in scripts/test-desktop-ui-v2-production.mjs.

The earlier HTML prototypes, exploratory screenshot galleries, color tests and ten-theme mockups are retained in a private development archive. They are historical references only; no build or release may depend on them. Historical local absolute image paths and obsolete alternatives must not be treated as source-of-truth links.

## Visual and interaction invariants

- Chat and its composer are the primary interaction. Tools, model and Agent settings use progressive disclosure rather than dominating the main screen.
- Preserve clear navigation for work, memory, agents and plugins; task/context state must reflect actual Core data.
- Show asynchronous activity, tool results and approvals separately from normal text, with real pending/success/error states.
- Keep a consistent warm paper/sage direction (including background around #f1f0ea, text around #2e3630, accent around #75937b), accessible contrast, keyboard focus and reduced-motion behavior.
- Do not introduce sample records as real user state, or re-enable discarded prototype themes by default.
- Preserve native window behavior, file dialogs, IPC permissions and settings persistence.

## Change control

Update the actual maintained UI files and their tests when refining the design. Old mockups must not be reintroduced merely as implementation dependencies. Full visual approval still requires an actual application render and appropriate manual review; static tests alone do not establish visual fidelity.
