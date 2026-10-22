# CetaMesh — public Desktop + Mobile migration record

Updated: 2026-10-22. The reviewed Desktop + Mobile source import **was merged** to public main on 2026-10-21 (merge commit 350c1fc4ec8d21d9ae7ac80285979c588c007e99). This is a historical migration record, not a claim that a stable release was published.

## Source and repository boundary

- Public predecessor: ec6b07d8abcdea0c66ed8362d36d3c4984462cdf.
- Public import commit: 85a5a68b0668a9a6fa440ccfb451615886ba0b20.
- Source snapshot: private integration 4acbb3d1dca1abf0acf53a5b5384f9ee71c6842b.
- No private Git parents or complete private histories were added to the public repository; the original public history and governance files were retained.
- Desktop is rooted at src/, desktop-shell/ and desktop-ui/; Mobile is at apps/mobile/. Both retain independent dependency, runtime and release ownership.

## Recorded migration verification (2026-10-21)

The migration's local verification recorded a successful Android Standalone Release APK build and inspection, React Native type/lint/architecture/Jest checks, and Desktop TypeScript/Vite, Core SEA, Rust shell and release test runs. Related details remain available in the original public merge and the private migration report.

The checks had real limitations: Android/iOS device behavior, actual cross-device pairing, some real third-party integrations, code signing and old-client update/verification were not fully validated. GitHub Actions outcomes and test counts are commit-specific and must be rechecked for any subsequent commit.

## Licensing and public-source hygiene

SnowLuma upstream source and restricted SDK/MCP were excluded; CetaMesh's independently implemented OneBot transport communicates with a separately installed compatible gateway. Other third-party code and binary notices still require release-time review. Historical repair reports, internal evidence and design prototypes have been marked for private retention; active product source is preserved.

Follow [source provenance](SOURCE_PROVENANCE.md), [engineering guide](../MONOREPO.md), [project status](../../PROJECT_STATE.md) and [public repository policy](../development/PUBLIC_REPOSITORY_POLICY.md).

Deleting old files from current main after PR approval will **not** remove their contents from prior publicly accessible commits. If material is sensitive, handle it as a separate incident with rotation, investigation and appropriate historical remediation.
