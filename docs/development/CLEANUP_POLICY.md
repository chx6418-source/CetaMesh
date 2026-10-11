# Local Cleanup and Artifact Policy

## Commands

- `npm run cleanup:status` reports metadata-only sizes and eligible cleanup totals.
- `npm run cleanup:dev` previews the exact allowlisted Rust incremental cache.
- `npm run cleanup:release` previews eligible old release packages.
- Cleanup commands are dry-run by default. Pass `--apply` to the underlying script only after reviewing the printed paths.

The cleanup implementation accepts only fixed relative paths. It rejects traversal, paths outside the repository, symbolic links, junctions, reparse points, changed directory sizes, stale plans, and tracked Dev-cache files. It never accepts a caller-selected path.

## Desktop output layout and retention

Successful packages publish once to:

```text
artifacts/{dev|rc|stable}/{productVersion}/build-{buildNumber}/
artifacts/.staging/{runId}/
artifacts/manifests/{channel}/{productVersion}/build-{buildNumber}.json
```

The staging directory is unique to one build and is removed on a failed process exit. A published build is immutable; an existing version/build path causes the new build to fail without moving or replacing it. Legacy `dist/` packages are not migrated or pruned automatically.

Each `release-manifest.json` records product version, channel, build number, source commit, build time, entry file, sizes, SHA-256 hashes, and `remoteBackedUp: false`. The marker must remain false until the release service confirms an upload completed and verifies its checksum. No release-service upload exists in this repository yet, so existing and newly built artifacts are ineligible for automatic deletion.

Retention limits are Dev 1, RC 2, and Stable 1 per channel. A package is a candidate only when it is outside the count window, has a valid manifest, every declared retention artifact matches its size and SHA-256, `remoteBackedUp` is exactly `true`, and every declared binary is duplicated by another valid package. Invalid, unique, unbacked, or legacy packages remain untouched. The policy prefers extra disk use over losing a unique installer.

## Tests and temporary files

All Desktop suites run through `npm test`. The aggregator creates one UUID-marked directory per suite below the operating system Temp root and sets `TMPDIR`, `TEMP`, `TMP`, and `WHALEBRIDGE_TEST_TMPDIR` for the child. Successful suites and failures are removed in `finally`; `KEEP_TEST_ARTIFACTS=1` retains only the newest completed failed diagnostic for a suite. A running or unmarked Temp directory is never considered for that retention cleanup.

Tests that need filesystem fixtures must use `WHALEBRIDGE_TEST_TMPDIR` (or the OS Temp root when run standalone), not the repository `output/` directory. Cargo tests retain the configured Rust target cache; do not run `cargo clean` as a storage cleanup shortcut.

## Caches and data boundary

- npm cache is inspected with `npm cache verify`; this policy does not run `npm cache clean --force`.
- Global Gradle cache is report-only.
- Local app data, workspace state, identity keys, migration backups, installers without verified backup, and all Git worktrees are outside automated cleanup.
- Git object storage is measured only. No history rewrite, prune, or garbage collection is performed by these commands.
