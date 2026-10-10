# CetaMesh Intelligence Runtime — Product Context 1.0

## Current follow-up (2026-10-10)

The Product Intelligence Runtime / Product Context tool-calling follow-up is implemented on the isolated branch `codex/product-context-tool-calling` for the native desktop runtime. The branch is uncommitted and awaits Owner review; do not merge, push `main`, or delete the branch until the Owner confirms.

### Adjudications

| Earlier ruling | Current behavior | Why |
| --- | --- | --- |
| Standalone Chat cannot request capabilities; Smart Router is the only entry. | Native Chat and Managed Agent use structured Model tool calls. Smart Router remains optional pre-routing. | Models need to choose registered capabilities while Capability Broker remains the sole executor. |
| Capability descriptions can be omitted when context is tight. | Callable manifests retain id, description, input schema, availability, and approval requirement. Non-callable capabilities remain in bounded status summaries; compaction retains as many sorted status facts as fit. | A bare capability id cannot support a valid structured request. |
| Task and selected Workspace conflicts may be shown while execution continues. | A Task/Workspace mismatch hides the entire callable manifest and Capability Broker fails with `WORKSPACE_RECONCILIATION_REQUIRED`. Owner can explicitly resolve to the observed registered Workspace; the Task checkpoint records the decision and time. | Execution must pause until the authoritative Task link is reconciled. |
| Production Chat may continue without Product Context. | Native production Chat and Managed Agent require Product Context and fail with `PRODUCT_CONTEXT_UNAVAILABLE` if it cannot be built. | Missing wiring must not silently change the execution mode. |

### Delivered behavior

- The Capability Registry publishes bounded descriptions, input schemas, availability, source, risk, approval, Task, Workspace, and model-callability facts. The context builder advertises only currently available, in-scope, granted/requestable capabilities. Disabled, crash-disabled, or uninstalled Extension capabilities stay out of the callable manifest; re-enabling restores requestability when the grant remains.
- Model Providers declare tool support explicitly. The native OpenAI-compatible adapter converts descriptors to structured function schemas and parses structured calls. DeepSeek Official and OpenAI are declared supported; OpenAI-compatible custom Providers default to unsupported. Unsupported Providers receive no fake schemas and report `toolCalling: unsupported`.
- `src/model/tool-execution.js` runs bounded tool loops (8 calls per batch, 6 cycles, 24 total calls, 300-second turn timeout), validates input schemas, rejects input-supplied authority, calls only Capability Broker, bounds and redacts returned data, and propagates cancellation. Unknown capability ids return Broker errors to the same Model turn.
- Owner approval pauses a Model turn without holding a provider request. A bounded continuation is stored through `src/storage/json-file.js`, bound to the target and request fingerprint, and resumes after a decision. A transient Model resume failure keeps the continuation available for retry. The legacy Managed Agent approval queue also resumes only after the matching Owner decision.
- Owner-only `task.create` is bound to the current Workspace. `agent.run` requires a Task, workspace, and existing Broker grants. Workspace reconciliation is an explicit Native Continuity operation and does not silently move a Task or Agent binding.
- Product Context v2 remains ephemeral; identity and current dynamic facts are composed for the inference request and are not persisted into Chat or Agent history. It reports requested and provider-returned resolved model ids truthfully, preserves the existing approval risk baseline, and makes no UI redesign.
- The test runner now requires both the repository-local `config.json` and a reachable TCP gateway before running real gateway suites, avoiding false positives from another local session's listener.

### Verification

Verified on 2026-10-10 using the repository entry point `npm test`:

- 78 suites discovered
- 69 passed
- 0 failed
- 9 reported as `NOT_RUN_ENVIRONMENT`
- `git diff --check` reported no whitespace errors; Git only warned that several LF files may be converted to CRLF on a future write.

The 9 skipped suites require: legacy bridge (`test-console`), core distribution artifacts (`test-core-dist`, `test-process-extension-sea`), desktop shell debug artifacts (`test-desktop-install`, `test-desktop-shell`), a configured local gateway (`test-mcp-exec`, `test-onebot-connection`), explicit network opt-in (`test-mcp-web-search`), or release distribution artifacts (`test-release-candidate`).

### Owner delivery gate

Implementation and local verification are complete on the work branch. Await Owner review and confirmation before merging to `main`; then delete the work branch as required by the repository handoff rule. No push to `main` was made.

## Product Context projection baseline (2026-10-09)

This slice adds a stable CetaMesh identity prompt and a bounded Product Context projection for the native Model Runtime Chat path and the CetaMesh Managed Agent path.

- Standalone Chat receives the identity prompt and a JSON Product Context system message after Smart Router resolution and before Model Runtime streaming. The messages are assembled for that request and are not written to Chat history.
- Managed Agent receives the identity prompt and freshly resolved Product Context before each inference step. Its existing one-command JSON protocol remains in place. Context is not appended to its stored conversation messages.
- Chat context follows only `record.taskId` and `record.config.workspaceId`. Missing or stale links produce missing facts; the active Workspace and other Tasks are never substituted.
- Managed Agent context follows the live `(provider, sessionId)` Task binding and current Task principal. Only registered capabilities with the current Task grant are marked requestable. Execution, permission checks, and approval continue through the Capability Broker.
- Capability registration, availability, grants, and requestability are represented as separate facts. Extension capability availability is combined with the current Extension overview: disabled or crash-disabled capabilities are not requestable, removed capabilities are unavailable, and re-enabling restores requestability when the Task grant remains. Provider health is reported as unknown unless already known; context construction does not probe external Agent providers.
- Task and Workspace facts use explicit allowlists. Absolute roots, Workspace settings, recent files, unrelated history, and secret fields are excluded. Task Memory references are resolved through the existing Memory policy; unavailable or unauthorized references are omitted.
- Product Context is serialized deterministically and bounded to 12,000 characters by default. Its identity and authorization labels are kept ahead of optional descriptions when compaction is needed.

## Baseline verification (2026-10-09)

Verified on 2026-10-09 with the repository entry point `npm test`:

- 77 suites discovered
- 68 passed
- 0 failed
- 9 reported as `NOT_RUN_ENVIRONMENT`
- The service-container integration covers enabling, disabling, re-enabling, and uninstalling a real registered Extension while retaining the Task grant.

The 9 environment-gated suites require the legacy bridge, core distribution artifacts, desktop shell debugging, a gateway, network access, or release distribution artifacts that were not present in this environment.

## Baseline deferred scope (superseded by the current follow-up where noted)

This slice does not add arbitrary model-callable tools to standalone Chat, broader Task routing or creation behavior, UI changes, or persistent Product Context storage. Smart Router behavior and capability execution policy are unchanged.
