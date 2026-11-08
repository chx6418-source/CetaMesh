# Retained history synopsis contract

The history synopsis is a deterministic extractive projection of existing
Chat or retained Managed history. Chat, Task, Tool Evidence and Continuity retain
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
fields belong to the source owner's atomic writers; they must not overwrite Owner
checkpoint text or certify a completed Task. A missing raw source remains
unavailable; a synopsis cannot manufacture it or authorize replay of an uncertain effect.

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

Managed owns optional version-1 protocol envelopes under its Agent state directory,
using the existing atomic JSON primitive. Each envelope is bounded to 8 MiB and
binds actor, Task, Workspace and Session, the current authorization/configuration
revision, original message fingerprint, turn/run and checkpoint phase. Within a
turn, checkpoints retain the exact append-only ordered body, including in-turn
system feedback. Only the leading contiguous system headers may refresh on a new
turn or approval continuation; header changes invalidate prior synopsis projections. Completed final responses are also
checkpointed. Optional synopsis references retain their exact prefix anchors.
Raw protocol and private continuation never enter public Agent status or events.

A fresh Managed session follows at most the current Task's 100 server-resolved
`agentHistory` attachments backwards to the nearest retained Managed source.
Missing replacement envelopes cannot hide a known earlier source. Current actor,
grants, Workspace and attachment are rechecked. Existing Session stop inspection,
Task recovery intent, Capability review/approval state and tool recovery journals
must affirmatively permit recovery, including after asynchronous stop lookups and
before the new turn's initial model dispatch. Unknown external Sessions and live
effects/approvals still refuse; missing Core-owned Managed Sessions use the existing
Core restart stop proof, without inventing external process termination.

Only a completed adjacent source with settled public protocol restores messages.
An incomplete or native-private source, skipped replacement, or absent legacy
source instead permits Task-only continuation after those execution gates clear.
The new request carries an explicit `retained-history-gap`: omitted originals
remain separate from current Task facts, must not be called recovered, and cannot
authorize replay. Its bounded original fingerprint/provenance and skipped Session
IDs persist in the same optional Managed envelope and propagate to later turns.
The original bytes are unchanged; reconciliation never marks an incomplete source
completed. No private/native/tool execution stack is injected by this gap path.
The existing context warning event reports the gap. Corrupt, oversized or
future-version envelopes remain refusals, not gap fallbacks. Existing Chat/Task/
settings schemas remain unchanged; prior readers ignore the optional Agent files.

A completed legacy envelope with a known structured Core post-write feedback
message promoted into its leading headers has unusable order. After the same
execution recovery gates clear, it takes the Task-only gap path with reason
`legacy-transcript-order` and original provenance. Its bytes and completion phase
remain unchanged; the message cannot prove stop, authorize replay or supply a
guessed original position. Feedback in the ordered body is retained normally.

Approval continuation may use a trusted in-process `restoreMessages` callback
from its exact still-live Managed waiting turn. The coordinator first fences the
consumed approval, then requires the supplied raw messages to reproduce its exact
saved sanitized projection before resuming any tool or model work. This callback
has no RPC/tool schema and never loads a cold execution stack. Mismatch, lost live
ownership and consumed cold continuations cannot replay the accepted effect.
