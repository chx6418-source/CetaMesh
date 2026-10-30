# CetaMesh Desktop v1 — Known Limitations (Release Candidate)

> Desktop v1 is currently a **RELEASE CANDIDATE** (`1.0.0-rc.2`), not yet COMPLETE. This file lists
> what is verified, what is not, and what must happen before a final `v1.0.0` claim.

## Not verified yet (release gates)

| Item | Status | Why it matters |
| --- | --- | --- |
| Clean Windows VM / fresh image acceptance | `NOT_RUN_ENVIRONMENT` | All local acceptance ran on this real Windows machine in isolated sandboxes; no fresh-image run was possible here. |
| Installed-UI manual walkthrough (Chat / Memory / Workspace / Task, tray menu clicks, IME candidate interaction) | `NOT_RUN_ENVIRONMENT` | No Windows UI automation was available in this session (Computer Use runtime missing). Core-level behavior and metadata safety are verified. |
| Real QQ (SnowLuma) full-mode MCP tool matrix | `NOT_RUN_ENVIRONMENT` | The shipped QQ adapter was not exercised against a live QQ account. |
| Cross-device Device Mesh link | `PENDING_NATIVE_VERIFICATION` | Requires a second CetaMesh node; single-machine tests cover protocol/trust/approval only. |
| Code signing / installer signing | Not done | Unsigned artifacts trigger Windows SmartScreen warnings. |

## Product limitations

- **Update channel is fail-closed.** Without a configured Ed25519 public key the Update page reports
  "not configured" and performs no check. The app never downloads or executes installers silently.
- **Model and Agent execution require configured providers.** Standalone Chat can call a user-configured DeepSeek, OpenAI, or compatible Model Provider directly, without DSH. Managed Agent workflows need their selected external Agent Provider (such as DSH, Codex or ZCode), compatible versions and explicit authorization. No local large-model weights are bundled.
- **Provider secrets are local user data.** They are preserved across upgrades, but stored in the
  user data directory as JSON rather than an OS keychain; protect the Windows account accordingly.
- **Log redaction is best-effort.** Known secret shapes (tokens, authorization headers, cookies,
  credential fields) are removed; a bare random secret with no recognizable shape can still appear.
- **Attachments use local references and bounded processors.** Source builds support chunked images,
  documents and ZIP files; images require a verified vision model. PDF/Office full-text extraction,
  generic external-Agent attachment transfer and native installed-build acceptance remain separate.
  See [developer tools and attachment limits](../development/DEVELOPER_TOOLS_AND_ATTACHMENTS.md).
- **Legacy web console pages remain in the repository** (`public/console.html`, `token-login.html`)
  for development/reference only. Native/no-web release builds exclude product HTML from the Core
  payload; the Release Candidate ships the native UI only. The obsolete Tauri shell was removed.
- **`WhaleBridge.exe` embeds the build-machine repository path** (Cargo string literal). The release
  audit records this as a known deviation; it contains no user data or credentials. Building on a
  clean CI path is the recommended fix before public release.
- **Legacy QQ modes** (`reserved` / `reserved2`) remain only in the QQ Channel Adapter
  (Advanced → Policy / Presets). The CetaMesh product runtime (Chat / Tasks / Memory / Workspace /
  Agent / Continuity) has no reference to them.

## What is already verified

See `PROJECT_STATE.md` (stage 14/15 snapshots) for the full evidence list. Highlights:

- Installer install/upgrade/repair/migrate/uninstall/reinstall lifecycle on real Windows, including
  byte-level preservation of config, settings, Tasks, Memory, Workspace metadata and provider
  secrets, and external Workspace safety on `--remove-data`.
- Release candidate install on paths with Chinese characters and spaces with no system `node.exe` on
  PATH; Core startup, API surface, crash recovery (worker restart), single instance and orphan
  guard.
- Real DSH round trip using the Core executable from the installer payload.
- Architecture red lines are enforced by `npm run test-architecture` plus the functional suites.
