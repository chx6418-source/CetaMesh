# M5-A read-only inventory and fixture migration plan

**Goal:** Produce reproducible redacted inventories and migration plans, then verify recoverable migration only in tool-created temporary fixtures.

**Architecture:** Read-only discovery uses createAppPaths and explicit root provenance. Domain schemas and file hashes produce deterministic plans without runtime store constructors. A separate testing helper owns a private fixture permit and only writes inside a temporary root it created; no real apply CLI or runtime resolver is installed. Existing Storage Primitive handles JSON persistence. Production Core/Connector/Bionic ownership and data gates remain unchanged.

**Spec:** Owner M5-A request; 03 Legacy migration design; M4.4 report and data ownership/migration plans.

**Constraints:** No real migration, credentials/config/preset/registry writes, process stopping, lease reclaiming, store activation, long-term memory imports, push, merge or release. Reports contain metadata/hashes, never account IDs, tokens or message bodies. Unknown attribution and side effects block switching.

## Tasks

- [x] Add registered failing tests for deterministic read-only inventory, path precedence, source drift/schema/ownership/conflict/unknown-effect rejection and secret redaction.
- [x] Implement src/migration inventory/schema helpers and scripts/whalebridge-migration-dry-run.mjs; inspect installed/source roots and config-referenced DSH locations without writes.
- [x] Add fixture-only migration tests and helper for approval, stopped writers, leases, immutable backup and permission evidence, journal, stage verification, atomic pointer, restart, compensation and rollback. Test both sides of every commit boundary and preserve original bytes/IDs/scopes.
- [x] Exercise two accounts/groups, existing targets, tampering, missing cursor, disk/permission/link failures and crash recovery. Reject real roots even with spoofed flags.
- [x] Run npm test, Core/UI builds, desktop check/test and applicable SEA/release regression. Final npm: 114 PASS / 0 FAIL / 7 environment skips; Rust: 198 PASS; focused SEA/Core: 2 PASS. Four reports and actual redacted inventory delivered separately. Real writes remain unauthorized; production resolver and Legacy read-only compatibility need M5-B design approval.

## Review focus

The fixture pointer is a tested design prototype, not a production store resolver. Absence of a lock is not proof of stopped real writers. Windows ACL and process-start identity must be explicitly addressed before M5-B. Reports never serialize raw config or session data. Dry Run is read-only even when sources are damaged or change during a scan. Backups and target metadata must be verified before any pointer commit or rollback; no uncertain step permits a second writer.
