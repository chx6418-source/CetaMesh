# Exact Git index actions

The existing Workspace Git product provides `reviewStaged`, `stage`, `unstage`
and `commitStaged` for trusted Core executors. Production mutations must pass
through the existing Capability Broker authorization and approval boundary.
These methods do not provide an approval flag or a second execution service.

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
