# CetaMesh Mobile Agent Rules

- The repository roadmap under `docs/roadmap/` and the approved current
  implementation plan are authoritative. Process exactly one `TASK-ID` at a
  time; do not implement items marked Deferred or pull work forward from a
  later phase.
- CetaMesh Mobile is an independent React Native/TypeScript node. Android is
  first priority, but all public contracts and composition must remain
  iOS-compatible. Do not copy Desktop code into Mobile.
- Preserve Feature-oriented Clean Architecture: Feature → Runtime → Domain
  interface → Provider/Repository → Infrastructure. Features must not import
  concrete Native, Provider or Data implementations.
- Native capabilities must go through Capability Runtime and Permission
  Policy. Unknown capabilities default to DENY. Advertisement is not
  permission; Trust is not Presence; Task is not Session.
- Model, Task, Memory, extensions and remote peers may not directly call
  Android/iOS system APIs. Use Kotlin/Swift providers behind the shared
  capability contracts. Do not add unrestricted shell, arbitrary native
  bridges, downloaded JavaScript or executable payloads.
- Secrets, API keys, pairing material and device private keys use secure
  storage. Never put them in ordinary SQLite, logs, Push payloads, event
  summaries or protocol diagnostics.
- Memory defaults to Local Only. Authorize scope before Memory retrieval,
  ranking or synchronization. Remote Capability requests are finally checked
  by the local device policy before a local provider runs.
- Keep Task state CetaMesh-owned; Provider and Session are replaceable
  execution references. Sync Task metadata only; never silently sync chat
  transcripts or the SQLite file.
- Do not change protocol fields casually. Keep protocol/data types independent
  of React Native UI so they can later move to `@cetamesh/protocol`.
- Test failures, unexecuted native checks and unavailable peer checks must not
  be recorded as PASS or marked DONE. Use `NOT_RUN_ENVIRONMENT` or
  `PENDING_NATIVE_VERIFICATION` with the reason.
- Avoid unrelated refactors, heavy new dependencies and global-state
  shortcuts. Keep UI State, Runtime State, Persistent State and Remote/Sync
  State separate.
