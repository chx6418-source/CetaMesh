# Exact Git index actions

## Paged read consumers

Git Workspace reads status, anchored history and local branches through the
existing cursor APIs. It does not use the legacy eager-hashing overview. The
Owner-only context projection retains bounded Task/Worktree associations without
reading working file contents. Status pages contain metadata eligibility hints,
never content hashes or approval authority. Git still scans bounded native
metadata before slicing status/branch pages; measured observation timings do not
claim a streaming repository index.

Search and filters cover the displayed server page only. More-page indicators,
commit patch/file omissions and current-file preview truncation remain visible.
Commit detail is historical; original-file preview reads the current worktree,
including untracked text. Refresh and Workspace generations discard late page,
detail and preview responses. Bounded selections are intent, and full-file commit
obtains fresh selected-path `review` evidence before requesting approval. Index
and branch operations retain their existing independent exact review paths.

Agents can request `git.status.page`, `git.history`, `git.branches`,
`git.commit.detail`, `git.preview` and `git.review` only with explicit grants for
those exact IDs. Existing permission categories and Broker Task/Workspace checks
remain authoritative; old/default grants are unchanged. These sequential,
cancellation-aware read descriptors use the same Workspace observation owner.
They do not grant writes or broaden plugin path scopes; Extension use remains
refused until an explicit resource-scope contract is supplied.

Registered observation and production Chromium suites exercise real Git pages,
fresh review, grant denial and late Workspace responses. Installed native,
external Agent and remote-platform acceptance remain separate gates.

## Exact write boundary

The existing Workspace Git product provides `reviewStaged`, `stage`, `unstage`
and `commitStaged` for trusted Core executors. Production mutations must pass
through the existing Capability Broker authorization and approval boundary.
These methods do not provide an approval flag or a second execution service.

The Desktop `workspace.git.index.review` route exposes the current exact review.
`workspace.git.stage`, `workspace.git.unstage` and `workspace.git.commit.staged`
go through the existing Capability Broker, with high-risk, single-call Owner
approval. The ordinary Workspace RPC refuses mutation flags. The trusted
`validateApprovedGit` entry reuses the Git domain's read-only preparation both
before approval and at dispatch; the executor retains its final lock/CAS checks.
No separate index state or approval queue is maintained. Non-Owner Agents need
explicit grants for these new capability IDs; old grants do not expand. Extension
index mutations remain refused until their exact path-scope contract is supported.

Git Workspace offers complete-file or staged-only submission. Staged-only review
binds the index objects, preserving later working edits. The UI obtains a fresh
Core review and awaits the existing approval result; acceptance of a request does
not imply completion. Workspace/message generations reject stale review replies,
and failed requests retain drafts. Registered `test-git-core-actions` and
`test-git-workspace-ui` exercise actual Git, Core approval and Chromium, separately
from native WebView2 or installed-product acceptance.

A review binds exact normalized relative paths, current file SHA-256 or absence,
complete normal-index identity, HEAD SHA and full local HEAD ref, and
`expectedRepositoryIdentity`. A staged commit additionally binds every selected
index mode and object ID. Only regular `100644` and `100755` entries are accepted.
Sensitive paths, links, gitlinks, conflicts and ambiguous metadata are refused.

Stage and unstage take the standard normal-index lock and prepare a private index.
Only the selected index entries change; unrelated staged entries and all working
file bytes remain. Commit creates the tree from the reviewed staged objects,
preserves partial working-file edits, and leaves the normal index byte-for-byte
unchanged. Detached commits require an explicit reviewed local branch first.

Repository ownership includes canonical root, Git directory and common directory,
native linked-worktree reverse pointers, directory identity, marker contents and
bounded common-config identity/hash. Native linked worktrees are supported;
unrelated external metadata is not adopted from matching HEAD or index bytes.
Preexisting custom ref-storage URI layouts are refused without migration or data
changes. Ordinary files and reftable layouts have distinct native regression cases.

The staged-commit ref update requires Git 2.x at least 2.55. This restriction is
checked before taking the index lock or creating objects. The final native
`no-deref` single-ref CAS uses the narrowly validated internal `referenceBackend`
option of the existing Git executor, bound to the reviewed common directory and
plain ref format. `GIT_COMMON_DIR` observations alone do not prove the actual
native refs-backend path. The internal option is not a renderer or tool parameter.

This is a CAS over the exact approved ref, not a transaction over all external
Git processes, HEAD, index and working files. Source facts are checked before and
after the effect. A changed source or unconfirmed result retains an unknown
outcome with the candidate SHA and approved ref. It must be independently checked
before another effect; it must not be replayed as a successful operation.

Cleanup cannot replace an established result. A known success may carry
`cleanupPending` and bounded owned-resource evidence. An existing unknown error
keeps its code, effect status, SHA and ref. Deferred cleanup evidence is not
permission to delete external locks or directories.

## Branch switching and exact completion

`workspace.git.branch.review` / `git.branch.review` returns the target local ref,
target commit, exact changed paths, current raw hashes and modes, index/HEAD and
repository identities, and `canSwitch` with a refusal reason. The corresponding
`branch.switch` action always requires a fresh high-risk once-only approval.
Renderer approval flags, default Agent grants and generic Plugin declarations do
not authorize it. The Git Workspace uses the existing approval operations and
refreshes on a terminal result; accepted/running requests are not completion.

The existing Workspace raw transaction owns native byte publication. Its immutable
owner binds the original Core request, optional Task/operation, consumed approval,
fingerprint and invocation identity before source writes. After a retained file
phase, `finish-prepared` reviews the same native receipt, original preimages,
current postimages and physical repository ownership. It never republishes the
files. Only the exact original index or already prepared target index is eligible;
HEAD still uses native physical-ref CAS after fresh checks.

The same raw manifest holds at most 16 exact invocation records. A continuation
durably appends `started` before any new index/HEAD effect. Workspace writes
`closed` only after awaiting that domain invocation, its actual Git/native child
close events and its final cleanup block. Older closed records never prove a
newer invocation ended. Raw-only incomplete records, legacy unbound records,
mixed/corrupt evidence and any latest unclosed invocation remain
`EXECUTION_UNCONFIRMED` or recovery-required. An exact terminal Git marker also
proves that invocation has no remaining effects. Process IDs, matching HEAD,
timeouts and missing in-memory Sessions do not establish closure. These records
support reconstructed-Core recovery after a proven closed invocation, not arbitrary
abrupt-crash recovery or power-loss durability claims.

The original raw journal remains applied/fenced until Broker has durably retained
the bounded completion result, including Owner requests without a Task. That same
dispatch save reconciles only inactive, exactly bound closed invocations from the
raw chain, retaining historical unknown status and the new completion request.
Unrelated effects, approvals, overlapping registrations and Task/provisioning
ownership continue to block admission. No Task-wide acknowledgement is used.

After durable completion, an opaque Workspace result handle acknowledges the
journal. Only its affirmative terminal transition may retire the derived fence.
Private cleanup failures remain known results with `cleanupPending`; the existing
journal recovery retries only cleanup. Raw journal retirement clears only its own
exact obligation; retained routing-anchor, index-lock and private-index resources
continue to report pending cleanup in the completion result. A failed approval-wrapper save can settle
from its exact durable Broker receipt, without repeating Git or needing an already
retired raw journal. Added manifest fields remain within schema v2; incomplete
records keep the existing old-reader refusal and native request/receipt digests.

A zero-file tree delta creates no native file transaction and leaves the normal
index bytes unchanged. Its existing Broker dispatch row retains the exact
original approval binding and invocation closure instead. Before the first effect,
the dispatch owner also retains a bounded original Git review proof after verifying
consumed approval and exact request/operation fingerprints. The proof contains only
allowlisted Git facts, original dispatch identity and their scope digest, without
reason, model context or approval history. Ordinary approval pruning cannot remove
these recovery facts. Legacy records require the exact consumed approval while it
remains available; missing legacy proof is an explicit refusal. The ordinary UI
approval-operation wrapper uses verified closed dispatch identities before reading
pruned approval history. After completion, the Broker's unique approval-bound
receipt or explicit same-Task/same-Workspace completed successor can reconcile the
old inactive unknown wrapper. Missing, ambiguous, active or unrelated evidence
retains the refusal; inspection never dispatches another operation. Fresh completion
requires that original approved zero-path scope, the same repository and index,
and the original or target physical HEAD. A bounded chain of closed dispatches
supports repeated failures and reconstructed-Core completion; a newer unclosed
intent blocks it. No empty native file set, fabricated receipt or separate Git
store is used. Related logical Task operations retain their original Task scope.

`test-git-branch-core` uses real isolated Core, native byte publication and Git with
controlled failures. `test-git-workspace-ui` exercises production Chromium UI and
the existing approval panel. Neither substitutes for installed WebView2, external
accounts, arbitrary process-crash or release acceptance.

## Explicit dirty-scope checkpoints

The ordinary Git Workspace provides Owner-explicit checkpoint capture, bounded
saved-file preview, and exact restore review. `workspace.git.checkpoint.capture`
writes only a private Workspace-owned StateDir artifact and adds no project-write
approval. Capture is Owner-only. The `list`, `preview`, `review` and `restore`
capabilities are separate exact IDs; old Agent grants do not expand, and Extension
access remains unsupported. Restore always needs once-only approval, including
Owner requests carrying an approval flag.

A checkpoint contains the complete bounded Git dirty-path set, including rename
ends, deletions, untracked files and binary bytes, plus the independent normal
index bytes and saved staged blobs. It is not a project backup: ignored files and
unchanged files are not copied. Capture rejects sensitive paths, reparse points,
conflicts, split indexes, unborn repositories and oversized scopes. Bounds are
100 files, 8000 path characters, 10 MiB per file, 64 MiB of working bytes, 96 MiB
of combined working/staged content, 32 MiB of index and 132 MiB of serialized
artifact. At most 20 artifacts are retained; no existing checkpoint is pruned
automatically. Validation precedes atomic publication, and content-addressed IDs
plus per-payload hashes detect changed artifacts. List/preview do not hash current
project files; previews return at most 64000 bytes and identify binary/truncation.

Saved restore requires the original physical repository, HEAD and local HEAD ref.
The Owner must explicitly return to that branch/commit first; this is not an
automatic cross-branch merge. Review binds the artifact digest and exact current
working hashes/modes, index, HEAD and dirty set. Unrelated later staged content
blocks restoring the old index; unrelated working files are preserved. Head mode
additionally requires the complete current dirty scope to still match capture.
The dirty-switch UI saves first, reviews this cleanup, and then requires a fresh
independent branch review/approval. It never invokes stash or force checkout/reset.

Restore publishes working bytes through the existing native Workspace transaction,
verifies their postimages, replaces the normal index through its owned lock, and
independently observes the final bytes and index. Original native preimages remain
until the existing durable Capability receipt is saved and acknowledged. The same
journal binds the exact `git.checkpoint.restore` invocation; it cannot be adopted
as `git.branch.switch` recovery or vice versa. Interrupted file/index effects retain
the artifact and native journal and block further writes. This batch does not
provide automatic continuation of an unknown checkpoint effect: Owner inspection
of the actual files, index and retained evidence is required. The UI reports that
state without replay or a subsequent automatic branch switch.

`test-git-checkpoints` covers real isolated Core, Git and native byte effects,
including independent staged/working data and an interrupted normal-index phase.
The existing `test-git-workspace-ui` exercises capture, preview and two separate
restore approvals through production Chromium controls. Both require the verified
native test host for byte publication; they do not claim installed-app acceptance.
