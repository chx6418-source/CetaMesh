# 鲸桥 WhaleBridge — QQ ↔ DeepSeek Harness Bridge

> Connect QQ messages to DeepSeek Harness (DSH) agents: QQ friends/groups become DSH conversations, and agent replies (including questions and tool approvals) are sent back to QQ.

> **Native UI migration status (2026-09-23):** the default release path no longer ships WhaleBridge product HTML, and the desktop shell/installer now use native egui windows with named-pipe management IPC. An isolated no-web release candidate passed automated install/recovery checks; the old console is not yet fully migrated, and the existing `dist/app` remains a historical web-based artifact; see [the current migration status](docs/DESKTOP_APP.md#13-去网页化迁移当前状态).

For the detailed Chinese guide, see **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**.

## Architecture

```
QQ messages ──► SnowLuma (OneBot v11 WS) ──► WhaleBridge ──► DSH Web API (127.0.0.1:3080/api)
                                                    ▲                      │
                                                    └── agent replies / questions / approvals ┘
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: reuses `@deepseek-ai/dsh-host-apiproxy` and implements the Node transport layer.
- **Agent tools**: safe MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.).
- **Native management UI (in migration):** the desktop app uses a Rust/egui window and local named-pipe IPC, not a WhaleBridge web page. Current controls cover overview/restart, roles, notification security, global mode/owner/allow-deny policy, SnowLuma/DSH service discovery/selection/install/start/stop, model catalog/defaults, preset listings/bindings, approval/question and risky-card queues, slang settings, sessions/social phase, read-only activity/log views, and allowlisted diagnostics. Send parameters, live event subscription, memory, stickers, file/audio/Kugou, and other legacy-console features remain to be ported.

## Features

- Bridges QQ group/private messages to DSH agent sessions.
- Social simulation mode ("simulated group friend") with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control, fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading group history/members, sending messages, replying with quotes, and (in `reserved2`) full simulated-group-friend tooling.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and member impressions.
- Sticker library integration with AI-friendly sticker usage.

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ/group IDs |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the two DSH chat presets (`whale-chat` and `whale-chat-v2`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- `~/.dsh/.agent-presets/whale-chat` and `~/.dsh/.agent-presets/whale-chat-v2`
- five MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`, all launched through the unified core
  entry (`node <repo>/src/core-entry.js --mcp <mode>`)
- `whale-mode-console` in the profile `package.json`
- Default DSH mode set to `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

The installer is idempotent (a second run changes nothing) and never overwrites content you edited:
ownership is tracked by content hashes in `~/.dsh/.whalebridge-integration.json`. Presets you created
yourself, your own MCP entries, and non-symlink plugin directories are only reported, never deleted.
Legacy `src/mcp-*.js` entries are migrated in place, `qq-*` era artifacts are cleaned up, and a failed
run rolls back to the previous state. Useful flags: `--dry-run`, `--force-presets`,
`--no-plugin-install`, `--json`.

> Installs made from the packaged app have no `scripts/` directory — use
> `WhaleBridgeCore.exe --setup-dsh web` instead. It points the MCP `command` at
> `WhaleBridgeCore.exe` directly, so the target machine needs no Node.js.

Then restart DSH. See [docs/DSH_SETUP.md](docs/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`.
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Process control for SnowLuma (`start_snowluma` / `stop_snowluma`) is disabled by default and only allowed in `closed-agent` mode when explicitly enabled.
- The console uses a generated token when none is configured.

## Repository Layout

```
WhaleBridge/
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    PROJECT_GUIDE.md    # detailed Chinese guide
  dsh/agent-presets/    # whale-chat / whale-chat-v2 DSH agent preset templates
  plugins/whale-mode-console  # DSH settings whale-mode card plugin
  src/                  # bridge core and MCP servers
  public/
    # WhaleBridge product HTML is excluded from the default release payload
  roles/                # persona cards
  assets/               # images and project intro video
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
  dist/core/            # packaged artifacts (not in repo; created by npm run build:core)
  desktop-shell/        # Windows native desktop shell (Rust/eframe, see desktop-shell/README.md)
```

## Unified Core Entry and Standalone EXE

Source mode uses a single dispatch entry (`node src/core-entry.js --worker`, `--mcp <mode>`,
`--self-test`, `--help`) while every original direct entry keeps working. `src/app-paths.js`
separates read-only resources from writable data via `WHALEBRIDGE_RESOURCE_DIR` and
`WHALEBRIDGE_DATA_DIR` (or `--data-dir <path>`); with neither set, both remain the repository root.

Build a Windows core that runs without a system Node.js installation:

```bash
npm run build:core        # dist/core/WhaleBridgeCore.exe + dist/core/resources/
npm run test-core-dist    # smoke test with an isolated PATH, temp data dir and temp ports
```

When packaged, the core resolves resources from `resources/` next to the executable and writable
data from `%LOCALAPPDATA%\WhaleBridge` (or `<exe dir>\data` when an empty `portable.flag` sits next
to the executable). The install directory stays read-only.

## Windows Desktop Shell (in progress)

`desktop-shell/` is the Rust + eframe native shell that starts and supervises the Core. UI management uses a named pipe; the loopback HTTP listener is retained for Agent/DSH programmatic APIs only. Full feature parity with the old console is not complete yet:

```bash
npm run desktop:build:debug       # debug build (keeps a console; required by self-check modes)
npm run desktop:test              # Rust unit tests (exit-code policy, backoff, probes, paths)
npm run test-desktop-supervisor   # supervised worker contract (orphan guard, exit codes)
npm run test-desktop-shell        # end-to-end: spawn/health/restart/port conflict/window/orphans
```

- Exit codes: `0` normal end (no restart), `2` another instance or port in use (no restart),
  `10` restart requested (restart now), anything else crashes into a 5/10/20/30 s backoff
  (giving up after 5 consecutive failures). `start.bat` restarts on anything but 2, so code 10
  stays compatible with the existing daemon path.
- A worker started by the shell runs with `WHALEBRIDGE_SUPERVISED=1`: "关闭主程序" then only exits
  that process instead of killing every `start.bat` daemon on the machine, and a force-killed shell
  cannot leave an orphaned worker (stdin EOF is the liveness signal).
- Closing the current native window exits the shell and stops its worker; tray behavior has not yet been migrated.
- Diagnostics: `--print-core-command`, `--smoke-test` (headless spawn → health → graceful stop).
  Logs live in `<data dir>\logs\`.
- Native GUI details (DPI, Chinese IME, keyboard/copy/paste, named-pipe ACL) still need manual acceptance;
  code signing remains outstanding.

## Testing

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
