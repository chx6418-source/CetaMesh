# CetaMesh Desktop v1 — Build, Test and Release

> Applies to Windows x64. The release candidate `1.0.0-rc.1` was produced with these steps.

## Prerequisites

- Windows 10/11 x64, Node.js >= 22.13, Rust toolchain (edition 2024), `cargo` on PATH.
- Repository dependencies installed (`npm install`). The RC build itself was performed offline
  from the local cargo/npm caches.

## Development build and tests

| Command | Purpose |
| --- | --- |
| `npm run desktop:check` | `cargo check` for the native shell |
| `npm run desktop:test` | Rust unit tests |
| `npm run desktop:build:debug` | debug shell (required by `test-desktop-shell` / `test-desktop-install`) |
| `npm run test-architecture` | source-level architecture red lines (stage 15) |
| `npm run test-system` | Settings / About / Update / Diagnostics / redaction |
| `npm run test-config`, `test-agent`, `test-memory`, `test-task`, `test-workspace`, `test-extension`, `test-mesh` | product runtime suites |
| `npm run test-core-entry`, `test-privilege`, `test-dsh-integration` | Core startup, privilege boundary, DSH integration |
| `npm run test-desktop-shell`, `test-desktop-supervisor` | native window/supervisor contract, real window smoke |
| `npm run self-test` | live DSH round trip (creates one isolated test session) |

There is no TypeScript or lint toolchain in this repository (plain ESM JavaScript + Rust), so
"TypeScript / lint" is **NOT_APPLICABLE** rather than skipped.

## Release candidate build

Build from a **clean commit**, never from a dirty working tree: the artifact records its commit in
`build-info.json`, and the release audit fails on forbidden files, build-machine paths in the Core
and real credentials.

```powershell
# 1. Clean worktree at the release commit (recommended; keeps parallel work out of the artifact)
git worktree add --detach "$env:TEMP\cetamesh-rc" <COMMIT>
# 2. Reuse the installed dependency cache (junction keeps the worktree clean and cheap)
New-Item -ItemType Junction -Path "$env:TEMP\cetamesh-rc\node_modules" -Target "<repo>\node_modules"
Set-Location "$env:TEMP\cetamesh-rc"

npm run build:core          # Node SEA Core -> dist/core (no-web, API-only)
npm run desktop:build       # release native shell
npm run desktop:build:debug # needed by installer lifecycle tests
npm run build:release       # dist/app: single-file setup + payload + SBOM + SHA256SUMS
```

`dist/app` contains:

- `WhaleBridge-Setup-x64.exe` — single-file installer (Windows IExpress, branded icon)
- `WhaleBridge.exe` — native shell / uninstaller, `payload/` — Core SEA + read-only resources
- `build-info.json` (version / commit / buildId / dirty flag), `release-manifest.json`,
  `SHA256SUMS.txt`, `sbom.json`, `licenses/`, `INSTALL.txt`

## Release verification

```powershell
npm run test-installer-package   # single-file installer + no-web guard
npm run test-release-candidate   # install/launch/API/crash recovery/uninstall, PATH without node
npm run test-desktop-install     # install/upgrade/repair/migrate/uninstall/reinstall lifecycle
npm run test-core-dist           # SEA distribution contract (WHALEBRIDGE_DIST_DIR=dist/core)
```

The RC artifacts (version / SHA256 / commit / test results) are recorded in `PROJECT_STATE.md`.

## Extension Worker process isolation

Installed ordinary code Extensions run in a separate Core SEA process started with
`WhaleBridgeCore.exe --extension-worker`. The Worker uses the existing bounded frame protocol,
starts with an explicit environment allowlist, and runs with its current versioned Extension
package directory as `cwd`. Capability requests return to the host and pass through the
Capability Broker and policy checks. Updates stage and validate a package before switching the
registry; new permissions require a fresh Owner Review, and the immediately previous package is
retained for rollback.

`ProcessExtensionHost` and the Extension VM provide process separation and API restriction. They do
**not** provide Windows Sandbox or AppContainer isolation. The Worker is not an OS sandbox.
Memory Packs remain data-only and do not run in the Extension Worker. Manifest requests for
`shell`, `native`, `process`, or downloaded executables remain denied.

Run the release Worker end-to-end check after building the Core SEA:

```powershell
npm run build:core
npm test
```

The `test-process-extension-sea` suite is marked `NOT_RUN_ENVIRONMENT` when the Core SEA artifact is
not present. Set `WHALEBRIDGE_DIST_DIR` when testing a Core build stored outside `dist/core`.

## Install / upgrade / uninstall semantics

```text
WhaleBridge.exe --install [--install-dir DIR] [--data-dir DIR] [--dry-run]
WhaleBridge.exe --repair
WhaleBridge.exe --uninstall                 # keeps user data
WhaleBridge.exe --uninstall --remove-data   # explicit, destructive
WhaleBridge.exe --migrate --from OLD_DIR [--dry-run]
```

- Upgrade replaces application files and `resources/`; `config.json`, `settings.json`, `state/`
  (Tasks / Memory / Workspace metadata / continuity / provider secrets) are preserved byte-for-byte.
- Uninstall removes application files, shortcuts and the uninstall registry entry. User data stays
  unless `--remove-data` is passed.
- User Workspace directories live outside the data directory and are never deleted by uninstall.

## Pre-publish checklist

1. Code-sign the installer and both executables (currently unsigned; SmartScreen warns).
2. Add the Node.js runtime license text under `dist/app/licenses/` before public redistribution.
3. Configure the update manifest public key (updates are fail-closed until then).
4. Run the manual UI walkthrough and the real-QQ/full-mode acceptance on a clean VM.
