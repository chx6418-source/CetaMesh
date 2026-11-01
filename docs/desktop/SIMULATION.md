# Native Simulation

Simulation is an optional Core domain presented in Chat as **仿真聊天** and
**项目协作**. Ordinary Chat and the existing QQ/Bionic channel remain separate.
QQ, SnowLuma and DSH are not prerequisites. Generating a reply requires a
configured Model Provider; missing credentials are an error, never a simulated
success. Disabling an external connector does not disable native rooms.

The optional external path now uses the neutral OneBot adapter, disabled by default
with empty endpoints. Owner configuration, integration enablement and an explicit
connection request are required. SnowLuma-specific installation, detection, process
management, configuration, plugin and MCP entrypoints are retired; their old IDs
are rejected rather than mapped to OneBot. CetaMesh neither uninstalls external
gateways nor terminates their or QQ's processes.

## Ownership and execution

- `src/simulation/service.js` schedules bounded discussion turns through the
  existing Model Runtime. It does not create an executor per fictional role.
- `room-store.js` stores room transcripts, pending requests, usage reservations,
  role revisions and Task references using the existing JSON storage primitive.
  It is not a second Task store or long-term Memory database.
- `persona-assets.js` owns immutable role revisions, full source, hashes,
  section/example indexes and reversible asset imports. Personality and tool
  metadata are context, not a principal or an authorization grant.
- `project-bridge.js` creates queued Tasks and requests isolated Git Worktrees
  through the existing Workspace and Capability Broker. The existing Task UI
  controls dispatch and independent outcome verification.
- Only the trusted local `ui.simulation.*` allowlist exposes this domain.
  A Channel or plugin does not gain these Owner UI methods automatically.

The first five scenes are free conversation, brainstorming, product discussion,
project development and code review. Speaking preference, interests, mentions,
cooldown and silence affect speaker selection; an automatic discussion is not
an unconditional round robin. A user can interrupt, pause, end or cancel it.
Late model replies cannot commit after the generation has been invalidated.

## Budgets and recovery

Automated discussion needs explicit finite turn, token, time, call and estimated
cost limits, with a provider/model-bound price reference. One manual reply can
run without a tariff, in which case monetary usage stays unknown. Price evidence
is an estimate, not a provider invoice or a promise about external billing.
Unknown usage remains visible and reservations remain charged against limits.

Requests have stable identities and input fingerprints. A repeated request with
the same input returns its stored state; changed input conflicts. A request left
running on process loss becomes unknown and is never replayed automatically.
The Owner may explicitly acknowledge that uncertainty and start a **new** bounded
run; that does not reconcile or discard the previous request. Storage errors
pause mutation and preserve the existing durable evidence.

Current bounds include 100 rooms, 1,000 messages per room and a 16 MiB room
store; paginated responses have additional byte bounds. Capacity is an explicit
error. Automatic room archival/deletion and provider invoice reconciliation are
not implemented. Do not edit or replace a damaged store to conceal a failure.

## Persona fidelity and migration

The library retains the complete original source up to 256 KiB per revision,
including original bytes, source hash, provenance and version history. A role
can have up to 512 indexed dialogue examples. Context construction uses stable
personality material plus relevant source segments and positive/negative
examples within a budget, with traceable selection and omissions. Negative
examples are marked as non-recommended, not suggested answers.

The role drawer provides source, examples, behavior, memory, context preview,
model trial, version restore and import/export. Export is a complete role bundle.
Legacy inventory is read-only; importing requires explicit ownership confirmation
and the expected source hash and preserves a backup. Private QQ transcripts and
Social Memory are not silently imported into Simulation or global Memory.
Role and room Memory are scoped through the existing Memory service; arbitrary
global/user scopes are rejected. Model inference is a candidate until confirmed.

Preserving source and passing fixtures do not prove human persona fidelity.
Paired actual-model comparisons must identify the baseline (for example the old
role-hint projection versus a live historical DSH session), report automatic
measurements separately, and retain Owner review as pending until it occurs.
The old Bionic migration is incomplete until this review passes.

Retiring the connector does not rewrite `roles/*.md`, `state/current-role.json`,
social memories or private transcripts. The four preset files in `whale-chat` and
`whale-chat-v2` receive only tool-namespace and corresponding reference revisions;
original backups and hash comparisons remain in the private development archive.
This compatibility revision is not a completed persona migration or fidelity review.

Legacy `config.snowluma` is not connection authority. A separate trusted Owner UI
can preview and confirm endpoint-only migration after an original-byte hash check
and backup. The new OneBot configuration stays disabled, carries no copied tokens
and cannot overwrite an existing configuration. Tokens must be entered again;
saving or migrating does not connect. This connector migration does not import
persona or conversation data and does not promote CP-080 beyond PROPOSED or add
a wire version.

## Real project collaboration

Creating a Task saves a proposal; it does not execute it. Review the requirements
and acceptance criteria, then explicitly start. A clean Git source is required
for isolated Worktree creation so uncommitted work cannot be silently omitted.
Non-Git Workspaces remain usable within their ordinary boundaries.

The optional project-test checkbox only permits this Task to **request**
`test.run`; each invocation still requires the normal exact Broker approval.
Concurrent starts with different executor, model or test-consent inputs conflict.
File writes retain the full-file raw-byte `expectedHash` precondition, normal
approval and Workspace boundaries. A partial read is not a valid write baseline.
The room displays delivered only for a completed Task with independent
`VERIFIED` evidence. A role's claim or a successful model request is insufficient.
Interrupted real execution is recovered in Tasks, rather than rerunning the
entire project through a new room command.

## Validation

Use root `npm test -- --suite test-simulation-persona --suite
test-simulation-runtime --suite test-simulation-project --suite
test-simulation-integration --suite test-simulation-ui` (one shell line).
All new suites are registered in the root runner. UI rendering checks, native
WebView2 acceptance and actual-model acceptance are distinct evidence.

`test-real-simulation` is opt-in with `CETAMESH_TEST_REAL_SIMULATION=1` and
`CETAMESH_SIM_SCENARIO=chat|group|project`. It uses the configured provider secret
reference, synthetic input and an isolated state/Workspace; it does not print
credentials. Real project acceptance can modify only its disposable fixture and
uses normal approvals. Evidence and screenshots belong in the private development
archive, not the public source tree. Source validation does not update the user's
installed application or lift Defender RELEASE HOLD.
