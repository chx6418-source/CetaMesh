# Desktop Provider Settings and Feedback Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose only Provider-supported advanced settings and keep all feedback/security links centralized, validated, and honest when no official destination is configured.

**Architecture:** Provider metadata is the source for advanced-field visibility and type; secret values stay in the existing Provider Secrets service. About links continue to come from `release-config.json` through Product Service and the native HTTPS browser route.

**Tech Stack:** Node.js Model/Product services, Provider Secrets, TypeScript Harbor Settings/About pages, repository test aggregator.

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

- Provider does not support a setting; pin that the field is absent in `scripts/test-product-services.mjs`.
- Provider supports a typed field with an enum/range; pin its metadata and validation in the same suite.
- API Key is saved then reopened; pin that only `configured` metadata returns in `scripts/test-provider-secrets.mjs`.
- No official feedback URL configured; pin disabled links/null URLs in `scripts/test-feedback-links.mjs`.
- Hostile query values or URL path/host are injected; pin allowlisted query fields and HTTPS validation in `scripts/test-feedback-links.mjs`.

---

### Task 1: Provider-declared advanced fields

**Files:**
- Modify: `src/model/model-provider.js`
- Modify: `src/model/providers/openai-compatible.js`
- Modify: `src/model/service.js`
- Modify: `src/product/provider-view.js`
- Modify: `src/product/service.js`
- Modify: `scripts/test-product-services.mjs`
- Modify: `scripts/test-provider-secrets.mjs`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Provider metadata: `settingsFields()` returns descriptors only for implemented settings, each `{ key, label, type, choices?, min?, max? }`.
- Product projection: preserves basic Provider/API Key/Model fields and adds only the selected Provider's supported advanced descriptors.
- Secret API Key update remains write-only; read projection returns configured status, never the secret.

- [ ] **Step 1: Add failing tests** for providers with different supported field sets, unsupported-field omission, enum/range validation, and write-only API Key projection.
- [ ] **Step 2: Run `npm test -- --category runtime --category security`** and confirm provider metadata/settings assertions fail.
- [ ] **Step 3: Implement Provider metadata and render its supported advanced fields** in Settings; do not show a control for any value the selected Provider does not consume.
- [ ] **Step 4: Run `npm test -- --category runtime --category security`** and confirm Provider settings and secret tests pass.

### Task 2: Centralized feedback and security links

**Files:**
- Modify: `src/product/release-config.js` only if validation is missing
- Modify: `src/product/feedback-links.js` only if URL/query construction is missing
- Modify: `scripts/test-feedback-links.mjs`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- `ui.feedback.links` remains the only About-page data source; URL query keys are exactly `version`, `build`, and `platform`.
- With no verified `feedback.baseUrl` or website, entries return `url: null` and the page keeps the existing unavailable state.

- [ ] **Step 1: Add failing assertions** for all four entries, query-key allowlist, malformed config rejection, disabled no-URL state, and native HTTPS opening.
- [ ] **Step 2: Run `npm test -- --category runtime --category security`** and confirm feedback link assertions fail only where behavior is missing.
- [ ] **Step 3: Implement only centralized validation/projection gaps.** Do not add a guessed URL or a page-level URL constant.
- [ ] **Step 4: Run `npm test -- --category runtime --category security`** and confirm feedback tests pass; record the missing official destination as `BLOCKED` in the final report.
