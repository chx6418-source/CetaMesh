# Plugin Center, Release Versioning, and Developer Kit Report

Date: 2026-10-11
Working branch: codex/plugin-center-versioning-sdk

## Delivered

### Plugin Center

- Added a native Marketplace entry with Catalog views, category and text filters, plugin cards with Catalog icons, detail metadata, permission/capability summaries, and screenshot preview.
- Added plugin-center.catalog.list, plugin-center.catalog.detail, plugin-center.catalog.refresh, plugin-center.status, plugin-center.health, and plugin-center.configure, plus bounded plugin-center.icon.get and plugin-center.screenshot.get.
- Reserved pluginService.catalogUrl and pluginService.allowedHosts in release configuration. The service root remains unset pending the official CetaMesh endpoint; Desktop startup and local plugin management work without it.
- Added HTTPS-only Catalog and image fetches, configured host allowlists, response size limits, offline view-only Catalog cache, and package byte-count/SHA-256 verification for .cetamesh-plugin archives. Package review and installation delegate to the existing Extension Runtime.
- Added Installed management for enable, disable, update, rollback review, uninstall, local staging, reload, and logs. Installs remain disabled until separately enabled. Local plugins are marked Unverified / Local, require Developer Mode, and receive a separate first-enable Owner Review.
- Catalog revocation blocks install/enable and does not automatically remove installed files or user data.

### Release versioning

- Added canonical release/version.json and version tooling for validation, setting, SemVer bumps, prerelease channels, and build-number increments. The current canonical value is 1.0.0-rc.2, channel rc, build 1053.
- package.json and Cargo versions are synchronized SemVer mirrors. Build metadata records channel, build number, and source commit; About/build info and update manifests expose the applicable release fields.
- Update selection compares SemVer and then build number and enforces channel policy, including Stable not receiving RC by default.
- Release packaging uses versioned artifact names and refuses dirty formal builds; explicit development builds are labeled DEV.

### Plugin Developer Kit

- Added the 15-chapter guide under docs/plugin-development/, the Hello Tool starter, and npm run plugin:validate.
- The starter uses the actual CommonJS module.exports.handlers contract and its fixture invokes it through the Extension VM Host.
- Added registered unified-runner regression suites for Plugin Center, SDK, and release versioning.

## Verification

npm test completed successfully:

- 90 suites total
- 81 PASS
- 0 FAIL
- 9 NOT_RUN_ENVIRONMENT

The skipped suites require local release/core distributions, a debug desktop binary, a configured gateway, or explicit network/legacy bridge opt-in. Both cargo:check and cargo:test passed inside the unified run. No live native installer session or official Plugin Service was available for visual or network acceptance.

## Remaining service and release work

- Configure the official CetaMesh Plugin Service root and allowed hosts when supplied, then validate its Catalog/package API and website integration against the same service.
- Publisher cryptographic signatures, key management, publisher onboarding, and signed revocation are not implemented. The Catalog verified value is display metadata and is not proof of a signature.
- Production release/core artifacts were not assembled in this run because the unified runner reported the required core-dist and release-dist inputs unavailable. No installer or release was published.
- The native Marketplace has compile and Rust unit-test coverage, but this run did not include native visual acceptance because the required debug shell executable was unavailable.

## Current handoff state

The implementation and report are on codex/plugin-center-versioning-sdk. The branch has not been merged or deleted. Owner confirmation is required before merging into main and removing the working branch.
