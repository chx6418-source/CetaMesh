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
  const listedAgents = await services.desktopUiService.execute({ method: 'ui.agent.list', params: {} });
  assert.equal(listedAgents.agents.find(row => row.id === 'cetamesh')?.taskEligible, true,
    'Work must show an actually Task-capable Managed Agent');
  assert.equal(listedAgents.agents.find(row => row.id === 'dsh')?.taskEligible, false,
    'Work must not offer an unconnected DSH Agent');
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Do not silently choose an executor', workspaceId: workspace.id
  } }), error => error.code === 'AGENT_PROVIDER_SELECTION_REQUIRED');
  assert.equal(services.taskService.runtime.countAll(), 0, 'missing executor must not create a Task');
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Do not silently fall back to Managed', workspaceId: workspace.id, agentProvider: 'dsh'
  } }), error => ['PROVIDER_UNAVAILABLE', 'AGENT_BOUNDARY_UNSUPPORTED'].includes(error.code));
  assert.equal(services.taskService.runtime.countAll(), 0, 'unavailable executor must not create a Task');
  const incompleteCreate = services.taskService.runtime.create({ goal: 'Incomplete Work dispatch',
    workspaceId: workspace.id, requestId: 'phase3-incomplete-create', requestedAgentProvider: 'cetamesh' });
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Incomplete Work dispatch', workspaceId: workspace.id, agentProvider: 'cetamesh',
    requestId: 'phase3-incomplete-create'
  } }), error => error.code === 'TASK_DISPATCH_INCOMPLETE',
  'same request ID must not report a queued Task as a successful Agent dispatch');
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Incomplete Work dispatch', workspaceId: workspace.id, agentProvider: 'cetamesh',
    requestId: 'phase3-different-request-for-queued-task'
  } }), error => error.code === 'TASK_DISPATCH_INCOMPLETE',
  'a distinct request must not treat the unassigned Task as successfully dispatched');
  services.taskService.runtime.cancel({ id: incompleteCreate.id, expectedRev: incompleteCreate.rev });
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
  services.agentBroker.send = async request => {
    const ownerTask = services.taskService.runtime.findByAgent({ provider: request.provider, sessionId: request.sessionId });
    assert.equal(ownerTask?.status, 'running', 'Agent execution must not start while its Task is paused');
    sent.push(request.content);
    return { accepted: true };
  };
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

  const sentBeforeConcurrentCreate = sent.length;
  const concurrentCreates = await Promise.all([1, 2].map(() => services.desktopUiService.execute({
    method: 'ui.task.create', params: { goal: 'One coordinated Work Task', workspaceId: workspace.id,
      agentProvider: 'cetamesh', requestId: 'phase3-work-create-once' }
  })));
  assert.equal(concurrentCreates[0].task.id, concurrentCreates[1].task.id);
  assert.equal(sent.length, sentBeforeConcurrentCreate + 1, 'same Work create request cannot start two Agent instructions');
  const countBeforeRequestConflict = services.taskService.runtime.countAll();
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Changed request payload', workspaceId: workspace.id, agentProvider: 'cetamesh',
    requestId: 'phase3-work-create-once'
  } }), error => error.code === 'REQUEST_ID_CONFLICT');
  assert.equal(services.taskService.runtime.countAll(), countBeforeRequestConflict,
    'request ID conflict must not leave a duplicate Task');
  await services.desktopUiService.execute({ method: 'ui.task.cancel', params: {
    id: concurrentCreates[0].task.id, expectedRev: services.taskService.runtime.get({ id: concurrentCreates[0].task.id }).task.rev
  } });

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
  let modelCycles = 0;
  services.modelRegistry.register({ id: 'phase3-fixture', label: 'Phase 3 Fixture', defaultModel: 'fixture-model',
    supportsTools: true, listModels: async () => [{ id: 'fixture-model' }], health: async () => ({}),
    chat: async () => ({ text: 'Workspace analysis finished' }),
    stream: async function* () {
      if (modelCycles++ === 0) {
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'phase3-read',
          capabilityId: 'filesystem.read', arguments: '{"path":"proof.txt"}' }] } };
      } else {
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Workspace analysis finished' } } };
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  services.providerSecrets.set({ provider: 'phase3-fixture', apiKey: 'fixture-secret-key' });
  const actual = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Analyze the Workspace', workspaceId: workspace.id, agentProvider: 'cetamesh', modelProvider: 'phase3-fixture'
  } });
  const directRetry = services.taskService.runtime.create({ goal: 'Analyze the Workspace', workspaceId: workspace.id });
  assert.equal(directRetry.id, actual.task.id, 'Task Core must deduplicate a simultaneous create from another surface');
  assert.throws(() => services.taskService.runtime.create({ goal: 'Analyze the Workspace', workspaceId: workspace.id,
    requirements: ['Different authorized scope'] }), error => error.code === 'TASK_REQUIREMENTS_CONFLICT',
  'Task Core must reject a same-goal create that changes requirements');
  const duplicate = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: '  Analyze   the Workspace  ', workspaceId: workspace.id, agentProvider: 'cetamesh'
  } });
  assert.equal(duplicate.task.id, actual.task.id, 'Work must attach the existing Chat/Work Task for the same Workspace goal');
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Analyze the Workspace', workspaceId: workspace.id, requirements: ['Different authorized scope']
  } }), error => error.code === 'TASK_REQUIREMENTS_CONFLICT',
  'Harbor cannot silently discard new requirements when reusing an active Task');
  const taskCountBeforeConflict = services.taskService.runtime.countAll();
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Different concurrent Workspace task', workspaceId: workspace.id, agentProvider: 'cetamesh'
  } }), error => error.code === 'TASK_WORKSPACE_BUSY');
  assert.equal(services.taskService.runtime.countAll(), taskCountBeforeConflict,
    'Workspace conflict must not leave a queued Task that was never dispatched');
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
  assert.ok(observed.completedWork.some(item => /filesystem\.read/.test(item.text)),
    'actual completed Agent tool activity must update the Task work record');
  assert.ok(observed.executionEvidence?.some(item => item.capability === 'filesystem.read'
    && item.status === 'completed' && item.taskRev <= observed.rev),
  'actual Agent tool results must be linked to a persisted Task revision');
  const assignment = observed.currentAgent;
  fs.writeFileSync(path.join(workspaceRoot, 'generated.md'), 'Agent artifact fixture');
  const artifactOutcome = services.taskService.runtime.recordToolOutcome({ id: actual.task.id,
    ...assignment, eventId: 'phase3-file-result', capability: 'filesystem.write', status: 'completed',
    filePath: 'generated.md' });
  assert.ok(artifactOutcome.task.artifacts.some(item => item.ref === 'generated.md'
    && item.sourceEventId === 'phase3-file-result'));
  const repeatOutcome = services.taskService.runtime.recordToolOutcome({ id: actual.task.id,
    ...assignment, eventId: 'phase3-file-result', capability: 'filesystem.write', status: 'completed',
    filePath: 'generated.md' });
  assert.equal(repeatOutcome.changed, false, 'replayed tool result cannot duplicate an Artifact');
  const testOutcome = services.taskService.runtime.recordToolOutcome({ id: actual.task.id,
    ...assignment, eventId: 'phase3-test-result', capability: 'test.run', status: 'completed',
    tool: 'npm', exitCode: 1 });
  assert.ok(testOutcome.task.executionEvidence.some(item => item.capability === 'test.run'
    && item.tool === 'npm' && item.exitCode === 1 && item.taskRev === testOutcome.task.rev),
  'a completed test invocation with a nonzero exit code must retain the real result, not become a false PASS');
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
    assert.equal(restarted.taskService.runtime.findByCreateRequestId({ requestId: 'phase3-work-create-once',
      goal: 'One coordinated Work Task', workspaceId: workspace.id, requestedAgentProvider: 'cetamesh' })?.id,
    concurrentCreates[0].task.id, 'Task creation request IDs must remain idempotent after Core restart');
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
  const riskStateDir = path.join(root, 'risk-state');
  const riskServices = createCetaMeshServices({ stateDir: riskStateDir, dataRoot: path.join(root, 'risk-data') });
  const { workspace: riskWorkspace } = await riskServices.workspaceService.execute({ method: 'workspace.create',
    params: { name: 'Uncertain tool Workspace', root: workspaceRoot } });
  const riskTask = riskServices.taskService.runtime.create({ goal: 'Continue only after effect review', workspaceId: riskWorkspace.id });
  const attachedRisk = riskServices.taskService.runtime.attachAgent({ id: riskTask.id, expectedRev: riskTask.rev,
    provider: 'cetamesh', sessionId: 'uncertain-agent-session' }).task;
  riskServices.taskService.runtime.start({ id: riskTask.id, expectedRev: attachedRisk.rev });
  const riskChat = await riskServices.chatService.execute({ method: 'chat.sessions.create', params: {} });
  const riskChatFile = path.join(riskStateDir, 'desktop-chat', 'sessions.json');
  const riskChatStore = readJsonFile(riskChatFile);
  riskChatStore.sessions.find(row => row.id === riskChat.id).taskId = riskTask.id;
  riskChatStore.sessions.find(row => row.id === riskChat.id).config.workspaceId = riskWorkspace.id;
  writeJsonAtomic(riskChatFile, riskChatStore);
  writeJsonAtomic(path.join(riskStateDir, 'desktop-chat', 'history', `${riskChat.id}.json`), {
    schemaVersion: 1, messages: [{ id: 'uncertain-user', role: 'user', text: 'Write a report', at: Date.now() }]
  });
  writeJsonAtomic(path.join(riskStateDir, 'model', 'tool-executions.json'), {
    'model:uncertain:turn:0:0': { status: 'started', sessionId: riskChat.id, turnId: 'turn',
      taskId: riskTask.id, capability: 'filesystem.write', at: Date.now() }
  });
  writeJsonAtomic(path.join(riskStateDir, 'capability', 'requests.json'), {
    'uncertain-agent-request': { hash: 'durable-original-fingerprint', status: 'in-flight', taskId: riskTask.id }
  });
  const orphanedApproval = riskServices.capabilityService.broker.approvals.pending({
    requestId: 'old-write-approval', taskId: riskTask.id, workspaceId: riskWorkspace.id,
    actor: { kind: 'agent', id: 'uncertain-agent-session' }, capability: 'filesystem.write',
    input: { path: 'old-report.txt', content: 'Do not replay this write' }
  });
  const approvedBeforeCrash = riskServices.capabilityService.broker.approvals.pending({
    requestId: 'old-approved-write', taskId: riskTask.id, workspaceId: riskWorkspace.id,
    actor: { kind: 'agent', id: 'uncertain-agent-session' }, capability: 'filesystem.write',
    input: { path: 'approved-report.txt', content: 'Still must not replay' }
  });
  riskServices.capabilityService.broker.approvals.decide(approvedBeforeCrash.id, true, OWNER_ACTOR);
  const expiredChatApproval = riskServices.capabilityService.broker.approvals.pending({
    requestId: 'expired-chat-write', taskId: riskTask.id, workspaceId: riskWorkspace.id,
    actor: { kind: 'agent', id: 'uncertain-agent-session' }, capability: 'filesystem.write',
    input: { path: 'expired-report.txt', content: 'Never replay after expiry' }
  });
  const approvalsFile = path.join(riskStateDir, 'capability', 'approvals.json');
  const approvals = readJsonFile(approvalsFile);
  approvals.find(row => row.id === expiredChatApproval.id).expiresAt = Date.now() - 1;
  writeJsonAtomic(approvalsFile, approvals);
  writeJsonAtomic(path.join(riskStateDir, 'model', 'tool-continuations.json'), {
    [orphanedApproval.id]: { approvalId: orphanedApproval.id, targetKind: 'agent',
      target: { sessionId: 'uncertain-agent-session', turnId: 'approval-turn' },
      state: { scope: { taskId: riskTask.id } } },
    [approvedBeforeCrash.id]: { approvalId: approvedBeforeCrash.id, targetKind: 'agent',
      target: { sessionId: 'uncertain-agent-session', turnId: 'approved-turn' },
      state: { scope: { taskId: riskTask.id } } },
    [expiredChatApproval.id]: { approvalId: expiredChatApproval.id, targetKind: 'chat',
      target: { sessionId: riskChat.id, turnId: 'expired-turn' },
      state: { scope: { taskId: riskTask.id } } }
  });
  riskServices.chatService.close();
  await riskServices.capabilityService.close();
  const riskRestart = createCetaMeshServices({ stateDir: riskStateDir, dataRoot: path.join(root, 'risk-data') });
  try {
    assert.equal(riskRestart.capabilityService.broker.approvals.get(orphanedApproval.id).status, 'revoked',
      'a pre-restart Managed Agent approval cannot execute after its process-local turn was lost');
    assert.equal(riskRestart.capabilityService.broker.approvals.get(approvedBeforeCrash.id).status, 'revoked',
      'even an approved but unconsumed effect must be revoked when its Agent turn is lost');
    assert.equal(riskRestart.capabilityService.broker.approvals.get(expiredChatApproval.id).status, 'revoked',
      'an expired Chat approval cannot remain resumable after restart');
    assert.throws(() => riskRestart.capabilityService.broker.approvals.decide(
      orphanedApproval.id, true, { kind: 'owner', id: 'owner' }
    ), error => error.code === 'APPROVAL_ALREADY_DECIDED',
    'the orphaned approval must not permit an old effect');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'old-report.txt')), false);
    const riskRecovered = riskRestart.taskService.runtime.get({ id: riskTask.id }).task;
    assert.equal(riskRecovered.status, 'blocked');
    assert.match(riskRecovered.progress.note, /needs-reconciliation/);
    const riskHarbor = await riskRestart.desktopUiService.execute({ method: 'ui.task.get', params: { id: riskTask.id } });
    assert.match(riskHarbor.task.progress.note, /needs-reconciliation/);
    await assert.rejects(riskRestart.desktopUiService.execute({ method: 'ui.task.resume',
      params: { id: riskTask.id, expectedRev: riskRecovered.rev } }), error => error.code === 'NEEDS_RECONCILIATION');
    const riskStatus = await riskRestart.desktopUiService.execute({ method: 'ui.chat.status', params: { id: riskChat.id } });
    assert.equal(riskStatus.state, 'needs-reconciliation');
    await assert.rejects(riskRestart.chatService.execute({ method: 'chat.continue', params: { id: riskChat.id } }),
      error => error.code === 'NEEDS_RECONCILIATION');
    await assert.rejects(riskRestart.desktopUiService.execute({ method: 'ui.task.reconcile', params: {
      id: riskTask.id, expectedRev: riskRecovered.rev, reviewed: true, reviewSummary: 'Checked the Workspace'
    } }), error => error.code === 'INVALID_PARAMS', 'manual reconciliation requires a new explicit instruction');
    const sentAfterReview = [];
    riskRestart.agentBroker.status = async () => { const error = new Error('Old session ended'); error.code = 'SESSION_NOT_FOUND'; throw error; };
    riskRestart.agentBroker.send = async ({ content }) => { sentAfterReview.push(content); return { accepted: true }; };
    const reconciled = await riskRestart.desktopUiService.execute({ method: 'ui.task.reconcile', params: {
      id: riskTask.id, expectedRev: riskRecovered.rev, reviewed: true,
      reviewSummary: 'Checked Workspace files and confirmed the prior write outcome',
      nextInstruction: 'Only inspect the existing report; do not repeat the prior write',
      requestId: 'phase3-reconcile-new-instruction'
    } });
    assert.equal(reconciled.task.status, 'running');
    assert.deepEqual(sentAfterReview, ['Only inspect the existing report; do not repeat the prior write']);
    assert.match(reconciled.task.progress.note, /Owner reviewed interrupted effect/);
    assert.equal(readJsonFile(path.join(riskStateDir, 'capability', 'requests.json'))['uncertain-agent-request'].status,
      'reconciled', 'Owner review must durably clear the uncertain Agent dispatch marker');
    assert.equal(readJsonFile(path.join(riskStateDir, 'model', 'tool-continuations.json'))[orphanedApproval.id].status,
      'reconciled', 'Owner review must durably clear the orphaned approval continuation');
    assert.equal(readJsonFile(path.join(riskStateDir, 'model', 'tool-continuations.json'))[approvedBeforeCrash.id].status,
      'reconciled');
    assert.equal(readJsonFile(path.join(riskStateDir, 'model', 'tool-continuations.json'))[expiredChatApproval.id].status,
      'reconciled');
    assert.notEqual((await riskRestart.desktopUiService.execute({ method: 'ui.chat.status',
      params: { id: riskChat.id } })).state, 'needs-reconciliation',
    'Owner reconciliation must clear the old uncertain tool marker without replaying it');
    await assert.rejects(riskRestart.chatService.execute({ method: 'chat.continue', params: { id: riskChat.id } }),
      error => error.code === 'RECOVERY_USE_NEW_INSTRUCTION',
    'the interrupted Chat turn cannot replay after the Owner supplied a new reviewed instruction');
  } finally { riskRestart.chatService.close(); await riskRestart.capabilityService.close(); }
  const riskAfterReviewRestart = createCetaMeshServices({ stateDir: riskStateDir,
    dataRoot: path.join(root, 'risk-data') });
  try {
    assert.doesNotMatch(riskAfterReviewRestart.taskService.runtime.get({ id: riskTask.id }).task.progress.note,
      /needs-reconciliation/, 'an already reconciled effect must not reappear as uncertain after another restart');
  } finally { riskAfterReviewRestart.chatService.close(); await riskAfterReviewRestart.capabilityService.close(); }

  const nonGitState = path.join(root, 'non-git-state');
  const nonGitData = path.join(root, 'non-git-data');
  const nonGitBefore = createCetaMeshServices({ stateDir: nonGitState, dataRoot: nonGitData });
  const nonGitRoot = path.join(root, 'non-git-workspace');
  fs.mkdirSync(nonGitRoot);
  fs.writeFileSync(path.join(nonGitRoot, 'report.txt'), 'Existing result must not be replayed');
  const { workspace: nonGitWorkspace } = await nonGitBefore.workspaceService.execute({ method: 'workspace.create',
    params: { name: 'Non Git recovery', root: nonGitRoot } });
  let nonGitTask = nonGitBefore.taskService.runtime.create({ goal: 'Continue a non Git project', workspaceId: nonGitWorkspace.id });
  nonGitTask = nonGitBefore.taskService.runtime.attachAgent({ id: nonGitTask.id, expectedRev: nonGitTask.rev,
    provider: 'cetamesh', sessionId: 'stale-managed-session' }).task;
  nonGitTask = nonGitBefore.taskService.runtime.start({ id: nonGitTask.id, expectedRev: nonGitTask.rev }).task;
  nonGitBefore.chatService.close();
  await nonGitBefore.capabilityService.close();
  const nonGitRestart = createCetaMeshServices({ stateDir: nonGitState, dataRoot: nonGitData });
  try {
    const interrupted = nonGitRestart.taskService.runtime.get({ id: nonGitTask.id }).task;
    assert.equal(interrupted.status, 'blocked');
    await assert.rejects(nonGitRestart.desktopUiService.execute({ method: 'ui.task.resume',
      params: { id: interrupted.id, expectedRev: interrupted.rev } }),
    error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED',
    'non Git restart must require Owner review instead of retrying unknown effects');
    const reviewed = await nonGitRestart.desktopUiService.execute({ method: 'ui.task.reconcile', params: {
      id: interrupted.id, expectedRev: interrupted.rev, reviewed: true,
      reviewSummary: 'Checked report.txt and confirmed the prior operation is complete',
      nextInstruction: 'Read report.txt only; do not repeat the prior write',
      requestId: 'non-git-reviewed-new-instruction'
    } });
    assert.equal(reviewed.task.status, 'running', 'Owner-reviewed non Git Task can continue with a new instruction');
    assert.match(fs.readFileSync(path.join(nonGitRoot, 'report.txt'), 'utf8'), /Existing result/);
    const latestBeforePause = nonGitRestart.taskService.runtime.get({ id: interrupted.id }).task;
    const pausedAgain = await nonGitRestart.desktopUiService.execute({ method: 'ui.task.pause',
      params: { id: interrupted.id, expectedRev: latestBeforePause.rev } });
    const originalNonGitSend = nonGitRestart.agentBroker.send;
    nonGitRestart.agentBroker.send = async () => {
      throw Object.assign(new Error('fixture send failed after Task resume'), { code: 'PROVIDER_ERROR' });
    };
    try {
      await assert.rejects(nonGitRestart.desktopUiService.execute({ method: 'ui.task.resume',
        params: { id: interrupted.id, expectedRev: pausedAgain.task.rev } }),
      error => error.code === 'PROVIDER_ERROR');
    } finally { nonGitRestart.agentBroker.send = originalNonGitSend; }
    const failedResume = nonGitRestart.taskService.runtime.get({ id: interrupted.id }).task;
    assert.equal(failedResume.status, 'blocked', 'failed Resume cannot leave a false running Task');
    assert.match(failedResume.progress.note, /needs-reconciliation/);

    const raceRoot = path.join(root, 'pause-dispatch-workspace');
    fs.mkdirSync(raceRoot);
    const { workspace: raceWorkspace } = await nonGitRestart.workspaceService.execute({ method: 'workspace.create',
      params: { name: 'Pause dispatch race', root: raceRoot } });
    let releaseDispatch;
    const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
    let signalDispatch;
    const dispatchEntered = new Promise(resolve => { signalDispatch = resolve; });
    nonGitRestart.agentBroker.send = async () => {
      signalDispatch();
      await dispatchGate;
      return { accepted: true, requestId: 'late-accepted-provider-turn' };
    };
    const racingCreate = nonGitRestart.desktopUiService.execute({ method: 'ui.task.create', params: {
      goal: 'Pause during Agent send', workspaceId: raceWorkspace.id, agentProvider: 'cetamesh'
    } });
    await dispatchEntered;
    const racingTask = nonGitRestart.taskService.runtime.findByGoalWorkspace({
      goal: 'Pause during Agent send', workspaceId: raceWorkspace.id });
    assert.equal(racingTask.status, 'running');
    await nonGitRestart.desktopUiService.execute({ method: 'ui.task.pause', params: {
      id: racingTask.id, expectedRev: racingTask.rev
    } });
    releaseDispatch();
    await assert.rejects(racingCreate, error => error.code === 'TASK_NOT_RUNNING',
      'a late Agent ACK cannot revive a Task paused during dispatch');
    assert.equal(nonGitRestart.taskService.runtime.get({ id: racingTask.id }).task.status, 'paused');

    const cancelRoot = path.join(root, 'cancel-dispatch-workspace');
    fs.mkdirSync(cancelRoot);
    const { workspace: cancelWorkspace } = await nonGitRestart.workspaceService.execute({ method: 'workspace.create',
      params: { name: 'Cancel dispatch race', root: cancelRoot } });
    let releaseCancel;
    const cancelGate = new Promise(resolve => { releaseCancel = resolve; });
    let signalCancel;
    const cancelEntered = new Promise(resolve => { signalCancel = resolve; });
    nonGitRestart.agentBroker.send = async () => {
      signalCancel();
      await cancelGate;
      return { accepted: true, requestId: 'cancelled-late-provider-turn' };
    };
    const cancellingCreate = nonGitRestart.desktopUiService.execute({ method: 'ui.task.create', params: {
      goal: 'Cancel during Agent send', workspaceId: cancelWorkspace.id, agentProvider: 'cetamesh'
    } });
    await cancelEntered;
    const cancellingTask = nonGitRestart.taskService.runtime.findByGoalWorkspace({
      goal: 'Cancel during Agent send', workspaceId: cancelWorkspace.id });
    await nonGitRestart.desktopUiService.execute({ method: 'ui.task.cancel', params: {
      id: cancellingTask.id, expectedRev: cancellingTask.rev
    } });
    releaseCancel();
    await assert.rejects(cancellingCreate, error => error.code === 'TASK_NOT_RUNNING',
      'a late Agent ACK cannot revive a cancelled Task');
    assert.equal(nonGitRestart.taskService.runtime.get({ id: cancellingTask.id }).task.status, 'cancelled');
  } finally { nonGitRestart.chatService.close(); await nonGitRestart.capabilityService.close(); }
} finally {
  await services.capabilityService.close();
  fs.rmSync(root, { recursive: true, force: true });
}
