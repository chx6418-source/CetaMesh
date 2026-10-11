# CetaMesh Local Storage Audit

**Snapshot:** 2026-10-11 (Windows, metadata only for user-profile locations)<br>
**Desktop audit root:** `D:\GIT-QQ-BRIDGE`<br>
**Mobile audit root:** `D:\GIT- CetaMesh`<br>
**Units:** GB uses decimal bytes (1 GB = 1,000,000,000 bytes). Nested directory totals overlap and must not be summed.

## Git state recorded before cleanup

| Repository / worktree | Branch / HEAD | State | Size excluding shared Git store | Merge / cleanup note |
|---|---|---:|---:|---|
| Desktop shared checkout `D:\GIT-QQ-BRIDGE` | `design/ui-ia-exploration-2026-10` / `19d6002140190c543b1850b71d05ac7e509e535e` | Dirty; staged changes, unmerged `PROJECT_STATE.md`, `src/app/ipc-runtime.js`, `src/app/service-container.js`, modified/deleted/untracked product and design files | 18.107 GB | Preserve all source, drafts, QA output and conflicts. `assets/project-intro.mp4` is marked deleted in this dirty checkout; left untouched. |
| Desktop `main` worktree | `main` / `205d88b623f01828b27ad1d66110f09e1a537fe8` | Clean; `origin/main` ahead by 26 | 2.012 GB | Keep as active main checkout; no push. |
| Desktop product-context phase1 | `codex/session-20261009-rules-confirm` / `09e199197cdd099a1f2eb7fc29c3a63756e5cd2b` | Clean | 1.563 GB | Commit is an ancestor of local `main`; removal is only a candidate and awaits owner confirmation because use is not provable. |
| Desktop RC2 temp worktree | detached / `2986e7834b906d73ba5ba0c787c253999242fc76` | Clean | 2.491 GB | Commit is merged; package duplicates exist in Desktop `dist`; preserve the release workspace pending owner confirmation. |
| Desktop task worktree | `codex/local-storage-hygiene` / `205d88b623f01828b27ad1d66110f09e1a537fe8` | Clean at audit start | 0.025 GB | Current task branch; retain until owner confirms merge/cleanup. |
| Mobile shared checkout `D:\GIT- CetaMesh` | `codex/production-release-integration` / `4b80d2d7910b80e395f366f5841a11083c3f621d` | Clean, tracks origin branch; stash empty | 0.321 GB | Existing checkout preserved. Mobile Git store is separate. |
| Mobile task worktree | `codex/local-storage-hygiene-mobile` / `4b80d2d7910b80e395f366f5841a11083c3f621d` | Clean at audit start | Not remeasured in the Desktop scan | Current Mobile task branch; retain until owner confirms merge/cleanup. |
| CetaMesh website `D:\cetamesh-web` | `feature/website-production-v1` / `e0b15eab5cc96a1a58cbc67560dededdc49d0d20` | Clean | 1.014 GB | Separate website workspace, preserved and outside cleanup changes. |

Desktop stash list is empty. Mobile `.git` is 17.45 MiB packed, with no loose objects or garbage. Desktop `.git` reports 219 loose objects / 1.38 MiB, 369.71 MiB packed, and 3.51 MiB of garbage (`.git/objects/d9/tmp_obj_xUpbda`). No `git gc`, prune, or history rewrite was run.

## Largest measured paths

| Path | Bytes | Size | Tracked? | Generated? | Rebuildable? | Unique / protected? | Safe to delete? | Recommended action |
|---|---:|---:|---|---|---|---|---|---|
| `D:\GIT-QQ-BRIDGE` | 18,106,932,045 | 18.107 GB | Mixed | Mixed | Mixed | Contains dirty source and unique QA | No | Preserve checkout; only act on the exact incremental-cache entry below. |
| `D:\GIT-QQ-BRIDGE\desktop-shell` | 14,507,635,168 | 14.508 GB | Mixed | Mostly build output | Partly | Contains current target | No | Do not remove the directory. |
| `D:\GIT-QQ-BRIDGE\desktop-shell\target` | 14,503,381,625 | 14.503 GB | Ignored | Yes | Yes, with costly rebuild | Contains active/release caches | No, as a whole | Keep current target; remove only the audited debug incremental cache. |
| `D:\GIT-QQ-BRIDGE\desktop-shell\target\debug` | 10,846,500,950 | 10.847 GB | Ignored | Yes | Yes | Mixed build cache | Not as a whole | Keep dependencies and build outputs. |
| `D:\GIT-QQ-BRIDGE\desktop-shell\target\debug\deps` | 6,621,611,905 | 6.622 GB | Ignored | Yes | Yes | Shared active cache | No, as a whole | Keep. |
| `D:\GIT-QQ-BRIDGE\desktop-shell\target\release` | 3,656,870,639 | 3.657 GB | Ignored | Yes | Yes | Contains release inputs | No, as a whole | Keep. |
| `D:\GIT-QQ-BRIDGE\dist` | 3,280,352,219 | 3.280 GB | Ignored | Yes | Not exactly reproducible | 21 historical installer builds, unbacked | No | Preserve until remote backup and canonical identity are verified. |
| `D:\GIT-QQ-BRIDGE\desktop-shell\target\release\deps` | 2,984,824,613 | 2.985 GB | Ignored | Yes | Yes | Release cache | No, as a whole | Keep. |
| `D:\GIT-QQ-BRIDGE\desktop-shell\target\debug\incremental` | 2,963,681,838 | 2.964 GB | Ignored | Yes | Yes | No unique release artifact | **Yes, exact path only** | Safe first-run cleanup after final path recheck; do not run `cargo clean`. |
| `%TEMP%\cetamesh-release-rc2` | 2,491,338,292 | 2.491 GB | Git worktree | Build + RC output | Partly | RC2 workspace and target | Owner review | Preserve until owner confirms worktree removal. |
| `%TEMP%\cetamesh-release-rc2\desktop-shell` | 2,219,336,462 | 2.219 GB | Mixed | Yes | Yes | RC2 target | No, in this pass | Preserve with RC2 worktree. |
| `%TEMP%\cetamesh-release-rc2\desktop-shell\target` | 2,215,468,966 | 2.215 GB | Ignored | Yes | Yes | RC2 target | Owner review | Do not clean another worktree. |
| `C:\Users\Administrator\.codex\worktrees\product-context-main-merge` | 2,012,059,305 | 2.012 GB | Mixed | Yes | Yes | Active `main` worktree | No | Keep. |
| `...\product-context-main-merge\desktop-shell` | 1,946,942,416 | 1.947 GB | Mixed | Yes | Yes | Main build cache | No, as a whole | Keep. |
| `...\product-context-main-merge\desktop-shell\target` | 1,942,856,344 | 1.943 GB | Ignored | Yes | Yes | Main build cache | No, in this pass | Keep. |
| `...\product-context-main-merge\desktop-shell\target\debug` | 1,942,854,769 | 1.943 GB | Ignored | Yes | Yes | Main build cache | No, in this pass | Keep. |
| `...\product-context-main-merge\desktop-shell\target\debug\deps` | 1,582,229,347 | 1.582 GB | Ignored | Yes | Yes | Main build cache | No, in this pass | Keep. |
| `C:\Users\Administrator\.codex\worktrees\product-context-phase1\GIT-QQ-BRIDGE` | 1,562,539,403 | 1.563 GB | Mixed | Yes | Yes | Separate clean, merged worktree | Owner review | Preserve pending owner confirmation. |
| `%TEMP%\cetamesh-release-rc2\desktop-shell\target\debug` | 1,552,701,677 | 1.553 GB | Ignored | Yes | Yes | RC2 build cache | Owner review | Preserve with RC2 worktree. |
| `...\product-context-phase1\GIT-QQ-BRIDGE\desktop-shell` | 1,500,134,151 | 1.500 GB | Mixed | Yes | Yes | Separate worktree | Owner review | Preserve pending owner confirmation. |

The Desktop checkout also contains `output` (149,475,671 bytes), `node_modules` (44,385,139 bytes), and the shared Git object store (393,302,576 bytes). `desktop-shell/target-released`, `desktop-shell/native-spike`, `scripts/.test-runner`, root `build`, `release`, and `artifacts` were absent. Directory totals above overlap.

## Desktop release installer inventory

The following 21 installer EXEs were found in `dist` release manifests. Every legacy entry lacks a build number and has no `remoteBackedUp: true`; none is eligible for automatic pruning. SHA-256 values were calculated from the files. Created times are UTC. Commit is abbreviated here; the release manifest holds the source metadata when present.

| Relative path | Product version | Build # | Source commit | Bytes | Created (UTC) | SHA-256 |
|---|---|---:|---|---:|---|---|
| `app/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.2 | missing | `48408f9d39dd` | 42,483,712 | 2026-10-11 04:07 | `bbcb9f276e987c732ca1fca61bab55e99ce34c57cd25940b1d1fffb622f576f3` |
| `app-1.0.0-rc.1/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `35261e9e4a57` | 41,914,368 | 2026-10-05 04:33 | `82eb7c41c4164d051794edc8e2b1cf91a574bea210c5724507b08fc19c008343` |
| `app-1.0.0-rc.1-27e9606/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `27e9606d9b66` | 41,943,040 | 2026-10-05 07:25 | `7430725b340d205d44738131e1836275411e5fa601784180843eb84e505f1c72` |
| `app-1.0.0-rc.1-dfb0061/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `dfb0061a5d77` | 42,086,400 | 2026-10-06 13:24 | `3115c89cfdb122015b820cd247c870467b5f04e2a26d3ac3528c925c2f141f5a` |
| `app-1.0.0-rc.1-final/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `ca0eefae52f6` | 41,938,944 | 2026-10-05 07:08 | `3a165b5ae22b748be002b5856b169d9cb0bb2f43fe5a58a91e02a13d10296b23` |
| `app-1.0.0-rc.2/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.2 | missing | `2986e7834b90` | 42,328,064 | 2026-10-08 15:36 | `33b55c40347593c72f20ba60a4ef57effad9fec8e88ff9097e83ad996b268a84` |
| `app-dirty-2026-10-05/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `32571d4407a7` | 42,049,536 | 2026-10-05 13:58 | `f7861fcd457dc4ffa4cd00ba78723db5fde9bdf645edfb7361099be7472edabc` |
| `app-previous-2026-09-21T16-08-47-181Z/WhaleBridge-Setup-x64.exe` | 0.1.0 | missing | missing | 40,521,728 | 2026-09-21 15:54 | `be20630e33f5ee291a1d7929be2c02e73d381182f631c16d8643c9fa763cec2d` |
| `app-previous-2026-09-21T16-12-20-464Z/WhaleBridge-Setup-x64.exe` | 0.1.0 | missing | missing | 40,595,456 | 2026-09-21 16:08 | `c85587e996c71d4b080e898e96e07df5a4bb17fd164ec658aaefc821d55394e0` |
| `app-previous-2026-09-21T16-45-02-038Z/WhaleBridge-Setup-x64.exe` | 0.1.0 | missing | missing | 40,595,456 | 2026-09-21 16:12 | `ef95fdc72925797b403df8e273adc352a4116c7f1adc6e4a137634977d3e5af1` |
| `app-previous-2026-10-04T10-50-00-383Z/WhaleBridge-Setup-x64.exe` | 0.1.0 | missing | missing | 40,710,144 | 2026-09-21 16:45 | `a0e03df3f46e636cd637c07df316d97ba4bfce206f20e211fb1abf818077d3fd` |
| `app-previous-2026-10-05T10-48-13-303Z/WhaleBridge-Setup-x64.exe` | 0.1.0 | missing | missing | 41,742,336 | 2026-10-04 10:49 | `6830ec6f4dd458eae90435c083a94d66d9209ab8156f83f7b9e52d0bb838e911` |
| `app-previous-2026-10-05T10-58-29-874Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `6903dd06bc30` | 42,012,672 | 2026-10-05 10:48 | `a720ecd688da924ce9e9f86a8b5ae5ed8d2a9ab78390b13eddbeaa6bdbfe505c` |
| `app-previous-2026-10-05T11-07-02-028Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `e0ed980f05d4` | 42,012,672 | 2026-10-05 10:58 | `32c13a8387731281ab89f5b00967d86efdec75df2ab457dfaad429cd5878d09d` |
| `app-previous-2026-10-05T11-12-13-903Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `76f8b6368402` | 42,016,768 | 2026-10-05 11:07 | `9ba6de310f457b3906540161cc328fe094095c6b45551f9f6b96e987874cf49f` |
| `app-previous-2026-10-05T13-58-01-529Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `74ede4eb0548` | 42,012,672 | 2026-10-05 11:12 | `d3a7d3af35182728b7e619151acbadd140dbfcb8b67b9602a5cccfe9749e9a15` |
| `app-previous-2026-10-05T14-42-23-476Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `9861976b1c30` | 42,033,152 | 2026-10-05 14:06 | `b55a1559ba5830897f312d32d02ff5cd02c400b4ecee9f52078fdd29461b6fad` |
| `app-previous-2026-10-07T13-16-46-413Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `d4c9395c4c2a` | 42,074,112 | 2026-10-06 12:04 | `6396b7e228797a66b856a7e18603c23982bc387ee7338aedd2b8b7f4a01decc6` |
| `app-previous-2026-10-07T13-23-23-985Z/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `9c882dea1fdd` | 42,078,208 | 2026-10-07 13:16 | `3ae96987e804ed3add44956b401f5ef4ca4a13a9905b4b32a3ba5234dae6de36` |
| `app-previous-32571d4/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `32571d4407a7` | 42,037,248 | 2026-10-05 14:01 | `6ebb6b364217d48273bd0209eac123d98435b6545fad7424c185e2d39e99ee33` |
| `app-previous-9861976/WhaleBridge-Setup-x64.exe` | 1.0.0-rc.1 | missing | `9861976b1c30` | 42,074,112 | 2026-10-05 14:42 | `e1181a60c0f70c0eb1bf91e60c5e044ddc16981a550c8416a0f393b01512231c` |

Additional files:

| Path | Metadata | SHA-256 | Classification |
|---|---|---|---|
| `D:\GIT-QQ-BRIDGE\dist\CetaMesh-Setup-1.0.0-rc.1.exe` | 41,943,040 bytes; 2026-10-05 07:25 UTC; sidecar `.sha256` exists | `7430725b340d205d44738131e1836275411e5fa601784180843eb84e505f1c72` | Exact duplicate of `app-1.0.0-rc.1-27e9606`; keep until package-level canonical source and remote backup are decided. |
| `%TEMP%\cetamesh-release-rc2\dist\app\WhaleBridge-Setup-x64.exe` | 42,328,064 bytes; 2026-10-08 15:36 UTC; release worktree is clean and merged | `33b55c40347593c72f20ba60a4ef57effad9fec8e88ff9097e83ad996b268a84` | Exact duplicate of `dist/app-1.0.0-rc.2`; preserve the worktree pending owner confirmation. |
| `D:\cetamesh-wt\WhaleBridge-Setup-x64.productization.exe` | 42,504,192 bytes; 2026-10-11 05:19 UTC; Windows file metadata says `WEXTRACT.EXE` / Internet Explorer 11.00.22621.4745, not CetaMesh product metadata | `56f57101019362bd2fcc4fcebee1f9cbfe4906a9fb76024176740fda02a3be65` | Manual review; do not treat as a verified CetaMesh release installer. |

## Mobile, caches, and external named paths

| Area | Measured state | Classification / action |
|---|---|---|
| Mobile `node_modules` | 318,764,543 bytes; active shared checkout | Keep. Do not duplicate or remove the active dependency tree. |
| Mobile Android `android/app/build`, `android/build`, `android/.gradle`, `android/app/build/outputs` | Absent; no APK/AAB found | No Mobile build output exists to retain or clean. |
| Desktop `%LOCALAPPDATA%\npm-cache` | 1,408,507,702 bytes | Report only; no `npm cache clean --force`. `npm cache verify` is the safe check. |
| `%USERPROFILE%\.gradle` | Absent | No global Gradle cache found at the default location. |
| `%TEMP%` names beginning `CetaMesh` / `WhaleBridge` | 655 entries, 4,050,269,064 bytes total; includes the 2.491 GB RC2 worktree | Metadata-only audit. Do not delete unknown or active diagnostics. |
| `%TEMP%\WhaleBridgeInstallerPayload-*` | 15 directories, 873,084,125 bytes total; last write 2026-10-09; no matching installer PID is running | Manual review: no per-run install-success/failure marker proves these are disposable diagnostics. |
| `%TEMP%\cetamesh-ws-*` | 150 directories, 10,326,191 bytes total; entries include recent writes | Keep; live Node processes exist and these paths have no completion marker. |
| `%TEMP%\cetamesh-bare-integration-*` / `cetamesh-bound-integration-*` | 22 + 20 empty directories, 0 bytes | Keep until test-run ownership/active state can be proven. |
| `%TEMP%\whalebridge-native-release-pending-20260923` | 127,864,832 bytes | Manual review; name indicates a pending release record. |
| `%TEMP%\cetamesh-d0-core-1791112181064` | 102,099,300 bytes | Manual review; purpose/outcome is not recorded in metadata. |
| `%LOCALAPPDATA%\WhaleBridge` | 2,187,065,153 bytes | **User runtime data; do not clean.** Contents were not read. |
| `%LOCALAPPDATA%\WhaleBridge-before-migrate-224829` | 39,304,267 bytes | **User-data migration backup; do not clean.** Contents were not read. |
| `%APPDATA%` | No matching top-level names | No matching data found. |
| `%USERPROFILE%\Downloads\CetaMesh-Logo-05.png` | 69,297 bytes | User asset; keep. |
| `%USERPROFILE%\Desktop` | CetaMesh handoff text (12,240 bytes) and `CetaMesh.lnk` (1,384 bytes) | User document and shortcut; keep. File contents were not read. |
| CetaMesh website `D:\cetamesh-web` | `.next` 586,865,492 bytes; `node_modules` 419,577,164 bytes | Separate clean website checkout; preserve and do not include in Desktop/Mobile cleanup. |

No user-profile file contents were scanned. External paths were limited to names, paths, sizes, and timestamps for CetaMesh/WhaleBridge matches.

## Git historical objects

Desktop `git count-objects -vH` shows a 369.71 MiB pack and 3.51 MiB garbage. Largest historical blobs include several 95–96 MB `WhaleBridgeCore.exe` copies, a 42 MB installer, two ~40 MB ZIP packages, and `assets/project-intro.mp4` (11.46 MB). Mobile history's largest listed blob is the same 11.46 MB video. The current shared Desktop checkout marks that tracked video deleted but dirty; it was not restored, staged, or otherwise changed. No history rewrite is authorized in this task.
