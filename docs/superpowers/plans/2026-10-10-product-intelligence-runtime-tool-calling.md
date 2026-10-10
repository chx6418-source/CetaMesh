# CetaMesh Product Intelligence Runtime — Tool Calling Follow-up Plan

> Continuation of `docs/superpowers/plans/2026-10-09-product-context-capability-discovery.md`.
> Preserve the completed Product Context projections and runtime wiring; implement the Owner's
> correction as an additive follow-up on `codex/product-context-tool-calling`.

## Goal

Give CetaMesh-managed Chat and Task Model turns a bounded, truthful, schema-bearing capability
manifest and structured Model Provider tool calling. Route every call through the existing
Capability Broker, preserve approval and authorization boundaries, fail closed on Task/Workspace
conflicts, and guarantee Product Context in production model paths.

## Adjudication changes

| Earlier decision | New decision | Reason |
| --- | --- | --- |
| Chat Model cannot request capabilities; deterministic routing runs before inference. | Chat and Task Models can request structured capabilities. Smart Router remains optional pre-routing for cost, obvious project escalation, and safety classification. | The Model must be able to select a registered capability while the Broker remains the execution authority. |
| Capability descriptions may be omitted under tight context budgets. | Keep id, one-line description, minimum input schema, availability, and approval requirement; drop optional detail and then deterministically reduce capability count. | A bare id does not let the Model make a valid, safe request. |
| Task and selected Workspace conflicts are displayed as two facts. | Enter an execution reconciliation gate; block reads and mutations by default until an explicit resolution is recorded. | Displaying a conflict while executing against either Workspace is unsafe. |
| A missing Product Context provider may result in identity-only or ordinary chat. | Low-level constructors may omit it for isolated tests, while production Chat and Task Model paths must fail with `PRODUCT_CONTEXT_UNAVAILABLE`. | A wiring defect must not silently change the product's execution mode. |

## Implementation sequence

1. **Capability descriptors and budget**
   - Extend the authoritative Capability Registry descriptors with descriptions, input schemas,
     availability, source, risk, and approval facts.
   - Build a current, actor/scope/mode filtered callable manifest; keep unavailable status summaries
     out of provider tool schemas.
   - Change compaction to preserve the minimum callable semantics and reduce manifest count last.
   - Keep the existing Product Context implementation and add an explicit configurable
     `ProductContextBudget`.

2. **Model Provider structured tools**
   - Extend the Model Provider contract with explicit tool-call support metadata.
   - Map OpenAI-compatible capability descriptors into provider function schemas and parse structured
     tool calls without text/regex interpretation.
   - Keep unsupported providers in truthful plain-chat mode with `toolCalling: unsupported`.
   - Record `requestedModel=provider-default` when appropriate and only record `resolvedModel` when
     the provider returns it.

3. **Tool Execution Coordinator**
   - Add `src/model/tool-execution.js` to validate provider arguments, call the existing Broker,
     normalize/redact results, continue Model turns, enforce per-batch/total/cycle/time limits, and
     propagate cancellation.
   - Pause on pending approval and persist only bounded continuation state through
     `src/storage/json-file.js`; resume or return structured rejection/expiry results.
   - Keep the provider disconnected from Executors and do not create a second Broker.

4. **Chat and Task Model wiring**
   - Wire both CetaMesh Model paths through the coordinator and the existing Product Context service.
   - Pass server-owned actor, Task, and Workspace scope; never accept authority fields from tool input.
   - Surface pending approval and truthful tool-calling/model status through existing Chat status
     contracts without redesigning UI.
   - Require Product Context at production bootstrap and at production Chat/Task Model entry points;
     retain optional context injection for isolated unit constructors.

5. **Workspace execution reconciliation**
   - Compare the Task's expected Workspace against the selected/observed execution Workspace before
     exposing tools and again inside the Broker policy path.
   - Return `WORKSPACE_RECONCILIATION_REQUIRED` and deny all capabilities during conflict by default.
   - Add an explicit Continuity reconciliation operation that records expected Workspace, observed
     Workspace, resolution, and resolvedAt in the Task checkpoint and only then resumes execution.
   - Never silently rewrite the Task or Agent assignment.

6. **Regression coverage and delivery records**
   - Add tests for identity and manifest schemas, dynamic availability, Broker-only execution,
     unknown calls, approvals, limits, unsupported providers, production context requirements,
     memory scope, injection resistance, and Workspace conflict/reconciliation.
   - Register every test script in `scripts/run-all-tests.mjs`; run only `npm test`.
   - Update `PRODUCT_INTELLIGENCE_RUNTIME_REPORT.md` with the old-to-new adjudications, delivered
     behavior, tests, and any `NOT_RUN_ENVIRONMENT` suites.
   - Update `PROJECT_STATE.md` Active Work for this branch. Do not merge, push, or delete the branch
     before Owner confirmation.
