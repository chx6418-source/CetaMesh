# CetaMesh Intelligence Runtime — Product Context 1.0

## Delivered scope

This slice adds a stable CetaMesh identity prompt and a bounded Product Context projection for the native Model Runtime Chat path and the CetaMesh Managed Agent path.

- Standalone Chat receives the identity prompt and a JSON Product Context system message after Smart Router resolution and before Model Runtime streaming. The messages are assembled for that request and are not written to Chat history.
- Managed Agent receives the identity prompt and freshly resolved Product Context before each inference step. Its existing one-command JSON protocol remains in place. Context is not appended to its stored conversation messages.
- Chat context follows only `record.taskId` and `record.config.workspaceId`. Missing or stale links produce missing facts; the active Workspace and other Tasks are never substituted.
- Managed Agent context follows the live `(provider, sessionId)` Task binding and current Task principal. Only registered capabilities with the current Task grant are marked requestable. Execution, permission checks, and approval continue through the Capability Broker.
- Capability registration, availability, grants, and requestability are represented as separate facts. Provider health is reported as unknown unless already known; context construction does not probe external Agent providers.
- Task and Workspace facts use explicit allowlists. Absolute roots, Workspace settings, recent files, unrelated history, and secret fields are excluded. Task Memory references are resolved through the existing Memory policy; unavailable or unauthorized references are omitted.
- Product Context is serialized deterministically and bounded to 12,000 characters by default. Its identity and authorization labels are kept ahead of optional descriptions when compaction is needed.

## Verification

Verified on 2026-10-09 with the repository entry point `npm test`:

- 77 suites discovered
- 68 passed
- 0 failed
- 9 reported as `NOT_RUN_ENVIRONMENT`

The 9 environment-gated suites require the legacy bridge, core distribution artifacts, desktop shell debugging, a gateway, network access, or release distribution artifacts that were not present in this environment.

## Deferred scope

This slice does not add arbitrary model-callable tools to standalone Chat, broader Task routing or creation behavior, UI changes, or persistent Product Context storage. Smart Router behavior and capability execution policy are unchanged.
