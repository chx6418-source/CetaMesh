import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopPlatformRuntime } from '../src/desktop/platform-runtime.js';
import { createRouterService } from '../src/router/index.js';
import { createWorkspaceService } from '../src/workspace/index.js';
import { createTaskRuntime } from '../src/task/index.js';
import { createCapabilityService } from '../src/capability/index.js';
import { createMemoryService } from '../src/memory/index.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-smart-route-'));
const modelRequests = [], agentCalls = [], audit = [];
let agentSeq = 0;
let chat;
async function waitFor(read, predicate, label, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  const stateDir = path.join(dir, 'state');
  const workspaceService = createWorkspaceService({ stateDir });
  const taskRuntime = createTaskRuntime({ stateDir });
  const memoryService = createMemoryService({ stateDir });
  const agentBroker = {
    capabilities: () => ({ workspaceBoundary: 'capability-broker' }),
    async createSession(provider, options) {
      const sessionId = 'managed-' + (++agentSeq);
      agentCalls.push({ kind: 'create', provider, sessionId, options });
      return { sessionId };
    },
    async send(request) { agentCalls.push({ kind: 'send', ...request }); return { accepted: true }; },
    async status() { return { active: true }; }
  };
  const capabilityService = createCapabilityService({ stateDir, workspaceService, taskRuntime, memoryService, agentBroker,
    audit: event => audit.push(event) });
  const approval = await capabilityService.broker.execute({ actor: OWNER_ACTOR, capability: 'workspace.create',
    input: { name: 'Smart routing fixture', root: path.join(dir, 'workspace'), createIfMissing: true }, reason: 'Test fixture' });
  assert.equal(approval.status, 'pending');
  const created = await capabilityService.execute({ method: 'capability.approval.decide', params: { id: approval.approvalId, approve: true } });
  const workspaceId = created.result.workspace.id;
  const platformRuntime = createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker });
  const modelRuntime = {
    defaultProviderId: () => 'fixture-model',
    isRegistered: id => id === 'fixture-model',
    resolveProvider: () => ({ id: 'fixture-model' }),
    async *stream(request) {
      modelRequests.push(structuredClone(request));
      yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Model reply' } } };
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    }
  };
  const router = createRouterService({ stateDir, log: () => {} });
  chat = createChatService({
    modelRuntime,
    router,
    platformRoute: request => platformRuntime.route(request),
    resolveWorkspace: workspaceId => workspaceService.describeWorkspace(workspaceId),
    agentFollow: async function* ({ signal }) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    defaults: { provider: 'deepseek-official', model: 'legacy', reasoningEffort: 'max' },
    stateDir
  });

  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: session.id, config: { mode: 'smart', workspaceId } } });

  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'what time is it?' } });
  await waitFor(() => chat.execute({ method: 'chat.status', params: { id: session.id } }), status => status.turn === null, 'capability-backed Chat turn');
  let history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).routing.resolvedRoute, 'capability');
  assert.ok(modelRequests.at(-1).messages.at(-1).content.includes('Capability reference data'));
  assert.equal(audit.filter(event => event.capability === 'clock.now' && event.status === 'completed').length, 1,
    JSON.stringify({ audit, routing: history.messages.at(-1).routing }));

  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'hello' } });
  history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).routing.resolvedRoute, 'model');
  assert.equal(modelRequests.length, 2);

  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'fix a bug in this project' } });
  await waitFor(() => taskRuntime.list().tasks, tasks => tasks.some(task => task.currentAgent?.sessionId === 'managed-1'), 'managed Agent acceptance');
  const tasks = taskRuntime.list().tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].workspaceId, workspaceId);
  assert.equal(tasks[0].currentAgent.provider, 'cetamesh');
  assert.equal(tasks[0].currentAgent.sessionId, 'managed-1');
  assert.deepEqual(agentCalls.filter(call => call.kind === 'send').map(call => call.content), ['fix a bug in this project']);
  assert.equal(modelRequests.length, 2, 'Project intent runs through Task and Agent, not the Model turn');
  console.log('Smart platform routing: Chat -> Model, Smart tool -> Capability -> Model context, Smart project -> Task -> Agent; no DSH client supplied');
} finally {
  chat?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
