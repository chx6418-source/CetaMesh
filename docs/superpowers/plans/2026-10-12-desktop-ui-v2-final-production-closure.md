# CetaMesh Desktop UX v2 Final Production Closure Plan Set

This index splits the approved closure design into independently reviewable implementation plans, as the design spans separate runtimes and product surfaces. Implement the subsystem plans in order where they touch shared files; finish with the manual acceptance and release plan.

**Approved design:** `docs/superpowers/specs/2026-10-12-desktop-ui-v2-final-production-closure-design.md`

## Subsystem plans

1. [Chat, Provider, Tool Calling, and Approval](2026-10-12-desktop-chat-runtime-closure.md) — local Provider fixture, real Chat service lifecycle, Capability Broker execution, approval continuation.
2. [Agent Directory Readiness](2026-10-12-desktop-agent-readiness.md) — actual DSH/Codex/ZCode installation and readiness state through registry, projection, and Harbor.
3. [MCP, Plugin, Extension, and Bionic Inventory](2026-10-12-desktop-integrations-closure.md) — local MCP process, local catalog/package lifecycle, schema-driven Extension settings, truthful Bionic statuses.
4. [Safe Artifact Opening](2026-10-12-desktop-artifact-open-boundary.md) — identity-based open request, Core path authorization, native allowlisted file opening.
5. [Provider Settings and Feedback Links](2026-10-12-desktop-settings-and-feedback.md) — provider-declared advanced fields and centralized feedback links; no invented official destination.
6. [Long Chat History](2026-10-12-desktop-chat-history-pagination.md) — stable bounded paging, existing virtualization, and scroll anchoring.
7. [Manual Acceptance and Final RC](2026-10-12-desktop-acceptance-and-release.md) — visual/accessibility/window/upgrade evidence and final clean-source candidate.

## Dependency and execution notes

- Plans 1–6 produce local testable behavior and can be reviewed independently. The final plan depends on their merged-in-branch commits and reports.
- Keep each change on `feature/desktop-ui-v2-production`. Do not push, publish Stable, merge, or delete the branch/worktree before Owner confirmation.
- Execution method: Owner selected Native sequential execution. The Harbor UI and typed bridge files recur across plans, so one implementer works sequentially in this worktree with review checkpoints after each subsystem.
- Real Provider credential acceptance is `NOT_RUN_ENVIRONMENT` if credentials are absent. Feedback stays `BLOCKED` until an Owner-verified official destination exists.
- Do not treat the existing build-1057 as the final RC; the final candidate must identify the final committed source and report `dirty=false`.
