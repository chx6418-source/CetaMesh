# M2 Local Memory — implemented architecture

Roadmap sections 9/18/30 are authoritative. UI → Runtime → domain repository →
SQLite; production wiring is in assembleServices. M1 history/provider behavior
is preserved. M2 introduces no native module, permission or npm dependency.

Schema v2 adds memories with five kinds (working/chat/user/task/local), scope,
content, source, importance/confidence, pin, local revision and timestamps.
Scope is constrained to local-only in both validation and SQLite. Migration is
additive and idempotent through the existing migration engine. Sources have
manual/chat/task discriminants; chat provenance retains session/message IDs
without a cascading FK, so it survives deletion of the source conversation.

SqliteMemoryRepository uses the shared serialized connection. Updates, pin,
delete and candidate deduplication use transactions. Each mutation checks the
observed revision; stale changes fail with sync_conflict. Automatic updates or
deletion of a pinned record fail; explicit user edits/deletion remain available.
Candidate saves create or return an exact content/source match, never overwrite.
Candidate commits require transient source evidence. The SQLite transaction
rechecks the source chat/message, role/status and original text before deduplication/
insertion, closing deletion/change races. Original evidence is never persisted
as a separate Memory field; already saved memories survive later source deletion.

Search is a parameterized literal substring query, including CJK/accented/Cyrillic/Greek text. ASCII letters
are case insensitive; SQLite lower is not a general Unicode case-folding engine.
Kind, pin and chat source are filterable. Simple ranking uses pin, keyword prefix
match, importance, recency and stable IDs; no vector or graph system. Pagination
is bounded and UI requests are guarded/deduplicated, with obsolete responses ignored.

MemoryRuntime applies MemoryPolicy and emits only event/type/memory/trace IDs
and timestamps. UI drafts are independent; runtime refresh does not reset an
editor. Pin changes retain unsaved text. The user can browse/edit/delete without
a configured model or network.

ChatMemoryExtraction is an offline opt-in extractor. Preview examines the latest
200 messages and proposes at most 10 recent explicit user “记住/请记住/Remember”
requests, each no longer than 4000 characters. Assistant text and file content
are excluded. Preview and rejection do not write long-term memory. Candidate
IDs are ephemeral and source text is rechecked before each one-use confirmation.
The user may edit a candidate; duplicates do not overwrite pinned records.

MemoryScreen offers Recent, five kind filters, search, creation, editing,
pin/unpin, source details and confirmed deletion. A chat source can be opened;
deleted sources show a typed error while the memory/provenance remains intact.
ChatMemoryReview preserves the chat composer while previews are inspected.

Memory is not automatically injected into model requests, uploaded, extracted
in the background or synchronized. These choices keep M2 local-only. M3,
Identity, Pairing, Memory Graph and Vector DB remain unimplemented.
