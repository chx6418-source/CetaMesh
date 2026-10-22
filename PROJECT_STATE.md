# CetaMesh — current project state

Last reviewed: 2026-10-22.

## Repository and layout

- Official open-source repository: https://github.com/chx6418-source/CetaMesh
- Desktop and Mobile source snapshots were merged to public main on 2026-10-21 in commit 350c1fc4ec8d21d9ae7ac80285979c588c007e99.
- Desktop remains the repository root (src/, desktop-shell/, desktop-ui/). Mobile is independent in apps/mobile/.
- Original private Desktop and Mobile repositories, including their histories and recovery sources, are kept separately. The private histories were not imported into public Git.
- The public-repository cleanup is prepared in chore/public-repository-cleanup; main has not been modified by that review work.

## Stable boundaries

- Desktop: local-first Core, Chat/Task/Memory/Workspace services, Agent/Capability brokers, plugin and Device Mesh facilities.
- Mobile: React Native app with independent local Chat, Memory, Tasks, native permissions and storage.
- Pairing and protocols do not grant automatic memory access, tool execution or transcript synchronization.
- SnowLuma upstream source and restricted SDK/MCP are excluded from the public source/build; optional QQ uses a separate OneBot protocol integration.
- Windows and Android retain distinct build processes and release artifacts.

## Verified work and remaining gates

The migration has recorded successful local Desktop and Mobile automated checks and an Android Standalone APK build (see docs/migration/PUBLIC_MIGRATION_ACCEPTANCE.md). These are historical test results, not new post-cleanup passes.

Before a new release: rerun affected Desktop and Mobile tests and native builds; verify GitHub Actions; complete any required real-device/real-provider end-to-end checks, third-party notices, code signing and update compatibility checks. Do not represent unrun checks as PASS.

Development: docs/MONOREPO.md; Desktop design: UI_SOURCE_OF_TRUTH.md; Mobile handoff: apps/mobile/PROJECT_STATE.md.
