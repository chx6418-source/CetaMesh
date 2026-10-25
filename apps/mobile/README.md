# CetaMesh Mobile

**A standalone local-first CetaMesh node for Android, with an iOS native project under development.**

This is the Mobile application inside the [public CetaMesh Desktop-primary monorepo](../../README.en.md), located at `apps/mobile/`. It is **not** a separate private-repository root and does not need Desktop, QQ or DSH to run its local features.

[简体中文](README.zh-CN.md) · [Main project](../../README.en.md) · [Monorepo guide](../../docs/MONOREPO.md)

## Features and maturity

The existing React Native code includes chats, provider/model configuration, sessions and attachments; local Memory; CetaMesh-owned Tasks and Approvals; Device Mesh identity, pairing and trust foundations; permissions and safe declarative extension contracts.

- **Local first:** Memory and tasks have independent local storage. Pairing does not automatically publish Memory or grant remote capabilities.
- **Provider connections:** users supply their own model/API credentials. Message content is sent to the selected external model provider when a request is made.
- **Device Mesh:** native security and transport foundations exist, but real Desktop↔Android/iOS interoperability and end-to-end continuation remain subject to actual device tests.
- **Extensions:** runtime policies govern capabilities and declarations; there is no implicit path for arbitrary downloaded JavaScript, shell scripts or native binaries.
- **iOS:** the native project is present, but Android CI is not evidence of an iOS Xcode build or physical-device acceptance.

See [architecture](docs/architecture/MOBILE_ARCHITECTURE.md), [security](docs/security/MOBILE_SECURITY.md) and [acceptance status](docs/acceptance/MOBILE_ACCEPTANCE.md).

## Develop and test

Run from the **`apps/mobile/` directory**, not from the monorepo root unless a `--prefix` command is shown:

```sh
cd apps/mobile
npm ci
npm test          # TypeScript, ESLint, architecture, Jest and artifact checks
npm start         # Metro for development
```

To run a development build, start Metro in one terminal and run `npm run android` in another. A development Metro server is **not required by the standalone Release APK**.

Android native toolchain: Node.js 22.11+, JDK 17, Android SDK Platform 37, Build Tools 37.0.0 and NDK 27.1.12297006. See the committed Gradle settings and root [Android CI](../../.github/workflows/android-ci.yml) for exact versions.

```sh
# From apps/mobile; Android SDK/JDK installed
npm run android:debug           # Debug APK
npm run build:android:release   # Standalone Release APK + artifact hygiene
```

The CI pipeline verifies the Release APK's embedded JavaScript bundle, native modules, permissions and signing, then uploads an artifact for that workflow run. CI uses disposable test signing; it is not a publicly signed stable app and may not upgrade over APKs signed with a different key.

For iOS on macOS, install Xcode and CocoaPods dependencies, then run `npm run ios` after native setup. iOS requires its own build and device validation.

## Project conventions

- Mobile lives under `apps/mobile/` with its own package-lock, Android and iOS projects.
- Read [AGENTS.md](AGENTS.md), [PROJECT_STATE.md](PROJECT_STATE.md) and the [protocols](docs/protocol/UNIFIED_PAIRING_V1_1.md) before changing security/mesh internals.
- Never auto-sync private memory or assume paired peers can execute arbitrary tools.
- Read the parent [GPL-3.0-only license](../../LICENSE), [contributing rules](../../CONTRIBUTING.md) and [security reporting policy](../../SECURITY.md).

The project is pre-stable. Source availability, passing unit tests or a green APK job does not prove every native feature, external service or real-device scenario works.
