# Unified development, verification and releases

## Layout and independent dependencies

The public migration candidate keeps Desktop at the root. Mobile is entirely in `apps/mobile`,
including native projects, its license, Agent rules, state, scripts and lockfile.
Do not install React Native dependencies at the repository root or add implicit
npm/Cargo workspace behavior.

From the repository root:

```powershell
npm ci
npm --prefix desktop-ui ci
npm --prefix apps/mobile ci
npm test
npm --prefix apps/mobile test
npm run build:ui
npm run build:core
npm run desktop:build
npm run desktop:build:debug
```

Mobile `npm test` now includes the existing typecheck, lint, architecture, Jest
and artifact hygiene checks via `test:verification`. `check` remains available.
For interactive React Native development, change to `apps/mobile` before running
`npm start`, `npm run android`, or `npm run ios`. Metro's project root stays
`__dirname`; Gradle includes `../node_modules`; Pod resolution starts in `ios`;
Codegen's `src/native` remains relative to the Mobile package. Relative native,
Babel, Jest and TypeScript paths keep their original directory relationships.

## CI

Root `.github/workflows/ci.yml` validates Desktop on Windows. Mobile-only changes
do not run it. `.github/workflows/android-ci.yml` runs Mobile commands from
`apps/mobile` and native commands from `apps/mobile/android`; setup-node cache
and artifact upload paths are explicitly repository-relative. Shared packages,
protocol documents and pairing fixtures trigger both workflows. Pushes to review
branches run CI. Permissions are read-only; neither workflow publishes releases.

Desktop release jobs build Core, UI, release/debug shells and then run the
registered release category. Android CI still bundles JS into a standalone APK,
checks signing, Manifest, bundle and native modules, and uploads an artifact.
CI uses the existing disposable beta signing approach, not a production key.
Path filters may require branch-protection required-check configuration to be
reviewed by the Owner before merge.

## Releases and compatibility

Desktop: root `release/version.json`, package/Cargo mirrors and existing build
scripts. Mobile: its package version plus Android versionName/versionCode; iOS
retains its existing project settings. Version numbers remain independent.

Desktop packaging: root `npm run build:release`; artifacts under
`artifacts/<channel>/<version>/build-<number>/`. Mobile packaging: in `apps/mobile`,
`npm run build:android:release`; immutable APK/AAB packages and manifests under
`apps/mobile/artifacts/`. Both artifact trees are ignored. Keep signing keys out
of Git. Native iOS compilation requires macOS/Xcode/Pods.

Update URLs and verification keys were not rewritten. Desktop retains GitCode
stable manifest and whalebridge GitHub fallback; Mobile retains GitCode plus the
public CetaMesh Releases fallback. Original release repositories and assets must
remain reachable for installed clients. Publishing from this source repository
does not migrate release assets or authorize public source export.

## Security and manual acceptance

Trust does not grant capabilities; permissions are decided on the receiving
device. Memory stays Local Only until scoped authorization. SQLite, secrets,
private keys, chat transcripts and runtime state are never merged across nodes.
Pairing contract parity and socket fixtures do not establish real Android/iOS
pairing, task continuation or authorized memory synchronization acceptance.

Before merging, inspect `docs/migration/PUBLIC_MIGRATION_ACCEPTANCE.md`, remote CI, pending
native validation, release-source availability and existing platform release gates.

## Official public development target

The official target is chx6418-source/CetaMesh. This local candidate imports source bytes from private integration 4acbb3d without private Git parents. Public main history and governance documents are retained. Public push is paused by Owner instruction pending SnowLuma permission and source review. GitCode/old client endpoints remain unchanged.
