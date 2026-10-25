# M2 Local Memory Acceptance

Implemented scope: TASK-M2-001 through TASK-M2-005. The user explicitly requested
M2 while prior native gates remain blocked. Automated results do not constitute
native launch/upgrade acceptance.

Automated coverage:

- `npm run check` — PASS (TypeScript, Lint with no errors/warnings, current-source
  architecture scan, 19 Jest suites / 81 tests, none skipped).
- Android and iOS Metro release JS bundles — PASS. These are not native builds.
- Real SQLite v1→v2 migration preserves chat rows, reruns safely, enforces scope/
  kinds/metadata; file-backed memory pin/source persists after close/reopen.
- CRUD, literal CJK/ASCII/wildcard search, filtering, ranking, pagination,
  stale edits, automatic pin denial and test DB isolation.
- Offline Runtime composition, content/metadata/credential-pattern validation,
  safe errors and body-free correlation events.
- Chat preview produces explicit user candidates without persistence/network.
  Confirm/edit/reject, provenance changes/deletion, replay/race and pin protection.
- Provider-free Memory navigation, edit/search/pin/source, confirmed deletion,
  candidate confirmation, retained chat draft and list/filter/page races.
- Independent review reported 3 Important findings; all reproduced and fixed:
  English labelled secrets, source deletion/change race and exact Unicode matching.
  See [M2_REVIEW.md](M2_REVIEW.md) for disposition and decisions.

## Device checklist — NOT_RUN_ENVIRONMENT

1. Build Android Debug on a provisioned SDK/Gradle machine; launch offline.
2. Upgrade an installed M1 app to M2 without clearing storage. Preserve chats,
   settings and keys; open/create Memory before configuring any new Provider.
3. Save each kind, search Unicode/literal wildcard text, edit/pin/unpin/delete.
4. Send “记住：我喜欢乌龙茶”, open candidate preview, reject once, preview again,
   edit and confirm. Observe source; verify no Memory upload or implicit prompt use.
5. Force-stop/relaunch, verify memory/content/source/pin persistence.
6. Delete the source chat, keep the saved memory; open source and see safe error.
7. Exercise long lists, rapid filtering, draft editing and retry after storage error.
8. Build iOS on macOS/Xcode/Pods, run the same SQLite/UI/lifecycle checks.

Android/iOS native builds, on-device migration/restart, native SQLite integration
and device E2E are NOT_RUN_ENVIRONMENT until executed. M0/M1 results are unchanged.
Android Debug attempt on 2026-09-30 could not download Gradle 9.4.1 because the
socket was denied (Operation not permitted); Android SDK/ADB are absent.
iOS is unavailable on this Linux host (Xcode/Ruby/Pods absent). Metro reports
upstream private-export fallback and CLI setup-script EPERM warnings but emits
both bundles successfully.
Do not enter M3 based on this document.

## Recovery and fresh verification — 2026-09-30

The environment contained the older M1 checkout (19d33d8), so the delivered
M2 source ZIP was restored into an independent checkout without overwriting it.
The archive does not include Git history; b6e74d0 records the recovered baseline.

`npm run check` passed again: TypeScript, Lint, architecture guard and 81 tests
in 19 suites, none skipped. The dependency lockfile exactly matches the available
installed tree reused for this run.

Android Debug was attempted again. The initial socket restriction was overcome
on retry: Gradle 9.4.1 and React Native build plugins downloaded and compiled.
The build then failed during configuration with `SDK location not found`.
No Android SDK/sdkmanager/adb is installed; no APK or launch result exists.
APK compilation and all device checks remain NOT_RUN_ENVIRONMENT.
iOS remains unavailable on this Linux host. Gate M2 remains BLOCKED.
