# CetaMesh 1.0 Production Release Integration Report

Date: 2026-10-08  
Release candidate evaluated: **1.0.0-rc.2**  
Integration branch: `codex/production-release-integration`

## Release decision

**Do not promote to Stable 1.0.0.** RC2 source and the Windows desktop installer were built and exercised, but required release gates remain blocked or unverified. GitCode/GitHub synchronization could not be verified because Git could not acquire credentials (`SEC_E_NO_CREDENTIALS`). The work remains on local integration branches; no main branch was pushed.

## Integrated work and source state

- Desktop integration commit: `2986e7834b906d73ba5ba0c787c253999242fc76` (`chore(release): prepare CetaMesh 1.0 RC2 integration`). It aligns Desktop version metadata at RC2 and fixes the release-candidate architecture/system-page fixture expectations.
- Mobile integration commit: `4b80d2d` (`chore(release): align mobile RC2 version metadata`). It aligns npm/Android version metadata to RC2 and Android versionCode 2.
- Existing A-D implementation was already present in Desktop history and reports: GitCode updater, unified pairing, Extension ProcessHost/SEA, and native themes. This integration did not reimplement those features.
- The Desktop worktree contains a pre-existing unstaged deletion of `assets/project-intro.mp4`; it was preserved and not included in the integration commit.

## Gate results

| Gate | Result | Evidence / remaining work |
|---|---|---|
| Desktop aggregate tests | **PASS with environment skips** | `npm test`: 76 suites; 72 passed, 0 failed, 4 `NOT_RUN_ENVIRONMENT` (legacy bridge, gateway/network dependent cases). Includes RC, pairing, updater, Extension process E2E and Rust checks. |
| Desktop native checks | **PASS** | `npm run desktop:check`; `npm run desktop:test`: 147 passed, 0 failed. Existing compiler warnings remain. |
| Desktop core packaging | **PASS** | `npm run build:core`; 92.8 MB, no-Web output and artifact audit passed. SHA-256 `cca1d7c8a400502d3fe29eba32bc47509b0f731fe43a6125d5d7359ba7593abe`. |
| Desktop release installer | **PASS** | `npm run build:release`; Windows x64 installer produced, 42,328,064 bytes. SHA-256 `33b55c40347593c72f20ba60a4ef57effad9fec8e88ff9097e83ad996b268a84`. Build metadata: `1.0.0-rc.2+2986e78`, clean source tree in the detached build checkout. SBOM and checksums generated. |
| Desktop release lifecycle | **PASS** | `npm run test-release-candidate`: Chinese/spaced install path, no system Node, no HTTP listener, read-only install directory, crash recovery, single-instance behavior, orphan guard, and uninstall preserving user data all passed. |
| Windows signing | **BLOCKED_SIGNING** | Installer reports `NotSigned`; no `signtool` or signing certificate was available. Do not distribute as a signed production installer. |
| Mobile source checks | **PASS** | `npm ci` succeeded; `npm run check` passed TypeScript, ESLint, architecture (5/5), and Jest (71 suites / 288 tests). npm reported 58 dependency advisories (6 moderate, 52 high), not triaged in this release integration. |
| Mobile Android release APK | **BLOCKED_SIGNING / NOT_RUN_ENVIRONMENT** | Android SDK tools (`adb`, `sdkmanager`, `apksigner`) and SDK path were unavailable. Release Gradle config points to the debug signing config/test keystore. No APK was produced or installed; do not treat a debug-signed APK as production. |
| Desktop↔Android real pairing / Provider / QQ / DSH | **NOT_RUN_ENVIRONMENT** | No Android device/SDK was available. Desktop `npm run self-test` was attempted and failed at `settings/describe` with `ECONNREFUSED` because DSH did not accept a connection. Real Provider credentials were not configured. QQ/DSH processes were observed, but no successful real conversation or end-to-end device run is evidenced. |
| Extension ProcessHost | **PASS (automated)** | Covered by Desktop `npm test`, including process SEA E2E. Manual UI extension verification was not performed in this run. |
| Theme migration | **PASS (automated/history); manual QA NOT_RUN** | Existing migration report and automated Desktop checks cover the 10 themes. No live screenshot review was completed in this integration run. |
| GitCode distribution / GitHub fallback | **NOT_RUN_ENVIRONMENT** | GitCode updater implementation is present, but release publication and fallback pull were not verified. `git ls-remote` against both remotes failed with `SEC_E_NO_CREDENTIALS`; `gh` CLI was unavailable. No cloud push occurred. |

## Artifact facts

- Desktop output directory: `dist/app` in the detached build checkout at `C:\Users\Administrator\AppData\Local\Temp\cetamesh-release-rc2`.
- Installer SHA-256: `33b55c40347593c72f20ba60a4ef57effad9fec8e88ff9097e83ad996b268a84`.
- Core package SHA-256: `cca1d7c8a400502d3fe29eba32bc47509b0f731fe43a6125d5d7359ba7593abe`.
- Shell executable SHA-256: `f6a4cef25ab59994c9f9348a4ccb082a5a4d2a215dd94bf81e814bf84aee2b64`.
- Android APK: none produced.

## Required closure before Stable 1.0.0

1. Provide authorized GitCode/GitHub credentials and publish/synchronize the release candidate; verify the resulting remote refs and fallback behavior.
2. Sign the Windows installer with the release certificate and verify its signature.
3. Configure a proper Android release signing key, build and inspect the APK, then install it on a supported device.
4. Complete real Desktop↔Android pairing and Provider/QQ/DSH conversation checks, plus manual extension and theme UI review.
5. Reassess the 58 Mobile dependency advisories under the project’s release policy.

Until those gates are closed, keep this release labeled **1.0.0-rc.2**.
