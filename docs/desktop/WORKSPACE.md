# Workspace ownership, execution and recovery

The product flow is **Project → Task → Changes / Review**. Opening an existing
folder registers a project; it does not initialize Git, copy the project, approve
tools, or assign an Agent. Advanced Git views expose branches and worktrees.
The current Harbor Changes and Task review surfaces share `DiffViewer`; new
features must not introduce another file-review UI or another Workspace runtime.

## Owners and entry points

| State | Authoritative owner | Derived consumers |
| --- | --- | --- |
| Project ID, canonical root, settings, recent files, registered Git relations | `src/workspace/registry.js`, existing atomic `workspaces.json` | Workspace service, sidebar, project selectors |
| Task ID, revision, Workspace binding, status, Attempts, current executor and evidence | `src/task/runtime.js` / `store.js` | Task UI, Agent Broker, Continuity |
| Actual file contents, HEAD, refs, index and linked worktrees | Filesystem and native Git | `workspace/tools.js`, `git-product.js`, Changes, Continuity |
| Tool authority, approval, finite grants and logical-operation outcome | Existing Capability Broker / Policy / Approval / dispatch journal | Workspace executors and Agent adapters |
| Filtered execution input, baseline hashes, output proposal | `workspace/staging.js`, owned by the Provider session lifecycle | Exact approved imports; never authoritative Task completion |
| Import intent, original bytes and rollback state | `workspace/transaction.js`, existing root-scoped import journal | Startup recovery and Workspace write fence |
| Checkpoint and handoff references | Existing Continuity runtime | Reconciliation against live facts, not replacement file/Task state |

Trusted Desktop IPC enters `workspace/service.js` or `desktop/ui-service.js`.
Agent and plugin effects enter Capability Broker. `executeApprovedGit` is an
in-process executor, not an IPC approval flag. Callers must not create their own
Workspace stores, trust arbitrary cwd values, or write project files directly to
avoid these boundaries. Existing IPC names and Workspace/Task IDs remain stable.

## Execution areas: existing backends, one interpretation

An execution area is a Task-bound working directory and baseline, not another
persistent domain. Use existing Workspace identity, staging `versionContext`,
Task Attempt/Session, Git relation and operation references together:

1. Resolve the current Task and authorized Workspace. A role description or
   historical Worktree `taskId` is not an execution principal.
2. Prepare the existing backend. A non-Git project uses a bounded filtered copy.
   Git may provide a separately approved linked worktree, sharing Git history.
   Creating a worktree registers its provenance; it does not silently retarget an
   existing Task. Changing an executor does not create a new project or Task.
3. External native adapters currently still use the filtered-copy boundary even
   for a Git source. It preserves dirty/untracked inputs, excludes credentials and
   nested projects, and requires separate import approval. Replacing it with HEAD
   checkout would change these semantics. **A Git worktree is not an OS sandbox.**
4. An existing managed worktree under private StateDir is recognized only after
   checking its canonical managed location, registered parent, native Git link,
   common metadata and backlink. This exempts only that verified source subtree
   from private-state ancestor exclusions. Detailed exclusions and path/secret
   checks remain. No renderer or model can supply this trusted provenance.
5. Collect a change proposal; compare exact bytes to the baseline. Verify live
   preimages only for changed paths, including their ancestors. Stage output still
   receives a full bounded scan. No-op turns do not rebase or claim unrelated edits.
6. Apply exact Broker-approved changes through the existing import transaction.
   Refresh only accepted baseline outputs; independently verify before delivery.
7. Unknown native exit, pending import or uncertain operation retains execution
   ownership/evidence. Do not clean up or replay it just because an Agent changed.

Initial copying and stage scanning remain bounded full operations. The default
snapshot limits are separate from import limits: the latter still allow at most
500 changes and 5 MiB per text file. The current text import contract rejects a
change that cannot survive UTF-8 round-trip without changing bytes. Original
binary/non-UTF-8 output is retained for explicit review, never silently transcoded.

## Failure and recovery rules

- Task execution observations survive JSON reload. Restart blocks interrupted
  running/waiting Tasks and marks their retained observation unknown; it does not
  infer completion from a former Agent report or repeat its instruction.
- Every protected Capability dispatch retains its available Task/Workspace
  binding, including Tasks with no Workspace. This applies with and without a
  logical Operation ID. A settlement write failure is an unconfirmed outcome;
  restart retains that fence. Only the invocation holding the dispatch claim can
  settle it. Reusing its request ID for another capability cannot clear the fence.
  Owner review requires the exact recorded Task/Workspace and a settled executor;
  the reviewed request remains non-replayable. Older rows lacking attribution
  remain unattributed and require independent evidence, not guessed migration.
  The Core's Continuity safety point consults both Capability and model-tool
  recovery, including effects without a logical Operation ID, before transferring
  Agent authority. Owner review of an effect does not bypass Agent safety checks.
- Import journals are partitioned by canonical source-root hash and validate
  their recorded root. An incomplete/corrupt journal blocks that project, not
  every registered project. Original files and unknown journal material remain.
  An ancestor/descendant registration of the same unresolved tree inherits the
  fence. Removing an unresolved registration is refused, preserving recovery
  ownership across restart. The affected project remains inspectable; execution
  roots and writes are withheld.
- Valid journal recovery only restores a file whose current hash matches the
  known original or staged image. A third-party edit requires review. Never
  overwrite it to make startup succeed. Do not automatically delete unknown
  worktrees, reset Git, discard unstaged changes, or merge results.
- The retained legacy `workspace.pending.*` Owner API rechecks live commit policy,
  exact HEAD/paths/hashes and expiry. Before dispatch it persists `executing` in
  the existing pending row. Only specific proven pre-execution failures become
  `failed-no-effect`, requiring another explicit decision. Uncertain failures and
  interrupted `executing` rows require reconciliation; denial cannot erase them.
  Unknown/executing commits block overlapping project writes and execution roots.
  Their project registration cannot be removed. A failed registry replacement
  rolls back its in-memory pending mutation, so another save cannot erase the
  surviving disk execution fence.
  Current product Git actions continue using Capability Broker approvals.
- Git HEAD/status/diff or required file observation failure cannot certify an
  unchanged handoff. `consistent:null` means unverified; it is not success.
  Diff is not applicable to a positively identified non-Git folder. Non-Git
  execution is supported; automatic non-Git cross-session handoff remains gated
  until the existing Continuity contract can prove the required state.

Primary error codes: `WORKSPACE_CONFLICT`, `WORKSPACE_RECONCILIATION_REQUIRED`,
`WORKSPACE_RECOVERY_REQUIRED`, `IMPORT_JOURNAL_INCOMPLETE`,
`STAGING_ENCODING_UNSUPPORTED`, `STAGING_PATH_DENIED`, `GIT_INDEX_BUSY`,
`GIT_COMMIT_DENIED`, `PENDING_BUSY`, `PENDING_RECONCILIATION_REQUIRED`.
Do not convert any of them into successful delivery or unconditional retry.

## Automatic recovery after a lost Agent session

An unavailable transport or `SESSION_NOT_FOUND` from an external Provider is not
evidence that its process stopped. Keep the old Task binding, execution evidence
and Workspace ownership until independently verified. For Core-owned Codex
execution, the lifecycle record binds Task, Workspace, Session, staging snapshot
and execution generation. Its Windows supervisor issues a stop receipt only when
the owned Job has no active processes. A root-process exit, missing PID or Owner
description cannot substitute for that receipt. Historical sessions without
trustworthy receipts remain unresolved; recovery does not invent missing proof.

`ui.task.recovery.inspect` reports the blocking Task, Agent,
status, ownership reason, unresolved operations and available actions. Its
short-lived review token binds the current Task revision, session proof,
Workspace contents and exact operation set. A non-Git Workspace uses an
exhaustive bounded proof of the filtered staging scope, including file bytes,
paths, sizes and modes. This path does not initialize Git. Incomplete scans,
links, changed roots or concurrent changes cannot certify recovery. Inspection
does not dispatch an Agent or replay tools. Once all execution and operation
blockers are settled, the existing Workspace service can finish a verified import
rollback using its original manifest and preimages. Unknown or changed bytes stay
untouched; inspection is not unconditionally a read-only filesystem operation.

Content observation can automatically include an in-bound nested Git repository
or linked worktree. It verifies canonical directories, the Git metadata location
and a linked worktree's exact `commondir`/`gitdir` backlink before observing its
HEAD, index and file bytes. Nested Git enumeration fixes both metadata and working
directories and disables filters, hooks and filesystem monitors; configuration
values and object contents are not copied into evidence. This proof neither adds
nested projects to execution staging nor expands import or tool authority.
External metadata without proven current Workspace ownership, substituted links,
unmerged indexes and concurrent changes remain unverified with bounded diagnostic
codes. The original Task binding and operation evidence remain intact.

Read-only Git proof hashes files sequentially in 64 KiB chunks, with a 64 MiB
per-file and 512 MiB aggregate bound, 25,000 paths, at most 32 nested repositories
and eight nesting levels. Metadata, file identities and file sets are rechecked
after asynchronous observation. Only the aggregate digest enters a Handoff; no
file bytes are included. These observation limits do not change the 10 MiB file
tool read cap or the existing 5 MiB text-import limit.

The startup recovery sweep snapshots candidate Task IDs before releases can
reorder pagination, then rereads each current binding. Core shutdown cancels the
sweep's own read-only Git processes and content observation through an internal
AbortSignal. Cancellation is rechecked before import rollback and each recovery
commit; it neither releases an unverified Task nor stops a user's Agent process.

Task details automatically inspect the current revision with `automatic:true`.
When the proof is complete, `ui.task.reconcile` automatically releases the old
execution without a human summary, checkbox or new model request. Normal Task
resume and a new Chat message use the same Core coordinator to verify and continue
the same Task. Creation in an occupied Workspace can retire a proven stale owner
through that coordinator; the new Task does not inherit the old execution.

A normally paused Managed Session that is still present and proven idle in the
same Core can resume without retirement. Automatic inspection reports
`canResume:true, canRelease:false`; the UI enables Continue without submitting a
release. Native processes and missing/restarted Sessions do not qualify for this
shortcut. A competing Task still needs the full owner-release proof; a refusal
preserves `TASK_WORKSPACE_BUSY`, the blocking Task ID and its specific recovery code.

Automatic recovery requires a proven stopped executor, settled operation journals,
no pending approval or unknown effect, verified Workspace contents and valid import
receipts. For each path with completed Core writes, its current bytes must match a
retained completed receipt. Intent timestamps are not completion order; this check
recognizes a known postimage, not the final intended result or Task success. A fresh
execution must inspect current state. Prepared Handoffs and incomplete historical
manual reviews cannot be automatically acknowledged. Failures expose their actual
blocker and retain history; refreshing the page does not loop failed recovery.

The older Owner token-and-review API remains available for compatibility.
Active execution, unknown stop state, active tools, pending approvals and children
still prevent retirement. A prepared Handoff additionally requires its original
Task/Workspace and both exact participants to be verified stopped. Missing target
Session identity requires a Provider-owned Task-scoped quiescence proof; it cannot
be inferred from a creation error. Codex Handoff inspection is a private Core
method that checks lifecycle generations and bootstrap identity; ordinary Session
recovery retains its stricter current-assignment/current-run checks.

Commit rechecks the recorded
bindings, writes a recovery intent before acknowledging journals, and then
records the review and retires the old binding. A partial write retains a fence;
it cannot free the Workspace or silently mark an unknown effect successful.
The intent retains the exact reviewed Handoff scope if its journal was already
acknowledged, so the next inspection rechecks both participants live again.

Unknown native tool observations appear in the same review as opaque hashes
bound to the Task, Workspace and complete evidence row. Their original status
and content remain unchanged. Only the exact reviewed older execution stops
blocking acceptance of a later independently evidenced run; a new unknown tool
result, changed observation or unrelated Session remains blocked. A textual
summary alone never retires a tool observation.

Recovery can release ownership without dispatch or continue the same
Task with a fresh Session and new request identity. Automatic continuation carries
the original goal and requirements, historical checkpoint and an instruction to
verify current state without replaying prior effects. A new user instruction is
appended to that context. Oversized constraints stop dispatch rather than being
silently dropped. Concurrent identical resume actions share the entire recovery
and dispatch promise; different pending requests are refused.
Prior requests remain non-replayable. Checkpoints, Memory references, reports and
execution evidence remain available. The compatibility resume entry point also
requires new instruction/request identity after this retirement. Recovery intent
and review records remain bound to their original Workspace; changing the Task's
Workspace cannot detach that evidence from its scope.

A separate durable dispatch fence covers the interval before Task attachment,
including attachment or blocked-state persistence failure. `blocked` alone never
releases it. Workspace-busy feedback links to the actual owner; pre-dispatch Chat
failures do not create Agent output or imply tool completion. The UI binds automatic
recovery to the inspected Task revision and prevents duplicate submissions,
including remounts while a release is still pending.

Registered regressions include `test-owner-session-recovery`,
`test-agent-workspace-fence`, `test-workspace-recovery-proof`,
`test-codex-session-lifecycle`, `test-codex-owned-supervisor` and
`test-chat-failure-feedback-ui`. Controlled fault tests, rendered component tests
and actual native/model acceptance are separate evidence.

## Protected raw file sets

Branch switching prepares converted target bytes and an index in an owned
temporary directory. Git never checks out directly over live Workspace files.
The existing Workspace transaction owner publishes at most 100 exact regular
file changes, with 10 MiB per file and 64 MiB per original or target set. On
Windows, the existing Desktop executable provides a fixed headless primitive:
exclusive file handles protect the raw SHA-256 preimage check, backup, write or
delete, flush and readback. Handle-relative child opens and directory leases
reject reparse points, hard links, active writers and writable mappings. An
unavailable host is a known pre-execution refusal, not an unknown execution.

The transient, root-partitioned journal uses an explicit schema version 2 for
`protected-raw-byte-set-v1`. Workspace registration, Task storage and legacy
text-import journals retain their existing schemas. Older transaction readers
refuse the new journal and preserve its preimages; they must not roll it back or
delete it as a completed version-1 import. A downgrade with a pending raw journal
therefore requires finishing that operation with a compatible Core first.

A native terminal receipt is bounded at 256 KiB by both producer and reader and
binds the exact request digest, opaque owner facts,
file hashes and native node identities. It proves only the file phase; normal
index replacement and the physical worktree HEAD CAS remain separate existing
Git phases. Missing or partial receipts retain the original journal and block
replay. After restart, the Workspace owner can read a completed receipt, verify
its original backups and current raw postimages, and expose it for a fresh Git
approval to finish only missing phases. It does not reconstruct an execution
stack or repeat file writes. A changed manifest generation, receipt or user file
refuses that continuation and preserves evidence.

Known completion may carry `cleanupPending`. Retiring a journal first requires
its original directory identity and a successful rename, which a live native
directory lease prevents. Before deleting its artifacts, Core flushes a bounded
`retirement-<nonce>.json` containing the terminal v2 manifest in the same journal.
Preparation uses a bounded `retirement-pending.json` inside the verified retired
directory, followed by atomic create-new hardlink publication after write and
fsync, then pending-name removal. Existing destination evidence is never
replaced. A crash between publication and pending removal permits only the exact
same-node two-link pair under the verified directory and terminal proof; extra
links or a mismatched peer remain refused. Other journal artifacts and source
files retain their existing hardlink restrictions. Interrupted
preparation leaves the terminal manifest authoritative; pending bytes grant no
cleanup authority. A corrupt published record remains refused.
This cleanup-only record binds the root, request digest and directory node; it
is removed last, after the retired directory is gone. The record and directory
represent one pending cleanup, including when the final directory removal or
record unlink fails. Missing, corrupt or mismatched evidence remains refused.
Completed private cleanup can resume after restart without restoring files or
overwriting later user work, and cannot authorize Git adoption. These boundaries do not
make files, index and HEAD one atomic transaction and do not promise power-loss
durability. Capability authorization and unknown-effect protections still apply.

Registered native regressions include `test-workspace-native-byte-transaction`,
`test-workspace-byte-recovery`, `test-git-branch-byte-preservation`,
`test-git-branch-file-race` and `test-git-branch-conversion`. The root test runner
requires an explicit trusted `CETAMESH_TEST_WORKSPACE_NATIVE` test-host path;
absence is `NOT_RUN_ENVIRONMENT`. A fixture override is not a renderer or model
parameter and does not imply native product or release acceptance.

## Projections, compatibility and maintenance

UI status is derived from real recovery/Git state; timestamps identify whether
they mean opening or registration. Task lists use bounded server pagination with
total/next offset; rendered pagination alone is insufficient. Project version
previews are bounded and disclose total/truncation rather than calling 100 rows
the total. Managed task directories stay available to their Task and advanced Git
view, without filling the normal project list.

Keep persisted schema version 1 and prior field meaning. New optional projections
do not grant authority. Future persistent/wire changes need the compatibility
review described in `docs/protocol/CP-000-GOVERNANCE.md`; the proposed protocols
do not silently replace current storage. Recovery diagnostics should expose
bounded codes and identities, not private file bodies, credentials or raw prompts.

Contract regressions run through root `npm test`: `test-workspace-governance`,
`test-workspace-staging-governance`, `test-managed-worktree-boundary`,
`test-workspace-projections`, `test-workspace-scale`, existing Workspace/Git/Task,
Capability and Continuity suites. The scale suite uses real native Git and
generated contents; it is distinct from real model/Agent and native UI acceptance.

Product references: [VS Code folders](https://code.visualstudio.com/docs/editing/workspaces/workspaces),
[GitHub Desktop Changes and History](https://docs.github.com/en/desktop/overview/creating-your-first-repository-using-github-desktop),
[Codex worktrees](https://developers.openai.com/codex/app/worktrees/),
[JetBrains worktree management](https://www.jetbrains.com/help/idea/use-git-worktrees.html).
These inform interaction and ownership; they do not authorize copying cleanup or
permission policy into CetaMesh.
