import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { inspectTaskSession } from '../src/agent/session-recovery.js';

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

  // A real Continuity invocation is held at its Workspace observation. The
  // existing application command must reject before changing Task or operations.
  const failures = [];
  for (const command of ['pause', 'cancel']) {
    const f = await fixture(`F3-handoff-${command}`);
    let release = () => {}, handoff;
    try {
      const created = await f.ui('ui.task.create', { goal: 'Keep the source execution intact during rejected Handoff.',
        workspaceId: f.workspace.id, agentProvider: 'cetamesh', modelProvider: 'functional-loop', model: 'fixture', requestId: `handoff-${command}` });
      const id = created.task.id;
      await f.finished(id);
      const originalProof = f.services.workspaceService.collectContentProof;
      let entered;
      const gate = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { entered = resolve; });
      f.services.workspaceService.collectContentProof = async (...args) => {
        const proof = originalProof(...args); entered(); await gate; return proof;
      };
      handoff = f.services.continuityService.runtime.rollover({ taskId: id, targetProvider: 'cetamesh', reason: 'manual' });
      handoff.catch(() => {});
      await Promise.race([reached, handoff.then(() => assert.fail('Handoff completed before the held observation'))]);
      assert.equal(f.services.continuityService.runtime.isInFlight(id), true);
      const before = f.read(id);
      let cancelCalls = 0;
      const originalCancel = f.services.capabilityService.cancelTaskOperations;
      f.services.capabilityService.cancelTaskOperations = (...args) => { cancelCalls++; return originalCancel(...args); };
      await assert.rejects(f.ui(`ui.task.${command}`, { id, expectedRev: before.rev }), { code: 'TASK_HANDOFF_IN_FLIGHT' });
      f.sample.refusedTaskChanged = JSON.stringify(f.read(id)) !== JSON.stringify(before);
      f.sample.refusedOperationCancelCalls = cancelCalls;
      assert.deepEqual(f.read(id), before, 'known Handoff refusal must not mutate Task, revision, checkpoint or evidence');
      assert.equal(cancelCalls, 0, 'known Handoff refusal must not begin cancelling operations');
      release();
      await assert.rejects(handoff, { code: 'WORKSPACE_UNVERIFIED' }); // non-Git Handoff retains its existing policy
      assert.deepEqual(f.read(id), before, 'non-Git Handoff refusal must preserve the original executor');
      f.services.workspaceService.collectContentProof = originalProof;
      const paused = await f.ui('ui.task.pause', { id, expectedRev: before.rev });
      assert.equal(paused.task.status, 'paused');
      await f.ui('ui.task.resume', { id, expectedRev: paused.task.rev, requestId: `after-${command}-refusal` });
      await f.complete(id);
      console.log(`PASS F3 ${command} refuses active Handoff without effects; non-Git source still pauses/resumes/completes`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL F3 ${command}: ${error.message}`);
    } finally {
      release(); await handoff?.catch(() => {}); await f.close();
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Known control refusals must not manufacture recovery work');

  const recovering = await fixture('F3-partial-recovery');
  try {
    const created = await recovering.ui('ui.task.create', { goal: 'Preserve an unfinished Owner recovery commit.',
      workspaceId: recovering.workspace.id, agentProvider: 'cetamesh', modelProvider: 'functional-loop', model: 'fixture', requestId: 'partial-recovery-create' });
    const id = created.task.id;
    const ended = await recovering.finished(id);
    await recovering.ui('ui.task.pause', { id, expectedRev: ended.rev });
    const paused = recovering.read(id);
    const proof = await recovering.services.workspaceService.collectRecoveryProof(recovering.workspace.id);
    const stopped = await inspectTaskSession(recovering.services.agentBroker, paused);
    // Fault injection at the existing durable intent boundary, before journal acknowledgements.
    recovering.rt.prepareOwnerRecovery({ id, expectedRev: paused.rev, reviewId: 'partial-owner-review',
      summary: 'Interrupt after durable intent', workspaceProof: proof, sessionProof: stopped, operationIds: [], journalSha256: 'a'.repeat(64) });
    const before = recovering.read(id);
    let calls = 0;
    const original = recovering.services.capabilityService.cancelTaskOperations;
    recovering.services.capabilityService.cancelTaskOperations = (...args) => { calls++; return original(...args); };
    for (const method of ['pause', 'cancel']) {
      await assert.rejects(recovering.ui(`ui.task.${method}`, { id, expectedRev: before.rev }), { code: 'TASK_RECOVERY_REVIEW_REQUIRED' });
      assert.deepEqual(recovering.read(id), before);
    }
    assert.equal(calls, 0, 'partial recovery refusal must occur before any operation cancellation');
    assert.equal(recovering.rt.activeWorkspaceOwner({ workspaceId: recovering.workspace.id }).id, id);
    const preview = await recovering.ui('ui.task.recovery.inspect', { id });
    assert.equal(preview.canResume, true, JSON.stringify(preview.blockers));
    await recovering.ui('ui.task.reconcile', { id, expectedRev: preview.taskRev, reviewed: true,
      reviewToken: preview.reviewToken, reviewedOperationIds: preview.reviewOperationIds, action: 'resume',
      provider: 'cetamesh', reviewSummary: 'Verified original file hash and real Managed stop; retain old effects.',
      nextInstruction: 'Fresh read of proof.txt after completing the interrupted Owner review.', requestId: 'partial-recovery-fresh' });
    await recovering.complete(id);
    assert.equal(recovering.read(id).recoveryIntent, null);
    console.log('PASS F3 partial recovery refuses pause/cancel without mutations, then original Owner recovery completes');
  } finally { await recovering.close(); }

  const raced = await fixture('F3-post-await-guard');
  try {
    const created = await raced.ui('ui.task.create', { goal: 'Recheck authority after an awaited cancellation.',
      workspaceId: raced.workspace.id, agentProvider: 'cetamesh', modelProvider: 'functional-loop', model: 'fixture', requestId: 'late-handoff-create' });
    const id = created.task.id;
    await raced.finished(id);
    let lateHandoff = false, agentStops = 0;
    const runtime = raced.services.continuityService.runtime, originalFlight = runtime.isInFlight;
    const originalCancel = raced.services.capabilityService.cancelTaskOperations;
    const stop = raced.services.agentBroker.cancel;
    runtime.isInFlight = taskId => lateHandoff || originalFlight(taskId);
    raced.services.capabilityService.cancelTaskOperations = async (...args) => {
      const result = await originalCancel(...args); lateHandoff = true; return result;
    };
    raced.services.agentBroker.cancel = (...args) => { agentStops++; return stop(...args); };
    const before = raced.read(id);
    await assert.rejects(raced.ui('ui.task.cancel', { id, expectedRev: before.rev }), { code: 'TASK_HANDOFF_IN_FLIGHT' });
    assert.equal(agentStops, 0, 'early preflight never replaces the post-await check');
    assert.deepEqual(raced.read(id), before);
    lateHandoff = false;
    runtime.isInFlight = originalFlight;
    raced.services.capabilityService.cancelTaskOperations = originalCancel;
    await raced.complete(id);
    console.log('PASS F3 a Handoff beginning during awaited work still refuses the Agent stop');
  } finally { await raced.close(); }
} finally {
  if (process.env.CETAMESH_FUNCTIONAL_METRICS_FILE) fs.writeFileSync(process.env.CETAMESH_FUNCTIONAL_METRICS_FILE,
    JSON.stringify({ samples, externalModelCalls: 0, nativeAcceptance: false }, null, 2) + '\n');
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('cetamesh-functional-loop-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
