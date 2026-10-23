# CetaMesh public source provenance

The public repository chx6418-source/CetaMesh initially used Mobile source as its foundation. Its pre-integration main head was ec6b07d8abcdea0c66ed8362d36d3c4984462cdf, with 16 then-reachable commits.

Desktop + updated Mobile source was imported as an independently reviewed **source snapshot** (commit 85a5a68b0668a9a6fa440ccfb451615886ba0b20) from private integration 4acbb3d1dca1abf0acf53a5b5384f9ee71c6842b. It was merged to public main by commit 350c1fc4ec8d21d9ae7ac80285979c588c007e99 on 2026-10-21.

The private source histories, worktrees and Git bundles were **not** grafted into public history. Original private repositories remain separate. Public-source comparisons and Git secret scans recorded during migration were scope-limited; they do not establish that every historic artifact is publication-safe.

A subsequent cleanup review removes obsolete theme/demo prototypes, repair handoffs and evidence files from the active tree without rewriting public history. Exact preservation of these files is tracked in the separately controlled private archive branch archive/public-cleanup-20261022. Removing paths now does not erase their prior public exposure.

The selected Desktop Harbor UI and Mobile code remain in their maintained source directories. Licensing for third-party dependencies and any binaries must be evaluated independently; no approval to redistribute restricted SnowLuma SDK or its native addon is implied. See [public migration record](PUBLIC_MIGRATION_ACCEPTANCE.md) and [public repository policy](../development/PUBLIC_REPOSITORY_POLICY.md).

## Desktop snapshot update — 2026-10-23

The public main history at 33b10b3 was retained while importing the reviewed Desktop UI/Agent product delta corresponding to private source 2b2339c (included in private integration 7406fe2). This is a source snapshot, without attaching any private Git parent. Existing Mobile, introductions, governance, independent OneBot transport, dependency manifests and restricted-SDK bundle exclusions remain preserved. Internal repair reports and historical plans remain outside this export.

The public snapshot itself passed30 of31 selected registered suites; the remaining new-SEA suite was environment-gated. Desktop UI TypeScript/Vite build passed, and the export-boundary review found no issues. No new binary Release, installation, actual-account workflow or native-security acceptance is established by this update. See [current Agent integration boundaries](../desktop/AGENT_INTEGRATION_STATUS.md).
