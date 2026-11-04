import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import * as workshopModule from '../src/workshop/index.js';

assert.equal(typeof workshopModule.workshopQqIngress, 'function', 'Workshop QQ ingress must bind a private transport actor');
assert.deepEqual(workshopModule.workshopQqIngress({ kind: 'group', id: 100, senderId: 7 }), { accepted: false, code: 'PRIVATE_REQUIRED' });
assert.deepEqual(workshopModule.workshopQqIngress({ kind: 'private', id: 7, senderId: 8 }), { accepted: false, code: 'ACTOR_MISMATCH' });
assert.deepEqual(workshopModule.workshopQqIngress({ kind: 'private', id: 7, senderId: 7 }),
  { accepted: true, actor: { kind: 'external', id: 'qq:7' } });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-workshop-flow-'));
const dataRoot = path.join(root, 'data');
const stateDir = path.join(dataRoot, 'state');
const workspaceRoot = path.join(root, 'approved-workspace');
const alice = { kind: 'external', id: 'qq:alice' };
const bob = { kind: 'external', id: 'qq:bob' };
const services = createCetaMeshServices({ stateDir, dataRoot, sourceRoot: root, resourceRoot: root,
  config: { allow: { private: [], groups: [] } } });
let sessions = 0;
let failSend = true;
let closes = 0;
let stopReceiptAvailable = false;
let toolsAvailable = true;
const sessionRecords = new Map();
const instructions = [];
services.agentBroker.register({ ...defineAgentProvider({ id: 'workshop-fixture', label: 'Workshop fixture',
  capabilityExtras: { workspaceBoundary: 'capability-broker' }, methods: {
    async health() { return { available: true, installed: true, authenticated: true,
      sessionCapable: true, compatible: true, toolsAvailable }; },
    async createSession({ taskId, workspaceId }) {
      const sessionId = `fixture-${++sessions}`;
      sessionRecords.set(sessionId, { taskId, workspaceId, closed: false });
      return { sessionId };
    },
    async send({ sessionId, content }) {
      instructions.push({ sessionId, content });
      if (failSend) {
        fs.writeFileSync(path.join(workspaceRoot, 'partial.csv'), 'a,b\n');
        throw Object.assign(new Error('Fixture transport failed after partial output'), { code: 'PROVIDER_ERROR' });
      }
      return { accepted: true };
    },
    async closeSession({ sessionId }) { closes++; sessionRecords.get(sessionId).closed = true; return { closed: true }; },
    async status({ sessionId }) { return { running: sessionRecords.get(sessionId)?.closed !== true }; },
    async *follow({ signal }) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
  } }),
  // Controlled in-process fixture proof, never native/model acceptance evidence.
  async verifyStoppedTask(scope) {
    const session = sessionRecords.get(scope.sessionId);
    return { ...scope, provider: 'workshop-fixture', evidence: 'controlled-provider-close',
      receiptId: 'fixture-close-' + scope.sessionId, stopped: stopReceiptAvailable && session?.closed === true
        && session.taskId === scope.taskId && session.workspaceId === scope.workspaceId };
  },
  async verifyTaskQuiescence({ taskId, workspaceId }) {
    const owned = [...sessionRecords.values()].filter(row => row.taskId === taskId && row.workspaceId === workspaceId);
    return { stopped: stopReceiptAvailable && owned.every(row => row.closed) };
  }
});
const workshop = services.workshopService;
const external = (method, params, actor = alice) => workshop.execute({ method, params, actor });
const ui = (method, params) => services.desktopUiService.execute({ method, params });
try {
  const proposal = (await external('workshop.proposal.submit', {
    title: 'Export table', description: 'Export approved table', requirements: ['CSV']
  })).proposal;
  assert.equal(proposal.status, 'submitted');
  const ownerInbox = await services.desktopUiService.execute({ method: 'ui.workshop.proposals', params: {} });
  assert.equal(ownerInbox.proposals[0].id, proposal.id);
  assert.equal(ownerInbox.proposals[0].description, 'Export approved table');
  assert.equal(services.taskService.runtime.list().tasks.length, 0);
  await assert.rejects(() => external('workshop.proposal.get', { id: proposal.id }, bob), { code: 'WORKSHOP_FORBIDDEN' });

  const rejected = (await external('workshop.proposal.submit', { title: 'Reject', description: 'No scope' }, bob)).proposal;
  assert.equal((await ui('ui.workshop.review', { id: rejected.id, approve: false, reason: 'No', actor: bob })).proposal.status, 'rejected');
  assert.equal(services.taskService.runtime.list().tasks.length, 0);
  assert.equal((await external('workshop.proposal.list', {}, alice)).total, 1);

  const plan = { workspace: { name: 'Export', root: workspaceRoot, createIfMissing: true },
    provider: 'workshop-fixture', capabilities: ['filesystem.read', 'filesystem.write'] };
  const first = await ui('ui.workshop.review', { id: proposal.id, approve: true, plan, actor: bob });
  assert.equal(first.proposal.status, 'provision_failed');
  assert.equal(first.proposal.errorCode, 'PROVIDER_ERROR');
  assert.equal(closes, 1, 'failed Agent session is closed during rollback');
  assert.equal(services.taskService.runtime.list().tasks.length, 1);
  const interrupted = services.taskService.runtime.get({ id: first.proposal.taskId }).task;
  assert.deepEqual(interrupted.currentAgent, { provider: 'workshop-fixture', sessionId: 'fixture-1' });
  assert.equal(interrupted.status, 'blocked', 'Workshop preserves the recoverable Task after an uncertain send');
  assert.match(interrupted.progress.note, /needs-reconciliation/);
  assert.equal(services.taskService.runtime.activeWorkspaceOwner({ workspaceId: first.proposal.workspaceId }).id, interrupted.id);
  const interruptedReview = services.capabilityService.taskReviewState({ taskId: interrupted.id, workspaceId: interrupted.workspaceId });
  assert.equal(interruptedReview.workspaceFences.length, 1);
  assert.equal(interruptedReview.workspaceFences[0].taskId, interrupted.id);
  const originalRequestId = interruptedReview.workspaceFences[0].requestId;
  const partialOutput = fs.readFileSync(path.join(workspaceRoot, 'partial.csv'));
  const beforeReceipt = await ui('ui.task.recovery.inspect', { id: interrupted.id });
  assert.equal(beforeReceipt.reviewToken, null);
  assert.equal(beforeReceipt.canResume, false);
  assert.equal(beforeReceipt.canRelease, false);
  assert.ok(beforeReceipt.blockers.some(row => row.code === 'SESSION_EXECUTION_UNCONFIRMED'));
  assert.equal(beforeReceipt.blockers.some(row => row.code === 'TASK_RECOVERY_NOT_REQUIRED'), false,
    'the proposal catch must not turn the retained Task into an unrecoverable terminal state');

  failSend = false;
  const retry = await ui('ui.workshop.retry', { id: proposal.id });
  assert.equal(retry.proposal.status, 'provision_failed', 'Workshop retry cannot bypass formal Task recovery');
  assert.equal(retry.proposal.errorCode, 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(sessions, 1);
  assert.equal(instructions.length, 1, 'retry must not repeat an instruction that already produced a partial file');
  assert.equal(retry.proposal.taskId, first.proposal.taskId);
  assert.deepEqual(services.taskService.runtime.get({ id: interrupted.id }).task, interrupted,
    'rejected retry preserves the exact retained assignment and Task revision');

  const checkpointed = services.taskService.runtime.setCheckpoint({ id: interrupted.id, expectedRev: interrupted.rev,
    summary: 'Retain the partial CSV for Owner review', nextAction: 'Inspect the existing result before further work' });
  stopReceiptAvailable = true;
  const preview = await ui('ui.task.recovery.inspect', { id: interrupted.id });
  assert.equal(preview.canResume, true, JSON.stringify(preview.blockers));
  assert.equal(preview.canRelease, true);
  assert.equal(preview.session.stopped, true);
  assert.equal(preview.workspace.kind, 'filtered-workspace-v1');
  assert.ok(preview.reviewToken);
  assert.ok(preview.reviewOperationIds.includes('request:' + originalRequestId));
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.git')), false, 'recovery uses non-Git content evidence');
  const nextInstruction = 'Read the retained partial.csv and report what remains; do not repeat the export.';
  const recoveryRequest = { id: interrupted.id, expectedRev: preview.taskRev,
    action: 'resume', reviewed: true, reviewToken: preview.reviewToken, reviewedOperationIds: preview.reviewOperationIds,
    reviewSummary: 'Checked the controlled stop receipt, original request and partial CSV; retain its existing bytes.',
    nextInstruction, requestId: 'workshop-reviewed-next-instruction' };
  const beforeReadinessRefusal = services.taskService.runtime.get({ id: interrupted.id }).task;
  const requestsFile = path.join(stateDir, 'capability', 'requests.json');
  const beforeRequests = fs.readFileSync(requestsFile);
  toolsAvailable = false;
  await assert.rejects(ui('ui.task.reconcile', recoveryRequest), { code: 'PROVIDER_UNAVAILABLE' });
  assert.deepEqual(services.taskService.runtime.get({ id: interrupted.id }).task, beforeReadinessRefusal);
  assert.deepEqual(fs.readFileSync(requestsFile), beforeRequests, 'failed admission cannot acknowledge earlier effects');
  assert.deepEqual(fs.readFileSync(path.join(workspaceRoot, 'partial.csv')), partialOutput);
  assert.equal(sessions, 1, 'unverified tools cannot create a recovery Session');
  assert.equal(instructions.length, 1, 'unverified tools cannot replay the previous instruction');
  toolsAvailable = true;
  const resumed = await ui('ui.task.reconcile', recoveryRequest);
  assert.equal(resumed.task.id, interrupted.id);
  assert.equal(sessions, 2);
  assert.equal(services.taskService.runtime.list().tasks.length, 1, 'formal recovery preserves the original Task identity');
  assert.deepEqual(instructions.at(-1), { sessionId: 'fixture-2', content: nextInstruction });
  assert.equal(instructions.length, 2, 'only the new Owner instruction is dispatched after review');
  const task = services.taskService.runtime.get({ id: retry.proposal.taskId }).task;
  assert.equal(task.workspaceId, retry.proposal.workspaceId);
  assert.deepEqual(task.currentAgent, { provider: 'workshop-fixture', sessionId: 'fixture-2' });
  assert.deepEqual(task.checkpoint, checkpointed.checkpoint);
  assert.equal(task.agentHistory[0].sessionId, 'fixture-1');
  assert.deepEqual(task.recoveryReviews.at(-1).previousAgent, interrupted.currentAgent);
  assert.ok(task.recoveryReviews.at(-1).operationIds.includes('request:' + originalRequestId));
  assert.deepEqual(fs.readFileSync(path.join(workspaceRoot, 'partial.csv')), partialOutput);
  const reconciledJournal = JSON.parse(fs.readFileSync(path.join(stateDir, 'capability', 'requests.json'), 'utf8'));
  assert.equal(reconciledJournal[originalRequestId].status, 'reconciled');
  assert.equal(reconciledJournal[originalRequestId].workspaceFence, undefined);
  assert.deepEqual(services.capabilityService.taskReviewState({ taskId: task.id, workspaceId: task.workspaceId }).workspaceFences, []);
  assert.equal(services.taskService.runtime.activeWorkspaceOwner({ workspaceId: task.workspaceId }).id, task.id);
  console.log('Workshop recovery:', JSON.stringify({ taskId: task.id, beforeStatus: interrupted.status,
    beforeAgent: interrupted.currentAgent, beforeFence: interruptedReview.workspaceFences,
    unconfirmedBlockers: beforeReceipt.blockers.map(row => row.code), afterStatus: task.status,
    afterAgent: task.currentAgent, reviewOperationIds: preview.reviewOperationIds }));
  assert.equal((await external('workshop.task.status', { id: proposal.id })).task.status, 'running');
  await assert.rejects(() => external('workshop.artifact.deliver', { id: proposal.id, label: 'result', content: 'data', approve: true }), { code: 'WORKSHOP_FORBIDDEN' });
  await assert.rejects(() => ui('ui.workshop.deliver', { id: proposal.id, label: 'result', content: 'data', approve: true }), { code: 'WORKSHOP_TASK_NOT_COMPLETED' });
  services.taskService.runtime.complete({ id: task.id, expectedRev: task.rev, summary: 'done' });
  const delivery = await ui('ui.workshop.deliver', { id: proposal.id, label: 'export.csv', content: 'a,b', approve: true });
  assert.equal(delivery.proposal.status, 'delivered');
  assert.equal((await external('workshop.proposal.get', { id: proposal.id })).proposal.artifacts[0].content, 'a,b');
  await assert.rejects(() => external('workshop.proposal.get', { id: proposal.id }, bob), { code: 'WORKSHOP_FORBIDDEN' });

  const unrelated = services.taskService.runtime.create({ goal: 'Unrelated owned Task', workspaceId: retry.proposal.workspaceId });
  const collision = (await external('workshop.proposal.submit', { title: 'Collision', description: 'Unrelated owned Task' }, bob)).proposal;
  const collisionReview = await ui('ui.workshop.review', { id: collision.id, approve: true, plan });
  assert.equal(collisionReview.proposal.status, 'provision_failed');
  assert.equal(collisionReview.proposal.taskId, null, 'Workshop must not claim a preexisting Task');
  assert.equal(services.taskService.runtime.get({ id: unrelated.id }).task.currentAgent, null);
  assert.equal(sessions, 2, 'Workshop must not dispatch Agent on another Task');
  console.log('Workshop production flow: passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
