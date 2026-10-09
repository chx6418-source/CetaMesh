# CetaMesh Product Context and Capability Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add stable CetaMesh identity and a bounded, truthful runtime context to standalone Model Runtime Chat and CetaMesh-managed Agent inference.

**Architecture:** Keep identity and bounded projection in pure modules under src/context, with a context service that gathers only explicitly linked runtime data. Inject its ephemeral result into Chat and the managed Agent. The Capability Broker remains the sole authority for actions; no new tool loop or routing policy is added.

**Tech Stack:** Node.js ES modules, existing Model Runtime message contract, existing Task/Memory/Workspace/Capability/Extension/Agent services, scripts/run-all-tests.mjs.

**Spec:** docs/superpowers/specs/2026-10-09-product-context-capability-discovery-design.md

## Global Constraints

- Identity and dynamic context are ephemeral system messages and are never persisted to Chat or Agent history.
- Persistent Task and Memory ownership stays in CetaMesh; an Agent session remains an optional Task attachment.
- Capability registration, actor grants, requestability, approval, and execution remain separate states; execution still passes through Capability Broker.
- Read only the linked Task and explicitly linked, Memory-policy-authorized references; never enumerate all Tasks or Memory.
- Do not include absolute Workspace roots, secrets, environment values, full histories, or arbitrary file contents.
- Do not add tool schemas/loops, Task creation behavior, Smart Router behavior, UI changes, or persistent context storage in this slice.
- Use npm test as the only repository test entry point. Register every new scripts/test-*.mjs in scripts/run-all-tests.mjs.
- Do not add a bare empty catch; any required empty catch needs an explanatory comment.

## Review Focus

- A simple Chat with no linked Task or Workspace still gets identity and does not create a Task; cover in Task 2.
- A stale or mismatched Task/Workspace link never broadens context to another Task or the active Workspace; cover in Task 2.
- Cross-scope or ungranted Memory references are omitted by the existing Memory policy; cover in Task 2.
- Registered capabilities are not labeled requestable unless the current route or managed Agent grants permit them; cover in Tasks 1 and 2.
- Oversized or instruction-like runtime data cannot evict authority/status labels or exceed the context limit; cover in Task 1.

---

### Task 1: Build bounded Product Context projections

**Files:**
- Create: src/context/product-context.js
- Create: src/context/capability-context.js
- Create: src/context/task-context.js
- Create: scripts/test-product-context.mjs
- Modify: scripts/run-all-tests.mjs

**Interfaces:**
- PRODUCT_IDENTITY_PROMPT is a stable, versioned string separate from dynamic facts.
- buildCapabilityContext({ registered, grantedIds, requestableIds, executionPath }) returns normalized registered and MCP-backed descriptors plus the exact requestable capability ids for that execution path.
- buildTaskContext({ task, workspace, memoryReferences }) returns only allowlisted Task, Workspace, checkpoint, and Memory-reference fields. It returns null for a missing Task or Workspace and never returns an absolute root path.
- buildProductContext(snapshot, { maxChars = 12000 } = {}) returns a deterministic JSON string no longer than maxChars. It preserves version, authorization, availability, and requestability labels before optional descriptions.

- [x] **Step 1: Write focused failing cases in scripts/test-product-context.mjs** for stable identity, deterministic capability ordering, grant/requestable filtering, MCP provider grouping, Task/Workspace allowlists, Memory-reference limits, root/secret omission, and total-size bounds.
- [x] **Step 2: Register test-product-context.mjs in scripts/run-all-tests.mjs** under runtime; run npm test and confirm the new cases fail because the context modules are not implemented.
- [x] **Step 3: Implement buildCapabilityContext and buildTaskContext** as pure projections with no storage, network, or filesystem access.
- [x] **Step 4: Implement PRODUCT_IDENTITY_PROMPT and buildProductContext** with explicit field allowlists, stable ordering, bounded optional descriptions, and deterministic omission order when maxChars is exceeded.
- [x] **Step 5: Run npm test** and confirm the context suite and existing suites pass.
- [x] **Step 6: Commit only the context projections and their registered tests** with the message feat: add product context projections.

### Task 2: Resolve live runtime context and inject it into model calls

**Files:**
- Create: src/context/service.js
- Modify: src/app/service-container.js
- Modify: src/desktop/chat-service.js
- Modify: src/agent/managed-agent-provider.js
- Modify: scripts/test-standalone-model-path.mjs
- Modify: scripts/test-managed-agent-provider.mjs
- Modify: scripts/test-desktop-chat-product.mjs
- Modify: scripts/test-service-container.mjs
- Create: PRODUCT_INTELLIGENCE_RUNTIME_REPORT.md

**Interfaces:**
- createProductContextService({ taskRuntime, workspaceService, memoryService, capabilityService, extensionService, agentBroker }) returns buildForChat({ record, routing, modelProvider }) and buildForAgent({ sessionId, provider, principal, modelProvider, model }).
- buildForChat resolves only record.taskId and record.config.workspaceId; it does not substitute the active Workspace when either link is absent or stale. Chat has no arbitrary model-callable capability ids in this slice; the existing deterministic Smart Router result remains reference data.
- buildForAgent re-resolves the live Task principal for every inference step and advertises only its current granted capabilities as requestable through the existing structured protocol.
- Both methods return the serialized JSON string from Task 1. Memory refs go through memoryService.runtime.resolveReferences with the user principal for Chat and current Task actor for Managed Agent.
- The context service reads capabilityService.broker.list(), extensionService.runtime.overview(), and agentBroker.listProviders(). It does not call external Agent health endpoints just to build Chat context; unknown provider health remains unknown.
- Chat and Managed Agent constructors accept a buildProductContext callback. Chat calls it after Smart Router resolution and before Model Runtime streaming. Managed Agent calls it before each inference step.
- PRODUCT_INTELLIGENCE_RUNTIME_REPORT.md records only this approved slice's actual behavior, verification, and explicit deferred scope.

- [x] **Step 1: Extend test fakes first** in the Chat, Managed Agent, and service-container suites to capture model messages and context requests. Assert ephemeral system messages, per-step refresh, and no context in persisted history; run npm test and confirm these new assertions fail.
- [x] **Step 2: Implement createProductContextService** in src/context/service.js using linked Task/Workspace references, policy-authorized Memory refs, registered capability descriptors, extension runtime summaries, and registered Agent Providers. Project fields through the Task 1 pure builders.
- [x] **Step 3: Add a late-bound context callback in service-container.js** before constructing Chat and Managed Agent, then build the Product Context service after all existing context sources are composed (Task, Workspace, Memory, Capability, Extension, Agent, Channel, and Mesh). Point the callback at the completed service before createCetaMeshServices returns. Preserve the existing cyclic service ordering and lifecycle; expose the context service additively for integration tests.
- [x] **Step 4: Inject identity and context as non-persisted system messages in chat-service.js** after the routing result is known and before Model Runtime stream starts. Preserve prior user/assistant messages and the current user prompt.
- [x] **Step 5: Inject the same identity and fresh Task-scoped context in each managed-agent-provider.js inference step** while preserving its JSON command protocol and server-owned actor, workspace, task, and grants.
- [x] **Step 6: Extend integration assertions** to prove simple Chat does not create Tasks, stale links do not widen scope, unauthorized Memory refs are omitted, requestable grants are accurate, and existing external Agent Provider prompt semantics stay unchanged.
- [x] **Step 7: Write PRODUCT_INTELLIGENCE_RUNTIME_REPORT.md** with actual delivered behavior and verification; state that arbitrary model tool calling, broader Task routing, and UI changes are deferred.
- [x] **Step 8: Run npm test** and confirm all suites pass or report environment-gated suites as NOT_RUN_ENVIRONMENT.
- [ ] **Step 9: Review the branch diff and commit the integration, regression coverage, and report** on codex/session-20261009-rules-confirm. Do not merge, push main, or delete the branch before Owner confirmation.
