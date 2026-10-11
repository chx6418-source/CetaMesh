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

The Hello Tool tutorial takes 15–30 minutes. Run npm run plugin:validate -- <directory> before review.

## Current boundaries

The Plugin Center is prepared for the CetaMesh Plugin Service; its official endpoint remains unconfigured. Offline mode can show a cached Catalog but cannot install or update. Package integrity uses HTTPS, host allowlists, bounded sizes, and SHA-256. Publisher signatures and public publishing endpoints are not implemented. Local plugins are Unverified / Local, require Developer Mode and a separate first-enable Owner Review, and install disabled. The Process Host is defense in depth, not a complete OS security boundary.
