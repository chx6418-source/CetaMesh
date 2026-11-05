import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

// Production Core/Managed Agent/tool path; only the model leaf is deterministic.
// This is neither external-model nor native Desktop acceptance.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cetamesh-functional-loop-'));
const samples = [];
const content = 'A real isolated filesystem result, not model-generated evidence.';

async function until(read, predicate, label) {
  const deadline = Date.now() + 10_000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

async function fixture(name) {
  const base = path.join(root, name), project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'proof.txt'), content);
  const services = createCetaMeshServices({ stateDir: path.join(base, 'state'),
    dataRoot: path.join(base, 'data'), resourceRoot: base, sourceRoot: base });
  const rt = services.taskService.runtime, turns = new Set(), received = [];
  const sample = { name, evidence: 'production-core-deterministic-model-real-filesystem',
    ownerCommands: 0, approvalDecisions: 0, modelCalls: 0, states: [], transitions: 0 };
  const observed = new Map();
  // Observe public Task commands without replacing their validation or storage.
  for (const method of ['create', 'start', 'attachAgent', 'block', 'pause', 'resume', 'cancel', 'complete']) {
    const original = rt[method];
    rt[method] = function (...args) {
      const result = original.apply(this, args), task = result?.task ?? result;
      if (task?.id && task.status && observed.get(task.id) !== task.status) {
        if (observed.has(task.id)) sample.transitions++;
        observed.set(task.id, task.status); sample.states.push(task.status);
      }
      return result;
    };
  }
  services.modelRegistry.register({ id: 'functional-loop', label: 'Deterministic local model leaf',
    supportsTools: true, defaultModel: 'fixture', health: async () => ({ available: true, configured: true }),
    listModels: async () => [{ id: 'fixture' }], chat: async () => { throw Error('Unexpected non-streaming model call'); },
    stream: async function* (request) {
      sample.modelCalls++;
      const user = [...request.messages].reverse().find(row => row.role === 'user');
      const key = JSON.stringify(user?.content);
      if (!turns.has(key)) {
        turns.add(key);
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: `read-${turns.size}`,
          capabilityId: 'filesystem.read', arguments: JSON.stringify({ path: 'proof.txt' }) }] } };
      } else {
        const results = request.messages.filter(row => row.role === 'tool');
        assert.ok(JSON.stringify(results).includes(content), 'model must receive actual Broker tool output');
        received.push(...results);
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Observed the real file result.' }] } } };
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  services.providerSecrets.set({ provider: 'functional-loop', apiKey: 'synthetic-local-only' });
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create',
    params: { root: project, name } })).workspace;
  const ui = (method, params) => {
    sample.ownerCommands++;
    if (method === 'ui.approvals.decide') sample.approvalDecisions++;
    return services.desktopUiService.execute({ method, params });
  };
  const read = id => rt.get({ id }).task;
  const finished = id => until(() => read(id), row => row.executionObservation?.state === 'awaiting-review'
    && !services.capabilityService.completionBlocker(id), 'Agent and tool settlement');
  const complete = async id => {
    const task = await finished(id);
    assert.ok(task.currentAgent?.sessionId, 'real Managed session must be attached');
    assert.ok(task.executionEvidence.some(row => row.capability === 'filesystem.read' && row.status === 'completed'));
    const result = await ui('ui.task.complete', { id, expectedRev: task.rev, reviewed: true,
      summary: 'Verified the isolated actual filesystem read and its retained tool receipt.' });
    assert.equal(result.task.status, 'completed');
    assert.equal(services.capabilityService.broker.approvals.list().length, 0);
    assert.equal(fs.readFileSync(path.join(project, 'proof.txt'), 'utf8'), content);
    assert.ok(received.length);
    return result.task;
  };
  const started = performance.now();
  return { services, rt, workspace, project, ui, read, finished, complete, sample,
    async close() {
      sample.elapsedMs = +(performance.now() - started).toFixed(3);
      samples.push(sample);
      for (const service of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) {
        await services[service].close();
      }
    } };
}

try {
  const f = await fixture('F0-minimum');
  try {
    const task = f.rt.create({ goal: 'Read proof.txt and return its actual content.', workspaceId: f.workspace.id });
    const result = await f.services.capabilityService.broker.execute({ actor: OWNER_ACTOR, taskId: task.id,
      workspaceId: f.workspace.id, requestId: 'minimum-run', capability: 'agent.run',
      input: { agentProvider: 'cetamesh', modelProvider: 'functional-loop', model: 'fixture', content: task.goal } });
    assert.equal(result.result.accepted, true);
    assert.equal((await f.complete(task.id)).id, task.id);
    assert.equal(f.sample.approvalDecisions, 0, 'existing read authorization must not create another approval');
    console.log('PASS F0 Agent Session -> Task -> actual Broker file read -> result -> reviewed completion');
  } finally { await f.close(); }

  const integrated = await fixture('F1-desktop-pause-resume');
  try {
    const created = await integrated.ui('ui.task.create', { goal: 'Inspect proof.txt through the normal Task entry.',
      workspaceId: integrated.workspace.id, agentProvider: 'cetamesh', modelProvider: 'functional-loop', model: 'fixture', requestId: 'integrated-create' });
    const id = created.task.id, settled = await integrated.finished(id);
    const checkpoint = integrated.rt.setCheckpoint({ id, expectedRev: settled.rev,
      summary: 'The first actual file read returned.', nextAction: 'Read proof.txt again for the next explicit turn.' });
    const priorHistory = structuredClone(checkpoint.agentHistory);
    const paused = await integrated.ui('ui.task.pause', { id, expectedRev: checkpoint.rev });
    assert.equal(paused.task.status, 'paused');
    const resumed = await integrated.ui('ui.task.resume', { id, expectedRev: paused.task.rev, requestId: 'integrated-resume' });
    assert.equal(resumed.task.id, id);
    const ended = await integrated.complete(id);
    assert.equal(ended.id, id);
    const final = integrated.read(id);
    assert.deepEqual(final.agentHistory.map(row => [row.provider, row.sessionId]), priorHistory.map(row => [row.provider, row.sessionId]));
    assert.deepEqual(final.checkpoint, checkpoint.checkpoint);
    assert.equal(final.executionEvidence.filter(row => row.capability === 'filesystem.read' && row.status === 'completed').length, 2);
    assert.equal(integrated.sample.approvalDecisions, 0);
    console.log('PASS F1 Desktop create -> actual read -> pause -> same-Task resume -> second actual read -> complete');
  } finally { await integrated.close(); }
} finally {
  if (process.env.CETAMESH_FUNCTIONAL_METRICS_FILE) fs.writeFileSync(process.env.CETAMESH_FUNCTIONAL_METRICS_FILE,
    JSON.stringify({ samples, externalModelCalls: 0, nativeAcceptance: false }, null, 2) + '\n');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('cetamesh-functional-loop-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
