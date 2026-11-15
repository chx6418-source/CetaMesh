# ReverseLab P1 integration

ReverseLab is a native CetaMesh plugin backed by a pinned, replaceable REA 6.8.0 engine. P1 supports one actual static workflow: analyze an extracted JavaScript application directory, export the original REA Evidence bundle, and register its index as a CetaMesh Task artifact. It never executes the analyzed application.

This plugin requires the CetaMesh build containing the `analysis.static` adapter. Installing its template into an older build does not add that adapter. P1 does not expose the remaining REA tools, prompts or advanced CLI commands through CetaMesh; those implementations and contracts remain in the unmodified engine for P2 integration.

## Runtime and package layout

```text
resources/plugins/reverselab/
  engine.lock.json             # trusted manifest SHA, outside engine assets
  engine/
    engine-manifest.json       # exact file inventory and SHA-256
    runtime/node.exe           # private Node 24.22.1; no system Node change
    runtime/LICENSE
    rea/                       # REA runtime, production dependencies and notices
```

The small Manifest v1 plugin is installed through the existing Extension Runtime. Its `analysis.json` is a validated data definition, analogous to existing HTTP/Event data hosts; no downloaded plugin JavaScript gets process authority. Core's domain adapter starts an independent stdio REA process for each analysis, with a default capacity of two and a 120-second run deadline. Ordinary VM/Process plugin defaults and prohibited `shell/native/download/process` permissions remain intact.

The engine and plugin have separate identities. Engine files are verified asynchronously before execution against the external lock, including rejection of extra modules and reparse entries. Health returns a timestamped last verification result; polling health does not hash the entire engine on the Core event loop. SHA locks identify content and do not certify a publisher signature.

Build engine assets from a verified, built REA checkout:

```powershell
node scripts/reverselab/package-engine.mjs <rea-root> <private-node.exe> <fresh-output-engine-dir> <node-24.22.1-LICENSE>
```

This build tool performs no download or dependency installation. REA's declared runtime files, locked production dependencies, Windows native addon and all required notices must already be present. The Node license must be the complete license from its matching official release tag, including third-party notices.

## Scoped installation

`extensions/cetamesh-reverselab` is a template. Use the preparation or installation script to bind the selected existing Workspace and input/output scope **before review**. P1 uses one reviewed Workspace per installation; global multi-Workspace setup is a later integration step.

Create existing input and output parent directories such as `apps/` and `results/` in that Workspace. With the development Core stopped, run from this CetaMesh checkout:

```powershell
& '<resources>/plugins/reverselab/engine/runtime/node.exe' scripts/reverselab/install-plugin.mjs --state-dir '<development-state-dir>' --workspace '<workspace-id>' --paths apps,results
```

The command prints the normalized manifest and review token. Repeat the same selection with `--approve-review <returned-token>` to install. Changing the Workspace, paths or package invalidates the token. Installation uses the standard managed package/version store and leaves the plugin disabled. Enable it through the usual Plugins entry or `ext.enable`. The script acquires the StateDir ownership lock and cannot install over a running Core.

For an already running development host, use `prepareReverseLabPlugin({workspaceService, workspaceId, paths, outputRoot})` from `scripts/reverselab/prepare-plugin.mjs`, then normal `ext.review` / `ext.install` / `ext.enable` APIs. The same function is used by integration tests.

Uninstall through the normal Plugins entry or the stopped-Core installer with `--state-dir <dir> --uninstall`. User Workspace artifacts are retained. Engine assets are separately packaged read-only application resources; uninstall does not delete them or another installed version's assets.

## Agent invocation and results

The model-callable tool is:

```text
extension.org.cetamesh.reverselab.analyze_javascript_application
```

Example input:

```json
{"path":"apps/my-application","outputPath":"results/analysis-001"}
```

Both paths must be relative to the Task's Workspace and inside the installed, canonically reviewed scope. Input and output cannot contain one another. The output directory must be fresh; its parent must exist. A junction into another part of the same Workspace does not bypass the narrower reviewed scope.

Task grants must explicitly include the installed tool ID and internal `analysis.static`; default Task grants do not expand. `analysis.static` is not model-callable. Current data-host policy separately reviews the plugin request and its exact concrete file operation. Both decisions retain the existing Broker request, actor, Task, Workspace and descriptor bindings.

The output contains original MCP response files, byte-for-byte stdout transcript, engine diagnostics, the original `evidence-bundle.json`, and a separate `index.json`. The index is committed after successful analysis, original bundle export and confirmed Worker exit. It keeps original `evidence_id` values, target digest, engine identity and bundle digest. Full results stay in files; the Agent receives a small receipt. The Task artifact opens through existing Workspace/reference APIs. Memory is not populated automatically.

REA's fixed `export_evidence_bundle` operation avoids forcing complete bundles through the MCP response budget. If analysis cannot establish completed Evidence or an export/write/cleanup fails, no successful index is published. Available partial diagnostics remain in the run directory. Existing unknown-effect fences apply; a rejected response does not authorize automatic replay.

Disabling, uninstalling or shutting down revokes the plugin route, aborts and joins owned analysis runs, and preserves committed artifacts. Task completion remains an Owner-reviewed CetaMesh transition. A successful Agent turn does not mark the Task complete.

## Verification and present limits

Run tests through the root entry:

```powershell
$env:CETAMESH_TEST_REVERSELAB_RESOURCES='<offline-resources-root>'
$env:CETAMESH_REVERSELAB_EVIDENCE_DIR='<existing-test-evidence-directory>'
npm test -- --suite test-reverselab-assets --suite test-reverselab-boundary --suite test-reverselab-install --suite test-reverselab-engine --suite test-reverselab
```

Without real engine resources, the two real-engine suites report `NOT_RUN_ENVIRONMENT`; the asset, boundary and installer tests still run. An explicitly supplied invalid resource path fails the tests.

The real Core test uses the actual Managed Agent, Broker, installation/approval, REA, filesystem and Task/Workspace APIs with a deterministic model leaf. It verifies actual source facts, original Evidence IDs, pause/resume at a completed tool boundary without replay, and disabling an active Worker. The engine test analyzes distinct targets concurrently in different processes and checks physical exit. Controlled transcript I/O and cleanup faults are labeled fault injection, not real disk exhaustion.

P1 does not certify arbitrary in-engine resume, two real external-model Agents running concurrently, automatic interrupted-run reconciliation, all optional Providers, native WebView presentation, or clean ordinary-user Windows installation. These require the planned P2–P5 contract, continuity, Provider, UI and release gates. This integration does not update an installed application or grant release approval.
