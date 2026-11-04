import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopPlatformRuntime } from '../src/desktop/platform-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-chat-failure-'));
const failures = [];
async function check(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures.push(name); console.error('FAIL', name, error.message); }
}
const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui');
const require = createRequire(path.join(uiRoot, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const record = () => ({ id: 'chat-stage', config: { agentProvider: 'cetamesh', workspaceId: 'workspace-stage' } });
const broker = { health: async () => ({ available: true, installed: true, authenticated: true, sessionCapable: true, toolsAvailable: true }), capabilities: () => ({ workspaceBoundary: 'capability-broker' }) };
const taskRuntime = { findByGoalWorkspace: () => null, create: () => ({ id: 'task-stage', status: 'queued', workspaceId: 'workspace-stage' }), get: () => ({ task: { id: 'task-stage', status: 'queued', workspaceId: 'workspace-stage' } }) };
try {
  await check('platform rejection before dispatch is explicit and never calls the executor', async () => {
    let sends = 0;
    const platform = createDesktopPlatformRuntime({ agentBroker: { ...broker, health: async () => ({ available: false }) }, taskRuntime,
      capabilityService: { broker: { execute: async () => { sends++; } } } });
    await assert.rejects(platform.route({ decision: { agentIntent: true }, record: record(), text: 'inspect', requestId: 'request-preflight' }), error => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE'); assert.equal(error.failureStage, 'pre-dispatch'); return true;
    });
    assert.equal(sends, 0);
  });
  await check('unconfirmed dispatch cannot claim pre-dispatch even with a provider supplied code or stage', async () => {
    const platform = createDesktopPlatformRuntime({ agentBroker: broker, taskRuntime,
      capabilityService: { broker: { execute: async () => { throw Object.assign(new Error('provider detail'), { code: 'PROVIDER_UNAVAILABLE', failureStage: 'pre-dispatch' }); } } } });
    await assert.rejects(platform.route({ decision: { agentIntent: true }, record: record(), text: 'inspect', requestId: 'request-unknown' }), error => {
      assert.equal(error.failureStage, 'unknown'); return true;
    });
  });
  await check('Chat persists pre-dispatch rejection as a system event with no invented Agent output', async () => {
    const events = [];
    const diagnosticFailures = [];
    const options = { stateDir: path.join(root, 'chat'), api: {}, defaults: {}, defaultAgentProvider: () => 'cetamesh',
      agentProviders: [{ id: 'cetamesh', eventProtocol: 'dsh-session-events', requiresTask: true }],
      platformRoute: async ({ record }) => { record.taskId = 'task-blocked'; throw Object.assign(new Error('request blocked'), { code: 'TASK_WORKSPACE_BUSY', failureStage: 'pre-dispatch', blockingTaskId: 'task-owner' }); },
      onEvent: event => events.push(event), onFailure: event => diagnosticFailures.push(event) };
    let chat = createChatService(options);
    try {
      const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
      const sent = await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'preserve this request', clientMessageId: 'client-failure-1' } });
      let status;
      for (let i = 0; i < 100; i++) { status = await chat.execute({ method: 'chat.status', params: { id: session.id } }); if (!status.turn) break; await new Promise(resolve => setTimeout(resolve, 5)); }
      const history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
      assert.equal(history.messages.length, 2); assert.equal(history.messages[0].text, 'preserve this request');
      const failure = history.messages[1];
      assert.equal(failure.role, 'system'); assert.equal(failure.failureStage, 'pre-dispatch');
      assert.equal(failure.text, ''); assert.equal(failure.agentActivity ?? null, null); assert.deepEqual(failure.toolActivity, []);
      assert.equal(failure.errorCode, 'TASK_WORKSPACE_BUSY'); assert.equal(failure.requestId, sent.requestId);
      assert.equal(diagnosticFailures.length,1,'asynchronous settled failure reaches Core diagnostics without polling history');
      assert.equal(diagnosticFailures[0].code,'TASK_WORKSPACE_BUSY');
      assert.equal(diagnosticFailures[0].requestId,sent.requestId);
      assert.equal(diagnosticFailures[0].blockingTaskId,'task-owner');
      assert.ok(!Object.hasOwn(diagnosticFailures[0],'message')&&!Object.hasOwn(diagnosticFailures[0],'error'));
      assert.ok(!events.some(event => event.data?.agentActivity), 'selection alone cannot create Agent activity');
      chat.close(); chat = createChatService(options);
      const reloaded = await chat.execute({ method: 'chat.status', params: { id: session.id } });
      assert.equal(reloaded.lastRequestId, sent.requestId); assert.equal(reloaded.lastFailureStage, 'pre-dispatch');
      assert.equal(reloaded.lastRouting.blockingTaskId, 'task-owner'); assert.equal(reloaded.lastErrorCode, 'TASK_WORKSPACE_BUSY');
    } finally { chat.close(); }
  });
  globalThis.window = { setTimeout, clearTimeout };
  const ui = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  const message = { id: 'system-failure', role: 'system', text: '', at: 1, requestId: 'request-failure', attachments: [], toolActivity: [], agentActivity: null, error: 'private raw failure must not appear', errorCode: 'TASK_WORKSPACE_BUSY', failureStage: 'pre-dispatch', routing: { taskId: 'task-new', blockingTaskId: 'task-owner' }, cancelled: false };
  await check('pre-dispatch feedback is not an assistant bubble or Agent activity and points at the blocking Task', () => {
    const html = renderToStaticMarkup(React.createElement(ui.MessageBubble, { message, onOpenTask() {} }));
    assert.doesNotMatch(html, /chat-message assistant|message-avatar|Agent 活动|没有文本内容|private raw failure/);
    assert.match(html, /尚未开始执行/); assert.match(html, /task-owner/); assert.match(html, /查看占用任务/);
    assert.match(html, /TASK_WORKSPACE_BUSY/); assert.match(html, /request-failure/); assert.match(html, /诊断/);
    assert.doesNotMatch(html, />重试<|>继续</);
  });
  await check('a settled failure has one canonical notice even while status and history overlap', () => {
    assert.equal(ui.chatFailureInHistory({ requestId: 'request-failure', error: message.error, errorCode: message.errorCode }, [message]), true);
    assert.equal(ui.chatFailureInHistory({ requestId: 'new-request', error: message.error, errorCode: message.errorCode }, [message]), false);
    assert.equal(ui.chatFailureInHistory({ requestId: 'request-failure', error: 'Recovery required', errorCode: 'NEEDS_RECONCILIATION' }, [message]), false, 'authoritative recovery must not be hidden by an older request failure');
    assert.equal(ui.chatFailureInHistory({ requestId: null, error: message.error, errorCode: message.errorCode }, [message]), true);
  });
  await check('paused Task recovery is reachable without parsing progress copy and cannot resume before inspection', () => {
    const task = { id: 'paused-task', title: 'Old Session', goal: 'Inspect first', status: 'paused', currentPhase: '', progress: { percent: null, note: '进度说明已经本地化' }, workspaceId: null, agent: 'codex', currentAgent: { provider: 'codex', sessionId: 'old-session' }, parentTaskId: null, verification: null, attemptCount: 0, childOutputKind: null, attempts: [], children: [], createdAt: 1, updatedAt: 1, rev: 2, checkpoint: null, result: null, artifacts: [], executionEvidence: [], agentHistory: [], failure: null };
    const html = renderToStaticMarkup(React.createElement(ui.TaskDetails, { task, providers: [], onHandoff() {}, onAction() {}, onStart() {}, onReconcile: async () => {}, onReview() {}, onCreateChild() {}, onComplete() {}, onVerifyChild() {} }));
    assert.match(html, /核对已记录结果（只读）/);
    assert.doesNotMatch(html, />继续任务</, 'recovery must require a current Core preview instead of calling resume blindly');
    assert.match(html, /尚未读取恢复检查/);
  });
} finally {
  await vite.close(); delete globalThis.window;
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures.length) process.exitCode = 1;
