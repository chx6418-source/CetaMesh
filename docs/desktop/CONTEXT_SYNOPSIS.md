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

The coordinator accepts two trusted constructor callbacks. Neither callback nor
any authorization flag comes from model JSON. `resolveHistoryContext` resolves
the current actor/Session/Turn/Run/Task/Workspace source and its stable identity
revision; normal append/checkpoint writes must not manufacture a new authority
revision. `onMessagesCheckpoint` delegates to the existing owner's atomic writer
at `settled-transcript`, `request-projection` and pre-dispatch `tool-calls` phases.
Checkpoint failure retains completed journal receipts and fences dispatch rather
than replaying an accepted tool operation.

`coordinator.readHistory` accepts only the unchanged request in a currently
admitted Core Broker frame. It rechecks actor, binding, revision, original prefix
and readable projection before and after retrieval. A copied origin or alternate
Task/Session cannot construct that frame. Core pages are limited to 4,000
characters to fit the existing tool-result envelope. Pages expose public message
text and real tool-call associations, exclude raw tool arguments and unknown
private metadata, and clean tool bodies with the existing evidence policy.
`publicSha256` and projected lengths describe that readable page separately from
the original range/prefix hashes; native/private spans remain unavailable.

History projection also runs when the complete model token window, rather than
the byte guard alone, is exceeded. The final no-tool synthesis retains the same
authorized projection after tool allowance is exhausted. Its request-only system
instruction is appended independently and included in the complete budget; it
does not become an invented retained-source or checkpoint message. Tool limits,
permission checks and unknown-effect protection are unchanged.

Ordinary Core Chat wires its actual existing history owner and atomic writer
through these interfaces. The current-turn envelope retains only the Owner
content or attachment references, headers, protocol tail, source fingerprints
and optional synopsis; previous history is reconstructed from its existing rows,
not duplicated into each checkpoint. Final, failed and interrupted writers retain
the private protocol and mark unavailable sources explicitly. Public Chat history,
status and events exclude private protocol bodies and continuation metadata.

The owner getter may return messages directly or a Promise. Each invocation
rechecks the actual current Owner/Chat/Turn/Task/Workspace/configuration/catalog
identity and compares its original authorization revision. Catalog metadata may
be asynchronous; the current Core Task snapshot is read synchronously after that
wait. An asynchronous replacement Task resolver without a current snapshot
contract is unavailable for this optional source feature. The coordinator awaits
each acquisition and supplies its result only to that invocation's pure budget
or page helper. It does not cache source authority, persist a second transcript
or turn an unavailable optional projection into short-request admission.

`context.history.read` is a low-risk read-only Core descriptor under the existing
context permission. Its one-time source reader binding cannot be replaced. Normal
parent Task grants include it; read-only child grants retain their original two
file tools. Exact admitted Broker frames remain required even for the Owner.

Managed retained raw-source persistence and other Task/Continuity synopsis
consumers require their own existing owner integration before advertising this
retrieval. Cold private sources remain unavailable; loading Chat history never
replays a model request, tool operation or uncertain interrupted result.
