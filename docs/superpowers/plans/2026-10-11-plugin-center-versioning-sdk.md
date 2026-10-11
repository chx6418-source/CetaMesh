# Plugin Center, Release Versioning, and Plugin SDK Implementation Plan

> **For agentic workers:** This plan follows the owner-provided CetaMesh 1.0 prelaunch task. Keep the existing Extension Runtime, ProcessExtensionHost, Capability Broker, Extension Installer, Owner Review, Update/Rollback, and Memory Pack contracts.

**Goal:** Add an in-app official plugin catalog and safe distribution path, a canonical release version/build model, and a validated plugin authoring kit.

**Architecture:** A new catalog/distribution service will validate catalog metadata and downloaded package containers, then delegate review, installation, enablement, update, rollback, and uninstall to the existing Extension Runtime. Release metadata will have one checked source in `release/version.json`; runtime/About/update/release artifacts will expose product SemVer, channel, platform build number, and source commit separately. The developer kit will validate against the actual manifest and capability implementation.

**Tech Stack:** Node.js ESM, existing `src/extension` and `src/update` domains, `src/storage/json-file.js`, Rust/egui native shell, and the repository's `npm test` aggregate runner.

**Spec:** Owner-provided task text `Plugin Center + Release Versioning + Plugin Developer Kit` (provided in the conversation attachment; not copied into repository history).

## Global Constraints

- Official plugin packages are never fetched from GitHub; the Catalog API origin is configurable until the owner supplies the official service URL.
- HTTPS, a configured official-host allowlist, bounded catalog/package/image sizes, SHA-256, manifest validation, compatibility validation, and explicit permission review are required before installation.
- Marketplace code does not execute packages or create a second installer; all package lifecycle changes go through the existing Extension Runtime.
- Newly installed plugins stay disabled until the Owner explicitly enables them; unsigned local plugins remain Unverified / Local and require review before first enable.
- Persistent JSON uses `src/storage/json-file.js`; no plugin receives the Core object, unrestricted process environment, credentials, or agent tokens.
- Release builds fail on a dirty worktree or inconsistent version metadata; Stable users do not receive RC/Beta/Dev updates by default.
- Register every new `scripts/test-*.mjs` file in `scripts/run-all-tests.mjs`; final suite command is `npm test`.
- Documentation states current support only; cryptographic publisher signatures and an undeployed official service remain explicitly distinguished from implemented client trust.

## Review Focus

- Malformed, oversized, stale, or revoked catalog and package inputs must fail closed or use only the last successful cache without enabling installs offline.
- Catalog-controlled URLs must not reach local/private destinations, different unapproved hosts, or dangerous screenshot schemes.
- Package path traversal, duplicate paths, hidden credential files, hash/size mismatch, manifest mismatch, incompatible versions, and added permissions must stop installation or request Owner review.
- Same SemVer with a higher build is newer; Stable outranks every prerelease, and a Stable channel never selects Beta/RC/Dev.
- Missing Plugin Service configuration must leave CetaMesh running and display a clear unavailable/offline state.

---

### Task 1: Establish the canonical release version source and CLI

**Files:**
- Create: `release/version.json`
- Create: `src/release/version.js`
- Create: `scripts/release-version.mjs`
- Create: `scripts/test-release-versioning.mjs`
- Modify: `package.json`, `scripts/run-all-tests.mjs`, `desktop-shell/Cargo.toml`, `src/about/build-info.js`, `scripts/build-release.mjs`

**Interfaces:**
- `loadReleaseVersion({ rootDir })` reads and validates `{ productVersion, channel, buildNumber }` from the canonical file.
- `compareReleaseVersions(left, right)` compares SemVer first and numeric build second.
- CLI subcommands: `show`, `set`, `bump-build`, and `validate`; npm aliases include `version:show`, `version:bump`, `version:prerelease`, `version:validate`, and a pre-build build-number step.

- [ ] Add tests that reject SemVer/channel disagreement, mismatched generated package/shell metadata, and invalid build numbers.
- [ ] Add tests for patch/minor/prerelease updates and monotonic build-number increments.
- [ ] Run the focused script through the aggregate runner and confirm the new tests fail before implementation.
- [ ] Implement the canonical source, generated/validated mirrors, CLI, and readable About/build metadata.
- [ ] Verify a dirty formal release fails while a developer build is labeled DEV.

### Task 2: Compare update releases by SemVer, channel, and build

**Files:**
- Modify: `src/update/manifest.js`, `src/update/checker.js`, `src/update/service.js`, `src/about/build-info.js`, release-manifest generation in `scripts/build-release.mjs`
- Modify: update/release test scripts registered in `scripts/run-all-tests.mjs`

**Interfaces:**
- Update manifests carry `version`, `channel`, `buildNumber`, and source commit; legacy handling is explicit and tested.
- Channel selection defaults to Stable. Advanced RC/Beta selection never leaks prereleases to Stable users.

- [ ] Test same-version higher-build updates, Stable > `rc.10`, no Stable-to-RC downgrade, channel isolation, artifact naming, and release-manifest consistency.
- [ ] Run the focused tests and verify they fail before implementation.
- [ ] Implement comparison, channel filtering, and release metadata propagation without weakening signature verification.

### Task 3: Add Catalog and package distribution over the existing Extension Runtime

**Files:**
- Create: `src/plugin-center/catalog.js`, `src/plugin-center/package.js`, `src/plugin-center/service.js`, `src/plugin-center/index.js`
- Modify: `src/product/release-config.js`, `src/app/service-container.js`, `src/app/ipc-runtime.js`, `src/extension/manifest.js`, `src/extension/types.js`
- Create: `scripts/test-plugin-center.mjs`
- Modify: `scripts/run-all-tests.mjs`

**Interfaces:**
- Catalog contract: versioned `schemaVersion`, `generatedAt`, and `plugins[]` with the fields in the owner task.
- IPC service: list/search/filter, detail, refresh/offline status, stage/review/install/update/rollback/disable/enable/uninstall; state-changing calls delegate to existing extension runtime methods.
- Package container uses an explicitly documented, bounded `.cetamesh-plugin` representation; extract only safe relative paths to a staging folder before calling the existing extension review flow.
- Missing official Catalog URL is a graceful unavailable state. The URL, same-origin package/image policy, cache TTL, and request bounds are injectable/configurable.

- [ ] Test catalog parse/schema, cache fallback, search/filter/detail, screenshot allowlist and count/size bounds.
- [ ] Test package hash/size/path checks, compatibility, manifest agreement, install disabled by default, permission review, update permission expansion, rollback, revocation, and offline install refusal.
- [ ] Verify these tests fail before implementing the service.
- [ ] Implement catalog normalization/cache and bounded package download/staging; call only existing Extension Runtime review/install/update/rollback APIs.

### Task 4: Add the Plugin Center to the native Plugins page

**Files:**
- Modify: `desktop-shell/src/integrations_ui.rs`, `desktop-shell/src/native_ui.rs`, relevant native-shell UI tests

**Interfaces:**
- The Plugins page exposes Recommended, All, Installed, and Update Available views, category/search filters, cards, detail and permission review, status, and lifecycle actions.
- A missing service URL shows an unavailable/offline state without failing the application; untrusted images are skipped without failing the page.

- [ ] Add Rust model tests for catalog responses, installed/update/revoked states, detail, and failure/offline responses.
- [ ] Implement the minimum native flow on the existing Plugins page and verify all lifecycle operations use the new IPC service.

### Task 5: Build local Developer Mode, validator, template, and SDK docs

**Files:**
- Modify: `src/settings/schema.js`, `src/settings/service.js`, `desktop-shell/src/integrations_ui.rs` (or current settings UI module)
- Create: `scripts/plugin-validate.mjs`, `examples/plugin-template/extension.json`, `examples/plugin-template/index.js`, `examples/plugin-template/README.md`, `examples/plugin-template/test.mjs`
- Create: `docs/plugin-development/README.md` and `01-getting-started.md` through `15-versioning.md`
- Create: `scripts/test-plugin-sdk.mjs`
- Modify: `scripts/run-all-tests.mjs`

**Interfaces:**
- `npm run plugin:validate -- <directory>` checks manifest/schema/permissions/entry/compatibility/package size/forbidden files using current Extension validation and scanning.
- Developer Mode gates Load Local Plugin, Reload Plugin, and Open Plugin Logs; loaded local packages are marked Unverified / Local, disabled by default, and reviewed before enable.
- Template contains a structured-input Hello Tool and a runnable test; Memory Pack documentation remains data-only.

- [ ] Test local package validation, forbidden files/permissions, template validation, and Hello Tool execution.
- [ ] Verify tests fail before implementing the CLI/template.
- [ ] Write all 15 SDK sections against current code and keep publishing/signature/service claims honest.

### Task 6: Report and final verification

**Files:**
- Create: `PLUGIN_CENTER_VERSIONING_SDK_REPORT.md`

- [ ] Record implemented client/API contracts, URL configuration state, security checks, version/build/channel behavior, artifact names, compatibility, SDK/template, exact tests, and remaining service/deployment work.
- [ ] Run `npm test` from this branch and report PASS / FAIL / NOT_RUN_ENVIRONMENT counts.
- [ ] Run the native Rust compile check and inspect the complete branch diff/status.
- [ ] Stop for Owner confirmation before merging to `main`; preserve the branch until the Owner confirms deletion after merge.
