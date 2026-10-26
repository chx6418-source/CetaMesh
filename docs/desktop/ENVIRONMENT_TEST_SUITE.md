# Developer Windows environment tests

This suite extends the existing Core Task, Attempt, Capability Broker, Approval and artifact services. The developer Environment Host owns VM resources; it is not a second task scheduler. Desktop distributions leave its client unconfigured. No Windows feature, elevation, OS download or VM is started automatically.

## Architecture and trust

- `src/environment/contracts.js`: versioned profile, execution identity, quotas, status vocabulary and unavailable backend declarations.
- `service.js`: explicit Capability grants and high-risk approval; records an existing Task Attempt, monitors assignment/grant/expiry changes, blocks completion when effects are unknown, and attaches an owned Markdown artifact.
- `host-client.js`: the existing bounded native IPC framing, a dedicated local pipe, a 256-bit secret and a fixed method allowlist. The token belongs only to the trusted Core client. Never place it in workspace files, tool arguments, logs or Agent environments.
- `host.js`: one active run, durable replay/ownership references, final reports and quarantine admission. A restart never resumes installation or VM creation automatically.
- `hyperv-backend.js` and `scripts/environment/hyperv-host.ps1`: fixed typed operations; independently cloned fixed VHDX, disabled checkpoints, fixed RAM, no NIC, exact VM GUID/nonce/directory/disk ownership checks.
- `scripts/environment/guest-*.ps1`: guarded Guest-only installer, production SEA IPC and interactive UI Automation probes. They reject a missing Guard/SMBIOS binding before mutations.

Only Hyper-V is implemented. Windows Sandbox, Linux VM, container, Android and independent AgentOS remain unavailable contract entries. Native process execution is not an OS sandbox.

An execution binds Actor, Task ID, existing Attempt ID, Run UUID, Environment UUID, workspace, `environment.test`, profile digest, expiration and all quotas. Agent inputs contain only a selected profile ID and digest. Neither arbitrary Host commands nor caller-selected Host paths are accepted.

## Owner-prepared host and Guest

Prepare these outside an Agent writable workspace. This is an Owner deployment step, not performed by the test runner:

1. A licensed Windows 11 x64 Guest VHDX with documented source, exact build and SHA-256, no parent disk, and virtual capacity within the profile quota. The image must already complete Windows setup and have WebView2 available for the Desktop UI.
2. A qualified Hyper-V host and adequate space for a **fixed independent clone** plus RAM and evidence reserve. Current limits allow 1–4 vCPUs, 4–8 GiB Guest RAM, 32–128 GiB disk, 10 seconds–1 hour and at most 64 MiB / 128 exported files. Start with 2 CPUs, 4 GiB RAM and 64 GiB disk.
3. An Owner-launched privileged Host deployment whose Node runtime, source, PowerShell scripts, configuration, images and credential references are protected against ordinary-user writes. The backend fails closed on unsafe ACLs. Do not run privileged code from an Agent-editable checkout. Deploy a reviewed source snapshot with its dependencies to an administrator-controlled location first; do not modify Windows ACLs just to make a test pass.
4. A Guest credential exported by that Host identity as a DPAPI-protected `PSCredential` CLIXML file. Never commit it. PowerShell Direct uses Host-local VM identity and Guest credentials; it is not an interactive desktop session. See [Microsoft PowerShell Direct prerequisites](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct).
5. For W02/W03, an existing logged-on interactive Guest user. The suite uses a bounded scheduled task with that user token. It does not enable autologon or create host sessions. Without a usable interactive session/UI Automation, those checks stay `BLOCKED_ENV`.
6. A private random 64-hex-character token file and a local pipe named `\\.\pipe\CetaMeshEnvironment-<deployment-name>`. The same secret is configured only in the trusted Host and trusted Core client. It is never passed to Guest tests.

The default is offline: no Guest NIC. Synthetic model servers bind to Guest loopback. Real Provider testing needs a separately reviewed network/credential profile; v1 does not silently open networking.

## Profiles and candidate provenance

The developer Host config is JSON with `root`, `pipe`, `tokenFile`, and `profiles`. A profile has this shape; substitute Owner-verified values, never these placeholders:

```json
{
  "version": 1,
  "id": "win11-offline",
  "backend": "hyper-v",
  "mode": "cetamesh",
  "network": "offline",
  "image": {
    "id": "owner-win11",
    "path": "C:\\ProtectedEnvironment\\images\\base.vhdx",
    "sha256": "<64 lowercase hex>",
    "source": "owner-approved-local-image",
    "windowsBuild": "26100",
    "architecture": "x64"
  },
  "candidate": {
    "root": "C:\\ProtectedEnvironment\\candidate",
    "installer": "WhaleBridge.exe",
    "installerSha256": "<64 lowercase hex>",
    "manifestSha256": "<SHA-256 of environment-inputs.json>",
    "buildCommit": "<40 hex commit>",
    "buildHash": "<SHA-256 of environment-inputs.json>"
  },
  "guestCredentialFile": "C:\\ProtectedEnvironment\\guest-credential.xml",
  "limits": {
    "cpuCount": 2, "memoryMiB": 4096, "diskGiB": 64,
    "timeoutMs": 900000, "maxEvidenceBytes": 67108864,
    "maxEvidenceFiles": 128
  },
  "packIds": ["W01", "W02", "W03", "W04", "W05", "W06", "W07"],
  "retainedLimit": 1
}
```

`environment-inputs.json` is an explicit candidate inventory: `{"files":[{"path":"WhaleBridge.exe","sha256":"...","bytes":123}, ...]}`. List all required release bundle files, including `payload/WhaleBridgeCore.exe`, with exact relative paths, sizes and SHA-256. Protect the reviewed inventory and candidate from writes. This suite uses the production **release CLI bundle** (`WhaleBridge.exe` plus `payload/`), with the verified installer flags. It does not claim coverage of the outer IExpress self-extracting `CetaMesh-Setup-*.exe` wrapper. `buildHash` identifies the pinned inventory; `buildCommit` is checked against installed build metadata.

For the first VM bootstrap smoke test use `mode: "lifecycle-fixture"` and `candidate: null`. This checks the VM/Guest/file/evidence lifecycle only. It is never product installation or onboarding acceptance, even if its own lifecycle succeeds.

## Running and Core integration

From the reviewed developer deployment, with Node on PATH:

```powershell
# Read-only. Does not elevate or enable Hyper-V.
node scripts/environment-test.mjs --preflight

# Run on the already prepared Owner host. Startup checks but does not create a VM.
node scripts/environment-host.mjs --config C:\ProtectedEnvironment\host.json

# In another trusted Core client process. --approve-run is an explicit Owner action.
node scripts/environment-test.mjs --config C:\PrivateCore\client.json --profile win11-offline --state-dir C:\PrivateCore\environment-acceptance --approve-run --report C:\PrivateCore\environment-acceptance\report.json
```

The client JSON requires only `pipe` and `tokenFile`. The CLI uses the production Workspace, Task, Capability and Approval implementations in its dedicated state directory; it does not modify the user's normal Desktop state. The CLI creates a Task and obtains the current profile digest before the Owner-approved dispatch.

For embedding in an already trusted Core deployment, construct `createEnvironmentHostClient({pipe,token})` and inject it as `createCetaMeshServices({environmentClient,...})`. Default product startup does not discover or auto-enable a Host. Existing Agent integrations use the same Capability Broker:

- `environment.profiles`: available IDs, digests, limits and pack IDs; no Host paths or credentials.
- `environment.test`: explicitly granted and high-risk; every Agent dispatch requires existing Owner approval.
- `environment.status`, `environment.report`, `environment.cancel`: scoped to the existing Task/workspace/Run; normal Capability grants still apply.
- `environment.reconcile`: explicit high-risk Owner review after a disconnect. Queries the same immutable binding and verified final report without rerunning effects. Only confirmed destroyed/not-created resources release the environment blocker; the original unknown Attempt remains historical, and Core records the Owner decision. An actual retained VM remains blocked for exact-resource inspection.

Grant these IDs deliberately through the existing Owner task-grant flow. The ordinary Agent grant set excludes them. An Agent cannot provide its own privileged token, replace Task identity, approve its own start or mark its Task completed from a Guest result.

## Test packs and evidence

| Pack | Implemented probe | Acceptance boundary |
| --- | --- | --- |
| W01 | Pinned release files, real installer exit, installed Core hash/build | Actual Guest installation required |
| W02 | Owned GUI process and native window | Interactive Guest required |
| W03 | UI Automation saves model step 4, advances optional steps and reaches Chat | Button presence alone is insufficient |
| W04 | Installed SEA authenticated IPC, synthetic provider, Task/Attempt, Memory/Workspace read/auth/error checks | Integration probes run inside Guest |
| W05 | Managed tool roundtrip/progress/cancel probes; external provider conditional | Synthetic endpoint is labeled; external real connection remains separate |
| W06 | Owned process cancellation/crash, persisted Task and unknown Attempt after restart, rejected replay | A restart cannot be reported as successful replay |
| W07 | Verified uninstall path; upgrade requires previous candidate | Upgrade stays blocked without supported previous artifact input |

Results are `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED_ENV`, or `INCONCLUSIVE`; layers are `Unit/Fixture`, `Integration`, `Windows VM E2E`, and `Real Provider E2E`. Missing named checks, foreign binding, wrong OS/build, invalid exit, wrong proof layer and malformed evidence cannot become PASS. A report can have mixed pack outcomes; conditional real Provider absence does not erase individual completed checks.

Guest evidence is copied with byte/file limits, reparse/traversal checks and hash verification. The Host preserves immutable execution evidence under `evidence/<runId>/`, including a manifest and JSON/Markdown report. Only a verified receipt permits exact-owned cleanup. A separate `final-reports/<runId>.json` records the final stop/destruction/quarantine outcome, including failures before Guest export. Core attaches a Markdown report under its existing owned-artifact root. Full Host diagnostics stay private.

If creation, stop, export, identity or transport completion is uncertain, retain the run as quarantined; never retry create/install automatically. One retained environment prevents another run. Owner reconciliation must inspect the exact saved Run/Environment/VM GUID and directory. There is deliberately no wildcard cleanup or “delete all test VMs” command. Do not edit an unknown row to completed merely to unblock admission.

The Host keeps its authenticated query endpoint available even when startup preflight blocks new runs. A stopped or quarantined resource is not synonymous with a destroyed resource. Failure before Guest export produces a Host-only partial final report and retains the VM; that report does not claim Guest diagnostics were recovered.

## Regression and real acceptance

Use root `npm test`; every new test is registered:

```powershell
npm test -- --suite test-environment-contracts --suite test-environment-host --suite test-environment-hyperv --suite test-environment-packs --suite test-environment-capability --suite test-environment-vm --jobs 2
```

Without explicit opt-in, the VM suite performs only a read-only preflight and exits with `NOT_RUN_ENVIRONMENT` (77). This is a skip, not PASS. For an Owner-prepared host, set `CETAMESH_ENV_VM_OPT_IN=1`, `CETAMESH_ENV_CONFIG`, `CETAMESH_ENV_PROFILE`, and `CETAMESH_ENV_TEST_STATE` explicitly for that test process. Do not put credentials in CI. Hosted Windows CI cannot be assumed to support nested Hyper-V or an interactive Guest.

Unit fixtures and Windows PowerShell parser checks validate contracts and failure paths. They do not establish that Hyper-V, UI Automation, Windows installation, outside Agent authentication or release upgrades work on a real image. Run lifecycle smoke first, then the pinned product bundle, and retain exact source/artifact/image identities with the final reports for human acceptance.
