import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const gateFile = new URL('../src/agent/dsh-sdk-tool-gate.js', import.meta.url);
const profileFile = new URL('../src/agent/dsh-sdk-profile.js', import.meta.url);
assert.equal(await fs.access(gateFile).then(() => true, () => false), true,
  'the owned DSH gate must exist before controlled tools can receive authority');
const { DSH_TOOL_GATE_SOURCE, DSH_GATE_POLICY_VERSION } = await import(gateFile);
const { createDshSdkProfile } = await import(profileFile);

// This imports the exact emitted Host plugin and exercises its policy with a
// protocol fixture. It does not start an official DSH runtime or a real model.
const fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cetamesh-dsh-sdk-gate-')));
let passed = 0;
const config = {
  sessionId: 'sdk-controlled-session', nonce: 'owned-test-process-nonce-12345678',
  policyFingerprint: 'a'.repeat(64),
};
const pluginPath = path.join(fixtureRoot, 'gate-fixture.mjs');
await fs.writeFile(pluginPath, DSH_TOOL_GATE_SOURCE, { flag: 'wx' });
const plugin = await import(pathToFileURL(pluginPath));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function gateFixture({ outcome = 'allowed-once', flushResult = true, approve, flush, pluginModule = plugin } = {}) {
  const listeners = new Map();
  const guards = [];
  const services = new Map();
  const cleanups = [];
  const live = new Map();
  const approvals = [];
  const flushes = [];
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => { const i = list.indexOf(handler); if (i !== -1) list.splice(i, 1); };
    },
    tools: {
      guard(handler) {
        guards.push(handler);
        return () => { const i = guards.indexOf(handler); if (i !== -1) guards.splice(i, 1); };
      },
    },
    agents: { get: id => live.get(id) },
    sessions: {
      async flush(session) {
        flushes.push(session);
        return flush ? flush(session) : flushResult;
      },
    },
    approval: {
      async request(request) {
        approvals.push(request);
        const terminal = async () => approve ? approve(request) : outcome;
        const handlers = listeners.get('approval/request') ?? [];
        const visit = index => index < handlers.length
          ? handlers[index](request, () => visit(index + 1)) : terminal();
        return visit(0);
      },
    },
    provide(name, value) {
      if (services.has(name)) throw new Error('duplicate fixture service');
      services.set(name, value);
      return () => services.delete(name);
    },
    effect(callback) {
      const result = callback();
      const nested = [];
      if (result && typeof result.next === 'function') {
        for (const cleanup of result) if (typeof cleanup === 'function') nested.push(cleanup);
      } else if (typeof result === 'function') nested.push(result);
      const dispose = async () => {
        for (const cleanup of nested.reverse()) await cleanup();
      };
      cleanups.push(dispose);
      return dispose;
    },
  };
  pluginModule.apply(ctx, config);
  const agent = { id: config.sessionId, session: { id: config.sessionId, header: { cwd: fixtureRoot } } };
  live.set(agent.id, agent);
  const emit = async (event, value) => {
    for (const handler of [...(listeners.get(event) ?? [])]) await handler(value);
  };
  const bind = () => emit('agent/created', { agent, source: 'startup' });
  let effects = 0;
  const prepare = async exec => {
    const handlers = listeners.get('tools/pre-execute') ?? [];
    const visit = index => index < handlers.length
      ? handlers[index](exec, () => visit(index + 1)) : { kind: 'allow' };
    return visit(0);
  };
  const guard = exec => guards.map(handler => handler(exec)).find(reason => reason !== undefined);
  const dispatch = async exec => {
    const handlers = listeners.get('tools/execute') ?? [];
    const visit = index => index < handlers.length ? handlers[index](exec, () => visit(index + 1))
      : (effects += 1, { isError: false, value: 'observed fixture effect', content: [] });
    return visit(0);
  };
  const attempt = async (exec, { skipPreExecute = false, changeAfterApproval } = {}) => {
    const decision = skipPreExecute ? { kind: 'allow' } : await prepare(exec);
    changeAfterApproval?.(exec);
    if (decision.kind !== 'allow') return { dispatched: false, decision };
    const denied = guard(exec);
    if (denied !== undefined) return { dispatched: false, denied };
    const result = await dispatch(exec);
    await emit('tools/result', exec);
    return { dispatched: true, result };
  };
  return {
    ctx, agent, approvals, flushes, services, live, emit, bind, prepare, guard, dispatch, attempt,
    effects: () => effects,
    dispose: async () => { for (const cleanup of cleanups.reverse()) await cleanup(); },
  };
}

let callCounter = 0;
function execution(agent, overrides = {}) {
  const callId = `native-call-${++callCounter}`;
  return { agent, token: Symbol('official-execution-fixture'), callId, rootCallId: callId,
    name: 'read', arguments: { path: 'input.txt' }, signal: new AbortController().signal, ...overrides };
}
async function check(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

try {
  await check('mandatory global guard denies a listener that bypasses the async gate', async () => {
    const f = gateFixture(); await f.bind();
    const result = await f.attempt(execution(f.agent), { skipPreExecute: true });
    assert.equal(result.dispatched, false);
    assert.equal(f.effects(), 0);
    assert.equal(f.approvals.length, 0);
    await f.dispose();
  });

  await check('exact read executes once after official one-shot approval', async () => {
    const f = gateFixture(); await f.bind();
    const exec = execution(f.agent);
    const result = await f.attempt(exec);
    assert.equal(result.dispatched, true);
    assert.equal(f.effects(), 1);
    assert.equal(f.approvals.length, 1);
    const reason = JSON.parse(f.approvals[0].reason);
    assert.deepEqual(reason, { format: 'cetamesh-dsh-tool-v1', processNonce: config.nonce,
      policyFingerprint: config.policyFingerprint, sessionId: config.sessionId,
      callId: exec.callId, toolName: 'read', input: { path: 'input.txt' } });
    assert.ok(f.flushes.length >= 2, 'native and approval audit prefixes must flush before dispatch');
    assert.equal((await f.attempt(exec)).dispatched, false);
    assert.equal(f.effects(), 1);
    await f.dispose();
  });

  await check('rejection and unavailable approval cannot create a permit', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      const f = gateFixture({ outcome }); await f.bind();
      assert.equal((await f.attempt(execution(f.agent))).dispatched, false);
      assert.equal(f.effects(), 0);
      await f.dispose();
    }
  });

  await check('every new native call requires a fresh permit despite matching arguments', async () => {
    const f = gateFixture(); await f.bind();
    assert.equal((await f.attempt(execution(f.agent))).dispatched, true);
    assert.equal((await f.attempt(execution(f.agent))).dispatched, true);
    assert.equal(f.approvals.length, 2);
    assert.equal(f.effects(), 2);
    await f.dispose();
  });

  await check('changed arguments and cross-session calls fail before the body', async () => {
    const f = gateFixture(); await f.bind();
    const changed = await f.attempt(execution(f.agent), {
      changeAfterApproval: exec => { exec.arguments = { path: 'unapproved.txt' }; },
    });
    assert.equal(changed.dispatched, false);
    const other = { id: 'other-session', session: { id: 'other-session', header: { cwd: fixtureRoot } } };
    f.live.set(other.id, other);
    assert.equal((await f.attempt(execution(other))).dispatched, false);
    const stale = { ...f.agent };
    assert.equal((await f.attempt(execution(stale))).dispatched, false);
    assert.equal(f.effects(), 0);
    await f.dispose();
  });

  await check('unsupported shells, PTC, subagent and MCP calls remain unavailable', async () => {
    const f = gateFixture(); await f.bind();
    for (const name of ['pwsh', 'bash', 'run_code', 'subagent', 'mcp__files__read', 'working_directory', 'apply_patch']) {
      assert.equal((await f.attempt(execution(f.agent, { name }))).dispatched, false, name);
    }
    assert.equal((await f.attempt(execution(f.agent, { parent: Symbol('parent') }))).dispatched, false);
    assert.equal(f.approvals.length, 0);
    assert.equal(f.effects(), 0);
    await f.dispose();
  });

  await check('duplicate in-flight call id invalidates ambiguous unstarted executions', async () => {
    const answer = deferred(); const started = deferred();
    const f = gateFixture({ approve: async () => { started.resolve(); return answer.promise; } }); await f.bind();
    const exec = execution(f.agent);
    const pending = f.attempt(exec);
    await started.promise;
    assert.equal((await f.attempt(execution(f.agent, { callId: exec.callId, rootCallId: exec.callId }))).dispatched, false);
    answer.resolve('allowed-once');
    assert.equal((await pending).dispatched, false);
    assert.equal(f.approvals.length, 1);
    assert.equal(f.effects(), 0);
    await f.dispose();
  });

  await check('abort and disposal invalidate a late Owner grant', async () => {
    for (const kind of ['abort', 'dispose']) {
      const answer = deferred(); const started = deferred();
      const f = gateFixture({ approve: async () => { started.resolve(); return answer.promise; } }); await f.bind();
      const abort = new AbortController();
      const pending = f.attempt(execution(f.agent, { signal: abort.signal }));
      await started.promise;
      if (kind === 'abort') abort.abort();
      else await f.emit('agent/disposed', { agent: f.agent });
      answer.resolve('allowed-once');
      assert.equal((await pending).dispatched, false);
      assert.equal(f.effects(), 0);
      await f.dispose();
    }
  });

  await check('missing durability, oversized input and malformed JSON fail closed', async () => {
    const f = gateFixture({ flushResult: false }); await f.bind();
    assert.equal((await f.attempt(execution(f.agent))).dispatched, false);
    assert.equal(f.approvals.length, 0);
    assert.equal(f.effects(), 0);
    await f.dispose();
    const g = gateFixture(); await g.bind();
    for (const input of [{ path: 'x'.repeat(70 * 1024) }, { n: NaN }, { path: undefined }, { n: -0 }]) {
      assert.equal((await g.attempt(execution(g.agent, { arguments: input }))).dispatched, false);
    }
    assert.equal(g.approvals.length, 0);
    assert.equal(g.effects(), 0);
    await g.dispose();
  });

  await check('dispatch wrapper rechecks authority and permits cannot be reused', async () => {
    const f = gateFixture(); await f.bind();
    const exec = execution(f.agent);
    assert.equal((await f.prepare(exec)).kind, 'allow');
    assert.equal(f.guard(exec), undefined);
    assert.equal(typeof f.guard(exec), 'string');
    exec.arguments = { path: 'changed-after-guard.txt' };
    await assert.rejects(f.dispatch(exec), /gate|permit|input/i);
    assert.equal(f.effects(), 0);
    await f.dispose();
  });

  await check('readiness is published only with gate dependencies and removed on teardown', async () => {
    const f = gateFixture();
    const ready = f.services.get('cetameshDshTaskGateReady');
    assert.equal(ready.policyVersion, DSH_GATE_POLICY_VERSION);
    assert.equal(ready.policyFingerprint, config.policyFingerprint);
    assert.equal(ready.sessionId, config.sessionId);
    await f.dispose();
    assert.equal(f.services.has('cetameshDshTaskGateReady'), false);
    assert.throws(() => plugin.apply({ on() {}, tools: {} }, config), /gate|depend|guard/i);
  });

  await check('Core bundling cannot insert missing helpers into the emitted Host plugin', async () => {
    for (const keepNames of [false, true]) {
      const bundlePath = path.join(fixtureRoot, `core-gate-${keepNames}.cjs`);
      await build({ entryPoints: [fileURLToPath(gateFile)], outfile: bundlePath, bundle: true,
        platform: 'node', format: 'cjs', target: `node${process.versions.node.split('.')[0]}`,
        minify: false, sourcemap: false, legalComments: 'eof', keepNames, logLevel: 'silent' });
      const bundle = await import(pathToFileURL(bundlePath));
      const source = bundle.DSH_TOOL_GATE_SOURCE ?? bundle.default.DSH_TOOL_GATE_SOURCE;
      const bundledPluginPath = path.join(fixtureRoot, `bundled-plugin-${keepNames}.mjs`);
      await fs.writeFile(bundledPluginPath, source, { flag: 'wx' });
      const bundledPlugin = await import(pathToFileURL(bundledPluginPath));
      const f = gateFixture({ pluginModule: bundledPlugin }); await f.bind();
      assert.equal((await f.attempt(execution(f.agent))).dispatched, true);
      assert.equal(f.effects(), 1);
      await f.dispose();
    }
  });

  await check('plaintext endpoints require explicit loopback test scope', async () => {
    const defaults = { sessionId: config.sessionId, nonce: config.nonce,
      modelProvider: 'deepseek-official', model: 'synthetic-model' };
    await assert.rejects(createDshSdkProfile({ ...defaults, directory: path.join(fixtureRoot, 'plaintext-default'),
      baseUrl: 'http://127.0.0.1:9876/anthropic' }), /HTTP|HTTPS|endpoint|loopback/i);
    await assert.rejects(createDshSdkProfile({ ...defaults, directory: path.join(fixtureRoot, 'plaintext-remote'),
      baseUrl: 'http://example.com/anthropic', allowLoopbackHttpForTests: true }), /HTTP|HTTPS|endpoint|loopback/i);
  });

  await check('profile creates a fresh secret-free native file-only composition', async () => {
    const directory = path.join(fixtureRoot, 'owned-profile');
    const profile = await createDshSdkProfile({ directory, sessionId: config.sessionId, nonce: config.nonce,
      modelProvider: 'deepseek-official', model: 'synthetic-model', baseUrl: 'http://127.0.0.1:9876/anthropic',
      allowLoopbackHttpForTests: true });
    assert.equal(profile.profile, 'sdk-minimal');
    assert.equal(profile.homeDir, path.join(directory, 'home'));
    assert.match(profile.policyFingerprint, /^[a-f0-9]{64}$/);
    const patches = JSON.parse(await fs.readFile(profile.patchPath, 'utf8'));
    const byId = id => patches.find(row => row.id === id);
    const gate = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'cetamesh-task-gate');
    const emittedPath = path.resolve(path.dirname(profile.patchPath), gate.name);
    assert.equal(await fs.readFile(emittedPath, 'utf8'), DSH_TOOL_GATE_SOURCE);
    assert.deepEqual(gate.config, { sessionId: config.sessionId, nonce: config.nonce,
      policyFingerprint: profile.policyFingerprint });
    assert.deepEqual(byId('sdk-jsonrpc-server').inject, ['sdkAppStartup', 'loader', 'cetameshDshTaskGateReady']);
    for (const id of ['persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'mcp-resources', 'tool-working-directory']) {
      assert.equal(byId(id).disabled, true, id);
    }
    assert.deepEqual(byId('tool-fs').config, { read: true, readImage: false, write: true, edit: true, applyPatch: false });
    assert.equal(byId('llm-deepseek').config.apiKeyEnv, 'CETAMESH_DSH_TASK_API_KEY');
    assert.equal(byId('llm-deepseek').config.baseURL, 'http://127.0.0.1:9876/anthropic');
    assert.deepEqual(byId('llm-deepseek').config.models, [{ id: 'synthetic-model', inputModalities: ['text'] }]);
    await assert.rejects(createDshSdkProfile({ directory, sessionId: config.sessionId, nonce: config.nonce,
      modelProvider: 'deepseek-official', model: 'synthetic-model', baseUrl: 'http://127.0.0.1:9876/anthropic',
      allowLoopbackHttpForTests: true }), /exist|fresh/i);
  });

  await check('invalid profile input cannot create or modify an existing home', async () => {
    const defaults = { directory: path.join(fixtureRoot, 'invalid-input'), sessionId: config.sessionId,
      nonce: config.nonce, modelProvider: 'deepseek-official', model: 'synthetic-model', baseUrl: 'http://127.0.0.1:9876' };
    for (const override of [{ directory: 'relative-home' }, { nonce: '' }, { sessionId: '' },
      { modelProvider: 'not-installed-provider' }, { baseUrl: 'http://user:pass@127.0.0.1:9876' },
      { apiKeyEnvName: 'X\nmalicious' }]) {
      await assert.rejects(createDshSdkProfile({ ...defaults, ...override }));
    }
    assert.equal(await fs.access(defaults.directory).then(() => true, () => false), false);
  });

  await check('profile verification rejects changed artifacts and a replaced home identity', async () => {
    const directory = path.join(fixtureRoot, 'profile-attestation');
    const profile = await createDshSdkProfile({ directory, sessionId: config.sessionId, nonce: config.nonce,
      modelProvider: 'deepseek-official', model: 'synthetic-model', baseUrl: 'https://example.com/anthropic' });
    assert.equal(await profile.verify(), true);
    const before = await fs.readFile(profile.gatePath);
    await fs.appendFile(profile.gatePath, '\n// unexpected change\n');
    await assert.rejects(profile.verify(), error => error.code === 'DSH_SDK_PROFILE_CHANGED');
    await fs.writeFile(profile.gatePath, before);
    assert.equal(await profile.verify(), true);
    const retained = path.join(directory, 'retained-owned-home');
    assert.ok(path.resolve(profile.homeDir).startsWith(fixtureRoot + path.sep));
    assert.ok(path.resolve(retained).startsWith(fixtureRoot + path.sep));
    await fs.rename(profile.homeDir, retained);
    await fs.mkdir(profile.homeDir);
    await assert.rejects(profile.verify(), error => error.code === 'DSH_SDK_PROFILE_CHANGED');
  });
  console.log(`DSH SDK gate protocol fixture: ${passed} PASS; real DSH runtime/model NOT_RUN.`);
} finally {
  // Only the canonical, test-owned temporary directory is removed.
  const resolved = await fs.realpath(fixtureRoot);
  assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir()) + path.sep));
  await fs.rm(resolved, { recursive: true, force: true });
}
