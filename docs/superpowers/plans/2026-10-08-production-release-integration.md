# Production Release Integration Plan

> **For agentic workers:** Use the execution workflow for this plan task by task. This is a release integration and verification task; do not reimplement completed A–D feature work.

**Goal:** Verify the Desktop, Mobile, pairing, extension, theme, and distribution release gates and produce an evidence-based CetaMesh 1.0 release report.

**Architecture:** Treat the Desktop, Mobile, and GitCode distribution repositories as separate release inputs. Audit existing commits and reports first, run only the requested checks and builds, classify real-device or credential-dependent work as `NOT_RUN_ENVIRONMENT` or `BLOCKED_SIGNING`, and choose Stable only when every required gate passes.

**Tech Stack:** Git, Node.js/npm, Rust/Cargo, React Native, Android Gradle, Windows installer tooling, SHA-256 manifests.

**Spec:** User-provided Production Release Integration instructions in `C:\Users\Administrator\.codex\attachments\b58035e5-d698-488d-9557-572e04664f4a\已粘贴的文本.txt`.

## Global Constraints

- Audit and preserve completed A GitCode Distribution, B Desktop–Mobile Pairing, C Extension Process Runtime, and D Native Theme Migration work; do not reimplement them.
- Confirm each candidate commit, its test evidence, and its report before integrating it.
- Resolve conflicts from the latest `RULES.md`, `PROJECT_STATE.md`, and actual source; never apply blanket `ours` or `theirs` to core code.
- Desktop tests use `npm test` as the unified entry point; run `npm run desktop:check` and `npm run desktop:test` as requested.
- Build release artifacts from a clean commit; do not alter or discard the pre-existing deletion of `assets/project-intro.mp4` in the Desktop checkout.
- Never claim real device, Provider, QQ/DSH, signature, or GitCode publication success without direct evidence.
- Android release APK must be standalone and signed with a valid release credential; do not present debug signing as production signing.
- Windows Authenticode is `NOT_RUN_ENVIRONMENT` or `BLOCKED_SIGNING` when no established code-signing certificate is available; do not create a temporary self-signed certificate.
- Use `1.0.0` only when every required release gate passes; otherwise keep the release at `1.0.0-rc.2`.
- Keep the release work branch until Owner confirmation; do not merge into `main`, publish artifacts, or delete the branch before the applicable gate and confirmation.

## Review Focus

- A dirty source tree must not leak into `build-info.json`, installer payloads, or release manifests.
- The Mobile release APK must contain its JS bundle, install without Metro, and use real release signing.
- Desktop updater and Mobile updater must agree on GitCode primary, GitHub fallback, manifest schema, version, artifact names, and SHA-256 values.
- Pairing trust must survive restart without another scan, and revoke must invalidate the device; if hardware is absent, record the exact `NOT_RUN_ENVIRONMENT` boundary.
- Missing Provider keys, QQ/DSH services, signing certificates, or GitCode credentials must remain explicit blockers rather than implied PASS results.

---

### Task 1: Audit merged session work and release inputs

**Files:**
- Read: `RULES.md`, `PROJECT_STATE.md`, `DISTRIBUTION_UPDATE_REPORT.md`, `UNIFIED_PAIRING_INTEROP_REPORT.md`, `EXTENSION_PROCESS_RUNTIME_REPORT.md`, `NATIVE_THEME_MIGRATION_REPORT.md`.
- Read: Mobile `AGENTS.md`, `PROJECT_STATE.md`, `docs/acceptance/M9_PRIVATE_BETA.md` and Android release configuration.
- Record: `CETAMESH_1_0_RELEASE_REPORT.md`.

- [ ] Verify the commit, test evidence, and report for each A–D workstream from Git history and current source.
- [ ] Compare Mobile `main` with the M9 candidate branch; identify unique commits, gate state, and merge conflicts before integrating any candidate.
- [ ] Record starting Desktop, Mobile, and GitCode HEADs and all pre-existing working-tree changes.

### Task 2: Run Desktop verification and clean release build

**Files:**
- Read: `docs/desktop/BUILD_AND_RELEASE.md`, release scripts in `scripts/`, generated `dist/` outputs.
- Record: Desktop results in `CETAMESH_1_0_RELEASE_REPORT.md`.

- [ ] Run `npm test`, `npm run desktop:check`, and `npm run desktop:test`.
- [ ] Run requested specialist coverage through the registered suite; preserve each `NOT_RUN_ENVIRONMENT` result.
- [ ] In a clean detached worktree at the candidate commit, run `npm run build:core`, `npm run desktop:build`, `npm run build:release`, and `npm run test-release-candidate`.
- [ ] Verify installer, Core SEA Extension Worker, no-web/no-http release contract, manifest fields, and Desktop SHA-256.

### Task 3: Verify Mobile source and Android release candidate

**Files:**
- Read/modify only as required: Mobile `PROJECT_STATE.md`, `package.json`, `package-lock.json`, `android/app/build.gradle`, CI/release scripts.
- Record: Mobile and APK results in `CETAMESH_1_0_RELEASE_REPORT.md`.

- [ ] Integrate only reviewed, completed Mobile commits that are required for the candidate; preserve a separate gate status for M9 device verification.
- [ ] Run `npm ci` and `npm run check` on the integrated candidate.
- [ ] Build and statically verify a standalone release APK when Android SDK/NDK and legitimate signing material are available.
- [ ] Install the APK only when a real Android device is available; otherwise state the missing tool/device evidence precisely.

### Task 4: Verify cross-device and live-environment gates

**Files:**
- Read: pairing and extension integration tests, existing acceptance reports, local runtime/tool availability.
- Record: Pairing, Mesh, Extension, Theme, Provider, QQ, and DSH results in `CETAMESH_1_0_RELEASE_REPORT.md`.

- [ ] Run requested automated cross-feature tests and inspect existing theme QA evidence.
- [ ] Exercise Desktop QR → Android scan → mutual approval → trusted/presence/manifest, restart persistence, and revoke when devices are available.
- [ ] Exercise a real Provider stream/stop/retry/restart only through configured secure storage; never print the key.
- [ ] Check QQ/SnowLuma and DSH independently; their failure must not block standalone CetaMesh Chat.
- [ ] Run the ProcessExtensionHost crash/recovery check against the release Core where supported.

### Task 5: Verify distribution and assign the release version

**Files:**
- Read/modify only after gates: Desktop and Mobile updater manifests/configuration, GitCode/GitHub release assets, `CETAMESH_1_0_RELEASE_REPORT.md`.

- [ ] Verify GitCode source mirror, Release assets, updater, and GitHub fallback with an old-version update fixture.
- [ ] Compare artifact SHA-256 across local output, GitCode, and GitHub; record version, buildId, sourceCommit, size, and publishedAt.
- [ ] Set `1.0.0` only when every required release gate passes; otherwise use `1.0.0-rc.2` and report all blockers.
- [ ] Stop after the release report; do not start new feature development.
