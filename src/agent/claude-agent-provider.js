import { defineAgentProvider } from './agent-provider.js';
import { createAcpAgentProvider } from './acp-agent-provider.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import path from 'node:path';
import { APP_PATHS, isPackagedRuntime } from '../app-paths.js';
import { createAcpProcessLauncher } from './acp-provider-descriptors.js';

/** The private mode always uses this Core executable, never an assumed system Node. */
export function claudeRunnerLaunchSpec({ executable = process.execPath, sea = false, entry } = {}) {
  if (!sea && !entry) throw new TypeError('Source Core entry required');
  return { command: executable, args: [...(sea ? [] : [entry]), '--agent-sdk-runner', 'claude'], shell: false };
}

/** Reuse the reviewed raw-pipe supervisor and observed process-close contract. */
export function createClaudeSdkRunnerLauncher({executable = process.execPath, sea = isPackagedRuntime(),
  entry = path.join(APP_PATHS.sourceRoot,'src','core-entry.js'), spawnImpl, envSource} = {}) {
  const spec = claudeRunnerLaunchSpec({executable,sea,entry});
  return createAcpProcessLauncher({executable:spec.command,argv:spec.args,spawnImpl,envSource});
}

// SDK resources, official executable and native policy have not been validated in SEA.
// Configuring credentials or injecting a launcher cannot bypass these readiness gates.
export function createClaudeAgentProvider({ launchSdkRunner, taskOptions, resolveCredential, requestNativeApproval, log } = {}) {
  const runtime = taskOptions?.verifiedRuntime;
  if (runtime?.verified === true && runtime.sdkResourcesVerified === true && runtime.binaryVerified === true
      && runtime.security?.verified === true && runtime.security.nativeSandboxSupported === true
      && runtime.security.nativeApprovalSupported === true && (launchSdkRunner == null || typeof launchSdkRunner === 'function')
      && typeof resolveCredential === 'function' && typeof taskOptions.resolveTaskWorkspace === 'function') {
    const launcher = launchSdkRunner ?? createClaudeSdkRunnerLauncher();
    return createAcpAgentProvider({
      descriptor: { id: 'claude', label: 'Claude', protocolVersion: 1, verifiedRuntime: true, security: runtime.security },
      resolveTaskWorkspace: taskOptions.resolveTaskWorkspace, applyChanges: taskOptions.applyChanges,
      approvalStatus: taskOptions.approvalStatus, cancelApproval: taskOptions.cancelApproval,
      requestNativeApproval, log,
      async launch(binding) {
        // Secret resolved only after Task Workspace binding and staging were established.
        const credential = await resolveCredential(taskOptions.credentialRef);
        if (typeof credential !== 'string' || !credential) throw Object.assign(new Error('Claude credential unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
        const handle = await launcher(binding);
        // Shared lifecycle owns close + observed exit before bootstrap can fail.
        binding.onHandle(handle);
        const bootstrap = createJsonRpcTransport({ readable: handle.readable, writable: handle.writable, framing: 'acp-v1-jsonl' });
        try {
          await bootstrap.request('initialize', { credential, cwd: binding.cwd, runtimePath: runtime.runtimePath,
            tools: runtime.tools ?? [] }, { timeoutMs: 15000 });
          // Release bootstrap request bookkeeping before the lifecycle channel starts its IDs.
          await new Promise(resolve => setImmediate(resolve));
          return handle;
        } finally { bootstrap.close(); }
      }
    });
  }
  return defineAgentProvider({ id: 'claude', label: 'Claude', eventProtocol: null,
    capabilityExtras: { available: false, reason: 'runtime_security_unverified', readyForTask: false,
      workspaceBoundary: 'unsupported', supportsFreshSession: false, supportsResume: false,
      security: { mode: 'native', nativeSandboxMode: 'unverified', nativeSandboxSupported: false,
        nativeApprovalPolicy: 'ask', strictIsolationVerified: false,
        securityLimitations: ['Official binary, SDK resources under SEA and native execution boundaries are unverified.'] } },
    methods: { async health() { return { provider: 'claude', available: false, readyForTask: false,
      reason: 'runtime_security_unverified', nativePolicyVerified: false }; } }
  });
}
