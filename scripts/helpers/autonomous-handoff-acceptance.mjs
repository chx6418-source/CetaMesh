// Test-side acceptance guards. They confer no model, Core or native authority.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const acceptanceHash = value => crypto.createHash('sha256').update(value).digest('hex');

export function assertProtectedFiles(project, protectedHashes) {
  for (const [file, expected] of Object.entries(protectedHashes)) {
    assert.equal(acceptanceHash(fs.readFileSync(path.join(project, file))), expected, 'Original verification file must remain unchanged: ' + file);
  }
}

/** Trusted fixture Owner setup, shared by the real opt-in test and its model-free preparation regression. */
export async function prepareSubscriptionOwnerContract({ services, taskId, workspaceId, project, protectedHashes,
  operationId, testInput, allowedPaths, now = () => Date.now() }) {
  const rt = services.taskService.runtime, revisions = [];
  const read = phase => { const task = rt.get({ id: taskId }).task;
    revisions.push({ phase, revision: task.rev, authorizationRevision: task.authorizationRevision ?? task.rev }); return task; };
  let task = read('before-acceptance');
  assert.equal(task.workspaceId, workspaceId); assert.equal(task.currentAgent?.provider, 'cetamesh');
  await services.taskService.execute({ method: 'task.acceptance.add', params: { id: task.id, expectedRev: task.rev,
    text: 'Only sum.js changes; unchanged package.json and verify.cjs run the fixed Node verification successfully through Core.' } });
  task = read('after-acceptance');
  const currentGrants = services.capabilityService.principalForTask(task.id).grants.capabilities;
  services.capabilityService.grantTask(task.id, { capabilities: [...new Set([...currentGrants,
    'filesystem.read', 'git.diff', 'workspace.apply', 'test.run', 'operation.read', 'operation.continue'])] });
  read('after-grant');
  assertProtectedFiles(project, protectedHashes);
  await services.capabilityService.execute({ method: 'capability.operation.prepare', params: {
    taskId: task.id, workspaceId, operationId, capability: 'test.run', input: testInput } });
  // Owner preparation awaits real validation. Re-read the actual Task before the revision-bound policy write.
  task = read('after-operation-prepare');
  const authorized = await services.capabilityService.execute({ method: 'capability.delegation.authorize', params: {
    taskId: task.id, expectedRev: task.rev, policy: { expiresAt: now() + 600000, maxDelegations: 1,
      prepareNative: true, allowUnknownCost: false, allowSubscriptionOnly: true,
      verification: { kind: 'code-tests', operationId, acceptanceIds: task.acceptance.map(row => row.id), allowedPaths,
        unchangedFiles: Object.entries(protectedHashes).map(([path, sha256]) => ({ path, sha256 })) } } } });
  read('after-policy');
  assert.equal(authorized.task.delegationPolicy.allowSubscriptionOnly, true);
  assert.equal(authorized.task.delegationPolicy.allowUnknownCost, false);
  return { task: authorized.task, revisions };
}

/** Reuse the real-autonomous test's exact import/test checks; refuse every other capability. */
export function assertExactHandoffEffect(request, { taskId, workspaceId, project, allowedPaths, protectedHashes,
  testInput = { tool: 'npm', args: ['test'], timeoutMs: 30000 }, operationId, maxContentChars = 5000 } = {}) {
  assert.equal(request.taskId, taskId);
  if (workspaceId !== undefined) assert.equal(request.workspaceId, workspaceId);
  assertProtectedFiles(project, protectedHashes);
  if (request.capability === 'workspace.apply') {
    assert.deepEqual(request.input.changes.map(change => change.path).sort(), [...allowedPaths].sort());
    assert.ok(request.input.changes.every(change => change.action === 'write'
      && typeof change.content === 'string' && change.content.length < maxContentChars));
  } else if (request.capability === 'test.run') {
    assert.equal(request.input.tool, testInput.tool); assert.deepEqual(request.input.args, testInput.args);
    if (operationId !== undefined) assert.equal(request.operationId, operationId, 'Only the Owner-prepared operation may be approved');
    assert.equal(request.input.timeoutMs, testInput.timeoutMs);
  } else throw Error('Unexpected approval capability ' + request.capability);
}

/** Synchronous fsync-before-dispatch reservations; failed/uncertain sends never refund a slot. */
export function createHandoffBudgetJournal(file, { maxDispatches = 6, maxUserTurns = 3 } = {}) {
  assert.equal(maxDispatches, 6); assert.equal(maxUserTurns, 3);
  const fd = fs.openSync(file, 'wx'); let dispatches = 0, userTurns = 0, sequence = 0, closed = false;
  function append(value) {
    assert.equal(closed, false, 'The dispatch budget journal must remain open');
    const bytes = Buffer.from(JSON.stringify({ sequence: ++sequence, at: Date.now(), ...value }) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  }
  append({ kind: 'limits', maxDispatches, maxUserTurns });
  return {
    append,
    reserveDispatch({ provider, sessionId, phase = 'user', runId = null }) {
      if (dispatches >= maxDispatches) { append({ kind: 'dispatch-refused', provider, phase, dispatches });
        throw Object.assign(Error('Acceptance dispatch budget is exhausted; no retry is authorized'), { code: 'ACCEPTANCE_DISPATCH_LIMIT' }); }
      assert.ok(['codex', 'cetamesh'].includes(provider), 'Only the real Codex and local Managed coordinator may be sent');
      const next = dispatches + 1;
      append({ kind: 'dispatch-reserved', dispatch: next, provider, sessionId, phase, runId });
      dispatches = next; return next;
    },
    reserveUserTurn() {
      if (userTurns >= maxUserTurns) throw Object.assign(Error('Acceptance user-turn budget is exhausted'), { code: 'ACCEPTANCE_USER_TURN_LIMIT' });
      const next = userTurns + 1; append({ kind: 'user-turn-reserved', userTurn: next }); userTurns = next; return next;
    },
    snapshot: () => ({ dispatches, userTurns, maxDispatches, maxUserTurns }),
    close() { if (!closed) { fs.fsyncSync(fd); fs.closeSync(fd); closed = true; } }
  };
}

export function assertCodexSubscriptionRoute(health, capabilities) {
  const route = health?.billingRoute, declared = capabilities?.security?.billingRoute;
  for (const entry of [route, declared]) {
    assert.equal(entry?.mode, 'chatgpt-subscription', 'The real adapter must prove the ChatGPT subscription route');
    assert.equal(entry.verified, true); assert.equal(entry.source, 'codex-login-status');
    assert.match(entry.fingerprint, /^[a-f0-9]{64}$/);
  }
  assert.equal(route.fingerprint, declared.fingerprint, 'Health and adapter route observations must agree');
  return route.fingerprint;
}

export function assertOwnerVerifiedHandoff(task, { operationId, allowedPaths, project, protectedHashes }) {
  assertProtectedFiles(project, protectedHashes);
  assert.equal(task.delegationPolicy?.allowUnknownCost, false);
  assert.equal(task.delegationPolicy?.allowSubscriptionOnly, true);
  assert.deepEqual(task.agentHistory.map(row => row.provider), ['cetamesh', 'codex', 'cetamesh']);
  assert.equal(task.delegationProposal?.selectedProvider, 'codex');
  assert.equal(task.delegationProposal?.state, 'verified'); assert.equal(task.status, 'completed');
  const test = task.executionEvidence.findLast(row => row.capability === 'test.run');
  assert.equal(test?.source, 'core-test'); assert.equal(test.operationId, operationId);
  assert.equal(test.provider, 'cetamesh'); assert.equal(test.sessionId, task.delegationProposal.returnSessionId);
  assert.equal(test.runId, task.delegationProposal.verificationRunId);
  assert.equal(test.status, 'completed'); assert.equal(test.exitCode, 0);
  const imported = task.executionEvidence.filter(row => row.source === 'core-import' && row.status === 'completed');
  assert.ok(imported.length > 0);
  const changes = imported.flatMap(row => row.changes ?? []);
  assert.deepEqual([...new Set(changes.map(row => row.path))].sort(), [...allowedPaths].sort());
  for (const change of changes) {
    assert.equal(change.action, 'write'); assert.equal(acceptanceHash(fs.readFileSync(path.join(project, change.path))), change.sha256);
  }
  return { testEventId: test.eventId, testExitCode: test.exitCode,
    importEventIds: imported.map(row => row.eventId), verification: task.delegationProposal.verification };
}
