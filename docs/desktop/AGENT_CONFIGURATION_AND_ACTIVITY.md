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

## Execution and cancellation

Workspace ownership remains a Task-domain decision. New-launch readiness cannot erase an
existing Session's cleanup obligation. External cancellation needs its exact close result;
Codex uses its existing owned-process receipt. Task/run/Workspace identity is checked again
synchronously immediately before the revision-checked cancellation mutation. A replacement
Session cannot be cancelled using an older receipt. Unknown tool effects still require the
existing Owner review flow; none of these projections supplies replay authority.

Tests distinguish controlled protocol fixtures, installed CLIs with synthetic model servers,
authorized remote models, actual Core services, rendered browser UI and native Desktop
acceptance. Success at one layer never satisfies a missing layer's release gate.
