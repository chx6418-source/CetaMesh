import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createTaskService } from '../src/task/service.js';
import { createTaskRecovery } from '../src/desktop/task-recovery.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createWorkspaceRegistry, workspaceRegistryFile } from '../src/workspace/registry.js';
import { workspaceJournalDir, recoverWorkspaceImports } from '../src/workspace/transaction.js';

// Real non-Git files, transaction manifests and storage. No model or native UI.
const parent = fs.realpathSync.native(os.tmpdir());
const base = fs.mkdtempSync(path.join(parent, 'cetamesh-import-recovery-'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const journals = new Set(), cases = [], test = (name, run) => cases.push([name, run]);
function fixture(name, live = 'third-party') {
  const root = path.join(base, name), project = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'input.txt'), live);
  const workspace = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir) }).create({ root: project, name });
  const journal = workspaceJournalDir(project); journals.add(journal);
  const batch = path.join(journal, 'batch-original'); fs.mkdirSync(batch, { recursive: true });
  const manifest = { schemaVersion: 1, root: project, status: 'committing', rows: [
    { action: 'write', path: 'input.txt', originalHash: hash('original'), stagedHash: hash('staged'), backup: '0.preimage' }
  ] };
  fs.writeFileSync(path.join(batch, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(batch, '0.preimage'), 'original');
  return { root, project, stateDir, workspace, journal, batch, manifest,
    build: () => createWorkspaceService({ stateDir }) };
}

test('F0 normal interrupted import restores verified original bytes', async () => {
  const f = fixture('rollback', 'staged'), service = f.build();
  assert.equal(service.describeWorkspace(f.workspace.id).root, f.project);
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.journal), []);
  assert.equal((await service.collectRecoveryProof(f.workspace.id)).kind, 'filtered-workspace-v1');
});

test('F0 conflicting bytes retain project ownership and original recovery evidence', async () => {
  const f = fixture('conflict'), manifest = fs.readFileSync(path.join(f.batch, 'manifest.json'));
  const service = f.build();
  assert.equal(service.describeWorkspace(f.workspace.id), null);
  await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'third-party');
  assert.deepEqual(fs.readFileSync(path.join(f.batch, 'manifest.json')), manifest);
});

test('F1 Owner verifies original import and resumes the same Task in the same Core', async () => {
  const f = fixture('same-core');
  const services = createCetaMeshServices({ stateDir: f.stateDir, dataRoot: path.join(f.root, 'data'), resourceRoot: f.root, sourceRoot: f.root });
  try {
    const rt = services.taskService.runtime, task = rt.create({ goal: 'Read reconciled input.txt', workspaceId: f.workspace.id });
    const read = () => rt.get({ id: task.id }).task;
    const memory = await services.memoryService.execute({ method: 'memory.create', params: {
      type: 'chat', scope: 'task:' + task.id, content: 'Original Owner note must survive recovery', source: 'user' } });
    rt.linkMemory({ id: task.id, expectedRev: read().rev, memoryId: memory.id, scope: memory.scope, type: memory.type, note: 'Original note' });
    const memoryBefore = await services.memoryService.execute({ method: 'memory.get', params: { id: memory.id } });
    rt.setCheckpoint({ id: task.id, expectedRev: read().rev, summary: 'Keep original checkpoint', nextAction: 'Read reconciled input' });
    rt.setModelConfig({ id: task.id, expectedRev: read().rev, modelProvider: 'import-fixture', model: 'fixture' });
    rt.start({ id: task.id, expectedRev: read().rev }); rt.block({ id: task.id, expectedRev: read().rev, reason: 'needs-reconciliation: import interrupted' });
    const before = read(); let modelCalls = 0, actualToolResult = false;
    services.modelRegistry.register({ id: 'import-fixture', label: 'Controlled model leaf', supportsTools: true, defaultModel: 'fixture',
      health: async () => ({ available: true, configured: true }), listModels: async () => [{ id: 'fixture' }],
      stream: async function* (request) {
        modelCalls++;
        if (modelCalls === 1) yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'read-recovered-file', capabilityId: 'filesystem.read', arguments: JSON.stringify({ path: 'input.txt' }) }] } };
        else {
          actualToolResult = request.messages.some(row => row.role === 'tool' && JSON.stringify(row.content).includes('original'));
          assert.ok(actualToolResult, 'real Broker file result must reach the model leaf');
          yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Read original bytes.' }] } } };
        }
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: 'import-fixture', apiKey: 'synthetic-local-only' });
    const ui = (method, params) => services.desktopUiService.execute({ method, params });
    const denied = await ui('ui.task.recovery.inspect', { id: task.id });
    assert.equal(denied.canResume, false); assert.ok(denied.blockers.some(row => row.code === 'WORKSPACE_RECOVERY_REQUIRED'));
    assert.deepEqual(read(), before); assert.equal(modelCalls, 0);
    // Simulate Owner reconciling the actual bytes against retained preimages;
    // text acknowledgement alone cannot satisfy this proof.
    fs.writeFileSync(path.join(f.project, 'input.txt'), 'original');
    const reviewed = await ui('ui.task.recovery.inspect', { id: task.id });
    assert.equal(reviewed.canResume, true, JSON.stringify(reviewed.blockers));
    assert.equal(reviewed.workspace.kind, 'filtered-workspace-v1');
    const resumed = await ui('ui.task.reconcile', { id: task.id, expectedRev: read().rev,
      action: 'resume', provider: 'cetamesh', reviewed: true, reviewToken: reviewed.reviewToken,
      reviewedOperationIds: reviewed.reviewOperationIds, reviewSummary: 'Verified original bytes and retained batch evidence',
      nextInstruction: 'Read input.txt through the registered filesystem tool', requestId: 'explicit-import-resume' });
    assert.equal(resumed.task.id, task.id);
    const deadline = Date.now() + 10_000;
    while (read().executionObservation?.state !== 'awaiting-review' || services.capabilityService.completionBlocker(task.id)) {
      assert.ok(Date.now() < deadline, 'real Core file read must settle'); await delay(5);
    }
    assert.ok(actualToolResult); assert.equal(modelCalls, 2);
    assert.ok(read().executionEvidence.some(row => row.capability === 'filesystem.read' && row.status === 'completed'));
    assert.deepEqual(read().checkpoint, before.checkpoint);
    for (const ref of before.memoryRefs) assert.deepEqual(read().memoryRefs.find(row => row.memoryId === ref.memoryId), ref);
    assert.deepEqual((await services.memoryService.execute({ method: 'memory.get', params: { id: memory.id } })).memory, memoryBefore.memory);
    assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(f.project, '.git')), false);
    assert.equal(services.capabilityService.broker.approvals.list().length, 0);
    assert.deepEqual(fs.readdirSync(f.journal), []);
    console.log('METRIC same-Core Owner recovery: inspect(refused), inspect(verified), reconcile(resume); approvals=0; modelCalls=' + modelCalls);
  } finally {
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
});

for (const kind of ['missing-manifest', 'missing-preimage', 'changed-preimage', 'changed-manifest', 'unrelated-batch', 'removed-journal']) {
  test('F2 ' + kind + ' cannot replace original recovery evidence', async () => {
    const f = fixture(kind), service = f.build();
    fs.writeFileSync(path.join(f.project, 'input.txt'), 'original');
    if (kind === 'missing-manifest') fs.renameSync(path.join(f.batch, 'manifest.json'), path.join(f.batch, 'manifest.retained'));
    if (kind === 'missing-preimage') fs.renameSync(path.join(f.batch, '0.preimage'), path.join(f.batch, '0.retained'));
    if (kind === 'changed-preimage') fs.writeFileSync(path.join(f.batch, '0.preimage'), 'different');
    if (kind === 'changed-manifest') fs.writeFileSync(path.join(f.batch, 'manifest.json'), JSON.stringify({ ...f.manifest, status: 'completed' }));
    if (kind === 'unrelated-batch') fs.renameSync(f.batch, path.join(f.journal, 'batch-unrelated'));
    if (kind === 'removed-journal') {
      // A direct helper result is not the same-Core Owner settlement receipt.
      assert.deepEqual(recoverWorkspaceImports(f.project), ['batch-original']);
    }
    await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(service.describeWorkspace(f.workspace.id), null);
    assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
  });
}

test('F2 read-only facts and overlapping Workspace identities cannot trigger rollback', async () => {
  const f = fixture('overlap'), service = f.build();
  fs.writeFileSync(path.join(f.project, 'input.txt'), 'staged');
  const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested);
  for (const [name, root] of [['ancestor', f.root], ['descendant', nested]]) {
    const alias = (await service.execute({ method: 'workspace.create', params: { name, root } })).workspace;
    await assert.rejects(service.collectRecoveryProof(alias.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(service.describeWorkspace(alias.id), null);
  }
  await assert.rejects(service.collectContentProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(service.describeWorkspace(f.workspace.id), null);
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'staged');
  assert.ok(fs.existsSync(path.join(f.batch, 'manifest.json')));
});

test('F2 unknown execution cannot turn Owner inspection into a Workspace write', async () => {
  const f = fixture('active-executor'), workspaceService = f.build(), taskService = createTaskService({ stateDir: f.stateDir });
  const task = taskService.runtime.create({ goal: 'Keep external execution ownership', workspaceId: f.workspace.id });
  let row = taskService.runtime.attachAgent({ id: task.id, expectedRev: task.rev, provider: 'external', sessionId: 'unconfirmed' }).task;
  row = taskService.runtime.start({ id: row.id, expectedRev: row.rev }).task;
  row = taskService.runtime.block({ id: row.id, expectedRev: row.rev, reason: 'needs-reconciliation: unknown process' }).task;
  fs.writeFileSync(path.join(f.project, 'input.txt'), 'staged');
  const recovery = createTaskRecovery({ services: { taskService, workspaceService, capabilityService: {},
    agentBroker: { require: () => ({}), capabilities: () => ({ workspaceBoundary: 'native-staged' }) } } });
  const inspected = await recovery.inspect(row);
  assert.equal(inspected.canRelease, false); assert.ok(inspected.blockers.some(blocker => blocker.code === 'SESSION_EXECUTION_UNCONFIRMED'));
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'staged');
  assert.ok(fs.existsSync(path.join(f.batch, 'manifest.json')));
  assert.deepEqual(taskService.runtime.get({ id: row.id }).task, row);
});

test('F2 another Task writer prevents import recovery through an older Task', async () => {
  const f = fixture('other-writer');
  const services = createCetaMeshServices({ stateDir: f.stateDir, dataRoot: path.join(f.root, 'data'), resourceRoot: f.root, sourceRoot: f.root });
  try {
    const rt = services.taskService.runtime;
    const old = rt.create({ goal: 'Older interrupted task', workspaceId: f.workspace.id });
    let oldRow = rt.start({ id: old.id, expectedRev: old.rev }).task;
    oldRow = rt.block({ id: old.id, expectedRev: oldRow.rev, reason: 'needs-reconciliation: import interrupted' }).task;
    const writer = rt.create({ goal: 'Existing writer still owns execution', workspaceId: f.workspace.id });
    const assigned = rt.attachAgent({ id: writer.id, expectedRev: writer.rev, provider: 'external', sessionId: 'still-owned' }).task;
    rt.start({ id: writer.id, expectedRev: assigned.rev });
    fs.writeFileSync(path.join(f.project, 'input.txt'), 'staged');
    const inspected = await services.desktopUiService.execute({ method: 'ui.task.recovery.inspect', params: { id: old.id } });
    assert.equal(inspected.canRelease, false, 'recovery must respect the other Task ownership');
    assert.ok(inspected.blockers.some(row => row.code === 'TASK_WORKSPACE_BUSY'));
    assert.ok(inspected.blockers.some(row => row.blockingTaskId === writer.id && row.message.includes(writer.id)));
    assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'staged');
    assert.ok(fs.existsSync(path.join(f.batch, 'manifest.json')));
    assert.deepEqual(rt.get({ id: old.id }).task, oldRow);
  } finally {
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
});

test('F3 a completed import with interrupted preimage cleanup stays completed', async () => {
  const f = fixture('completed-cleanup', 'staged');
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), JSON.stringify({ ...f.manifest, status: 'completed' }));
  // The durable completion marker precedes best-effort cleanup. Backups may
  // already be gone; completed imports never use them to overwrite user files.
  fs.renameSync(path.join(f.batch, '0.preimage'), path.join(f.root, 'retained-preimage'));
  const service = f.build();
  assert.equal(service.describeWorkspace(f.workspace.id)?.root, f.project);
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'staged');
  assert.deepEqual(fs.readdirSync(f.journal), []);
});

test('F2 unassigned Owner effect blocks recovery until its actual file operation settles', async () => {
  const f = fixture('owner-effect', 'staged');
  const services = createCetaMeshServices({ stateDir: f.stateDir, dataRoot: path.join(f.root, 'data'), resourceRoot: f.root, sourceRoot: f.root });
  let finish, entered = false, operation;
  const gate = new Promise(resolve => { finish = resolve; });
  try {
    const rt = services.taskService.runtime, task = rt.create({ goal: 'Interrupted import', workspaceId: f.workspace.id });
    const started = rt.start({ id: task.id, expectedRev: task.rev }).task;
    rt.block({ id: task.id, expectedRev: started.rev, reason: 'needs-reconciliation: import' });
    const broker = services.capabilityService.broker;
    broker.register({ id: 'fixture.workspace-effect', permission: 'filesystem.write', effect: 'non-idempotent',
      execute: async () => { entered = true; await gate; fs.writeFileSync(path.join(f.project, 'owner-result.txt'), 'actual Owner result'); return { written: true }; } });
    operation = broker.execute({ requestId: 'owner-file-effect', workspaceId: f.workspace.id, actor: OWNER_ACTOR,
      approved: true, capability: 'fixture.workspace-effect', input: {} });
    const deadline = Date.now() + 1000;
    while (!entered) { assert.ok(Date.now() < deadline); await delay(1); }
    fs.mkdirSync(f.batch); fs.writeFileSync(path.join(f.batch, 'manifest.json'), JSON.stringify(f.manifest));
    fs.writeFileSync(path.join(f.batch, '0.preimage'), 'original'); fs.writeFileSync(path.join(f.project, 'input.txt'), 'third-party');
    assert.throws(() => services.workspaceService.applyChanges({ id: f.workspace.id, changes: [{ action: 'write', path: 'unused.txt', content: 'unused' }] }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    fs.writeFileSync(path.join(f.project, 'input.txt'), 'staged');
    const inspect = () => services.desktopUiService.execute({ method: 'ui.task.recovery.inspect', params: { id: task.id } });
    const denied = await inspect();
    assert.equal(denied.canResume, false); assert.ok(denied.blockers.some(row => row.code === 'OPERATION_STILL_RUNNING'));
    assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'staged');
    finish(); await operation;
    assert.equal((await inspect()).canResume, true);
    assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(f.project, 'owner-result.txt'), 'utf8'), 'actual Owner result');
  } finally {
    finish(); await operation;
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
});

test('F3 verified rollback can retry partial journal cleanup without accepting unverified missing backups', async () => {
  const f = fixture('rollback-cleanup'), service = f.build(), remove = fs.rmSync;
  fs.writeFileSync(path.join(f.project, 'input.txt'), 'staged');
  try {
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === f.batch) {
        fs.unlinkSync(path.join(f.batch, '0.preimage'));
        throw Object.assign(new Error('Controlled cleanup interruption'), { code: 'EBUSY' });
      }
      return remove(target, options);
    };
    await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  } finally { fs.rmSync = remove; }
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
  assert.ok(fs.existsSync(path.join(f.batch, 'manifest.json')));
  fs.writeFileSync(path.join(f.project, 'input.txt'), 'later-user-edit');
  await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'later-user-edit');
  fs.writeFileSync(path.join(f.project, 'input.txt'), 'original');
  assert.equal((await service.collectRecoveryProof(f.workspace.id)).fileCount, 1);
  assert.deepEqual(fs.readdirSync(f.journal), []);
});

test('F3 startup retains verified rollback evidence if its first cleanup is interrupted', async () => {
  const f = fixture('startup-cleanup', 'staged'), remove = fs.rmSync; let service;
  try {
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === f.batch) {
        fs.unlinkSync(path.join(f.batch, '0.preimage'));
        throw Object.assign(new Error('Controlled startup cleanup interruption'), { code: 'EBUSY' });
      }
      return remove(target, options);
    };
    service = f.build();
  } finally { fs.rmSync = remove; }
  assert.equal(service.describeWorkspace(f.workspace.id), null);
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
  assert.equal((await service.collectRecoveryProof(f.workspace.id)).fileCount, 1);
  assert.deepEqual(fs.readdirSync(f.journal), []);
});

test('F3 ordinary failed import with complete rollback leaves no stale recovery fence', async () => {
  const f = fixture('ordinary-rollback', 'staged'), service = f.build(), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (path.resolve(String(to)) === path.join(f.project, 'input.txt')) throw Object.assign(new Error('Controlled write failure'), { code: 'EIO' });
      return rename(from, to);
    };
    assert.throws(() => service.applyChanges({ id: f.workspace.id, changes: [{ action: 'write', path: 'input.txt', content: 'new' }] }), { code: 'WRITE_FAILED' });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.journal), []);
  assert.equal(service.describeWorkspace(f.workspace.id)?.root, f.project);
  service.applyChanges({ id: f.workspace.id, changes: [{ action: 'write', path: 'input.txt', content: 'explicit retry' }] });
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'explicit retry');
});

test('F2 completed history from a removed Workspace does not block unrelated recovery', async () => {
  const f = fixture('retired-workspace');
  const services = createCetaMeshServices({ stateDir: f.stateDir, dataRoot: path.join(f.root, 'data'), resourceRoot: f.root, sourceRoot: f.root });
  try {
    const retiredRoot = path.join(f.root, 'retired'); fs.mkdirSync(retiredRoot);
    const retired = (await services.workspaceService.execute({ method: 'workspace.create', params: { name: 'Retired', root: retiredRoot } })).workspace;
    await services.capabilityService.broker.execute({ capability: 'filesystem.write', actor: OWNER_ACTOR, approved: true,
      workspaceId: retired.id, requestId: 'retired-completed-write', input: { path: 'retained.txt', content: 'Keep this history' } });
    await services.workspaceService.execute({ method: 'workspace.remove', params: { id: retired.id } });
    const rt = services.taskService.runtime, task = rt.create({ goal: 'Recover separate Workspace', workspaceId: f.workspace.id });
    const started = rt.start({ id: task.id, expectedRev: task.rev }).task;
    rt.block({ id: task.id, expectedRev: started.rev, reason: 'needs-reconciliation: import' });
    fs.writeFileSync(path.join(f.project, 'input.txt'), 'original');
    const inspected = await services.desktopUiService.execute({ method: 'ui.task.recovery.inspect', params: { id: task.id } });
    assert.equal(inspected.canResume, true, JSON.stringify(inspected.blockers));
    assert.equal(fs.readFileSync(path.join(retiredRoot, 'retained.txt'), 'utf8'), 'Keep this history');
    assert.equal(services.capabilityService.broker.dispatchStatus('retired-completed-write').status, 'completed');
  } finally {
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
});

test('F3 partial multi-batch recovery records exact progress and can finish without Core restart', async () => {
  const f = fixture('multiple');
  const other = path.join(f.journal, 'batch-second'); fs.mkdirSync(other);
  const manifest = { ...f.manifest, rows: [{ ...f.manifest.rows[0], path: 'second.txt' }] };
  fs.writeFileSync(path.join(other, 'manifest.json'), JSON.stringify(manifest)); fs.writeFileSync(path.join(other, '0.preimage'), 'original');
  fs.writeFileSync(path.join(f.project, 'second.txt'), 'second-third-party');
  const service = f.build(); fs.writeFileSync(path.join(f.project, 'input.txt'), 'original');
  await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(f.batch), false, 'the first batch has an affirmative settlement receipt');
  assert.equal(fs.existsSync(other), true); assert.equal(service.describeWorkspace(f.workspace.id), null);
  fs.writeFileSync(path.join(f.project, 'second.txt'), 'staged');
  const proof = await service.collectRecoveryProof(f.workspace.id);
  assert.equal(proof.fileCount, 2); assert.equal(fs.readFileSync(path.join(f.project, 'second.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.journal), []);
  const restarted = f.build();
  assert.equal(restarted.describeWorkspace(f.workspace.id).root, f.project);
  assert.deepEqual(await restarted.collectRecoveryProof(f.workspace.id), proof);
});

test('F3 a change during rollback retains the batch until final content verification succeeds', async () => {
  const f = fixture('rollback-race');
  f.manifest.rows.push({ ...f.manifest.rows[0], path: 'second.txt', backup: '1.preimage' });
  fs.writeFileSync(path.join(f.batch, 'manifest.json'), JSON.stringify(f.manifest)); fs.writeFileSync(path.join(f.batch, '1.preimage'), 'original');
  fs.writeFileSync(path.join(f.project, 'second.txt'), 'third-party');
  const service = f.build(), rename = fs.renameSync;
  const originalManifest = fs.readFileSync(path.join(f.batch, 'manifest.json'));
  for (const name of ['input.txt', 'second.txt']) fs.writeFileSync(path.join(f.project, name), 'staged');
  try {
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (path.resolve(String(to)) === path.join(f.project, 'input.txt')) fs.writeFileSync(path.join(f.project, 'second.txt'), 'concurrent-edit');
      return result;
    };
    await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(path.join(f.batch, 'manifest.json')), originalManifest);
  assert.equal(fs.readFileSync(path.join(f.project, 'second.txt'), 'utf8'), 'concurrent-edit');
  fs.writeFileSync(path.join(f.project, 'second.txt'), 'original');
  assert.equal((await service.collectRecoveryProof(f.workspace.id)).fileCount, 2);
  assert.equal(service.describeWorkspace(f.workspace.id).root, f.project);
});

try {
  for (const [name, run] of cases) { const start = performance.now(); await run(); console.log('PASS', name, Math.round(performance.now() - start) + 'ms'); }
} finally {
  for (const journal of journals) {
    assert.equal(path.dirname(path.resolve(journal)), path.join(os.tmpdir(), 'CetaMesh', 'workspace-import-journal'));
    assert.match(path.basename(journal), /^[a-f0-9]{32}$/); fs.rmSync(journal, { recursive: true, force: true });
  }
  assert.equal(path.dirname(path.resolve(base)), parent); assert.ok(path.basename(base).startsWith('cetamesh-import-recovery-'));
  fs.rmSync(base, { recursive: true, force: true });
}
