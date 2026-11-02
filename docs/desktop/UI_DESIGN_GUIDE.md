# Harbor Desktop UI conventions

The maintained Desktop presentation is Harbor. Extend `desktop-ui/src/theme/tokens.css`,
`global.css` and existing primitives; do not introduce a parallel theme or store.

## Visual structure

- Use the existing warm neutral surfaces, sage accent, semantic success/warning/danger,
  spacing and radius tokens. Light, dark and system modes use the same component structure.
- A page has one heading, a short explanation and its principal action. Search/filter controls
  precede the data. Cards summarize; details, diagnostics and advanced configuration expand on demand.
- Use `Button`, `IconButton`, `Input`, `Textarea`, `SearchInput`, `Select`, `Tabs`, `Badge`,
  `Surface`, `Card`, `Dialog`, `Sheet`, `Tooltip`, `Popover`, `LoadingState` and existing empty/error
  presentations. Native file inputs may remain hidden implementation controls. Custom navigation,
  switches and Composer inputs retain their established accessible semantics and styles.
- A button must perform its stated action or disclose why it is unavailable. Busy, failed,
  pending approval, completed and unknown are different states. Disabled controls do not imply success.

## Page patterns and state contracts

Use the existing components to fit the task:

- **Index and detail** for Tasks, Memory, Agents and Plugins: keep the selected identity,
  search context, return position and error recovery clear.
- **Conversation and context** for Chat and Simulation: keep composing primary, and show
  usage, activity and permissions in bounded disclosures. Unknown usage stays unknown.
- **Settings and diagnostics** for configuration: group edits, save explicitly and retain
  drafts after failures. Installed, configured, authenticated and executable are distinct.
- **Review and evidence** for Tasks, Workspaces and Artifacts: show observed changes and
  verification before Owner acceptance, using the existing DiffViewer and capability routes.

Show loading, empty, ready, pending approval, failed, unknown and degraded/offline states
according to the relevant Core DTO. An error or denied permission is not an empty result;
unknown side effects remain subject to the existing recovery and approval boundaries.
Preserve request generation, Task revision, Agent assignment and Workspace scope across
asynchronous refreshes. Reuse the existing local draft state and virtual lists.

## Navigation and detail

The rail keeps Chat, Tasks/Workspace, Memory, Agents, Devices, Plugins, Settings and About.
Workspaces and sessions remain in the collapsible panel. Ctrl+K opens a keyboard-searchable quick
jump, reusing the Core's existing local search; it is not a new task or search database.

`Sheet` owns dialog semantics, focus entry/containment/return and Escape for the topmost drawer.
`Dialog` uses the browser's native modal mechanism. Avoid stacked drawers for ordinary configuration.
Preserve input and scope/revision bindings when an asynchronous operation fails.

## Work and evidence

- Task cards show actual executor, project, status, known progress, approvals and artifacts.
  Missing progress remains unknown. Agent completion is not Owner acceptance.
- Task details group goal, result review, collaboration, evidence and recovery while preserving
  the existing Core callbacks and authorization. Internal IDs belong in diagnostics disclosures.
- Chat usage is a concise expandable summary retaining incomplete/unknown cost and token fields.
  Tool activity remains accessible in bounded groups. The message composer is visually primary;
  attachment limits and advanced options are not permanent banners.
- Text drafts live per Session in the existing process-local UI state, survive page changes,
  and clear only after a successful send of the same text. They are not persisted across
  application restart or written to long-term Memory. Attachment recovery remains Core-owned.
- Git and Task review use the same inert `DiffViewer`, Unified/Split views, exact file path reads,
  bounded DOM and explicit truncation. Current workspace changes may include other tasks and user edits.
  The UI never relabels all current changes as a particular Task's verified output.
- Git file selection is a commit scope, not Git staging. When no authorized staging executor exists,
  show an unavailable reason instead of inventing a privileged command route. AI explanation prepares
  an ordinary Chat draft for review; it does not send a model request automatically.

## Configuration and state

Plugin enabled, process running, runtime discovered and callable are separate observations.
Credentials stay masked and use existing controlled storage. Memory keeps source, Scope, revision,
validity and correction history. Device trust does not grant capabilities; online presence cannot
stand in for environment or Guest test evidence. Settings search covers actual schema fields,
and saving one group preserves other unsaved edits and edits made during the request.

## Windows frame and validation

Windows uses the native caption, icon, system buttons, resizing and system menu. Fixed DWM theme
attributes harmonize its caption, text, border and corner preference with Harbor; unsupported
attributes fall back to Windows drawing. The pre-boot native-chrome flag removes the HTML titlebar
and its layout row, preventing duplicate controls. The small client-drawn chrome remains a fallback.
No arbitrary window command, color or process target is accepted from the renderer.

Native caption choice preserves the OS-owned behavior described by
[Microsoft's Snap guidance](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-snap-layout-menu)
and [DWM window attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).
Availability of Snap UI still depends on Windows settings and real manual/native acceptance.

Verify real rendered pages in 1024×768, 1280×800, 1440×900 and 1920×1080, with light/dark themes
and 125/150% content scale. Content zoom, emulated DPR, application zoom and actual Windows DPI
are distinct evidence. Test keyboard focus, dropdown/dialog bounds, long text and bounded large
lists. TypeScript, source tests and browser fixtures do not replace native WebView2 acceptance.
Keep screenshots and internal acceptance records in the private development archive.

## Startup and runtime diagnostic presentation

Startup PASS stays quiet. DEGRADED uses one compact affected-check entry; BLOCKED uses an
independent diagnostic surface before normal pages are mounted. A later runtime block keeps
existing mounted UI drafts inert and hidden until a current-generation check admits work.
Settings/About and important fault banners expose the same system diagnostics and developer
feedback controls. Details progressively show module, timeout versus failure, fixed code,
remediation, version/build and unknown-effect status. History/export and browser failures keep
the current report. Do not show installation, registration or an old PASS as current readiness.
