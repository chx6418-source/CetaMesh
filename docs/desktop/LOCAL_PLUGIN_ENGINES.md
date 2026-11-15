# External plugins: AgentOS and ReverseLab

These adapters install separately supplied AgentOS and REA runtime ZIPs from their existing projects. The CetaMesh installer includes the adapters. Installed engines appear in the regular plugin list. Calls use the existing Capability Broker, Task grants, approval inbox and operation journal.

## Configure and use

1. In **Plugins → Plugin Center**, choose **导入插件包** and select a ZIP. AgentOS and ReverseLab are detected automatically and do not require Developer Mode. Ordinary development extensions retain their existing Extension Runtime installation rules.
2. Review the plugin name, version and execution scope, then choose **确认安装并启用**. CetaMesh extracts into owned staging and installs immutable version directories under its private StateDir. The plugin package supplies Node; no runtime directory or Node path field is required. Importing never executes package code or install scripts.
3. Open **管理插件** to enable/disable, import an update ZIP, uninstall or authorize a queued project Task. Updates retain the previous program version. Uninstall removes managed program versions while preserving Task/Memory history, analysis records and Guest disks; legacy externally configured runtime folders are retained. File validation does not assert that every backend or upstream dependency works.
4. Select an unassigned, queued project Task and open plugin requests for that Task. Its existing grants are preserved. Read-only and isolated-writer child contracts are not expanded.
5. Start its Managed Agent. The Agent uses the advertised catalog and structured calls. Each native execution goes through the existing approval inbox with its exact arguments. Task authorization permits requests, not automatic execution.

Configuration changes require idle operations and a new review. Pending approval is bound to the configuration revision. Disabling stops owned hosts and analysis workers without deleting historical records or Guest disks. Configuration corruption disables the optional integration without replacing the saved data.

## Runtime package format

AgentOS packages contain `agentos.system.json`, the reviewed managed contract and source dependencies, plus `runtime/node.exe` on Windows. ReverseLab packages contain `engine.lock.json` and the complete pinned `engine/` tree. One outer directory is accepted. A source repository ZIP without built runtime assets is not an installable engine package.

`scripts/package-local-plugin.mjs` creates ready-to-import ZIPs from existing prepared runtimes and separately supplied Node/licenses. It downloads nothing and executes no third-party build scripts. Generated third-party assets belong outside the public repository. See [ReverseLab packaging](REVERSELAB.md#runtime-and-package-layout) for preparing its locked engine from source.

Runtime ZIPs are bounded to 128 MiB compressed, 512 MiB expanded and 20,000 entries, with incremental extraction yielding to Core I/O. CRC, Windows paths, duplicate/case-colliding names, encrypted/special/link entries and private credential paths are checked. These runtime-specific limits do not relax the ordinary small Extension ZIP profile. Only package review/install receive longer bounded Host deadlines; diagnostics, file pickers and ordinary RPC budgets are unchanged.

## AgentOS workbench and official registry

The release configuration reads `https://cetamesh.com/api/v1/plugins`. Registry v1 metadata is distinct from the original Catalog v1 format; both remain supported. A registry entry is discovery metadata, not permission or execution evidence. Download authorization uses a same-origin POST endpoint. Its response must match the selected ID, version, filename, size and SHA-256 before requesting the short-lived, same-origin package URL. External ZIPs reuse the existing bounded review and immutable installation flow, with Owner confirmation. A server refusal is reported as `PLUGIN_DOWNLOAD_FORBIDDEN`; local ZIP import remains available.

To grant plugins before execution, choose **先创建，暂不启动（用于配置插件）** in the Work task form. Select that queued Task in **管理插件 → 项目 Agent 调用**, grant the plugin, then start it in Task details. Queued creation starts no Agent and owns no Workspace write lease. Normal immediate-start creation retains its previous behavior. Automatic collaboration is not preauthorized in this mode.

An installed Windows AgentOS package exposes **打开工作台**. It must include the original `AgentOSConsole.exe`, `ui.mjs`, `install.mjs` and server dependencies. Core verifies the reviewed package before opening fixed entries with the package's Node runtime; renderer arguments cannot select commands. The workbench uses a separate `StateDir/agentos/workbench` home for Owner-managed environments and system downloads. It does not adopt Task-managed Guests or inherit their HMAC keys. Core does not enable unmanaged root operations or start image downloads automatically. While this workbench is open, updating, disabling or uninstalling the engine is refused. Closing it confirms owned processes have exited before releasing the configuration lease.

## AgentOS managed contract

`src/agentos/managed-v1.json` records the closed `cetamesh.agentos.managed.v1` contract from the owned AgentOS 2.0.0 system-host candidate. It is an implemented adapter contract, not a replacement for proposed CP protocols or Manifest v1. AgentOS's system-host proposal must not be installed as an ordinary Extension v1 package.

The project Agent receives two entry points to avoid flooding its model context:

- `agentos.catalog`: list operations or read an operation's complete input schema.
- `agentos.call`: `{operation, arguments}` using that schema.

Available managed operations: backend list; environment list/status/create/start/stop/delete/attach; command execution; file read/write; snapshot create/restore/list; and logs. The 15 direct Broker descriptors remain non-model-callable. They share the same validation and executor as the Agent entry point.

Only Core signs the Host grant, after approval. Its identity includes the operation, Task, Workspace, environment, exact input digest, expiry and limits. Keys stay in the owned Host environment, not model-visible output or settings. Each Task/Workspace has an independent managed home and transport. The Host checks persisted resource ownership and operation status. Cancellation or lost transport does not prove a Guest command stopped and never authorizes automatic replay.

The current adapter supports managed Docker and QEMU. WSL creation is refused. Existing standalone AgentOS VMs are **not adopted**: the current protocol cannot safely transfer their ownership. Reusing an existing standalone system needs a separate ownership-transfer contract. Direct CLI Agents also need their own verified Core tool bridge; a working Managed Agent invocation does not establish that bridge.

### Existing Docker images

The original 2.0.0 Docker backend pulls even an existing image. Prepare an independent adapted copy with:

```powershell
node scripts/agentos/prepare-runtime.mjs <existing-AgentOS-package> <new-runtime-directory>
```

The script accepts the reviewed package shape, preserves the original, and changes creation to inspect local images before pulling. The resulting package is reviewed again through Plugins. Its Docker run still uses `--pull never`, no host mounts, no network, dropped capabilities and resource limits. A missing image may still require a download; inspect the create request before approving it. This script does not download or redistribute bundled binaries.

## ReverseLab full MCP mode

Full mode complements the workspace-bound P1 `analysis.static` plugin; it does not expand that plugin's authorization. Full mode is **native host execution, not an OS sandbox**. It can invoke upstream tools that access host files, processes, devices or networks. The configuration review discloses this, and each tool call requires separate approval. Ambient credentials and user configuration are not inherited.

Entry points:

| Capability | Purpose |
| --- | --- |
| `reverselab.session.open` | Start or reuse this Task's live analysis process; returns `sessionId`. |
| `reverselab.catalog` | Page tool names and prompts, or obtain a tool's exact input schema by name. |
| `reverselab.call` | Invoke an advertised MCP tool with its actual arguments; validate against the upstream JSON Schema 2020-12. |
| `reverselab.prompt` | Read an official prompt as reference data; it grants no execution authority. |
| `reverselab.record` | Read sanitized pages of a committed result by session, sequence and offset, including after closure/restart. |
| `reverselab.session.close` | Stop this Task's process while retaining records. |

REA 6.8.0 advertises 229 tools and 6 prompts. The adapter permits the complete advertised catalog, without a static-tool allowlist. Tool discovery and Schema compilation are distinct from executing every tool. Optional providers, device connectivity and binary dependencies may still be unavailable. The worker uses a private environment; user-wide provider configuration and credentials are deliberately not imported. CLI installation/administration commands are not exposed as unrestricted Agent shell commands.

Up to four live Task sessions are supported, with one operation per Task at a time. Results, requests, the original MCP transcript and catalogs live under the protected Core StateDir. Task artifacts refer to the analysis session. Tool-returned errors retain the original response and do not become success. Large responses are explicitly incomplete; Agents can use `reverselab.record` for bounded sanitized pages or approve an upstream Evidence export into a chosen location. Prompts are flattened only for display; the original MCP response remains intact.

After Core restart the live process binding is absent. Existing records remain readable, but old-session tool calls return `REVERSELAB_SESSION_LOST`. A new session is an explicit approved operation; prior calls are not replayed.

## Verification boundaries

Run Desktop regressions through root `npm test`. Environment tests require explicit local paths:

- `test-local-plugin-engines`: Owner-only configuration, review tokens and configuration leases.
- `test-agentos-adapter`: signed managed transport and optional actual Host process; invalid signature and foreign-environment refusal.
- `test-local-plugin-core`: actual Core/Managed Agent, deterministic local model, actual AgentOS Host and REA; approval rejection, stale configuration, complete catalog, analysis/export, prompt rendering, record read and Core restart.
- `test-agentos-guest`: opt-in existing Docker image; actual project Agent creates, reads, writes and executes in a Guest; foreign Task refusal, nonzero exit, stop/start and owned cleanup.

`CETAMESH_TEST_AGENTOS_ROOT` selects a local AgentOS package. `CETAMESH_TEST_REVERSELAB_RESOURCES` selects the resource root containing `plugins/reverselab`. `CETAMESH_TEST_AGENTOS_IMAGE` explicitly opts into creating a temporary Docker environment from an existing image, using the prepared runtime. These tests do not use paid models. Native Windows UI acceptance, QEMU Guest acceptance and the optional REA provider matrix must be reported separately.
