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

## Owner recovery after a lost Agent session

An unavailable transport or `SESSION_NOT_FOUND` from an external Provider is not
evidence that its process stopped. Keep the old Task binding, execution evidence
and Workspace ownership until independently verified. For Core-owned Codex
execution, the lifecycle record binds Task, Workspace, Session, staging snapshot
and execution generation. Its Windows supervisor issues a stop receipt only when
the owned Job has no active processes. A root-process exit, missing PID or Owner
description cannot substitute for that receipt. Historical sessions without
trustworthy receipts remain unresolved; recovery does not invent missing proof.

`ui.task.recovery.inspect` is read-only. It reports the blocking Task, Agent,
status, ownership reason, unresolved operations and available actions. Its
short-lived review token binds the current Task revision, session proof,
Workspace contents and exact operation set. A non-Git Workspace uses an
exhaustive bounded proof of the filtered staging scope, including file bytes,
paths, sizes and modes. This path does not initialize Git. Incomplete scans,
links, changed roots or concurrent changes cannot certify recovery.

The Owner submits the current token and review through `ui.task.reconcile`.
Active execution, unknown stop state, active tools, pending approvals, children
or an unresolved Handoff still prevent retirement. Commit rechecks the recorded
bindings, writes a recovery intent before acknowledging journals, and then
records the review and retires the old binding. A partial write retains a fence;
it cannot free the Workspace or silently mark an unknown effect successful.

The Owner can either release ownership without dispatch or continue the same
Task with a fresh Session, explicit new instruction and new request identity.
Prior requests remain non-replayable. Checkpoints, Memory references, reports and
execution evidence remain available. The compatibility resume entry point also
requires new instruction/request identity after this retirement. Recovery intent
and review records remain bound to their original Workspace; changing the Task's
Workspace cannot detach that evidence from its scope.

A separate durable dispatch fence covers the interval before Task attachment,
including attachment or blocked-state persistence failure. `blocked` alone never
releases it. Workspace-busy feedback links to the actual owner; pre-dispatch Chat
failures do not create Agent output or imply tool completion. The UI requires a
current inspection before enabling recovery and prevents duplicate submissions.

Registered regressions include `test-owner-session-recovery`,
`test-agent-workspace-fence`, `test-workspace-recovery-proof`,
`test-codex-session-lifecycle`, `test-codex-owned-supervisor` and
`test-chat-failure-feedback-ui`. Controlled fault tests, rendered component tests
and actual native/model acceptance are separate evidence.

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
