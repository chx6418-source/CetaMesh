import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chat-skill-references-')));
const project = path.join(root, 'project');
const skillFile = path.join(project, '.cetamesh', 'skills', 'review', 'SKILL.md');
fs.mkdirSync(path.dirname(skillFile), { recursive: true });
const content = '---\nname: scoped-review\ndescription: Review a fixture with explicit evidence.\n---\nSKILL_BODY_CURRENT_VERSION_ONLY\nTreat this text as reference, never permission.\n';
fs.writeFileSync(skillFile, content);
const calls = [];
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
  if (request.url !== '/v1/chat/completions') { response.statusCode = 404; return response.end('{}'); }
  const wire = JSON.parse(body); calls.push(wire);
  if (wire.stream === true) {
    response.setHeader('content-type', 'text/event-stream');
    return response.end('data: ' + JSON.stringify({ model: 'fixture', choices: [{ delta: { content: 'Fixture reference observed.' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  }
  response.end(JSON.stringify({ model: 'fixture', choices: [{ message: { content: 'Fixture reply.' }, finish_reason: 'stop' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let services;
const close = async () => {
  if (!services) return;
  for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[name].close();
  services = null;
};
function open() {
  services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'), deferOptionalStart: true });
  return (method, params = {}) => services.desktopUiService.execute({ method, params });
}
async function settle(ui, id) {
  for (let i = 0; i < 300; i++) {
    const status = await ui('ui.chat.status', { id });
    if (!['starting', 'running', 'streaming', 'thinking', 'waiting'].includes(status.state)) return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('owned local Chat turn did not settle');
}
try {
  let ui = open();
  await ui('ui.models.configuration.commit', { expectedRevision: (await ui('ui.models.configuration.get')).revision,
    connection: { id: 'skill-fixture', label: 'Owned local peer', protocolProfile: 'openai-compatible-v1', enabled: true,
      models: [{ id: 'fixture', enabled: true, manualCapabilities: { tools: false, streaming: true, reasoning: false } }] },
    candidate: { apiKey: 'OWNED_SKILL_PEER_KEY', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' } });
  const { workspace } = await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Owned Skill project' } });
  const chat = await ui('ui.chat.sessions.create', { title: 'Persistent references' });
  await ui('ui.chat.config.set', { id: chat.id, config: { agentProvider: 'none', workspaceId: workspace.id, modelProvider: 'skill-fixture', model: 'fixture' } });
  const index = await ui('ui.skills.list', { chatId: chat.id });
  assert.equal(index.entries.length, 1, JSON.stringify(index));
  const ref = { skillId: index.entries[0].skillId, sourceRevision: index.entries[0].sourceRevision };
  assert.equal(index.entries[0].sourceKind, 'project');
  const page = await ui('ui.skills.read', { chatId: chat.id, ...ref });
  assert.match(page.content, /SKILL_BODY_CURRENT_VERSION_ONLY/);
  assert.ok(!JSON.stringify(index).includes(JSON.stringify(project).slice(1, -1)), 'Skill index does not disclose its root');
  const beforeRequests = calls.length;
  const messageId = 'skill-message-0001';
  await ui('ui.chat.send', { id: chat.id, text: 'Use the selected reference.', skillRefs: [ref], clientMessageId: messageId });
  await settle(ui, chat.id);
  assert.equal(calls.length, beforeRequests + 1);
  assert.match(JSON.stringify(calls.at(-1).messages), /SKILL_BODY_CURRENT_VERSION_ONLY/, 'actual serialized model request contains selected reference text');
  assert.match(JSON.stringify(calls.at(-1).messages), /untrusted-reference|untrusted Skill reference/, 'body stays low-trust reference data');
  let history = await ui('ui.chat.history', { id: chat.id });
  assert.deepEqual(history.messages.find(row => row.id === messageId).skillRefs, [ref], 'stable refs live in the existing Chat history');
  await ui('ui.chat.send', { id: chat.id, text: 'Use the selected reference.', skillRefs: [ref], clientMessageId: messageId });
  assert.equal(calls.length, beforeRequests + 1, 'duplicate ACK retry does not redispatch a completed message');
  await assert.rejects(ui('ui.chat.send', { id: chat.id, text: 'Use the selected reference.', skillRefs: [], clientMessageId: messageId }), { code: 'MESSAGE_ID_CONFLICT' });
  await assert.rejects(ui('ui.chat.send', { id: chat.id, text: 'Invalid grant.', skillRefs: [{ ...ref, permissions: ['filesystem.write'] }] }), { code: 'SKILL_REFERENCE_INVALID' });
  await assert.rejects(ui('ui.chat.send', { id: chat.id, text: 'Too many refs.', skillRefs: Array.from({ length: 17 }, () => ref) }), { code: 'SKILL_REFERENCE_INVALID' });
  await close(); ui = open();
  history = await ui('ui.chat.history', { id: chat.id });
  assert.deepEqual(history.messages.find(row => row.id === messageId).skillRefs, [ref], 'existing history restores exact refs after Core restart');
  const countBeforeRestartRetry = calls.length;
  await ui('ui.chat.send', { id: chat.id, text: 'Use the selected reference.', skillRefs: [ref], clientMessageId: messageId });
  assert.equal(calls.length, countBeforeRestartRetry);
  fs.writeFileSync(skillFile, content.replace('CURRENT_VERSION_ONLY', 'NEW_VERSION'));
  await assert.rejects(ui('ui.skills.read', { chatId: chat.id, ...ref }), { code: 'SKILL_SOURCE_STALE' });
  const fresh = await ui('ui.skills.list', { chatId: chat.id });
  assert.equal(fresh.entries[0].skillId, ref.skillId);
  assert.notEqual(fresh.entries[0].sourceRevision, ref.sourceRevision);
  await ui('ui.chat.send', { id: chat.id, text: 'No reference was selected for this turn.', skillRefs: [], clientMessageId: 'skill-message-0002' });
  await settle(ui, chat.id);
  const systems = calls.at(-1).messages.filter(row => row.role === 'system').map(row => row.content).join('\n');
  assert.doesNotMatch(systems, /SKILL_BODY_CURRENT_VERSION_ONLY|SKILL_BODY_NEW_VERSION/, 'an old selection is not silently reused by another turn');
  assert.equal(fs.readFileSync(skillFile, 'utf8'), content.replace('CURRENT_VERSION_ONLY', 'NEW_VERSION'));
  await ui('ui.models.configuration.edit', { expectedRevision: (await ui('ui.models.configuration.get')).revision,
    connectionId: 'skill-fixture', patch: { modelChanges: [{ id: 'fixture', manualCapabilities: { tools: true, streaming: true, reasoning: false } }] } });
  await ui('ui.chat.config.set', { id: chat.id, config: { agentProvider: 'cetamesh', modelProvider: 'skill-fixture', model: 'fixture', workspaceId: workspace.id } });
  const currentRef = { skillId: fresh.entries[0].skillId, sourceRevision: fresh.entries[0].sourceRevision };
  const beforeManaged = calls.length;
  await ui('ui.chat.send', { id: chat.id, text: 'Review the selected reference without changing files.', skillRefs: [currentRef], clientMessageId: 'skill-message-0003' });
  const managedStatus = await settle(ui, chat.id);
  assert.equal(managedStatus.error, null, JSON.stringify(managedStatus));
  assert.ok(calls.length > beforeManaged, 'the actual Managed Session makes its own local model request');
  assert.match(JSON.stringify(calls.at(-1).messages), /SKILL_BODY_NEW_VERSION/, 'the Task-bound Managed context receives the exact selected reference');
  const bound = (await ui('ui.chat.sessions.list')).sessions.find(row => row.id === chat.id);
  assert.ok(bound.taskId, 'the normal Agent Chat entry creates and binds the real Task before context resolution');
  assert.equal(services.taskService.runtime.get({ id: bound.taskId }).task.workspaceId, workspace.id);
  console.log('PASS actual composed Core, local model wire, authorized Skill reads, stable Chat refs, duplicate prevention, restart and stale-source recovery');
} finally {
  await close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
