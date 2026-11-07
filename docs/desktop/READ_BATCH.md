# Bounded Workspace read programs

`context.batch` combines dependent repository exploration inside the existing
Model tool coordinator. It uses Capability Broker and Workspace Service for
every source read or search; it is not a JavaScript interpreter or another
Agent, Task, permission or execution runtime.

The only sources are `filesystem.read` and `filesystem.search`. A Task needs
the composite grant and each actual source grant. New ordinary parent Tasks
may receive these defaults. Existing stored grants are retained, and read-only
child contracts still permit only their explicitly scoped source capabilities.
Selecting reference content never supplies a grant.

## Program shape

A program contains `version: 1`, an ordered `steps` array, and
`output: {from, fields?}`. Step IDs are unique. A dependency can refer only to
an earlier step. Supported steps are:

| Operation | Purpose |
| --- | --- |
| `search` | Obtain scoped paths and snippets from Workspace search. |
| `read` | Read one literal relative path. |
| `readEach` | Read a bounded list of paths from a preceding result. |
| `lines` | Split bounded text or parse JSONL, reporting invalid rows. |
| `filter` | Compare a selected field using equality, containment or prefix. |
| `select` | Return an explicit list of fields. |
| `unique` | Remove duplicate selected field values. |
| `sort` | Order rows by one field. |
| `aggregate` | Count rows, optionally grouped by one field. |

Arbitrary code, regular-expression execution, loops, prototype properties,
network, commands and writes are outside this grammar. The entire program is
validated before a source is admitted. Paths returned by an earlier search
are data: each later read still needs current source authorization.

## Limits and evidence

Programs have at most eight steps and eight items in a fan-out. The turn's
existing 24-call budget is shared with ordinary calls and actual batch sources.
One composite read is limited to 50,000 bytes, and its shared source I/O budget
is 512 KiB. Search content reads and header reads consume this budget before
actual I/O. Transformations have a 2,000-row budget, parsed lines are bounded
at 8,000 characters, the plan at 32,000 characters and the final projection at
12,000 characters. Truncation and omitted or invalid rows are reported.

The coordinator admits at most two reviewed Core Workspace reads at a time,
including its approved continuations. Source descriptors must declare both
`readOnly` and `parallelSafe`; this is restricted to the audited Core sources.
Extension, MCP, native, Git and model-supplied declarations do not opt in.
An effect or approval is a serial barrier. Promise rejection does not release
a read slot before its underlying cooperative I/O has settled.

Every source retains its original Task, Workspace, Session, Run and request
identity, plus the batch step and item attribution. Existing tool evidence
holds source results; ordinary model history receives the selected projection
and source references. A summary or aggregate is not execution evidence for
an operation that never ran.

## Approval, cancellation and recovery

Unexpected source approvals use the existing approval store and continuation
receipt. Settled siblings are retained and delivered in original order. Any
unneeded pending sibling is precisely cancelled; an unconfirmed cancellation
retains recovery state. Approval decisions re-enter the same read admission
and byte budget. They do not inherit authority from a previous result.

All accepted reads are drained before cancellation settles or another barrier
starts. An unknown source takes precedence over a known failure when deciding
whether the program may continue: no following writer or model request starts
through that boundary. Started or interrupted quota leases remain fenced after
restart. Recovery preserves completed receipts and never repeats unknown
tools. A pure model continuation can retry only when no later tool was admitted;
its already delivered source events and results are retained.

Workspace's existing path and live authorization checks remain authoritative.
These Node filesystem checks do not claim an operating-system sandbox or
kernel-level containment against an adversarial host changing links between
checks. The native execution and unknown-side-effect boundaries are unchanged.
