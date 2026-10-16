import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/index.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-phase3-task-'));
const services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') });
try {
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'proof.txt'), 'Task data stays intact');
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
  const competingTask = services.taskService.runtime.create({ goal: 'Competing task in the same Workspace', workspaceId: workspace.id });
  await assert.rejects(services.capabilityService.broker.execute({ requestId: 'phase3-workspace-conflict',
    actor: OWNER_ACTOR, taskId: competingTask.id, workspaceId: workspace.id, capability: 'agent.run',
    input: { agentProvider: 'cetamesh', content: 'must not start a second Workspace writer' } }),
  error => error.code === 'TASK_WORKSPACE_BUSY', 'two Tasks in one Workspace cannot hold concurrent write execution');
  services.capabilityService.setTaskHandoffGuard(() => true);
  await assert.rejects(services.capabilityService.broker.execute({ requestId: 'phase3-bootstrap-agent-read',
    actor: services.capabilityService.principalForTask(task.id), taskId: task.id,
    workspaceId: workspace.id, assignment: services.taskService.runtime.get({ id: task.id }).task.currentAgent,
    capability: 'filesystem.read', input: { path: 'proof.txt' } }),
  error => error.code === 'TASK_HANDOFF_IN_FLIGHT', 'provisional bootstrap Agent cannot use Task capabilities before Handoff commits');
  await assert.rejects(run('phase3-during-handoff', 'must not race handoff'),
    error => error.code === 'TASK_HANDOFF_IN_FLIGHT');
  assert.equal(sent.length, 2, 'agent.run must not send while Handoff owns the Task');
  services.capabilityService.setTaskHandoffGuard(() => false);
  const isTaskProvisioning = services.capabilityService.isTaskProvisioning;
  services.capabilityService.isTaskProvisioning = () => true;
  await assert.rejects(services.continuityService.runtime.rollover({ taskId: task.id, targetProvider: 'cetamesh' }),
    error => error.code === 'ROLLOVER_NOT_SAFE', 'Handoff must not start while agent.run owns the Task');
  services.capabilityService.isTaskProvisioning = isTaskProvisioning;
  const firstTask = services.taskService.runtime.get({ id: task.id }).task;
  await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: task.id, expectedRev: firstTask.rev } });
  const rivalTask = services.taskService.runtime.create({ goal: 'Concurrent rival Task', workspaceId: workspace.id });
  const rivalResults = await Promise.allSettled([
    services.capabilityService.broker.execute({ requestId: 'phase3-rival-a', actor: OWNER_ACTOR,
      taskId: competingTask.id, workspaceId: workspace.id, capability: 'agent.run',
      input: { agentProvider: 'cetamesh', content: 'first rival' } }),
    services.capabilityService.broker.execute({ requestId: 'phase3-rival-b', actor: OWNER_ACTOR,
      taskId: rivalTask.id, workspaceId: workspace.id, capability: 'agent.run',
      input: { agentProvider: 'cetamesh', content: 'second rival' } })
  ]);
  assert.equal(rivalResults.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(rivalResults.filter(row => row.status === 'rejected' && row.reason?.code === 'TASK_WORKSPACE_BUSY').length, 1);
  const winnerId = rivalResults[0].status === 'fulfilled' ? competingTask.id : rivalTask.id;
  const winner = services.taskService.runtime.get({ id: winnerId }).task;
  await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: winner.id, expectedRev: winner.rev } });

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
  assert.equal(services.taskService.runtime.get({ id: actual.task.id }).task.modelConfig?.modelProvider, 'phase3-fixture',
    'Task must persist the selected Model Provider independently of an Agent Session');
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
  const chatSession = await services.chatService.execute({ method: 'chat.sessions.create', params: {} });
  const chatStoreFile = path.join(root, 'state', 'desktop-chat', 'sessions.json');
  const chatStore = readJsonFile(chatStoreFile);
  const chatRecord = chatStore.sessions.find(row => row.id === chatSession.id);
  chatRecord.taskId = actual.task.id;
  chatRecord.config.workspaceId = workspace.id;
  chatRecord.dshSessionId = 'stale-core-session';
  chatRecord.runtimeProvider = 'dsh';
  writeJsonAtomic(chatStoreFile, chatStore);
  writeJsonAtomic(path.join(root, 'state', 'desktop-chat', 'history', `${chatSession.id}.json`), {
    schemaVersion: 1, messages: [{ id: 'phase3-unfinished-user', role: 'user', text: 'Unfinished before restart', at: Date.now() }]
  });
  const chatPrompts = [];
  const restarted = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
    api: {
      async callEndpoint(endpoint, args) {
        if (endpoint === 'session/create') return { sessionId: 'phase3-recovery-chat' };
        if (endpoint === 'session/prompt') { chatPrompts.push(args.request.content[0].text); return { accepted: true }; }
        if (endpoint === 'session/selectModel') return {};
        throw new Error(`Unexpected DSH fixture endpoint: ${endpoint}`);
      },
      async *openRemoteStream(_endpoint, _args, { signal } = {}) {
        await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
      }
    } });
  try {
    const recovered = restarted.taskService.runtime.get({ id: actual.task.id }).task;
    assert.equal(recovered.status, 'blocked', 'Core restart must identify interrupted running Tasks');
    assert.equal(recovered.modelConfig?.modelProvider, 'phase3-fixture');
    assert.match(recovered.progress.note, /interrupted|重启|中断/i);
    assert.match(recovered.checkpoint.summary, /Workspace analysis finished/);
    await assert.rejects(restarted.capabilityService.broker.execute({ requestId: 'phase3-stale-agent-read',
      actor: restarted.capabilityService.principalForTask(actual.task.id), taskId: actual.task.id,
      workspaceId: workspace.id, capability: 'filesystem.read', input: { path: 'proof.txt' },
      assignment: recovered.currentAgent, reason: 'stale Agent after Core restart' }),
    error => error.code === 'TASK_NOT_AUTHORIZED', 'interrupted Task must not grant its old Agent new effects');
    const chatStatus = await restarted.chatService.execute({ method: 'chat.status', params: { id: chatSession.id } });
    assert.equal(chatStatus.taskId, actual.task.id, 'Chat projection must retain its authoritative Task ID after restart');
    assert.equal(chatStatus.dshSessionAlive, false, 'Core restart must not reuse the stale Agent Session');
    assert.equal(chatStatus.lastState, 'interrupted', 'unfinished Chat turn is marked interrupted after restart');
    await assert.rejects(restarted.chatService.execute({ method: 'chat.continue', params: { id: chatSession.id } }),
      error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    // Fixture stands in for a separate Owner Workspace review; Chat itself must not clear the block.
    const reviewed = restarted.taskService.runtime.get({ id: actual.task.id }).task;
    restarted.taskService.runtime.resume({ id: reviewed.id, expectedRev: reviewed.rev });
    const brokerPrompts = [];
    let statusCalls = 0;
    let sessionCreates = 0;
    const createManagedSession = restarted.agentBroker.createSession;
    restarted.agentBroker.status = async () => { statusCalls++; const error = new Error('Core restarted'); error.code = 'SESSION_NOT_FOUND'; throw error; };
    restarted.agentBroker.createSession = async (...args) => { sessionCreates++; return createManagedSession(...args); };
    restarted.agentBroker.send = async ({ content }) => { brokerPrompts.push(content); return { accepted: true }; };
    await restarted.chatService.execute({ method: 'chat.continue', params: { id: chatSession.id } });
    const promptDeadline = Date.now() + 1000;
    while (!brokerPrompts.length && Date.now() < promptDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    const continuation = brokerPrompts.at(-1) ?? '';
    assert.match(continuation, /Workspace analysis finished/,
      `Chat continue must send the persisted Task checkpoint to the Agent: ${JSON.stringify({ statusCalls, sessionCreates, status: await restarted.chatService.execute({ method: 'chat.status', params: { id: chatSession.id } }) })}`);
    assert.notEqual(continuation, '继续', 'a bare continue prompt is not Task recovery');
    assert.match(continuation, /Unfinished before restart/, 'a fresh Task Agent must receive bounded Chat constraints from the same Session');
    assert.equal(chatPrompts.length, 0, 'Task recovery must use the authoritative Task Agent instead of an independent DSH Chat session');
  } finally { restarted.chatService.close(); await restarted.capabilityService.close(); }
} finally {
  await services.capabilityService.close();
  fs.rmSync(root, { recursive: true, force: true });
}
