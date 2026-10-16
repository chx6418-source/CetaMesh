# CetaMesh Desktop · Phase 3 Task / Handoff repair record

Date: 2026-10-16. Branch: `codex/phase3-task-handoff`. This is an **incomplete Phase 3 record**, not a Phase 3 acceptance certificate. No push, main merge, or Stable release was performed.

## Baseline and change sets

- Phase 1 (`REPAIR_PHASE_1_SECURITY.md`) and Phase 2 (`REPAIR_PHASE_2_CHAT_MODEL.md`) are ancestors of this branch. The Phase 2 report commit is `e19f292`; this branch was based on it, without merging main.
- `83c05ca` — Task dispatch, request idempotency, Task Follow, initial production assembly regressions.
- `887c8be` — Continuity transfer, Workspace verification, sequence/history persistence, bootstrap completion checks.
- `d212a38` — Core restart recovery, Chat/Task binding, Harbor wiring, model configuration persistence, provisional Handoff authority guard, additional regressions.
- `ed8d4bf` — real Agent tool activity projected into Task phase and completed work.

The issue descriptions and original locations are from the Owner's *CetaMesh Desktop core audit and Codex repair register*. This report records the changed locations on this branch. `PASS_AUTOMATED` means the cited local regression passed; it does **not** mean a real DSH ↔ Codex ↔ Managed cross tool E2E passed. `PARTIAL` means the stated acceptance remains unmet and must not be marked PASS.

## Issue evidence

| ID | Root cause and changed location | Regression evidence | Result / commit |
| --- | --- | --- | --- |
| TASK-01 | Harbor created a Task record without dispatch. `src/desktop/ui-service.js` now sends `agent.run` through Capability Broker. | `test-phase3-task-handoff`: UI create → actual Managed turn and checkpoint. | PASS_AUTOMATED `83c05ca`, `d212a38` |
| TASK-02 | Resume changed only state. `src/desktop/ui-service.js` now dispatches an Agent turn from Task facts and checks Workspace on interrupted recovery. | `test-phase3-task-handoff`: pause → resume → second send. | PASS_AUTOMATED `83c05ca`, `d212a38` |
| TASK-03 | Pause/cancel did not stop the Session. `src/desktop/ui-service.js`, `src/capability/policy.js` cancel first, revoke later Agent effects. | `test-phase3-task-handoff`: cancel count and stale capability denial. | PASS_AUTOMATED `83c05ca`, `d212a38` |
| TASK-04 | Concurrent `agent.run` calls reused the first send. `src/capability/service.js` serializes distinct instructions and journals request IDs. | `test-phase3-task-handoff`: two distinct concurrent prompts and same-ID retry. | PASS_AUTOMATED `83c05ca` |
| TASK-05 | Rejected Agent ACK could leave a running Task. `src/capability/service.js` rolls back attachment/session and fails an initialized Task on rejection. | `test-agent-provider-expansion`, `test-phase3-task-handoff`. | PASS_AUTOMATED `83c05ca` |
| TASK-06 | Task fields required manual updates. `src/capability/service.js` now records completed turns, checkpoints and tool activity; phase/note reflect actual tool events. File artifact references, decisions and test evidence are not yet automatically linked to Task revisions. | `test-phase3-task-handoff`: production assembly Agent tool read → completed work/checkpoint. | **PARTIAL** `83c05ca`, `ed8d4bf` |
| TASK-07 | `src/desktop/platform-runtime.js` still chooses `config.agentProvider` or Managed default, without a capability/health ranking for code tasks. Existing boundary checks prevent unsafe providers but do not meet adaptive routing acceptance. | `test-smart-platform-routing` covers Workspace/Task reuse, not capability scoring. | **INCOMPLETE** `d212a38` |
| TASK-08 | Harbor used filter values outside Task enum. `desktop-ui/src/app/HarborApp.tsx` aligns filters with Core statuses. | `test-desktop-ui-v2-production`; `build:ui`. | PASS_AUTOMATED `d212a38` |
| TASK-09 | Work and Chat could each create a Task for an identical Workspace goal. `src/task/runtime.js`, `src/desktop/platform-runtime.js` reuse exact active goal+Workspace and fail on ambiguity. Semantic duplicates with differently worded goals remain possible. | `test-smart-platform-routing`. | **PARTIAL** `d212a38` |
| TASK-11 | Harbor input length differed from Task Core limit. `desktop-ui/src/app/HarborApp.tsx`, `src/desktop/ui-service.js` align bounds. | `test-desktop-ui-v2-production`; `build:ui`. | PASS_AUTOMATED `d212a38` |
| HND-01 | Chat closed the old Agent before Continuity owned transfer. `src/desktop/chat-service.js` routes provider changes through `continuity.rollover`. | `test-desktop-chat-product`, `test-continuity-rollover`. | PASS_AUTOMATED `887c8be`, `d212a38` |
| HND-02 | Bootstrap ACK was treated as completion. `src/continuity/runtime.js` waits for the target terminal turn before accepting later instructions. | `test-continuity-rollover`: gated bootstrap; no early success. | PASS_AUTOMATED `887c8be` |
| HND-03 | Target binding preceded proof of recovery. `src/continuity/runtime.js` checks terminal bootstrap and fresh Workspace facts before success; `src/capability/policy.js` denies Agent capabilities during provisional Handoff. | `test-continuity-rollover`, `test-phase3-task-handoff`: provisional Agent request denied. | PASS_AUTOMATED `887c8be`, `d212a38` |
| HND-04 | Transfer lock began after async status work. `src/continuity/runtime.js` acquires it before the first await; `src/capability/service.js` fences `agent.run`. | `test-continuity-rollover`, `test-phase3-task-handoff`: concurrent Handoff/run denied. | PASS_AUTOMATED `887c8be`, `d212a38` |
| HND-05 | Old Agent stop failure could be reported as success. `src/continuity/runtime.js` verifies stop/status, blocks recovery when target cleanup is uncertain. | `test-continuity-rollover`: old stop failure, no success history. | PASS_AUTOMATED `887c8be` |
| HND-07 | Workspace reconciliation reused stale facts. `src/continuity/runtime.js` recollects Git SHA/diff/files before and after bootstrap and fails closed on mismatch. | `test-continuity-rollover`: changed Workspace blocks transfer. | PASS_AUTOMATED `887c8be` |
| HND-08 | `latest.json` cache and successful history could disagree. `src/continuity/runtime.js` treats committed rollover history as authority; latest is repairable cache. | `test-continuity-rollover`: failed transfer cannot become latest success. | PASS_AUTOMATED `887c8be` |
| HND-09 | History truncation allowed sequence reuse. `src/continuity/runtime.js` computes next sequence from persistent packet/history maxima. | `test-continuity-rollover`: retained-history limit and next sequence. | PASS_AUTOMATED `887c8be` |
| HND-10 | Packet normalized requirement text too narrowly. `src/continuity/types.js`, `src/continuity/runtime.js` retain Task requirement bounds. | `test-continuity-rollover`: packet requirements survive. | PASS_AUTOMATED `887c8be` |
| HND-11 | Target could restore an unrelated model default. `src/task/runtime.js`, `src/task/store.js`, `src/capability/service.js` persist the selected model; `src/continuity/runtime.js` passes it to target and persists target selection. Provider-specific compatibility checking remains unverified for real cross tool sessions. | `test-phase3-task-handoff`: Core restart; `test-continuity-rollover`: cross Provider model args. | **PARTIAL** `d212a38` |
| HND-12 | Monitor state/policy was volatile. `src/continuity/runtime.js` persists both; usage still depends on Provider estimates when exact counts are unavailable. | `test-continuity-rollover`: restart policy and usage. | **PARTIAL** `887c8be` |
| HND-13 | New target did not enter Task Follow. `src/continuity/service.js`, `src/capability/service.js` register Follow only after successful transfer. | `test-continuity-rollover`: callback follows successful transfer. | PASS_AUTOMATED `d212a38` |
| CHAT-05 | Continue sent a bare “continue”. `src/desktop/chat-service.js` builds a bounded Task checkpoint/goal/requirements recovery instruction and refuses unsafe Task states. Exact tool cursor replay is not implemented. | `test-phase3-task-handoff`: prompt contains persisted checkpoint. | **PARTIAL** `d212a38` |
| CHAT-06 | New Agent Session lacked Chat constraints. `src/desktop/chat-service.js` includes bounded prior Owner messages for Task-bound continuation. Non-Task DSH summary recovery remains unverified. | `test-desktop-chat-product`, `test-phase3-task-handoff`. | **PARTIAL** `d212a38` |
| CHAT-07 | Chat projected no durable Task ID. `src/desktop/chat-service.js`, `src/desktop/ui-service.js` persist and expose it after restart. | `test-phase3-task-handoff`: restarted `chat.status.taskId`. | PASS_AUTOMATED `d212a38` |
| CORE-01 | Interrupted in-memory turns were invisible after Core restart. `src/app/service-container.js`, `src/task/runtime.js`, `src/desktop/chat-service.js` mark them interrupted/blocked and deny stale Session effects. Automatic replay of a high risk operation is intentionally absent. | `test-phase3-task-handoff`: Core restart, stale Session/Agent denial, explicit recovery. | PASS_AUTOMATED for safe interruption `d212a38` |
| UI-01 | Harbor lacked Task handoff controls/history. `desktop-ui/src/app/HarborApp.tsx`, `desktop-ui/src/bridge/typed-client.ts`, `src/desktop/ui-service.js`, `desktop-shell/src/webview_policy.rs` connect controls to Core. A dedicated native audit view and real cross tool visual acceptance remain unverified. | `test-desktop-ui-v2-production`, `test-phase3-task-handoff`; `build:ui`, `desktop:test`. | **PARTIAL** `d212a38` |

## Verification

- `npm test -- --category runtime`: 36 PASS, 0 FAIL after the latest Task activity change.
- `npm test`: 92 PASS, 0 FAIL, 11 NOT_RUN_ENVIRONMENT on final `ed8d4bf` source state (103 suites).
- `npm run build:ui`: PASS, TypeScript and Vite; existing large chunk warning.
- `npm run build:core`: PASS, SEA build and resource audit.
- `npm run desktop:check`: PASS, existing dead-code warnings.
- `npm run desktop:test`: PASS, 197 Rust tests.
- Opt-in production assembled real Codex E2E: **NOT_RUN_ENVIRONMENT**. Codex CLI was installed and logged in, but its Windows sandbox rejected execution in the disposable Task Workspace (`CODEX_SANDBOX_UNAVAILABLE`). No real DSH ↔ Codex ↔ Managed transfer was demonstrated. Fixture Handoff PASS must not be substituted for it.

## Remaining acceptance work

`TASK-06`, `TASK-07`, `TASK-09`, `HND-11`, `HND-12`, `CHAT-05`, `CHAT-06`, and `UI-01` remain PARTIAL or INCOMPLETE as above. In particular, automatic artifact/test evidence linkage, capability-and-health-based executor selection, exact tool cursor recovery, provider model compatibility and actual cross tool E2E require further implementation or environment evidence. Phase 3 must not be declared complete or advanced to Phase 4 on this record.
