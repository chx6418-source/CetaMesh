import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createWorkspaceRegistry, workspaceRegistryFile } from '../src/workspace/registry.js';
import { workspaceJournalDir } from '../src/workspace/transaction.js';

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
