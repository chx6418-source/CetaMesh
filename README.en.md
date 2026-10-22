# CetaMesh

**An intelligent collaboration network for AI agents, tasks, memory, plugins and devices.**

CetaMesh is a local-first Desktop + Mobile project. It aims to help people continue tasks and authorized context across separate AI tools, while retaining independent runtimes and security boundaries. The software is in active development; not all integrations or cross-device workflows are production-ready.

[简体中文](README.md) · [Website](https://cetamesh.com)

## Repository layout

- **Desktop (repository root):** src/ Core, desktop-shell/ native Rust host, desktop-ui/ interface, plugins/ and extensions/.
- **Mobile (apps/mobile/):** standalone React Native app with Android and iOS native projects.
- **Shared contracts:** docs/protocol/, fixtures/pairing/; packages/ is reserved for validated shared modules.
- Desktop and Mobile retain separate dependencies, versions, permissions, build pipelines and release artifacts.

## Development

Node.js 22.13+ is required. Desktop native builds need Windows and Rust; Android native builds require the compatible SDK/JDK toolchain.

~~~sh
npm ci
npm --prefix desktop-ui ci
npm test
npm run build:ui

npm --prefix apps/mobile ci
npm --prefix apps/mobile test
~~~

See the [Monorepo guide](docs/MONOREPO.md), [Desktop architecture](docs/desktop/ARCHITECTURE.md), [Desktop build guide](docs/desktop/BUILD_AND_RELEASE.md) and [Mobile README](apps/mobile/README.md) for platform-specific requirements.

## Scope and release status

Desktop focuses on Chat, Tasks, Memory, Workspaces, Agents and authorized tools/plugins. Mobile has an independent local runtime. Trusted devices do not automatically gain access to private memory or remote capabilities. Real-device interoperability, external providers, code signing and platform release gates must be verified separately.

See [current project state](PROJECT_STATE.md), [known Desktop limitations](docs/desktop/KNOWN_LIMITATIONS.md) and [changelog](CHANGELOG.md). A successful source build is not a claim of production-ready release.

## Licensing and contributions

CetaMesh source uses [GPL-3.0-only](LICENSE); third-party components retain their own licenses and require separate review. See [third-party notices](THIRD_PARTY_NOTICES.md). Restricted SnowLuma SDK/MCP and the upstream application are not redistributed; optional QQ connectivity uses an independently implemented OneBot protocol client to communicate with a separately installed compatible gateway.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Open source policy](OPEN_SOURCE.md) · [Plugin development](docs/plugin-development/README.md) · [Source provenance](docs/migration/SOURCE_PROVENANCE.md)

Historical design experiments, internal repair reports and diagnostic evidence are kept outside the active public source tree.
