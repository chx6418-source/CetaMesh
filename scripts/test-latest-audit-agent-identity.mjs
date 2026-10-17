import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-agent-identity-'));
const services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') });
try {
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const { workspace } = await services.workspaceService.execute({ method: 'workspace.create',
    params: { name: 'Agent identity regression', root: workspaceRoot } });
  const task = services.taskService.runtime.create({ goal: 'First instruction', workspaceId: workspace.id });
  services.providerSecrets.set({ provider: 'deepseek-official', apiKey: 'local-identity-fixture' });
  const originalStream = services.modelRuntime.stream;
  let modelTurn = 0;
  services.modelRuntime.stream = async function* () {
    modelTurn += 1;
    yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `Result ${modelTurn}` }] } } };
    yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
  };
  try {
    const run = requestId => services.capabilityService.broker.execute({ requestId, actor: OWNER_ACTOR,
      taskId: task.id, workspaceId: workspace.id, capability: 'agent.run',
      input: { agentProvider: 'cetamesh', content: 'First instruction' } });
    const first = await run('identity-first');
    assert.equal(first.status, 'completed');
    assert.match(first.result.requestId, /^[0-9a-f-]{36}$/i,
      'production capability result must return the actual Managed Agent request ID');
    const second = await services.capabilityService.broker.execute({ requestId: 'identity-second', actor: OWNER_ACTOR,
      taskId: task.id, workspaceId: workspace.id, capability: 'agent.run',
      input: { agentProvider: 'cetamesh', content: 'Second instruction' } });
    assert.equal(second.result.reused, true);
    assert.match(second.result.requestId, /^[0-9a-f-]{36}$/i,
      'reused Task sessions must return the new turn identity');
    assert.notEqual(second.result.requestId, first.result.requestId);
    const retried = await run('identity-first');
    assert.equal(retried.result.requestId, first.result.requestId,
      'idempotent retries retain the original provider turn identity');
    const directStarted = Date.now();
    while (modelTurn < 2) {
      if (Date.now() - directStarted > 3000) throw new Error('Direct Agent turns did not finish');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    console.log('PASS production Agent capability preserves provider request identity');

    const chatWorkspaceRoot = path.join(root, 'chat-workspace');
    fs.mkdirSync(chatWorkspaceRoot);
    const { workspace: chatWorkspace } = await services.workspaceService.execute({ method: 'workspace.create',
      params: { name: 'Three Smart turns', root: chatWorkspaceRoot } });
    const chat = await services.chatService.execute({ method: 'chat.sessions.create', params: {} });
    await services.chatService.execute({ method: 'chat.config.set', params: { id: chat.id,
      config: { mode: 'smart', agentProvider: 'cetamesh', workspaceId: chatWorkspace.id } } });
    const prompts = ['分析项目中的第一个问题', '分析项目中的第二个问题', '分析项目中的第三个问题'];
    for (let index = 0; index < prompts.length; index += 1) {
      await services.chatService.execute({ method: 'chat.send', params: { id: chat.id, text: prompts[index] } });
      const started = Date.now();
      while ((await services.chatService.execute({ method: 'chat.status', params: { id: chat.id } })).turn) {
        if (Date.now() - started > 3000) throw new Error(`Smart Agent turn ${index + 1} did not finish`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const history = await services.chatService.execute({ method: 'chat.history', params: { id: chat.id } });
      const assistants = history.messages.filter(message => message.role === 'assistant');
      assert.equal(assistants.length, index + 1, 'each Smart Agent turn must produce one assistant message');
      assert.equal(assistants[index].text, `Result ${index + 3}`,
        `Chat must consume the matching Managed Agent turn: ${JSON.stringify({ assistant: assistants[index], modelTurn })}`);
    }
    console.log('PASS production Smart Chat correlates three distinct Agent turns');
  } finally {
    services.modelRuntime.stream = originalStream;
  }
} finally {
  await services.close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
