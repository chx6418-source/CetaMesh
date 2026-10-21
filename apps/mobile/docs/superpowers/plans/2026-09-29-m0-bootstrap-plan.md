# CetaMesh Mobile M0 Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish a clean React Native + TypeScript CetaMesh Mobile foundation that can be tested and extended safely, with Android priority and iOS-compatible boundaries.

**Architecture:** Start with the React Native New Architecture template, then add only the M0 foundations required by the authoritative mobile workplan. Keep UI, runtime, domain, data, native, protocol, security, and shared boundaries explicit; later tasks add behavior behind those interfaces.

**Tech Stack:** React Native, TypeScript, React Native New Architecture, Jest, ESLint, SQLite foundation, Kotlin/Swift native project scaffolding.

**Spec:** `docs/roadmap/CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md`

## Global Constraints

- Android is the priority platform; public interfaces remain iOS-compatible from day one.
- React Native New Architecture is required.
- Do not implement Chat, Memory, Desktop Sync, plugins, Agent, Social, Marketplace, or other Deferred work during M0.
- Device capabilities must cross Capability Runtime and Permission Policy; no feature may call concrete native APIs directly.
- Secrets and device private keys must not be stored in ordinary SQLite, source, or logs.
- SQLite is the formal business database; schema versioning and migrations must be present before business tables are added.
- Test failures or unavailable verification must not be reported as PASS.
- The GitHub repository is read-only for this work; no push or remote mutation is permitted.

## Review Focus

- Project initialization must leave both `android/` and `ios/` present, even when native build tools are unavailable; test with filesystem assertions and record environment limits.
- React Native must be configured for New Architecture; test the relevant project configuration instead of relying on defaults.
- TypeScript, Jest, and lint must be independently runnable; test the exact npm scripts and a minimal bootstrap test.
- The root must remain free of Desktop/WhaleBridge/QQ/DSH runtime imports; test the scaffolded package and source tree for accidental coupling.
- The first UI must stay intentionally minimal and not pre-implement later product behavior; test only startup-safe bootstrap output.

### Task 1: Initialize React Native Project

**Files:**
- Create: generated React Native project files under the repository root, including `android/`, `ios/`, `package.json`, `tsconfig.json`, Jest, and ESLint configuration.
- Create: `AGENTS.md`
- Create: `PROJECT_STATE.md`
- Create: `src/app/bootstrap/AppBootstrap.tsx` and `src/test/bootstrap.test.tsx` after the generated template is verified.

**Interfaces:**
- Consumes: no prior project code.
- Produces: a runnable React Native TypeScript project, Android/iOS native project scaffolding, and the baseline npm commands `typecheck`, `lint`, and `test`.

- [ ] Generate the React Native TypeScript New Architecture project without overwriting the existing roadmap.
- [ ] Verify the generated files and configuration before adding product code.
- [ ] Write the minimal bootstrap test first and run it to confirm the expected missing-module failure.
- [ ] Implement the minimal bootstrap screen and app entry wiring, with no Chat or future runtime behavior.
- [ ] Run typecheck, lint, unit test, and native project presence/configuration checks.
- [ ] Record PASS versus `NOT_RUN_ENVIRONMENT` in `PROJECT_STATE.md`; do not mark the task DONE unless all required checks available in this environment pass.

### Task 2: Architecture Skeleton

**Files:**
- Create: `src/app/`, `src/features/`, `src/runtime/`, `src/domain/`, `src/providers/`, `src/native/`, `src/data/`, `src/protocol/`, `src/security/`, `src/shared/`, and `src/test/` boundary files.
- Create: `docs/architecture/MOBILE_ARCHITECTURE.md` describing only implemented M0 boundaries.

**Interfaces:**
- Consumes: the project created by Task 1.
- Produces: compile-checked index/interface files with dependency direction that prevents Feature → concrete Native Provider coupling.

- [ ] Add one meaningful interface or placeholder per required boundary.
- [ ] Add a compile/test guard for the dependency direction.
- [ ] Run typecheck, lint, and unit tests.
- [ ] Update `PROJECT_STATE.md` with exact verification and the next task.

### Task 3: Error and Logging Foundation

**Files:**
- Create: `src/shared/errors/CetaError.ts`, `src/shared/errors/CetaErrorCode.ts`, `src/shared/logging/StructuredLogger.ts`, and focused tests under `src/test/`.

**Interfaces:**
- Consumes: the boundary skeleton from Task 2.
- Produces: `CetaError`, `CetaErrorCode`, structured logging context, trace IDs, and recursive secret redaction.

- [ ] Write tests for redaction, observable ordinary fields, standard Error behavior, and trace context.
- [ ] Implement the smallest API satisfying those tests.
- [ ] Run the focused test and the full unit suite.
- [ ] Update `PROJECT_STATE.md`.

### Task 4: SQLite Foundation

**Files:**
- Create: `src/data/database/` bootstrap and migration interfaces, `src/data/migrations/` initial migration, test database adapter, and focused tests.

**Interfaces:**
- Consumes: the data boundary from Task 2 and errors from Task 3.
- Produces: schema versioning, repeatable migrations, isolated test database setup, and no destructive reset path.

- [ ] Write migration tests for first creation, upgrade, repeat execution, and test/real database isolation.
- [ ] Implement the smallest SQLite adapter compatible with the React Native runtime and test environment.
- [ ] Run data tests plus the complete M0 gate.
- [ ] Update `PROJECT_STATE.md` and stop at the M0 gate; do not start M1 until explicitly governed by the roadmap after M0 passes.

