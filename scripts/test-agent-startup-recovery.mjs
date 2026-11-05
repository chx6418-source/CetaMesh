import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskService } from '../src/task/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

// Real Core services and ACP adapter; the in-process protocol peer is controlled.
// No external runtime/model or native Desktop acceptance is claimed.
const parent = fs.realpathSync.native(os.tmpdir());
const base = fs.mkdtempSync(path.join(parent, 'cetamesh-startup-recovery-'));
const cases = [], test = (name, run) => cases.push([name, run]);
const fault = code => Object.assign(new Error(code), { code });
async function fixture(name) {
  const root = path.join(base, name), project = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'input.txt'), 'retained input');
  const workspaces = createWorkspaceService({ stateDir });
  const workspace = (await workspaces.execute({ method: 'workspace.create', params: { root: project, name } })).workspace;
  let tasks = createTaskService({ stateDir });
  const task = tasks.runtime.create({ goal: 'Read isolated input', workspaceId: workspace.id });
  tasks.runtime.setCheckpoint({ id: task.id, expectedRev: task.rev, summary: 'Retain original checkpoint', nextAction: 'Read input' });
  const state = { launches: 0, prompts: 0, validations: 0, validationError: null, failValidationAt: null, launchError: null };
  const descriptor = { id: 'fixture-acp', label: 'Controlled ACP', protocolVersion: 1, verifiedRuntime: true,
    security: { mode: 'native', verified: true, nativeSandboxSupported: true, nativeApprovalSupported: true } };
  const providerOptions = { descriptor, stagingRoot: path.join(root, 'stages'),
    resolveTaskWorkspace: async ({ taskId }) => ({ task: tasks.runtime.get({ id: taskId }).task, workspace }),
    validateRuntime: async () => { state.validations++; if (state.validationError
      && (!state.failValidationAt || state.validations === state.failValidationAt)) throw state.validationError; },
    launch: async () => {
      state.launches++; if (state.launchError) throw state.launchError;
      const readable = new PassThrough(), writable = new PassThrough();
      let done; const stopped = new Promise(resolve => { done = resolve; });
      const reply = (id, result) => readable.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      writable.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) {
        const frame = JSON.parse(line);
        if (frame.method === 'initialize') reply(frame.id, { protocolVersion: 1 });
        if (frame.method === 'session/new') reply(frame.id, { sessionId: 'controlled-session' });
        if (frame.method === 'session/prompt') { state.prompts++; reply(frame.id, { stopReason: 'end_turn' }); }
      } });
      return { readable, writable, done: stopped, close: async () => done({ processTreeExitConfirmed: true }) };
    } };
  let acp, provider, agents;
  function startAgents() {
    acp = createAcpAgentProvider(providerOptions);
    provider = { ...acp, health: async () => ({ available: true, authenticated: true, sessionCapable: true }) };
    agents = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [provider] }), resolveWorkspaceIdentity: () => workspace.root });
    const security = agents.describeExecutionSecurity(provider.id, workspace.id);
    agents.authorizeExecution(provider.id, workspace.id, security.fingerprint);
  }
  startAgents();
  const build = () => createCapabilityService({ stateDir, workspaceService: workspaces, taskRuntime: tasks.runtime, agentBroker: agents });
  let capabilities = build();
  capabilities.grantTask(task.id, { capabilities: ['filesystem.read'], workspaceIds: [workspace.id] });
  const read = () => tasks.runtime.get({ id: task.id }).task;
  const run = requestId => capabilities.broker.execute({ capability: 'agent.run', requestId, taskId: task.id,
    workspaceId: workspace.id, actor: OWNER_ACTOR, approved: true, input: { provider: provider.id, content: 'Read isolated input' } });
  return { state, stateDir, project, task, workspace, get agents() { return agents; }, get provider() { return provider; }, read, run,
    fences: () => capabilities.taskReviewState({ taskId: task.id, workspaceId: workspace.id }).workspaceFences,
    async restart() { await capabilities.close(); await acp.shutdown(); tasks = createTaskService({ stateDir }); startAgents(); capabilities = build(); },
    async close() { await capabilities.close(); await acp.shutdown(); } };
}

test('F0 ACP session creation, dispatch and completion retain Workspace and checkpoint', async () => {
  const f = await fixture('happy');
  try {
    const before = f.read(); const result = await f.run('happy-run');
    assert.equal(result.result.accepted, true);
    const deadline = Date.now() + 5000;
    while ((await f.agents.status({ provider: f.provider.id, sessionId: result.result.sessionId })).state !== 'ready') {
      assert.ok(Date.now() < deadline, 'controlled turn must finish'); await delay(5);
    }
    assert.equal(f.state.launches, 1); assert.equal(f.state.prompts, 1);
    assert.deepEqual(f.fences(), []); assert.deepEqual(f.read().checkpoint, before.checkpoint);
    assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'retained input');
  } finally { await f.close(); }
});

test('F1 exact ACP pre-start rejection releases only this creation and permits explicit same-Task retry', async () => {
  const f = await fixture('pre-start');
  try {
    const before = f.read(); f.state.validationError = fault('AGENT_RUNTIME_CHANGED');
    await assert.rejects(f.run('pre-start-rejected'), { code: 'AGENT_RUNTIME_CHANGED' });
    assert.equal(f.state.launches, 0); assert.equal(f.state.prompts, 0);
    assert.deepEqual(f.fences(), [], 'a proven pre-effect creation must not retain a Workspace fence');
    assert.deepEqual(f.read(), before, 'no execution means no invented Attempt, checkpoint or Task transition');
    f.state.validationError = null;
    const result = await f.run('owner-explicit-retry');
    assert.equal(result.result.accepted, true); assert.equal(result.result.taskId, f.task.id);
    assert.equal(f.state.launches, 1); assert.equal(f.state.prompts, 1);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
  } finally { await f.close(); }
});

test('F2 second pre-launch validation also requires successful staging cleanup', async () => {
  const f = await fixture('second-validation');
  try {
    const before = f.read(); f.state.validationError = fault('AGENT_RUNTIME_CHANGED'); f.state.failValidationAt = 2;
    await assert.rejects(f.run('second-validation'), { code: 'AGENT_RUNTIME_CHANGED' });
    assert.equal(f.state.launches, 0); assert.deepEqual(f.fences(), []); assert.deepEqual(f.read(), before);
    assert.deepEqual(fs.readdirSync(path.join(path.dirname(f.project), 'stages')), []);
  } finally { await f.close(); }
});

test('F2 proof is bound to invocation and cannot be copied, changed in scope or reused after launch', async () => {
  const f = await fixture('proof-scope');
  try {
    const params = { taskId: f.task.id, workspaceId: f.workspace.id, requestId: 'exact-creation' };
    const scope = { ...params, provider: f.provider.id };
    const original = fault('AGENT_RUNTIME_CHANGED'); f.state.validationError = original;
    let proof;
    await assert.rejects(f.agents.createSession(f.provider.id, params), error => { proof = error; return error.code === original.code; });
    assert.notEqual(proof, original); assert.equal(f.agents.isSessionCreationPreflightFailure(proof, scope), true);
    for (const key of ['taskId', 'workspaceId', 'provider', 'requestId']) {
      assert.equal(f.agents.isSessionCreationPreflightFailure(proof, { ...scope, [key]: 'other' }), false, key);
    }
    assert.equal(f.agents.isSessionCreationPreflightFailure({ ...proof, stopped: true, effectStatus: 'none' }, scope), false);
    assert.equal(f.agents.isSessionCreationPreflightFailure(original, scope), false);
    f.state.validationError = null; f.state.launchError = proof;
    await assert.rejects(f.agents.createSession(f.provider.id, params), { code: original.code });
    assert.equal(f.state.launches, 1);
    assert.equal(f.agents.isSessionCreationPreflightFailure(proof, scope), false, 'a later launch cannot reuse old proof even with identical scope fields');
  } finally { await f.close(); }
});

test('F2 the same error code after launch retains ownership and rejects redispatch', async () => {
  const f = await fixture('after-launch');
  try {
    f.state.launchError = Object.assign(fault('AGENT_RUNTIME_CHANGED'), { stopped: true, effectStatus: 'none' });
    await assert.rejects(f.run('launched-unknown'), { code: 'AGENT_RUNTIME_CHANGED' });
    assert.equal(f.state.launches, 1); assert.equal(f.fences().length, 1); assert.equal(f.read().status, 'blocked');
    f.state.launchError = null;
    await assert.rejects(f.run('unsafe-retry'), { code: 'TASK_RECOVERY_REVIEW_REQUIRED' });
    assert.equal(f.state.launches, 1); assert.equal(f.state.prompts, 0);
  } finally { await f.close(); }
});

test('F3 durable preflight failure remains retryable after reconstruction but never replays its request', async () => {
  const f = await fixture('restart');
  try {
    const before = f.read(); f.state.validationError = fault('AGENT_RUNTIME_CHANGED');
    await assert.rejects(f.run('original-request'), { code: 'AGENT_RUNTIME_CHANGED' });
    const taskBytes = fs.readFileSync(path.join(f.stateDir, 'tasks', 'tasks.json'));
    await f.restart(); f.state.validationError = null;
    // Loading legacy-compatible optional fields adds defaults to the projection,
    // without changing persisted Task data or any established evidence.
    for (const key of Object.keys(before)) assert.deepEqual(f.read()[key], before[key], key);
    assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'tasks', 'tasks.json')), taskBytes);
    assert.deepEqual(f.fences(), []);
    await assert.rejects(f.run('original-request'), { code: 'REQUEST_RECOVERY_REQUIRED' });
    assert.equal(f.state.launches, 0);
    const result = await f.run('new-owner-command');
    assert.equal(result.result.taskId, f.task.id); assert.equal(f.state.prompts, 1);
  } finally { await f.close(); }
});

test('F3 failed fence-release persistence retains ownership across reconstruction', async () => {
  const f = await fixture('release-write-failure');
  const rename = fs.renameSync; let writes = 0;
  try {
    f.state.validationError = fault('AGENT_RUNTIME_CHANGED');
    fs.renameSync = (from, to) => {
      if (path.resolve(String(to)) === path.join(f.stateDir, 'capability', 'requests.json') && ++writes === 3) throw fault('EIO');
      return rename(from, to);
    };
    try { await assert.rejects(f.run('failed-release'), { code: 'AGENT_RUNTIME_CHANGED' }); }
    finally { fs.renameSync = rename; }
    assert.ok(writes >= 3); assert.equal(f.fences().length, 1); assert.equal(f.read().status, 'blocked');
    await f.restart();
    assert.equal(f.fences().length, 1); assert.equal(f.read().status, 'blocked');
    await assert.rejects(f.run('must-not-guess'), { code: 'TASK_RECOVERY_REVIEW_REQUIRED' });
    assert.equal(f.state.launches, 0);
  } finally { fs.renameSync = rename; await f.close(); }
});

try {
  for (const [name, run] of cases) { const start = performance.now(); await run(); console.log('PASS', name, Math.round(performance.now() - start) + 'ms'); }
} finally {
  assert.equal(path.dirname(path.resolve(base)), parent); assert.ok(path.basename(base).startsWith('cetamesh-startup-recovery-'));
  fs.rmSync(base, { recursive: true, force: true });
}
