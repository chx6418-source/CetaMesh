# Local Storage / Build Artifact Hygiene Report

**Audit date:** 2026-10-11<br>
**Scope:** CetaMesh Desktop and Mobile local build/test artifacts, release retention, local caches, and Git object storage.<br>
**Desktop task branch:** `codex/local-storage-hygiene` (`205d88b623f01828b27ad1d66110f09e1a537fe8`)<br>
**Mobile task branch:** `codex/local-storage-hygiene-mobile` (`4b80d2d7910b80e395f366f5841a11083c3f621d`)

## Delivered

- Added Desktop dry-run-first `cleanup:status`, `cleanup:dev`, and `cleanup:release` commands. Cleanup accepts only fixed allowlisted paths, verifies containment and reparse points, rejects Git-tracked files beneath the Dev cache, and requires `--apply` for deletion.
- Added the canonical Desktop release layout under `artifacts/{dev,rc,stable}` with unique staging directories, immutable version/build destinations, SHA-256 manifests, and a `remoteBackedUp: false` marker until a verified remote upload exists. Legacy `dist/` packages are left in place.
- Changed `npm test` suites to run with UUID-marked OS Temp sandboxes. Successful runs and ordinary failures are removed after suite processes close; `KEEP_TEST_ARTIFACTS=1` retains only the latest completed failure per suite, and concurrent running suites are preserved. Timeouts terminate and await the suite process tree; if termination cannot be confirmed, its sandbox is preserved and the suite fails.
- Routed repository test fixtures that wrote beneath `output/` to the suite Temp sandbox or OS Temp.
- Fixed Windows timeout cleanup in the isolated test runner: the watchdog now waits for `taskkill /T /F` to finish before reporting timeout completion. The new regression assertion verifies that the timed-out workspace can be deleted immediately.
- Added separate Mobile Android artifact staging, canonical package/manifest paths, dry-run cleanup commands, and independent retention rules. Release versions must be safe SemVer path components, and artifact, staging, version, and manifest directories reject reparse points before Gradle starts and are revalidated after Gradle before output reads or publishing. Gradle build directories and release outputs remain separate from Desktop.
- Added the cleanup policy, storage audit, safe cleanup plan, and this report.

## Desktop storage measurements

The shared Desktop checkout was measured before and after the exact cache cleanup. Directory totals exclude `.git` and nested directory rows overlap.

| Measurement | Before | After | Change / handling |
|---|---:|---:|---|
| Shared Desktop checkout, excluding `.git` | 18,106,932,045 bytes | 15,143,250,207 bytes | 2,963,681,838 bytes reclaimed |
| `desktop-shell/target/debug/incremental` | 2,963,681,838 bytes | absent | Exact allowlisted Rust incremental cache deleted |
| `desktop-shell/target` | — | 11,539,699,787 bytes | Kept; no `cargo clean` |
| `dist` | — | 3,280,352,219 bytes | Kept; includes 21 legacy installer packages |
| `output` | — | 149,475,671 bytes | Kept; remaining output was not part of the exact allowlist |
| `node_modules` | — | 44,385,139 bytes | Kept |
| Shared Git object store | 393,302,576 bytes | 392,977,532 bytes | Measured only; no prune, GC, or history rewrite |

All 21 historical Desktop installers lack a build number and verified remote-backup marker. They remain untouched. The candidate release-prune total is zero because there are no eligible verified, duplicated, backed-up release packages.

## Mobile and external cache measurements

- Active Mobile checkout: 320,745,333 bytes excluding `.git`; `node_modules` is 318,764,543 bytes. Android build and Gradle output directories and APK/AAB packages were absent.
- The isolated Mobile task worktree contains 320,773,631 bytes excluding `.git`; its 318,764,548-byte `node_modules` tree was installed offline for validation. No Android SDK or `adb` is installed, so a real Gradle package build was not run.
- npm cache was 1,408,507,702 bytes at audit and 1,114,431,465 bytes at the final metadata check. `npm cache verify` completed successfully (3,197 content entries, 889,946,710 content bytes, 3,353 index entries). No force-clean command was run.
- The default global Gradle cache was absent. App runtime data, identity/device data, migration backups, Downloads/Desktop files, other worktrees, and release packages were preserved. External scans used matching path names and metadata only; personal file contents were not read.
- Git history was measured only. Large historical blobs remain; no object pruning or history rewrite was performed.

## Test Temp cleanup

The final Desktop aggregate run cleaned its own suite sandboxes. Seven exact stale suite directories from earlier task runs were separately verified and removed, reclaiming 1,908,352 bytes. The checks covered exact Temp-root containment, marker/run identity where present, dead recorded PIDs, measured size, and reparse counts. The removed workspace-runtime sandbox contained two test junctions; cleanup removed their entries without traversing the targets.

Two workspace-runtime directories remain in OS Temp, totaling 140,929 bytes. One has a stale `running` marker whose PID was observed as a Windows WMI process, so that PID cannot identify the original suite. The other disappeared during its immediate pre-delete check and reappeared in a later inventory. Both are preserved for manual review because the evidence did not establish safe ownership at deletion time.

## Verification

- Desktop `npm test`: **82 PASS, 0 FAIL, 12 NOT_RUN_ENVIRONMENT** across 94 suites. Skips are recorded for unavailable legacy bridge, core/release distribution, shell-debug, gateway/network, and opt-in Cargo environments. Cargo remained opt-in to avoid rebuilding the large Rust target.
- Desktop `npm test -- --category security`: **11 PASS, 0 FAIL**, including descendant termination before sandbox cleanup and the immediate workspace-removal regression.
- Desktop `npm test -- --category runtime`: **34 PASS, 0 FAIL**; the Model Runtime fixture path assertion confirms writes stay in the aggregate sandbox.
- Desktop `npm test -- --category release`: **5 PASS, 0 FAIL, 3 NOT_RUN_ENVIRONMENT** because core/release distribution artifacts are absent. Includes regression coverage for rejecting tracked Dev-cache files, failing closed without Git metadata, duplicate manifest artifact paths, and staging junctions.
- Mobile `npm run check`: passed TypeScript, ESLint, 5 architecture-boundary checks, 71 Jest suites / 288 tests, and 11 Mobile artifact-hygiene fixtures, including duplicate-manifest retention and post-Gradle junction revalidation.
- `git diff --check` passed in both task worktrees.
- Desktop `cleanup:status` reports zero eligible Dev cleanup and zero eligible backed-up release cleanup in the isolated task worktree. npm cache remains report-only.

## Branch and shared-worktree state

Both task branches remain uncommitted and available for review. No push, merge, commit, or branch deletion was performed. The shared Desktop checkout remains on `design/ui-ia-exploration-2026-10` with its pre-existing dirty changes and unresolved conflicts in `PROJECT_STATE.md`, `src/app/ipc-runtime.js`, and `src/app/service-container.js`; it was not reset or modified by this task. The Mobile shared checkout remains on `codex/production-release-integration`.

## Supporting records

- [STORAGE_AUDIT.md](STORAGE_AUDIT.md)
- [SAFE_CLEANUP_PLAN.md](SAFE_CLEANUP_PLAN.md)
- [CLEANUP_POLICY.md](docs/development/CLEANUP_POLICY.md)
- [Mobile storage policy](C:/Users/Administrator/.codex/worktrees/local-storage-hygiene-mobile/docs/LOCAL_STORAGE_HYGIENE.md)
