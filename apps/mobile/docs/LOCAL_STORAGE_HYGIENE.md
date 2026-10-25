# Mobile Local Storage Hygiene

## Build outputs

Run `npm run build:android:release` to build `assembleRelease` and `bundleRelease`. The wrapper reads `versionName` and `versionCode` from `android/app/build.gradle`, checks that `versionName` matches `package.json`, and publishes APK/AAB files only after Gradle succeeds:

```text
artifacts/{dev|rc|beta|stable}/{versionName}/build-{versionCode}/
artifacts/.staging/{runId}/
artifacts/manifests/{channel}/{versionName}/build-{versionCode}.json
```

The app module's Gradle output directory is redirected to the unique staging directory for this build. A failure removes only that stage. Previously published packages are immutable and are not overwritten. The generated manifest includes version, `versionCode` build number, Git commit, timestamp, SHA-256 values, artifact sizes, and `remoteBackedUp: false`.

The repository currently configures the Android `release` build type with the debug signing config. This storage task leaves signing credentials and release signing configuration unchanged; generated packages must not be treated as production-signed until a release signing setup is provided.

## Cleanup

- `npm run cleanup:status` reports Mobile Android/build/artifact sizes without reading user file contents.
- `npm run cleanup:dev` previews only `android/app/build/outputs/apk/debug` and `android/app/build/outputs/bundle/debug`.
- `npm run cleanup:release` previews old canonical packages eligible under Dev 1, RC 2, Beta 2, Stable 1 retention.
- Cleanup is dry-run by default; `--apply` is required to delete the listed exact paths.
- Traversal, symlink/junction escapes, changed plans, unique binary packages, invalid manifests, and artifacts without `remoteBackedUp: true` are preserved.
- Global Gradle cache is report-only. The cleanup scripts do not remove it or Android user data.

## Fixture checks

`npm run check` includes `npm run test:artifact-hygiene`, which uses temporary Mobile fixture repositories. It does not require Android SDK or a device. SDK/device builds must be recorded as `NOT_RUN_ENVIRONMENT` when those tools are unavailable.
