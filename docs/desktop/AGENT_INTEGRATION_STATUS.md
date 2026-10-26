# Agent integration status

Updated: 2026-10-26. This page describes the current Desktop source and verification boundaries. It does not establish general runtime availability or a new signed release.

## Registered providers

| Provider | Current implementation | Availability boundary |
| --- | --- | --- |
| DSH | Existing staged Provider retained | Requires its configured runtime and task authorization |
| Codex | Existing exec transport stays default; App Server adapter added | App Server requires a verified version/schema and native policy; old sessions are not blindly migrated |
| Claude | Configured native Claude Code runtime, pinned SDK 0.3.308, supervised private runner and all-tool approvals | Requires a real console CLI and explicit API configuration; desktop GUI installation is insufficient. Real account execution is not verified |
| Gemini CLI | Shared ACP, official 0.65.0 discovery/handshake and native policy probes | This version omits exact tool input from ACP permission requests; native_input_unverified keeps Task execution unavailable |
| OpenCode | Bundled CLI discovery, verified 2.1.4 ACP and private native approval policy | Requires explicit model/API configuration, verified runtime identity and Owner execution consent |
| Qwen Code | Verified 0.26.1 coding CLI, ACP and explicit builtin-tool permission policy | Requires the coding CLI, standalone Node, explicit model/API configuration and Owner execution consent |
| ZCode | Protocol presence is recognized; execution unavailable | Exact external control, version, approval and workspace contract unverified |
| WorkBuddy | Fixed-origin, bounded private API client | Real OAuth/account authorization and local Workspace execution remain unavailable |

Registration is not execution permission. The existing Broker/Registry, Owner approvals, Workspace identity and Capability-mediated imports remain authoritative. Staging is a working copy, not an operating-system sandbox.

Desktop-client installation is reported separately from CLI installation and Agent readiness.
Bounded local binary checks and the Claude Windows Store package query identify supported
installation forms; discovery errors remain unknown. Installed clients with unverified
connectors display an installed/pending state. A desktop executable is never launched as
an assumed CLI, and installation evidence does not satisfy protocol, SDK or native-policy gates.

## Native permission mode and setup

The Owner-approved Windows mode is native-permissions. It explicitly reports
nativeSandboxSupported: false and strictIsolationVerified: false. It is not an OS
sandbox. An approved native tool can access host files and the network. The existing
native-sandbox and isolated execution requirements remain in force for their respective modes.

The four connection cards accept the coding runtime path, optional standalone Node path,
model, HTTPS API endpoint and API Key. Credentials use provider-owned secret references;
public settings and health return only credential presence. Saving a key does not prove
account authentication. Health distinguishes configured/unverified credentials from
observed authentication, and a first real Task may still fail authentication. Existing
Task sessions must be closed before changing their runtime configuration.

### Four-card connection evidence and account-route gates

Gemini, OpenCode, Qwen Code and Claude now separate CLI installation, protocol,
authentication and task-policy evidence. Missing API model/key does not suppress
bounded keyless runtime discovery. Gemini/OpenCode/Qwen API paths require an explicit
model; Claude's optional default is shown only after its native/SDK semantics verify.
API service presets contain endpoint metadata, not inferred models or credentials.
Changing service/endpoint requires re-entering its scoped API Key. Selecting account
mode preserves an existing key but never resolves or injects it into account processes.
Version-1 settings migrate in memory only; explicit saves write version 2.

Official account adapters and synthetic lifecycle contracts are implemented, but **all
new account login and account task routes remain disabled** pending native Windows
profile/ACL, process, policy and interaction acceptance. There is no clickable placeholder
login action. API configuration remains available; no real account or paid model call is
performed by a refresh. Native contract tests are not account acceptance.

- Gemini 0.65.0 uses the actual ACP `oauth-personal` route and provider-owned browser
  flow, with a five-minute timeout. Its private root resolves `.gemini` exactly once;
  encrypted/keychain and ambient Google credential overrides are excluded. This pin
  has no passive metadata-only authentication status API, so refresh does not inspect
  tokens or call `authenticate`. This additional status gate remains unresolved.
  Manual `NO_BROWSER` code entry is not multiplexed into ACP. Task execution retains
  `native_input_unverified`, independent of login.
- Qwen 0.26.1 is API-only. Its retired OAuth route and removed `qwen auth status`
  command are not authentication evidence.
- OpenCode 2.1.4 uses only source-verified `openai/chatgpt-headless` and
  `openai/chatgpt-browser` candidate selections. Standalone auth-list metadata can
  establish a unique stored OAuth connection, not live access or the selected method.
  ACP's empty authenticate reply is not login evidence. The browser candidate can
  cancel another localhost:1455 login on a port collision and remains closed.
  Credential-value/export APIs, token-sharing and global imports are excluded.
- Claude's new route requires native 2.1.308 and the pinned SDK 0.3.308, subscription
  authentication and a canonical matching `configDirectory`. Console no-key sign-in
  is excluded because its storage is not fully scoped by `CLAUDE_CONFIG_DIR`.
  [Current support guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  and older SDK overview eligibility wording differ; release review must reconcile
  them rather than treating technical login as permission or a categorical prohibition.

Auth uses new private generations; only uncancelled successful attempts with confirmed
process exit and unchanged connection identity may promote a generation. Cancelled
writes remain quarantined. Shared task/auth/configuration leases retain ownership on
unknown exit. Owner IPC returns bounded states only, never tokens, auth codes, callback
URLs or raw process output. Existing all-tool approval and separate source-import
approval remain unchanged. Closing/replacing the setup panel cancels its owned attempt
and ignores late replies.

Desktop app login is not imported into a coding runtime. No automatic CLI installation,
user authentication database copying or provider download is part of connection setup.
Use the official [Gemini CLI installation guide](https://geminicli.com/docs/get-started/installation/),
[Qwen Code quickstart](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/) or
[Claude Code setup](https://code.claude.com/docs/en/setup). The supported OpenCode desktop
package supplies its own native CLI.

Every native tool, including reads, requires one Owner decision bound to its full input,
Task, Workspace, Session and runtime/policy fingerprint. Missing input, an oversized
unreviewable payload, a changed runtime/configuration, a duplicate tool ID or cancellation
cannot reuse approval. Review data is redacted without silently truncating executable
arguments. File changes made in staging require a separate Capability-mediated Source
import approval. Staging itself does not confine approved host commands.

Private profiles disable unapproved project/user integrations and configuration. Runtime
and policy identities are checked before Session creation, execution, approval and import.
Malformed optional Agent configuration is preserved and reported as unavailable without
preventing Core startup or unrelated providers from loading.

Verification uses pinned official CLI processes with disposable local synthetic model
servers. It exercises protocol and local permission behavior without proving provider
account authentication, model quality or production API access. Gemini's real ACP request
omission is retained as a specific execution block; no desktop-installation or handshake
result overrides it.

## Protocol and recovery

- JSON-RPC framing is protocol-specific, bounded and UTF-8 strict. Missing real token usage remains unknown.
- Cancellation acknowledgement is distinct from terminal confirmation. Unconfirmed process exit retains ownership and staging for recovery.
- Event replay keeps a rolling bounded history and reports cursor expiry explicitly.
- Native permission requests default to denial without trusted approval. Import approval remains separate.
- New ACP snapshot failures use ACP_STAGING_READ_FAILED. The legacy Codex STAGING_READ_FAILED stop-proof meaning is preserved; restarting into the old default does not release unconfirmed native ownership.
- The optional Claude resource is pinned and hash checked. A future SEA gate requires an explicitly selected artifact with matching source/executable metadata; old release artifacts cannot stand in for the new code.

## Desktop UI included in this source update

The maintained Harbor interface includes the supplied green application mark, compact window chrome, icon navigation with a collapsible workspace list and Memory entry, vertical Settings categories, compact operation history, feedback-link layout, an inline task card, a simpler composer and consistent motion respecting reduced-motion preferences.

## Public repository scope

This update is a reviewed Desktop source snapshot on the existing public main history. Mobile source, current introductions and documentation cleanup remain preserved. Private development history, internal repair reports, raw evidence, old design galleries and restricted SnowLuma SDK/MCP are not imported. Existing OneBot interoperability and public bundle exclusion checks remain intact.

Historical verification for the public snapshot on 2026-10-23: 31 selected registered suites returned 30 PASS / 0 FAIL / 1 NOT_RUN_ENVIRONMENT (the explicitly gated new SEA). TypeScript/Vite passed; independent export review found no issues. These are targeted checks, not a new full-suite, Cargo, Mobile or installed-runtime acceptance run. Real Agent accounts, native enforcement, formal new SEA and installed product acceptance remain separate evidence gates. No new Release or installation is implied.
