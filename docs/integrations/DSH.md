# DeepSeek Harness Integration

CetaMesh exposes DeepSeek Harness as a built-in Agent Integration. The product card combines two independent components:

```text
DeepSeek Harness
├─ Desktop App       external Windows application: detect, version, status, open
└─ Agent Provider    existing DSH adapter scheduled through Agent Broker
```

The Desktop App is optional. Its installation state never makes the Agent Provider ready. The Agent Provider can remain available without the Desktop App, and an installed Desktop App can coexist with an unavailable Agent Provider. CetaMesh Core, Model Runtime, Memory, Task, and Plugins do not require DSH.

## Desktop App

On Windows, the integration checks for an already running `DeepSeek Harness.exe` process, registered uninstall entries, Start Menu shortcuts, Windows App Paths, and known installation locations. The app version comes from its registered display version when available. The `dsh` CLI is detected separately and its optional version probe uses the installed CLI entry point. No CLI probe runs from chat or Agent session creation.

Desktop status uses `not_installed`, `installed`, `running`, `unavailable`, or `unsupported_version`. The service caches its last snapshot for 30 seconds; opening the integration page may populate the cache, and the explicit status action forces a new scan. A registry record without its executable is reported as installed but unavailable, with `EXECUTABLE_MISSING` in the status summary and the underlying detail in Advanced diagnostics.

Opening the app starts the discovered executable directly with a hidden window, detached process, ignored stdio, `shell: false`, and a small operating-system environment allowlist. CetaMesh does not invoke `cmd /c`, PowerShell `Start-Process`, or an installer. If the app is already running, CetaMesh reports that state and does not launch a second copy; the current public integration has no stable focus mechanism.

If the app is absent, the Plugins page can open the [official DeepSeek download page](https://www.deepseek.com/en/download/). CetaMesh does not download or install DSH.

## Agent Provider

The existing `dsh` Agent Provider remains registered with the Agent Broker. It reuses the existing injected `NodeApiClient` and DSH runtime. It is separate from the Desktop App adapter and is not hosted in `ProcessExtensionHost`.

The Agent Provider remains subject to the existing Task, Workspace, Capability, and Continuity contracts. Creating workspace-bound Agent sessions must go through Task assignment. Continuation uses CetaMesh Continuity Runtime; the Provider does not need its own permanent Desktop session. Agent health is distinct from Desktop process state and is only refreshed through the normal Agent health action or a bounded status-cache refresh.

The new `agents.defaultAgentProvider` setting applies to newly created Chat sessions. `auto` remains the default; `dsh`, `codex`, and `zcode` select a registered compatible provider. Existing sessions keep their own provider selection. The DSH integration enabled toggle remains stored by the Integration Registry and does not change the Desktop App state.

## Public API boundary

The reviewed [official Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md) describes the app-owned Electron lifecycle and its optional `dsh` command. The reviewed public documentation does not publish a third-party Agent execution API. CetaMesh therefore records Desktop Agent Control as `NOT_SUPPORTED_BY_PUBLIC_API` and continues using its existing DSH Agent Provider.

CetaMesh does not probe a local port as an Agent API, read Desktop cookies, browser authentication or credential files, inspect private Electron state, automate DevTools, inject a renderer, or reverse engineer private IPC. Desktop detection uses process identity and Windows application registration only. Ordinary settings expose status and version; executable paths and raw detection errors remain under Advanced diagnostics.

## Built-in Integration boundary

DeepSeek Harness is registered by CetaMesh as the built-in descriptor `dsh` / `cetamesh-dsh`. It is not a `.cetamesh-plugin` package. Third-party plugin packages continue through Extension Runtime and Process Extension Host; integrations such as DSH and SnowLuma connect the product surface to their existing domain service or Agent Provider.

See [Built-in Integrations](../plugin-development/16-built-in-integrations.md) for the Plugin SDK distinction.
