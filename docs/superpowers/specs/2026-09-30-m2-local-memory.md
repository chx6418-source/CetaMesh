# M2 Local Memory design

Authority: CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md sections 9, 18, 23, 30.
The user explicitly requested completion of M2 after M1 implementation. Native
M0/M1 verification remains blocked; this authorizes M2 code, not a native PASS.
The existing architecture and continuous execution instruction govern this work.

SQLite schema v2 adds memories without changing existing chat rows. Kinds are
working/chat/user/task/local. Every record has local-only scope, content, source,
importance/confidence (0–1), timestamps, pin and local revision. Source metadata
is retained even if a chat is deleted. No device/identity/sync schema is added.

MemoryRepository implements CRUD, literal keyword/metadata search and simple
ranking (pin, keyword match, importance, recency). Runtime validates input,
publishes metadata-only events and rejects stale edits. Automatic mutation of
pinned records is denied atomically by the repository; explicit user edits and
confirmed deletion are allowed. Scope cannot be widened in M2.

Chat extraction is offline and opt-in. A user opens a preview that examines
completed user text with an explicit “记住/请记住/remember” prefix. It proposes
bounded, source-linked chat memories, omitting credential-like content.
Assistant text and files are excluded. Candidates stay ephemeral until the
user confirms each one; save verifies provenance again, rejects replay and
duplicates, and never changes an existing/pinned memory. No API call, memory
retrieval into prompts, or background extraction is introduced.

Memory UI offers Recent, all five kinds, literal search, create/detail/edit,
pin/unpin, confirmed delete and source. Chat UI opens candidate preview and
supports confirm/reject. Drafts are UI-owned; runtime and SQLite remain separate.
No new dependencies, native permissions, global store, Vector DB or M3 feature.

Verification: real SQLite upgrade/reopen/isolation; hostile queries; revision and
pin races; extraction provenance, refusal/replay/duplicates; UI confirmations,
edits and deletion; TypeScript/lint/architecture/full tests; both Metro bundles.
Native launch/SQLite integration remains NOT_RUN_ENVIRONMENT without tools.
