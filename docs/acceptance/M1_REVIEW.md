# M1 Review record

## Baseline

Six M1 implementation tasks were executed sequentially on feat/m1-standalone-chat.
The roadmap remains authoritative. M0 native validation was deferred by explicit user instruction.

## Review evidence

A previous reviewer could not run due to an account usage limit; no independent
review result was claimed for that attempt. A new independent read-only review
completed on 2026-09-30 against the local M1 implementation. No Critical finding
was reported. Four Important and one Minor finding were addressed:

| Finding                                                                     | Resolution                                                                                | Regression evidence     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| Valid Android document IDs containing encoded slashes were rejected         | Treat content URI document IDs as opaque; decode file paths for traversal validation      | attachments.test.ts     |
| Content URI stat/read is unreliable across Android document providers       | Create a picker-owned local cache copy before stat/read and clean it in finally           | picker-provider.test.ts |
| Old provider model discovery could appear after switching provider          | Invalidate pending requests on provider change/unmount and discard stale responses        | chat-ui-races.test.tsx  |
| Concurrent session/message page requests inserted duplicate rows            | Synchronous request guards, disabled loading actions, ID deduplication and version guards | chat-ui-races.test.tsx  |
| Retry erased an unrelated prepared draft (Minor; treated as user-data loss) | Distinguish send/retry in runtime started events; only send clears composer/attachments   | chat-ui-races.test.tsx  |

The reviewer also exercised XHR incremental delivery, early-return cleanup and
waiting cancellation with focused probes. Native/device/live API checks were
outside the runnable environment. Regression tests first reproduced the UI
failures, then passed after fixes. Final `npm run check` passes with 14 suites /
61 Jest tests, 5 architecture guard tests and the current-source scan.

Author failure-path review identified:

- Provider metadata was published before secure-key writes. Fixed by staging a new
  credential reference and publishing metadata only after successful secure write.
  Regression verified secure-write failure keeps the old endpoint/reference.
- Closing services could close SQLite before cancellation state was persisted.
  Fixed by runtime.close cancellation/drain before database.close.
  Regression verified stalled reply closes with cancelled rather than storage_error.
- Architecture script only unit-tested helpers and missed direct native SDK/Data
  access. The script now scans current source, and rejects SDK/bridge/Data/Provider
  access from features and concrete infrastructure imports in runtime/domain.

## Verification caveats

Keychain/picker mocks replace only external OS operations. SQLite integration
runs real executable SQLite, including file-backed close/reopen.
JS Bundle generation is not an APK/iOS native build.
No real API key is available and no paid model call has been made.
