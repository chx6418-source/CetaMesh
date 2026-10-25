import { AGENT_PROVIDER_METHODS, agentProviderError, defineAgentProvider } from './agent-provider.js';
import { createAcpAgentProvider } from './acp-agent-provider.js';
import { isNativePermissionSecurity } from './execution-security.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import path from 'node:path';
import { APP_PATHS, isPackagedRuntime } from '../app-paths.js';
import { createAcpProcessLauncher } from './acp-provider-descriptors.js';
import { CLAUDE_NATIVE_TOOLS, createClaudeOwnedProfile, createClaudeRuntimeVerifier } from './claude-runtime.js';

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
      && runtime.security?.verified === true
      && ((runtime.security.mode === 'native' && runtime.security.nativeSandboxSupported === true && runtime.security.nativeApprovalSupported === true)
        || isNativePermissionSecurity(runtime.security)) && (launchSdkRunner == null || typeof launchSdkRunner === 'function')
      && typeof resolveCredential === 'function' && typeof taskOptions.resolveTaskWorkspace === 'function') {
    const launcher = launchSdkRunner ?? createClaudeSdkRunnerLauncher();
    return createAcpAgentProvider({
      descriptor: { id: 'claude', label: 'Claude', protocolVersion: 1, verifiedRuntime: true, security: runtime.security },
      resolveTaskWorkspace: taskOptions.resolveTaskWorkspace, applyChanges: taskOptions.applyChanges,
      approvalStatus: taskOptions.approvalStatus, cancelApproval: taskOptions.cancelApproval,
      requestNativeApproval, log, validateRuntime: taskOptions.validateRuntime, stagingRoot: taskOptions.stagingRoot,
      excludedRoots: taskOptions.excludedRoots, listWorkspaceRoots: taskOptions.listWorkspaceRoots, snapshotExcludedPaths: taskOptions.snapshotExcludedPaths,
      async launch(binding) {
        // Secret resolved only after Task Workspace binding and staging were established.
        const credential = await resolveCredential(taskOptions.credentialRef);
        const apiKey = typeof credential === 'string' ? credential : credential?.apiKey;
        if (typeof apiKey !== 'string' || !apiKey) throw Object.assign(new Error('Claude credential unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
        await taskOptions.validateRuntime?.();
        const handle = await launcher(binding);
        // Shared lifecycle owns close + observed exit before bootstrap can fail.
        binding.onHandle(handle);
        const bootstrap = createJsonRpcTransport({ readable: handle.readable, writable: handle.writable, framing: 'acp-v1-jsonl' });
        try {
          await bootstrap.request('initialize', { credential: apiKey, cwd: binding.cwd, runtimePath: runtime.runtimePath,
            ...(typeof credential?.baseUrl === 'string' ? { baseUrl: credential.baseUrl } : {}),
            ...(handle.profileRoot ? { profileRoot: handle.profileRoot, executionMode: 'native-permissions' } : {}),
            tools: runtime.tools ?? [], ...(runtime.model === undefined ? {} : { model: runtime.model }) }, { timeoutMs: 15000 });
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


/** Owner-configured production runtime. All verification and launch inputs stay in Core. */
export function createConfiguredClaudeAgentProvider({ runtimeConfiguration, taskOptions = {}, requestNativeApproval, log,
  resourceRoot = APP_PATHS.resourceRoot } = {}) {
  if (!runtimeConfiguration || ['get', 'identity', 'configure', 'resolveCredential'].some(key => typeof runtimeConfiguration[key] !== 'function')) {
    throw new TypeError('Claude runtime configuration service required');
  }
  const verifier = createClaudeRuntimeVerifier({ resourceRoot });
  const unavailable = createClaudeAgentProvider();
  const sessions = new Map(), inners = new Set(), creating = new Set();
  let latest = null, closing = false, shutdownPromise;
  const current = () => ({ configuration: runtimeConfiguration.get('claude'), identity: runtimeConfiguration.identity('claude') });
  function security(evidence = {}, configurationIdentity = null, verified = false) {
    return { mode: 'native-permissions', verified, nativeSandboxSupported: false, strictIsolationVerified: false,
      nativeSandboxMode: 'none', nativeApprovalPolicy: 'ask-once', nativeApprovalSupported: true,
      nativePermissionPolicyVerified: verified, allToolsRequireApproval: true,
      configurationIdentity, runtimeBinaryHash: evidence.binaryHash ?? null, sdkResourceHash: evidence.sdkHash ?? null,
      runtimeVersion: evidence.version ?? null, tools: [...CLAUDE_NATIVE_TOOLS],
      securityLimitations: ['Native tool approvals do not provide an OS sandbox. Approved commands may access host files and network.'] };
  }
  function configurationFailure(error) {
    const reason = typeof error?.code === 'string' && /^AGENT_RUNTIME_(?:CONFIG_[A-Z_]+|CHANGED)$/.test(error.code)
      ? error.code : 'AGENT_RUNTIME_CONFIG_UNAVAILABLE';
    return { provider: 'claude', available: false, readyForTask: false, taskEligible: false, installed: null, compatible: null,
      authConfigured: null, authVerified: false, authenticated: null, authentication: 'unknown', sessionCapable: false, binaryVerified: false, sdkResourcesVerified: false, nativePolicyVerified: false,
      reason, runtimeConfiguration: null };
  }
  function reasonFor(configuration, evidence) {
    if (!configuration.enabled) return 'disabled';
    if (configuration.executionMode !== 'native-permissions') return 'native_policy_unverified';
    if (evidence.reason) return evidence.reason;
    if (!configuration.credentialConfigured) return 'credential_missing';
    if (typeof taskOptions.resolveTaskWorkspace !== 'function') return 'task_binding_unavailable';
    if (typeof requestNativeApproval !== 'function') return 'native_approval_unavailable';
    return null;
  }
  async function refresh() {
    const selected = current();
    const evidence = selected.configuration.enabled ? await verifier.inspect(selected.configuration.runtimePath)
      : { installed: null, compatible: false, binaryVerified: false, sdkResourcesVerified: false, reason: 'disabled' };
    if (current().identity !== selected.identity) throw agentProviderError('AGENT_RUNTIME_CHANGED', 'Claude configuration changed; refresh and create a new session');
    const reason = reasonFor(selected.configuration, evidence);
    const identity = JSON.stringify([selected.identity, evidence.binaryHash, evidence.sdkHash, evidence.reason]);
    if (latest?.identity === identity) return latest;
    const record = { ...selected, identity, configurationIdentity: selected.identity, evidence, reason,
      security: security(evidence, selected.identity, !reason), inner: null };
    if (!reason) {
      async function validateRuntime() {
        if (closing) throw agentProviderError('PROVIDER_SHUTTING_DOWN', 'Claude provider is shutting down');
        const now = current();
        if (now.identity !== record.configurationIdentity) throw agentProviderError('AGENT_RUNTIME_CHANGED', 'Claude configuration changed; create a new session');
        const checked = await verifier.inspect(now.configuration.runtimePath);
        if (current().identity !== record.configurationIdentity || checked.reason || checked.binaryHash !== evidence.binaryHash || checked.sdkHash !== evidence.sdkHash) {
          throw agentProviderError('AGENT_RUNTIME_CHANGED', 'Claude runtime changed; refresh and create a new session');
        }
      }
      record.inner = createClaudeAgentProvider({
        taskOptions: { ...taskOptions, credentialRef: 'agent-claude', validateRuntime, verifiedRuntime: { verified: true,
          sdkResourcesVerified: true, binaryVerified: true, runtimePath: evidence.runtimePath,
          ...(selected.configuration.model ? { model: selected.configuration.model } : {}),
          tools: [...CLAUDE_NATIVE_TOOLS], security: record.security } },
        async requestNativeApproval(request, context) {
          await validateRuntime();
          const decision = await requestNativeApproval(request, context);
          await validateRuntime();
          return decision;
        }, log,
        async resolveCredential() {
          await validateRuntime();
          const credential = await runtimeConfiguration.resolveCredential('claude');
          if (current().identity !== record.configurationIdentity || credential?.baseUrl !== selected.configuration.baseUrl) {
            throw agentProviderError('AGENT_RUNTIME_CHANGED', 'Claude credential scope changed; create a new session');
          }
          return credential;
        },
        async launchSdkRunner(binding) {
          await validateRuntime();
          const profile = createClaudeOwnedProfile();
          let wrapped;
          const wrap = handle => {
            if (wrapped) return wrapped;
            wrapped = { ...handle, profileRoot: profile.root, async close() {
              await handle.close(); await handle.done; profile.cleanup();
            } };
            binding.onHandle?.(wrapped); return wrapped;
          };
          try {
            const launch = createClaudeSdkRunnerLauncher({ envSource: profile.environment });
            const handle = await launch({ ...binding, onHandle: wrap });
            return wrap(handle);
          } catch (error) {
            // Once captured, shared ACP lifecycle owns exit confirmation and profile cleanup.
            if (!wrapped) profile.cleanup();
            throw error;
          }
        }
      });
      inners.add(record.inner);
    }
    latest = record; return record;
  }
  function route(params = {}) {
    const binding = sessions.get(params.sessionId);
    if (!binding) throw agentProviderError('SESSION_NOT_FOUND', 'Claude session unavailable; create a new session');
    if ((params.taskId !== undefined && params.taskId !== binding.taskId) || (params.workspaceId !== undefined && params.workspaceId !== binding.workspaceId)) {
      throw agentProviderError('TASK_WORKSPACE_MISMATCH', 'Claude session binding mismatch');
    }
    return binding.inner;
  }
  const provider = { id: 'claude', label: 'Claude', eventProtocol: 'agent-turn-events-v1',
    configure(settings = {}) {
      if (sessions.size || creating.size) throw agentProviderError('AGENT_RUNTIME_BUSY', 'Close Claude sessions before changing its runtime configuration');
      if (closing) throw agentProviderError('PROVIDER_SHUTTING_DOWN', 'Claude provider is shutting down');
      return runtimeConfiguration.configure('claude', settings);
    },
    capabilities() {
      let selected;
      try { selected = current(); }
      catch (error) {
        // Optional configuration failure must not escape composition-time provider enumeration.
        return { ...unavailable.capabilities(), ...configurationFailure(error), eventProtocol: 'agent-turn-events-v1', security: security() };
      }
      const valid = latest?.configurationIdentity === selected.identity;
      const active = valid && !latest.reason && !closing;
      const base = active ? latest.inner : unavailable;
      return { ...base.capabilities(), eventProtocol: 'agent-turn-events-v1', available: Boolean(active), readyForTask: Boolean(active),
        reason: closing ? 'provider_shutting_down' : valid ? latest.reason : selected.configuration.enabled ? 'runtime_verification_required' : 'disabled',
        security: valid ? latest.security : security({}, selected.identity), runtimeConfiguration: selected.configuration };
    },
    async health() {
      let record;
      try { record = await refresh(); }
      catch (error) { return configurationFailure(error); /* Keep malformed optional configuration untouched and fail closed. */ }
      const available = !record.reason && !closing;
      return { provider: 'claude', available, installed: record.evidence.installed, compatible: record.evidence.compatible,
        authConfigured: record.configuration.credentialConfigured, authVerified: false, authenticated: null,
        authentication: record.configuration.credentialConfigured ? 'configured-unverified' : 'not-configured',
        sessionCapable: available, taskEligible: available, readyForTask: available,
        reason: closing ? 'provider_shutting_down' : record.reason, version: record.evidence.version ?? null,
        binaryVerified: record.evidence.binaryVerified, sdkResourcesVerified: record.evidence.sdkResourcesVerified,
        nativePolicyVerified: !record.reason, runtimeConfiguration: record.configuration };
    },
    createSession(params = {}) {
      const pending = (async () => {
        if (closing) throw agentProviderError('PROVIDER_SHUTTING_DOWN', 'Claude provider is shutting down');
        if (sessions.size + creating.size >= 16) throw agentProviderError('AGENT_SESSION_LIMIT', 'Claude session limit reached');
        const record = await refresh();
        if (record.reason) throw agentProviderError('PROVIDER_UNAVAILABLE', 'Claude runtime is not ready: ' + record.reason);
        try {
          const result = await record.inner.createSession(params);
          sessions.set(result.sessionId, { inner: record.inner, taskId: params.taskId, workspaceId: params.workspaceId });
          return result;
        } catch (error) {
          if (error?.sessionId) sessions.set(error.sessionId, { inner: record.inner, taskId: params.taskId, workspaceId: params.workspaceId });
          throw error;
        }
      })();
      creating.add(pending); pending.then(() => creating.delete(pending), () => creating.delete(pending));
      return pending;
    },
    async *follow(params) { yield* route(params).follow(params); },
    async shutdown() {
      closing = true;
      if (!shutdownPromise) shutdownPromise = (async () => {
        await Promise.allSettled([...creating]);
        const results = await Promise.allSettled([...inners].map(inner => inner.shutdown()));
        if (results.some(result => result.status === 'rejected')) throw agentProviderError('ACP_CLOSE_UNKNOWN', 'Claude shutdown incomplete; owned resources retained');
        sessions.clear(); inners.clear();
      })();
      try { await shutdownPromise; } catch (error) { shutdownPromise = null; throw error; }
    }
  };
  for (const method of AGENT_PROVIDER_METHODS) {
    if (provider[method]) continue;
    provider[method] = async params => {
      const result = await route(params)[method](params);
      if (method === 'closeSession') sessions.delete(params.sessionId);
      return result;
    };
  }
  return Object.freeze(provider);
}
