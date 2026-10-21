# M2 Local Memory Implementation Plan

> Execute with superpowers:executing-plans inline, one TASK-ID at a time.

**Goal:** Offline memory with reviewable chat candidates and user-controlled persistence.
**Architecture:** Feature → Memory/Extraction Runtime → domain ports → SQLite.
**Tech Stack:** Existing RN/TypeScript/New Architecture/SQLite; no added dependency.
**Spec:** docs/superpowers/specs/2026-09-30-m2-local-memory.md

## Global Constraints

User authorizes continuous M2 execution, so no design/plan permission loop.
Remote is read-only. Existing clean checkout is reused on feat/m2-local-memory.
All scope is local-only. No implicit upload or prompt injection, M3, vector DB,
Memory Graph, sync, account or native feature. Native Gate results stay truthful.

## Review Focus

1. Upgrade/reopen must preserve M1 history and pinned memories.
2. Stale edits and automatic pin races must not overwrite newer user changes.
3. Empty/Unicode/literal wildcard searches and repeated pagination must be safe.
4. Conversation changes/deletion, duplicate/replayed confirmation and sensitive
   text must not persist an unreviewed or misleading candidate.
5. List refresh/filter races must not reset an edit draft or show stale results.

### Task 1: TASK-M2-001 Memory Schema

Files: domain/memory/Memory.ts, data/migrations/AppMigrations.ts, test/memory-schema.test.ts.
Produces MemoryRecord, MemorySource, MemoryKind, MemoryInput, MemoryPatch,
MemoryQuery and migration v2. Record has revision/pinned, immutable local scope.

- [x] Write tests for upgrade v1→v2, repeat migration and CHECK constraints.
- [x] Run npm test -- --runInBand src/test/memory-schema.test.ts; Expected FAIL missing memories table/version 2.
- [x] Add domain types and additive schema. Preserve chat and migration v1.
- [x] Run npm run check; Expected PASS. Update state and commit.

### Task 2: TASK-M2-002 Memory Repository

Files: domain/memory/MemoryRepository.ts, data/repositories/SqliteMemoryRepository.ts,
test/memory-repository.test.ts.
Produces create(input), get(id), search(query), update(id,patch,revision,actor),
pin(id,pinned,revision), delete(id,revision,actor), saveCandidate(input).
Actor is user/automatic. Updates/deletion check revision and pinned atomically.
saveCandidate deduplicates content+source without updating existing memories.

- [x] Write real SQLite tests: CRUD/ranking/literal search/filter/pagination,
      stale/automatic pin denial, delete, duplicate candidate, file reopen/isolation.
- [x] Run targeted tests; Expected FAIL missing repository.
- [x] Implement parameterized queries, bounded input, safe errors, transactions.
- [x] Run npm run check; Expected PASS. Update state and commit.

### Task 3: TASK-M2-003 Memory Runtime

Files: runtime/memory/MemoryRuntime.ts, security/MemoryPolicy.ts,
test/memory-runtime.test.ts, app/bootstrap/assembleServices.ts, runtime/session/MobileServices.ts.
Produces save/search/get/update/pin/delete and subscribe metadata-only events.
Consumes repository, validates all inputs, defaults local-only, explicit actors.

- [x] Test invalid scope/content/metadata, safe storage failures, revision/pin
      protection, observable IDs without content, and runtime composition offline.
- [x] Run targeted tests; Expected FAIL missing runtime.
- [x] Implement policy/runtime and production composition.
- [x] Run npm run check; Expected PASS. Update state and commit.

### Task 4: TASK-M2-004 Chat Memory Extraction

Files: runtime/memory/ChatMemoryExtraction.ts, domain/memory/MemoryCandidate.ts,
test/memory-extraction.test.ts, composition and service port.
Produces preview(sessionId), confirm(candidateId,editedContent), reject(id),
clear(); consumes ChatRepository and MemoryRuntime.

- [x] Test preview-only/no write/network, explicit user text, secret exclusion,
      confirmation source checks, edit/duplicate/replay/rejection and pinned safety.
- [x] Run targeted tests; Expected FAIL missing extractor.
- [x] Implement bounded offline candidates, one-use confirmation, provenance recheck.
- [x] Run npm run check; Expected PASS. Update state and commit.

### Task 5: TASK-M2-005 Memory UI

Files: features/memory/MemoryScreen.tsx, MemoryEditor.tsx, ChatMemoryReview.tsx,
features/chat/ChatHome.tsx, ChatScreen.tsx, test/memory-ui.test.tsx.
Consumes MobileServices.memory and memoryExtraction. UI never accesses SQL/native.

- [x] Test Memory navigation without provider, CRUD/search/kind/pin/source,
      confirm-delete and chat candidate explicit confirm/reject with draft retention.
- [x] Run targeted tests; Expected FAIL missing Memory UI.
- [x] Implement simple UI, request guards, source display and chat preview.
- [x] Run npm run check and both Metro bundles; Expected PASS. Native builds may
      return NOT_RUN_ENVIRONMENT. Update architecture/security/acceptance/state.
- [x] Independent final read-only review, fix important findings RED→GREEN,
      local commit and source archive. No M3.
