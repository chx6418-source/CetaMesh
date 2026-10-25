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
const stateDir = path.join(root, 'state');
const workspaceRoot = path.join(root, 'approved-workspace');
const alice = { kind: 'external', id: 'qq:alice' };
const bob = { kind: 'external', id: 'qq:bob' };
const services = createCetaMeshServices({ stateDir, dataRoot: root, sourceRoot: root, resourceRoot: root,
  config: { allow: { private: [], groups: [] } } });
let sessions = 0;
let failSend = true;
let closes = 0;
services.agentBroker.register(defineAgentProvider({ id: 'workshop-fixture', label: 'Workshop fixture',
  capabilityExtras: { workspaceBoundary: 'capability-broker' }, methods: {
    async health() { return { available: true, installed: true, authenticated: true,
      sessionCapable: true, compatible: true }; },
    async createSession() { return { sessionId: `fixture-${++sessions}` }; },
    async send() {
      if (failSend) throw Object.assign(new Error('Fixture transport failed'), { code: 'PROVIDER_ERROR' });
      return { accepted: true };
    },
    async closeSession() { closes++; return { closed: true }; },
    async status() { return { running: true }; },
    async *follow({ signal }) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
  } }));
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
  assert.equal(services.taskService.runtime.get({ id: first.proposal.taskId }).task.currentAgent, null);
  assert.equal(services.taskService.runtime.get({ id: first.proposal.taskId }).task.status, 'failed');

  failSend = false;
  const retry = await ui('ui.workshop.retry', { id: proposal.id });
  assert.equal(retry.proposal.status, 'active', `retry failed: ${retry.proposal.errorCode}`);
  assert.equal(sessions, 2);
  assert.equal(services.taskService.runtime.list().tasks.length, 2, 'rollback keeps the failed Task for audit');
  assert.notEqual(retry.proposal.taskId, first.proposal.taskId);
  const task = services.taskService.runtime.get({ id: retry.proposal.taskId }).task;
  assert.equal(task.workspaceId, retry.proposal.workspaceId);
  assert.equal(task.currentAgent.provider, 'workshop-fixture');
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
