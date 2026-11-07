import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { agentProviderError as fault, defineAgentProvider, normalizePromptContent,
  agentCreationPreflightFailure, runAgentCreationPreflight, AGENT_EVENT_PROTOCOL_DSH } from './agent-provider.js';
import { CliAgentProcess, createMinimalAgentEnv } from './cli-agent-process.js';
import { createDshSdkProfile, DSH_GATE_POLICY_VERSION, DSH_TOOL_GATE_SOURCE } from './dsh-sdk-profile.js';
import { createCodexSessionLifecycle } from './codex-session-lifecycle.js';
import { createAgentEventBuffer } from './protocol/agent-event-buffer.js';
import { createAgentPermissionBridge, permissionFingerprint } from './protocol/agent-permission-bridge.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import { canonicalizeRoot, resolveInside } from '../workspace/boundary.js';

const VERSION = '0.2.2-rc.1';
const TOOLS = new Set(['read', 'write', 'edit']);
const FILE_SCOPE_POLICY = 'task-staging-file-tools-v2';
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const stopped = result => result?.terminationConfirmed !== false && result?.effectStatus !== 'unknown'
  && (result?.terminationConfirmed === true || result?.processTreeExitConfirmed === true);

function runtimeIdentity(runtime) {
  return permissionFingerprint({ version: runtime.version, nodePath: runtime.nodePath, dshBin: runtime.dshBin,
    artifactIdentity: runtime.identity ?? null,
    baseUrl: runtime.baseUrl, model: runtime.model, configuration: runtime.configuration ?? null,
    credential: hash(runtime.apiKey) });
}

function fileSnapshot(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fault('DSH_SDK_PROFILE_CHANGED', 'DSH profile artifact is not a regular owned file');
  return { path: file, dev: stat.dev, ino: stat.ino, sha256: hash(fs.readFileSync(file).toString('base64')) };
}

function stagingSnapshot(directory) {
  const canonical = canonicalizeRoot(directory), stat = fs.lstatSync(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('DSH_SDK_STAGING_CHANGED', 'DSH requires the exact canonical Task staging directory');
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function assertStagingRoot(s) {
  const stat = fs.lstatSync(s.cwd, { bigint: true });
  if (!s.staging || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== s.staging.dev || stat.ino !== s.staging.ino
    || fs.realpathSync(s.cwd) !== s.cwd) throw fault('DSH_SDK_STAGING_CHANGED', 'The owned Task staging directory changed');
}

function resolveStagedFile(s, toolName, input) {
  if (typeof input.file_path !== 'string' || !input.file_path) throw fault('DSH_SDK_FILE_SCOPE_INVALID', 'DSH file tools require their exact file_path string');
  // The pinned native filesystem expands these spellings before path.resolve.
  // Core's shared boundary treats them literally, so their targets would differ.
  // Reject them without changing the actual arguments presented for approval.
  if (input.file_path === '~' || input.file_path.startsWith('~/') || input.file_path.startsWith('~\\')) {
    throw fault('DSH_SDK_FILE_SCOPE_INVALID', 'DSH Task file tools require a staging path without home expansion');
  }
  assertStagingRoot(s);
  const resolved = resolveInside(s.cwd, input.file_path, { forWrite: toolName !== 'read' });
  // The shared boundary resolves lexical/real paths; this file-tool scope also
  // excludes ADS segments while preserving an absolute Windows path's drive.
  if (path.relative(s.cwd, resolved.absolute).split(/[\\/]/).some(segment => segment.includes(':'))) {
    throw fault('DSH_SDK_FILE_SCOPE_INVALID', 'DSH Task file tools do not accept alternate data streams');
  }
  return resolved;
}

/** Official SDK JSON-RPC over one supervised, private runtime per Core Task. */
export function createDshSdkTaskTransport({ runtimeResolver, stateDir, requestNativeApproval,
  settleNativeEffect, log = () => {}, launch, sessionLifecycle, ownedTreeSupervisor, allowLoopbackHttpForTests = false } = {}) {
  if (typeof runtimeResolver !== 'function' || !path.isAbsolute(stateDir ?? '')) throw new TypeError('DSH SDK requires a runtime resolver and absolute Core StateDir');
  const sessions = new Map(), creations = new Set();
  const lifecycle = sessionLifecycle ?? createCodexSessionLifecycle({ stateDir, provider: 'dsh' });
  let shuttingDown = false, verified = null, healthProof = null, healthPending = null;
  const safeLog = code => log(`DSH SDK: ${/^[A-Z0-9_]+$/.test(code ?? '') ? code : 'DSH_SDK_FAILURE'}`);

  async function resolveRuntime() {
    if (process.platform === 'win32' && !launch && !isSea() && !ownedTreeSupervisor) {
      throw fault('DSH_SDK_SUPERVISOR_REQUIRED', 'Source DSH execution requires an explicitly verified owned-process supervisor');
    }
    const runtime = await runtimeResolver();
    if (runtime?.version !== VERSION || typeof runtime.validate !== 'function'
      || !path.isAbsolute(runtime.nodePath ?? '') || !path.isAbsolute(runtime.dshBin ?? '')
      || !/^node(?:\.exe)?$/i.test(path.basename(runtime.nodePath)) || !/\.[cm]?js$/i.test(runtime.dshBin)
      || !text(runtime.model) || typeof runtime.apiKey !== 'string' || !runtime.apiKey
      || typeof requestNativeApproval !== 'function' || typeof settleNativeEffect !== 'function') {
      throw fault('DSH_SDK_RUNTIME_UNVERIFIED', 'The paired DSH SDK runtime and approval callbacks are not verified');
    }
    await runtime.validate();
    return runtime;
  }

  async function validateSession(s) {
    const current = await resolveRuntime();
    if (runtimeIdentity(current) !== s.identity) throw fault('DSH_SDK_RUNTIME_CHANGED', 'DSH SDK configuration changed; create a fresh owned runtime');
    await s.profile.verify();
    for (const file of s.bootstrap ?? []) {
      const actual = fileSnapshot(file.path);
      if (actual.dev !== file.dev || actual.ino !== file.ino || actual.sha256 !== file.sha256) {
        throw fault('DSH_SDK_PROFILE_CHANGED', 'The bootstrapped DSH profile changed');
      }
    }
    for (const file of [path.join(s.profile.homeDir, 'cordis.patch.yml'), path.join(s.profile.homeDir, '.env'),
      path.join(s.controlDir, '.env')]) {
      if (fs.existsSync(file)) throw fault('DSH_SDK_PROFILE_CHANGED', 'Unexpected ambient DSH configuration is present');
    }
  }

  function captureBootstrap(s) {
    const base = path.join(s.profile.homeDir, 'profiles', 'sdk-minimal');
    const manifestFile = path.join(base, 'package.json'), patchFile = path.join(base, 'cordis.patch.yml');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(['@deepseek-ai/dsh-sdk-minimal'])
      || Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length
      || fs.readFileSync(patchFile, 'utf8').split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('').trim() !== '[]') {
      throw fault('DSH_SDK_PROFILE_CHANGED', 'DSH SDK startup composition is not the owned minimal profile');
    }
    s.bootstrap = [manifestFile, patchFile].map(fileSnapshot);
  }

  function emit(s, nativeEvent, extra = {}) {
    const run = s.run ?? s.lastRun;
    const seq = ++s.sequence;
    const event = { ...nativeEvent, seq, data: { ...nativeEvent.data, taskId: s.taskId, workspaceId: s.workspaceId,
      runId: run?.runId ?? null, phase: run?.phase ?? 'unknown', ...extra } };
    s.buffer.push({ type: 'event', seq, source: 'dsh', eventId: `dsh:${s.id}:${seq}`,
      nativeEvent: structuredClone(nativeEvent), event });
  }

  function activity(s, call, status) {
    emit(s, { type: 'tool/activity', data: { turn: s.run?.nativeTurn ?? null } }, { activity: {
      id: call.id, name: call.name, capability: `dsh.native.${call.name}`,
      status, executionBoundary: 'agent-native' } });
  }

  function requireSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || s.closed) throw fault('SESSION_NOT_FOUND', 'The owned DSH SDK Session is not available');
    return s;
  }

  function invalidate(s) {
    s.permissions?.close();
    if (s.run) s.run.cancelled = true;
  }

  function queue(s, work) {
    s.work = s.work.then(work).catch(error => {
      s.effectFailure = true; s.state = 'unknown'; safeLog(error?.code);
    });
  }

  async function settle(s, effect, outcome, evidence) {
    const result = await settleNativeEffect({ nativeEffectId: effect.nativeEffectId, provider: 'dsh',
      sessionId: s.id, taskId: s.taskId, workspaceId: s.workspaceId,
      runId: effect.runId, toolCallId: effect.callId, inputFingerprint: effect.inputFingerprint,
      outcome, ...(evidence ? { evidence } : {}) });
    if (outcome === 'completed' || outcome === 'failed') {
      if (outcome === 'completed' && result?.status !== 'completed'
        || outcome === 'failed' && (!['failed', 'outcome-unknown'].includes(result?.status)
          || result.status === 'failed' && effect.effectPolicy !== 'dsh-staging-read-v1')) {
        throw fault('DSH_NATIVE_EFFECT_UNKNOWN', 'Core did not retain the terminal native effect');
      }
      effect.terminal = ['completed', 'failed'].includes(result.status);
      effect.unknown = !effect.terminal;
    } else effect.unknown = true;
  }

  async function unknownEffects(s) {
    for (const effect of s.effects.values()) if (!effect.terminal && !effect.unknown) await settle(s, effect, 'unknown');
  }

  function receive(s, method, params) {
    if (s.closed || s.disconnected) return;
    if (method === 'session.status') {
      if (params?.sessionId !== s.id || !['idle', 'running'].includes(params.status)) throw fault('DSH_SDK_PROTOCOL_INVALID', 'Invalid DSH Session status');
      if (params.status === 'running' && !s.run) throw fault('DSH_SDK_PROTOCOL_INVALID', 'Unexpected DSH activity');
      return;
    }
    if (method !== 'session.event' || !keys(params, ['sessionId', 'event']) || params.sessionId !== s.id) {
      throw fault('DSH_SDK_PROTOCOL_INVALID', 'Unexpected DSH SDK notification');
    }
    const event = params.event, data = event?.data;
    if (!record(event) || !text(event.type) || !Number.isSafeInteger(event.seq) || event.seq !== s.nativeSequence + 1
      || !Number.isSafeInteger(event.time) || !record(data)) throw fault('DSH_SDK_PROTOCOL_INVALID', 'Invalid or discontinuous DSH Session event');
    s.nativeSequence = event.seq;
    if (event.type === 'tool/call') {
      if (!s.run || s.run.cancelled || !text(data.callId) || !text(data.name) || typeof data.arguments !== 'string'
        || Buffer.byteLength(data.arguments) > 65536 || s.calls.has(data.callId) || s.calls.size >= 1024) {
        throw fault('DSH_SDK_CALL_INVALID', 'DSH tool call is not uniquely bound to the current run');
      }
      let input;
      try { input = data.arguments ? JSON.parse(data.arguments) : {}; } catch { input = null; }
      s.calls.set(data.callId, { id: data.callId, name: data.name, input, seq: event.seq, run: s.run });
      emit(s, event); activity(s, s.calls.get(data.callId), 'running'); return;
    }
    if (event.type === 'approval/asked') {
      if (!text(data.id) || !text(data.callId) || !text(data.toolName) || typeof data.reason !== 'string'
        || Buffer.byteLength(data.reason) > 65536 || s.audits.has(data.id) || s.audits.size >= 1024) {
        throw fault('DSH_SDK_APPROVAL_INVALID', 'DSH approval audit is invalid');
      }
      s.audits.set(data.id, { ...data, pending: true, claimed: false }); emit(s, event); return;
    }
    if (event.type === 'approval/decided') {
      const audit = s.audits.get(data.id);
      if (!audit || !audit.pending || !['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(data.outcome)) {
        throw fault('DSH_SDK_APPROVAL_INVALID', 'DSH approval decision has no unique pending audit');
      }
      audit.pending = false; audit.outcome = data.outcome;
      if (data.outcome !== 'allowed-once') s.permissions?.invalidate(audit.callId);
      emit(s, event); return;
    }
    if (event.type === 'tool/result') {
      const message = data.message, call = s.calls.get(message?.toolCallId);
      if (!call || call.result || message?.role !== 'tool' || message.source?.kind !== 'tool'
        || message.source.callId !== call.id || !Array.isArray(message.content) || typeof message.isError !== 'boolean'
        || event.surfaceOp !== 'append' || JSON.stringify(event.sourceEventSeqs) !== JSON.stringify([call.seq])) {
        throw fault('DSH_SDK_RESULT_INVALID', 'DSH tool result does not identify its exact native call');
      }
      if (!message.isError && s.effects.get(call.id)?.released !== true) {
        throw fault('DSH_SDK_UNAPPROVED_RESULT', 'DSH reported success without the exact released Core permit');
      }
      call.result = true; s.permissions?.invalidate(call.id);
      const evidence = { source: 'native-result', resultSha256: hash(message.content), eventId: `dsh:${s.id}:${event.seq}` };
      queue(s, async () => {
        const effect = s.effects.get(call.id);
        if (effect?.released && !effect.terminal) await settle(s, effect, message.isError ? 'failed' : 'completed', evidence);
        activity(s, call, message.isError ? 'failed' : 'completed');
        emit(s, event, { ...evidence, capability: `dsh.native.${call.name}`, status: message.isError ? 'failed' : 'completed',
          runId: call.run.runId, phase: call.run.phase });
      }); return;
    }
    if (event.type === 'turn/start') {
      if (!s.run || s.run.cancelled || !Number.isSafeInteger(data.turn)) throw fault('DSH_SDK_TURN_INVALID', 'Unexpected DSH turn');
      s.run.nativeTurn = data.turn; emit(s, event); return;
    }
    if (event.type === 'turn/end') {
      const run = s.run;
      if (!run || data.turn !== run.nativeTurn || !text(data.reason?.kind)) throw fault('DSH_SDK_TURN_INVALID', 'DSH turn terminal does not match current activity');
      run.ended = true; s.permissions?.cancel();
      queue(s, async () => {
        await unknownEffects(s);
        const unknown = s.protocolViolation || s.effectFailure || [...s.effects.values()].some(effect => effect.runId === run.runId && !effect.terminal);
        emit(s, event, unknown ? { reason: { kind: 'error', error: { code: 'DSH_NATIVE_EFFECT_UNKNOWN', message: 'Native effect requires reconciliation' } } } : {});
        if (s.run === run) {
          if (s.lifecycle) lifecycle[unknown ? 'unknown' : 'observeIdle']({ sessionId: s.id, generation: run.generation, runId: run.runId });
          s.lastRun = run; s.run = null; s.state = unknown ? 'unknown' : 'ready';
        }
      }); return;
    }
    emit(s, event);
  }

  async function approval(s, method, params) {
    const run = s.run;
    const active = () => run && s.run === run && !run.cancelled && !run.ended && !s.stopping && !s.disconnected;
    if (run?.phase === 'bootstrap') return { outcome: 'cancelled' };
    if (method !== 'approval/request' || !active() || !keys(params, ['sessionId', 'callId', 'toolName', 'reason'])
      || params.sessionId !== s.id || !text(params.callId) || !TOOLS.has(params.toolName)
      || typeof params.reason !== 'string' || Buffer.byteLength(params.reason) > 65536) return { outcome: 'rejected' };
    const call = s.calls.get(params.callId);
    const matches = [...s.audits.values()].filter(row => row.pending && !row.claimed && row.callId === params.callId
      && row.toolName === params.toolName && row.reason === params.reason);
    let reason;
    try { reason = JSON.parse(params.reason); } catch { return { outcome: 'rejected' }; }
    if (!keys(reason, ['format', 'processNonce', 'policyFingerprint', 'sessionId', 'callId', 'toolName', 'input'])
      || reason.format !== 'cetamesh-dsh-tool-v1' || reason.processNonce !== s.processNonce
      || reason.policyFingerprint !== s.profile.policyFingerprint || reason.sessionId !== s.id
      || reason.callId !== params.callId || reason.toolName !== params.toolName
      || !call || call.run !== run || call.name !== params.toolName || call.result || !record(call.input)
      || !record(reason.input)
      || permissionFingerprint(reason.input) !== permissionFingerprint(call.input) || matches.length !== 1) return { outcome: 'rejected' };
    const audit = matches[0]; audit.claimed = true;
    let effect = null;
    s.waiting++; s.state = 'waiting'; activity(s, call, 'waiting-approval');
    try {
      await validateSession(s);
      if (!active() || !audit.pending) return { outcome: 'cancelled' };
      resolveStagedFile(s, call.name, reason.input);
      const result = await s.permissions.request({ sessionId: s.id,
        toolCall: { toolCallId: call.id, kind: call.name === 'read' ? 'read' : 'edit', title: call.name,
          rawInput: structuredClone(reason.input), locations: typeof reason.input.file_path === 'string' ? [{ path: reason.input.file_path }] : [] },
        options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] });
      if (result?.outcome?.outcome !== 'selected' || !text(result.nativeEffectId) || !/^[a-f0-9]{64}$/.test(result.inputFingerprint ?? '')) {
        return { outcome: active() ? 'rejected' : 'cancelled' };
      }
      if (result.inputFingerprint !== permissionFingerprint(reason.input)) return { outcome: 'rejected' };
      effect = { nativeEffectId: result.nativeEffectId, inputFingerprint: result.inputFingerprint, callId: call.id, runId: run.runId,
        ...(call.name === 'read' ? {effectPolicy: 'dsh-staging-read-v1'} : {}) };
      s.effects.set(call.id, effect);
      await validateSession(s);
      if (!active() || !audit.pending) { await settle(s, effect, 'unknown'); return { outcome: 'cancelled' }; }
      resolveStagedFile(s, call.name, reason.input);
      effect.released = true;
      return { outcome: 'allowed-once' };
    } catch (error) {
      if (effect && !effect.released && !effect.unknown) {
        try { await settle(s, effect, 'unknown'); }
        catch (failure) { s.effectFailure = true; safeLog(failure?.code); }
      }
      safeLog(error?.code); return { outcome: 'rejected' };
    }
    finally { s.waiting--; if (active()) s.state = s.waiting ? 'waiting' : 'running'; }
  }

  async function launchDefault({ runtime, profile, sessionId, controlDir, environment }) {
    if (process.platform === 'win32' && !isSea() && !ownedTreeSupervisor) {
      throw fault('DSH_SDK_SUPERVISOR_REQUIRED', 'Source DSH execution requires an explicitly verified owned-process supervisor');
    }
    const owner = new CliAgentProcess({ name: 'dsh-sdk', executable: runtime.nodePath,
      argsPrefix: [runtime.dshBin], envSource: createMinimalAgentEnv(),
      ownedTreeStateDir: path.join(stateDir, 'agent', 'dsh-sdk-processes'), ownedTreeSupervisor });
    const handle = owner.startSession({ sessionId, cwd: controlDir, args: ['--profile', profile.profile, '--patch', profile.patchPath],
      inputMode: 'open', timeoutMs: 30 * 60 * 1000, env: environment,
      authorizedEnvKeys: ['DSH_HOME', 'CETAMESH_DSH_TASK_API_KEY'] });
    return { readable: handle.child.stdout, writable: handle.child.stdin, done: handle.done,
      close: async () => { handle.shutdown(); await handle.done; await owner.shutdown(); } };
  }

  async function stop(s) {
    invalidate(s); s.stopping = true;
    if (s.lifecycle && !s.stopped) lifecycle.unknown({ sessionId: s.id });
    if (s.stopPromise) return s.stopPromise;
    s.stopPromise = (async () => {
      if (!s.handle?.done?.then || typeof s.handle.close !== 'function') throw fault('DSH_SDK_CLOSE_UNKNOWN', 'The attempted DSH launch has no confirmed supervisor handle');
      try { await s.rpc?.request('shutdown', {}, { timeoutMs: 1000 }); } catch { /* Supervisor remains the stop authority. */ }
      let result, timer;
      try { result = await Promise.race([s.handle.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]); }
      finally { clearTimeout(timer); }
      if (!result) { await s.handle.close(); result = await s.handle.done; }
      await s.rpc?.close(); await s.work;
      if (!stopped(result)) { s.state = 'unknown'; throw fault('DSH_SDK_CLOSE_UNKNOWN', 'Owned DSH runtime exit is unconfirmed; execution evidence retained'); }
      if (s.lifecycle && !s.protocolViolation) {
        const row = lifecycle.read(s.id);
        lifecycle.settle({ sessionId: s.id, generation: row.generation, runId: row.runId, proof: 'supervisor-close', staging: 'retained' });
      }
      s.stopped = true; s.state = 'stopped';
      try { await unknownEffects(s); }
      catch (error) { s.effectFailure = true; safeLog(error?.code); }
      return { stopped: true, sessionId: s.id, processExitObserved: true,
        processTreeExitConfirmed: true,
        effectsUnknown: s.protocolViolation || s.effectFailure || [...s.effects.values()].some(effect => !effect.terminal) };
    })();
    try { return await s.stopPromise; } catch (error) { s.stopPromise = null; throw error; }
  }

  function disconnected(s, error) {
    if (s.stopping || s.closed || s.disconnected) return;
    s.disconnected = true; invalidate(s); s.state = 'unknown';
    // A successful body without a released Core permit contradicts the trusted
    // policy. Its effects have no Core operation id to reconcile automatically.
    // Retain the lifecycle as unknown even after physical process exit.
    if (error?.code === 'DSH_SDK_UNAPPROVED_RESULT') s.protocolViolation = true;
    const run = s.run;
    if (run && !run.ended) {
      run.ended = true;
      queue(s, async () => {
        try { await unknownEffects(s); } catch (failure) { s.effectFailure = true; safeLog(failure?.code); }
        emit(s, { type: 'turn/end', data: { turn: run.nativeTurn ?? run.id,
          reason: { kind: 'error', error: { code: s.protocolViolation ? 'DSH_NATIVE_OUTCOME_UNKNOWN' : 'DSH_SDK_CONNECTION_LOST',
            message: 'DSH SDK execution evidence is incomplete' } } } });
        s.lastRun = run; s.run = null; s.buffer.close();
      });
    }
    void stop(s).catch(failure => safeLog(failure?.code)); safeLog(error?.code);
  }

  async function start(runtime, invocation, healthOnly = false, creation = {}) {
    const base = path.join(stateDir, 'agent', 'dsh-sdk'); fs.mkdirSync(base, { recursive: true });
    const controlDir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'session-')));
    const id = crypto.randomUUID(), processNonce = crypto.randomUUID();
    const profile = await createDshSdkProfile({ directory: path.join(controlDir, 'profile'), sessionId: id, nonce: processNonce,
      modelProvider: 'deepseek-official', model: runtime.model, baseUrl: runtime.baseUrl,
      allowLoopbackHttpForTests: allowLoopbackHttpForTests || runtime.allowLoopbackHttpForTests === true });
    const s = { id, controlDir, processNonce, profile, runtime, identity: runtimeIdentity(runtime),
      taskId: invocation.taskId ?? null, workspaceId: invocation.workspaceId ?? null,
      cwd: creation.staging?.path ?? invocation.cwd, staging: creation.staging,
      state: 'starting', sequence: 0, nativeSequence: -1, buffer: createAgentEventBuffer({ limit: 1024 }),
      calls: new Map(), audits: new Map(), effects: new Map(), work: Promise.resolve(), waiting: 0 };
    for (const dir of ['os-home', 'appdata', 'localappdata', 'tmp']) fs.mkdirSync(path.join(controlDir, dir));
    const environment = { HOME: path.join(controlDir, 'os-home'), USERPROFILE: path.join(controlDir, 'os-home'),
      APPDATA: path.join(controlDir, 'appdata'), LOCALAPPDATA: path.join(controlDir, 'localappdata'),
      TEMP: path.join(controlDir, 'tmp'), TMP: path.join(controlDir, 'tmp'),
      DSH_HOME: profile.homeDir, CETAMESH_DSH_TASK_API_KEY: runtime.apiKey };
    try {
      if (!healthOnly) assertStagingRoot(s);
      await profile.verify();
      if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN', 'DSH SDK Provider is shutting down');
      if (!healthOnly) {
        lifecycle.create({ sessionId: id, taskId: s.taskId, workspaceId: s.workspaceId,
          transport: 'dsh-sdk', snapshotId: path.basename(controlDir) });
        s.lifecycle = true;
      }
      creation.processAttempted = true;
      s.handle = await (launch ?? launchDefault)({ runtime, profile, sessionId: id, processNonce, controlDir, environment });
      if (!s.handle?.readable || !s.handle.writable || typeof s.handle.close !== 'function' || !s.handle.done?.then) {
        throw fault('DSH_SDK_LAUNCH_INVALID', 'DSH SDK requires supervised streams and a confirmed exit promise');
      }
      sessions.set(id, s);
      s.rpc = createJsonRpcTransport({ readable: s.handle.readable, writable: s.handle.writable, framing: 'dsh-sdk-jsonl',
        onNotification: (method, params) => receive(s, method, params),
        onRequest: (method, params) => approval(s, method, params), onClose: error => disconnected(s, error) });
      Promise.resolve(s.handle.done).then(() => disconnected(s, fault('DSH_SDK_EXITED', 'DSH SDK exited')), error => disconnected(s, error));
      const initialized = await s.rpc.request('initialize', { cwd: s.cwd ?? controlDir, provider: 'deepseek-official',
        model: runtime.model, approvalRequests: true }, { timeoutMs: 15000 });
      if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime' || initialized.serverInfo.version !== '0.0.1') {
        throw fault('DSH_SDK_PROTOCOL_INVALID', 'Unsupported DSH SDK handshake');
      }
      captureBootstrap(s); await validateSession(s);
      if (!healthOnly) {
        const directory = await s.rpc.request('session/working-directory/get', { sessionId: id });
        if (directory?.cwd !== s.cwd) throw fault('TASK_WORKSPACE_MISMATCH', 'DSH SDK did not confirm the exact staging directory');
      }
      if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN', 'DSH SDK Provider is shutting down');
      s.state = 'ready'; verified = { identity: s.identity, version: VERSION,
        policyFingerprint: hash({ runtime: s.identity, policyVersion: DSH_GATE_POLICY_VERSION,
          fileScopePolicy: FILE_SCOPE_POLICY, source: hash(DSH_TOOL_GATE_SOURCE) }) };
      return s;
    } catch (error) {
      if (creation.processAttempted) {
        sessions.set(id, s); error.sessionId = id;
        if (s.handle) { try { await stop(s); } catch { /* Retain exact launch ownership and its stop uncertainty. */ } }
        else if (s.lifecycle) lifecycle.unknown({ sessionId: id });
      }
      throw error;
    }
  }

  const provider = defineAgentProvider({ id: 'dsh', label: 'DSH Agent', eventProtocol: AGENT_EVENT_PROTOCOL_DSH,
    capabilityExtras: { taskTransport: 'sdk', workspaceBoundary: 'native-staged', requiresTask: true, requiresSessionCleanup: true, supportsFreshSession: true, supportsResume: true },
    methods: {
      async health() {
        if (shuttingDown) return { provider: 'dsh', available: false, ready: false, taskEligible: false, reason: 'PROVIDER_SHUTTING_DOWN' };
        try {
          const runtime = await resolveRuntime(), identity = runtimeIdentity(runtime);
          if (healthProof?.session.identity === identity && Date.now() < healthProof.expiresAt) {
            await validateSession(healthProof.session);
            return structuredClone(healthProof.result);
          }
          if (healthPending?.identity === identity) return await healthPending.promise;
          const work = (async () => {
            const s = await start(runtime, {}, true);
            await stop(s); s.closed = true; sessions.delete(s.id); s.buffer.close();
            const result = { provider: 'dsh', available: true, installed: true, ready: true, compatible: true, sessionCapable: true,
              taskEligible: true, authConfigured: true, authVerified: false, authentication: 'configured-unverified',
              version: VERSION, toolsAvailable: true, workspaceBoundary: 'native-staged', reason: null };
            if (!shuttingDown) healthProof = { session: s, expiresAt: Date.now() + 5000, result };
            return result;
          })();
          healthPending = { identity, promise: work }; creations.add(work);
          try { return await work; }
          finally { creations.delete(work); if (healthPending?.promise === work) healthPending = null; }
        } catch (error) { verified = null; healthProof = null; return { provider: 'dsh', available: false, ready: false, taskEligible: false,
          sessionCapable: false, version: null, reason: error?.code ?? 'DSH_SDK_UNAVAILABLE' }; }
      },
      async createSession(invocation = {}) {
        const releaseCreation = lifecycle.beginCreation({ taskId: invocation.taskId });
        const creation = { processAttempted: false };
        try {
        const runtime = await runAgentCreationPreflight(invocation, async () => {
          if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN', 'DSH SDK Provider is shutting down');
          if (!text(invocation.taskId) || !text(invocation.workspaceId) || !path.isAbsolute(invocation.cwd ?? '')
            || !fs.statSync(invocation.cwd).isDirectory()) throw fault('TASK_WORKSPACE_MISMATCH', 'DSH SDK requires an exact Task, Workspace and staging directory');
          creation.staging = stagingSnapshot(invocation.cwd);
          const runtime = await resolveRuntime();
          if (invocation.modelProvider != null && invocation.modelProvider !== 'deepseek-official'
            || invocation.model != null && invocation.model !== runtime.model
            || invocation.reasoningEffort != null) {
            throw fault('AGENT_CONFIGURATION_UNSUPPORTED', 'DSH SDK requires the configured DeepSeek provider and model; reasoning effort selection is unsupported');
          }
          return runtime;
        });
        const work = start(runtime, invocation, false, creation); creations.add(work);
        try { const s = await work;
          if (shuttingDown) { await stop(s); throw fault('PROVIDER_SHUTTING_DOWN', 'DSH SDK Provider is shutting down'); }
          return { provider: 'dsh', sessionId: s.id, taskId: s.taskId, workspaceId: s.workspaceId, cwd: s.cwd };
        } finally { creations.delete(work); }
        } catch (error) {
          if (!creation.processAttempted) throw agentCreationPreflightFailure(invocation, error);
          throw error;
        } finally { releaseCreation(); }
      },
      async send({ sessionId, content, runId, phase = 'user', onRequestId } = {}) {
        const s = requireSession(sessionId);
        if (shuttingDown || s.run || s.state !== 'ready' || s.stopping) throw fault('TURN_BUSY', 'DSH SDK Session is not ready; input is never replayed');
        if (!text(runId) || !['user', 'bootstrap'].includes(phase)) throw fault('INVALID_PARAMS', 'A trusted Core run identity is required');
        const blocks = normalizePromptContent(content);
        if (blocks.some(block => block.type !== 'text' || typeof block.text !== 'string')) throw fault('AGENT_UNSUPPORTED', 'DSH SDK Task input supports text only');
        await validateSession(s);
        if (s.run || s.stopping || s.state !== 'ready') throw fault('TURN_BUSY', 'DSH SDK Session changed before input admission');
        const run = { runId, phase, id: crypto.randomUUID(), cancelled: false, nativeTurn: null };
        run.generation = lifecycle.begin({ sessionId: s.id, runId, turnId: run.id }).generation;
        s.run = run; s.state = 'running';
        s.permissions = phase === 'user' ? createAgentPermissionBridge({ provider: 'dsh', sessionId: s.id, nativeSessionId: s.id,
          taskId: s.taskId, workspaceId: s.workspaceId, runId, phase, trackEffect: true,
          // Only this version-pinned transport classifies its actual recorded
          // native read implementation; the protocol peer cannot set the policy.
          classifyNativeEffect: toolCall => s.calls.get(toolCall.toolCallId)?.name === 'read' ? 'dsh-staging-read-v1' : undefined,
          requestNativeApproval }) : null;
        try {
          const result = await s.rpc.request('session/prompt', { sessionId: s.id, contentBlocks: blocks }, { timeoutMs: 15000 });
          if (!text(result?.messageId)) throw fault('DSH_SDK_PROTOCOL_INVALID', 'DSH SDK prompt has no durable receipt');
          onRequestId?.(result.messageId);
          return { accepted: true, provider: 'dsh', sessionId: s.id, taskId: s.taskId, workspaceId: s.workspaceId,
            requestId: result.messageId, ...(run.nativeTurn != null ? { turnId: run.nativeTurn } : {}) };
        } catch (error) { disconnected(s, error); throw error; }
      },
      async cancel({ sessionId } = {}) { const s = requireSession(sessionId); invalidate(s); return { cancelled: true, ...(await stop(s)) }; },
      async closeSession({ sessionId } = {}) {
        const s = requireSession(sessionId); invalidate(s); const result = await stop(s);
        if (result.effectsUnknown) throw fault('DSH_NATIVE_EFFECT_UNKNOWN', 'Native tool effects require reconciliation; staging retained');
        if (s.lifecycle) lifecycle.close({ sessionId: s.id, staging: 'retained' });
        s.closed = true; s.buffer.close(); sessions.delete(s.id); return { closed: true, ...result };
      },
      async status({ sessionId } = {}) {
        const s = requireSession(sessionId);
        return { provider: 'dsh', sessionId: s.id, taskId: s.taskId, workspaceId: s.workspaceId,
          state: s.state, running: Boolean(s.run && !s.stopped), waitingForApproval: s.waiting > 0,
          cwd: s.cwd, stopped: s.stopped === true, effectsUnknown: s.protocolViolation || s.effectFailure
            || [...s.effects.values()].some(effect => !effect.terminal) };
      },
      async resume({ sessionId } = {}) {
        const s = requireSession(sessionId); if (s.stopped || s.disconnected || s.state === 'unknown') throw fault('DSH_SDK_RESUME_UNSUPPORTED', 'Restore requires a new verified Task recovery, never an automatic prompt replay');
        await validateSession(s); return { resumed: true, provider: 'dsh', sessionId: s.id, running: Boolean(s.run) };
      },
      async contextUsage({ sessionId } = {}) { requireSession(sessionId); return { provider: 'dsh', sessionId, available: false }; },
      async *follow({ sessionId, signal, sinceSequence = 0 } = {}) { yield* requireSession(sessionId).buffer.follow({ signal, sinceSequence }); }
    } });
  return Object.freeze({ ...provider,
    capabilities() { return { ...provider.capabilities(), security: { mode: 'native-permissions', verified: Boolean(verified),
      nativeSandboxSupported: false, strictIsolationVerified: false, nativeApprovalSupported: true,
      nativePermissionPolicyVerified: Boolean(verified), allToolsRequireApproval: true, nativeSandboxMode: 'none',
      nativeApprovalPolicy: 'host-approval-every-tool', policyVersion: DSH_GATE_POLICY_VERSION,
      fileScopePolicy: FILE_SCOPE_POLICY,
      securityLimitations: [FILE_SCOPE_POLICY, 'Only read, write and edit paths inside the current Task staging root are accepted; no OS sandbox.'],
      identity: verified?.policyFingerprint ?? null, policyFingerprint: verified?.policyFingerprint ?? null } }; },
    async verifyTaskQuiescence({ taskId, workspaceId, allowEmpty = false } = {}) {
      if (!text(taskId) || !text(workspaceId) || lifecycle.hasPendingCreation(taskId)) return { stopped: false };
      const rows = lifecycle.forTask(taskId);
      return { stopped: (allowEmpty || rows.length > 0) && rows.every(row => row.workspaceId === workspaceId
        && row.transport === 'dsh-sdk' && row.receipt && ['stopped', 'closed'].includes(row.state)
        && (!sessions.has(row.sessionId) || sessions.get(row.sessionId).stopped === true)) };
    },
    async verifyStoppedTask({ taskId, workspaceId, sessionId } = {}) {
      if (!text(taskId) || !text(workspaceId) || !text(sessionId) || lifecycle.hasPendingCreation(taskId)) return { stopped: false };
      const row = lifecycle.read(sessionId);
      if (!row || row.taskId !== taskId || row.workspaceId !== workspaceId || row.transport !== 'dsh-sdk'
        || !row.receipt || !['stopped', 'closed'].includes(row.state)
        || sessions.has(sessionId) && !sessions.get(sessionId).stopped) return { stopped: false };
      if (!(await this.verifyTaskQuiescence({ taskId, workspaceId })).stopped) return { stopped: false };
      const latest = lifecycle.read(sessionId);
      if (latest?.receipt?.id !== row.receipt.id || lifecycle.hasPendingCreation(taskId)
        || lifecycle.forTask(taskId).some(item => item.workspaceId !== workspaceId || !item.receipt
          || !['stopped', 'closed'].includes(item.state) || sessions.has(item.sessionId) && !sessions.get(item.sessionId).stopped)) return { stopped: false };
      return { stopped: true, provider: 'dsh', taskId, workspaceId, sessionId, receiptId: row.receipt.id,
        generation: row.generation, runId: row.runId, snapshotId: row.snapshotId, attemptId: row.attemptId,
        transport: row.transport, evidence: row.receipt.evidence };
    },
    async shutdown() {
      shuttingDown = true; verified = null; healthProof = null; for (const s of sessions.values()) invalidate(s);
      await Promise.allSettled([...creations]);
      const results = await Promise.allSettled([...sessions.values()].map(s => provider.closeSession({ sessionId: s.id })));
      if (results.some(result => result.status === 'rejected')) throw fault('PROVIDER_CLOSE_UNKNOWN', 'DSH SDK shutdown retains unknown execution evidence');
    }
  });
}
