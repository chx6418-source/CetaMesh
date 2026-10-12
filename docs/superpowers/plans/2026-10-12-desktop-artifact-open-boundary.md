# Desktop Safe Artifact Opening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe Harbor Artifact open action that accepts CetaMesh task/artifact identities and never accepts a renderer-supplied path or URL.

**Architecture:** Core resolves the task artifact identity, canonicalizes it, and checks Workspace/CetaMesh ownership and content type. Rust Host requests that Core resolution using the identity and opens only the returned canonical local file; the path never returns to React.

**Tech Stack:** Node.js task/workspace services, `src/storage/json-file.js`, Rust WebView2 bridge, typed React bridge, repository test aggregator.

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

## Review Focus

- Renderer supplies a path instead of an artifact identity; pin schema rejection in `scripts/test-artifact-open-boundary.mjs`.
- Symlink/junction resolves outside an authorized root; pin `realpath` containment rejection in the same suite.
- Artifact identity belongs to another Task/Workspace; pin ownership rejection in the same suite.
- Unsupported extension, missing file, or non-local scheme; pin denial before native dispatch in Node and Rust tests.
- Host receives malformed or oversized artifact identity; pin bounded method and payload checks in Rust tests.

---

### Task 1: Core identity resolution and Workspace boundary

**Files:**
- Create: `src/task/artifact-open.js`
- Modify: `src/task/runtime.js`
- Modify: `src/task/service.js`
- Modify: `src/app/service-container.js`
- Create: `scripts/test-artifact-open-boundary.mjs`
- Modify: `scripts/run-all-tests.mjs` with registry entry `'test-artifact-open-boundary.mjs': { category: 'security' }`

**Interfaces:**
- Core method: `task.artifact.resolveOpen({ taskId, artifactId }) -> { canonicalPath, extension }` for trusted Host-to-Core IPC only.
- Resolver: `resolveTaskArtifactOpen({ artifact, workspaceRoot, ownedArtifactRoot }) -> { canonicalPath, extension }`.
- Allowlisted local extensions: `.csv`, `.jpeg`, `.jpg`, `.md`, `.pdf`, `.png`, and `.txt`; no scripts, executables, HTML, or arbitrary URI schemes.

- [x] **Step 1: Add failing tests** for a valid in-root artifact, unknown IDs, wrong task/workspace, missing file, traversal, symlink/junction escape, and rejected file types.
- [x] **Step 2: Register `test-artifact-open-boundary.mjs` as category `security` in `scripts/run-all-tests.mjs` and run `npm test -- --category security`.** Confirm the new tests fail.
- [x] **Step 3: Implement task/artifact lookup and canonical-path authorization** using `realpath`; do not return `ref` or `canonicalPath` from any renderer projection.
- [x] **Step 4: Run `npm test -- --category security`** and confirm Core boundary tests pass.

### Task 2: Native open route and Harbor affordance

**Files:**
- Modify: `desktop-shell/src/webview_policy.rs`
- Modify: `desktop-shell/src/webview_ui.rs`
- Modify: `desktop-shell/src/external_link.rs`
- Modify: `scripts/test-desktop-ui-v2-production.mjs`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/components/product/cards.tsx`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Native method: `app.openArtifact({ taskId, artifactId }) -> { opened: boolean }`; the host fetches `task.artifact.resolveOpen` over Core IPC and opens only its authorized canonical result.
- UI action: ArtifactCard calls `app.openArtifact` with identities only and reports a structured unavailable/error state. External links require an explicit user action through the existing `app.openExternal` HTTPS route; HTTP and custom schemes remain unavailable.

- [ ] **Step 1: Add failing Rust and UI contract tests** for method allowlisting, identity-only request, safe extension acceptance, and no path/URL projection to React.
- [ ] **Step 2: Run `npm test -- --category architecture --category security`** and confirm the contract assertions fail.
- [ ] **Step 3: Implement the Rust Host dispatch and Harbor button**; use only the existing native external-action boundary and an explicit extension allowlist.
- [ ] **Step 4: Run `npm test -- --category architecture --category security`** and confirm bridge and UI contract assertions pass.
