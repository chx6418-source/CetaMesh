# Retained history synopsis contract

The history synopsis is a deterministic extractive projection of existing
Chat or live Managed history. Chat, Task, Tool Evidence and Continuity retain
their current ownership. It is not a second history database, a model-generated
decision or evidence that an operation completed.

`buildContextSynopsis` binds actual message content and protocol representation,
the server-resolved actor/Session/Task/Workspace tuple, and exact linked Task
facts. A supplied Task must match a non-null Task binding. The whole derivative,
including source references and hashes, is at most 8,000 characters. Goal,
requirements and checkpoint instructions are not silently rewritten to fit.
Optional older facts may be omitted whole with explicit counts.

`projectHistoryLayers` may replace only old closed non-native conversation
spans. It retains four recent complete turns, the current Owner instruction,
open or uncertain tool groups, missing results and private/native continuation
representations verbatim. Production `outcome-unknown` and explicit unknown
effects remain protected. The original messages are not modified. An irreducible
current instruction or protocol group retains the existing budget refusal.

Every omitted span has an exact content hash and source ID. `readHistorySource`
accepts only that bound range and checks current authorization before resolving
the original history. It does not accept a path or arbitrary Session selector.
Its source-message-count anchor permits later append-only tool calls while
rejecting changes to the original prefix or binding. Pages are bounded and keep
surrogate pairs intact. Native or unsettled spans cannot become synopsis sources.

The optional `synopsis:true` message-budget layer runs only when the existing
evidence/dedup projection still exceeds the byte limit. A retained-source resolver
must first confirm that the omitted originals remain available. Reuse of a
derivative after history, Task facts or binding change is refused. Recent retained
tool bodies remain exact, so request-relative duplicate references cannot point
to an omitted source.

Caller integration must separately recalculate the complete outgoing request,
including actual tools, provider framing and output reserve. Persisted synopsis
fields belong to existing atomic Chat/Task writers; they must not overwrite Owner
checkpoint text or certify a completed Task. Raw Managed history unavailable after
process loss remains unavailable; a synopsis cannot manufacture it or authorize
replay of an uncertain effect.
