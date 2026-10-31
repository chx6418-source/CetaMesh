# CetaMesh Plugin Developer Kit

The guide documents the v1 Extension Runtime contract. Plugins declare capabilities and permissions; the existing Runtime owns review, install, hosting, and lifecycle.

1. [Getting started](01-getting-started.md)
2. [Plugin manifest](02-plugin-manifest.md)
3. [Capabilities](03-capabilities.md)
4. [Permissions](04-permissions.md)
5. [Process Host](05-process-host.md)
6. [Plugin API](06-plugin-api.md)
7. [Tools](07-tools.md)
8. [Memory Pack](08-memory-pack.md)
9. [Lifecycle](09-lifecycle.md)
10. [Debugging](10-debugging.md)
11. [Testing](11-testing.md)
12. [Packaging](12-packaging.md)
13. [Publishing](13-publishing.md)
14. [Security](14-security.md)
15. [Versioning](15-versioning.md)
16. [Built-in Integrations](16-built-in-integrations.md)

The Hello Tool tutorial takes 15–30 minutes. Run npm run plugin:validate -- <directory> before review.

## Proposed protocol development rules

The [Core protocol index](../protocol/README.md) maps current implementations to
the CP proposals. Read CP-020/021 for current Manifest/Worker/delegation boundaries,
and CP-022..026 for the 17-category taxonomy, composition, collaboration and SDK
proposals. Categories are product metadata, not new Manifest v1 types or permissions.
`npm run contracts:validate` checks draft DTOs and graphs only; the current installer
does not activate compositions. Existing v1 guides and `plugin:validate` remain the
source of truth for installing and running supported plugins.

## Current boundaries

The Plugin Center is prepared for the CetaMesh Plugin Service; its official endpoint remains unconfigured. Offline mode can show a cached Catalog but cannot install or update. Package integrity uses HTTPS, host allowlists, bounded sizes, and SHA-256. Publisher signatures and public publishing endpoints are not implemented. Local plugins are Unverified / Local, require Developer Mode and a separate first-enable Owner Review, and install disabled. The Process Host is defense in depth, not a complete OS security boundary.
