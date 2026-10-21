# M6-C Release Gates Implementation Plan

> Execute inline with superpowers:executing-plans. No delegation requested. All M6-C sections and the final mandatory decision rules have been received. Final status is computed from evidence and cannot be overridden.

**Goal:** Close reproducible release defects and produce truthful, individually evidenced Owner gates.

**Architecture:** Reuse the production Core Bootstrap, existing Capability/Approval/Task/Memory/Plugin machinery, SEA and Harbor. No replacement stores, event buses or migration engine. Only targeted changes after a reliable counterexample.

**Tech Stack:** Node ESM, TypeScript/React, Rust/WebView2, Windows SEA/IExpress; npm test is the sole test aggregator.

**Spec:** Owner's M6-C request; M6-B report, Owner checklist, final blockers and E/AC matrix at repository root.

## Constraints

- Base HEAD 83362a737936d456f24429b0fb958e6790f6ea26; product Build1088 source c3d5657fba5dfcd9a5004b84d0e87cf329aafaea.
- No real-data migration, credential/Preset overwrite, unknown-lock release, real-user process stop, unapproved QQ send, push, merge or publication.
- Fixture and release integration never substitute for real Provider, standard-user GUI or trusted production signing.
- Product changes require a registered reproduction test, minimal fix, regression, Build increment and clean-source packaging.
- No CLOSED gate without its actual acceptance evidence or separately documented Owner-approved deferral.

## Steps

- [x] Verify branch/HEAD/tree, M6-B provenance and unchanged Build1088.
- [x] Reprobe only configured update sources with TLS verification enabled.
- [x] Run eight existing scoped suites for Tool/Artifact/Task/Plugin/MCP/Update baseline.
- [x] Initialize the unique blocker ledger with explicit open/environment/Owner states.
- [ ] Trace production catalog/control diagnostics, native tool activity, Artifact identities and Plugin operations. Record exact implemented/missing/unverified distinctions.
- [ ] Reproduce confirmed defects using real service assembly or actual installed SEA/Harbor in isolated data; add each regression through npm test before implementation.
- [ ] Apply only proven minimal fixes; retain all M0-M6-B safety/ownership corrections.
- [ ] Exercise actual local production UI/installer paths allowed by the available Windows environment; provide manual steps for independent standard-user/VM gaps.
- [ ] Execute real Providers/Agents/QQ only if safe authorization and environment are verified; retain NOT_RUN_ENVIRONMENT otherwise.
- [ ] Complete final builds/tests, clean-source provenance, hashes and signature checks per remaining Owner instructions.
- [ ] Deliver final ledger, reports, E/AC evidence and manual acceptance; local commit and stop, preserving RELEASE_BLOCKED where necessary.

## Review Focus

1. Native UI method exists but never reaches a production Core handler.
2. Optional DSH catalog failure misreported as ordinary Chat unavailable.
3. Tool terminal/approval/cancel loses its formal message or starts another side effect.
4. Artifact metadata lacks the Task/Workspace identity required for safe opening.
5. Plugin disable/uninstall leaves a callable Worker or bypasses permissions.
6. Updater certificate or signature failures are mistaken for permission to bypass verification.

## Implementation decisions

- Preserve the legacy DSH available field and its existing assertions; fix only the actual Harbor catalog status renderer. The first projection hypothesis was rejected by an existing regression and reverted.
- Cancel only known, unexecuted waiting-approval tool activities after Broker cancellation; do not claim active external tools stopped.
- Manifest redirect checks preserve signature verification and fail closed on HTTPS downgrade, unapproved hosts, missing Location and loops.
- Real migration is not automatically required for release; unresolved compatibility/access or writer safety remains a separate gate.
- Final delivery: CETAMESH_FINAL_RELEASE_GATE_REPORT.md, CETAMESH_FINAL_RELEASE_BLOCKERS.md, CETAMESH_OWNER_FINAL_ACCEPTANCE.md, the unique blocker ledger and final 64-case E/AC matrix.

## Owner stop and Git authorization (2026-10-19 local)

Owner explicitly requested merge/push and shutdown, then clarified shutdown even if acceptance is incomplete. Stop acceptance now. Build1091 source9b25f3b is committed and focused UI/Chat regression passed; final packaging/full npm/RC not run. Intermediate1090 aggregate128PASS/1FAIL/5NOT_RUN retained (release suite expected1091 package after version advanced). Final gate RELEASE_BLOCKED; no fake completion. Merge/push origin main only after clean/ancestry checks; no Stable/tag/deploy. Preserve artifact worktree and unrelated design changes.
