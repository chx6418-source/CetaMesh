# CetaMesh Desktop UX v2 Final Production Closure

## Status

Owner approved the recommended in-place, test-first closure path on 2026-10-12. This document is the design for the next implementation phase; it is not a claim that the listed work has been implemented or accepted.

## Goal

Close the remaining locally verifiable 01 Harbor production-parity gaps, preserve the current Rust Host / WebView2 / React / Core service boundaries, and produce one release candidate whose manifest identifies the final source commit. The five Owner screenshots remain the only visual source of truth.

## Fixed constraints and non-goals

- Continue on `feature/desktop-ui-v2-production`; do not modify another checkout, push, publish Stable, merge, or delete this branch/worktree without Owner confirmation.
- Do not redesign Harbor, add another UI direction, migrate to another framework, or refactor the overall architecture.
- Keep React on the existing typed `ui.*` projection, Rust Host on native file/browser/window actions, and business behavior in existing Core domains and services.
- Use local fixtures for deterministic tests, but label fixture evidence separately from real-provider or external-service acceptance. No fixture result can satisfy the real Provider requirement.
- Keep unsupported operations visibly unavailable/deprecated instead of fabricating success or enabling a fake button.
- Keep new test scripts registered with `scripts/run-all-tests.mjs`; the canonical aggregate entry is `npm test`.
- Do not expose provider, agent, MCP, plugin, device, or extension secrets in React state, DTOs, logs, reports, or screenshots.

## Baseline facts

- Feature branch HEAD is `2fcbf4ca299ca063ae76757015c4845b9b8afe6b`; the worktree is clean.
- The existing build-1057 `build-info.json` records `sourceCommit=f822667e92d718e69ef005e1da83af934ec8e317` and `dirty=false`.
- The only paths changed from `f822667` to current HEAD are reports/state, the visual-acceptance record, and `release/version.json`. The version source changed from build number 1056 to 1057, so build-1057 does not meet the new requirement that the final candidate identify the final HEAD.
- `scripts/build-release.mjs` records the pre-build HEAD and cleanliness, builds `release/version.json`'s next number, then increments the version counter after publishing. The final release therefore must be built from a clean detached checkout of the final feature commit; retain that build checkout for review so the active feature worktree stays clean and the artifact's `sourceCommit` remains the committed HEAD.
- Current parity evidence reports a 200-message maximum for one history request, no safe Artifact open action, no ordinary Extension settings schema page, no configured feedback base URL, and no full visual/DPI acceptance.

## Selected approach

Implement the closure incrementally inside the existing domains and bridge contracts. Add or extend narrowly scoped tests before behavior changes. Use the installed local runtime and test-only local fixtures to exercise the real Core paths. This limits cross-domain changes and keeps security behavior under existing Workspace, Capability Broker, Extension, and native-host enforcement.

The alternative of creating a shared production mock/runtime layer is rejected because it would blur the boundary between test fixtures and shipped behavior. Narrowing this turn to only Chat/Tool/Approval would leave requested local gaps unaudited, so it is not the selected scope.

## Workstreams and behavior

### 1. Chat, Provider, Tool Calling, Approval, and Agent status

- Build a test-only local OpenAI-compatible Provider fixture that drives the existing Model Runtime and Chat service. Cover a plain response, streaming chunks, stop/cancel, structured provider error, retry, and secret redaction through the real service composition path.
- Keep real credential acceptance separate. If no real Provider credential is configured, record real plain-chat/streaming acceptance as `NOT_RUN_ENVIRONMENT`; never print or persist the key in test output.
- Exercise a safe declared capability through Model tool call → Capability Broker → fixture executor → result → model continuation → Harbor projection. The fixture must not call QQ, mutate the user's workspace, or run arbitrary processes.
- Exercise pending approval through the typed UI projection and real approval runtime. Approve Once must execute the safe fixture and continue the model turn; Reject must produce the structured rejection result and continuation. Cover Pending, Approved, Rejected, and Expired state transitions.
- Probe DSH, Codex, and ZCode from the current Agent Registry. Use their actual installed/readiness state in the product; test fixtures may assert unavailable/needs-setup paths without presenting them as available providers.

### 2. Local MCP and Plugin package lifecycle fixtures

- Use a local MCP server fixture and the existing MCP Registry/Host to cover register, tool discovery, enable/disable, invocation, restart, and error recovery. Verify redacted config projection and Capability Broker enforcement. Keep real SnowLuma/gateway execution in the external environment suite.
- Use a loopback-only local Catalog fixture and a test package to exercise catalog/detail, download, SHA-256 verification, manifest validation, permission review, install, enable, update, rollback, and uninstall through the existing Plugin Center and Extension Installer. The shipped UI must report online catalog unavailability honestly when no production Catalog URL is configured.

### 3. Safe Artifact opening and Extension settings

- Add a typed open request based on a CetaMesh-owned Artifact identity, never an arbitrary renderer-supplied path or URL. Resolve the selected file with `realpath`, verify it is an authorized Workspace artifact or CetaMesh-owned artifact, reject symlink/junction escape, reject unsupported schemes, and require the file to exist.
- Restrict local opens to documented safe content types. Do not invoke a shell command, arbitrary executable, script, `javascript:`, or an arbitrary HTTP URL. External links use the existing system-browser route plus allow/confirmation policy.
- Render ordinary Extension settings from its validated manifest/schema. Support boolean, string, number, enum, and secret-reference fields that the Core schema actually declares. Secret values remain in private storage; the renderer sees only safe metadata. Hide the settings action when a package declares no settings schema.

### 4. Models, Feedback, and Bionic inventory

- Derive Advanced Model fields from supported Provider metadata/configuration. Keep Provider, API Key, Model, and Test Connection in the basic view; expose Base URL, Reasoning, Timeout, and other fields only when that Provider supports them. Preserve password and single-IPC secret handling.
- Keep Feedback/Bug/Feature/Security as system-browser links with only version/build/platform query fields. Resolve them through the existing centralized product URL configuration (`src/product/release-config.js` / `feedback.baseUrl`), not scattered page constants. The inspected configuration currently has no official feedback base; if no verified destination exists, preserve the safe unavailable state and report the unresolved product URL as a blocker rather than inventing one.
- Make the Bionic inventory explicit: 46 restored tools, 5 partial, and 2 retired unsupported. Verify each actual state against the registry. Show retired tools as deprecated and identify a replacement only if an actual replacement exists. Do not claim unsupported process-control tools were restored.

### 5. Long Chat history and content

- Extend the existing Chat history service/typed DTO with bounded pagination, retaining a maximum page size of 200. Keep the renderer on the existing virtual-list primitive and preserve scroll anchoring while loading earlier pages and appending stream updates.
- Exercise 100-, 200-, and 500-message conversations without rendering all 500 messages at once. Measure history paging, scroll position, streaming interaction, and memory. Include long Markdown, a large code block, an overlong URL, and dense Tool/Agent cards. Do not claim performance acceptance without measurements.

### 6. Manual visual, keyboard, window, and upgrade acceptance

- Use the installed production UI and isolated fixture data to inspect First Run, Chat, Work, Memory, Agents, Plugins, Settings, and About against the supplied Harbor images. Record per-page PASS/FAIL and screenshots.
- Attempt the requested client sizes 1280×720, 1280×800, 1366×768, 1920×1080, and 2560×1440 and actual Windows scaling 100%, 125%, 150%, and 200%. Distinguish full-window capture from client-area dimensions. If the current display/monitor configuration cannot provide a requested state safely, record that state as NOT_RUN with the concrete environment reason.
- Check overflow, scroll, alignment, spacing, fonts, modal/dropdown/tooltip behavior, focus/hover, Tab/Shift+Tab/Enter/Escape, search, composer focus, dialog focus, and keyboard Approval action. Check available contrast/ARIA/button semantics and visible focus.
- On available monitors, test move, resize, maximize/restore, minimize, Snap Layout, close-to-tray, explicit quit, and moving between different-DPI monitors. Do not claim unsupported monitor configurations passed.
- Perform one manual upgrade from the existing isolated older RC sandbox; verify install location plus Chat history, Task, Memory, Settings, Plugins, and Device Trust remain available, then launch Harbor. Keep this distinct from the already-passing automated lifecycle suite.

### 7. Final release candidate

- After implementation and reports are committed, run the complete requested checks on the final source. Ensure version mirrors and the next build number are correct before the release build.
- Build from a clean detached checkout at the final feature commit. Confirm `build-info.json` and `release-manifest.json` have `sourceCommit` equal to that exact commit and `dirty=false`; verify the build number, SBOM, and `SHA256SUMS.txt` against the generated files.
- Run release-candidate verification on that candidate. Keep the generated build checkout and candidate available for Owner review; do not alter the final feature commit after building. Mark build-1057 obsolete in the release notes/report and do not distribute it.
- Keep branch and worktree attached for Owner review. No push, Stable publication, merge, or cleanup is included in this design.

## Test and evidence policy

- Write regression coverage first for each local behavior. New `scripts/test-*.mjs` files must be registered in `scripts/run-all-tests.mjs` and run through `npm test`; use the repository's established Cargo suites for Rust checks.
- Local fixtures must bind only to loopback, use unique per-suite temporary directories, clean up only their own process tree, and produce deterministic outputs. A suite may not change the user's real provider config or contact a production endpoint.
- Keep outcomes distinct: `PASS` for executed local behavior, `NOT_RUN_ENVIRONMENT` for an unavailable real external dependency, `BLOCKED` for a missing required product decision such as an official Feedback destination, and `PARTIAL` where only some states are proven.
- Update `UI_V2_PRODUCTION_PARITY.md`, `UI_V2_VISUAL_ACCEPTANCE.md`, `DESKTOP_UI_V2_PRODUCTION_REPORT.md`, and `PROJECT_STATE.md` from observed evidence only.

## Completion gates

1. All locally runnable fixture-backed Core/UI paths above have regression coverage and pass in the aggregate test suite.
2. Security boundaries reject path escapes, unsupported file types/schemes, permission bypass, and secret projection.
3. UI parity entries reflect tested capability accurately; real Provider and unavailable external services remain explicitly NOT_RUN when credentials/services are absent.
4. Visual, accessibility, window, performance, and manual upgrade records contain actual evidence and preserve Harbor's existing direction.
5. The only final RC candidate is built from a clean checkout at the final feature commit with matching source commit and `dirty=false`.
6. The feature branch remains unpushed and retained pending Owner review and confirmation.
