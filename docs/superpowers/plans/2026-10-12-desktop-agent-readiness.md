# Desktop Agent Directory Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DSH, Codex, and ZCode cards reflect their actual registry, installation, and readiness state throughout the typed UI projection and Harbor Agents page.

**Architecture:** Read actual `AgentProvider` readiness from the existing Agent registry/service, project only safe status metadata through `ui.agent.list`, and render the returned values without hard-coded availability.

**Tech Stack:** Node.js ESM Agent Registry/Broker, Rust Host/Core IPC, TypeScript Harbor UI, repository test aggregator.

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

- Provider executable missing after a stale cached status; pin with a refresh assertion in `scripts/test-agent-provider-expansion.mjs`.
- Provider health call throws; pin that the result is unavailable and the directory still loads in the same suite.
- DSH Desktop installed but DSH Agent unavailable; pin the two distinct statuses in `scripts/test-dsh-desktop-integration.mjs`.
- Codex/ZCode not installed; pin disabled actions and truthful setup status in `scripts/test-agent-provider-expansion.mjs`.
- Provider diagnostic paths or tokens leaking into DTO/UI; pin a safe-projection assertion in `scripts/test-desktop-ui-v2-production.mjs`.

---

### Task 1: Project registry readiness into Harbor Agents

**Files:**
- Modify: `scripts/test-agent-provider-expansion.mjs`
- Modify: `scripts/test-dsh-desktop-integration.mjs`
- Modify: `scripts/test-desktop-ui-v2-production.mjs`
- Modify: `src/agent/service.js`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Consumes: `agent.list`, existing `AgentProvider.health()`, `projectAgent`, and typed `agentClient.list()`.
- Produces: DSH/Codex/ZCode cards whose status comes from the installed Registry and health result; preserve existing status strings and do not expose executable paths or credentials.

- [ ] **Step 1: Add failing tests** for ready, needs-setup, not-installed, unavailable, thrown health, and DSH Desktop-installed/Agent-unavailable separation using provider fixtures.
- [ ] **Step 2: Run `npm test -- --category runtime --category integration --category architecture`** and confirm projection/UI state assertions fail.
- [ ] **Step 3: Implement the smallest provider-service, projection, and Harbor rendering changes** using existing provider readiness results.
- [ ] **Step 4: Run `npm test -- --category runtime --category integration --category architecture`** and confirm all Agent readiness assertions pass.

### Task 2: Record actual local Agent acceptance

**Files:**
- Modify: `docs/desktop/UI_V2_PRODUCTION_PARITY.md`
- Modify: `docs/desktop/DESKTOP_UI_V2_PRODUCTION_REPORT.md`

- [ ] **Step 1: Inspect the installed DSH, Codex, and ZCode state** through the product's real Agent Registry and record each observed status.
- [ ] **Step 2: Update the parity matrix and report from those observations only**; do not count a fixture-backed status test as installed-provider acceptance.
