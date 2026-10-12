# Desktop UX v2 Manual Acceptance and Final RC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture honest manual acceptance evidence and build one release candidate whose source manifest matches the final committed feature-branch HEAD.

**Architecture:** Validate the existing Harbor app and native shell as packaged. Update reports only from observations. Build the final candidate from a clean detached checkout at the final feature commit so the build counter mutation cannot alter that commit.

**Tech Stack:** Windows WebView2/Rust Host, React production bundle, Cargo, Node.js test aggregator, release builder and RC verifier.

**Spec:** `docs/superpowers/specs/2026-10-12-desktop-ui-v2-final-production-closure-design.md`

## Global Constraints

- `Persistent JSON reads and writes must go through src/storage/json-file.js; error-code mapping stays in the owning Domain.`
- `Any new empty catch must include an explanation comment.`
- `Continue on feature/desktop-ui-v2-production; do not modify another checkout, push, publish Stable, merge, or delete this branch/worktree without Owner confirmation.`
- `Do not redesign Harbor, add another UI direction, migrate to another framework, or refactor the overall architecture.`
- `Keep React on the existing typed ui.* projection, Rust Host on native file/browser/window actions, and business behavior in existing Core domains and services.`
- `Use local fixtures for deterministic tests, but label fixture evidence separately from real-provider or external-service acceptance. No fixture result can satisfy the real Provider requirement.`
- `Keep unsupported operations visibly unavailable/deprecated instead of fabricating success or enabling a fake button.`
- `Keep new test scripts registered with scripts/run-all-tests.mjs; the canonical aggregate entry is npm test.`
- `Do not expose provider, agent, MCP, plugin, device, or extension secrets in React state, DTOs, logs, reports, or screenshots.`
- `Do not push, publish Stable, merge, or delete the feature branch/worktree without Owner confirmation.`

## Review Focus

- A requested resolution or DPI scale is unavailable; record `NOT_RUN` with the actual display reason in `UI_V2_VISUAL_ACCEPTANCE.md`.
- Actual WebView client-area size differs from window bounds; record both measurements and screenshot dimensions.
- A keyboard-only path loses focus or cannot decide approval; record the exact page/key sequence and screenshot.
- The last known good upgrade sandbox is unavailable; record the missing baseline and do not call upgrade acceptance PASS.
- Release build updates the detached checkout's build counter after packaging; verify artifact source commit and branch cleanliness separately.

---

### Task 1: Manual Harbor, accessibility, and long-content acceptance

**Files:**
- Modify: `docs/desktop/UI_V2_VISUAL_ACCEPTANCE.md`
- Modify: `docs/desktop/UI_V2_PRODUCTION_PARITY.md`
- Evidence: screenshots from the final packaged UI, stored under the approved acceptance evidence directory

- [ ] **Step 1: Open the packaged final Harbor build** with isolated fixture data and inspect First Run, Chat, Work, Memory, Agents, Plugins, Settings, and About against the five supplied screenshots.
- [ ] **Step 2: Record exact PASS/FAIL/NOT_RUN per page** and capture each result without including secrets or personal data.
- [ ] **Step 3: Attempt client sizes 1280×720, 1280×800, 1366×768, 1920×1080, 2560×1440 and Windows scales 100%, 125%, 150%, 200%;** record client-area and full-window dimensions separately.
- [ ] **Step 4: Check overflow, scroll, alignment, typography, modal/dropdown/tooltip behavior, visible focus, Tab/Shift+Tab/Enter/Escape, composer focus, dialog focus, and keyboard approval;** record actual steps and outcomes.
- [ ] **Step 5: Check available contrast, ARIA names/roles, reduced-motion behavior, hover/focus, and 100/200/500-message layouts;** record measurements and concrete environment limitations.

### Task 2: Native window and manual upgrade acceptance

**Files:**
- Modify: `docs/desktop/UI_V2_VISUAL_ACCEPTANCE.md`
- Modify: `docs/desktop/DESKTOP_UI_V2_PRODUCTION_REPORT.md`

- [ ] **Step 1: On available monitors, try move, resize, maximize/restore, minimize, Snap Layout, close-to-tray, explicit quit, and cross-DPI monitor movement;** record each unsupported monitor condition as `NOT_RUN`.
- [ ] **Step 2: Upgrade an isolated sandbox from the last known-good RC older than build-1057** and verify install location plus Chat history, Task, Memory, Settings, Plugins, Device Trust, then launch Harbor.
- [ ] **Step 3: If no suitable older sandbox or monitor state exists, record the concrete reason as `NOT_RUN`;** do not substitute an automated lifecycle test for manual acceptance.

### Task 3: Final verification and release candidate

**Files:**
- Modify: `docs/desktop/UI_V2_PRODUCTION_PARITY.md`
- Modify: `docs/desktop/UI_V2_VISUAL_ACCEPTANCE.md`
- Modify: `docs/desktop/DESKTOP_UI_V2_PRODUCTION_REPORT.md`
- Modify: `PROJECT_STATE.md`
- Release output: unique directory under `artifacts/rc/`

- [ ] **Step 1: On the final source worktree, confirm the feature branch is clean and run** `npm test`, `cargo check --manifest-path desktop-shell/Cargo.toml`, `cargo test --manifest-path desktop-shell/Cargo.toml`, `npm run build:ui`, `npm run desktop:build`, and `npm run build:core`; record command output and environment skips.
- [ ] **Step 2: Confirm release version mirrors and the next build number** before building; verify no final source edits remain uncommitted.
- [ ] **Step 3: Create a clean detached build checkout at the final feature commit and run `npm run build:release` there.** Retain this checkout because the builder increments its local release counter after producing the candidate.
- [ ] **Step 4: Run `npm run test-release-candidate`** against the unique final RC directory.
- [ ] **Step 5: Verify** `build-info.json.sourceCommit` and `release-manifest.json.sourceCommit` equal the exact final feature commit, `dirty=false`, and SBOM/`SHA256SUMS.txt` match generated files; keep build-1057 marked obsolete and undistributed.
- [ ] **Step 6: Update reports and `PROJECT_STATE.md` from measured evidence, verify the active feature worktree remains clean and unpushed, and retain the branch/worktree/candidate pending Owner confirmation.**
