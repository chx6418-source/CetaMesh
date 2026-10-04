# CetaMesh

**English** | [简体中文](README.zh-CN.md)

**CetaMesh** is a local-first AI node and collaboration runtime designed to connect conversations, memory, tasks, tools, devices, and external model providers without making any single platform the center of the system.

> 当前公开仓库首先提供 **CetaMesh Mobile** 基线。移动端是独立的 CetaMesh Node，不依赖 Desktop、QQ、DSH 或中心服务器才能运行其本地能力。

CetaMesh is still under active development. Interfaces, protocols, and product behavior may change before a stable release.

## What CetaMesh is building

CetaMesh is intended to grow beyond a single chat client. The long-term direction is a network of independent nodes that can cooperate while keeping capability boundaries, user approval, workspace scope, and memory authorization explicit.

The current Mobile baseline includes:

- **Chat** — configurable model providers, sessions, reasoning options, streaming, attachments, retry/cancel, and token-usage handling.
- **Local Memory** — offline create/search/edit/pin/delete, explicit memory candidates, confirmation before long-term writes, and local-first storage.
- **Tasks & Approvals** — CetaMesh-owned task state, execution references, attention events, approvals, and Action Center flows.
- **Device Mesh foundations** — device identity, pairing, trust metadata, capability advertisement, presence/sync contracts, and bounded peer communication.
- **Capability Runtime** — permission-gated access to camera, microphone, files/photos, notifications, QR scanning, and remote capability requests.
- **Extensions** — declarative and remote-transport extension contracts with validation, permission review, lifecycle handling, and no downloaded executable JavaScript path.
- **Android / iOS native bridges** — React Native shared product code with Kotlin and Swift providers behind capability interfaces.

## Core principles

CetaMesh follows a few architectural rules that are more important than any individual feature:

1. **Local first.** Local chat state, memory, task state, and identity should remain useful without a CetaMesh cloud service.
2. **Task is not Session.** Tasks belong to CetaMesh; model/provider sessions are replaceable execution references.
3. **Trust is not permission.** A trusted device still needs local authorization before a capability executes.
4. **Advertisement is not authorization.** A peer may advertise a capability without automatically receiving permission to invoke it.
5. **Memory is scoped before retrieval.** Authorization is evaluated before ranking or synchronization.
6. **Native access is bounded.** Product features do not call unrestricted Android/iOS APIs directly; they go through capability contracts and policy.
7. **No hidden executable plugin path.** The current extension system does not download or execute arbitrary JavaScript, shell commands, or unrestricted native code.

## Repository status

The current public repository contains the **CetaMesh Mobile** source baseline at the repository root.

Primary stack:

- React Native
- TypeScript
- Kotlin for Android native providers
- Swift / Objective-C++ bridges for iOS native providers
- SQLite for local structured data

The project is currently **pre-stable**. Automated checks cover TypeScript, linting, architecture boundaries, unit/integration behavior, and Android CI build/verification. Hardware-specific behavior and cross-device interoperability still require real-device validation as development continues.

For the detailed implementation record, see [PROJECT_STATE.md](PROJECT_STATE.md).

## Repository layout

```text
.
├── android/                 Android project and native capability providers
├── ios/                     iOS project and native capability providers
├── src/
│   ├── app/                 Bootstrap and composition
│   ├── data/                SQLite/database repositories and migrations
│   ├── domain/              Platform-independent contracts and entities
│   ├── features/            Product UI/features
│   ├── native/              React Native native-provider adapters
│   ├── protocol/            Pairing / Device Mesh protocol contracts
│   ├── providers/           Model/network/update/desktop adapters
│   ├── runtime/             Chat, task, memory, capability and sync runtimes
│   ├── security/            Capability / memory / attachment policies
│   ├── shared/              UI, i18n, errors, utilities and logging
│   └── test/                Automated test suite
├── docs/                    Architecture, protocol, security and acceptance docs
├── PROJECT_STATE.md         Current implementation and verification state
├── AGENTS.md                Repository rules for coding agents
└── LICENSE                  GNU GPL v3
```

## Quick start

### Requirements

- Node.js **22.11+**
- npm
- Android Studio + Android SDK for Android builds
- macOS + Xcode + CocoaPods for iOS native builds

Install dependencies:

```bash
npm ci
```

Run the full repository check:

```bash
npm run check
```

This runs TypeScript checks, ESLint, architecture-boundary checks, and the Jest test suite.

### Android

Start Metro for development:

```bash
npm start
```

Then install/run the development app:

```bash
npm run android
```

Or build a Debug APK without installing it:

```bash
npm run android:debug
```

The repository also contains Android CI and standalone/debug APK verification scripts under `.github/workflows/` and `scripts/`.

### iOS

On macOS:

```bash
bundle install
cd ios
bundle exec pod install
cd ..
npm run ios
```

iOS support exists in the source tree, but native verification should be treated separately from Android CI.

## Model providers and privacy

CetaMesh does not bundle a model API key.

Provider credentials are configured by the user and are intended to be stored through platform secure storage. Chat content is sent to the provider selected by the user when a request is made. Local Memory is not automatically uploaded merely because a model provider is configured.

Before using a third-party model provider, review that provider's privacy, retention, pricing, and acceptable-use terms.

## Security model

The current Mobile architecture uses explicit capability routing and permission policy for sensitive device operations. Unknown capabilities default to denial, and trust/pairing does not automatically grant execution permission.

Please do **not** publish vulnerability details in a public issue. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Documentation

Useful starting points:

- [Project state](PROJECT_STATE.md)
- [Mobile architecture](docs/architecture/MOBILE_ARCHITECTURE.md)
- [Protocol v1](docs/protocol/PROTOCOL_V1.md)
- [Mobile security notes](docs/security/MOBILE_SECURITY.md)
- [Mobile acceptance status](docs/acceptance/MOBILE_ACCEPTANCE.md)
- [Open-source policy](OPEN_SOURCE.md)
- [Contributing guide](CONTRIBUTING.md)

## Contributing

Contributions are welcome while the project evolves. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Keep changes focused, preserve architecture/security boundaries, add or update tests when behavior changes, and run:

```bash
npm run check
```

before submitting.

## License

CetaMesh source code in this repository is licensed under the **GNU General Public License v3.0 only (GPL-3.0-only)** unless a file or bundled third-party component states otherwise.

The full legal text is in [LICENSE](LICENSE). A practical project-level explanation of redistribution, contributions, third-party code, and branding is available in [OPEN_SOURCE.md](OPEN_SOURCE.md).

## Project stage

CetaMesh is currently an actively developed open-source project, not a finished security-audited production platform. Please evaluate builds, permissions, provider configuration, and device-to-device features carefully before relying on them for sensitive or critical workloads.
