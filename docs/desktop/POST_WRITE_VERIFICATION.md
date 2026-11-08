# Configured post-write verification

The existing Workspace settings owner accepts an optional
`postWriteVerification` configuration. It is disabled when absent. Saving the
configuration observes and validates it; saving never executes a project script
or grants `test.run`.

Work → Workspace exposes this configuration through the selected project's
verification controls. Owner saves carry the observed configuration digest and
reject a stale edit. Workspace Registry remains the configuration owner.

The full configuration is `{enabled,tool,args,includeExtensions,timeoutMs,
maxRunsPerTurn}`. `tool` is `npm` or `cargo` and its arguments pass the existing
isolated test runner validator. Extension names start with a dot; at most twenty
are retained. The timeout is 1,000–600,000 ms and at most two automatic checks may
be requested per turn. Zero disables those requests. Core does not discover or
execute arbitrary commands from repository instructions.

After a matching `filesystem.write` has actually completed, the existing model
coordinator waits for the current tool group to settle. It then requests the
configured `test.run` as a separate operation. The existing Capability Broker
checks the current Task, Session, Run, Workspace and grant and obtains a fresh
approval. The call consumes the same turn budget. An adjacent matching explicit
check can satisfy the request; a transport error or unknown effect is never
silently replayed.

Settled `workspace.apply` imports enter the same planner. Managed tool imports
use their existing barrier. Native staged adapters request a separate high-risk
test approval after the import's durable Broker settlement; they do not start a
model or another Agent turn. The Task principal must independently possess
`test.run` request authority. Missing authority is reported as
`POST_WRITE_TEST_GRANT_REQUIRED`; Owner must explicitly configure the Task's
permission and approve a fresh check. Import approval cannot supply that grant.

Native adapters may finish their turn before the test is approved. Only the same
current assignment and Run, with Task still running and observation running,
waiting-approval, or successfully awaiting-review with a recorded turn end, is
eligible. Approval and pre-spawn checks repeat config, source and execution
validation. Cancelled, failed, unknown and cold-interrupted Runs remain blocked.
Existing logical operations persist per-Run check reservations and prevent
duplicate requests. Restart does not replay an import or test.

Expired one-shot approvals remain historical records. Work derives expiry from
the Approval owner's complete current pending set and shows `APPROVAL_EXPIRED`
as not run. For a native imported check that was prepared but never dispatched,
Owner may explicitly choose “重新申请检查”. The exact
`ui.workspace.verification.retry` command binds Workspace, Task and old approval
IDs. It revalidates the original source, configuration, current assignment/Run
and independent Task grant before requesting a new high-risk approval for the
same logical operation. The old approval remains unchanged; renewal neither
executes a check nor consumes an additional check reservation. Concurrent
requests share the fresh pending approval. Live, rejected, consumed and unknown
operations cannot use this path; changed source/configuration also refuse it.
Saving settings and observing expiry never renew approval automatically.

The result enters the existing tool transcript as machine feedback, preserving
failure diagnostics for a subsequent repair. A repair needs its own write
approval and a new check. A successful check does not complete a Task or satisfy
Owner semantic acceptance by itself.

Core test evidence binds the configured invocation, current Workspace source
observation and actual completed write receipts. Checks retain the latest
postimage for every matching or previously checked path in the same Run. A later
legitimate write replaces the old hash for that path. The Capability descriptor
independently reconstructs the necessary source set rather than trusting the
coordinator's `origin` assertion.

Mixed direct writes and native imports retain every cumulative matching path.
For direct writes, Core resolves the completed Broker request, operation and
postimage under the current executor and Run. Older retained receipts use their
consumed original approval and exact operation fingerprint to recover execution
identity. Missing or ambiguous receipts remain not run; an asserted origin hash
cannot replace durable Broker proof.

An imported path binds the actual `core-import` event, its request and logical
import operation, action, and postimage (or explicit deletion absence). Several
paths may share one import event. Core checks its consumed approval, completed
Broker operation, exact input/assignment and changes digest before accepting the
receipt. Creation, replacement and deletion of lossless UTF-8 files are covered;
the existing staging rejection of binary/non-UTF-8 output remains in force.
At most 24 matching or previously checked paths are bound. Larger source sets
are explicitly not run rather than partially certified.

The Task owner interprets both earlier per-check bindings and cumulative
bindings in actual write-event order. `verifyPostWriteCurrentSource` reopens the
current files and validates the current configuration and execution identity.
It only verifies the source of a machine observation: a test with exit 1 may
have valid source provenance while remaining a failed test. Strict outcome
verification still requires its original test and acceptance conditions.

Workspace source observations use the existing filtered content-proof coverage.
Explicitly written files are additionally hashed, including written ignored
files. This does not attest to unobserved external dependencies, package
registries, account state or the entire host environment. The current runner
and native permission disclosures continue to apply.

The existing continuation journal retains settled feedback across retry and
approval recovery. A consumed approval, lost response or late completion keeps
unknown-effect protection until there is actual evidence. Querying Task proof
does not run a test or replay an interrupted write.

Registered regressions exercise actual Core and synthetic loopback model
requests, separately approved Node checks, failure/repair/pass, cumulative
ignored files, stale inputs, changed execution identity, provenance forgery,
old binding reloads and cancellation. Native import diagnostic excerpts are
bounded and redacted in Task evidence, projected in Work and Task details, and
available as untrusted reference data in the next authorized continuation.
The UI distinguishes pending/running checks, failed/passed machine results,
unknown effects and explicit not-run reasons. Historical passing results do not
claim that current files or the user goal have been verified. Registered Core
import and Chromium settings/status tests use owned local fixtures. Installed
native acceptance, external Provider runs and release validation remain separate
integration gates.
