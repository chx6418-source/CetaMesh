# CetaMesh Desktop + Mobile — public migration candidate

## Current State (2026-10-21)

- Official target: chx6418-source/CetaMesh; public main baseline ec6b07d8abcdea0c66ed8362d36d3c4984462cdf.
- Local branch feature/desktop-mobile-monorepo. Source snapshot: private integration 4acbb3d1dca1abf0acf53a5b5384f9ee71c6842b. No private Git history imported.
- Desktop owns root src/desktop-shell/desktop-ui; complete Mobile lives in apps/mobile. Dependencies and releases remain independent.
- Owner authorizes reviewed branch publication with SnowLuma SDK/MCP excluded and Mineradio/Kugou retained. Main merge and Release require separate confirmation.
- Existing public CONTRIBUTING, SECURITY, OPEN_SOURCE, conduct, GPL license and Chinese Mobile introduction are preserved.
- Current tests, native environment blockers, licensing and source findings: docs/migration/PUBLIC_MIGRATION_ACCEPTANCE.md. Prior private migration results are historical, not public-candidate acceptance.

## Active Work

- Local source audit, platform build/test verification, public-safe documentation.
- Resolve third-party permission/provenance before any public source commit or push.

## Architecture and next steps

Read docs/desktop/ARCHITECTURE.md for Desktop; apps/mobile/AGENTS.md and apps/mobile/PROJECT_STATE.md for Mobile. Preserve deny-by-default capabilities, scoped memory authorization, secure storage and update compatibility. Follow docs/MONOREPO.md for isolated dependency/build commands.
