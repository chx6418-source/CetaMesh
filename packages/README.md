# Shared packages

This directory reserves a home for stable protocol/types/SDK packages. It is not
an npm or Cargo workspace and contains no shared runtime at this migration stage.

Unified Pairing v1.1 is the verified cross-platform contract:
`../docs/protocol/UNIFIED_PAIRING_V1_1.md`. Desktop fixtures remain at
`../fixtures/pairing`; Mobile fixtures remain at
`../apps/mobile/src/test/fixtures/pairing`. The registered monorepo contract suite
checks byte parity without changing React Native/Metro packaging assumptions.

Device Mesh, Agent, Task, Memory, Capability, Sync and Extension implementations
remain platform-owned. Equal names do not establish wire compatibility. No
Desktop runtime is copied into Mobile. Future extraction must preserve explicit
authorization, Local Only memory, trust/permission separation and independent startup.
