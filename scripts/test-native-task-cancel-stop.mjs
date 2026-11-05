// Production Task/UI cancellation with a controlled native transport boundary.
// Deterministic stop failures are not real CLI/process-exit acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cetamesh-native-cancel-stop-'));
const services = createCetaMeshServices({stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
  agentStagingRoot: path.join(root, 'staging'), deferOptionalStart: true, log: () => {}});
const runtime = services.taskService.runtime;
const current = id => runtime.get({id}).task;
const ui = (method, params) => services.desktopUiService.execute({method, params});
const originals = {cancel: services.agentBroker.cancel, closeSession: services.agentBroker.closeSession,
  capabilities: services.agentBroker.capabilities};
const fault = code => Object.assign(new Error(code), {code});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
async function createAssigned(label, provider = 'opencode') {
  const project = path.join(root, label); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'input.txt'), 'unchanged synthetic input');
  const workspace = (await services.workspaceService.execute({method: 'workspace.create',
    params: {root: project, name: label}})).workspace;
  const created = runtime.create({goal: label, workspaceId: workspace.id});
  return runtime.start({id: created.id, expectedRev: created.rev,
    provider, sessionId: 'native-' + created.id}).task;
}
async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'control operation reached its boundary'); await delay(5); }
}

try {
  services.agentBroker.capabilities = provider => provider === 'opencode'
    ? {workspaceBoundary: 'native-staged'} : originals.capabilities(provider);
  const sibling = await createAssigned('unrelated-native-sibling');
  const controlled = await createAssigned('delayed-native-stop');
  const stageMarker = path.join(root, 'owned-stage-must-survive'); fs.writeFileSync(stageMarker, 'retained');
  const stop = deferred();
  let cancelCalls = 0, closeCalls = 0, settled = false;
  services.agentBroker.cancel = async assignment => {
    assert.deepEqual(assignment, controlled.currentAgent); cancelCalls++;
    return {cancelled: false, cancelRequested: true, state: 'unknown', sessionId: assignment.sessionId};
  };
  services.agentBroker.closeSession = async assignment => {
    assert.deepEqual(assignment, controlled.currentAgent); closeCalls++;
    await stop.promise;
    fs.unlinkSync(stageMarker);
    return {closed: true, sessionId: assignment.sessionId};
  };
  const pending = ui('ui.task.cancel', {id: controlled.id, expectedRev: controlled.rev}).finally(() => { settled = true; });
  try {
    await waitUntil(() => settled || closeCalls > 0);
    assert.equal(settled, false, 'native cancel request ACK must not settle Task cancellation before observed close');
    assert.equal(closeCalls, 1, 'native cancellation reuses the existing close/exit proof');
    assert.equal(current(controlled.id).status, 'running');
    assert.deepEqual(current(controlled.id).currentAgent, controlled.currentAgent);
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: controlled.workspaceId})?.id, controlled.id);
    assert.equal(fs.existsSync(stageMarker), true, 'owned stage remains while close is unconfirmed');
    assert.equal(current(sibling.id).status, 'running');
    stop.resolve();
    const completed = await pending;
    assert.equal(completed.task.status, 'cancelled');
    assert.equal(completed.task.currentAgent, null);
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: controlled.workspaceId}), null);
    assert.ok(current(controlled.id).agentHistory.some(row => row.sessionId === controlled.currentAgent.sessionId));
    assert.equal(cancelCalls, 1); assert.equal(closeCalls, 1);
    assert.equal(current(sibling.id).currentAgent.sessionId, sibling.currentAgent.sessionId);
  } finally { stop.resolve(); await pending.catch(() => {}); }
  console.log('PASS delayed native close retains Task assignment/Workspace owner and preserves independent sibling');

  for (const outcome of ['close-rejected', 'close-unconfirmed', 'close-wrong-session']) {
    const assigned = await createAssigned(outcome);
    const retainedStage = path.join(root, outcome + '.stage'); fs.writeFileSync(retainedStage, 'retained');
    let confirmed = false, attempts = 0;
    services.agentBroker.cancel = async assignment => {
      assert.deepEqual(assignment, assigned.currentAgent);
      return {cancelRequested: true, cancelled: false, state: 'unknown', sessionId: assignment.sessionId};
    };
    services.agentBroker.closeSession = async assignment => {
      assert.deepEqual(assignment, assigned.currentAgent); attempts++;
      if (!confirmed) {
        if (outcome === 'close-rejected') throw fault('ACP_CLOSE_UNKNOWN');
        return {closed: outcome === 'close-wrong-session', sessionId: 'unconfirmed-session'};
      }
      fs.unlinkSync(retainedStage);
      return {closed: true, sessionId: assignment.sessionId};
    };
    await assert.rejects(ui('ui.task.cancel', {id: assigned.id, expectedRev: assigned.rev}),
      {code: outcome === 'close-rejected' ? 'ACP_CLOSE_UNKNOWN' : 'SESSION_EXECUTION_UNCONFIRMED'});
    const retained = current(assigned.id);
    assert.equal(retained.status, 'running');
    assert.deepEqual(retained.currentAgent, assigned.currentAgent);
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: assigned.workspaceId})?.id, assigned.id);
    assert.equal(fs.existsSync(retainedStage), true);
    confirmed = true;
    const retry = await ui('ui.task.cancel', {id: assigned.id, expectedRev: retained.rev});
    assert.equal(retry.task.status, 'cancelled'); assert.equal(retry.task.currentAgent, null);
    assert.equal(attempts, 2); assert.equal(fs.existsSync(retainedStage), false);
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: assigned.workspaceId}), null);
    console.log('PASS ' + outcome + ' retains evidence and one fresh Owner cancellation can finish after confirmed close');
  }

  const changedRuntime = await createAssigned('configured-claude-became-unavailable', 'claude');
  const configuredCapabilities = services.agentBroker.capabilities;
  services.agentBroker.capabilities = provider => provider === 'claude'
    ? {workspaceBoundary: 'unsupported', available: false, reason: 'runtime_verification_required'}
    : configuredCapabilities(provider);
  const changedClose = deferred();
  let changedCloseCalls = 0, changedCancelSettled = false, permitClose = false;
  services.agentBroker.cancel = async assignment => {
    assert.deepEqual(assignment, changedRuntime.currentAgent);
    return {cancelRequested: true, cancelled: false, state: 'unknown'};
  };
  services.agentBroker.closeSession = async assignment => {
    assert.deepEqual(assignment, changedRuntime.currentAgent); changedCloseCalls++;
    await changedClose.promise;
    if (!permitClose) throw fault('ACP_CLOSE_UNKNOWN');
    return {closed: true, sessionId: assignment.sessionId};
  };
  const changedCancellation = ui('ui.task.cancel', {id: changedRuntime.id, expectedRev: changedRuntime.rev})
    .finally(() => { changedCancelSettled = true; });
  try {
    await waitUntil(() => changedCancelSettled || changedCloseCalls > 0);
    assert.equal(changedCancelSettled, false,
      'new-launch ineligibility must not skip cleanup of an already assigned native Session');
    assert.equal(changedCloseCalls, 1);
    assert.equal(current(changedRuntime.id).status, 'running');
    assert.deepEqual(current(changedRuntime.id).currentAgent, changedRuntime.currentAgent);
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: changedRuntime.workspaceId})?.id, changedRuntime.id);
    changedClose.resolve();
    await assert.rejects(changedCancellation, {code: 'ACP_CLOSE_UNKNOWN'});
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: changedRuntime.workspaceId})?.id, changedRuntime.id);
    permitClose = true;
    const retried = await ui('ui.task.cancel', {id: changedRuntime.id, expectedRev: current(changedRuntime.id).rev});
    assert.equal(retried.task.status, 'cancelled'); assert.equal(changedCloseCalls, 2);
  } finally {
    changedClose.resolve(); await changedCancellation.catch(() => {});
    services.agentBroker.capabilities = configuredCapabilities;
  }
  console.log('PASS unavailable launch configuration cannot waive existing Session close or its retry path');

  const raced = await createAssigned('assignment-changed-during-close');
  const oldClose = deferred(); let closeEntered = false;
  services.agentBroker.cancel = async () => ({cancelRequested: true, cancelled: false, state: 'unknown'});
  services.agentBroker.closeSession = async assignment => {
    assert.deepEqual(assignment, raced.currentAgent); closeEntered = true;
    await oldClose.promise; return {closed: true, sessionId: assignment.sessionId};
  };
  const staleCancellation = ui('ui.task.cancel', {id: raced.id, expectedRev: raced.rev});
  try {
    await waitUntil(() => closeEntered);
    const newer = runtime.attachAgent({id: raced.id, expectedRev: current(raced.id).rev,
      provider: 'opencode', sessionId: 'newer-native-session'}).task;
    oldClose.resolve();
    await assert.rejects(staleCancellation, {code: 'TASK_CONFLICT'},
      'an old native close receipt cannot cancel a replacement Task assignment');
    assert.equal(current(raced.id).status, 'running');
    assert.deepEqual(current(raced.id).currentAgent, newer.currentAgent);
    assert.equal(runtime.activeWorkspaceOwner({workspaceId: raced.workspaceId})?.id, raced.id);
  } finally { oldClose.resolve(); await staleCancellation.catch(() => {}); }
  console.log('PASS delayed close cannot cancel an assignment that changed during the await');

  for (const isChild of [true, false]) {
    const scope = await createAssigned(isChild ? 'late-child-replacement-scope' : 'late-root-replacement');
    let target = scope;
    if (isChild) {
      const detached = runtime.detachAgent({id: scope.id, expectedRev: scope.rev}).task;
      const parent = runtime.pause({id: detached.id, expectedRev: detached.rev}).task;
      const created = runtime.createChild({parentTaskId: parent.id, expectedParentRev: parent.rev,
        workspaceId: parent.workspaceId, requestId: 'late-child-create', goal: 'Read input.txt',
        contract: {mode: 'read-only', outputKind: 'analysis', readScope: ['input.txt'], expectedEvidence: ['filesystem.read']}});
      target = runtime.start({id: created.id, expectedRev: created.rev,
        provider: 'cetamesh', sessionId: 'old-read-child'}).task;
    }
    const get = runtime.get, status = services.agentBroker.status;
    let armRead = false, replacement = null, scheduled = false;
    services.agentBroker.cancel = async () => ({cancelRequested: true, cancelled: false, state: 'unknown'});
    services.agentBroker.closeSession = async assignment => {
      assert.deepEqual(assignment, target.currentAgent); armRead = true;
      return {closed: true, sessionId: assignment.sessionId};
    };
    services.agentBroker.status = async assignment => {
      assert.deepEqual(assignment, target.currentAgent); armRead = true;
      return {running: false, queued: 0, waitingForApproval: false};
    };
    runtime.get = params => {
      const result = get(params);
      // Root: immediately after the post-close read. Child: after its stopped
      // status read, before the final mutation. The current implementation
      // yields after both reads, so a new authoritative assignment can arrive.
      if (armRead && !scheduled && params.id === target.id) {
        scheduled = true;
        queueMicrotask(() => {
          replacement = runtime.attachAgent({id: target.id, expectedRev: get({id: target.id}).task.rev,
            provider: target.currentAgent.provider, sessionId: isChild ? 'replacement-read-child' : 'replacement-native-root'}).task;
        });
      }
      return result;
    };
    try {
      await assert.rejects(ui('ui.task.cancel', {id: scope.id, expectedRev: get({id: scope.id}).task.rev}),
        {code: 'TASK_CONFLICT'}, 'final ' + (isChild ? 'child' : 'root') + ' mutation must recheck the stopped assignment synchronously');
      assert.equal(scheduled, true);
      assert.ok(replacement);
      assert.equal(get({id: target.id}).task.status, 'running');
      assert.deepEqual(get({id: target.id}).task.currentAgent, replacement.currentAgent);
      assert.equal(runtime.activeWorkspaceOwner({workspaceId: target.workspaceId})?.id, target.id);
    } finally { runtime.get = get; services.agentBroker.status = status; }
    console.log('PASS microtask replacement survives final ' + (isChild ? 'child' : 'root') + ' cancellation boundary');
  }
} finally {
  Object.assign(services.agentBroker, originals);
  for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService',
    'pluginCenterService', 'extensionService', 'channelService', 'bionicService', 'simulationService', 'meshService'])
    await services[name]?.close?.();
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('cetamesh-native-cancel-stop-'));
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
  fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
