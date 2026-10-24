import assert from 'node:assert/strict';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';

let modelCalls = 0;
let toolCalls = 0;
const principal = { taskId: 'task-one', workspaceId: 'workspace-one', actor: { kind: 'agent', id: 'agent-one',
  grants: { taskIds: ['task-one'], workspaceIds: ['workspace-one'], capabilities: ['filesystem.write'] } } };
const runtime = createManagedAgentProvider({
  taskPrincipalResolver: () => principal,
  modelRuntime: { chat: async () => {
    modelCalls++;
    return { text: JSON.stringify({ capability: 'filesystem.write', input: { path: 'result.md', content: 'x' } }) };
  } },
  capabilityExecutor: async () => {
    toolCalls++;
    const error = new Error('Unconfirmed side effect');
    error.code = 'INVOKE_CANCEL_UNCONFIRMED';
    error.effectStatus = 'unknown';
    throw error;
  }
});
try {
  const { sessionId } = await runtime.provider.createSession({});
  const sent = await runtime.provider.send({ sessionId, content: 'Write once' });
  const events = [];
  for await (const event of runtime.provider.follow({ sessionId })) {
    events.push(event);
    if (event.type === 'turn/end' && event.data.requestId === sent.requestId) break;
  }
  assert.equal(toolCalls, 1, 'an uncertain legacy effect must not be replayed');
  assert.equal(modelCalls, 1, 'legacy model must not infer another tool step');
  assert.equal(events.find(event => event.type === 'tool/result')?.data?.status, 'outcome-unknown',
    'TaskFollow needs an observed unknown-effect event');
  assert.equal(events.at(-1)?.data?.reason?.error?.code, 'OUTCOME_UNKNOWN');
  const repeat = await runtime.provider.send({ sessionId, content: 'Try once more' });
  let repeatedEnd;
  for await (const event of runtime.provider.follow({ sessionId })) {
    if (event.type === 'turn/end' && event.data.requestId === repeat.requestId) { repeatedEnd = event; break; }
  }
  assert.equal(repeatedEnd?.data?.reason?.error?.code, 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(modelCalls, 1, 'a later turn must not infer before Owner reconciliation');
  assert.equal(toolCalls, 1);
  console.log('managed fallback outcome unknown: preserved, projected and stopped');
} finally {
  await runtime.close();
}
