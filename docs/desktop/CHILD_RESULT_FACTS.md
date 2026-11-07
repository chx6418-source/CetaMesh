# Child Task result facts

Task Runtime remains the authority for children, Attempts, reports, execution
observations and verification. `projectChildResultFacts(child,{parent})` derives a
bounded read-only view; it never starts, verifies, completes or rewrites a Task.
The caller supplies actual Task snapshots, not renderer summaries or model text.
Parent and Workspace identities must match exactly, and nested parents are not
accepted by this view.

The view separates:

- `report` and `findings`: attributed Agent claims, with the original report
  event/hash and exact retained source references. Claimed commands and changed
  files remain claims even when a completed read event is cited.
- `hostFacts`: current Attempt/Run-bound read receipts, execution observations and
  Task artifact records. A stored artifact record alone is not independent file
  verification. Current read-only children have no verified command/write list.
- `verification`: the saved result and its revision, plus a separate `current`
  observation and reasons. A historical `VERIFIED` value does not become current
  after a Run change, failed observation, lost source, parent change or unknown
  outcome.
- `remaining`: actual blockers and existing follow, review or fresh-child paths.
  These strings are navigation guidance, not execution authority or approval.

Earlier read receipts may not retain a file path. Such rows expose `path:null`
and `pathCoverage:not-retained`; neither report prose nor authorized readScope
fills that evidence gap. Event identities remain intact. Missing, redacted or
over-budget identities are omitted rather than shortened into different IDs.

The helper retains at most twenty rows per collection and uses a bounded
presentation budget. Complete source data stays in the existing Task. Omissions
and partial host coverage are explicit. Context construction accepts a trusted
`task.children` snapshot, places current leaves first and bounds all child views
to six children and 6,000 characters; outer context budgets still apply.

`ChildTaskResults` is a read-only presentation component. Its only optional
callback opens an existing child by ID. It creates no capabilities, scheduler,
ChildResult store, writer concurrency or external Provider support.

The Desktop Task read route derives these facts from the Runtime's current
children and the maintained Work detail page exposes the same component. The
normal parent Chat and Managed context builders read children from Task Runtime;
renderer rows and model text cannot supply the linked child snapshots. The outer
Product Context budget may omit whole child records with an explicit count,
while retaining mandatory parent and permission state.

The registered suite uses local Workspace files, the existing Capability Broker
and actual Task read receipts, including reverse completion order and invalid
bindings. It also covers the actual Desktop read route, parent context and Work
detail React rendering. These checks are distinct from native product interaction,
real external model time overlap, installed product and release acceptance.
