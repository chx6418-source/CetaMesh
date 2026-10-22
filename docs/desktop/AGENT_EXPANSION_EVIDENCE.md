# Agent expansion baseline and protocol evidence

Observed 2026-10-22 (Asia/Shanghai). This ledger records Task 1 observations, not completion of the eight-provider implementation. No prompt was sent to a real Agent, no login was attempted, no SDK/runtime was installed or upgraded, and no credentials or user configuration were changed. Version/help commands can attempt Codex's own temporary alias maintenance; this sandbox denied those incidental writes and the commands still exited successfully.

## Repository baseline

- Worktree: `D:/GIT- CetaMesh/comm-repair`; branch `codex/app-icon-refresh`.
- HEAD: `ee88b215bab4570f27866f57fa86493fe9b8ea26`.
- `git ls-files -u`: empty. `git rev-parse -q --verify MERGE_HEAD`: no merge head.
- Existing UI, documentation and test-runner edits were present before Task 1; see Task 1 report for the explicit inventory. They were preserved.
- Read current RULES, PROJECT_STATE and desktop ARCHITECTURE, then the existing contract, Broker, Registry, service, process launcher, Codex adapter, DSH adapter and staged DSH wrapper. Task identity remains independent of provider session identity; registration and availability never prove Task eligibility.

## Runtime discovery

`Get-Command` and the existing `findCliCandidates` logic were checked independently. Discovery is limited to PATH and the launcher's bounded known directories; an empty result does not prove absence from the entire machine. Runtime paths below are operational evidence, not UI DTO fields.

| Provider | runtimePath / actual discovery | Version | Executed argv | Authentication / native policy |
| --- | --- | --- | --- | --- |
| codex | `C:/Users/Administrator/AppData/Local/OpenAI/Codex/bin/a96ca4c1eee0cf35/codex.exe` | `codex-cli 0.163.0-alpha.11.1` | `--version`; `--help`; `exec --help`; `exec resume --help`; `app-server --help`; `app-server generate-json-schema --help` | Auth not inspected. Help advertises workspace-write; actual Windows sandbox enforcement and new App Server policy are NOT_RUN_ENVIRONMENT. |
| dsh | Get-Command: `C:/Users/Administrator/AppData/Roaming/npm/dsh.ps1`; existing launcher: sibling `dsh.cmd` | `0.1.5-rc.1` | `--version` | No gateway/auth/model/preset/session calls; readiness and native execution scope unverified. |
| claude | No command/candidate found; local module resolution for `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/claude-code` failed | No installed version proven | None | SDK/runtime missing from inspected scope; unavailable. No minimum supported version invented. |
| gemini | No command/candidate found | Not observed | None | Native ACP argv, installed protocol compatibility, auth and policy unverified; unavailable. |
| opencode | No command/candidate found | Not observed | None | Native ACP argv, installed protocol compatibility, auth and policy unverified; unavailable. |
| qwen | No command/candidate found | Not observed | None | Native ACP argv, installed protocol compatibility, auth and policy unverified; unavailable. |
| zcode | Task 1: no zcode/zencoder command/candidate found | Installed version not observed | None | Task 8 confirms an official protocol entry exists; installed version/schema/approval contract unverified. BLOCKED_PROTOCOL; unavailable. See ZCode evidence below. No private desktop state inspected. |
| workbuddy | No command/candidate found; CLI presence is not its API availability test | Not observed | None | No OAuth application, scope, endpoint or user grant inspected; API/native readiness unverified. |

`@agentclientprotocol/sdk` also failed local module resolution. This does not prevent implementing a bounded transport, but is not evidence of a validated installed Agent.

## Official protocol sources and compatibility boundaries

### Codex App Server

Official [App Server documentation](https://developers.openai.com/codex/app-server/) redirects to the current [ChatGPT Learn page](https://learn.chatgpt.com/docs/app-server). Its schema section explains that CLI-generated bindings match the generating binary version. It documents stdio startup, initialization, and thread/turn messages. The [official source README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) and [InitializeParams schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v1/InitializeParams.json) are additional sources; `main` is mutable and is not a schema pin for the local alpha binary.

Local help confirms default `stdio://`, explicit `--stdio`, and `--listen`. Schema help confirms `generate-json-schema --out <DIR>` and optional `--experimental`. Only help was invoked: no server launched, no schema generated, and no handshake performed. Therefore exact local schema hash, accepted initialization fields and session compatibility remain unverified. A later implementation must generate/pin the actual binary schema before claiming its compatibility. Existing exec thread IDs must not be blindly resumed through App Server.

### ACP v1

The official [v1 initialization contract](https://agentclientprotocol.com/protocol/v1/initialization) negotiates an integer major version and optional client capabilities before session creation. An unsupported selected version requires disconnect; omitted capabilities are unsupported. CetaMesh's approved scope accepts v1 only and must advertise only implemented file/terminal facilities. The [v1 schema](https://agentclientprotocol.com/protocol/v1/schema) links the downloadable release schema. The site also lists a v2 draft: that is outside the approved v1 scope. No concrete vendor binary or released schema artifact was pinned locally in this task.

### Claude Agent SDK

The [official TypeScript SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript) and [release v0.3.308](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.308) are public source evidence. The observed release page dated 22 October describes parity with Claude Code 2.1.308; this is a published version, not a locally tested compatibility floor. Neither package is installed in this worktree's module resolution scope. The large TypeScript reference fetch exceeded the browser content limit; it is not treated as locally validated type evidence.

The [official SDK permission guide](https://code.claude.com/docs/en/agent-sdk/permissions) is the policy reference. SDK permission callbacks/settings cannot by themselves establish Windows host isolation. Installed SDK types, runtime API, interrupt behavior, inherited MCP/hooks/plugins, SDK runner under SEA and native execution policy all still need verification. Do not enable Task execution based solely on the published release number or a mocked SDK.

### ZCode (Task 8, 2026-10-22)

The official [repository README](https://github.com/zai-org/ZCode/blob/main/README.en.md) lists desktop release v3.16.2 (2026-10-19) and includes Agent CLI/runtime source under apps/zcode-cli. This is public source evidence, not an installed version observation. The [usage guide](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/README.md) warns equal CLI version strings need not imply equal capabilities and calls for binary version, doctor output and commit/hash evidence. The [CLI package](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/package.json) has placeholder version 0.1.0; that cannot establish runtime compatibility.

The official [CLI reference](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md) explicitly identifies app-server as a protocol service entry. Ordinary --prompt supports text/json/stream-json, with stream-json using NDJSON and a final result record. Output shapes vary by build and some commands/errors return text or stderr. This confirms an external entry exists; it does not pin the bidirectional app-server request/event/approval schemas or establish ACP/Codex protocol compatibility.

The [session guide](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/06-sessions.md) documents ordinary prompt creating a new session and explicit --resume loading persisted history for another turn with matching cwd/data directory. Persisted CLI resume is distinct from attaching a currently running desktop session. [ADE Tools](https://www.zcode.network/en/docs/ADE-tools/) describes product Remote Control/Bot Channel entry points; a stable third-party live-attachment contract remains unverified. The private database is not a supported API and was not accessed.

The [permission guide](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/05-permissions.md) says prompt defaults to yolo, ask without an approval client fails, and plan is not an OS sandbox. The [official permission implementation](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/permission/service.ts) is available, but a future adapter must still trace its transport binding and confirm stop/disconnect resolution and inherited hooks/plugins/MCP scope. Source main links are mutable; no source commit or installed binary hash/schema was pinned.

Outcome: BLOCKED_PROTOCOL / PROTOCOL_PRESENT_UNVERIFIED_CONTRACT. Detection returns external_protocol_unverified, available=false and externalControl=false. Only health/capabilities are supported; execution methods remain unsupported, configure returns supported=false. New session, persisted resume and live attachment are not advertised by CetaMesh until exact runtime, transport, native permission and workspace boundaries are verified. Real ZCode E2E is NOT_RUN_ENVIRONMENT.

## Baseline verification

Command (unified repository runner):

```powershell
npm test -- --suite test-agent-provider --suite test-agent-broker --suite test-agent-provider-expansion --suite test-agent-native-security --suite test-codex-discovery --suite test-dsh-model-selection --suite test-codex-chat-snapshot
```

Initial sandbox run: **PASS 0 / FAIL 6 / NOT_RUN_ENVIRONMENT 1**. All six failures were runner `spawn EPERM`, before suite code ran. Approved escalation reran the identical command: **PASS 6 / FAIL 0 / NOT_RUN_ENVIRONMENT 1**. `test-codex-chat-snapshot` was skipped by the real-codex environment gate; it was not force-enabled because real prompting is outside Task 1.

The existing expansion suite already launches a real Node shim fixture under a spaced profile path, verifies missing GUI PATH/PATHEXT npm discovery, cancellation and standalone Node handling, and launches split-byte Chinese UTF-8 output. Task 1 strengthens the existing profile fixture with Chinese characters as well as spaces. No production defect was established by the baseline, so no speculative production fix or forced red phase was added. BOM framing belongs to the new protocol transport task, not a claim about the legacy fixture.

| Evidence category | Result | Limit |
| --- | --- | --- |
| Implementation | Task 1 evidence and baseline fixture only | No new provider implementation or capability enabled |
| Fixture/Contract | 6 PASS / 0 FAIL after approved escalation | Synthetic subprocesses and mocked providers; final rerun recorded in Task 1 report |
| Real E2E | NOT_RUN_ENVIRONMENT | No authentic create/send/stream/cancel/resume cycle; help/version discovery is not E2E |

Staging is a working copy, not a host security sandbox. Broker Owner approval, Workspace canonical identity, Task/session binding, import approval and native policy fingerprints remain required. Help-advertised sandbox flags are not proof of actual enforcement; unresolved policy/config inheritance keeps the affected new adapter unavailable.

## Final review correction wave — Codex F1 (2026-10-22)

The conditional App Server adapter now captures raw supervisor ownership internally and publishes/returns one stable facade to shared ACP lifecycle. Shared handle identity guard remains intact. Registered fixture reproduced ACP_LAUNCH_HANDLE_MISMATCH before correction, then verified callback-before-return success, callback-then-throw raw shutdown, staging retained until raw observed exit, and retained ownership/close retry when exit confirmation fails. Fresh scoped npm test for test-codex-app-server, test-agent-acp, test-agent-rpc-transport and test-error-hygiene: **4 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**. This is fixture evidence only; actual native launch/security/model E2E remains unavailable and rollout remains disabled. Full-suite evidence belongs to the controller's separate run. See task-7-report.md in the local ignored SDD execution folder for red/green detail.

F2 Minor was corrected by the controller in HarborApp.tsx: emitted Claude reason runtime_security_unverified now maps to “Claude 本机运行时与权限策略尚未验证” while preserving the old alias. Controller-provided build:ui evidence is fresh PASS (final-ui-build-after-review.log); no UI edit/build was performed by the F1 worker. Joint scoped F1/F2 re-review remains the review closure gate.

## Implementation-stage evidence after the Task 1 baseline

The discovery and baseline sections above describe Task 1's observations. Later authorized source work established the following narrower facts; they supersede the corresponding "not yet generated/inspected" statements for implementation-stage evidence, without converting them into real-runtime acceptance.

- The actual installed Codex 0.163.0-alpha.11.1 binary subsequently generated 318 JSON schema files using its documented app-server generate-json-schema command. The plan-local codex-schema/SHA256SUMS.txt records individual file hashes; the SHA256 of that checksum index is FCDEEC266BD28CCAAA7AD5A1BE810B0CA5666F7200E6EB8107365B1F32ED075D. The adapter's pinned fields were checked against this output. No App Server model session or native security exercise was performed.
- The official @anthropic-ai/claude-agent-sdk@0.3.308 tarball was obtained and statically inspected in the ignored plan evidence folder. Tarball SHA256: BCFF3EAD267F10F5C9ED4BF9234174311129381AB337DAE2E6B2309A090043DF. Its query export and compiled optional-resource loader were checked without invoking query. No shared node_modules installation was performed; actual Claude executable, native policy and SEA loading remain unverified.
- Eight provider IDs are registered in fixed order: dsh, codex, claude, gemini, opencode, qwen, zcode, workbuddy. Registration is not availability: existing Codex legacy exec remains the default, new App Server/ACP/SDK tasks require trusted runtime and native security evidence, ZCode execution remains unsupported, and WorkBuddy's account API helpers are not a local Workspace Task implementation or a public Renderer write endpoint.
- Controller verification after the final F1/F2 correction and scoped independent review: registered test-codex-app-server plus test-agent-expansion-provenance returned PASS2 / FAIL0 / NOT_RUN_ENVIRONMENT0; build:ui returned exit0 after the Claude reason mapping correction. The whole-tree test result is recorded in AGENT_EXPANSION_ACCEPTANCE.md when complete. No new Core/SEA or RC was built.

## Full-suite integration corrections (2026-10-22)

Four full-run failures were reproduced through the registered runner (0 PASS / 4 FAIL), then corrected: current eight-Provider registry fixture expectation; transparent router health refresh forwarding; exact legacy bridge.js basename import guard with positive/negative checks; and Codex legacy-default stopped-task recovery accepting transport-unknown only before the existing exact native stop proof and all recovery/approval/handoff fences. No unknown native session routes to legacy. Native-default unknown transport remains rejected before legacy proof; unsafe task reasons remain blocked. Fresh scoped nine-suite verification (the four failures plus Codex AppServer/ACP/RPC/native-security/error-hygiene): **9 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**. The controller's earlier 169-suite result remains 155 PASS / 4 FAIL / 10 NOT_RUN_ENVIRONMENT as historical red evidence; scoped green does not replace a full rerun or real new-provider E2E. Exact details and test commands are appended to local task-7-report.md.

### Aggregate review R1 correction

The current legacy default alone was insufficient historical evidence: new native snapshot failure shared the exec post-exit error code. Shared ACP Domain now emits ACP_STAGING_READ_FAILED consistently in terminal events and status, preserving legacy STAGING_READ_FAILED as the unchanged exact exec post-exit proof. Registered regression reproduces actual native staging failure through capability Follow to persisted Task.note, restarts actual Core with legacy default while raw native exit is unconfirmed, and confirms Owner cancellation remains denied/Task blocked. Red demonstrated incorrect cancellation before the fix. Final fresh scoped nine suites: **9 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT**, including old exec recovery and all existing safety fences. Exact red/green command/output appended to aggregate-regression-test.log; R1-only independent review pending. Controller confirms no released native histories require migration. Production/native E2E and original full-run evidence boundaries remain unchanged.
