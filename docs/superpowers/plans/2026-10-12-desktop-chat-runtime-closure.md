# Desktop Chat Runtime Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and close local Chat streaming, cancellation, retry, Capability Broker execution, approval, continuation, and secret-redaction gaps through the existing Core runtime.

**Architecture:** Keep the existing OpenAI-compatible Model Provider, Model Runtime, Chat service, Tool Execution Coordinator, Capability Broker, and typed `ui.*` projection. Tests inject an in-process OpenAI-compatible `fetchImpl`; no test fixture can make a production network request.

**Tech Stack:** Node.js ESM, existing Model Runtime and Chat service, React/TypeScript typed bridge, repository test aggregator.

**Spec:** `docs/superpowers/specs/2026-10-12-desktop-ui-v2-final-production-closure-design.md`

## Global Constraints

- `Persistent JSON reads and writes must go through src/storage/json-file.js; error-code mapping stays in the owning Domain.`
- `Any new empty catch must include an explanation comment.`
- `Continue on feature/desktop-ui-v2-production; do not modify another checkout, push, publish Stable, merge, or delete this branch/worktree without Owner confirmation.`
- `Do not redesign Harbor, add another UI direction, migrate to another framework, or refactor the overall architecture.`
- `Keep React on the existing typed ui.* projection, Rust Host on native file/browser/window actions, and business behavior in existing Core domains and services.`
- `Use local fixtures for deterministic tests, but label fixture evidence separately from real-provider or external-service acceptance. No fixture result can satisfy the real Provider requirement.`
- `Keep unsupported operations visibly unavailable/deprecated instead of fabricating success or enabling a fake button.`
- `Keep new test scripts registered with scripts/run-all-tests.mjs; the canonical aggregate entry is npm test.`
- `Do not expose provider, agent, MCP, plugin, device, or extension secrets in React state, DTOs, logs, reports, or screenshots.`

## Review Focus

- Provider HTTP errors or logs containing the fixture API key; pin with a redaction assertion in `scripts/test-provider-secrets.mjs`.
- Abort while streaming and a later retry must not duplicate the user turn; pin in `scripts/test-desktop-chat-product.mjs`.
- Malformed SSE and a provider 4xx/5xx response must produce structured error states; pin in `scripts/test-model-runtime.mjs`.
- Unknown/tampered tool arguments must be denied before executor invocation; pin in `scripts/test-model-tool-calling.mjs`.
- An expired, rejected, or replayed approval must not execute the capability; pin in `scripts/test-capability-broker.mjs` and the tool-calling suite.

---

### Task 1: OpenAI-compatible local Provider fixture

**Files:**
- Create: `scripts/test-support/openai-compatible-fixture.mjs`
- Modify: `scripts/test-model-runtime.mjs`
- Modify: `scripts/test-provider-secrets.mjs`

**Interfaces:**
- Produces: `createOpenAiCompatibleFixture({ responses }) -> { fetchImpl, requests, close() }`; each response is `{ kind: 'json', body, status? }`, `{ kind: 'sse', chunks, status? }`, or `{ kind: 'http-error', status, body }`; SSE observes `AbortSignal`.
- Consumes: existing `createOpenAiCompatibleModelProvider`, `createModelProviderRegistry`, and `createModelRuntimeService` APIs.

- [ ] **Step 1: Add failing runtime assertions** for normal response, ordered streaming chunks, abort, malformed SSE, HTTP error, and retry after error; assert the request uses only the injected fixture endpoint.
- [ ] **Step 2: Run `npm test -- --category runtime --category security`** and confirm the new named assertions fail.
- [ ] **Step 3: Implement the fixture helper** with deterministic injected `fetchImpl` responses; it must reject every URL outside the test fixture endpoint and must not bind or contact a public endpoint.
- [ ] **Step 4: Implement only the Provider changes required by the failing assertions** in `src/model/providers/openai-compatible.js`; preserve cancellation, structured error codes, and API-key scrubbing.
- [ ] **Step 5: Run `npm test -- --category runtime --category security`** and confirm Provider/runtime/redaction assertions pass.
- [ ] **Step 6: Record real Provider plain-chat/streaming acceptance separately**; if no credential is configured, record `NOT_RUN_ENVIRONMENT` and verify only the configured boolean without printing or persisting the key.

### Task 2: Chat service streaming, stop, error, and retry

**Files:**
- Modify: `scripts/test-desktop-chat-product.mjs`
- Modify: `src/desktop/chat-service.js`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Consumes: Task 1 fixture and existing `createChatService`, `ui.chat.send/status/stop/retry`, and typed `chatClient` methods.
- Produces: a Chat request creates one user message; streamed events update that turn; stop settles it as cancelled; retry creates one new attempt; errors remain structured and secret-free.

- [ ] **Step 1: Add failing Chat service and UI projection assertions** for streamed content, stop during stream, provider error, retry, and single user-message persistence.
- [ ] **Step 2: Run `npm test -- --category architecture --category runtime`** and confirm the Chat assertions fail.
- [ ] **Step 3: Implement the smallest service/projection/UI changes** needed for real runtime state to drive Harbor; remove no existing service boundary.
- [ ] **Step 4: Run `npm test -- --category architecture --category runtime`** and confirm Chat lifecycle assertions pass.

### Task 3: Real tool execution and approval continuation

**Files:**
- Modify: `scripts/test-model-tool-calling.mjs`
- Modify: `scripts/test-capability-broker.mjs`
- Modify: `src/model/tool-execution.js`
- Modify: `src/capability/broker.js`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Consumes: Task 1 local fixture, existing `createToolExecutionCoordinator`, Capability Broker, `ui.approvals.list/decide`, and owner actor binding.
- Produces: provider tool call → Broker validation → safe fixture executor → structured tool result → model continuation. Approval paths preserve `Pending`, `Approved`, `Rejected`, `Expired`, and consumed/replay rejection states.

- [ ] **Step 1: Add failing assertions** for one safe execution, an approval-required execution resumed by Approve Once, rejection continuation, expiry, and replay/tamper denial; assert executor call counts and final assistant content.
- [ ] **Step 2: Run `npm test -- --category runtime --category security`** and confirm the missing paths fail.
- [ ] **Step 3: Implement the minimal Core/typed-projection/UI changes** so approval decisions resume the same turn through the existing coordinator; do not invoke shell, QQ, or arbitrary workspace commands from the fixture.
- [ ] **Step 4: Run `npm test -- --category runtime --category security`** and confirm tool and approval assertions pass.
