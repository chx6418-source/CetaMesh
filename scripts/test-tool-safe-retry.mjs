import assert from 'node:assert/strict';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';

const actor = { kind: 'agent', id: 'agent-one', grants: { capabilities: ['filesystem.read', 'filesystem.write'] } };
const temporaryError = () => Object.assign(new Error('temporary read failure'), { code: 'EBUSY' });

async function scenario({ capability = 'filesystem.read', execute, resolveActor = () => actor,
  controller = new AbortController(), input = { path: 'file.txt' },
  onActivity = () => {}, dispatchStatus, manifestSchema = { type: 'object', additionalProperties: true } }) {
  const calls = [];
  const activities = [];
  const outcomes = [];
  let modelCalls = 0;
  const coordinator = createToolExecutionCoordinator({
    modelRuntime: { chat: async () => ++modelCalls === 1
      ? { toolCalls: [{ id: 'call-one', capabilityId: capability, arguments: input }] }
      : { text: 'Report the observed result' } },
    capabilityBroker: { execute: async request => { calls.push(request); return execute(request, calls.length); },
      ...(dispatchStatus ? { dispatchStatus } : {}) },
    actorResolver: resolveActor
  });
  const run = coordinator.run({ actor, sessionId: 'session-one', turnId: 'turn-one',
    scope: { taskId: 'task-one', workspaceId: 'workspace-one' }, signal: controller.signal,
    messages: [{ role: 'user', content: 'Read once and report' }],
    manifest: [{ id: capability, description: capability, inputSchema: manifestSchema }],
    onActivity: async event => { activities.push(event); await onActivity(event); },
    onCapabilityResult: event => outcomes.push(event) });
  return { run, calls, activities, outcomes, controller, coordinator };
}

{
  let actorResolutions = 0;
  const s = await scenario({ execute: (_request, count) => count === 1 ? Promise.reject(temporaryError())
    : { status: 'completed', result: { content: 'read' } }, resolveActor: () => { actorResolutions++; return actor; } });
  assert.equal((await s.run).status, 'completed');
  assert.equal(s.calls.length, 2, 'one transient read gets at most one retry');
  assert.notEqual(s.calls[0].requestId, s.calls[1].requestId, 'attempts have distinct Broker request IDs');
  assert.equal(actorResolutions, 2, 'live authority must be resolved again before the retry');
  assert.equal(s.activities.filter(row => row.status === 'retrying').length, 1, 'retry is traceable');
  assert.equal(s.outcomes[0].result.retryCount, 1);
}
{
  let resolutions = 0;
  const s = await scenario({ execute: () => Promise.reject(temporaryError()),
    resolveActor: () => ++resolutions === 1 ? actor : null });
  await s.run;
  assert.equal(s.calls.length, 1, 'revoked actor is not dispatched again');
  assert.equal(s.outcomes[0].result.error.code, 'TOOL_ACTOR_UNAVAILABLE');
}
{
  let grantValid = true;
  const s = await scenario({ execute: (_request, count) => {
    if (count === 1) { grantValid = false; throw temporaryError(); }
    if (!grantValid) throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' });
    return { status: 'completed', result: { content: 'should not happen' } };
  } });
  await s.run;
  assert.equal(s.calls.length, 2, 'Broker is invoked again with fresh policy, then stops on revoked grant');
  assert.equal(s.outcomes[0].result.error.code, 'PERMISSION_DENIED');
}
{
  const controller = new AbortController();
  const s = await scenario({ controller, execute: () => { controller.abort(); return Promise.reject(temporaryError()); } });
  await assert.rejects(s.run);
  assert.equal(s.calls.length, 1, 'cancelled retry does not dispatch again');
}
{
  const controller = new AbortController();
  const s = await scenario({ controller, execute: () => Promise.reject(temporaryError()),
    onActivity: event => { if (event.status === 'retrying') controller.abort(); } });
  await assert.rejects(s.run);
  assert.equal(s.calls.length, 1, 'cancellation during retry wait stops before redispatch');
}
{
  const s = await scenario({ execute: () => Promise.reject(temporaryError()) });
  await s.run;
  assert.equal(s.calls.length, 2, 'transient read exhausts after one retry');
  assert.equal(s.outcomes[0].result.error.code, 'EBUSY');
  assert.equal(s.outcomes[0].result.retryCount, 1);
}
{
  const s = await scenario({ execute: () => Promise.reject(temporaryError()),
    dispatchStatus: () => ({ status: 'failed' }) });
  await s.run;
  assert.equal(s.calls.length, 2);
  assert.equal(s.coordinator.recoveryForTask('task-one'), null,
    'known failed read attempts must not masquerade as uncertain effects');
}
{
  const s = await scenario({ capability: 'filesystem.write', execute: () => Promise.reject(temporaryError()) });
  await s.run;
  assert.equal(s.calls.length, 1, 'a write is never retried automatically');
}
for (const code of ['APPROVAL_REJECTED', 'MODEL_INVALID_TOOL_SCHEMA', 'INVOKE_CANCELLED']) {
  const s = await scenario({ execute: () => Promise.reject(Object.assign(new Error(code), { code })) });
  try { await s.run; } catch { /* cancellation may end the turn */ }
  assert.equal(s.calls.length, 1, `${code} cannot trigger a retry`);
}
{
  const s = await scenario({ execute: () => { throw new Error('must not dispatch'); }, input: {},
    manifestSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } });
  await s.run;
  assert.equal(s.calls.length, 0, 'invalid tool schema/input cannot dispatch or retry');
}
{
  const s = await scenario({ execute: () => Promise.reject(temporaryError()),
    dispatchStatus: () => ({ status: 'started' }) });
  await s.run;
  assert.equal(s.calls.length, 1, 'an unsettled Broker dispatch cannot overlap with a retry');
}
{
  const s = await scenario({ execute: async () => { await new Promise(resolve => setTimeout(resolve, 280)); throw temporaryError(); } });
  await s.run;
  assert.equal(s.calls.length, 1, 'retry deadline is bounded even for a slow transient failure');
}
{
  const s = await scenario({ execute: () => Promise.reject(temporaryError()),
    onActivity: async event => { if (event.status === 'retrying') await new Promise(resolve => setTimeout(resolve, 280)); } });
  await s.run;
  assert.equal(s.calls.length, 1, 'slow retry bookkeeping cannot bypass the retry deadline');
}
{
  let resolutions = 0;
  const s = await scenario({ execute: () => Promise.reject(temporaryError()),
    resolveActor: async () => {
      if (++resolutions === 2) await new Promise(resolve => setTimeout(resolve, 280));
      return actor;
    } });
  await s.run;
  assert.equal(s.calls.length, 1, 'slow live actor resolution cannot dispatch after the retry deadline');
}
{
  const started = Date.now();
  const s = await scenario({ execute: (_request, count) => count === 1
    ? Promise.reject(temporaryError())
    : new Promise(resolve => setTimeout(() => resolve({ status: 'completed', result: { content: 'late' } }), 900)) });
  const outcome = await s.run;
  assert.equal(s.calls.length, 2);
  assert.equal(outcome.code, 'OUTCOME_UNKNOWN', 'a timed-out retry is not called completed');
  assert.ok(Date.now() - started < 650, 'the second Broker call has a hard short deadline');
}
console.log('safe tool retry: read-only allowlist, one retry, live grant, cancel, deadline and exclusions passed');
