# Public repository cleanup — review summary

Date: 2026-10-22  
Public repository: chx6418-source/CetaMesh  
Baseline main: 350c1fc4ec8d21d9ae7ac80285979c588c007e99  
Proposed branch: chore/public-repository-cleanup

## Scope

The cleanup removes **239 tracked files** (5,896,247 original file bytes, not Git pack size):

| Scope | Files | Handling |
|---|---:|---|
| Root historical reports / matrices / redundant encoded filenames | 98 | Private historical archive |
| Historical design-demos/ (early themes, five mock layouts, screenshots) | 80 | Private design archive |
| docs/archive/ | 10 | Private archive |
| docs/repair-evidence/ | 16 | Private test evidence |
| docs/repairs/ | 1 | Private developer handoff |
| docs/superpowers/ plans/specs | 27 | Private plans |
| apps/mobile/docs/superpowers/ | 7 | Private Mobile plans |

All targeted content was checked against the private integration tree: 238 entries had byte-identical blobs available there (including duplicated, misencoded names); one revised compatibility report was explicitly copied to the private archive branch. The private archive includes an exact per-file SHA/path manifest.

The cleanup does not remove production src/, desktop-ui/, desktop-shell/, apps/mobile/, build scripts, package locks, real protocol fixtures, plugin documentation, GitHub workflows or licensing/governance files. Maintained README, PROJECT_STATE, AGENTS and UI reference documents were updated to reflect the already completed public merge rather than the original preview branch.

## Outstanding verification

This PR needs its Desktop automation, any required native builds and public content review. Old design prototypes and audit reports may still be reachable through earlier public commits; this change does **not** perform a Git-history rewrite or establish that historical content contained no sensitive data. A separate secrets, third-party/license and history-exposure review may be required before a broader release.

Status: **review only**. No automatic main merge, old-version update-source change or Release is authorized.
