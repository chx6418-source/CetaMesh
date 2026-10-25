import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-tool-unknown-'));
try {
  let modelCalls = 0;
  let brokerCalls = 0;
  const observed = [];
  const coordinator = createToolExecutionCoordinator({
    stateDir,
    modelRuntime: { chat: async () => {
      modelCalls++;
      return { toolCalls: [
        { id: 'write-1', capabilityId: 'filesystem.write', arguments: { path: 'result.md', content: 'x' } },
        { id: 'write-2', capabilityId: 'filesystem.write', arguments: { path: 'result.md', content: 'x' } }
      ] };
    } },
    capabilityBroker: { execute: async () => {
      brokerCalls++;
      const error = new Error('Cancellation did not confirm the side effect');
      error.code = 'INVOKE_CANCEL_UNCONFIRMED';
      error.effectStatus = 'unknown';
      throw error;
    } }
  });
  const result = await coordinator.run({ actor: { kind: 'agent', id: 'agent-one' },
    sessionId: 'session-one', turnId: 'turn-one', scope: { taskId: 'task-one', workspaceId: 'workspace-one' },
    messages: [{ role: 'user', content: 'Write the file once' }],
    manifest: [{ id: 'filesystem.write', description: 'Write file', inputSchema: { type: 'object', additionalProperties: true } }],
    onCapabilityResult: event => observed.push(event)
  });
  assert.equal(observed[0]?.result?.status, 'outcome-unknown', 'unknown effect must remain distinct from denial');
  assert.equal(brokerCalls, 1, 'an uncertain write must not be automatically repeated');
  assert.equal(modelCalls, 1, 'the model must not start a recovery turn after an uncertain side effect');
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(coordinator.recoveryForTask('task-one')?.state, 'needs-reconciliation',
    'a later turn must see the unresolved side effect');
  await assert.rejects(coordinator.run({ actor: { kind: 'agent', id: 'agent-one' },
    sessionId: 'session-one', turnId: 'turn-two', scope: { taskId: 'task-one', workspaceId: 'workspace-one' },
    messages: [{ role: 'user', content: 'Try again' }],
    manifest: [{ id: 'filesystem.write', description: 'Write file', inputSchema: { type: 'object', additionalProperties: true } }]
  }), error => error.code === 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(brokerCalls, 1, 'a subsequent turn cannot replay before reconciliation');
  assert.equal(coordinator.acknowledgeTaskRecovery('task-one').reconciled, 1,
    'Owner review may explicitly reconcile the original dispatch');
  assert.equal(coordinator.recoveryForTask('task-one'), null);
  console.log('tool outcome unknown: one dispatch, no automatic replay, review required');
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
