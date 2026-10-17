# Latest Audit Repair Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks in order; each code change follows red, green, and regression verification.

**Goal:** Close reproducible NEW-01–NEW-07 defects on the latest CetaMesh Desktop baseline while preserving security boundaries, and report NEW-08–NEW-10 against real environment evidence.

**Architecture:** Keep the existing Workspace, Agent Broker, Chat, Task, Continuity, and Memory services. Repair identity propagation and persistence at their current contracts; preserve Capability Broker, Owner Approval, and the canonical Workspace root.

**Tech Stack:** Node.js ESM, Rust desktop shell, Windows CI, npm test aggregator.

**Spec:** User-pasted latest-repository repair task and 2026-10-17 incremental audit report.

## Global Constraints

- Use an independent local branch; do not merge or push main without new Owner approval.
- Do not weaken Workspace Boundary, Capability Broker, Owner Approval, sandbox, or memory scope isolation.
- Register every new `scripts/test-*.mjs` in `scripts/run-all-tests.mjs`; persist JSON through `src/storage/json-file.js`.
- Distinguish fixture evidence from real Windows/DSH/Codex/QQ/Android E2E.

## Review Focus

- Windows temp-root aliases must use the Workspace Registry's canonical root while a junction outside the root remains denied.
- ACK-before-event races must not drop the first assistant chunk or accept an old turn's end.
- Resume must authorize fast tool execution only after durable Task state transition.
- Non-Git recovery needs an explicit reviewable Workspace snapshot and may not replay uncertain side effects.
- Handoff persistence failure must not leave an unreported active target or lose authoritative assignment.

## Tasks

### Task 1: NEW-07 Windows CI boundary contract

**Files:** `scripts/test-phase1-security.mjs`, `scripts/test-phase2-chat-model.mjs`; inspect `src/workspace/boundary.js`, `registry.js`, `tools.js`.

- [ ] Verify the CI failure and local fixture root versus `canonicalizeRoot()` behavior.
- [ ] Keep a failing Windows regression on the unmodified baseline; update direct tool calls to the canonical root without weakening the escape assertion.
- [ ] Run both focused suites and `npm test`; commit the narrow fix.

### Task 2: NEW-01/02 Agent event ownership

**Files:** `src/agent/{managed,dsh,codex}-agent-provider.js`, `src/agent/broker.js`, `src/capability/service.js`, `src/desktop/{platform-runtime,chat-service}.js`, production-assembly regression tests.

- [ ] Add failing tests for Smart/Task three turns, native turn-only events, ACK races, bootstrap and reconnect.
- [ ] Propagate provider Session/Request/Turn identity through ACKs and normalize only IDs supported by each provider; reject stale/duplicate events.
- [ ] Run focused and full tests; commit independently.

### Task 3: NEW-03 Memory retrieval

**Files:** `src/context/service.js`, `src/memory/{runtime,policy}.js`, production-assembly memory tests.

- [ ] Reproduce confirmed Global Knowledge absent from a new Chat; cover disabled memory and cross-scope denial.
- [ ] Add global as an explicit authorized knowledge partition within the existing budget and dedupe policy.
- [ ] Run tests and commit.

### Task 4: NEW-04/05 Task resume and non-Git recovery

**Files:** `src/desktop/ui-service.js`, Task/Workspace services, production-assembly tests.

- [ ] Reproduce fast tool execution before Task resume and interrupted non-Git recovery.
- [ ] Make resumed state durable before dispatch under the existing Task lock; require reviewable non-Git state evidence before continuation.
- [ ] Inject cancellation, crash and retry; run tests and commit.

### Task 5: NEW-06 Handoff persistence

**Files:** `src/continuity/runtime.js`, existing JSON storage primitive, continuity tests.

- [ ] Inject history/latest write failures after target activation and reproduce misleading failure.
- [ ] Persist recoverable transfer intent and reconcile authoritative Task assignment on failure/restart without two active writers.
- [ ] Run tests and commit.

### Task 6: NEW-08/09/10 and final evidence

**Files:** requested two repair/gate reports; only minimal product code if a newly reproduced defect requires it.

- [ ] Recheck real provider/Windows/QQ/Android/signing conditions without relaxing security; record exact environment blockers.
- [ ] Run `npm test`, `build:ui`, `build:core`, `desktop:check`, `desktop:test`, and applicable SEA/installer tests, then inspect Windows CI.
- [ ] Publish local-only status matrices for 91 old IDs, 10 NEW IDs, 269 F checks, and 24 E scenarios; commit reports on the work branch.
