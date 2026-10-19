# Agent handoff / context / working Memory repair

Base: db2b060018d0309052eeea004cdbd14e257aa56d
Execution source: 5f099795314a75bb898f827d646da8c1619d12ac
Repair branch: fix/handoff-context-working-memory-20261019

## Actual verification
- 01-red: exit 1
- 02-green: exit 0
- 03-related-regressions: exit 1
- 04-ui-install: exit 0
- 05-ui-build: exit 0
- 06-full-suite: exit 1

Targeted synthetic production-composition regression: red before implementation, green after implementation.
Real DSH/Codex/API and Windows desktop manual E2E were NOT run.
Full-suite failures remain blockers and are not converted to PASS. See text evidence.

## Scope
- Separate nullable selection policy from the actual Task Session owner.
- Synchronize committed Task assignments; recover a missed Chat projection lazily.
- Exclude the Core-identified bootstrap turn; preserve checkpoints and nextAction.
- Capture bounded Owner references with source IDs; later corrections take precedence.
- Project Task-scoped working Memory without broadening Agent grants.
- Preserve user/global long-term confirmation rules.

## Remaining boundaries
Bounded reference windows mark omissions. Cross-provider model compatibility and real external execution still need E2E. First model report remains unverified. No user data migration, main merge or Stable publication.

scripts/run-all-tests.mjs       |  1 +
 src/app/service-container.js    | 15 ++++++++-
 src/capability/service.js       | 27 +++++++++++-----
 src/continuity/runtime.js       | 25 +++++++++++---
 src/continuity/service.js       |  4 +--
 src/continuity/types.js         |  7 ++++
 src/desktop/chat-service.js     | 72 +++++++++++++++++++++++++++++++++++++++--
 src/desktop/platform-runtime.js |  8 +++--
 src/task/runtime.js             | 10 ++++++
 src/task/store.js               |  2 ++
 10 files changed, 152 insertions(+), 19 deletions(-)
## Follow-up 2026-10-19: queued DSH turns and migration CI blockers

- `8926b2edfe2986ec446da0f320050d40f748234c`: Task Follow now tracks accepted or pending queued turn terminals instead of exiting at the first `turn/end` when a subsequent request is already dispatched. The existing failing regression `DSH-style Follow retains both quickly queued Task turns` is the acceptance target. This code patch is **NOT VERIFIED** by a fresh test execution.
- `b5e8814784fcf511a6fee8ae41dd8c163c9b83bf`: added time-stamped test-only phase markers to M5 synthetic migration fixture. It does not weaken ACL, backup hashes, leases, or real-data restrictions; it is diagnostic instrumentation, **not an M5 performance fix**.
- GitHub Actions runs `39211468137` and `39211468103` completed failure in about four seconds with `runner_id=0`, `steps=[]` and unavailable job logs. They did not run the new tests. Run `39211918914` shows the same early failure. No success or product-regression conclusion can be inferred from these runs.
- Last CI that actually reached tests: `39207856230` at `cc062b5` returned **116 PASS / 2 FAIL / 17 NOT_RUN_ENVIRONMENT**: queued DSH Task Follow regression and `test-whalebridge-m5-fixture` timeout at 300 seconds. The latter is a distinct synthetic migration fixture performance/runtime blocker, not proof of a real data migration failure.
- **Required re-verification:** `npm test -- --suite test-handoff-context-working-memory --suite test-agent-provider-expansion --suite test-continuity-rollover --suite test-desktop-chat-product`, then `npm test -- --suite test-whalebridge-m5-fixture` (inspect `M5_FIXTURE_STEP` markers and isolate slow phase), then full `npm test`, `npm run build:ui`, `npm run desktop:check`, `npm run desktop:test`. Preserve environment skips. Do not merge main, publish Stable, or run migrations on user data until pass and Owner approval.
