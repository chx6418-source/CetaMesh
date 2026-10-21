# CetaMesh Desktop UX v2 — UI Source of Truth

Status: Owner confirmed the 01 Harbor direction on 2026-10-11. The five screenshots attached in that confirmation are the authoritative page-level reference for this production implementation.

## Source hierarchy

1. The Owner-provided screenshots define the final visible layout and component placement:
   - Chat and task context: D:/Administrator/Pictures/Camera Roll/屏幕截图 2026-10-11 194017.png
   - Settings: D:/Administrator/Pictures/Camera Roll/屏幕截图 2026-10-11 194033.png
   - About: D:/Administrator/Pictures/Camera Roll/屏幕截图 2026-10-11 194045.png
   - Plugins: D:/Administrator/Pictures/Camera Roll/屏幕截图 2026-10-11 194112.png
   - Agents: D:/Administrator/Pictures/Camera Roll/屏幕截图 2026-10-11 194124.png
2. The repository Harbor prototype is the supporting source for its warm paper and sage visual language, lower-level page patterns, and non-screened areas: design-demos/ui-ia-exploration-2026-10/p01.html at commit 19d6002140190c543b1850b71d05ac7e509e535e. Its original screenshots are under design-demos/ui-ia-exploration-2026-10/screenshots/ as p01-<view>.png.
3. The Owner screenshots match the Harbor preview capture set produced in the prior UX v2 worktree: artifacts/ui-v2-exploration/screenshots/harbor-chat.png, harbor-agents.png, and harbor-plugins.png. Their React prototype and tokens are under desktop-ui/ in that worktree. These are implementation references only; the new production branch remains the canonical deliverable.

The earlier design README marks all directions as unselected. The Owner's 2026-10-11 confirmation supersedes that historical note: only 01 Harbor is selected. Directions 02–05 are excluded from implementation.

## Required mapping

| Product surface | Authoritative source | Implementation notes |
| --- | --- | --- |
| App shell and navigation | Owner screenshots, especially Chat; Harbor p01 for the same warm-paper language | Keep the CetaMesh header, workspace switcher, Chat/Work/Agents/Plugins navigation, recent conversation list, bottom Settings/About, global search, connection/status area, and theme control in the shown positions. Memory is reached from the Chat context panel and its “查看全部” link; do not add an unshown primary navigation item. |
| Chat home and conversation | Owner Chat screenshot; Harbor p01 home/thread screenshots for uncovered empty and conversation states | Keep the selected conversation list, breadcrumb/header, central conversation, compact tool activity, agent progress, approval card, right task-context column, and bottom composer. |
| Work | Harbor p01-work.png; Work entry/count and task context card in the Owner Chat screenshot | Use the Harbor list/detail relationship. Show real task status, progress, agent, workspace, activity, and supported actions. |
| Memory | Harbor p01-memory.png; related-memory card and “查看全部” in the Owner Chat screenshot | Open the full Memory surface from the context card. Present user-facing saved knowledge and preferences; keep object scope and links in details. |
| Agents | Owner Agents screenshot; Harbor p01-agents.png for visual tone and status chips | Show DSH, Codex, and ZCode with real availability/setup state and separate DSH Desktop app installation from Agent integration readiness. |
| Plugins catalog | Owner Plugins screenshot; Harbor p01-plugins.png for icon/card tone | Keep search, category filters, and the two-column catalog card treatment. Separate built-in integrations from ordinary extensions in their metadata. |
| Plugin detail and secondary settings | Harbor p01-plugin-detail.png; Owner Plugins screenshot for catalog-to-detail continuity | Detail includes description, developer/version, compatibility, permissions, changelog, install/update/disable/uninstall, and settings. Unsupported backend actions must be explicitly disabled. |
| Settings | Owner Settings screenshot; Harbor p01-settings.png for the earlier compact section-row pattern | Preserve the left section rail and spacious right content. Provide General, Models, Agents, Plugins, Memory, Devices, Appearance, Notifications, Privacy & Security, Advanced, and About through the existing settings hierarchy. |
| About, update, feedback | Owner About screenshot; Harbor p01-about.png | Version/build/channel and update state come from the existing version and release-manifest services. Feedback and project links use the system browser. |
| Tool activity | Owner Chat screenshot; Harbor p01-thread collaboration steps | Default to a compact status row with duration and expand affordance; expose details only on expansion. |
| Task card | Owner Chat screenshot right-side “任务详情”; Harbor p01-work.png | Show title, status, progress, agent, workspace/context, last activity, and only actions supported by Task Runtime. |
| Approval | Owner Chat screenshot “等待你的批准” card | Treat the card as a first-class stateful component with real Pending/Approved/Rejected/Expired state and runtime-backed Approve Once/Reject actions. No simulated approval. |
| Dialogs and overlays | Harbor tokens and existing native host behavior; no Owner screenshot specifies a separate dialog composition | Follow the shown surfaces, spacing, borders, focus and contrast. Native file/folder selection stays in the Rust host. |

## Harbor design tokens

The selected Harbor implementation uses the values established by its existing React prototype:

- Light surfaces: background #f1f0ea, soft background #f7f6f1, surface #fbfaf6, elevated surface #fffefa.
- Text: primary #2e3630, secondary #59645c, muted #87918a.
- Accent and state: sage accent #75937b, hover #5e8067, soft accent #e7eee7, success #498363, warning #ad783d, danger #ad5e55, info #587f9a.
- Borders: #e1e5dd and stronger #c9d1c8. Use the existing system/dark mappings for dark mode.
- Typography: Segoe UI with Microsoft YaHei UI fallback; the prototype’s standard body size is 14px.
- Shape and spacing: 9px / 14px / 20px radius scale; 4px base spacing scale; 150ms control motion and 260ms page motion; visible sage focus ring.
- Icons: consistent outline SVG set, not emoji or arbitrary Unicode symbols.

## Production interpretation

The screenshots show a prototype badge, preview-mode text, sample content, and an exploration footer. The production app keeps the screenshot’s geometry and uses real Core state in those slots; it must not claim preview/demo status or render sample records as live data. The OS window frame remains native. The screenshot’s navigation and page composition are the fixed visual target; new states extend the same components and tokens without introducing another visual direction.

## Change control

Do not implement directions 02–05, combine their layouts, or re-open visual-direction selection. If a required state has no screenshot, use the relevant Harbor component above plus the user-provided production requirements; record any unavoidable backend limitation as unavailable rather than fabricating a successful action.