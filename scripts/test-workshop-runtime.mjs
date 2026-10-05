import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../src/workspace/index.js';
import { createTaskRuntime } from '../src/task/index.js';
import { createWorkshopService } from '../src/workshop/index.js';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-workshop-'));
const owner = { kind: 'owner', id: 'desktop-owner' };
const alice = { kind: 'external', id: 'channel:alice' };
const bob = { kind: 'external', id: 'channel:bob' };
let assertions = 0;
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++; };
async function denied(fn, code = 'WORKSHOP_FORBIDDEN') {
  await assert.rejects(fn, (error) => error.code === code); assertions++;
}
try {
  const stateDir = path.join(fixture, 'state');
  const workspaceService = createWorkspaceService({ stateDir });
  const taskRuntime = createTaskRuntime({ stateDir });
  const calls = [];
  const replay = new Map();
  let failAgent = false;
  let createdSessions = 0;
  const capabilityBroker = {
    async execute(request) {
      if (request.actor?.kind !== 'owner') throw Object.assign(new Error('Capability denied'), { code: 'CAPABILITY_DENIED' });
      if (request.capability !== 'agent.run' && replay.has(request.requestId)) return structuredClone(replay.get(request.requestId));
      calls.push(structuredClone(request));
      let result;
      if (request.capability === 'workspace.create') {
        result = await workspaceService.execute({ method: 'workspace.create', params: request.input });
      } else if (request.capability === 'agent.run') {
        if (failAgent) throw Object.assign(new Error('Provider unavailable /private/provider-secret'), { code: 'AGENT_OFFLINE' });
        const task = taskRuntime.get({ id: request.taskId }).task;
        check(request.workspaceId, task.workspaceId);
        check(request.input.grants.workspaceIds, [task.workspaceId]);
        check(request.input.grants.taskIds, [task.id]);
        if (task.currentAgent) return { ...task.currentAgent, reused: true };
        const sessionId = 'mock-session-' + ++createdSessions;
        taskRuntime.attachAgent({ id: task.id, expectedRev: task.rev, provider: request.input.provider, sessionId });
        const attached = taskRuntime.get({ id: task.id }).task;
        taskRuntime.start({ id: task.id, expectedRev: attached.rev });
        result = { provider: request.input.provider, sessionId };
      } else if (request.capability === 'filesystem.read') {
        result = await workspaceService.execute({ method: 'workspace.read', params: { id: request.workspaceId, ...request.input } });
      } else throw Object.assign(new Error('Unknown capability'), { code: 'CAPABILITY_DENIED' });
      replay.set(request.requestId, result);
      return structuredClone(result);
    }
  };
  let service = createWorkshopService({ stateDir, workspaceService, taskRuntime, capabilityBroker, ownerId: owner.id });
  const run = (method, params = {}, actor = alice) => service.execute({ method, params, actor });
  const p = (await run('workshop.proposal.submit', {
    requestId: 'alice-1', title: 'CSV exporter', description: 'Build an exporter', requirements: ['CSV output'],
    actor: owner, ownerId: owner.id, workspaceId: 'untrusted', grants: { capabilities: ['*'] }
  })).proposal;
  check(p.status, 'submitted');
  check((await run('workshop.proposal.submit', { requestId: 'alice-1', title: 'CSV exporter', description: 'Build an exporter', requirements: ['CSV output'] })).proposal.id, p.id);
  await denied(() => run('workshop.proposal.submit', { requestId: 'alice-1', title: 'Changed', description: 'Different' }), 'WORKSHOP_IDEMPOTENCY_CONFLICT');
  check(taskRuntime.list().tasks.length, 0);
  check(calls.length, 0);
  await run('workshop.proposal.supplement', { id: p.id, text: 'UTF-8 support', requestId: 's1' });
  await run('workshop.proposal.supplement', { id: p.id, text: 'UTF-8 support', requestId: 's1' });
  check((await run('workshop.proposal.get', { id: p.id })).proposal.supplements.length, 1);
  await denied(() => run('workshop.proposal.get', { id: p.id }, bob));
  await denied(() => run('workshop.proposal.supplement', { id: p.id, text: 'Hijack' }, bob));
  check((await run('workshop.proposal.list', {}, bob)).proposals, []);
  await denied(() => run('workshop.proposal.review', { id: p.id, approve: true }));
  await denied(() => run('workshop.proposal.retry', { id: p.id }));
  await denied(() => run('workshop.artifact.deliver', { id: p.id, label: 'output', content: 'private' }));
  await denied(() => run('filesystem.read', { path: 'secret' }), 'METHOD_NOT_FOUND');
  await denied(() => service.execute({ method: 'workshop.proposal.list', params: { actor: owner } }), 'WORKSHOP_ACTOR_REQUIRED');
  await denied(() => run('workshop.proposal.list', {}, { kind: 'extension', id: 'plugin' }));
  await assert.rejects(() => capabilityBroker.execute({ actor: alice, capability: 'filesystem.read', workspaceId: 'any', input: { path: 'secret' } }), { code: 'CAPABILITY_DENIED' }); assertions++;

  const rejected = (await run('workshop.proposal.submit', { title: 'Rejected', description: 'Scope too large' }, bob)).proposal;
  await run('workshop.proposal.review', { id: rejected.id, approve: false, reason: 'Reduce scope' }, owner);
  check((await run('workshop.proposal.get', { id: rejected.id }, bob)).proposal.status, 'rejected');
  await run('workshop.proposal.supplement', { id: rejected.id, text: 'Reduced scope' }, bob);
  check((await run('workshop.proposal.get', { id: rejected.id }, bob)).proposal.status, 'submitted');

  const root = path.join(fixture, 'approved-project');
  const plan = { workspace: { name: 'CSV exporter', root, createIfMissing: true }, provider: 'mock', capabilities: ['filesystem.read', 'filesystem.write', 'git.status'] };
  failAgent = true;
  const failed = await run('workshop.proposal.review', { id: p.id, approve: true, plan }, owner);
  check(failed.proposal.status, 'provision_failed');
  check(taskRuntime.list().tasks.length, 1);
  check((await workspaceService.execute({ method: 'workspace.list' })).workspaces.length, 1);
  check((await run('workshop.proposal.get', { id: p.id })).proposal.provision, undefined);
  check(JSON.stringify(await run('workshop.proposal.get', { id: p.id })).includes('/private/provider-secret'), false);
  await denied(() => run('workshop.task.status', { id: p.id }, bob));
  failAgent = false;
  service = createWorkshopService({ stateDir, workspaceService, taskRuntime, capabilityBroker, ownerId: owner.id });
  const approved = await service.executeOwner({ method: 'workshop.proposal.retry', params: { id: p.id } });
  check(approved.proposal.status, 'active');
  check(createdSessions, 1);
  check(taskRuntime.list().tasks.length, 1);
  const repeated = await run('workshop.proposal.review', { id: p.id, approve: true, plan }, owner);
  check(repeated.proposal.taskId, approved.proposal.taskId);
  check(createdSessions, 1);
  check(calls.filter((request) => request.capability === 'agent.run').length, 3);
  const internal = (await run('workshop.proposal.get', { id: p.id }, owner)).proposal;
  check(internal.assignment.grants.workspaceIds, [internal.workspaceId]);
  check(internal.assignment.grants.taskIds, [internal.taskId]);
  check(internal.assignment.grants.capabilities, plan.capabilities);
  check(internal.assignment.actor.kind, 'agent');
  const publicStatus = await run('workshop.task.status', { id: p.id });
  check(publicStatus.task.status, 'running');
  check(Object.keys(publicStatus.task).sort(), ['createdAt', 'id', 'percent', 'status', 'updatedAt']);
  check(JSON.stringify(publicStatus).includes(root), false);
  await denied(() => run('workshop.proposal.supplement', { id: p.id, text: 'Change approved work' }), 'WORKSHOP_REVIEW_REQUIRED');
  await denied(() => run('workshop.artifact.deliver', { id: p.id, label: 'output', content: 'result', approve: true }, owner), 'WORKSHOP_TASK_NOT_COMPLETED');
  const task = taskRuntime.get({ id: internal.taskId }).task;
  taskRuntime.complete({ id: task.id, expectedRev: task.rev, summary: 'Internal /private/summary' });
  const delivery = await run('workshop.artifact.deliver', { id: p.id, requestId: 'delivery-1', label: 'export.csv', mediaType: 'text/csv', content: 'name,value\na,1', approve: true }, owner);
  check(delivery.artifact.content, 'name,value\na,1');
  check((await run('workshop.artifact.deliver', { id: p.id, requestId: 'delivery-1', label: 'export.csv', mediaType: 'text/csv', content: 'name,value\na,1', approve: true }, owner)).artifact.id, delivery.artifact.id);
  const external = await run('workshop.proposal.get', { id: p.id });
  check(external.proposal.artifacts.length, 1);
  check(external.proposal.artifacts[0].content, 'name,value\na,1');
  check(JSON.stringify(external).includes('/private/summary'), false);
  await denied(() => run('workshop.proposal.get', { id: p.id }, bob));
  await denied(() => run('workshop.proposal.review', { id: rejected.id, approve: true, plan: { ...plan, workspace: { name: 'bad', root: path.join(fixture, 'other'), createIfMissing: true }, capabilities: ['*'] } }, owner), 'WORKSHOP_INVALID_PARAMS');
  check((await workspaceService.execute({ method: 'workspace.list' })).workspaces.length, 1);
  console.log('Workshop runtime: ' + assertions + ' assertions passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
