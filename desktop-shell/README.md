# WhaleBridge desktop shell

## Current state (2026-10-05, CetaMesh Desktop v1 RC)

This is the **native eframe/egui** desktop shell for CetaMesh Desktop. It supervises the Node SEA
Core, talks to it over a per-instance named pipe, owns the Windows tray icon, window preferences
(`state/desktop-ui.json`) and the installer/uninstaller CLI. Tauri/WebView and its `ui/*.html`
pages were removed in stage 15; `Cargo.toml` pins a single binary at `src/native_main.rs`.

```powershell
npm run desktop:check         # cargo check
npm run desktop:test          # cargo test
npm run desktop:build:debug   # debug shell (tests / local run)
npm run desktop:build         # release shell
```

Installer / lifecycle commands are documented in `docs/desktop/BUILD_AND_RELEASE.md`; architecture
and red lines in `docs/desktop/ARCHITECTURE.md`. The sections below are kept as historical notes
from the staged migration and may describe removed Tauri-era behaviour.

This directory contains the staged Windows desktop shell for WhaleBridge. It is intentionally
separate from the existing Node.js bridge so the desktop migration can be verified without
changing QQ, DSH, MCP, or console behavior.

## Stage 1 commands

Run these commands from the repository root:

```powershell
npm run desktop:check
npm run desktop:test
cargo build --manifest-path desktop-shell/Cargo.toml --offline
desktop-shell\target\debug\whalebridge-desktop.exe
```

The prototype loads `http://127.0.0.1:3100/` by default. A development-only override can be
provided with `--console-url http://localhost:PORT/` or `WHALEBRIDGE_CONSOLE_URL`. Non-loopback
hosts and non-HTTP schemes are rejected.

The shell preserves the console's existing token login and in-memory session cookie behavior.
It does not read, inject, log, or bypass the console token. Same-origin console navigation stays
inside the desktop window; external HTTP(S) links are handed to the system browser.

The selected C4 "light soda connection" artwork is the checked-in application icon. Run
`npm run build:icons` after changing `icons/source-c4.png`; it regenerates the multi-size Windows
ICO, Tauri PNG sizes, installer/status artwork and public console artwork. `package-installer.mjs`
also applies this ICO to the outer IExpress executable after packaging. The application
identifier is still a prototype value and must be finalized separately.

## Stage 2 path contract

The Node runtime now resolves mutable and immutable files through `src/app-paths.js`:

- `WHALEBRIDGE_DATA_DIR` selects the writable root for `config.json`, `state/`, user roles,
  logs, and caches.
- `WHALEBRIDGE_RESOURCE_DIR` optionally selects the read-only application root for `public/`,
  `assets/`, `tools/`, and bundled roles.
- With neither variable set, both roots are the repository root, so source-mode behavior remains
  unchanged.

Run `npm run test-app-paths` to verify default compatibility, process-environment overrides,
temporary data-directory isolation, and bundled/user role precedence.

## Stage 3 unified core entry

The source-mode core now has one dispatch entry while retaining every legacy direct entry:

```powershell
node src/core-entry.js --worker
node src/core-entry.js --mcp snowluma
node src/core-entry.js --mcp snowluma-host
node src/core-entry.js --mcp web-search-safe
node src/core-entry.js --mcp qq-file-send
node src/core-entry.js --mcp bilibili
node src/core-entry.js --self-test
```

`npm run test-core-entry` starts all five MCP modes over real stdio transports, performs
`initialize`, `listTools`, and a safe `callTool`, verifies the five legacy script entries, and
smoke-tests `--worker` with an isolated data directory and temporary loopback port.

## Stage 4 packaged core

The core is also built as a standalone Windows executable that does not need Node.js installed:

```powershell
npm run build:core        # dist\core\WhaleBridgeCore.exe + dist\core\resources\
npm run test-core-dist    # 发行产物烟测（隔离 PATH、临时数据目录、临时端口）
```

Layout produced by the build:

```text
dist\core\
  WhaleBridgeCore.exe        独立核心（Node SEA：宿主 node.exe + 注入的 bundle）
  resources\                 只读资源：public\ roles\ assets\ dsh\ plugins\ config.example.json
  runtime-manifest.json      版本、工具链、体积与 sha256
  build\                     中间产物：core.bundle.cjs、metafile、blob、sea-config.json
```

### Core launch resolution (`src/core_launch.rs`)

The shell does not hard-code a core path. `resolve_core_launch` selects between two modes, in this
priority order:

1. forced mode via `--core-mode` / `WHALEBRIDGE_CORE_MODE`;
2. explicit executable via `--core-command` / `WHALEBRIDGE_CORE_EXE` (a `.exe` implies packaged
   mode, anything else development mode);
3. **packaged** — `WhaleBridgeCore.exe` next to the shell, or under a `resources\` sub-directory;
4. **development** — `node <repo>\src\core-entry.js`, where the repository root is
   `WHALEBRIDGE_REPO_ROOT` or discovered by walking up from the shell executable to the first
   directory containing `src\core-entry.js`.

The resolved spec always runs the core with `--worker` and injects `WHALEBRIDGE_DATA_DIR` when a
data directory is configured. Packaged mode deliberately does **not** set
`WHALEBRIDGE_RESOURCE_DIR`: the core discovers its own `resources\` directory.

Inspect the resolution without opening a window (debug builds, which keep a console):

```powershell
desktop-shell\target\debug\whalebridge-desktop.exe --print-core-command
```

```text
mode=packaged
program=D:\app\WhaleBridgeCore.exe
args=["--worker"]
env=[]
```

Starting, health-checking, and restarting the core is stage 6 work; stage 4 only fixes and tests
this contract (`cargo test`).

## Stage 6 supervisor

The shell now owns the core's lifecycle end to end. Modules:

| file | responsibility |
|---|---|
| `src/core_launch.rs` | which core to run (packaged exe vs. `node src/core-entry.js`) |
| `src/desktop_paths.rs` | data-directory priority, `config.json` console port, log paths |
| `src/supervisor.rs` | spawn, HTTP health probe, exit-code policy, backoff, graceful stop |
| `src/main.rs` | window, tray, status page, exit orchestration |
| `ui/status.html` | startup / failure / stopped page, fed by the shell |

### Exit-code contract (locked by tests)

| code | meaning | launcher action |
|---:|---|---|
| 0 | normal end (console "关闭主程序", launcher shutdown) | do not restart; show "stopped" |
| 2 | another instance is running / port in use | do not restart; show guidance |
| 10 | restart requested (`/api/restart`) | restart immediately |
| other | crashed | restart with backoff (5/10/20/30 s, cap 5 failures) |

`src/bridge.js` sets `WHALEBRIDGE_SUPERVISED=1` semantics when the shell spawns it: the global
"kill every cmd.exe running start.bat" cleanup in `/api/shutdown` is skipped (it would damage a
second instance the user runs via `start.bat`), and stdin EOF is used as a parent-liveness signal
so a force-killed shell cannot leave an orphaned worker. The existing `start.bat` daemon is
unaffected: it restarts on any exit code except 2, so code 10 keeps working for it.

### Commands

```powershell
npm run desktop:build:debug     # debug build (keeps a console; required by the self-check modes)
npm run desktop:test            # cargo unit tests (exit-code policy, backoff, probes, paths)
npm run test-desktop-supervisor # Node side: supervised worker contract (orphan guard, exit codes)
npm run test-desktop-shell      # end-to-end: spawn/health/restart/port-conflict/window/orphan guard
```

Headless self-check modes (debug builds print to stdout; every line is also appended to
`<data>\logs\desktop-shell.log`, which is the only place to read them in a release build):

```powershell
whalebridge-desktop.exe --print-core-command          # resolved core, data dir, console port
whalebridge-desktop.exe --smoke-test                  # spawn → health → graceful stop, exit 0
whalebridge-desktop.exe --smoke-test --supervise-seconds 8   # keep supervising (restart testing)
```

### Behaviour notes

- Closing the window hides to tray; the tray's "退出" is what actually stops the core.
- The console port comes from `<data>\config.json`; the shell injects `WHALEBRIDGE_DATA_DIR` into the
  worker so both agree on where data lives. Pass `--data-dir <path>` to point the shell elsewhere.
- Logs: `<data>\logs\worker.log` (worker stdout/stderr, appended across restarts) and
  `<data>\logs\desktop-shell.log` (shell status transitions).
- The window, tray and EXE use `icons/icon.ico` (C4 light soda, nine layers from 16 to 256 px).
  `app.default_window_icon()` supplies the same embedded icon to the tray.

## Stage 7 installer, migrator and uninstaller

The shell binary is also the installer and the uninstaller — there is no second binary:

```powershell
WhaleBridge.exe --install [--dry-run]       # fresh install or upgrade
WhaleBridge.exe --repair                    # restore missing/changed program files
WhaleBridge.exe --migrate --from <dir>      # migrate old data (never overwrites by default)
WhaleBridge.exe --uninstall [--remove-data] [--remove-dsh-integration]
WhaleBridge.exe --help
```

| file | responsibility |
|---|---|
| `src/installer.rs` | effect-based install/repair/uninstall plans, snapshot rollback, install manifest |
| `src/migrate.rs` | source discovery, JSON validation, backup-style migration, warnings |
| `src/install_cli.rs` | the `--install/--repair/--uninstall/--migrate` command line |

Every root is injectable (`--install-dir`, `--data-dir`, `--start-menu-dir`, `--desktop-dir`,
`--registry-key`, `--payload-core`), which is what lets `npm run test-desktop-install` exercise the
full lifecycle inside a temp sandbox instead of touching the real system.

Behaviour worth knowing:

- `install-manifest.json` records every file the app placed, with its sha256. Uninstall removes only
  recorded files whose content is unchanged; files you added or edited are kept and reported.
- Uninstalling from inside the install directory relocates to a `%TEMP%` copy (a running exe cannot
  delete itself); the copy finishes the job and then deletes itself.
- Your data directory is never touched unless you pass `--remove-data`, and `config.json` is never
  overwritten by install, upgrade, repair or reinstall.
- `--remove-dsh-integration` shells out to `WhaleBridgeCore.exe --uninstall-dsh`, which removes only
  the DSH files recorded in `.whalebridge-integration.json` and keeps anything you edited.

`npm run build:core` audits the distribution (no `config.json`/`state/`/logs/`.node`/`.dll`/SnowLuma
files, no build-machine paths, no credentials from the local `config.json` leaking into the bundle or
the exe) and fails the build when something forbidden shows up.

NSIS packaging is intentionally not enabled: the project uses the IExpress + Tauri installer flow
described in ADR-015. Because IExpress has no custom-icon option, `set-exe-icon.ps1` updates every
`RT_GROUP_ICON` resource after packaging and before signing. The Windows App ID, version resource
and signing subject remain separate release decisions; the formal C4 application icon is embedded
in both `WhaleBridge.exe` and `WhaleBridge-Setup-x64.exe`.
