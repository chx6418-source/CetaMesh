import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRuntime } from '../src/memory/runtime.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { explicitMemoryCandidate } from '../src/memory/auto-candidate.js';
import { createQqMemoryAdapter } from '../src/memory/adapters/qq.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-phase4-'));
const user = { kind: 'user', id: 'desktop' };
const agent = { kind: 'agent', id: 'chat', grants: { scopes: ['user:desktop'] } };
try {
  const runtime = createMemoryRuntime({ stateDir: root });
  const proposal = { principal: agent, type: 'user', scope: 'user:desktop', content: '我喜欢简洁的中文回答', reason: '用户明确表达偏好' };
  const first = runtime.proposeCandidate(proposal).candidate;
  const duplicate = runtime.proposeCandidate(proposal).candidate;
  assert.equal(duplicate.id, first.id, 'duplicate proposal must share pending candidate');
  const accepted = runtime.confirmCandidate({ principal: user, id: first.id, decision: 'accept' });
  assert.equal(accepted.memory.content, proposal.content);
  assert.equal(runtime.proposeCandidate(proposal).existingMemoryId, accepted.memory.id,
    'accepted unchanged preference is not proposed again');
  const retried = runtime.confirmCandidate({ principal: user, id: first.id, decision: 'accept' });
  assert.equal(retried.memory.id, accepted.memory.id, 'confirmation retry must be idempotent');
  const restarted = createMemoryRuntime({ stateDir: root });
  assert.equal(restarted.confirmCandidate({ principal: user, id: first.id, decision: 'accept' }).memory.id, accepted.memory.id);
  const interrupted = runtime.proposeCandidate({ ...proposal, content: '我偏好深色主题' }).candidate;
  const insert = runtime._store.insert;
  runtime._store.insert = () => { throw Object.assign(new Error('injected disk failure'), { code: 'EIO' }); };
  assert.throws(() => runtime.confirmCandidate({ principal: user, id: interrupted.id, decision: 'accept' }), /injected disk failure/);
  runtime._store.insert = insert;
  const afterCrash = createMemoryRuntime({ stateDir: root });
  assert.equal(afterCrash.listCandidates({ principal: user }).candidates.find(row => row.id === interrupted.id).status, 'confirming');
  assert.deepEqual(afterCrash.recoverConfirmations({ principal: user }).recovered, [interrupted.id]);
  assert.equal(afterCrash.confirmCandidate({ principal: user, id: interrupted.id, decision: 'accept' }).memory.content, '我偏好深色主题');
  const crashWindow = afterCrash.proposeCandidate({ ...proposal, content: '我希望写盘后不会重复创建' }).candidate;
  const normalInsert = afterCrash._store.insert;
  afterCrash._store.insert = record => {
    normalInsert(record);
    throw Object.assign(new Error('simulated crash after Memory write'), { code: 'EIO' });
  };
  assert.throws(() => afterCrash.confirmCandidate({ principal: user, id: crashWindow.id, decision: 'accept' }), /simulated crash/);
  const afterIoCrash = createMemoryRuntime({ stateDir: root });
  assert.deepEqual(afterIoCrash.recoverConfirmations({ principal: user }).recovered, [crashWindow.id]);
  assert.equal(afterIoCrash.list({ principal: user, scope: 'user:desktop', query: '我希望写盘后不会重复创建' }).memories.length, 1);
  const oldRelevant = afterIoCrash.create({ principal: user, type: 'user', scope: 'user:desktop', content: '独特海獭风格的回答偏好' });
  for (let i = 0; i < 505; i += 1) afterIoCrash.create({ principal: user, type: 'user', scope: 'user:desktop', content: `历史偏好 ${i}` });
  const page = afterIoCrash.list({ principal: user, scope: 'user:desktop', limit: 50, offset: 500 });
  assert.equal(page.meta.total, 509);
  assert.equal(page.memories.length, 9);
  assert.equal(page.meta.offset, 500);
  assert.equal(afterIoCrash.retrieve({ principal: user, scope: 'user:desktop', query: '海獭风格', limit: 1 }).memories[0].id,
    oldRelevant.id, 'relevance search reaches records older than the first 500');
  const unicode = '中文😀'.repeat(900);
  const unicodeMemory = afterIoCrash.create({ principal: user, type: 'user', scope: 'user:desktop', content: unicode });
  assert.equal(afterIoCrash.get({ principal: user, id: unicodeMemory.id }).memory.content, unicode);
  const pagingServices = createCetaMeshServices({ stateDir: root, dataRoot: path.join(root, 'paging-data') });
  try {
    const latePage = await pagingServices.desktopUiService.execute({ method: 'ui.memory.overview', params: {
      scope: 'user:desktop', limit: 50, offset: 500 } });
    assert.ok(latePage.total > 500 && latePage.memories.length > 0, 'Harbor pages beyond 500 memories');
    const searched = await pagingServices.desktopUiService.execute({ method: 'ui.memory.overview', params: {
      scope: 'user:desktop', query: '独特海獭风格' } });
    assert.equal(searched.memories[0].id, oldRelevant.id, 'Harbor search reaches old records');
  } finally { pagingServices.chatService.close(); }
  assert.throws(() => afterIoCrash.create({ principal: user, type: 'user', scope: 'user:someone-else',
    content: 'foreign identity' }), error => error.code === 'SCOPE_NOT_AUTHORIZED');
  assert.throws(() => afterIoCrash.create({ principal: user, type: 'user', scope: 'user', content: 'missing identity' }),
    error => error.code === 'INVALID_SCOPE');
  const foreignCandidate = afterIoCrash.proposeCandidate({ principal: { kind: 'agent', id: 'foreign',
    grants: { scopes: ['user:someone-else'] } }, type: 'user', scope: 'user:someone-else',
    content: 'other user preference' }).candidate;
  assert.ok(!afterIoCrash.listCandidates({ principal: user }).candidates.some(row => row.id === foreignCandidate.id));
  assert.throws(() => afterIoCrash.confirmCandidate({ principal: user, id: foreignCandidate.id, decision: 'accept' }),
    error => error.code === 'SCOPE_NOT_AUTHORIZED');
  const legacyState = path.join(root, 'legacy-confirmation');
  const legacyCandidateId = 'cand_legacy_partial';
  writeJsonAtomic(path.join(legacyState, 'memory', 'candidates.json'), { schemaVersion: 1, updatedAt: 1,
    candidates: [{ id: legacyCandidateId, status: 'accepted', type: 'user',
      scope: { kind: 'user', id: 'desktop', key: 'user:desktop' }, content: '历史已批准偏好',
      confirmedContent: '历史已批准偏好', reason: 'fixture', proposedBy: 'agent:chat', proposedAt: 1,
      decidedAt: 2, decidedBy: 'user:desktop', memoryId: null, sourceRefs: [], entityIds: [] }] });
  const legacyRecovered = createCetaMeshServices({ stateDir: legacyState, dataRoot: path.join(root, 'legacy-data') });
  try {
    assert.deepEqual(legacyRecovered.memoryService.recovery.recovered, [legacyCandidateId]);
    assert.equal(legacyRecovered.memoryService.runtime.list({ principal: user, scope: 'user:desktop' }).memories.length, 1);
  } finally { legacyRecovered.chatService.close(); }
  const socialFile = path.join(root, 'social-v2.json');
  const qqSource = { conversations: {
    'group:100': { activeTopics: [{ text: 'group one topic' }], memberImpressions: { Alice: { traits: ['calm'] } } },
    'group:200': { activeTopics: [{ text: 'group two secret' }] }
  } };
  writeJsonAtomic(socialFile, qqSource);
  const qq = createQqMemoryAdapter({ socialV2File: socialFile });
  const qqRuntime = createMemoryRuntime({ stateDir: path.join(root, 'qq-state') });
  assert.equal(qq.importInto({ runtime: qqRuntime, principal: user }).imported, 3);
  const groupTwo = qqRuntime.list({ principal: user, scope: 'chat:qq-group-200' }).memories[0];
  const groupOneAgent = { kind: 'agent', id: 'qq-group-one', grants: { scopes: ['chat:qq-group-100'] } };
  assert.throws(() => qqRuntime.list({ principal: groupOneAgent, scope: 'chat:qq-group-200' }),
    error => error.code === 'SCOPE_NOT_AUTHORIZED');
  qqSource.conversations['group:100'].memberImpressions.Alice.traits = ['patient'];
  qqSource.conversations['group:100'].activeTopics = [];
  writeJsonAtomic(socialFile, qqSource);
  const sync = qq.importInto({ runtime: qqRuntime, principal: user });
  assert.equal(sync.updated, 1);
  assert.equal(sync.deleted, 1);
  assert.equal(qqRuntime.list({ principal: user, scope: 'chat:qq-group-100' }).memories[0].content, 'patient');
  assert.equal(qqRuntime.get({ principal: user, id: groupTwo.id }).memory.content, 'group two secret');
  const edited = qqRuntime.list({ principal: user, scope: 'chat:qq-group-100' }).memories[0];
  qqRuntime.update({ principal: user, id: edited.id, expectedRev: edited.rev, content: 'owner local edit' });
  qqSource.conversations['group:100'].memberImpressions.Alice.traits = ['changed again'];
  writeJsonAtomic(socialFile, qqSource);
  assert.equal(qq.importInto({ runtime: qqRuntime, principal: user }).conflicts, 1);
  assert.equal(qqRuntime.get({ principal: user, id: edited.id }).memory.content, 'owner local edit');
  qqRuntime.update({ principal: user, id: groupTwo.id, expectedRev: groupTwo.rev, pinned: true });
  qqSource.conversations['group:200'].activeTopics = [];
  writeJsonAtomic(socialFile, qqSource);
  assert.equal(qq.importInto({ runtime: qqRuntime, principal: user }).conflicts, 2,
    'Owner-pinned QQ memory is retained when source removes it');
  assert.equal(qqRuntime.get({ principal: user, id: groupTwo.id }).memory.pinned, true);
  fs.renameSync(socialFile, socialFile + '.offline');
  assert.throws(() => qq.importInto({ runtime: qqRuntime, principal: user }), error => error.code === 'ADAPTER_SOURCE_MISSING');
  assert.equal(qqRuntime.get({ principal: user, id: groupTwo.id }).memory.content, 'group two secret');
  fs.renameSync(socialFile + '.offline', socialFile);
  assert.equal(explicitMemoryCandidate('我的密码是 abc123，请记住'), null);
  assert.equal(explicitMemoryCandidate('我喜欢住在某个隐私地点'), null);
  const capacity = createMemoryRuntime({ stateDir: path.join(root, 'capacity-state') });
  const capacityIds = [];
  for (let i = 0; i < 500; i += 1) capacityIds.push(capacity.proposeCandidate({ ...proposal,
    content: `请记住我的偏好编号 ${i}` }).candidate.id);
  assert.equal(capacity.listCandidates({ principal: user, status: 'pending' }).meta.remaining, 0);
  assert.throws(() => capacity.proposeCandidate({ ...proposal, content: '请记住超过容量的新偏好' }),
    error => error.code === 'STORE_FULL');
  const batchService = createCetaMeshServices({ stateDir: path.join(root, 'capacity-state'), dataRoot: path.join(root, 'capacity-data') });
  try {
    const batch = await batchService.desktopUiService.execute({ method: 'ui.memory.candidates.confirmBatch', params: {
      ids: capacityIds.slice(0, 10), decision: 'reject' } });
    assert.equal(batch.results.filter(row => !row.error).length, 10);
    assert.equal(batchService.memoryService.runtime.listCandidates({ principal: user, status: 'pending' }).meta.remaining, 10);
  } finally { batchService.chatService.close(); }
  const services = createCetaMeshServices({ stateDir: path.join(root, 'product-state'), dataRoot: path.join(root, 'product-data') });
  try {
    const seen = [];
    services.modelRegistry.register({ id: 'memory-fixture', label: 'Memory fixture', defaultModel: 'fixture-model',
      supportsTools: false, listModels: async () => [{ id: 'fixture-model' }], health: async () => ({}),
      chat: async () => ({ text: 'unused' }), stream: async function* ({ messages }) {
        seen.push(messages.find(row => row.role === 'system' && row.content.includes('dynamic context'))?.content ?? '');
        yield { type: 'turn/start', data: {} };
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '收到' } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: 'memory-fixture', apiKey: 'fixture-secret-key' });
    await assert.rejects(services.settingsService.execute({ method: 'settings.update', params: {
      section: 'memory', values: { requireConfirmationForLongTerm: false } } }),
    error => error.code === 'LOCKED_SETTING');
    async function chat(text) {
      const session = await services.chatService.execute({ method: 'chat.sessions.create', params: {} });
      await services.chatService.execute({ method: 'chat.config.set', params: { id: session.id,
        config: { modelProvider: 'memory-fixture', model: 'fixture-model', agentProvider: null } } });
      await services.chatService.execute({ method: 'chat.send', params: { id: session.id, text } });
      for (let i = 0; i < 100; i += 1) {
        const status = await services.chatService.execute({ method: 'chat.status', params: { id: session.id } });
        if (status.turn === null) return session.id;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Chat fixture did not finish');
    }
    const chatA = await chat('我喜欢简洁的中文回答。');
    const proposed = (await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates;
    assert.equal(proposed.length, 1, 'completed Chat must propose explicit preference');
    const harbor = await services.desktopUiService.execute({ method: 'ui.memory.overview', params: {} });
    assert.equal(harbor.candidates[0].status, 'pending', 'Harbor receives candidate status');
    await assert.rejects(services.desktopUiService.execute({ method: 'ui.memory.create', params: {
      type: 'user', scope: 'user:desktop', content: 'x'.repeat(4001) } }), error => error.code === 'INVALID_PARAMS');
    await assert.rejects(services.memoryService.execute({ method: 'memory.create', params: {
      type: 'user', scope: 'user:desktop', content: 'x'.repeat(4001) } }), error => error.code === 'INVALID_CONTENT');
    await chat('我喜欢简洁的中文回答。');
    assert.equal((await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates.length, 1);
    const acceptedInApp = await services.desktopUiService.execute({ method: 'ui.memory.candidates.confirm', params: { id: proposed[0].id, decision: 'accept' } });
    await services.chatService.execute({ method: 'chat.sessions.delete', params: { id: chatA } });
    await chat('你记得我的回答偏好吗？');
    assert.ok(seen.at(-1).includes('我喜欢简洁的中文回答'), 'new Chat receives only approved memory');
    const revised = await services.memoryService.execute({ method: 'memory.update', params: {
      id: acceptedInApp.memory.id, expectedRev: 1, content: '我喜欢详细的中文回答' } });
    await chat('你记得我的回答偏好吗？');
    assert.ok(seen.at(-1).includes('我喜欢详细的中文回答') && !seen.at(-1).includes('我喜欢简洁的中文回答'));
    await services.settingsService.execute({ method: 'settings.update', params: { section: 'memory', values: { enabled: false } } });
    const pendingBeforeDisabled = (await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates.length;
    await chat('我偏好深色主题。');
    assert.ok(!seen.at(-1).includes('我喜欢详细的中文回答'), 'disabled Memory is absent from model context');
    assert.equal((await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates.length,
      pendingBeforeDisabled, 'disabled Memory does not propose');
    await services.settingsService.execute({ method: 'settings.update', params: { section: 'memory', values: { enabled: true } } });
    await services.memoryService.execute({ method: 'memory.delete', params: { id: acceptedInApp.memory.id, expectedRev: revised.rev } });
    await chat('你记得我的回答偏好吗？');
    assert.ok(!seen.at(-1).includes('我喜欢详细的中文回答'), 'deleted memory leaves next context');
    await chat('我喜欢使用简短句子。');
    const rejectedCandidate = (await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates.at(-1);
    await services.desktopUiService.execute({ method: 'ui.memory.candidates.confirm', params: { id: rejectedCandidate.id, decision: 'reject' } });
    await chat('你记得我喜欢简短句子吗？');
    assert.ok(!seen.at(-1).includes('我喜欢使用简短句子'), 'rejected candidate never enters model context');
    const scoped = await services.memoryService.execute({ method: 'memory.create', params: {
      type: 'user', scope: 'user:desktop', content: '仅授权给 Task A 的偏好' } });
    const other = await services.memoryService.execute({ method: 'memory.create', params: {
      type: 'user', scope: 'user:desktop', content: 'Task A 未授权的另一条偏好' } });
    await services.settingsService.execute({ method: 'settings.update', params: { section: 'memory', values: { retrievalLimit: 1 } } });
    const globalKnowledge = await services.memoryService.execute({ method: 'memory.create', params: {
      type: 'knowledge', scope: 'global', content: '全局已确认知识：CetaMesh 使用 Owner 审批' } });
    const globalChatContext = await services.productContextService.buildForChatTurn({
      record: { id: 'global-chat', config: {} }, memoryQuery: 'CetaMesh' });
    assert.ok(globalChatContext.context.includes(globalKnowledge.content),
      'ordinary Chat must rank relevant approved global Knowledge across scopes under the retrieval limit');
    await services.memoryService.execute({ method: 'memory.delete', params: {
      id: globalKnowledge.id, expectedRev: globalKnowledge.rev } });
    const capped = await services.productContextService.buildForChatTurn({ record: { id: 'capped-chat', config: {} } });
    assert.equal(JSON.parse(capped.context).memoryReferences.length, 1, 'retrievalLimit controls assembled context');
    await services.settingsService.execute({ method: 'settings.update', params: { section: 'memory', values: { retrievalLimit: 50 } } });
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(workspaceRoot);
    const { workspace } = await services.workspaceService.execute({ method: 'workspace.create', params: { name: 'Memory fixture', root: workspaceRoot } });
    const task = await services.taskService.execute({ method: 'task.create', params: { goal: 'Use one approved memory', workspaceId: workspace.id } });
    const linked = await services.taskService.execute({ method: 'task.memory.link', params: {
      id: task.id, expectedRev: task.rev, memoryId: scoped.id } });
    assert.equal(linked.memoryRefs[0].scope, 'user:desktop');
    assert.equal(linked.memoryRefs[0].authorizedBy, 'user:desktop');
    const actor = services.capabilityService.grantTask(task.id);
    const memoryPrincipal = services.capabilityService.memoryPrincipal(actor);
    assert.deepEqual(services.memoryService.runtime.list({ principal: memoryPrincipal, scope: 'user:desktop' }).memories.map(row => row.id), [scoped.id]);
    assert.throws(() => services.memoryService.runtime.get({ principal: memoryPrincipal, id: other.id }), error => error.code === 'MEMORY_NOT_FOUND');
    assert.throws(() => services.memoryService.runtime.resolveReferences({ principal: memoryPrincipal,
      sourceScope: `task:${task.id}`, refs: [{ kind: 'memory', id: other.id, scope: 'user:desktop' }],
      explicitCrossScope: true }), error => !String(error.message).includes(other.content),
    'cross-scope link lookup cannot bypass exact ID grant');
    const taskSource = await services.memoryService.execute({ method: 'memory.create', params: {
      type: 'task', scope: `task:${task.id}`, content: 'Task reference anchor' } });
    services.memoryService.runtime.createLink({ principal: user,
      source: { kind: 'memory', id: taskSource.id, scope: `task:${task.id}` },
      target: { kind: 'memory', id: other.id, scope: 'user:desktop' }, relation: 'related-to', explicit: true });
    assert.throws(() => services.memoryService.runtime.resolveReferences({ principal: memoryPrincipal,
      sourceScope: `task:${task.id}`, refs: [{ kind: 'memory', id: other.id, scope: 'user:desktop' }],
      explicitCrossScope: true }), error => !String(error.message).includes(other.content),
    'an explicit cross-scope link alone does not grant an unlinked User record');
    const attached = services.taskService.runtime.attachAgent({ id: task.id, expectedRev: linked.rev,
      provider: 'cetamesh', sessionId: 'memory-agent-session' });
    assert.equal(attached.task.currentAgent.sessionId, 'memory-agent-session');
    const agentSnapshot = await services.productContextService.buildForAgentTurn({
      provider: 'cetamesh', sessionId: 'memory-agent-session',
      principal: { taskId: task.id, workspaceId: workspace.id, expectedWorkspaceId: workspace.id, actor } });
    assert.ok(agentSnapshot.context.includes('仅授权给 Task A 的偏好'));
    assert.ok(!agentSnapshot.context.includes('Task A 未授权的另一条偏好'));
    const packet = services.continuityService.runtime.buildHandoffPacket({ taskId: task.id,
      reason: 'fixture handoff', sequence: 1, workspaceFacts: {} });
    assert.equal(packet.memoryRefs[0].scope, 'user:desktop');
    assert.equal(packet.memoryRefs[0].authorizedBy, 'user:desktop');
    const handoff = services.taskService.runtime.attachAgent({ id: task.id, expectedRev: attached.task.rev,
      provider: 'cetamesh', sessionId: 'memory-agent-after-handoff' });
    assert.equal(handoff.task.id, task.id);
    const resumedSnapshot = await services.productContextService.buildForAgentTurn({ provider: 'cetamesh',
      sessionId: 'memory-agent-after-handoff', principal: { taskId: task.id, workspaceId: workspace.id,
        expectedWorkspaceId: workspace.id, actor } });
    assert.ok(resumedSnapshot.context.includes('仅授权给 Task A 的偏好'));
    assert.ok(!resumedSnapshot.context.includes('Task A 未授权的另一条偏好'));
    const taskB = await services.taskService.execute({ method: 'task.create', params: { goal: 'Task B', workspaceId: workspace.id } });
    const actorB = services.capabilityService.grantTask(taskB.id);
    assert.throws(() => services.memoryService.runtime.list({ principal: services.capabilityService.memoryPrincipal(actorB),
      scope: 'user:desktop' }), error => error.code === 'SCOPE_NOT_AUTHORIZED');
    const managedContexts = [];
    services.modelRegistry.register({ id: 'memory-agent-fixture', label: 'Managed memory fixture', defaultModel: 'fixture-model',
      supportsTools: false, listModels: async () => [{ id: 'fixture-model' }], health: async () => ({}),
      chat: async () => ({ text: JSON.stringify({ final: '任务完成' }) }),
      stream: async function* ({ messages }) {
        managedContexts.push(messages.find(row => row.role === 'system' && row.content.includes('dynamic context'))?.content ?? '');
        yield { type: 'turn/start', data: {} };
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '任务完成' } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: 'memory-agent-fixture', apiKey: 'fixture-secret-key' });
    const managedA = await services.managedAgent.provider.createSession({ modelProvider: 'memory-agent-fixture', model: 'fixture-model' });
    services.managedAgent.bindSession(managedA.sessionId, { taskId: task.id, workspaceId: workspace.id, actor });
    services.taskService.runtime.attachAgent({ id: task.id, expectedRev: handoff.task.rev,
      provider: 'cetamesh', sessionId: managedA.sessionId });
    const managedATurn = await services.managedAgent.provider.send({ sessionId: managedA.sessionId, content: task.goal });
    const managedAController = new AbortController();
    for await (const event of services.managedAgent.provider.follow({ sessionId: managedA.sessionId, signal: managedAController.signal })) {
      if (event.type === 'turn/end' && event.data.requestId === managedATurn.requestId) { managedAController.abort(); break; }
    }
    assert.ok(managedContexts[0].includes('仅授权给 Task A 的偏好'));
    assert.ok(!managedContexts[0].includes('Task A 未授权的另一条偏好'));
    const taskC = await services.taskService.execute({ method: 'task.create', params: {
      goal: '请记住我的长期偏好是使用中文交流。', workspaceId: workspace.id } });
    const actorC = services.capabilityService.grantTask(taskC.id);
    const agentSession = await services.managedAgent.provider.createSession({ modelProvider: 'memory-agent-fixture', model: 'fixture-model' });
    services.managedAgent.bindSession(agentSession.sessionId, { taskId: taskC.id, workspaceId: workspace.id, actor: actorC });
    services.taskService.runtime.attachAgent({ id: taskC.id, expectedRev: taskC.rev, provider: 'cetamesh', sessionId: agentSession.sessionId });
    const acceptedTurn = await services.managedAgent.provider.send({ sessionId: agentSession.sessionId, content: taskC.goal });
    const controller = new AbortController();
    const agentEvents = [];
    for await (const event of services.managedAgent.provider.follow({ sessionId: agentSession.sessionId, signal: controller.signal })) {
      agentEvents.push(event);
      if (event.type === 'turn/end' && event.data.requestId === acceptedTurn.requestId) { controller.abort(); break; }
    }
    assert.equal(agentEvents.at(-1)?.data?.reason?.kind, 'completed', JSON.stringify(agentEvents.at(-1)?.data));
    for (let attempt = 0; attempt < 50; attempt++) {
      const pending = (await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates;
      if (pending.some(row => row.content.includes('长期偏好'))) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok((await services.memoryService.execute({ method: 'memory.candidates.list', params: { status: 'pending' } })).candidates
      .some(row => row.content.includes('长期偏好')), 'Managed Agent completed a trusted Task and proposed its explicit preference');
    console.log('PASS production assembly Chat proposal, confirmation, retrieval, and deletion');
  } finally { services.chatService.close(); }
  const relaunched = createCetaMeshServices({ stateDir: path.join(root, 'product-state'), dataRoot: path.join(root, 'product-data') });
  try {
    const snapshot = await relaunched.productContextService.buildForChatTurn({
      record: { id: 'new-chat-after-restart', config: { mode: 'chat' } }, memoryQuery: '仅授权给 Task A 的偏好' });
    assert.ok(snapshot.context.includes('仅授权给 Task A 的偏好'), 'approved Memory persists across Core restart');
    assert.ok(!snapshot.context.includes('我喜欢使用简短句子'), 'rejected Memory stays excluded after restart');
    let relaunchContext = '';
    relaunched.modelRegistry.register({ id: 'memory-relaunch-fixture', label: 'Relaunch fixture', defaultModel: 'fixture-model',
      supportsTools: false, listModels: async () => [{ id: 'fixture-model' }], health: async () => ({}),
      chat: async () => ({ text: 'unused' }), stream: async function* ({ messages }) {
        relaunchContext = messages.find(row => row.role === 'system' && row.content.includes('dynamic context'))?.content ?? '';
        yield { type: 'turn/start', data: {} };
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: relaunchContext.includes('仅授权给 Task A 的偏好') ? '记得已批准偏好' : '没有记忆' } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    relaunched.providerSecrets.set({ provider: 'memory-relaunch-fixture', apiKey: 'fixture-secret-key' });
    const chatB = await relaunched.chatService.execute({ method: 'chat.sessions.create', params: {} });
    await relaunched.chatService.execute({ method: 'chat.config.set', params: { id: chatB.id,
      config: { modelProvider: 'memory-relaunch-fixture', model: 'fixture-model', agentProvider: null } } });
    await relaunched.chatService.execute({ method: 'chat.send', params: { id: chatB.id, text: '你记得已批准的偏好吗？' } });
    for (let i = 0; i < 100; i += 1) {
      if ((await relaunched.chatService.execute({ method: 'chat.status', params: { id: chatB.id } })).turn === null) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const historyB = await relaunched.chatService.execute({ method: 'chat.history', params: { id: chatB.id } });
    assert.ok(relaunchContext.includes('仅授权给 Task A 的偏好'));
    assert.ok(historyB.messages.some(row => row.role === 'assistant' && row.text.includes('记得已批准偏好')));
  } finally { relaunched.chatService.close(); }
  const corruptState = path.join(root, 'corrupt-state');
  fs.mkdirSync(path.join(corruptState, 'memory'), { recursive: true });
  const corruptFile = path.join(corruptState, 'memory', 'memories.json');
  fs.writeFileSync(corruptFile, '{bad memory json', 'utf8');
  const corrupted = createCetaMeshServices({ stateDir: corruptState, dataRoot: path.join(root, 'corrupt-data') });
  try {
    const context = await corrupted.productContextService.buildForChatTurn({ record: { id: 'safe-chat', config: {} } });
    assert.ok(context.context.includes('CetaMesh'));
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{bad memory json', 'corrupt source is never overwritten');
  } finally { corrupted.chatService.close(); }
  console.log('PASS Phase 4 Memory candidate idempotence, restart, and pagination');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
