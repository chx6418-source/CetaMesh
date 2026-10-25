# M1 Standalone Chat — implemented architecture

The authoritative roadmap remains CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md.
The user authorized M1 work while M0 native verification is deferred; this is not a M0 PASS.

## Composition and dependency direction

App.tsx → MobileApp → createServices → assembleServices initializes SQLite,
runs versioned migrations, recovers unfinished turns, creates repositories and
runtime instances, and registers HTTPS model providers. UI receives MobileServices.

- Feature UI calls ProviderSettings, SessionRuntime, ChatRuntime or the
  Capability Runtime. Attachment selection is routed as `file.pick` or
  `photos.select` through the shared Capability Policy.
- Runtime depends on domain interfaces and security policies.
- SQLite repositories implement domain ports and serialize transactions through a shared connection queue.
- CompatibleProvider implements ModelProvider through HttpTransport and CredentialReader.
- XhrTransport uses RN incremental text; SseDecoder validates bounded frames.
- KeychainStorage is the sole production credential adapter.
- `AttachmentCapabilityProvider` adapts the existing `PickerProvider` to the
  shared Capability contract; the generic Runtime authorizes it before any
  system picker is opened.
- Only app/bootstrap imports concrete native/data/provider implementations to assemble the graph.
- ProtocolEnvelope remains UI-independent; no Desktop connection is involved.

## State ownership

UI: drafts, staged attachments, selected route and local form fields.
Runtime: active requests, cancellation, trace/event IDs and subscribers.
Persistent: provider metadata, per-session configuration, messages, status and bounded attachment content.
Remote: HTTPS request/stream only; no sync queue, login or remote state store.

## SQLite schema v1

M0 schema_version remains. M1 adds model_providers, chat_sessions and chat_messages.
Messages have a stable id, increasing sequence, reply_to, status and optional typed error.
A partial unique index permits only one streaming reply per session.
Only credential references are stored; no API secret column exists.

Create, rename, archive/unarchive, delete and list/pagination are implemented.
Deletion explicitly deletes the owned messages in a transaction. It never resets the database.
Interrupted replies become failed on bootstrap and can be retried using the original user turn.
Session mode/model/provider/reasoning persist independently.

## Streaming and lifecycle

User message and assistant placeholder are committed together before the request.
Each delta checkpoints partial content. Completed, failed and cancelled states are durable.
Runtime cancellation races the next iterator step, including stalled providers.
Retry resets only the latest failed/cancelled assistant; it does not duplicate the user message.
Closing services cancels and drains runtime work before closing SQLite.
Conversation history is bounded to 200 messages and an 8 MiB serialized request.
The app reports oversized conversations explicitly rather than silently discarding history.

## Supported provider contract

HTTPS base URL without userinfo/query/fragment, with /models and /chat/completions.
SSE text deltas and [DONE] completion; abort, timeout and standard errors.
Model list discovery has manual Model ID fallback.
Discovery responses are bound to the current provider; obsolete requests are ignored.
Page loading is guarded and deduplicated. Retrying a reply preserves the next draft.
Reasoning is opt-in per provider: fast→low, standard→medium, high/max→high.
Smart mode is model-only in M1. Tool/Agent orchestration is not implemented.
Server support for vision/reasoning varies; live provider verification is still pending.

## Attachment foundation

photos.select accepts JPEG/PNG/WebP up to 2 MiB, using a single system selection.
file.pick accepts supported plain-text/CSV/JSON/Markdown content up to 128 KiB.
At most four attachments per turn. Binary/PDF/office parsing is not implemented.
Picker URI is never exposed as a caller-controlled path or persisted as the attachment.
Selected bounded bytes are stored with the local message; only Send uploads content.
Native selected URIs are copied into a local cache file for stat/read, with cleanup on completion/failure.
All later turns include previous sent attachments as part of the conversation context.
The M1 attachment contract remains the bounded input implementation used by
the M4 file and photo capabilities.

## Remaining verification

Native APK/iOS builds, native secure storage and system picker behavior need a provisioned device environment.
Metro JS bundles and Node SQLite tests do not substitute for those checks.
