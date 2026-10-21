# M1 Standalone Chat Implementation Plan

> Execute inline, one TASK-ID at a time with test-first verification.

**Goal:** Configure a provider, create independent chats, select model/reasoning/mode, stream, cancel/retry, and restore persisted sessions without Desktop.
**Architecture:** UI → Chat/Session/Provider use cases → domain ports → SQLite/HTTPS/secure storage. Composition only in app/bootstrap. Attachment input → Capability → one-use policy → native picker.
**Tech Stack:** Existing RN New Architecture + TypeScript + Nitro SQLite; minimal Keychain and picker adapters.
**Spec:** docs/roadmap/CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md sections 6, 7, 10, 11, 17, 23–26, 29.

## Global constraints / ruling

- User on 2026-09-29 explicitly said “先放着，完成 M1”: proceed with M1 implementation while M0 native validation remains BLOCKED/NOT_RUN_ENVIRONMENT. This does not waive security or turn any native test green.
- Follow supplied architecture, no new architecture approval cycle; user instructed continuous task-by-task execution.
- Existing local checkout is retained on feat/m1-standalone-chat; no remote writes or Desktop changes.
- No M2 Memory, M3 pairing, full M4 capabilities, agents, sync, plugins, or unrestricted native access.
- Model credentials never in SQLite/logs. HTTPS endpoints only; raw provider responses/errors not logged.
- Smart is model-only at M1. Attachment foundation supports bounded images/text; unsupported file types fail explicitly.
- UI/runtime/persistent state separated; no global store or DI framework.

## Review focus

1. Abort/timeout during streaming must end request, persist partial status and allow retry without duplicating the user turn.
2. Persistence after process death must retain history/settings and recover unfinished assistant messages.
3. Untrusted SSE, provider failures and credential errors must not leak bodies or secrets.
4. Unknown capabilities, cancelled pickers, oversized/unsafe files must not read arbitrary local paths or upload implicitly.
5. Fresh native entry must actually bootstrap database/runtime; test seams must not replace production wiring.

### Task 1: TASK-M1-001 Provider

Files: domain/model/ModelProvider.ts, runtime/chat/ProviderRegistry.ts, providers/model/CompatibleProvider.ts, providers/network/XhrTransport.ts, test/model-provider.test.ts.
Interfaces: ModelProvider.listModels/chat/stream; ChatRequest{modelId,reasoning,messages,signal,timeoutMs}; ChatChunk discriminated delta/done. CredentialReader.get(ref); HttpTransport.json/stream.

- [x] Write/run failing tests: SSE chunk boundaries/CRLF, malformed data, HTTP unauthorized, abort, timeout, registry duplicate/missing, reasoning unsupported, HTTPS-only URL.
- [x] Implement domain contracts, registry, bounded transport, SSE parser, compatible provider. No secret persistence yet.
- [x] Run npm test -- --runInBand, npm run typecheck, npm run lint; expected PASS. Update state/commit.

### Task 2: TASK-M1-002 Credentials

Files: security/SecureStorage.ts, native/secure-storage/KeychainStorage.ts, runtime/session/ProviderSettings.ts, test/provider-settings.test.ts.
Interfaces: SecureStorage.set/get/delete, ProviderConfigRepository.list/save, ProviderSettings.save(config,secret)/removeSecret/list.

- [x] Tests first: write/read/delete roundtrip, failures sanitized, validation before secret write, no key in config, missing secret unauthorized.
- [x] Install isolated Keychain adapter (Android Keystore/iOS Keychain); no insecure fallback. Keep provider config nonsecret.
- [x] Full unit/typecheck/lint PASS; native secure storage smoke NOT_RUN_ENVIRONMENT until device available. Record state/commit.

### Task 3: TASK-M1-003 Repository

Files: domain/chat/ChatRepository.ts, data/repositories/SqliteChatRepository.ts, SqliteProviderRepository.ts, migrations/AppMigrations.ts, test/chat-repository.test.ts, test/helpers/NodeDatabase.ts.
Interfaces: ChatSession config per session; ChatMessage with role/status/turn IDs; create/rename/archive/delete/list/messages pagination, beginTurn/finishTurn/recoverInterrupted.

- [x] Real SQLite tests first: CRUD, pagination, isolation, parameterized hostile titles, migration rerun, file-backed close/reopen, rollback, interrupted recovery, secret-free provider rows.
- [x] Migration v1 adds only providers/sessions/messages. Serialized repository transactions; no destructive reset. SessionRuntime validates selections.
- [x] Full tests/typecheck/lint PASS; state/commit.

### Task 4: TASK-M1-004 Runtime

Files: runtime/chat/ChatRuntime.ts, test/chat-runtime.test.ts.
Interfaces: send(sessionId,text,attachments?), cancel(sessionId), retry(sessionId), subscribe(events). Dependencies injected registry/repository, no native imports.

- [x] Tests first: multi-turn context, stream events, partial cancel/error persisted, duplicate send rejected, retry uses same user message, no failed assistant in context, process recovery, listener disposal.
- [x] Implement state transitions and correlation IDs; all failures CetaError; bounded context, no silent history truncation.
- [x] Full tests/typecheck/lint PASS; state/commit.

### Task 5: TASK-M1-005 UI

Files: app/bootstrap/createServices.ts, app/bootstrap/MobileApp.tsx, features/chat/ChatScreen.tsx, SessionList.tsx, features/profile/ProviderForm.tsx, App.tsx, test/chat-ui.test.tsx.
Interfaces: injected AppServices; async DB bootstrap to ready/error; UI only runtime/use-case ports.

- [x] Tests first: fresh setup, validation, session creation/config persistence, send/stop/retry, restore history, database bootstrap error.
- [x] Simple accessible UI, provider model discovery + manual ID fallback, mode/model/reasoning per session, list rename/archive/delete, page loading. Key field cleared on save/unmount, no key redisplay.
- [x] Full tests/typecheck/lint/Metro bundle PASS where executable; state/commit.

### Task 6: TASK-M1-006 Attachments

Files: domain/capability/Attachment.ts, security/AttachmentPolicy.ts, runtime/capability/AttachmentRuntime.ts, native/files/PickerProvider.ts, features/chat attachment UI, test/attachments.test.ts.
Interfaces: one-use grant bound to file.pick/photos.select; native picker returns only selected bounded bytes; attachment typed image/text payload; never accept arbitrary URI from model/UI.

- [x] Tests first: unknown DENY, grant replay DENY, cancelled/denied, size/type/scheme validation, no upload before send, session restore attachment content.
- [x] Install minimal native pickers/file reader behind provider. Device OS selection + explicit app confirmation. Only text/image content sent, no PDF extraction or executable evaluation.
- [x] Run complete gate, independent review, fix important findings with regression tests, update architecture/security/acceptance/state. Mark device/real API checks NOT_RUN_ENVIRONMENT; no M2.
