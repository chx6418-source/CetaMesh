import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-phase3-task-'));
const services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') });
try {
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const { workspace } = await services.workspaceService.execute({ method: 'workspace.create',
    params: { name: 'Phase 3 task', root: workspaceRoot } });
  const task = services.taskService.runtime.create({ goal: 'Complete two instructions', workspaceId: workspace.id });
  const sent = [];
  const originalCreateSession = services.agentBroker.createSession;
  const originalSend = services.agentBroker.send;
  const originalStatus = services.agentBroker.status;
  const originalCancel = services.agentBroker.cancel;
  let releases;
  const ready = new Promise(resolve => { releases = resolve; });
  const createSession = services.agentBroker.createSession.bind(services.agentBroker);
  services.agentBroker.createSession = async (...args) => { const session = await createSession(...args); await ready; return session; };
  services.agentBroker.send = async request => { sent.push(request.content); return { accepted: true }; };
  services.agentBroker.status = async () => ({ running: false });
  const run = (requestId, content) => services.capabilityService.broker.execute({ requestId,
    actor: OWNER_ACTOR, taskId: task.id, workspaceId: workspace.id, capability: 'agent.run',
    input: { agentProvider: 'cetamesh', content }, reason: 'Phase 3 concurrent Task instruction regression' });
  const first = run('phase3-first', 'first distinct instruction');
  const second = run('phase3-second', 'second distinct instruction');
  releases();
  const results = await Promise.all([first, second]);
  assert.deepEqual(sent, ['first distinct instruction', 'second distinct instruction'],
    'concurrent requests to one Task must send each distinct instruction exactly once');
  assert.equal(results.every(result => result.status === 'completed' && result.result.accepted === true), true);
  await run('phase3-first', 'first distinct instruction');
  assert.equal(sent.length, 2, 'retrying a requestId must not duplicate an Agent instruction');

  const assigned = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Produce a result in the Workspace', workspaceId: workspace.id, agentProvider: 'cetamesh'
  } });
  assert.equal(assigned.task.status, 'running', 'Work creation must start a real Agent turn');
  assert.equal(sent.at(-1), 'Produce a result in the Workspace');
  assert.equal(assigned.task.currentAgent.provider, 'cetamesh');
  let cancellations = 0;
  services.agentBroker.cancel = async () => { cancellations++; return { cancelled: true }; };
  const paused = await services.desktopUiService.execute({ method: 'ui.task.pause', params: {
    id: assigned.task.id, expectedRev: assigned.task.rev
  } });
  assert.equal(paused.task.status, 'paused');
  assert.equal(cancellations, 1, 'Pause must cancel active Agent execution');
  const resumed = await services.desktopUiService.execute({ method: 'ui.task.resume', params: {
    id: paused.task.id, expectedRev: paused.task.rev
  } });
  assert.equal(resumed.task.status, 'running');
  assert.match(sent.at(-1), /Produce a result in the Workspace/, 'resume must send Task facts');
  const cancelled = await services.desktopUiService.execute({ method: 'ui.task.cancel', params: {
    id: resumed.task.id, expectedRev: resumed.task.rev
  } });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancellations, 2, 'Cancel must stop Agent execution before terminal Task state');

  services.agentBroker.createSession = originalCreateSession;
  services.agentBroker.send = originalSend;
  services.agentBroker.status = originalStatus;
  services.agentBroker.cancel = originalCancel;
  services.modelRegistry.register({ id: 'phase3-fixture', label: 'Phase 3 Fixture', defaultModel: 'fixture-model',
    supportsTools: false, listModels: async () => [{ id: 'fixture-model' }], health: async () => ({}),
    chat: async () => ({ text: 'Workspace analysis finished' }),
    stream: async function* () {
      yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Workspace analysis finished' } } };
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  services.providerSecrets.set({ provider: 'phase3-fixture', apiKey: 'fixture-secret-key' });
  const actual = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Analyze the Workspace', workspaceId: workspace.id, agentProvider: 'cetamesh', modelProvider: 'phase3-fixture'
  } });
  const deadline = Date.now() + 2000;
  let observed;
  do {
    observed = services.taskService.runtime.get({ id: actual.task.id }).task;
    if (observed.checkpoint?.summary?.includes('Workspace analysis finished')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.match(observed.checkpoint?.summary ?? '', /Workspace analysis finished/,
    `real Agent result must persist to the Task checkpoint independently of an open Chat page: ${JSON.stringify({
      status: observed.status, progress: observed.progress,
      agent: await services.agentBroker.status(observed.currentAgent)
    })}`);
} finally {
  await services.capabilityService.close();
  fs.rmSync(root, { recursive: true, force: true });
}
