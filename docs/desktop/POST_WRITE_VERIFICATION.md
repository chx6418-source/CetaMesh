# Configured post-write verification

The existing Workspace settings owner accepts an optional
`postWriteVerification` configuration. It is disabled when absent. Saving the
configuration observes and validates it; saving never executes a project script
or grants `test.run`.

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
old binding reloads and cancellation. Core import triggers, complete product
controls, installed native acceptance and release validation are separate
integration gates.
