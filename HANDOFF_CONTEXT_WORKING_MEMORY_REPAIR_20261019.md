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