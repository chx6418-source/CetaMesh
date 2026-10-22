# CetaMesh

**Making work across AI tools and devices easier to continue.**

CetaMesh is a local-first AI collaboration workspace under active development. It brings chats, tasks, memory, agents, tools and devices into one manageable system. The goal is to reduce the cost of reconstructing context whenever a user changes a model, tool or device.

It is more than a collection of model chat tabs: **CetaMesh owns the task; an Agent may execute it; access to memory and device capabilities remains permission-scoped.**

[简体中文](README.md) · [Website](https://cetamesh.com) · [Project guide](docs/PROJECT_GUIDE.md) · [Contributing](CONTRIBUTING.md)

> **Pre-stable / under development.** Desktop and Mobile codebases, automated tests and working features exist, but real cross-tool continuity, cross-device interoperability, third-party integrations and signed releases are still being validated. Architectural goals are not claims of production-ready end-to-end behavior.

## What problem does it address?

A user may plan in one AI tool, develop with another and ask a third to review the result. These tools generally do not share task ownership, past decisions or the authorized context needed to continue.

CetaMesh is being built around four ideas:

- **Chat is the entry point, not the entire product.** Work can become a persistent task.
- **Tasks outlive a single Agent session.** Their identity, status and workspace should not be tied to one provider.
- **Memory has explicit boundaries.** Local knowledge, task context and cross-device sharing are distinct.
- **Devices remain independent.** Pairing or trusting another device never automatically authorizes every action.

Some of these cross-provider and cross-device flows are still at the contract, implementation or verification stage.

## Current code and limitations

| Area | What exists today |
| --- | --- |
| **Chat** | Desktop supports direct Model Provider conversations without requiring DSH; Mobile has independent chats, sessions and attachment foundations. Users configure their own model services. |
| **Tasks / Workspace** | Desktop includes Task and Workspace runtimes, execution references and continuity mechanisms. Mobile includes local tasks, approvals and Action Center foundations. Complex external-Agent execution requires verified integration and authorization. |
| **Memory** | Local memory on both platforms; cross-scope access and device sync do not bypass explicit authorization. |
| **Agents / Tools** | Desktop provides an Agent Broker, tools and capability policies, plus DSH, Codex and ZCode adapter code. Presence in source does not guarantee an installed, supported, functioning external service. |
| **Plugins** | Extension/permission contracts and validation exist. The plugin marketplace, publishing infrastructure and process-isolation guarantees remain works in progress. |
| **Device Mesh** | Identity, pairing, trust and protocol foundations exist. Full real-device Desktop↔Mobile workflows have not all passed end-to-end acceptance. |

## Platforms and repository layout

```text
CetaMesh/
├── src/                 # Desktop Core
├── desktop-shell/       # Windows Rust native host
├── desktop-ui/          # React / WebView2 Desktop UI
├── plugins/ extensions/ # Desktop extensibility
├── apps/mobile/         # Independent React Native Android/iOS source
├── docs/                # Guides, architecture, protocols
└── .github/workflows/   # Separate Windows and Android CI
```

**Desktop is the primary project at the repository root; Mobile lives under `apps/mobile/`.** Each platform has its own runtime, dependencies, permissions and release artifacts. iOS source does not imply a completed iOS native build or device acceptance.

## Builds and availability

- [GitHub Releases](https://github.com/chx6418-source/CetaMesh/releases): see available build artifacts and their notes. Previous Windows release candidates are **not stable releases**; read the related warnings about signing and compatibility.
- [GitCode](https://gitcode.com/ygdnn/CetaMesh): another project code/distribution entry; availability and versions may differ.
- [Website](https://cetamesh.com): product information.

Not every platform has a publicly downloadable stable build. Android Standalone APKs can be built in CI, but temporary CI signing is not a production release signature.

From the repository root, with Node.js **22.13+**:

```sh
# Desktop
npm ci
npm --prefix desktop-ui ci
npm test
npm run build:ui

# Mobile
npm --prefix apps/mobile ci
npm --prefix apps/mobile test
```

Windows native builds require Rust/Windows tools; Android builds require JDK and Android SDK/NDK; iOS requires macOS/Xcode. See [monorepo instructions](docs/MONOREPO.md), [Desktop build guide](docs/desktop/BUILD_AND_RELEASE.md) and [Mobile guide](apps/mobile/README.md).

## Privacy, license and contributions

CetaMesh source is [GPL-3.0-only](LICENSE), subject to [separate third-party notices](THIRD_PARTY_NOTICES.md). Restricted SnowLuma SDK/MCP and the upstream application are not redistributed; optional QQ interoperation connects to a separately installed and licensed compatible gateway.

[Project status](PROJECT_STATE.md) · [Known limitations](docs/desktop/KNOWN_LIMITATIONS.md) · [Plugin development](docs/plugin-development/README.md) · [Contributing](CONTRIBUTING.md) · [Open-source policy](OPEN_SOURCE.md) · [Security](SECURITY.md)

Issues, testing feedback and focused pull requests are welcome. Please distinguish features present in source from those verified in production conditions.
