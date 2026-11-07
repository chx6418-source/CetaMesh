# Agent configuration and activity contract

Task owns its execution assignment and requested configuration. The Provider owns its
live Session and confirmed native configuration. Chat exposes bounded read-only projections
and submits commands through the existing Agent Broker and Continuity runtime. Model Runtime
catalogs describe managed model execution; they are not catalogs for external Agent CLIs.

## Provider configuration

`modelControl` exposes `status`, `source`, `application`, `selection`, and model/reasoning
options as bounded value/label pairs. `available` plus `runtime-confirmed` means that the
Provider observed a matching native acknowledgement. `unknown` preserves the last confirmed
selection without implying that it is still effective. `unsupported` does not invent options.
Codex exec's `next-turn` projection separates `requested` and actual `cli-argv` submission
evidence from `selection`; submitting arguments is not native model acknowledgement.

ACP controls are limited to verified provider option IDs in `model` and `thought_level`
categories. Complete acknowledgements must match every requested field, including fields
that a later option change could reset. A failed or ambiguous mutation fences new prompts
until a safe fresh Session is established. Runtime changes, concurrent prompts and native
permission selectors cannot be accepted as ordinary model changes. Qwen's lack of an
advertised reasoning control stays visible as unsupported.

DSH uses its own catalog, selected-provider identity and selection response. Explicit
model-unavailable refusals preserve the prior binding; missing or ambiguous acknowledgements
retain the last known selection and block prompts. No shared default reasoning level is
injected. Claude's pinned bridge currently accepts its Owner-configured model and refuses
unverified Task overrides or reasoning settings before launching a process.

The ACP configuration method is enabled only for the verified native profiles
(OpenCode 2.1.4 and Qwen Code 0.26.1), matching `agentInfo` identity/version and the
configured runtime version where supplied. An option advertisement on an unknown
version does not establish method support. The native option IDs/categories remain
allowlisted; permission and mode controls do not become model controls.

Codex App Server model control has a separate protocol profile for
`0.167.0-alpha.3.2`. That profile does not grant execution eligibility: verified
runtime identity and all existing native policy/approval gates are still required.
The older `0.163.0-alpha.11.1` execution adapter has no verified model-control
profile and rejects explicit overrides before launch. Codex exec is unchanged and
continues to distinguish next-turn requests and argv submission from native ACKs.

The App Server profile reads its own bounded `model/list` advertisements, retaining
wire model values rather than catalog record IDs. Each model option may carry
`reasoningOptions` and an advertised `defaultReasoningEffort`; a missing default is
not filled from the current model or a shared enumeration. A default must belong
to the same model's advertised options. Current selection still comes only from a
matching complete native receipt, not from these suggested defaults.
The catalog is bounded by page/entry/option counts. The complete serialized
`modelControl` envelope, including selection and current reasoning options, has a
128 KiB UTF-8 budget. An oversized projection is refused as
`CODEX_MODEL_CATALOG_INVALID` before publishing its native Session; the unused
target is closed and the existing source is retained. Identities, native ACKs,
allowed options and defaults are never truncated or silently omitted.

Initial configuration is sent with `thread/start` and checked against its complete
model/provider/reasoning and native-policy receipt. This version has no resumable
rollout before its first turn, and resuming an already loaded thread does not prove
that model-setting overrides applied. Model/reasoning changes therefore return
`AGENT_CONFIGURATION_REQUIRES_NEW_SESSION`; the existing Continuity handoff creates
and confirms the configured target before stopping the source. `thread/resume`
only confirms restoration of the original tuple. Missing/mismatched restore ACKs
retain the last known tuple, mark it unknown and fence further prompts. Outgoing
`turn/start` carries the acknowledged model/effort, but turn acceptance alone is not
proof of the remote inference model or entitlement.

Claude's configured model is exposed as a `requested` value with
`application: requires-new-session` and `selection: null`. SDK initialization and
model configuration are not native model acknowledgement. No reasoning choices are
invented when the pinned bridge has not advertised model-specific native choices
and confirmed their application.

The protocol shapes are described in the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server),
[ACP configuration contract](https://agentclientprotocol.com/protocol/v1/session-config-options)
and [Claude Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript).
Current general documentation does not override a pinned runtime's verified behavior.

For a Task-bound Chat, a configuration change reuses the existing same-provider Continuity
handoff. The target's required acknowledgement must be verified before stopping the source.
Busy or unknown execution cannot be switched. Existing non-Git review requirements continue
to apply; a model picker does not grant recovery or file-import authority.

## Durable observations

The existing Chat history JSON holds finalized messages and one bounded `activeTurn`
checkpoint. Public structured activity is checkpointed before publication. Finalization
atomically appends the stable assistant message and removes the matching active checkpoint.
Loading an interrupted checkpoint preserves completed tool receipts and marks unfinished
activity unknown; it does not resume execution or certify success.

Each public timeline has stable local identity/order, timestamps, source, provider/Task/run
association and a bounded sequence of events. Tools are summarized separately with explicit
omission counts. The timeline keeps at most 128 entries; tool summaries keep at most 32.
History pagination uses the existing Chat API. Source cursor gaps and retention truncation
are explicit. ACP outer-envelope sequence/time fields survive normalization. Duplicate or
late events cannot replace newer runs or regress completed receipts.

Only public plans, stages, approvals, tool status/duration and bounded summaries are retained.
Raw credentials, arbitrary protocol metadata, raw tool output and private reasoning are not
timeline fields. A status message such as thinking is not an official reasoning summary.
The UI keeps its final activity snapshot until the matching persisted message arrives and
accepts terminal snapshots even when their text is shorter than a streaming snapshot.

### Public streaming and approval operations

Core coalesces public text deltas from provider events within a 50 ms window. Direct
coordinator text callbacks remain immediately published. A lifecycle-owned timer flushes a
quiet provider tail without waiting for the next chunk, and accepted text is flushed before
tool activity, approval waits and terminal notifications. Timer callbacks bind the exact
runtime state, turn object and request; disposal or replacement cannot publish into a later
turn. This is a Core transport bound, not a measured native frame-rate guarantee.

Managed tool cycles retain earlier public segments under the same stable message identity.
A nonempty final answer replaces its own cycle's streamed segment; an empty partial result
preserves already observed prose and its failure/unknown status. Core-generated approval
notices use status fields. The `statusOnly` marker is honored only for the trusted Managed
provider; external provider reset/replacement semantics and private reasoning filters remain.
Active checkpoints preserve bounded public text at the existing activity/lifecycle points;
this does not provide per-token crash durability.

The Owner approval inbox is global and decisions are keyed by exact `approvalId`. Chat
disables only the submitted decision, preserves transport failure and same-decision retry,
and reconciles existing `approval.operation` records. An accepted decision is not completed
execution. Async failure/unknown results remain visible after refresh; changing Chat selection
does not lose the global approval result or refresh another Chat's history. Retrying a failed
submission uses the same approval identity and never replays a completed or unknown effect.

## Usage and request observations

The existing Model Usage Ledger owns request receipts, attribution, deduplication and costs.
Missing metrics remain `null`; an explicit zero remains zero. `knownUsage` exposes reported
subtotals without replacing an unknown full total. `cacheCoverage` counts read/write reporting
separately and pairs cache counts only with reported input denominators. Its partial rate is
unknown when any contributing receipt is invalid. The Desktop projection preserves that
unknown result instead of recomputing a seemingly valid ratio from sums.

For supported adapters, `requestDiagnostics` hashes the actual serialized outgoing body and
provider/endpoint/protocol/model/components. It retains at most 64 optional observations in
the existing ledger, with omitted and unreported counts; token accounting still includes
all receipts. A missing latest observation remains missing. Historical turn aggregates and
synthetic snapshot scopes cannot establish request-level coverage and leave these observations
unknown. Existing raw ledger row-count fields keep their compatibility semantics;
the Desktop DTO sets the displayed request count to unknown for scopes containing
synthetic snapshot records, including persisted continuations. Token totals remain intact.

Local change codes distinguish provider, endpoint, model, tools, system, history and request
parameters. They do not establish provider cache support, eviction, a cold request, savings
or performance. Authorization headers and credential-store fields are excluded from these
observations; request bodies and routes appear only as opaque digests. Header-only credential
rotation cannot be inferred from otherwise identical routing and body observations. Public
DTOs retain only allowlisted hashes/counts/change codes; prompts, raw requests, URLs, private
reasoning, credentials and internal receipt identifiers are excluded. UI details label
reported coverage and known partial totals explicitly.

## Current code evidence queries

The existing Core `task.outcome.verify` command accepts optional boolean
`requireCurrentCodeEvidence`. For code queries, strict mode requires a settled current
provider/Session/Run/user phase and an actual `core-test` result digest; a generic display or
native self-report cannot replace it. Conflicting later results or writes refuse verification.
Task revision is rechecked after asynchronous Workspace resolution. Default historical/manual
queries retain their prior meaning.

This strict query is necessary evidence, not semantic completion or a new permission grant.
File content, immutable verifier, change scope and Owner acceptance remain independent checks.
A failed test's result returns through the existing model coordinator. Repair and retest use
fresh, separately authorized operations; completed or unknown tests are not replayed. No
automatic arbitrary post-write shell command or LSP process is introduced by this contract.

## Execution and cancellation

Workspace ownership remains a Task-domain decision. New-launch readiness cannot erase an
existing Session's cleanup obligation. External cancellation needs its exact close result;
Codex uses its existing owned-process receipt. Task/run/Workspace identity is checked again
synchronously immediately before the revision-checked cancellation mutation. A replacement
Session cannot be cancelled using an older receipt. The shared Core recovery
coordinator automatically retires stopped executions after verifying settled
receipts and Workspace contents. Task details, normal resume and Chat continuation
use this proof without requiring a human recovery form. Unknown tool effects remain
blocked; none of these projections supplies replay authority. See
[Workspace recovery](WORKSPACE.md#automatic-recovery-after-a-lost-agent-session).

Tests distinguish controlled protocol fixtures, installed CLIs with synthetic model servers,
authorized remote models, actual Core services, rendered browser UI and native Desktop
acceptance. Success at one layer never satisfies a missing layer's release gate.

## Selecting a complete native model configuration

When a Provider advertises model-specific reasoning options, the Picker keeps a
draft model and its own advertised choices. It submits the complete pair once
through the existing Chat configuration transaction. A default belongs only to
that model; absent defaults require an explicit choice. The current-model display
continues to depend on the runtime ACK, including while saving or after refusal.

Task-bound changes that require a new Session use existing Continuity. Explicit
no-reasoning is distinct from an omitted setting: a null request cannot inherit
the source effort, and its target must acknowledge null before the source is
stopped. Known invalid storage identities refuse before checkpoint or Agent
effects. An invalid target default is discarded before stopping the source.
Taskless fresh-session replacement is not provided by this control path.

Task retains exact native model/reasoning identities up to 256 characters;
ordinary Task limits remain unchanged. These are bounded stored identifiers, not
an allowed-model catalog or execution grant. Saved Chat request metadata keeps
its complete bounded identity during restart while the live model may be unknown.
It does not create a second persisted Provider binding. A native no-op still
checks current Task ownership, state, actual ACK and advertised writable options.

The complete native control and its display projection share the 128 KiB UTF-8
budget. Missing optional selector IDs do not become synthetic null metadata that
would make a valid native catalog disappear. Real selector IDs remain intact;
over-budget or malformed advertisements never become silently partial choices.
