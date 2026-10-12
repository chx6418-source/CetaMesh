# Desktop Chat History Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Page Chat history with a stable cursor capped at 200 messages and preserve the current Harbor virtual-list behavior and scroll anchor.

**Architecture:** The Chat service owns cursor validation and chronological page selection. The typed UI receives bounded pages, prepends older pages on demand, and continues to render rows through the existing TanStack `VirtualList` primitive.

**Tech Stack:** Node.js Chat service, typed React bridge, `@tanstack/react-virtual`, repository test aggregator.

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

- Limit is 0, negative, NaN, or above 200; pin clamp behavior in `scripts/test-desktop-chat-product.mjs`.
- Cursor points to an unknown message; pin safe structured failure in the same suite.
- Messages are appended while older pages load; pin no duplicate/drop behavior in the same suite.
- Long/dynamic message heights change while prepending; manual acceptance checks scroll anchor in `UI_V2_VISUAL_ACCEPTANCE.md`.
- A 500-message conversation mounts too many DOM rows; manual acceptance records virtualized mounted-row count and memory.

---

### Task 1: Stable Core and typed history cursor

**Files:**
- Modify: `src/desktop/chat-service.js`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `scripts/test-desktop-chat-product.mjs`

**Interfaces:**
- Core API: `history({ id, limit = 100, beforeMessageId = null }) -> { id, total, messages, nextBeforeMessageId, hasMore }`.
- Cursor: `beforeMessageId` identifies the earliest already loaded message; pages remain chronological and exclude the cursor item.
- Page size is clamped to `1..200`; the initial request returns the newest page.

- [x] **Step 1: Add failing assertions** for 100-, 200-, and 500-message histories, multi-page order/no overlap, unknown cursor, empty history, and limits `0`, `-1`, `201`, and `NaN`.
- [x] **Step 2: Run `npm test -- --category architecture --category runtime`** and confirm pagination assertions fail.
- [x] **Step 3: Implement bounded cursor paging** in Chat service and carry its exact DTO through `ui.chat.history` and `chatClient.history`.
- [x] **Step 4: Run `npm test -- --category architecture --category runtime`** and confirm paging assertions pass.

### Task 2: Older-page loading and scroll anchoring

**Files:**
- Modify: `desktop-ui/src/app/HarborApp.tsx`
- Modify: `desktop-ui/src/components/primitives/content.tsx`
- Modify: `desktop-ui/src/app/harbor.css`
- Modify: `scripts/test-desktop-ui-v2-production.mjs`

**Interfaces:**
- Chat keeps loaded pages in chronological order and exposes a load-earlier action while `hasMore` is true.
- Prepending preserves the first visible message and its viewport offset; stream append follows the existing bottom-stick behavior only when the user was already at the bottom.
- The renderer continues to use `VirtualList`; it must not render all 500 messages as ordinary mapped DOM rows.

- [x] **Step 1: Add failing UI contract assertions** for cursor forwarding, page prepend order, `VirtualList` use, and bottom-stick state handling.
- [x] **Step 2: Run `npm test -- --category architecture`** and confirm the UI contract assertions fail.
- [x] **Step 3: Implement the page-loading and anchor-restoration behavior** with the existing virtual-list primitive.
- [x] **Step 4: Run `npm test -- --category architecture`** and confirm UI contract assertions pass.
- [x] **Step 5: Measure 100/200/500-message fixtures** with long Markdown, large code, overlong URL, and dense Tool/Agent cards; record mounted rows, paging, scroll-anchor, stream, and memory evidence in the visual acceptance record. Automated row counts, scroll-anchor math, bottom behavior, and dynamic measurement are recorded in `UI_V2_VISUAL_ACCEPTANCE.md`; manual scrolling and real DOM memory measurement are `NOT_RUN_ENVIRONMENT` with the exact current-environment reason recorded there.

Task 2 verification: `npm run build:ui` PASS; focused `npm test -- --category architecture --category runtime` PASS 44 / FAIL 0 / NOT_RUN_ENVIRONMENT 0; full `npm test` PASS 92 / FAIL 0 / NOT_RUN_ENVIRONMENT 6. The remaining environment skips are listed in the final closure report. Browser visual inspection was intentionally not attempted per Owner instruction.
