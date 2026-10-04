# CetaMesh Mobile Project State

UI/UX Refactor (2026-10-04):

- Branch `feature/mobile-ui-ux-v1`: Phase 1–7 IMPLEMENTATION COMPLETE, followed by
  four device-feedback fix rounds (records in `UI_REFACTOR_PROGRESS.md`); the
  latest round (2026-10-04) dedupes the release-title version in update
  announcements and removes the duplicated page intros on Tasks and Memory
  (PR #10, open).
- Merged to `main` (2026-10-04): PR #7 `feat/context-budget-v1`
  (model-specific context budget with paged history admission), PR #8
  `fix/workspace-header-duplication`, PR #9 `fix/public-update-source`
  (public `chx6418-source/CetaMesh` Releases update source; only Releases with
  direct APK assets count as installable updates), PR #1 (roadmap v1.1 as the
  authoritative plan) and the dependabot bump to `react-native-nitro-sqlite`
  10.1.0 (PR #11). Current `main`: `3e3f1df`.
- Local `npm run check` PASS on `main` `3d34957` (2026-10-04, Windows): TypeScript,
  ESLint, architecture checks, Jest 69 suites / 268 tests, 0 skipped; PASS again
  on the PR #10 tree merged with `main` `3e3f1df`: 69 suites / 269 tests.
- Android CI run `37171452572` on `3d34957`: PASS — checks, Standalone Release APK
  build, standalone APK verification, and artifact upload. Artifact `11292450299`
  (31,425,084-byte archive, expires 2026-10-18). The PR #7 and PR #8 merge commits
  also have PASS Android CI runs; PR #10's branch CI PASSed on `8b9683f`.
- Public `chx6418-source/CetaMesh` `V1.1.0` Release still carries only the ZIP asset
  built from `59b4289`; a direct APK asset must be attached before the update check
  can offer it as an installable update. The open-source `main` is being synced to
  the current private-`main` source so the public tree matches the shipped code.
- Physical Android visual/interaction verification: PENDING USER DEVICE REVIEW.
- Existing M0–M9 runtime and Standalone APK packaging baseline preserved.


Current Phase: M8
Current Gate: M5–M8 Implementation Gate

Latest M5–M8 Completion Record (2026-09-30):

- TASK-M3-005..009: DONE — Device Mesh node roles, capability advertisement,
  trust/transport metadata, bounded health/reachability and handshake protocol
  contracts.
- TASK-M4-001..006: DONE for implementation and automated verification —
  Capability Runtime, local Permission Policy, manifest/audit metadata and
  camera, microphone, file/photos and notification capability routes. Existing
  Android CI/APK static evidence is retained below; device behavior is not
  inferred.
- TASK-M5-001..008: DONE — Task-first model v2, replaceable ExecutionRef,
  durable event/attention/approval state, opaque Push foundation, Task screen,
  Approval/Action Center UI and replay/expiry-safe approvals.
- TASK-M6-001..010: DONE — trusted HTTP/WebSocket ports, handshake checks,
  durable Sync Queue, scoped `my-devices` Memory sync, metadata-only Task sync,
  local-policy remote Capability routing, presence and revision reconciliation.
- TASK-M7-001..007: DONE — bounded Share/Quick Memory/Voice contracts, durable
  local-only Offline Inbox, transcription provider port, model-source contract,
  Action Center and bounded foreground/background catch-up.
- TASK-M8-001..008: DONE — declarative/remote extension contracts, untrusted
  read-only Memory Pack reader, bounded Remote Plugin transport, SHA-256
  content hash, publisher/permission security report, transactional install
  rollback, high-risk permission re-confirmation, lifecycle and base/overlay
  isolation. No downloaded code or executable payload path exists.
- Task 11 integration gate: DONE for repository/Node/JavaScript verification.

Active Task:

- TASK-M5-M8-011: DONE — final integration, security review and documentation

Execution Decision:

- 2026-09-30 user explicitly requested entering M4. Complete M4 sequentially
  from TASK-M4-001; do not implement later-phase Agent, Sync, Plugin, Social or
  Marketplace features.
- 2026-09-30 Mobile roadmap v1.1 adopted for M3–M8. M3-001 through M3-004 remain completed; after Android CI Recovery, continue with TASK-M3-005 Node Role Model, then M3-006 capability advertisement. Do not skip directly to M4. Implementation and Native Verification gates are tracked separately.

- 2026-09-30 user explicitly requested “完成 M3”. Implement identity, protocol, QR and pairing sequentially; prior native gates remain BLOCKED. New mobile repository writes authorized; whalebridge remains read-only.

- 2026-09-30 user authorized upload to the dedicated private repository `chx6418-source/cetamesh-mobile`. Original `whalebridge` remains read-only. Android CI is configured for SDK/build-tools 37, NDK 27.1.12297006 and mandatory `npm run check`; M4 Android CI/static APK acceptance now passes on run 36730384479.

- 2026-09-30 user explicitly requested “完成 M2”. Execute five M2 tasks sequentially; M0/M1 native/live-provider acceptance stays BLOCKED. No remote writes.
- 2026-09-29 user explicitly requested “先放着，完成 M1”. M1 implementation may proceed; M0 native verification stays BLOCKED / NOT_RUN_ENVIRONMENT, not PASS.

Completed:

- TASK-M4-003: DONE (implementation/automated) — added `camera.capture` through
  the Capability Runtime and Policy, bounded JPEG Provider cleanup, Android
  Kotlin/FileProvider capture Activity, iOS Swift camera picker and New
  Architecture adapters, production composition and cancellation/error
  mapping. Verification: `npm run check` PASS (29 suites/131 tests), React
  Native Android/iOS Codegen PASS. Android native CI, iOS compile and physical
  camera behavior remain NOT_RUN_ENVIRONMENT until execution.

- TASK-M4-004: DONE (implementation/automated) — added `microphone.record`
  through the Capability Runtime and Policy, with visible foreground Android
  and iOS recording surfaces, bounded output, cancellation and cache cleanup.
  Verification: `npm run check` PASS (30 suites/136 tests), targeted
  microphone tests PASS (5), React Native Android/iOS Codegen PASS, and both
  Metro release bundles PASS. Native build, OS prompt and hardware behavior
  remain NOT_RUN_ENVIRONMENT locally. TASK-M4-006 was next.

- TASK-M4-005: DONE (implementation/automated) — routed `file.pick` and
  `photos.select` through the shared Capability Runtime and Policy using an
  adapter over the bounded PickerProvider; Chat UI now consumes only validated
  Capability results. Verification: `npm run check` PASS (31 suites/141
  tests), targeted adapter/policy/UI tests PASS (13), and Android/iOS Metro
  release bundles PASS. Native picker, OS permission and build behavior remain
  NOT_RUN_ENVIRONMENT locally.

- TASK-M4-006: DONE (implementation/automated) — added `notification.send`
  through the shared Capability Runtime and Policy, with bounded title/body
  input, Android notification permission/channel delivery, iOS notification
  authorization/delivery, cancellation and no arbitrary intent/userInfo
  fields. Verification: `npm run check` PASS (32 suites/146 tests), targeted
  notification/Runtime tests PASS (12), React Native Android/iOS Codegen PASS,
  and Android/iOS Metro release bundles PASS. Android native compile and APK
  static acceptance PASS in CI run 36730384479; iOS compile, OS prompt and
  delivery behavior remain NOT_RUN_ENVIRONMENT locally.

- TASK-M4-002: DONE (implementation/automated) — added in-memory deny, ask and
  allow-once Policy modes; unknown capability default DENY; prompt failure
  normalization; expiring single-use grants; and concrete Runtime ordering
  tests. Verification: `npm run check` PASS (28 suites/126 tests). Native OS
  prompt behavior is NOT_RUN_ENVIRONMENT. TASK-M4-003 is next.

- TASK-M4-001: DONE (implementation/automated) — added the platform-independent
  Capability catalog, descriptor/request/result/provider contract, active
  platform Provider router, policy port, unknown-capability deny, unsupported
  platform mapping, duplicate-provider rejection and bounded result/error
  handling. Verification: TypeScript PASS, lint PASS, architecture checks PASS
  (5), Jest PASS (27 suites/117 tests). Native M4 capabilities are not yet
  implemented; TASK-M4-002 is next.

- M3 Android APK Static Acceptance: DONE — added `scripts/verify-android-debug-apk.sh` and mandatory pre-upload CI gate. Run `36716374111` on `672374cb39e0143d5ed822cb5efe356df219f6dc` PASS: APK v2 signature, package/SDK levels, required/forbidden permissions, allowBackup=false, non-exported QR activity, four ABIs, M3 native modules and no key/secret-like filenames. A deliberately tampered local APK is rejected. This is static artifact evidence, not device execution.

- M3 Android CI Recovery: DONE — corrected the published platform package to android-37.0. Run `36711723719` on remote `1f7f89b5fe27c72a981e1b9ff1746316f713b81d` PASS: clean npm ci/check (26 suites/111 tests), Kotlin/native compilation, `./gradlew assembleDebug --no-daemon --stacktrace`, APK upload. No installed-app or hardware execution is implied.

- TASK-M3-004: DONE (implementation/automated) — additive SQLite v3 public trust and durable token fingerprint replay rejection; signed two-confirmation pairing runtime; bounded native HTTPS transport; Devices UI and production composition. Independent review's two Important/one Minor findings addressed. Commands: targeted protocol/UI/token tests RED→GREEN, `npm run check` PASS (26 suites/111 tests), configured native Codegen and both Metro bundles PASS; Android native compilation subsequently PASS in CI. iOS/hardware/TLS/camera and real Desktop peer acceptance NOT_RUN_ENVIRONMENT. No M4/M6 work.

- TASK-M3-003: DONE (implementation/automated) — one-use camera.scanQr policy/runtime, Kotlin bundled QR and Swift AVFoundation providers, cancellation/foreground lifecycle and QR bounds. `npm run check` PASS (22 suites/94 tests); Android/iOS codegen PASS. OS camera/native smoke NOT_RUN_ENVIRONMENT.

- TASK-M3-002: DONE — exact v1 Envelope, bounded type/payload/URL/key/token/time validation and signed transcript. `npm run check` PASS (21 suites/90 tests), protocol tests RED→GREEN. Wire contract documented; actual Desktop interoperability unverified.

- TASK-M3-001: DONE (implementation/automated) — Kotlin Keystore and Swift Secure Enclave P-256 identity, stable public metadata, non-exportable keys and safe signing/verification bridge. `npm run check` PASS (20 suites/85 tests); RN Android/iOS codegen PASS. Native hardware/compile NOT_RUN_ENVIRONMENT.

- TASK-M2-005: DONE (implementation/automated) — provider-free Memory UI, search/type filters/edit/pin/source/confirmed delete, chat candidate confirm/reject and draft retention. Independent review's 3 Important findings fixed with RED→GREEN regressions. Final `npm run check` PASS (19 suites/81 tests); Android/iOS Metro PASS. Native E2E NOT_RUN_ENVIRONMENT.
- TASK-M2-004: DONE (implementation/automated) — offline explicit-user-text extraction with ephemeral preview, editable confirmation, rejection, source recheck, replay/race protection and create-only deduplication. No network/implicit save or pinned overwrite. Commands: extraction Jest RED→GREEN; `npm run check` PASS (18 suites/72 tests). Device UI pending TASK-M2-005.
- TASK-M2-003: DONE (implementation/automated) — local-only Memory Runtime, validation/credential-pattern policy, safe errors, ID-only events and production wiring. Offline composition and pin/revision cases PASS. Commands: runtime Jest RED→GREEN; `npm run check` PASS (17 suites/69 tests). Native integration NOT_RUN_ENVIRONMENT.
- TASK-M2-002: DONE (implementation/automated) — parameterized SQLite CRUD/search/filter/ranking, optimistic revisions, atomic pin protection and candidate deduplication. File-backed reopen/isolation PASS. Commands: targeted repository Jest RED→GREEN; `npm run check` PASS (16 suites/66 tests). Native SQLite NOT_RUN_ENVIRONMENT.
- TASK-M2-001: DONE (implementation/automated) — typed memory/source/pin/revision contracts and additive schema v2. v1 chat preservation, rerun and SQL constraints PASS. Commands: targeted memory-schema Jest (RED→GREEN), `npm run check` PASS (15 suites/63 tests). Native SQLite still NOT_RUN_ENVIRONMENT.
- M1 Review and Automated Verification: DONE (2026-09-30) — independent review fixes, regression tests, architecture/security/device acceptance docs, and one-command `npm run check`.
- TASK-M1-006: DONE (implementation/automated tests) — picker capability runtime, deny-by-default single-use policy, bounded selected images/text, staged attachments and explicit Send. Unneeded transitive Android permissions removed. Typecheck/lint/Jest 12 suites/53 tests PASS; native picker/device behavior NOT_RUN_ENVIRONMENT.
- TASK-M1-005: DONE (implementation/automated tests) — real DB/runtime composition, provider setup/model discovery/manual model ID, independent session options, history, stop/retry, rename/archive/delete UI. Typecheck/lint/Jest 10 suites/47 tests PASS; Android Metro release JS bundle PASS (not APK/native build).
- TASK-M1-004: DONE — event-driven send/stream/cancel/retry, partial checkpoints, stalled-provider cancellation/timeout, stable retry IDs, bounded history. Typecheck/lint/Jest 9 suites/45 tests PASS.
- TASK-M1-003: DONE — migration v1, provider metadata, sessions/messages, CRUD/archiving/pagination, serialized transactions, interrupted-turn recovery. File-backed SQLite close/reopen verified. Typecheck/lint/Jest 8 suites/41 tests PASS.
- TASK-M1-002: DONE (implementation/automated tests) — Keychain/Keystore adapter, credential references, provider settings validation. Typecheck/lint/Jest 7 suites/37 tests PASS. Native credential smoke remains NOT_RUN_ENVIRONMENT.
- TASK-M1-001: DONE — provider contracts/registry, HTTPS XHR transport, bounded SSE, abort/timeout and safe errors. Typecheck, lint and Jest 6 suites/34 tests PASS (2026-09-29). No live paid API request made.
- TASK-M0-002: DONE
  - Added compile-checked M0 architecture boundaries across app, features, runtime, domain, providers, native, data, protocol, security, and shared layers.
  - Added a runtime-only FeatureContext and platform-independent ProtocolEnvelope.
  - Added `docs/architecture/MOBILE_ARCHITECTURE.md` describing only the implemented M0 boundaries.
- TASK-M0-003: DONE
  - Added `CetaError`, the required `CetaErrorCode` union, structured logging, trace IDs, and recursive Secret redaction.
  - Added tests for redaction, ordinary fields, standard Error behavior, trace context, credential headers, circular fields, and Bootstrap error presentation.
- TASK-M0-004: DONE
  - Added the Nitro SQLite adapter, database configuration, `schema_version` bootstrap, migration engine, and empty M0 migration registry.
  - Production and test database names are explicit and isolated.
  - No destructive reset path is used; migration versions are validated and migration failures are retriable after rollback.
- M0 Acceptance Documentation: DONE
  - Added current security, protocol, and acceptance records without claiming deferred features are implemented.

Blocked:

- M5–M8 native/peer acceptance: BLOCKED — repository/Node/JavaScript gates
  pass, but no fresh Android APK build/install/device run, iOS compile/device
  run, Push provider delivery, or real Desktop/Server peer interoperability
  run in this Linux environment. These are explicitly `NOT_RUN_ENVIRONMENT`,
  not PASS. Android CI/APK static evidence from M4 remains valid for the
  unchanged native baseline.

- M4 Gate: BLOCKED — Android CI run 36730384479 and APK static acceptance PASS;
  iOS compilation, Android/iOS OS permission prompts, installed-app picker and
  notification behavior, camera/microphone hardware and device lifecycle
  checks remain NOT_RUN_ENVIRONMENT. The phase gate cannot be marked DONE from
  this Linux environment.
- M3 Gate: BLOCKED — four implementation tasks, automated checks and Android Debug Build complete. iOS compilation, hardware key nonexportability, camera lifecycle, controlled HTTPS no-retry and actual Desktop pairing remain NOT_RUN_ENVIRONMENT. Android compile PASS does not establish the device Gate.
- M2 Gate: BLOCKED — Android Build now PASS; installed-app upgrade/restart, Nitro SQLite and device UI/lifecycle/backup acceptance remain NOT_RUN_ENVIRONMENT.
- TASK-M0-001: BLOCKED for the roadmap's required installed Android Debug startup verification. Build/typecheck/lint/test acceptance now PASS on the cumulative M3 source and iOS project structure exists; no emulator/device launch has run. iOS native compilation remains NOT_RUN_ENVIRONMENT separately.
- M1 Gate: BLOCKED — Android Build now PASS; fresh install, native secure-storage/picker/SQLite integration and live model verification remain NOT_RUN_ENVIRONMENT. Six implementation tasks are complete; this is not a Standalone Alpha Gate PASS.

Last Verification:

- 2026-10-04 round-4 device-feedback fixes (PR #10 branch, merged with `main`
  `3e3f1df`; PROJECT_STATE conflict resolved by keeping both sides) — `npm run
  check` PASS: TypeScript, ESLint, architecture boundary checks, and Jest 69
  suites / 269 tests, 0 skipped. Fixes: update-announcement titles no longer
  repeat a version already present in the release name; the duplicated intro
  blocks were removed from the Tasks and Memory screens; about-app and task-ui
  regressions cover both. Native/device behavior remains NOT_RUN_ENVIRONMENT
  until the next APK build and device pass.
- 2026-10-04 local Windows gate on `main` `3d34957` — `npm run check` PASS:
  TypeScript, ESLint, architecture boundary checks, and Jest 69 suites / 268
  tests, 0 skipped. Includes the PR #7 context-budget history admission, the
  PR #8 workspace intro dedup and the PR #9 public update source. Android/iOS
  native builds and device behavior remain NOT_RUN_ENVIRONMENT on this machine;
  the matching Android CI run `37171452572` (Standalone APK build, verification,
  upload) PASSed.
- 2026-09-30 M5–M8 final repository gate — `npm run check` PASS: TypeScript,
  ESLint, architecture boundary checks (5 Node checks), and Jest 56 suites /
  213 tests, 0 skipped. Targeted M5–M8 gate tests, extension lifecycle tests,
  trusted transport tests, sync reconciliation tests and capability binding
  tests PASS. `npm run android:debug`, iOS native compilation, installed-app
  behavior, Push delivery and real peer interoperability are
  `NOT_RUN_ENVIRONMENT` in this Linux workspace.
- 2026-09-30 Metro release bundles — PASS with the temporary resolver config
  required by the workspace's shared `node_modules` symlink:
  `npx --no-install react-native bundle --config /tmp/cetamesh-m8-metro.config.js
  --platform android ...` and the equivalent `--platform ios ...`. React
  Native upstream private-export warnings were emitted; both bundle outputs
  were written successfully.
- 2026-09-30 Android Debug Build — NOT_RUN_ENVIRONMENT: `GRADLE_USER_HOME=/tmp/cetamesh-m8-gradle npm run android:debug` could not download
  Gradle 9.4.1 because the workspace network is unreachable. No APK was
  produced or launched.
- M8 security review follow-ups — Capability grants now match request
  caller/device/task/scope/target before providers; malformed sync, extension,
  plugin, HTTP and WebSocket payloads map to bounded CetaErrors; extension
  content hashes are pure-JS SHA-256 values and no executable payload is
  persisted or invoked.

- TASK-M4-006 — `npm run check` PASS: TypeScript, ESLint, architecture checks
  (5 Node checks), and Jest 32 suites/146 tests; targeted notification/Runtime
  tests PASS (12), React Native Codegen for Android/iOS PASS, and Android/iOS
  Metro release bundles PASS. Android native compile and APK static acceptance
  PASS in CI run 36730384479; iOS compile, OS prompt and notification delivery
  behavior were not run locally.

- Android CI [run 36730384479](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36730384479) — PASS on 2026-09-30: clean `npm ci`, `npm run check`, `BUILD SUCCESSFUL`, APK signature/static verifier PASS, and Debug APK upload PASS for commit `4c11c4ca6cfd336850ab967cc8113853bb7aba9b`. The preceding run 36727820944 also compiled the same M4 source successfully but exposed the remote executable-bit upload defect before verifier execution; the defect was corrected in the run-12 tree.
- M4 Android Debug APK artifact `11104509585` — 45,821,220-byte archive, SHA-256 `8fc5b7ace3a8f84583fe960d5082b729de0fd1b72a295de1faa5d5de26962348`, expires 2026-10-14. Static artifact evidence only; no installed-app, notification, camera, microphone, picker or hardware behavior is claimed.

- TASK-M4-005 — `npm run check` PASS: TypeScript, ESLint, architecture checks
  (5 Node checks), and Jest 31 suites/141 tests; targeted adapter/policy/UI
  tests PASS (13). Native picker and Android/iOS build behavior were not run
  locally.

- TASK-M4-004 — `npm run check` PASS: TypeScript, ESLint, architecture checks (5
  Node checks), and Jest 30 suites/135 tests; targeted microphone tests PASS (5),
  React Native Codegen for Android/iOS PASS, and Android/iOS Metro release
  bundles PASS. Android/iOS native build, OS prompt and microphone hardware
  behavior were not run locally.

- TASK-M4-003 — `npm run check` PASS: TypeScript, ESLint, architecture checks (5
  Node checks), and Jest 29 suites/131 tests; React Native Codegen for Android
  and iOS PASS. Android/iOS native build and camera hardware behavior were not
  run locally.

- TASK-M4-002 — `npm run check` PASS: TypeScript, ESLint, architecture checks (5
  Node checks), and Jest 28 suites/126 tests. Native OS permission prompts and
  platform implementations were not run in this environment.

- TASK-M4-001 — `npm run typecheck` PASS; `npm run lint` PASS;
  `npm run test:architecture` PASS (5 Node checks); `npm run test:unit
  -- --runInBand` PASS (27 suites/117 tests). No native M4 capability was
  claimed or run.

- Android CI [run 36716374111](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36716374111) — PASS on 2026-09-30: clean checks (26 suites/111 tests), `BUILD SUCCESSFUL in 15m 26s`, APK Signature Scheme v2 verified, static APK gate PASS for arm64-v8a/armeabi-v7a/x86/x86_64, artifact upload PASS.
- APK artifact `11097261367` — 45,775,531-byte archive, SHA-256 d7a4a206af70d1055ef27277fe209021e26782ffb1662d367afe9f16cff02880, expires 2026-10-14. Produced from remote `672374cb39e0143d5ed822cb5efe356df219f6dc`. Static validation only; no installation or hardware behavior claimed.
- Local verification against prior artifact `11095696570`: ZIP checksum matched GitHub metadata; APK SHA-256 1508a0b10251909eb1de21156e456c1b8707a27c1ae70c9cff518a761d8db592; Android 37 `apksigner` v2 verification PASS; `aapt2` manifest/permission checks PASS; all four ABIs and compiled Identity/QR/Pairing modules present; no key/secret-like file names. Appending a byte caused the gate to fail at signature/ZIP verification as required.
- Android CI [run 36711723719](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36711723719) — PASS, job 109874858162 completed success. Clean `npm ci`, `npm run check` PASS (26 suites/111 tests), `:app:compileDebugKotlin`, `:app:assembleDebug`; log reports `BUILD SUCCESSFUL in 17m 15s`. Covers all configured Android ABIs (armeabi-v7a, arm64-v8a, x86, x86_64), native identity/QR/pairing modules and production dependency wiring.
- APK artifact `11095696570` — upload PASS, archive 45,775,533 bytes, SHA-256 f5112e90735a44c1870f55757cccb87c66c4ee1a57d8810ae68eb2f3039d7325, expires 2026-10-14. Produced from remote `1f7f89b5fe27c72a981e1b9ff1746316f713b81d`. No APK launch or installed-device test was run.
- M3 uploaded to dedicated cetamesh-mobile main as `385a99cfe798cb62416c9d9e63175c13033e2cdb`; all 62 changed blob hashes match local sources, existing parent/history and LICENSE hash preserved, no signing key uploaded. Local task commit is 13362bb.
- Android CI run `36711135511`: historical FAIL during SDK setup, `Failed to find package 'platforms;android-37'`; npm checks/native build skipped, no APK. Official Google metadata publishes `platforms;android-37.0` and `build-tools;37.0.0` on stable channel. Corrected without lowering compile/target API; subsequent run PASS above.
- 2026-09-30 M3 final `npm run check` — PASS: TypeScript, ESLint 0 errors/warnings, architecture guard/5 Node checks, Jest 26 suites / 111 tests, 0 skipped.
- Actual Node SQLite additive v2→v3/repeat migration, preserved Memory, file-backed trust/replay reopen, trust insertion cancellation rollback and removal/final-confirm race — PASS. Native Nitro SQLite remains NOT_RUN_ENVIRONMENT.
- Real Node P-256 DER signed exchange/confirm, tamper rejection, expiration, changed-ID token replay and cancellation of revoked authorization — PASS. These do not establish Android/iOS hardware behavior.
- Targeted regressions: `npm test -- --runInBand src/test/pairing-protocol.test.ts src/test/devices-ui.test.tsx` RED→GREEN for actual RN URL bounds/loopback and confirmation-refresh UI; changed-ID token regression RED→GREEN. Android automatic retry addressed with retries disabled and one-shot POST; native controlled-peer test NOT_RUN_ENVIRONMENT.
- `node node_modules/react-native/scripts/generate-codegen-artifacts.js -p . -t all -o /tmp/ceta-m3-final-codegen` — PASS; separately combine schema and `generate-specs-cli.js --platform android --javaPackageName com.cetameshmobile.identity` — PASS. Identity fingerprint, QR and pairing transport specs are generated. Codegen is not native compilation.
- `npx --no-install react-native bundle --config /tmp/ceta-m3-metro.config.js --platform android --dev false --entry-file index.js --bundle-output /tmp/ceta-m3-final-android.bundle --assets-dest /tmp/ceta-m3-final-android-assets` — PASS. Same command for ios with iOS paths — PASS. Temporary config accounts for the reused node_modules symlink; product config unchanged. Upstream private-export/NO_COLOR warnings do not prevent packaging.
- Local `GRADLE_USER_HOME=/tmp/cetamesh-gradle npm run android:debug` — NOT_RUN_ENVIRONMENT: Gradle download Network is unreachable; Android SDK/ADB absent locally. Remote CI subsequently compiled the M3 APK successfully. iOS build/device checks — NOT_RUN_ENVIRONMENT: Linux without Xcode/Ruby/Pods or supported hardware.
- Independent read-only full M3 review addressed (2 Important, 1 Minor, no Critical reported); disposition in `docs/acceptance/M3_REVIEW.md`. Endpoint grammar is canonical DNS/IPv4; IPv6 literals unsupported. The original whalebridge repo remains unchanged.

Historical M2 Verification:

- 2026-09-30 recovery re-verification — restored the previously delivered M2 archive into an independent local checkout; the original M1 checkout was preserved. Archive has no Git history; local baseline commit is b6e74d0 (not the original M2 commit).
- `npm run check` — PASS again: TypeScript, Lint, architecture guard, Jest 19 suites / 81 tests, 0 skipped. Dependency lockfile matches the existing installed dependency tree reused for this run.
- `GRADLE_USER_HOME=/tmp/cetamesh-gradle npm run android:debug` — NOT_RUN_ENVIRONMENT for APK compilation: initial socket restriction was overcome on retry; Gradle 9.4.1 and React Native build plugins downloaded/compiled, then configuration failed with `SDK location not found`. No APK was built or launched. Android SDK, sdkmanager and adb are absent.
- iOS native acceptance — NOT_RUN_ENVIRONMENT at M2 recovery: Linux host with no xcodebuild/Ruby/CocoaPods. Installed-app migration/restart, device SQLite and live-provider acceptance remained unverified; this record predates M3 and the authorized upload.

- 2026-09-30 final M2 `npm run check` — PASS: TypeScript; Lint (0 errors/warnings); current-source architecture guard/tests; Jest 19 suites / 81 tests, 0 skipped.
- Real SQLite v1→v2 upgrade/repeat migration, preserved M1 rows, CRUD/ranking/literal Unicode search, optimistic revisions/pin races, deduplication, source/pin file-backed reopen and isolated test DB — PASS.
- Review regression commands: targeted runtime/repository/extraction Jest RED→GREEN; English labelled credential rejection across save/update/preview/confirm, Éclair/МОСКВА/Σπίτι exact matching, deletion/change interleaved after runtime check but before SQL commit — PASS. Saved/pinned memory survives later source chat deletion.
- Independent read-only review: 3 Important findings fixed, no Critical/Minor reported. Decisions and limits: `docs/acceptance/M2_REVIEW.md`.
- `npx --no-install react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/cetamesh-m2-android.bundle --assets-dest /tmp/cetamesh-m2-android-assets` — PASS (post-fix JS only).
- `npx --no-install react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/cetamesh-m2-ios.bundle --assets-dest /tmp/cetamesh-m2-ios-assets` — PASS (post-fix JS only).
- `GRADLE_USER_HOME=/tmp/cetamesh-gradle npm run android:debug` — NOT_RUN_ENVIRONMENT: Gradle 9.4.1 download denied with SocketException: Operation not permitted; Android SDK/ADB absent.
- iOS native build and M2 device migration/restart/UI/backup — NOT_RUN_ENVIRONMENT: Linux host, no Xcode/Ruby/Pods or native device runtime. M1 live-provider acceptance remains NOT_RUN_ENVIRONMENT (no real API credential).
- Metro emits upstream React Native private-export fallback and CLI setup script EPERM warnings but completes both bundles. JS packaging does not substitute for native acceptance.

Historical M1 Verification:

- 2026-09-30 final `npm run check` — PASS: TypeScript; Lint (0 errors/warnings); current-source architecture scan and 5 Node guard tests; Jest 14 suites / 61 tests (0 skipped).
- Real SQLite migration, transaction rollback, pagination, interrupted-turn recovery and file-backed close/reopen — PASS in executable Node SQLite tests; native Nitro SQLite remains NOT_RUN_ENVIRONMENT.
- Regression review — PASS: secure-write/DB failure keeps the previously published credential pair; runtime close cancels/drains before DB close; valid Android encoded document IDs accepted; picker copies/stat/reads/cleans local cache; provider switching discards stale model discovery; overlapping pagination is unique; Retry preserves next draft.
- `npx --no-install react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/cetamesh-m1-android.bundle --assets-dest /tmp/cetamesh-m1-android-assets` — PASS (JS only).
- `npx --no-install react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/cetamesh-m1-ios.bundle --assets-dest /tmp/cetamesh-m1-ios-assets` — PASS (JS only).
- `GRADLE_USER_HOME=/tmp/cetamesh-gradle npm run android:debug` — NOT_RUN_ENVIRONMENT: Gradle 9.4.1 download fails with Network is unreachable; Android SDK/ADB unavailable. Default Gradle home also is not writable in the sandbox.
- iOS native build — NOT_RUN_ENVIRONMENT: Linux; `xcodebuild`, Ruby and CocoaPods unavailable. Tool inventory also confirms `adb` and `sdkmanager` unavailable.
- Native fresh install, Keystore/Keychain, OS picker, merged Manifest, TLS/redirect and real provider streaming — NOT_RUN_ENVIRONMENT: no native runtime/device or real API credentials. See `docs/acceptance/M1_DEVICE_CHECKLIST.md`.
- Metro emits an upstream React Native private feature-flags export fallback warning; both JS bundles still complete. Native compatibility is not inferred from this.

Historical M0 Verification:

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run test:unit` — PASS (2 suites, 2 tests)
- `npm run test -- --runInBand src/test/architecture-boundaries.test.ts` — PASS (3 tests)
- `npm run typecheck` — PASS after architecture skeleton
- `npm run lint` — PASS after architecture skeleton
- `npm run test:unit` — PASS (3 suites, 5 tests)
- `npm test -- --runInBand src/test/errors-logging.test.ts` — PASS (4 tests)
- `npm run typecheck` — PASS after error/logging foundation
- `npm run lint` — PASS after error/logging foundation
- `npm run test:unit` — PASS (4 suites, 9 tests)
- `npm test -- --runInBand src/test/database.test.ts` — PASS (6 tests)
- `npm run typecheck` — PASS after SQLite foundation
- `npm run lint` — PASS after SQLite foundation
- `npm run test:architecture` — PASS (3 Node tests)
- `npm run typecheck` — PASS after final M0 fix pass
- `npm run lint` — PASS after final M0 fix pass
- `npm run test:unit` — PASS (5 suites, 20 tests)
- Executable Node SQLite migration test — PASS
- Structured logger credential-header and circular-field tests — PASS
- Bootstrap structured-error UI test — PASS
- Native SQLite runtime integration — NOT_RUN_ENVIRONMENT: Android SDK/ADB and iOS/Xcode/CocoaPods are unavailable.
- Android/iOS project structure check — PASS
- New Architecture marker check — PASS (`android/gradle.properties`, `newArchEnabled=true`)
- `npm run android:debug` — NOT_RUN_ENVIRONMENT: Gradle Wrapper could not download Gradle because network access is unavailable; Android SDK/ADB are also absent.
- iOS native build — NOT_RUN_ENVIRONMENT: `xcodebuild`, Ruby, and CocoaPods are unavailable in this Linux environment.
- Gate re-verification — 2026-09-29: `npm run typecheck` PASS; `npm run lint` PASS; `npm run test:architecture` PASS (3 tests); `npm run test:unit` PASS (5 suites, 20 tests).
- Gate re-verification — 2026-09-29: `npm run android:debug` remains NOT_RUN_ENVIRONMENT; Gradle Wrapper download failed with `java.net.SocketException: Network is unreachable`, and Android SDK/ADB remain unavailable.
- Native toolchain path scan — 2026-09-29: no usable Android SDK/ADB/Gradle distribution or iOS `xcodebuild`/Ruby/CocoaPods installation was found in the available local paths.

Known Risks:

- M5–M8 remains unverified against a live Desktop/Server peer and physical
  Android/iOS devices. Trust, presence, advertisement, permission and local
  execution boundaries are implemented and tested, but interoperability and
  OS-level delivery still require their respective environments.
- Remote Plugin execution is transport-only and declarative; local executable
  extensions, arbitrary JavaScript, unrestricted shell, unrestricted native
  bridges and implicit Memory upload remain intentionally unsupported.

- M3 requires hardware-backed Android Keystore / iOS Secure Enclave; software-only devices and simulators may be unsupported. Corrupt/missing public metadata fails closed; no identity repair/rotation API.
- Pairing peer must implement the documented contract and atomically consume/expire tokens. Actual Desktop interoperability is unverified; no Desktop source was edited. Consumed token fingerprints are retained without pruning/quota in M3.
- HTTPS destination confirmation and default certificate validation are required. Canonical DNS/IPv4 grammar rejects IPv6 literal origins; it is not a DNS-resolution sandbox. Native no-retry and lifecycle behavior require device acceptance.
- M2 extraction is intentionally conservative/offline: only explicit remember requests, latest 200 messages / 10 candidates, no automatic Memory prompt injection or upload.
- Memory credential detection covers common labelled/prefix patterns, not arbitrary unlabelled secrets. Chat/Memory SQLite content is not encrypted by this implementation.
- Android SDK/ADB are not available in the current environment.
- Ruby/CocoaPods are not available in the current environment.
- Android Debug Build and APK static acceptance are verified in CI; native app startup/hardware/security/device lifecycle remain unverified. iOS still needs macOS/Xcode and Secure Enclave hardware.
- Dedicated repository cetamesh-mobile contains the authorized M0–M8 source and
  prior passing Android CI evidence. Existing LICENSE/history are preserved; no
  signing key was uploaded. Original whalebridge remains read-only.
- New Architecture native integration and final merged permissions need the first provisioned-device acceptance run.
- Reasoning and image support depend on the configured compatible provider; Smart is model-only. Unsupported binary/PDF/office files are rejected explicitly.
- API secrets are in system secure storage; chat and attachments are ordinary local SQLite data. Failed secure-store cleanup can leave an unreachable credential in the OS store (never SQLite).

Next Task:

- M9: TODO — not started; no later-phase implementation was begun as part of
  the M5–M8 request.
