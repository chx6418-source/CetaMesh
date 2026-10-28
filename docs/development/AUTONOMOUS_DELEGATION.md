# Autonomous Task delegation contracts

The Managed Agent proposes external work through the existing Capability Broker. Core chooses an eligible registered executor and uses Continuity to transfer the same Task. Task JSON, the operation ledger, Event Journal and existing Agent Runtime remain authoritative.

## Authority and execution

The trusted desktop interface issues `capability.delegation.authorize` for a Task and its current revision. The policy has an expiry (at most 24 hours), a dispatch limit (1–3) and an explicit `allowUnknownCost` boolean. Unknown pricing is never represented as free. Automatic delegation needs a valid Owner policy. Native execution also needs existing per-Workspace Agent security consent and positive runtime evidence; installation and account configuration alone are insufficient.

The policy binds the goal, requirements, Workspace, model configuration and acceptance criteria. An Agent uses `agent.delegate.candidates` to discover actual matches and `agent.delegate.propose` to record task kind, difficulty, exact required Broker tools and a bounded suggestion. Generic native coding uses an empty required Broker tool list: native commands are not CetaMesh Broker capabilities. Suggestions cannot choose identities, grant permissions or replace the Owner goal.

After the source user turn ends, Core checks idle state, pending approvals, unknown operations, assignment and policy. It persists a claim before using existing Continuity. Eligibility is checked again before dispatch. Duplicate events, uncertain acknowledgements and Core restarts cannot silently create another dispatch.

Confirmed external completion, import receipts and idle state permit return to Managed. Its verification turn receives the original goal, an untrusted external report, actual evidence and existing operations. Effects resume by stable references, never by description similarity. Only a fixed `npm test` parameter shape can be carried as safe continuation input. Other operations require exact explicit input. Current permissions and approvals remain mandatory.

`capability.delegation.revoke` persists revocation, removes proposal tools and requests cancellation. Cancellation does not prove absence of side effects; active outcomes remain subject to reconciliation. Automatic dispatch rechecks current policy at its final send boundary.

## Verification and delivery

A model report alone leaves the Task awaiting review. An optional Owner verification contract covers every acceptance criterion using `kind: "code-tests"`, a prepared test `operationId`, all `acceptanceIds`, exact `allowedPaths`, and `unchangedFiles` with SHA-256 values for package.json and the verification sources.

Core requires a passing result from its controlled test runner in the current verification session/run, current imported-file hashes, unchanged verifier files and Git changes confined to allowed paths. The existing outcome verifier also rejects unknown effects, failed tests, empty diffs and modifications after testing. A later read-only diff inspection does not invalidate a test. Only confirmed machine criteria permit automatic completion; semantic criteria retain review.

The controlled runner is an allowlisted command runner, not an OS sandbox. Project-code execution, staging import and native execution approvals remain distinct. CetaMesh cannot intercept all actions performed directly by a native Agent through the host OS.

## Finite L2 grants

The existing `capability.grant.create` accepts exact non-append Core file writes and write-only Workspace batches. Grants bind Actor, Task, assignment, Workspace, full input, descriptor, risk and current authorization. Lifetime is 1 second–15 minutes and uses are limited to 1–20. Revocation, expiry, changed parameters or a new executor prevent reuse. Deletion, arbitrary project-code execution and unknown plugin effects require separate review.

## Memory replacement

The user-only `supersedes` Memory relation can confirm replacement of two versions of the same scoped fact. It binds both revisions. Retrieval omits the replaced record while keeping its history accessible. Editing either record invalidates replacement confirmation. Newer timestamps and model inferences do not establish authority.

## Declarative HTTP plugins

An `external-api` extension whose entry ends in .json uses a data-only HTTP host through existing package review, fingerprint, installation, enable/disable and Broker paths. Its entry declares `schemaVersion: 1`, `protocol: "http-json-v1"`, and endpoints with a capability, HTTPS URL, GET/HEAD method, exact query keys and text/json response. Input schemas are objects with `additionalProperties: false`.

Method names do not prove absence of side effects. Endpoint capabilities retain unknown effects and require invocation approval. DNS, private-address and redirect-host checks remain in Core. Schemas and package versions are checked again. Closing a plugin aborts active requests without claiming remote cancellation.

Authenticated HTTP writes, remote MCP sessions, generic WebSocket/Webhook plugins and cross-plugin delegation remain separate adapter work. Existing built-in adapters retain their contracts.

## Validation

Run root `npm test`. The deterministic `test-autonomous-handoff-integration` uses actual Core, Continuity and controlled test execution but cannot prove a real Provider decision.

The opt-in `test-real-autonomous-handoff` uses the existing Managed Provider, installed Codex CLI, disposable state and a synthetic Git Workspace. It separately verifies native readiness before testing autonomous selection. It requires a real model proposal, real external file modification, import approval, Managed independent testing and confirmed Task delivery. Enable both `WHALEBRIDGE_TEST_REAL_MANAGED=1` and `WHALEBRIDGE_TEST_REAL_CODEX=1` only with paid-test authorization. Credentials stay behind the existing Provider service and are not copied to fixtures.

## Default Tasks entrance and cold preparation

The production Tasks form starts from a goal and the active or only Workspace. It reads the configured executor preference before offering Managed cooperation. Executor and verification controls are advanced options. Creation opens the resulting Task only if the user has not navigated or closed the sheet meanwhile. Concurrent copies of the same creation request join setup and dispatch; changed collaboration/model criteria conflict with its identity.

`ui.task.create` accepts `collaboration: { enabled, allowUnknownCost, prepareNative, verification? }`. The normal form uses at most one external dispatch within 30 minutes. Unknown cost is denied unless explicitly allowed. A verification selection has exact `editablePaths` and existing `testFiles`; Core requires a clean Git baseline, snapshots package.json and test hashes, creates acceptance and the existing prepared npm-test operation, then binds the actual Managed model before authorizing the policy. Arbitrary natural-language goals retain review unless these machine criteria cover their declared acceptance.

Cold candidates may report `preparationRequired: true` and `taskEligible: false`. This permits a bounded preparation proposal, not execution. After the source settles, Core requests existing Owner native consent, uses Continuity, and requires an actual successful nonce-printing native command with no staging changes. The adapter returns a current bootstrap proof. Source/policy authority is checked after awaited preparation and immediately before native dispatch. No known refusal or unknown process outcome is retried as readiness.

The external receiver is explicitly assigned the execution-worker role; the original orchestration goal and old checkpoint cannot make it repeat delegation. Formal work still uses the same authoritative Task and existing import/test approvals.

## Approval, Memory and plugin continuation

Tasks show their own approvals and operation status. `capability.grant.fromApproval` derives future L2 scope only from the trusted stored request. Source-linked grants are initially pending, become active only with actual affirmative source consumption, and cannot be multiplied by repeated clicks. UI offers three future exact uses within 15 minutes; original one-shot use is counted separately. Parameters, preconditions, Actor, assignment, plugin constraint and current authorization remain bound.

After machine-verified completion, Core may propose a workspace Memory candidate containing historical verification metadata and Task evidence references. It rechecks the fixed contract using the persisted verified session, since completion detaches the live Agent. It never stores the model report as a confirmed fact. Existing user confirmation, correction, rejection and scoped stores remain authoritative; repeated delivery respects rejection.

Context-aware plugin calls retain the source Task Actor and Workspace and are independently restricted by the installed plugin's declared resources. Derived operations use stable parent identity. Task HTTP wrappers can yield a second concrete network approval: the same Managed continuation is transferred to that exact linked approval, then receives the version-bound parsed result. The parent package, grants, Task and exact data endpoint are checked again before concrete dispatch. These decisions do not grant one another's authority. Generic process-plugin Task reverse calls remain unavailable until their protocol binds the invocation context; ordinary installed-plugin execution keeps its existing contract.

The additional opt-in `test-real-default-ui-autonomy` drives the production HarborApp Tasks form through the authenticated native Core pipe with actual Managed/Codex execution, without a test-only readiness Task or direct task-policy setup. It also requires `WHALEBRIDGE_TEST_UI_MOTION=1` and installed Edge. Its host adapter is a browser acceptance harness; native WebView smoke, Cargo and Core SEA checks are separate evidence.