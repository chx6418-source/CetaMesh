# Git Workflow

This repository uses short-lived topic branches. Each implementation task starts from the latest verified `main` and stays isolated until review is complete.

## Standard flow

1. **Branch** — inspect `git status` and the current commit first. Preserve pre-existing user changes. Update from the intended `main` base, then create a `codex/<short-task-name>` branch (or use a branch name explicitly chosen for the task). Do not create a branch from a stale remote-tracking ref when the local `main` already contains unpushed handoff commits.
2. **Commit** — commit a coherent implementation slice with a scoped message. Keep generated build output and local runtime data out of commits unless the task explicitly requires them.
3. **Tests** — run the repository aggregate `npm test`, plus the relevant desktop and release checks required by the change. Record environment-limited checks honestly.
4. **Merge** — review the diff and confirm the worktree is clean. Merge into `main` only after the Owner approves the concrete result. Do not push unless explicitly requested.
5. **Verify** — run the required checks against the merged `main`; inspect `git status` and verify the merge commit contains the approved changes.
6. **Delete branch** — after merge verification succeeds, delete the local topic branch. If a remote branch was explicitly published, remove it only when that publication was authorized and the merge is verified.

## Handoff and recovery

Use commits, the task handoff document, and a clean branch boundary to pass work between sessions. `git reset` and `git reflog` are recovery tools for exceptional repair; they are not normal handoff or cleanup steps. Never reset, rewrite, or delete user refs or uncommitted work as a routine workflow.
