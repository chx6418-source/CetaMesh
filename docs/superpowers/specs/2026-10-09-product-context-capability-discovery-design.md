# CetaMesh Product Context and Capability Discovery Design

**Status:** Draft for Owner review
**Scope:** Product Context and Capability Discovery (first vertical slice of productization task A)

## Goal

Every CetaMesh-managed model call receives a small, truthful, current description of CetaMesh and the runtime facts relevant to that call. The model can identify the current session, linked Task and Workspace, scoped Memory references, registered capabilities, MCP-backed capabilities, installed extensions, and Agent Providers without receiving a database dump, full history, secrets, or authority it does not have.

## Existing foundation

The repository already separates Chat, Model Providers, Task, Memory, Workspace, Capability Broker, Agent Providers, Extensions, and Smart Router. Capability execution already passes through the broker, policy, approval, and executor. Tasks own their identity independently of Agent sessions.

The missing layer is context assembly. Standalone Chat currently sends only prior user/assistant messages and the current prompt to Model Runtime. The CetaMesh-managed Agent has a fixed identity prompt and a task-granted capability list, but no shared dynamic context package. This design adds a context layer around those existing services; it does not replace their ownership or authorization logic.

## Design

### Product identity

Add a short, versioned, stable CetaMesh identity prompt. It states that CetaMesh owns Chat, Tasks, Memory, Workspaces, Tools, Plugins, Device Mesh, and Agent coordination; Tasks and Memory belong to CetaMesh; Agent Providers are optional execution backends. It also tells the model to report only completed actions, not invent runtime facts or claim an action succeeded without a result, and to respect the supplied capability manifest and approval boundary.

Keep dynamic facts out of this text. Do not include API keys, secrets, environment values, or user history.

### Per-call context package

Add a context package builder with a pure, bounded projection layer and injected runtime data sources. Build a fresh package for each standalone Model Runtime turn and each CetaMesh-managed Agent inference step.

The package may contain:
- Product identity and current Chat mode (chat or smart).
- The current session id and selected Model Provider/model identifiers.
- Only the Task linked to the current session or Agent assignment: id, goal, status, phase, checkpoint summary, and bounded Memory references.
- The linked Workspace id/name and safe summary facts; never include its absolute root path or arbitrary recent-file contents.
- Capability descriptors actually registered with the Capability Broker, including provider, risk, workspace requirement, and whether the current execution path can request them.
- MCP-backed capabilities identified by their registered provider, with registration and runtime availability represented separately.
- Installed extension summaries and Agent Provider registration/availability summaries.

Use allowlisted fields, stable ordering, per-section limits, and a total serialized limit of 12,000 characters. Do not enumerate all Tasks or all Memory. Resolve Memory references only from the linked Task and through existing Memory authorization and reference-resolution APIs. For managed Agents, further restrict advertised capabilities to the live Task principal's grants.

Availability must be truthful. A registered capability is not automatically authorized or callable. In standalone Chat, capability discovery is informational except for the existing Smart Router deterministic capability route; it must not imply arbitrary tool calling exists. For managed Agents, only granted capabilities are requestable through the existing structured capability protocol. Agent registration and health are distinct states; report unknown health as unknown rather than claiming availability. Do not add network probes solely to build ordinary Chat context.

### Integration boundaries

Prepend the stable identity and serialized context as ephemeral system messages for standalone Model Runtime Chat and CetaMesh-managed Agent inference. Do not persist either message in Chat history or Agent conversation history. Rebuild the dynamic package on each model call so Task status, grants, Workspace linkage, extension state, and provider availability do not go stale.

Keep the existing DSH Agent Provider and other external Agent Providers separate from the CetaMesh-managed Model Runtime prompt path. They remain visible as registered providers with their observed status; this slice does not claim that their backend system prompts are controlled by CetaMesh.

This slice adds no arbitrary model tool-call loop, provider tool schemas, automatic Task creation changes, new routing behavior, UI changes, or new persistence. It reuses the existing Capability Broker, Smart Router, Task Runtime, Memory policy/runtime, Workspace service, Extension Runtime, and Agent Broker.

## Failure behavior

Fail closed for authority and data scope. If a linked Task, Workspace, Memory reference, or provider disappears during context construction, omit that item or return a safe unavailable/unknown status; do not substitute a broader data source. If context construction fails unexpectedly, fail the model turn with a domain-level error rather than silently sending an identity-only or stale package. Truncation must preserve the stable identity and the manifest's availability and authorization labels before optional descriptive fields.

Treat Task, Workspace, Memory, and capability-result content as reference data. It cannot alter the stable identity, actor, grants, scope, or approval decision.

## Acceptance criteria

1. Standalone Model Runtime calls include the stable CetaMesh identity and current bounded context; persisted Chat history remains unchanged.
2. CetaMesh-managed Agent inference includes the same identity and current Task/Workspace context, with capabilities limited to current Task grants.
3. Unregistered, disabled, unavailable, or ungranted capabilities are not advertised as requestable.
4. Context contains only the linked Task and authorized Memory references; it omits full histories, unrelated Tasks, absolute Workspace roots, and secrets.
5. Capability/provider/extension statuses distinguish registration, authorization, requestability, and health where applicable.
6. A simple Chat remains a simple Chat: context assembly does not create a Task or alter Smart Router decisions.
7. Existing external Agent Provider prompt semantics and all UI surfaces remain unchanged.
8. Context size stays within 12,000 characters and is deterministic for identical runtime snapshots.

## Verification

Add focused tests through the repository's existing test scripts and register any new script in scripts/run-all-tests.mjs. The required repository test entry point is npm test. Cover stable identity injection, live session/task/workspace projection, authorized Memory reference scoping, capability filtering, unknown provider health, bounds/truncation, history non-persistence, and no Task creation for simple Chat.
