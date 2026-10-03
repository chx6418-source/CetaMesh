# M2 Memory Security

All M2 storage is local SQLite; scope defaults to and is restricted to local-only.
There is no Memory network adapter, prompt injection path or upload/sync setting.
No new permission, native module, dynamic code or dependency is introduced.

Only explicit user interaction can persist a chat candidate. Preview is
ephemeral, sourced from completed user text with an explicit remember request.
Assistant assertions and attachments are never treated as a trusted memory source.
The runtime binds IDs to internally issued candidates, rechecks source text,
rejects replay/rejection and serializes duplicate saves. Preview mutation cannot
forge persisted provenance. Existing memories are never updated by extraction.
Repository commit requires transient source evidence and validates chat/message
existence and unchanged content inside the same insertion transaction.

Pin and optimistic-revision checks run in the same repository transaction as
automatic updates/deletion. Explicit user corrections and confirmed deletion
are possible even for pinned records. Stale edits cannot silently overwrite.
Sources retain IDs rather than entire raw conversations.

MemoryPolicy blocks common labelled credentials (including English “API key is”
and “password is”), known API token prefixes,
private-key headers and JWT-like text. This is conservative pattern detection,
not a guarantee that arbitrary unlabelled secrets can be recognized. Users should
not place credentials in Memory; system credentials continue to use Secure Storage.
SQLite memory/chat content is not encrypted by this implementation.

Content, metadata, source identifiers, query size and page ranges are bounded.
Queries are parameterized; %, \_, quotes and SQL syntax are literal content.
Errors use CetaError with safe static messages. Runtime events contain IDs and
types only, never content/candidates/source text, and no Memory body is logged.
Native backup/lifecycle/SQLite integration remain device acceptance checks.
