# Desktop MCP, Plugin, Extension, and Bionic Integration Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close local integration lifecycle gaps through the existing MCP Runtime, Plugin Center, Extension Installer/Runtime, Integration Registry, and Capability Broker.

**Architecture:** Exercise existing Core services with test-only local processes and a loopback Catalog fixture. Keep plugin permission review, extension private storage, and tool calls under existing Core policy and Broker boundaries.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk`, Plugin Center, Extension Runtime, TypeScript Harbor Plugins page, repository test aggregator.

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

- MCP fixture process exits or writes malformed protocol data; pin crashed/unavailable behavior in `scripts/test-mcp-host.mjs`.
- MCP config contains environment secrets; pin redaction in `scripts/test-mcp-registry.mjs` and the typed projection test.
- Catalog URL/package digest/manifest mismatch; pin closed installation in `scripts/test-plugin-center.mjs`.
- Extension schema submits an undeclared key or invalid enum/number; pin rejection in `scripts/test-extension-runtime.mjs`.
- Retired Bionic tools become enabled through bulk or per-tool toggles; pin denial and counts in `scripts/test-bionic-chat-plugin.mjs`.
- Real SnowLuma/gateway credentials are absent; record external execution as `NOT_RUN_ENVIRONMENT` instead of treating the local MCP fixture as gateway acceptance.

---

### Task 1: Exercise local MCP process lifecycle through the real host

**Files:**
- Create: `scripts/fixtures/mcp-stdio-server.mjs`
- Modify: `scripts/test-mcp-host.mjs`
- Modify: `scripts/test-mcp-registry.mjs`
- Modify: `scripts/run-all-tests.mjs` only if a new `scripts/test-*.mjs` suite is added

**Interfaces:**
- Consumes: `createStdioMcpConnection`, `createMcpRuntime({ servers, transportFactory })`, and `createIntegrationService({ mcpRuntime })`.
- Produces: a child-process fixture implementing MCP initialize/listTools/callTool over stdio, with deterministic close/crash behavior and no network listener.

- [x] **Step 1: Add failing assertions** for register, start, discovery, capability-gated invocation, disable, restart, crash, recovery, and redacted config projection using the stdio fixture.
- [x] **Step 2: Run `npm test -- --category runtime --category integration --category security`** and confirm actual process/lifecycle assertions fail.
- [x] **Step 3: Implement the fixture and minimal MCP service changes**; process cleanup must use the suite process-tree helper and terminate only the fixture process created by the suite.
- [x] **Step 4: Run `npm test -- --category runtime --category integration --category security`** and confirm all MCP local lifecycle assertions pass.
- [x] **Step 5: Check external SnowLuma/gateway availability separately**; record real execution as `NOT_RUN_ENVIRONMENT` when credentials or service are absent, and do not send fixture traffic to a production endpoint. Observed: local credentials are configured, but the loopback gateway connection was refused (ECONNREFUSED); external execution remains NOT_RUN_ENVIRONMENT.

### Task 2: Exercise Plugin catalog and package lifecycle over loopback

**Files:**
- Create: `scripts/test-support/plugin-catalog-fixture.mjs`
- Modify: `scripts/test-plugin-center.mjs`
- Modify: `src/plugin-center/service.js` only for failing behavior

**Interfaces:**
- Produces: `createPluginCatalogFixture() -> { catalogUrl, allowedHosts, close() }`; it binds only to `127.0.0.1`, serves a catalog and package built by the test, and refuses requests outside its own fixture origin.
- Consumes: `createPluginCenterService`, existing package SHA-256 verification, manifest validation, permission review, install/update/rollback/uninstall APIs.

- [ ] **Step 1: Add failing service assertions** for catalog/detail, package download, digest and manifest checks, permission review, install, enable, version update, rollback, uninstall, and offline-catalog unavailable state.
- [ ] **Step 2: Run `npm test -- --category runtime --category security`** and confirm lifecycle assertions fail.
- [ ] **Step 3: Implement the loopback fixture and only the missing service/UI state behavior**; the test fetch adapter must map the fixture origin to loopback and reject any non-fixture destination.
- [ ] **Step 4: Run `npm test -- --category runtime --category security`** and confirm Plugin lifecycle assertions pass.

### Task 3: Add manifest-backed Extension settings

**Files:**
- Create: `src/extension/settings.js`
- Modify: `src/extension/manifest.js`
- Modify: `src/extension/service.js`
- Modify: `src/extension/private-storage.js`
- Modify: `scripts/test-extension-runtime.mjs`
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Manifest property: `settingsSchema`, either absent or a bounded list of `{ key, label, type, required?, default?, options?, min?, max?, maxLength? }`; `type` is exactly `boolean | string | number | enum | secretRef`.
- Service methods: `ext.settings.describe({ id })`, `ext.settings.get({ id })`, `ext.settings.update({ id, values })`.
- Renderer result: public values plus `{ configured: boolean }` for `secretRef`; never return a stored secret value.

- [ ] **Step 1: Add failing manifest/runtime tests** for each supported type, invalid/duplicate keys, unknown fields, out-of-range values, empty schema, and secret set/clear/redaction.
- [ ] **Step 2: Run `npm test -- --category runtime --category security`** and confirm settings-schema assertions fail.
- [ ] **Step 3: Implement schema validation, settings persistence through `src/storage/json-file.js`, secret values through Extension private storage, and the typed Harbor settings form.** Hide its entry point when the validated schema is empty.
- [ ] **Step 4: Run `npm test -- --category runtime --category security`** and confirm schema, storage, and redaction assertions pass.

### Task 4: Make Bionic inventory and retired states explicit

**Files:**
- Modify: `scripts/test-bionic-chat-plugin.mjs`
- Modify: `scripts/test-capability-coverage.mjs`
- Modify: `src/integrations/catalog.js` only if registry facts are wrong
- Modify: `src/desktop/ui-service.js`
- Modify: `desktop-ui/src/bridge/typed-client.ts`
- Modify: `desktop-ui/src/app/HarborApp.tsx`

**Interfaces:**
- Consumes: `buildToolCatalog()`, `LEGACY_RETIRED_TOOLS`, and Integration Registry status.
- Produces: exact observed counts of 46 restored, 5 partial, and 2 legacy-unsupported tools; deprecated entries remain explicitly deprecated; replacement text appears only for a real registered replacement.

- [ ] **Step 1: Add failing assertions** that compare source catalog states, UI projection states, and bulk/per-tool enable behavior to those exact counts.
- [ ] **Step 2: Run `npm test -- --category security --category integration`** and confirm any inventory mismatch is visible.
- [ ] **Step 3: Correct only source facts/projection/rendering that fail those assertions**; do not restore unsupported process-control tools.
- [ ] **Step 4: Run `npm test -- --category security --category integration`** and confirm inventory and toggle assertions pass.
