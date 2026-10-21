// Real Workshop -> Capability -> Workspace -> Task -> Managed Agent -> Continuity.
// Only Model inference is a deterministic fixture; no DSH/native tool execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../src/workspace/index.js';
import { createTaskRuntime } from '../src/task/index.js';
import { createCapabilityService } from '../src/capability/index.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';
import { createContinuityService } from '../src/continuity/index.js';
import { createWorkshopService } from '../src/workshop/index.js';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-platform-'));
let managed, agentBroker;
let assertions = 0;
const check = (a, b) => { assert.deepEqual(a, b); assertions++; };
const rejected = async (fn, code) => { await assert.rejects(fn, (e) => e.code === code); assertions++; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const stateDir = path.join(fixture, 'state');
  const projectRoot = path.join(fixture, 'export-project');
  const workspaceService = createWorkspaceService({ stateDir });
  const taskRuntime = createTaskRuntime({ stateDir });
  let capabilities;
  const toolRequests = [], modelRequests = [], observations = [];
  let inference = 0;
  managed = createManagedAgentProvider({
    modelRuntime: { async chat(request) {
      modelRequests.push(structuredClone({ ...request, signal: undefined }));
      const command = [
        { capability: 'filesystem.write', input: { path: 'export.csv', content: 'name,value\na,1' } },
        { final: 'Export written' },
        { capability: 'filesystem.read', input: { path: 'export.csv' } },
        { final: 'Fresh session verified existing export' }
      ][inference] ?? { final: 'Done' };
      const pressure = inference++ < 2;
      return { text: JSON.stringify(command), usage: { inputTokens: pressure ? 44 : 2, outputTokens: 1, windowTokens: 100 } };
    } },
    capabilityExecutor: (request) => { toolRequests.push(structuredClone(request)); return capabilities.broker.execute(request); },
    taskPrincipalResolver: ({ provider, sessionId }) => {
      const task = taskRuntime.findByAgent({ provider, sessionId });
      return task ? { taskId: task.id, workspaceId: task.workspaceId, actor: capabilities.principalForTask(task.id) } : null;
    },
    onTurnEnd: async (payload) => { observations.push(payload); await agentBroker.reportTurnEnd(payload); }
  });
  agentBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [managed.provider] }) });
  capabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime, agentBroker, bindAgentSession: managed.bindSession,
    resumeAgentApproval: managed.resumeLegacyApproval });
  const continuity = createContinuityService({ stateDir, taskRuntime, agentBroker,
    canRollover: ({ taskId }) => taskRuntime.get({ id: taskId }).task.status === 'running' });
  agentBroker.onTurnEnd((payload) => continuity.runtime.observeAgentTurn(payload));
  let workshop = createWorkshopService({ stateDir, workspaceService, taskRuntime, capabilityBroker: capabilities.broker });
  const external = { kind: 'external', id: 'qq:alice' }, other = { kind: 'external', id: 'qq:bob' };
  const run = (method, params = {}, actor = external) => workshop.execute({ method, params, actor });
  const proposal = (await run('workshop.proposal.submit', { title: 'CSV export', description: 'Create approved CSV export', requirements: ['name,value columns'] })).proposal;
  check(proposal.status, 'submitted');
  check(taskRuntime.list().total, 0);
  await rejected(() => run('workshop.proposal.get', { id: proposal.id }, other), 'WORKSHOP_FORBIDDEN');
  await rejected(() => run('workshop.proposal.review', { id: proposal.id, approve: true, actor: { kind: 'owner', id: 'forged' } }), 'WORKSHOP_FORBIDDEN');
  const approved = (await workshop.executeOwner({ method: 'workshop.proposal.review', params: { id: proposal.id, approve: true, plan: {
    workspace: { name: 'CSV export', root: projectRoot, createIfMissing: true }, provider: 'cetamesh', capabilities: ['filesystem.read', 'filesystem.write', 'git.status', 'git.diff', 'git.commit']
  } } })).proposal;
  check(approved.status, 'active');
  check(approved.assignment.actor.id, 'task:' + approved.taskId);
  const initialSession = approved.assignment.sessionId;
  let pendingWrite = null;
  for (let i = 0; i < 400 && !pendingWrite; i++) {
    pendingWrite = capabilities.broker.approvals.list().find(row => row.request?.capability === 'filesystem.write');
    if (!pendingWrite) await delay(5);
  }
  assert.ok(pendingWrite, 'Agent Workspace write must wait for Owner approval'); assertions++;
  check(fs.existsSync(path.join(projectRoot, 'export.csv')), false);
  check((await capabilities.execute({ method: 'capability.approval.decide', params: { id: pendingWrite.id, approve: true } })).status, 'completed');
  for (let i = 0; i < 400 && (continuity.runtime.history({ taskId: approved.taskId }).total !== 1
    || observations.length < 2 || toolRequests.length < 2 || modelRequests.length < 4); i++) await delay(5);
  check(continuity.runtime.history({ taskId: approved.taskId }).total, 1);
  assert.ok(observations.length >= 2, 'Agent turn-end observation follows the approved write'); assertions++;
  let task = taskRuntime.get({ id: approved.taskId }).task;
  check(task.id, approved.taskId);
  check(task.workspaceId, approved.workspaceId);
  check(task.currentAgent.provider, 'cetamesh');
  assert.notEqual(task.currentAgent.sessionId, initialSession); assertions++;
  check(task.agentHistory.length, 2);
  check(fs.readFileSync(path.join(projectRoot, 'export.csv'), 'utf8'), 'name,value\na,1');
  check(toolRequests.length, 2);
  check(toolRequests[0].actor, toolRequests[1].actor);
  check(toolRequests[0].workspaceId, toolRequests[1].workspaceId);
  check(toolRequests[0].taskId, toolRequests[1].taskId);
  check(toolRequests[1].actor.grants.workspaceIds, [approved.workspaceId]);
  check(toolRequests[1].actor.grants.taskIds, [approved.taskId]);
  check(modelRequests[1].messages.at(-1).role, 'user');
  check(modelRequests[3].messages.at(-1).role, 'user');
  check((await agentBroker.status({ provider: 'cetamesh', sessionId: initialSession })).archived, true);
  await rejected(() => capabilities.broker.execute({ actor: external, workspaceId: task.workspaceId, capability: 'filesystem.read', input: { path: 'export.csv' } }), 'PERMISSION_DENIED');
  const agent = capabilities.principalForTask(task.id);
  await rejected(() => capabilities.broker.execute({ actor: agent, taskId: task.id, workspaceId: task.workspaceId, capability: 'filesystem.read', input: { path: '../outside.txt' } }), 'PATH_OUTSIDE_WORKSPACE');
  const secondWorkspace = (await workspaceService.execute({ method: 'workspace.create', params: { name: 'Other project', root: path.join(fixture, 'other-project'), createIfMissing: true } })).workspace;
  await rejected(() => capabilities.broker.execute({ actor: agent, taskId: task.id, workspaceId: secondWorkspace.id, capability: 'filesystem.read', input: { path: 'secret.txt' } }), 'WORKSPACE_RECONCILIATION_REQUIRED');
  await rejected(() => capabilities.broker.execute({ actor: agent, taskId: task.id, workspaceId: task.workspaceId, capability: 'memory.read', input: {} }), 'UNKNOWN_CAPABILITY');
  // Restart creates a new provider with no in-memory sessions, preserving disk state.
  const preRestartSession = task.currentAgent.sessionId;
  const persistedGrant = capabilities.principalForTask(task.id);
  const priorTasks = taskRuntime.list().total;
  const priorWorkspaces = (await workspaceService.execute({ method: 'workspace.list' })).workspaces.length;
  await managed.close();
  agentBroker.close();
  let requestReview = false, approvedActions = 0;
  let reviewAwaitingOwnerDecision = false;
  const restartObservations = [];
  const approvalResumePromptEvidence = [];
  managed = createManagedAgentProvider({
    modelRuntime: { async chat(request) {
      const hasOwnerDecision = request.messages.some(message => message.role === 'user'
        && typeof message.content === 'string' && message.content.includes('[Owner capability decision reference data]'));
      let command;
      if (requestReview && !reviewAwaitingOwnerDecision) {
        reviewAwaitingOwnerDecision = true;
        command = { capability: 'fixture.review', input: { note: 'Owner must decide' } };
      } else {
        if (reviewAwaitingOwnerDecision) approvalResumePromptEvidence.push(hasOwnerDecision);
        reviewAwaitingOwnerDecision = false;
        command = { final: 'Same Task continues after restart or Owner decision' };
      }
      return { text: JSON.stringify(command), usage: { inputTokens: 2, outputTokens: 1 } };
    } },
    capabilityExecutor: (request) => capabilities.broker.execute(request),
    taskPrincipalResolver: ({ provider, sessionId }) => {
      const bound = taskRuntime.findByAgent({ provider, sessionId });
      return bound ? { taskId: bound.id, workspaceId: bound.workspaceId, actor: capabilities.principalForTask(bound.id) } : null;
    },
    onTurnEnd: (payload) => { restartObservations.push(payload); return agentBroker.reportTurnEnd(payload); }
  });
  agentBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [managed.provider] }) });
  capabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime, agentBroker, bindAgentSession: managed.bindSession,
    resumeAgentApproval: managed.resumeLegacyApproval });
  workshop = createWorkshopService({ stateDir, workspaceService, taskRuntime, capabilityBroker: capabilities.broker });
  const recovered = (await workshop.executeOwner({ method: 'workshop.proposal.retry', params: { id: proposal.id } })).proposal;
  check(recovered.status, 'active');
  check(recovered.taskId, approved.taskId);
  check(recovered.workspaceId, approved.workspaceId);
  assert.notEqual(recovered.assignment.sessionId, preRestartSession); assertions++;
  check(recovered.assignment.actor, persistedGrant);
  check(taskRuntime.list().total, priorTasks);
  check((await workspaceService.execute({ method: 'workspace.list' })).workspaces.length, priorWorkspaces);
  for (let i = 0; i < 400 && restartObservations.length < 1; i++) await delay(5);
  check(restartObservations.length, 1);
  task = taskRuntime.get({ id: approved.taskId }).task;
  check(task.agentHistory.length, 3);
  check(task.currentAgent.sessionId, recovered.assignment.sessionId);
  const resumedSession = task.currentAgent.sessionId;
  const rerun = (await workshop.executeOwner({ method: 'workshop.proposal.retry', params: { id: proposal.id } })).proposal;
  check(rerun.assignment.sessionId, resumedSession);
  check(taskRuntime.get({ id: task.id }).task.agentHistory.length, 3);
  await delay(20);
  check(restartObservations.length, 1);
  check((await agentBroker.status({ provider: 'cetamesh', sessionId: resumedSession })).running, false);

  // The real approval engine executes a harmless injected high-risk operation.
  capabilities.broker.register({ id: 'fixture.review', permission: 'git.commit', workspace: true, risk: 'high',
    execute: () => ({ executed: ++approvedActions }) });
  capabilities.grantTask(task.id, { workspaceIds: [task.workspaceId], capabilities: [...persistedGrant.grants.capabilities, 'fixture.review'] });
  requestReview = true;
  for (const approve of [false, true]) {
    const observedBeforeRequest = restartObservations.length;
    await agentBroker.send({ provider: 'cetamesh', sessionId: resumedSession, content: 'Request Owner review ' + approve });
    for (let i = 0; i < 400 && restartObservations.length <= observedBeforeRequest; i++) await delay(5);
    check(restartObservations.length, observedBeforeRequest + 1);
    const waiting = await agentBroker.status({ provider: 'cetamesh', sessionId: resumedSession });
    assert.ok(waiting.waitingForApproval); assertions++;
    check(waiting.lastReason.kind, 'waiting');
    const decision = await capabilities.execute({ method: 'capability.approval.decide', params: { id: waiting.waitingForApproval, approve } });
    check(decision.status, approve ? 'completed' : 'rejected');
    check(decision.taskResumed, true);
    for (let i = 0; i < 400 && restartObservations.length <= observedBeforeRequest + 1; i++) await delay(5);
    check(restartObservations.length, observedBeforeRequest + 2);
    let continued;
    for (let i = 0; i < 400; i++) {
      continued = await agentBroker.status({ provider: 'cetamesh', sessionId: resumedSession });
      if (!continued.waitingForApproval && continued.lastReason?.kind === 'completed') break;
      await delay(5);
    }
    check(continued.waitingForApproval, null);
    check(continued.lastReason.kind, 'completed');
    check(approvalResumePromptEvidence.length, approve ? 2 : 1);
    check(approvalResumePromptEvidence.at(-1), true);
    check(taskRuntime.get({ id: task.id }).task.currentAgent?.sessionId ?? null, resumedSession);
    check(approvedActions, approve ? 1 : 0);
  }
  task = taskRuntime.get({ id: approved.taskId }).task;
  const visible = (await run('workshop.task.status', { id: proposal.id })).task;
  check(visible.status, 'running');
  check(JSON.stringify(visible).includes(projectRoot), false);
  check(Object.hasOwn(visible, 'currentAgent'), false);
  taskRuntime.complete({ id: task.id, expectedRev: task.rev, summary: 'Internal completed CSV; owner can deliver' });
  const completedHistory = taskRuntime.get({ id: task.id }).task.agentHistory.length;
  const completedRetry = (await workshop.executeOwner({ method: 'workshop.proposal.retry', params: { id: proposal.id } })).proposal;
  check(completedRetry.taskId, task.id);
  check(taskRuntime.get({ id: task.id }).task.currentAgent, null);
  check(taskRuntime.get({ id: task.id }).task.agentHistory.length, completedHistory);
  await workshop.executeOwner({ method: 'workshop.artifact.deliver', params: { id: proposal.id, approve: true, label: 'export.csv', mediaType: 'text/csv', content: fs.readFileSync(path.join(projectRoot, 'export.csv'), 'utf8') } });
  workshop = createWorkshopService({ stateDir, workspaceService, taskRuntime, capabilityBroker: capabilities.broker });
  const delivered = (await run('workshop.proposal.get', { id: proposal.id })).proposal;
  check(delivered.status, 'delivered');
  check(delivered.artifacts[0].content, 'name,value\na,1');
  check(Object.hasOwn(delivered, 'workspaceId'), false);
  const terminalSession = taskRuntime.get({ id: task.id }).task.currentAgent?.sessionId ?? null;
  const terminalHistory = taskRuntime.get({ id: task.id }).task.agentHistory.length;
  const deliveredRetry = (await workshop.executeOwner({ method: 'workshop.proposal.retry', params: { id: proposal.id } })).proposal;
  check(deliveredRetry.status, 'delivered');
  check(taskRuntime.get({ id: task.id }).task.currentAgent?.sessionId ?? null, terminalSession);
  check(taskRuntime.get({ id: task.id }).task.agentHistory.length, terminalHistory);
  await rejected(() => run('workshop.proposal.get', { id: proposal.id }, other), 'WORKSHOP_FORBIDDEN');
  console.log('Desktop platform integration: ' + assertions + ' assertions passed');
} finally {
  await managed?.close();
  agentBroker?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
