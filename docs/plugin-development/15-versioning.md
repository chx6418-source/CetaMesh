# 15 Versioning

Plugin SemVer is independent of the product release. release/version.json is the canonical product source: SemVer, channel, monotonic build number, and source commit. Package and Cargo versions are synchronized mirrors; Desktop and Mobile counters are independent.

Channels are dev, beta, rc, and stable. Update comparison uses SemVer then build number; Stable does not receive RC by default. A build may increment without a SemVer change. Use npm run version:show, version:validate, version:set, version:bump, version:prerelease, or version:bump-build. Plugin compatibility bounds in the manifest are inclusive.
