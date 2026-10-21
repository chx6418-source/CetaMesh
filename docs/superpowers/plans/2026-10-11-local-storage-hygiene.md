# Local Storage and Build Artifact Hygiene Implementation Plan

> **For agentic workers:** Execute task by task with test-first changes. Keep work isolated on `codex/local-storage-hygiene`; Mobile changes belong on `codex/local-storage-hygiene-mobile`.

**Goal:** Audit CetaMesh storage, recover only verified disposable build space, and prevent Desktop and Mobile builds and tests from accumulating unmanaged artifacts.

**Architecture:** Desktop gets a metadata-only status command, exact-path cleanup allowlists, manifest-based release retention, and one canonical `artifacts/{dev,rc,stable}` layout. The test aggregator gives each suite a marked OS-temp sandbox and removes it after exit. Mobile gets an independent release wrapper and matching retention policy in its own repository; neither tool touches user runtime data or unrelated worktrees.

**Tech Stack:** Node.js ESM for Desktop, Node.js CommonJS and Gradle for Mobile, existing repository test entry points, Git metadata, SHA-256 manifests.

**Spec:** User-provided Local Storage / Build Artifact Hygiene request in the current task.

## Global Constraints

- Cleanup defaults to dry-run; deletion requires explicit `--apply`.
- Only exact allowlisted generated paths may be removed; reject traversal, symlink, junction, and reparse-point escapes.
- Preserve source, dirty worktrees, user data, unique installers, signed packages, and artifacts without a proven remote backup.
- Desktop tests run through `npm test`; every new `scripts/test-*.mjs` is registered in `scripts/run-all-tests.mjs`.
- Mobile remains an independent React Native repository; do not copy Desktop code or touch credentials.
- Keep release manifests with product version, build number, commit, timestamp, SHA-256, and remote-backup state.

## Review Focus

- A cleanup target is a symlink/junction or resolves outside its canonical root; the plan must fail closed.
- An artifact has no valid manifest or is not remotely backed up; retention must preserve it.
- A previous build is the only copy of an installer; retention must keep it even when outside the count window.
- A test exits nonzero with `KEEP_TEST_ARTIFACTS=1`; retain only its latest marked diagnostic and clean successful runs.
- Gradle or packaging fails after creating partial output; do not publish it and do not remove a pre-existing artifact.

---

### Task 1: Desktop cleanup policy and safe cleanup commands

**Files:** Create `scripts/storage-hygiene.mjs`, `scripts/test-storage-hygiene.mjs`, and `docs/development/CLEANUP_POLICY.md`; modify `package.json` and `scripts/run-all-tests.mjs`.

**Interfaces:** `inspectStorage({ rootDir })`, `planCleanup({ rootDir, mode, now })`, `applyCleanup({ rootDir, plan })`, and `planArtifactRetention({ artifactRoot, now })`. CLI modes are `status`, `dev`, and `release`; `--apply` is the only deletion switch. Registered sibling worktrees may be targeted only after Git proves they belong to the same common repository.

- [ ] Add tests for dry-run default, exact allowlists, retained unique/unbacked artifacts, remote-backed retention, `..` rejection, and symlink escape.
- [ ] Run the focused release category through `npm test -- --category release`; confirm the new assertions fail for the missing module/behavior.
- [ ] Implement exact path resolution, realpath/reparse validation, metadata-only sizing, and release-manifest retention.
- [ ] Re-run the focused category, then `npm test` after all Desktop tasks.

### Task 2: Canonical Desktop release artifacts

**Files:** Modify `scripts/build-release.mjs` and `scripts/test-release-candidate.mjs`; extend release manifest tests.

**Interfaces:** Successful builds stage under `artifacts/.staging/<run-id>` and publish once to `artifacts/{dev,rc,stable}/<version>/build-<buildNumber>`. Failed builds remove only their own staging directory. A successful artifact records SHA-256, version, build number, source commit, timestamp, and `remoteBackedUp: false`; retention runs only after publication.

- [ ] Add tests for canonical path naming, manifest fields, staging failure cleanup, and preserving a pre-existing artifact on failure.
- [ ] Verify the tests fail before the build changes.
- [ ] Publish only to the canonical artifact path; stop rotating historical output into `dist/app-previous-*`.
- [ ] Resolve RC tests from the canonical artifact manifest and verify the release category.

### Task 3: Bounded test temporary output

**Files:** Modify `scripts/run-all-tests.mjs` and tests that currently write under repository `output/`.

**Interfaces:** Each suite receives a unique marked directory under system Temp through `TMPDIR`, `TEMP`, and `TMP`. The parent removes it in `finally` after success or failure unless the failing suite has `KEEP_TEST_ARTIFACTS=1`; marked retained failures are bounded to one latest diagnostic per suite.

- [ ] Test successful cleanup, failing-suite cleanup, explicit failure retention, and preservation of a concurrently running marked directory.
- [ ] Verify the new tests fail before implementation.
- [ ] Route test fixtures away from repository `output/` and add parent cleanup around child exit.
- [ ] Run `npm test` and confirm the registered test inventory has no orphan scripts.

### Task 4: Mobile APK/AAB artifacts and retention

**Files:** In the Mobile worktree, create `scripts/mobile-artifact-hygiene.cjs` and its fixture test; modify `package.json`; update Mobile `PROJECT_STATE.md` for one operations task.

**Interfaces:** `npm run build:android:release` runs existing Gradle release tasks and publishes APK/AAB output under the same channel/version/build-number structure. Mobile `cleanup:status`, `cleanup:dev`, and `cleanup:release` use exact allowlists and dry-run by default. The release manifest includes version, `versionCode` as build number, Git commit, timestamp, hashes, and `remoteBackedUp: false`.

- [ ] Add fixture tests for artifact naming, dry-run, manifest retention, traversal and symlink rejection.
- [ ] Run the new Mobile checks to observe the expected failure.
- [ ] Implement the wrapper and retention commands without changing signing credentials or native permissions.
- [ ] Run `npm run check`; record Android SDK/device checks as `NOT_RUN_ENVIRONMENT` when unavailable.

### Task 5: Audit, safe first-run cleanup, and final report

**Files:** Create `STORAGE_AUDIT.md`, `SAFE_CLEANUP_PLAN.md`, and `LOCAL_STORAGE_HYGIENE_REPORT.md` in the Desktop worktree.

- [ ] Record Git/worktree states, largest paths, installers, mobile/cache data, protected user-data paths, and Git object sizes.
- [ ] Apply only the verified `SAFE_AUTO_DELETE` allowlist; leave unbacked installers, worktrees, Mobile user data, and ambiguous Temp diagnostics for review.
- [ ] Re-measure the same scope, run the required tests, and report before/after/reclaimed bytes with environment limitations.
