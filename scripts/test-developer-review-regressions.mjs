import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { visionFixturePng } from './test-support/image-fixture.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-developer-review-'));
const gitEnvironment = { ...process.env };
for (const key of Object.keys(gitEnvironment)) if (/^GIT_/i.test(key)) delete gitEnvironment[key];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(temporary, 'no-hooks'), ...args],
  { cwd, env: gitEnvironment, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
async function until(read, predicate, description) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for ' + description);
}
async function gitFixture(name, { aliasStateDir = false } = {}) {
  const root = path.join(temporary, name), stateRoot = path.join(temporary, name + '-state');
  const stateDir = aliasStateDir ? stateRoot + '-alias' : stateRoot;
  if (aliasStateDir) {
    fs.mkdirSync(stateRoot); fs.symlinkSync(stateRoot, stateDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.notEqual(path.resolve(stateDir), fs.realpathSync.native(stateDir));
  }
  fs.mkdirSync(root); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'source.txt'), 'reviewed source\n'); git(root, 'add', 'source.txt'); git(root, 'commit', '-qm', 'fixture');
  const runtime = createTaskRuntime({ stateDir });
  const workspaceService = createWorkspaceService({ stateDir, getTask: id => runtime.get({ id }).task, listTasks: query => runtime.list(query).tasks });
  const { workspace } = await workspaceService.execute({ method: 'workspace.create', params: { name, root } });
  const ownTask = runtime.create({ goal: 'Authorized review Task', workspaceId: workspace.id });
  const foreignTask = runtime.create({ goal: 'PRIVATE_OTHER_TASK_GOAL', workspaceId: workspace.id });
  const capabilityService = createCapabilityService({ stateDir, workspaceService, taskRuntime: runtime });
  return { root, stateDir, runtime, workspaceService, workspace, ownTask, foreignTask, capabilityService, expectedHead: git(root, 'rev-parse', 'HEAD') };
}
async function upload(chat, id, name, bytes, mimeType) {
  const invoke = (method, params) => chat.execute({ method: 'chat.attachment.' + method, params: { id, ...params } });
  const file = await invoke('begin', { name, size: bytes.length, mimeType });
  await invoke('chunk', { ref: file.ref, offset: 0, data: bytes.toString('base64') });
  return invoke('finish', { ref: file.ref });
}
function modelFixture(requests) {
  return { defaultProviderId: () => 'fixture', resolveProvider: () => ({ id: 'fixture' }), supportsToolCalling: () => false,
    imageInputCapabilities: () => ({ supported: true }),
    stream: async function* (request) {
      requests.push(structuredClone(request.messages));
      yield { type: 'turn/start', data: {} };
      yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Observed fixture input.' }] } } };
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } };
}

try {
  for (const aliasStateDir of [false, true]) await check('Agent Git overview excludes other Task goals and branch/worktree associations while Owner keeps them' + (aliasStateDir ? ' through a directory alias' : ''), async () => {
    const f = await gitFixture(aliasStateDir ? 'overview-scope-alias' : 'overview-scope', { aliasStateDir });
    for (const [task, branch] of [[f.ownTask, 'codex/own'], [f.foreignTask, 'codex/foreign']]) {
      await f.workspaceService.executeApprovedGit({ method: 'workspace.git.branch.create', params: { id: f.workspace.id, taskId: task.id, branch, expectedHead: f.expectedHead } });
    }
    const foreignWorktree = await f.workspaceService.executeApprovedGit({ method: 'workspace.git.worktree.create', params: {
      id: f.workspace.id, taskId: f.foreignTask.id, branch: 'codex/foreign-worktree', expectedHead: f.expectedHead } });
    const actor = f.capabilityService.grantTask(f.ownTask.id, { capabilities: ['git.overview'] });
    const request = { capability: 'git.overview', input: {}, taskId: f.ownTask.id, workspaceId: f.workspace.id };
    const owner = (await f.capabilityService.broker.execute({ ...request, actor: { kind: 'owner', id: 'desktop' } })).result;
    assert.ok(owner.tasks.some(task => task.id === f.foreignTask.id));
    assert.equal(owner.branches.find(branch => branch.name === 'codex/foreign').taskId, f.foreignTask.id);
    assert.ok(owner.worktrees.some(worktree => worktree.workspaceId === foreignWorktree.workspace.id && worktree.taskId === f.foreignTask.id));
    const scoped = (await f.capabilityService.broker.execute({ ...request, actor })).result;
    assert.deepEqual(scoped.tasks.map(task => task.id), [f.ownTask.id]);
    assert.equal(scoped.branches.find(branch => branch.name === 'codex/own').taskId, f.ownTask.id);
    assert.ok(!JSON.stringify(scoped).includes(f.foreignTask.id));
    assert.ok(!JSON.stringify(scoped).includes('PRIVATE_OTHER_TASK_GOAL'));
    for (const branch of scoped.branches.filter(branch => branch.name.startsWith('codex/foreign'))) assert.ok(!branch.taskId && !branch.baselineHead);
    for (const worktree of scoped.worktrees.filter(worktree => worktree.branch === 'codex/foreign-worktree')) {
      assert.ok(!worktree.taskId && !worktree.baselineHead);
    }
    await assert.rejects(f.capabilityService.broker.execute({ ...request, actor, taskId: f.foreignTask.id }), { code: 'TASK_NOT_AUTHORIZED' });
  });

  await check('Agent model tools request Git branch/worktree approval with server-bound Task identity and no write', async () => {
    const f = await gitFixture('agent-git');
    const actor = f.capabilityService.grantTask(f.ownTask.id, { capabilities: ['git.branch.create', 'git.worktree.create'] });
    for (const capability of ['git.branch.create', 'git.worktree.create']) {
      const branch = 'codex/request-' + capability.split('.')[1];
      const descriptor = f.capabilityService.broker.list().find(row => row.id === capability);
      assert.ok(!descriptor.inputSchema.required.includes('taskId'));
      assert.ok(!Object.hasOwn(descriptor.inputSchema.properties, 'taskId'));
      const coordinator = createToolExecutionCoordinator({ capabilityBroker: f.capabilityService.broker,
        modelRuntime: { chat: async () => ({ toolCalls: [{ id: 'git-request', capabilityId: capability, arguments: { branch, expectedHead: f.expectedHead } }] }) } });
      const result = await coordinator.run({ actor, sessionId: capability, turnId: 'approval-request', targetKind: 'agent',
        scope: { taskId: f.ownTask.id, workspaceId: f.workspace.id }, messages: [{ role: 'user', content: 'Prepare a Task Git branch.' }], manifest: [descriptor] });
      assert.equal(result.status, 'pending');
      const pending = f.capabilityService.broker.approvals.get(result.approvalId);
      assert.equal(pending.request.taskId, f.ownTask.id);
      assert.equal(pending.request.workspaceId, f.workspace.id);
      assert.equal(pending.request.input.branch, branch);
      assert.ok(!Object.hasOwn(pending.request.input, 'taskId'));
      assert.equal(git(f.root, 'branch', '--list', branch), '');
      f.capabilityService.broker.approvals.cancel(result.approvalId, 'fixture-complete');
    }
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.expectedHead);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
  });

  await check('image-only user message remains in the next production Chat model request', async () => {
    const requests = [], chat = createChatService({ stateDir: path.join(temporary, 'image-history'), defaults: { model: '' }, modelRuntime: modelFixture(requests), controlExecute: async () => ({}) });
    const ui = createDesktopUiService({ services: { chatService: chat } });
    try {
      const { id } = await chat.execute({ method: 'chat.sessions.create', params: {} });
      const bytes = visionFixturePng(), original = await upload(chat, id, 'original.png', bytes, 'image/png'), derived = await upload(chat, id, 'model.png', bytes, 'image/png');
      await chat.execute({ method: 'chat.attachment.derive', params: { id, ref: original.ref, modelRef: derived.ref } });
      await ui.execute({ method: 'ui.chat.send', params: { id, text: '', attachments: [{ ref: original.ref }] } });
      await until(() => chat.execute({ method: 'chat.history', params: { id } }), history => history.messages.some(message => message.role === 'assistant'), 'first image response');
      await ui.execute({ method: 'ui.chat.send', params: { id, text: 'What color is the square in my previous image?' } });
      await until(() => Promise.resolve(requests), rows => rows.length === 2, 'image follow-up request');
      const images = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
      assert.equal(images(requests[0]).length, 1);
      assert.equal(images(requests[1]).length, 1);
      assert.deepEqual(images(requests[1]), images(requests[0]));
    } finally { await chat.close(); }
  });

  await check('Task Agent receives attachment references without body, with current Task/Workspace-only text reads', async () => {
    const requests = [], captured = [];
    const workspace = { id: 'workspace-attachment', root: temporary };
    const taskId = 'task-attachment';
    const chat = createChatService({ stateDir: path.join(temporary, 'task-attachments'), defaults: { model: '' }, modelRuntime: modelFixture(requests),
      controlExecute: async () => ({}), agentExecute: async () => ({}), agentProviders: [{ id: 'cetamesh', eventProtocol: 'agent-turn-events-v1' }],
      resolveWorkspace: id => id === workspace.id ? workspace : null,
      platformRoute: async request => { captured.push({ text: request.text, sourceText: request.sourceText }); return { kind: 'agent', accepted: true, provider: 'cetamesh', sessionId: 'fixture-task-session', taskId }; },
      agentFollow: async function* ({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } });
    try {
      const { id } = await chat.execute({ method: 'chat.sessions.create', params: {} });
      await chat.execute({ method: 'chat.config.set', params: { id, config: { agentProvider: 'cetamesh', workspaceId: workspace.id } } });
      const body = 'PRIVATE_ATTACHMENT_CONTENT_REQUIRES_AUTHORIZED_READ';
      const file = await upload(chat, id, 'requirements.txt', Buffer.from(body), 'text/plain');
      const unpublished = await upload(chat, id, 'unsubmitted.txt', Buffer.from('not submitted'), 'text/plain');
      await chat.execute({ method: 'chat.send', params: { id, text: 'Use the attached requirements.', attachments: [{ ref: file.ref }] } });
      await until(() => chat.execute({ method: 'chat.status', params: { id } }), status => status.taskId === taskId, 'Task binding');
      assert.equal(captured.length, 1);
      assert.ok(captured[0].text.includes(file.ref));
      assert.ok(captured[0].text.includes(file.name));
      assert.ok(!JSON.stringify(captured).includes(body));
      assert.ok(!JSON.stringify(captured).includes(unpublished.ref));
      assert.equal(captured[0].sourceText, 'Use the attached requirements.');
      assert.equal(chat.readScopedAttachment({ taskId, workspaceId: workspace.id, ref: file.ref }).text, body);
      for (const scope of [{ taskId: 'other-task', workspaceId: workspace.id }, { taskId, workspaceId: 'other-workspace' }]) {
        assert.throws(() => chat.readScopedAttachment({ ...scope, ref: file.ref }), { code: 'ATTACHMENT_NOT_AUTHORIZED' });
      }
      assert.throws(() => chat.readScopedAttachment({ taskId, workspaceId: workspace.id, ref: unpublished.ref }), { code: 'ATTACHMENT_NOT_AUTHORIZED' });
    } finally { await chat.close(); }
  });

  await check('pre-cancelled UI Git and ZIP import requests create neither effects nor pending approvals', async () => {
    let effects = 0;
    const broker = createCapabilityBroker({ policy: createCapabilityPolicy({ resolveTask: () => ({ workspaceId: 'workspace-cancel', status: 'running' }), resolveWorkspace: () => ({ root: temporary }) }) });
    for (const id of ['git.commit', 'git.branch.create', 'git.worktree.create', 'attachment.archive.import']) broker.register({ id, permission: 'storage', risk: 'high', effect: 'non-idempotent', execute: () => { effects++; return { changed: true }; } });
    const ui = createDesktopUiService({ services: { capabilityService: { broker } } });
    const controller = new AbortController(); controller.abort();
    for (const action of ['commit', 'branch.create', 'worktree.create']) {
      await assert.rejects(ui.execute({ method: 'ui.workspace.git.' + action, params: { id: 'workspace-cancel', taskId: 'task-cancel' }, signal: controller.signal }), { code: 'INVOKE_CANCELLED' });
    }
    await assert.rejects(ui.execute({ method: 'ui.chat.attachment.import', params: { id: 'session-cancel', ref: 'a'.repeat(32) }, signal: controller.signal }), { code: 'INVOKE_CANCELLED' });
    assert.equal(effects, 0);
    assert.equal(broker.approvals.list().length, 0);
  });
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('cm-developer-review-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(`Developer review regressions: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
