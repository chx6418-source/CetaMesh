import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCapabilityService } from '../src/capability/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { writeFile, applyWorkspaceChanges } from '../src/workspace/tools.js';
import { createTaskStore } from '../src/task/store.js';
import { createMemoryStore } from '../src/memory/store.js';
import { createMemoryRuntime } from '../src/memory/runtime.js';
import { createSettingsStore } from '../src/settings/store.js';
import { createMeshService } from '../src/mesh/service.js';
import { bootstrapCetaMesh } from '../src/app/bootstrap.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { workspaceJournalDir } from '../src/workspace/transaction.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-phase1-'));
const stateDir = path.join(root, 'state');
const workspaceRootInput = path.join(root, 'workspace');
fs.mkdirSync(workspaceRootInput);
const workspaceService = createWorkspaceService({ stateDir });
const ws = (await workspaceService.execute({ method: 'workspace.create', params: { name: 'phase1', root: workspaceRootInput } })).workspace;
// Direct tool fixtures must use the same canonical root that production Registry supplies.
// Windows temp paths may contain a junction/8.3 alias, which resolveInside rejects by design.
const workspaceRoot = ws.root;
const taskRuntime = createTaskRuntime({ stateDir });
const svc = createCapabilityService({ stateDir, workspaceService, taskRuntime });
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const owner = { kind: 'owner', id: 'desktop' };

try {
  const task = taskRuntime.create({ goal: 'safely edit', workspaceId: ws.id });
  svc.grantTask(task.id, { capabilities: ['filesystem.write'], workspaceIds: [ws.id] });
  const actor = svc.principalForTask(task.id);
  const target = path.join(workspaceRoot, 'note.txt');
  fs.writeFileSync(target, 'original');
  const request = { actor, taskId: task.id, workspaceId: ws.id, capability: 'filesystem.write',
    input: { path: 'note.txt', content: 'changed', expectedHash: hash('original') } };
  const pending = await svc.broker.execute(request);
  assert.equal(pending.status, 'pending', 'SEC-01: an Agent cannot write an existing file without Owner approval');
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  const approved = await svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  assert.equal(approved.status, 'completed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed');
  await assert.rejects(svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } }),
    error => error.code === 'APPROVAL_ALREADY_DECIDED');

  const second = await svc.broker.execute({ ...request, input: { path: 'note.txt', content: 'late', expectedHash: hash('changed') } });
  assert.equal(second.status, 'pending');
  const current = taskRuntime.get({ id: task.id }).task;
  taskRuntime.cancel({ id: task.id, expectedRev: current.rev });
  await assert.rejects(svc.execute({ method: 'capability.approval.decide', params: { id: second.approvalId, approve: true } }),
    error => error.code === 'TASK_NOT_AUTHORIZED' || error.code === 'APPROVAL_EXPIRED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed', 'SEC-02: cancelled Task cannot mutate Workspace');

  const handoffTask = taskRuntime.create({ goal: 'handoff', workspaceId: ws.id });
  svc.grantTask(handoffTask.id, { capabilities: ['filesystem.write'], workspaceIds: [ws.id] });
  taskRuntime.attachAgent({ id: handoffTask.id, expectedRev: handoffTask.rev, provider: 'codex', sessionId: 'old-session' });
  const staleImport = await svc.applyAgentWorkspaceChanges({ taskId: handoffTask.id, workspaceId: ws.id,
    provider: 'codex', sessionId: 'old-session', requestId: 'stale-import', changes: [
      { action: 'write', path: 'note.txt', content: 'stale-agent', expectedHash: hash('changed'), hash: hash('stale-agent') }
    ] });
  assert.equal(staleImport.status, 'pending');
  taskRuntime.attachAgent({ id: handoffTask.id, expectedRev: taskRuntime.get({ id: handoffTask.id }).task.rev,
    provider: 'dsh', sessionId: 'new-session' });
  await assert.rejects(svc.execute({ method: 'capability.approval.decide', params: { id: staleImport.approvalId, approve: true } }),
    error => error.code === 'APPROVAL_EXPIRED' || error.code === 'AGENT_ASSIGNMENT_EXPIRED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed', 'HND-06: previous Agent import cannot land after switch');

  writeFile(workspaceRoot, 'note.txt', '\nappended', { append: true, expectedHash: hash('changed') });
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed\nappended', 'WORKSPACE-02: append keeps preimage');
  assert.throws(() => writeFile(workspaceRoot, 'note.txt', 'wrong', { expectedHash: hash('stale') }),
    error => error.code === 'WORKSPACE_CONFLICT');
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed\nappended');

  fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'A');
  fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'B');
  assert.throws(() => applyWorkspaceChanges(workspaceRoot, [
    { action: 'write', path: 'a.txt', content: 'A2', expectedHash: hash('A') },
    { action: 'write', path: 'b.txt', content: 'B2', expectedHash: hash('stale') }
  ]), error => error.code === 'WORKSPACE_CONFLICT');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'A', 'WORKSPACE-01: failed batch keeps first file');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'b.txt'), 'utf8'), 'B');

  assert.throws(() => applyWorkspaceChanges(workspaceRoot, [
    { action: 'write', path: 'a.txt', content: 'A2', expectedHash: hash('A') },
    { action: 'write', path: 'b.txt', content: 'B2', expectedHash: hash('B') }
  ], { beforeCommit(index) { if (index === 1) throw new Error('injected second-file failure'); } }), /injected second-file failure/);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'A', 'WORKSPACE-01: second-file failure compensates first');

  fs.writeFileSync(path.join(workspaceRoot, 'c.txt'), 'C');
  assert.throws(() => applyWorkspaceChanges(workspaceRoot, [
    { action: 'write', path: 'a.txt', content: 'A3', expectedHash: hash('A') },
    { action: 'write', path: 'b.txt', content: 'B3', expectedHash: hash('B') },
    { action: 'delete', path: 'c.txt', expectedHash: hash('C') }
  ], { beforeCommit(index) { if (index === 2) throw new Error('injected delete failure'); } }), /injected delete failure/);
  assert.deepEqual(['a.txt', 'b.txt', 'c.txt'].map(name => fs.readFileSync(path.join(workspaceRoot, name), 'utf8')),
    ['A', 'B', 'C'], 'WORKSPACE-01: third-file delete failure compensates earlier writes');

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspaceRoot, 'linked'), 'junction');
  assert.throws(() => writeFile(workspaceRoot, 'linked/escape.txt', 'forbidden'),
    error => /OUTSIDE|ESCAPE|BOUNDARY/.test(error.code), 'WORKSPACE-02: junction cannot redirect a write outside Workspace');
  assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false);

  const crashDir = path.join(workspaceJournalDir(ws.root), 'batch-crash-fixture');
  fs.mkdirSync(crashDir, { recursive: true });
  fs.writeFileSync(path.join(crashDir, '0.preimage'), 'A');
  writeJsonAtomic(path.join(crashDir, 'manifest.json'), { schemaVersion: 1, root: ws.root, status: 'committing', rows: [
    { action: 'write', path: 'a.txt', originalHash: hash('A'), stagedHash: hash('A2'), backup: '0.preimage' }
  ] });
  fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'A2');
  createWorkspaceService({ stateDir });
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'A', 'WORKSPACE-01: restart recovers an interrupted batch');

  const taskState = path.join(root, 'invalid-task');
  fs.mkdirSync(path.join(taskState, 'tasks'), { recursive: true });
  const taskFile = path.join(taskState, 'tasks', 'tasks.json');
  const badTask = JSON.stringify({ schemaVersion: 1, revision: 1, tasks: 'not-an-array' });
  fs.writeFileSync(taskFile, badTask);
  assert.throws(() => createTaskStore({ stateDir: taskState }).count(), error => error.code === 'STORE_CORRUPT');
  assert.equal(fs.readFileSync(taskFile, 'utf8'), badTask, 'SEC-04: Task source preserved');
  assert.ok(fs.readdirSync(path.dirname(taskFile)).some(name => name.startsWith('tasks.corrupt.')), 'SEC-04: Task backup preserved');

  const memoryState = path.join(root, 'invalid-memory');
  fs.mkdirSync(path.join(memoryState, 'memory'), { recursive: true });
  const memoryFile = path.join(memoryState, 'memory', 'memories.json');
  const badMemory = JSON.stringify({ schemaVersion: 1, revision: 1, memories: 'not-an-array' });
  fs.writeFileSync(memoryFile, badMemory);
  assert.throws(() => createMemoryStore({ stateDir: memoryState }).count(), error => error.code === 'STORE_CORRUPT');
  assert.equal(fs.readFileSync(memoryFile, 'utf8'), badMemory, 'MEM-07: malformed Memory source preserved');
  assert.ok(fs.readdirSync(path.dirname(memoryFile)).some(name => name.startsWith('memories.corrupt.')), 'MEM-07: Memory backup preserved');

  const candidateState = path.join(root, 'invalid-candidates');
  fs.mkdirSync(path.join(candidateState, 'memory'), { recursive: true });
  const candidateFile = path.join(candidateState, 'memory', 'candidates.json');
  fs.writeFileSync(candidateFile, '{invalid');
  const memory = createMemoryRuntime({ stateDir: candidateState });
  const principal = { kind: 'user', id: 'desktop' };
  assert.throws(() => memory.listCandidates({ principal }), error => error.code === 'STORE_CORRUPT');
  assert.ok(fs.readdirSync(path.dirname(candidateFile)).some(name => name.startsWith('candidates.corrupt.')), 'MEM-06: invalid candidate source backed up');
  fs.writeFileSync(candidateFile, JSON.stringify({ schemaVersion: 1, candidates: [{ id: 'candidate-1', status: 'pending',
    type: 'user', scope: { key: 'global' }, content: 'keep', proposedAt: 1, proposedBy: 'user:desktop' }] }));
  assert.equal(memory.listCandidates({ principal }).candidates[0]?.id, 'candidate-1', 'MEM-06: failed load retries after repair');
  const candidateBefore = fs.readFileSync(candidateFile, 'utf8');
  const renameCandidate = fs.renameSync;
  fs.renameSync = function (source, destination) {
    if (destination === candidateFile) throw Object.assign(new Error('injected candidate write failure'), { code: 'EIO' });
    return renameCandidate(source, destination);
  };
  try {
    assert.throws(() => memory.confirmCandidate({ principal, id: 'candidate-1', decision: 'reject' }),
      /injected candidate write failure/, 'MEM-06: failed candidate write is reported');
  } finally { fs.renameSync = renameCandidate; }
  assert.equal(memory.listCandidates({ principal }).candidates[0]?.status, 'pending', 'MEM-06: failed candidate write keeps in-memory state');
  assert.equal(fs.readFileSync(candidateFile, 'utf8'), candidateBefore, 'MEM-06: failed candidate write keeps original file');

  const settingsState = path.join(root, 'invalid-settings');
  fs.mkdirSync(path.join(settingsState, 'settings'), { recursive: true });
  const settingsFile = path.join(settingsState, 'settings', 'settings.json');
  const badSettings = JSON.stringify({ schemaVersion: 1, revision: 1, settings: { devices: { meshEnabled: 'false' } } });
  fs.writeFileSync(settingsFile, badSettings);
  const settings = createSettingsStore({ stateDir: settingsState });
  assert.ok(settings.get().lastError, 'SETTINGS-02: schema error is reported');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), badSettings);
  assert.ok(fs.readdirSync(path.dirname(settingsFile)).some(name => name.startsWith('settings.corrupt.')), 'SETTINGS-02: source backup exists');
  assert.throws(() => settings.update('devices', { meshEnabled: false }), error => error.code === 'SETTINGS_RECOVERY_REQUIRED');
  const versionState = path.join(root, 'unknown-settings-version');
  fs.mkdirSync(path.join(versionState, 'settings'), { recursive: true });
  const versionFile = path.join(versionState, 'settings', 'settings.json');
  const unknownVersion = JSON.stringify({ schemaVersion: 99, revision: 1, settings: {} });
  fs.writeFileSync(versionFile, unknownVersion);
  assert.equal(createSettingsStore({ stateDir: versionState }).get().recoveryRequired, true, 'SETTINGS-02: unknown version requires recovery');
  assert.equal(fs.readFileSync(versionFile, 'utf8'), unknownVersion);

  const meshState = path.join(root, 'disabled-mesh');
  const meshSettings = createSettingsStore({ stateDir: meshState });
  meshSettings.update('devices', { meshEnabled: false });
  const mesh = createMeshService({ stateDir: meshState,
    isEnabled: () => meshSettings.get().settings.devices.meshEnabled });
  await assert.rejects(mesh.execute({ method: 'mesh.pairing.start' }), error => error.code === 'MESH_DISABLED');
  await assert.rejects(mesh.execute({ method: 'mesh.envelope.handle', params: { envelope: {} } }), error => error.code === 'MESH_DISABLED');
  assert.equal(mesh.node.pairingStatus().active, false, 'MESH-01: disabled Mesh has no pairing session');
  await mesh.close();
  const meshAfterRestart = createMeshService({ stateDir: meshState,
    isEnabled: () => createSettingsStore({ stateDir: meshState }).get().settings.devices.meshEnabled });
  await assert.rejects(meshAfterRestart.execute({ method: 'mesh.pairing.start' }), error => error.code === 'MESH_DISABLED');
  await meshAfterRestart.close();

  const ownerState = path.join(root, 'core-owner');
  const core = bootstrapCetaMesh({ stateDir: ownerState, dataRoot: path.join(root, 'core-data') });
  let finishCoreCleanup;
  let coreCleanupStarted;
  const coreCleanupReady = new Promise(resolve => { coreCleanupStarted = resolve; });
  const coreCleanupGate = new Promise(resolve => { finishCoreCleanup = resolve; });
  const originalMeshClose = core.services.meshService.close;
  core.services.meshService.close = async () => {
    coreCleanupStarted();
    await coreCleanupGate;
    return originalMeshClose();
  };
  try {
    assert.throws(() => bootstrapCetaMesh({ stateDir: ownerState, dataRoot: path.join(root, 'core-data') }),
      error => error.code === 'STATE_DIR_BUSY', 'SEC-05: a second Core cannot own the same StateDir');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { bootstrapCetaMesh } from ${JSON.stringify(new URL('../src/app/bootstrap.js', import.meta.url).href)};
       try { bootstrapCetaMesh({ stateDir: process.env.PHASE1_STATE_DIR }); process.exit(0); }
       catch (error) { process.exit(error.code === 'STATE_DIR_BUSY' ? 23 : 24); }`],
    { env: { ...process.env, PHASE1_STATE_DIR: ownerState }, timeout: 10000 });
    assert.equal(child.status, 23, 'SEC-05: another process cannot start Core on the owned StateDir');
  } finally {
    const stopping = core.lifecycle.stop();
    await coreCleanupReady;
    try {
      assert.equal(fs.existsSync(path.join(ownerState, '.core-owner.lock')), true,
        'SEC-05: owner remains held while asynchronous resource cleanup is pending');
      assert.throws(() => bootstrapCetaMesh({ stateDir: ownerState, dataRoot: path.join(root, 'core-data') }),
        error => error.code === 'STATE_DIR_BUSY', 'SEC-05: shutdown cannot transfer ownership before resource cleanup completes');
    } finally {
      finishCoreCleanup();
      const report = await stopping;
      assert.equal(report.ok, true);
      assert.equal(report.outcomes.at(-1).name, 'StateDir owner', 'SEC-05: owner release is the final cleanup');
    }
    assert.equal(fs.existsSync(path.join(ownerState, '.core-owner.lock')), false);
  }
  const restartedCore = bootstrapCetaMesh({ stateDir: ownerState, dataRoot: path.join(root, 'core-data') });
  assert.equal((await restartedCore.lifecycle.stop()).ok, true);

  let startEffect;
  const started = new Promise(resolve => { startEffect = resolve; });
  let finishEffect;
  const finishing = new Promise(resolve => { finishEffect = resolve; });
  let sends = 0;
  const dispatchState = path.join(root, 'dispatch-state');
  const broker = createCapabilityBroker({ stateDir: dispatchState });
  broker.register({ id: 'fixture.send', permission: 'message.send', risk: 'low', execute: async () => {
    startEffect();
    await finishing;
    sends += 1;
  } });
  const controller = new AbortController();
  const externalRequest = { actor: owner, capability: 'fixture.send', input: {}, requestId: 'external-send-1' };
  const external = broker.execute(externalRequest, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(external, error => error.code === 'INVOKE_CANCEL_UNCONFIRMED' && error.effectStatus === 'unknown',
    'SEC-03: local Abort cannot claim an external effect was cancelled');
  await assert.rejects(broker.execute(externalRequest), error => error.code === 'REQUEST_ALREADY_DISPATCHED',
    'SEC-03: retrying an uncertain requestId cannot send again');
  finishEffect();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sends, 1, 'SEC-03: external effect may still complete after local Abort');
  assert.equal(broker.dispatchStatus('external-send-1')?.status, 'completed', 'SEC-03: eventual external outcome is recorded');
  const afterRestart = createCapabilityBroker({ stateDir: dispatchState });
  afterRestart.register({ id: 'fixture.send', permission: 'message.send', risk: 'low', execute: () => { sends += 1; } });
  await assert.rejects(afterRestart.execute(externalRequest), error => error.code === 'REQUEST_ALREADY_DISPATCHED');
  assert.equal(afterRestart.dispatchStatus('external-send-1')?.status, 'completed');
  assert.equal(sends, 1, 'SEC-03: requestId cannot replay after Core restart');
  console.log('PASS phase 1 security fixture');
} finally {
  await svc.close();
  fs.rmSync(root, { recursive: true, force: true });
}
