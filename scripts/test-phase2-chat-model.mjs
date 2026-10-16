import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelProviderRegistry } from '../src/model/registry.js';
import { createModelRuntimeService } from '../src/model/service.js';
import { createOpenAiCompatibleModelProvider } from '../src/model/providers/openai-compatible.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { readFile, fileSearch } from '../src/workspace/tools.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-phase2-'));
try {
  const provider = { id: 'fixture', label: 'Fixture', defaultModel: 'fixture-model', supportsTools: true,
    listModels: async () => [], health: async () => ({}), stream: async function* () {},
    chat: async () => ({ text: 'ok' }) };
  const runtime = createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [provider] }),
    secrets: { list: () => [{ provider: 'fixture' }] } });
  assert.equal(runtime.supportsToolCalling(null), true, 'default provider resolves for tool capability');
  assert.equal((await runtime.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ id: 'read' }] })).toolCalling, 'supported');
  const catalogProvider = createOpenAiCompatibleModelProvider({ id: 'catalog-fixture', label: 'Catalog Fixture',
    baseUrl: 'https://example.invalid', secrets: { raw: () => ({ apiKey: 'fixture-secret' }) }, supportsTools: true,
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: 'with-tools', capabilities: { tools: true, streaming: true, reasoning: false } },
      { id: 'text-only', capabilities: { tools: false, streaming: true, reasoning: false } }
    ] }), { headers: { 'content-type': 'application/json' } }) });
  const catalog = await catalogProvider.listModels();
  assert.equal(catalog.find(row => row.id === 'text-only').toolCalling, 'unsupported');
  assert.equal(catalogProvider.supportsToolsForModel('text-only'), false);
  assert.equal(catalogProvider.supportsToolsForModel('with-tools'), true);

  fs.writeFileSync(path.join(root, 'hello.ts'), 'const greeting = "你好😀";\nexport { greeting };\n');
  fs.writeFileSync(path.join(root, 'utf16.txt'), '\ufeff中文😀', 'utf16le');
  fs.writeFileSync(path.join(root, 'gb18030.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  fs.writeFileSync(path.join(root, 'secrets.txt'), 'greeting private');
  const longUnicode = '代码😀'.repeat(3000);
  fs.writeFileSync(path.join(root, 'long-unicode.ts'), longUnicode);
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
  assert.match(readFile(root, 'utf16.txt').content, /中文😀/);
  assert.equal(readFile(root, 'gb18030.txt').content, '中文');
  assert.equal(readFile(root, 'binary.dat').binary, true);
  let reconstructed = ''; let readOffset = 0;
  do {
    const page = readFile(root, 'long-unicode.ts', { maxBytes: 8192, offset: readOffset });
    assert.equal(page.binary, false);
    reconstructed += page.content;
    readOffset = page.nextOffset;
  } while (readOffset !== null);
  assert.equal(reconstructed, longUnicode, 'UTF-8 and emoji pages reconstruct the original source');
  const found = fileSearch(root, { query: 'greeting', limit: 10 });
  assert.ok(found.results.some(row => row.path === 'hello.ts' && row.line === 1));
  assert.ok(!fileSearch(root, { query: 'greeting', restricted: true }).results.some(row => row.path === 'secrets.txt'));
  assert.equal(fileSearch(root, { query: 'greeting', limit: 1, offset: 1 }).results.length, 1);

  for (const count of [1, 8, 9, 16]) {
    let calls = 0;
    let modelCycles = 0;
    const coordinator = createToolExecutionCoordinator({ modelRuntime: {
      supportsToolCalling: () => true,
      chat: async () => ({ text: 'done', toolCalls: [] }),
      stream: async function* () {
        if (modelCycles++ === 0) yield { type: 'assistant/tool-calls', data: { toolCalls: Array.from({ length: count }, (_, i) => ({
          id: `c${i}`, capabilityId: 'fixture.read', arguments: '{}'
        })) } };
        else yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'done' } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      }
    }, capabilityBroker: { execute: async () => { calls++; return { status: 'completed', result: { value: '中文😀'.repeat(5000) } }; } },
      maxCycles: 2, maxBatchCalls: 8 });
    const result = await coordinator.run({ providerId: 'fixture', messages: [{ role: 'user', content: 'read' }],
      manifest: [{ id: 'fixture.read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
      actor: { kind: 'owner', id: 'owner' }, sessionId: 's', turnId: `t${count}` });
    assert.equal(calls, Math.min(count, 8));
    assert.equal(result.status, count > 8 ? 'partial' : 'completed', `${count} calls must preserve completion truth`);
    const toolRows = result.messages.filter(message => message.role === 'tool');
    assert.equal(toolRows.length, count);
    for (const item of toolRows) {
      const parsed = JSON.parse(item.content);
      assert.ok(item.content.length <= 12000);
      if (parsed.truncated) assert.match(parsed.preview, /中文/);
    }
  }

  const services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') });
  try {
    const workspace = await services.workspaceService.execute({ method: 'workspace.create', params: { name: 'Phase 2 TS', root } });
    const searched = await services.workspaceService.execute({ method: 'workspace.file.search', params: {
      id: workspace.workspace.id, query: 'greeting', path: '.', maxResults: 10
    } });
    assert.ok(searched.results.some(row => row.path === 'hello.ts' && row.line === 1));
    const searchTask = services.taskService.runtime.create({ goal: 'Search authorized source', workspaceId: workspace.workspace.id });
    const searchAgent = services.capabilityService.grantTask(searchTask.id, { capabilities: ['filesystem.search', 'filesystem.read'] });
    const restricted = await services.capabilityService.broker.execute({ requestId: 'phase2-agent-safe-search',
      actor: searchAgent, taskId: searchTask.id, workspaceId: workspace.workspace.id,
      capability: 'filesystem.search', input: { query: 'greeting', maxResults: 20 },
      reason: 'Phase 2 Agent search boundary regression' });
    assert.equal(restricted.status, 'completed');
    assert.ok(!restricted.result.results.some(row => row.path === 'secrets.txt'));
    const firstRead = await services.capabilityService.broker.execute({ requestId: 'phase2-agent-read-page',
      actor: searchAgent, taskId: searchTask.id, workspaceId: workspace.workspace.id,
      capability: 'filesystem.read', input: { path: 'long-unicode.ts' }, reason: 'Phase 2 paged read' });
    assert.equal(firstRead.status, 'completed');
    assert.ok(firstRead.result.nextOffset > 0 && firstRead.result.nextOffset < Buffer.byteLength(longUnicode));
    const realTsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop-ui/src');
    const realProject = await services.workspaceService.execute({ method: 'workspace.create', params: {
      name: 'Harbor TypeScript source', root: realTsRoot
    } });
    const sourceMatches = await services.capabilityService.broker.execute({
      requestId: 'phase2-search-real-ts', actor: OWNER_ACTOR, workspaceId: realProject.workspace.id,
      capability: 'filesystem.search', input: { path: 'app', query: 'mergeLatestChatMessages', maxResults: 20 },
      reason: 'Phase 2 Workspace regression'
    });
    assert.equal(sourceMatches.status, 'completed');
    assert.ok(sourceMatches.result.results.some(row => row.path === 'app/chat-history.ts' && row.line > 0),
      'production Workspace search analyzes the real Harbor TypeScript source');
    const deltas = [];
    services.modelRegistry.register({ id: 'phase2-fixture', label: 'Phase 2 Fixture', defaultModel: 'fixture-model',
      supportsTools: false, listModels: async () => [{ id: 'fixture-model' }], health: async () => ({}),
      chat: async () => ({ text: 'unused' }),
      stream: async function* ({ messages }) {
        const answer = `reply:${messages.at(-1).content}`;
        yield { type: 'turn/start', data: {} };
        if (answer === 'reply:second') await new Promise(resolve => setTimeout(resolve, 30));
        for (const piece of [answer.slice(0, 4), answer.slice(4)]) {
          deltas.push(piece);
          yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: piece } } };
        }
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: 'phase2-fixture', apiKey: 'fixture-secret-key' });
    const session = await services.chatService.execute({ method: 'chat.sessions.create', params: {} });
    await services.chatService.execute({ method: 'chat.config.set', params: { id: session.id,
      config: { modelProvider: 'phase2-fixture', model: 'fixture-model', agentProvider: null } } });
    for (const question of ['first', 'second', 'third']) {
      await services.chatService.execute({ method: 'chat.send', params: { id: session.id, text: question,
        ...(question === 'first' ? { clientMessageId: 'phase2-first-0001' } : {}) } });
      if (question === 'second') {
        services.chatService._injectEvent(session.id, { type: 'assistant/chunk', data: {
          sessionId: 'an-old-agent-session', chunk: { type: 'text-delta', text: 'stale' }
        } });
        services.chatService._injectEvent(session.id, { type: 'turn/end', data: {
          sessionId: 'an-old-agent-session', reason: { kind: 'completed' }
        } });
      }
      let idle = false;
      for (let attempt = 0; attempt < 100 && !idle; attempt++) {
        idle = (await services.chatService.execute({ method: 'chat.status', params: { id: session.id } })).turn === null;
        if (!idle) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(idle, true, `production Chat completed ${question}`);
      if (question === 'first') {
        // Simulate a lost UI ACK by discarding it and retrying with the same durable ID.
        await services.chatService.execute({ method: 'chat.send', params: {
          id: session.id, text: question, clientMessageId: 'phase2-first-0001'
        } });
        services.chatService._injectEvent(session.id, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      }
    }
    const history = await services.chatService.execute({ method: 'chat.history', params: { id: session.id, limit: 20 } });
    assert.deepEqual(history.messages.filter(row => row.role === 'assistant').map(row => row.text),
      ['reply:first', 'reply:second', 'reply:third']);
    assert.equal(deltas.length, 6, 'production composed Chat streamed distinct text deltas');
  } finally {
    services.chatService.close();
  }
  console.log('Phase 2 Model and Workspace regressions PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
