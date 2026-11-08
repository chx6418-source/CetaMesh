import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { createOpenAiCompatibleModelProvider } from '../src/model/index.js';
import { createTaskStore } from '../src/task/store.js';
import { createWorkspaceRegistry } from '../src/workspace/registry.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createIsolatedTestRunner } from '../src/workspace/isolated-runner.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { verifyPostWriteCurrentSource } from '../src/task/outcome-verification.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { buildTaskContext } from '../src/context/task-context.js';
import { buildProductContext } from '../src/context/product-context.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const original = 'export const add = (a, b) => a;\n';
const broken = 'export const add = (a, b) => a - b;\n';
const repaired = 'export const add = (a, b) => a + b;\n';
const config = { enabled: true, tool: 'npm', args: ['test'], includeExtensions: ['.mjs'], timeoutMs: 30000, maxRunsPerTurn: 2 };
const call = (id, capability, input) => ({ index: 0, id, type: 'function', function: {
  name: 'cap_' + capability.replace(/[^A-Za-z0-9_-]/g, '_'), arguments: JSON.stringify(input)
} });

function ownerConfiguration() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-post-write-settings-')));
  try {
    const registry = createWorkspaceRegistry({ file: path.join(root, 'workspaces.json') });
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    const workspace = registry.create({ root: project, name: 'Settings only' });
    assert.equal(workspace.settings.postWriteVerification?.enabled === true, false, 'default installation never enables automatic project execution');
    const saved = registry.updateSettings(workspace.id, { postWriteVerification: config });
    assert.deepEqual(saved.settings.postWriteVerification, config, 'Owner configuration is stored on the existing Workspace');
    assert.deepEqual(createWorkspaceRegistry({ file: path.join(root, 'workspaces.json') }).get(workspace.id).settings.postWriteVerification, config);
    for (const patch of [
      { ...config, enabled: 'true' }, { ...config, tool: 'node', args: ['verify.mjs'] },
      { ...config, args: ['run', 'test;whoami'] }, { ...config, args: ['run', 'test', '--', '&&'] },
      { ...config, args: ['test'], shell: true }, { ...config, includeExtensions: ['mjs'] },
      { ...config, includeExtensions: ['.mjs', '../x'] }, { ...config, includeExtensions: Array(21).fill('.js') },
      { ...config, timeoutMs: 999 }, { ...config, timeoutMs: 600001 },
      { ...config, maxRunsPerTurn: 3 }, { ...config, maxRunsPerTurn: 1.5 }
    ]) {
      assert.throws(() => registry.updateSettings(workspace.id, { postWriteVerification: patch }),
        error => ['POST_WRITE_CONFIG_INVALID', 'INVALID_PARAMS', 'TEST_COMMAND_NOT_ALLOWED'].includes(error.code));
      assert.deepEqual(registry.get(workspace.id).settings.postWriteVerification, config, 'invalid settings cannot partially replace the last valid invocation');
    }
    assert.deepEqual(fs.readdirSync(project), [], 'saving settings has no project/process side effects');
    registry.updateSettings(workspace.id, { postWriteVerification: { ...config, maxRunsPerTurn: 0 } });
    assert.equal(registry.get(workspace.id).settings.postWriteVerification.maxRunsPerTurn, 0);
    registry.updateSettings(workspace.id, { postWriteVerification: null });
    assert.equal(registry.get(workspace.id).settings.postWriteVerification ?? null, null);
    console.log('PASS explicit bounded Owner configuration persists without execution and rejects shell-like or invalid invocation/trigger settings');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// This regression catches a coordinator that returns model final prose after a
// write without requesting the explicitly configured fresh verifier. Both the
// model endpoint and the project/test process are suite-owned, local fixtures.
async function automaticRepair() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-post-write-')));
  const project = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(project);
  const verifier = [
    "import assert from 'node:assert/strict'; import { add } from './math.mjs';",
    "import fs from 'node:fs'; fs.appendFileSync('../test-starts.log', 'started\\n');",
    "assert.equal(add(2, 4), 6, 'R02_FRESH_ADD_POSITIVE');",
    "assert.equal(add(-2, 5), 3, 'R02_FRESH_ADD_NEGATIVE');",
    "console.log('R02_FRESH_CURRENT_CODE_VERIFIED');\n"
  ].join('\n');
  const packageSource = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node verify.mjs' } }) + '\n';
  for (const [name, content] of Object.entries({ 'math.mjs': original, 'verify.mjs': verifier, 'package.json': packageSource })) {
    fs.writeFileSync(path.join(project, name), content);
  }
  const fileHash = name => sha(fs.readFileSync(path.join(project, name)));
  const starts = () => fs.existsSync(path.join(root, 'test-starts.log'))
    ? fs.readFileSync(path.join(root, 'test-starts.log'), 'utf8').trim().split('\n').length : 0;
  const requests = [], decisions = [];
  let services, taskId, modelError;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fixture', capabilities: { tools: true, streaming: true } }] })); return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body); requests.push(request);
      // Every assistant call batch has all of its original tool answers before
      // another assistant batch begins. Synthetic verifier calls own new IDs.
      let owed = new Set();
      for (const message of request.messages) {
        if (message.role === 'assistant') {
          assert.equal(owed.size, 0, 'original model tool batch must be complete before server verification pair');
          owed = new Set((message.tool_calls ?? []).map(row => row.id));
        } else if (message.role === 'tool') {
          assert.ok(owed.delete(message.tool_call_id), 'tool answer must belong to the immediately preceding assistant batch');
        }
      }
      assert.equal(owed.size, 0);
      const step = requests.length - 1;
      const tests = request.messages.filter(row => row.role === 'tool').map(row => {
        try { return JSON.parse(row.content); } catch { return null; }
      }).filter(row => row?.postWriteVerification?.kind === 'post-write-verification');
      let tool;
      if (step === 0) tool = call('introduce-error', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(original), content: broken });
      if (step === 1) {
        const write = request.messages.find(row => row.role === 'tool' && row.tool_call_id === 'introduce-error');
        assert.equal(JSON.parse(write?.content ?? 'null')?.status, 'completed', write?.content);
        assert.equal(fileHash('math.mjs'), sha(broken));
        assert.equal(tests.length, 1, 'a successful matching write automatically requests the configured verifier without a model test call');
        assert.equal(tests[0].status, 'completed');
        assert.equal(tests[0].postWriteVerification.state, 'failed');
        assert.notEqual(tests[0].result.exitCode, 0);
        assert.match(tests[0].result.stdout + tests[0].result.stderr, /R02_FRESH_ADD_POSITIVE/,
          'actual Node assertion failure reaches the next actual HTTP inference request');
        tool = call('repair-error', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(broken), content: repaired });
      }
      if (step === 2) {
        assert.equal(tests.length, 2); assert.equal(tests[1].postWriteVerification.state, 'passed');
        assert.equal(tests[1].result.exitCode, 0); assert.match(tests[1].result.stdout, /R02_FRESH_CURRENT_CODE_VERIFIED/);
        tool = call('current-diff', 'git.diff', {});
      }
      assert.ok(step <= 3, 'automatic correction stays bounded');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { content: 'Written; report only after the configured fresh evidence.', tool_calls: [tool] }
        : { content: 'The fresh fixture passed; Owner acceptance remains separate.' };
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) { modelError = error; res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture assertion failed' } })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    for (const args of [['init', '-q', project], ['-C', project, 'config', 'core.autocrlf', 'false'], ['-C', project, 'add', '.'],
      ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline']]) {
      execFileSync('git', args, { stdio: 'ignore' });
    }
    const providerId = 'post-write-loop-fixture';
    const credentials = createProviderSecrets({ root: path.join(root, 'credentials') });
    credentials.set({ provider: providerId, apiKey: 'synthetic-loopback-only' });
    services = createCetaMeshServices({ stateDir, dataRoot: path.join(root, 'data'), agentStagingRoot: path.join(root, 'staging'), providerSecrets: credentials });
    services.modelRegistry.register(createOpenAiCompatibleModelProvider({ id: providerId, label: 'Synthetic loopback automatic verification model',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', defaultModel: 'fixture', supportsTools: true, secrets: credentials }));
    const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Automatic verification fixture' } })).workspace;
    await services.workspaceService.execute({ method: 'workspace.settings', params: { id: workspace.id, patch: { postWriteVerification: config } } });
    assert.equal(starts(), 0, 'saving explicit Owner configuration never executes a verifier');
    const created = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
      goal: 'Implement add in math.mjs. The Owner configured fresh npm test after writes. Report only current evidence.',
      workspaceId: workspace.id, agentProvider: 'cetamesh', modelProvider: providerId, model: 'fixture', requestId: 'post-write-repair',
      collaboration: { enabled: true, allowUnknownCost: false, prepareNative: false, verification: { editablePaths: ['math.mjs'], testFiles: ['verify.mjs'] } }
    } });
    taskId = created.task.id;
    const rt = services.taskService.runtime;
    const initial = rt.get({ id: taskId }).task;
    const acceptance = structuredClone(initial.acceptance);
    const deadline = Date.now() + 30000, decided = new Set();
    let task = initial;
    while (Date.now() < deadline) {
      if (modelError) throw modelError;
      for (const approval of services.capabilityService.broker.approvals.list()) {
        if (approval.status !== 'pending' || approval.request.taskId !== taskId || decided.has(approval.id)) continue;
        const request = approval.request;
        assert.equal(fileHash('verify.mjs'), sha(verifier)); assert.equal(fileHash('package.json'), sha(packageSource));
        if (request.capability === 'test.run') {
          assert.deepEqual(request.input, { tool: 'npm', args: ['test'], timeoutMs: 30000 });
          assert.equal(starts(), decisions.filter(row => row.capability === 'test.run').length, 'each fresh test waits for its own exact Owner approval');
          assert.match(request.target?.postWriteVerification?.configDigest ?? '', /^[a-f0-9]{64}$/);
          assert.match(request.target.postWriteVerification.sourceDigest, /^[a-f0-9]{64}$/);
        } else assert.equal(request.capability, 'filesystem.write');
        decided.add(approval.id);
        const result = await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: approval.id, approve: true } });
        assert.equal(result.status, 'completed');
        decisions.push({ id: approval.id, capability: request.capability, requestId: request.requestId, operationId: request.operationId });
      }
      task = rt.get({ id: taskId }).task;
      if (task.executionObservation?.state === 'awaiting-review') break;
      await delay(20);
    }
    if (modelError) throw modelError;
    assert.equal(task.executionObservation?.state, 'awaiting-review');
    assert.equal(requests.length, 4, 'write/automatic failure feedback/repair/automatic pass/diff/final use four HTTP inferences');
    assert.equal(starts(), 2); assert.equal(fileHash('math.mjs'), sha(repaired));
    const checks = decisions.filter(row => row.capability === 'test.run');
    assert.equal(new Set(checks.map(row => row.id)).size, 2);
    assert.equal(new Set(checks.map(row => row.operationId)).size, 2, 'repair cannot replay the failed test operation');
    const tests = task.executionEvidence.filter(row => row.source === 'core-test');
    assert.deepEqual(tests.map(row => row.exitCode === 0), [false, true]);
    for (const test of tests) {
      assert.equal(test.runId, task.executionObservation.runId); assert.equal(test.sessionId, task.currentAgent.sessionId);
      assert.match(test.postWriteVerification?.configDigest ?? '', /^[a-f0-9]{64}$/);
      assert.match(test.postWriteVerification.sourceDigest, /^[a-f0-9]{64}$/);
      assert.ok(test.postWriteVerification.sourceWriteIds.length > 0);
    }
    assert.notEqual(tests[0].postWriteVerification.sourceDigest, tests[1].postWriteVerification.sourceDigest);
    assert.deepEqual(task.acceptance, acceptance); assert.notEqual(task.status, 'completed');
    const saved = createTaskStore({ stateDir }).get(taskId);
    assert.deepEqual(saved.executionEvidence.filter(row => row.source === 'core-test'), tests, 'persisted Core evidence retains failed and fresh passing check bindings');
    assert.equal((await services.taskService.execute({ method: 'task.outcome.verify', params: { id: taskId, kind: 'code', requireCurrentCodeEvidence: true } })).status,
      'NEEDS_REVIEW', 'passing automatic checks cannot set semantic acceptance');
    for (const item of task.acceptance) {
      task = rt.get({ id: taskId }).task;
      rt.setAcceptance({ id: taskId, expectedRev: task.rev, acceptanceId: item.id, met: true });
    }
    const verifyCurrent = () => services.taskService.execute({ method: 'task.outcome.verify', params: { id: taskId, kind: 'code', requireCurrentCodeEvidence: true } });
    assert.equal((await verifyCurrent()).status, 'VERIFIED', 'existing strict outcome query uses current independently observed source proof after explicit semantic review');
    fs.appendFileSync(path.join(project, 'math.mjs'), '// external source edit\n');
    assert.deepEqual((await verifyCurrent()).reasons, ['POST_WRITE_SOURCE_CHANGED'], 'exit zero cannot certify a changed current postimage');
    fs.writeFileSync(path.join(project, 'math.mjs'), repaired);
    fs.appendFileSync(path.join(project, 'verify.mjs'), '// external verifier edit\n');
    assert.deepEqual((await verifyCurrent()).reasons, ['POST_WRITE_SOURCE_CHANGED'], 'the exact verifier source remains part of strict current-code evidence');
    fs.writeFileSync(path.join(project, 'verify.mjs'), verifier);
    await services.workspaceService.execute({ method: 'workspace.settings', params: { id: workspace.id, patch: { postWriteVerification: { ...config, timeoutMs: 31000 } } } });
    assert.deepEqual((await verifyCurrent()).reasons, ['POST_WRITE_CONFIG_CHANGED']);
    await services.workspaceService.execute({ method: 'workspace.settings', params: { id: workspace.id, patch: { postWriteVerification: config } } });
    assert.equal((await verifyCurrent()).status, 'VERIFIED', 'restoring the exact source/configuration restores read-only current proof without repeating a test effect');
    console.log('PASS R02 actual local HTTP write/final prose -> fresh approved Node failure -> next HTTP diagnostic -> repair -> new exact approval -> fresh actual pass');
  } finally {
    if (services && taskId) {
      const task = services.taskService.runtime.get({ id: taskId }).task;
      if (task.currentAgent) try { await services.agentBroker.cancel(task.currentAgent); } catch {}
      if (!['cancelled', 'completed', 'failed'].includes(task.status)) try { services.taskService.runtime.cancel({ id: taskId, expectedRev: task.rev, reason: 'Suite-owned fixture cleanup' }); } catch {}
    }
    if (services) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[name].close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const structuredCall = (id, capabilityId, input) => ({ id, capabilityId, arguments: input });
const owner = { kind: 'owner', id: 'desktop' };

// Authorization/recovery regressions use a deterministic model leaf and the
// actual Workspace/Task/Broker/Approval/Runner, separate from the HTTP proof.
async function coreFixture({ settings = config, grants = ['filesystem.read', 'filesystem.write', 'test.run'], calls,
  maxCalls = 24, loseTestReceipt = false, runnerAvailable = true, loseWriteReceipt = false, verifierPrefix = '', provider = 'cetamesh' } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-post-write-core-')));
  const project = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(project);
  const source = [verifierPrefix, "import { add } from './math.mjs'; import assert from 'node:assert/strict'; import fs from 'node:fs';",
    "fs.appendFileSync('../starts.log', 'test\\n'); assert.equal(add(2, 4), 6, 'R02_OWNED_FIXED_ASSERTION'); console.log('R02_OWNED_PASS');\n"].join('\n');
  for (const [name, content] of Object.entries({ 'math.mjs': original, 'verify.mjs': source,
    'package.json': JSON.stringify({ private: true, type: 'module', scripts: { test: 'node verify.mjs' } }) })) fs.writeFileSync(path.join(project, name), content);
  const registry = createWorkspaceRegistry({ file: path.join(stateDir, 'workspaces.json') });
  const workspace = registry.create({ name: 'Owned Core verification fixture', root: project });
  const workspaceService = createWorkspaceService({ stateDir });
  if (settings) await workspaceService.execute({ method: 'workspace.settings', params: { id: workspace.id, patch: { postWriteVerification: settings } } });
  const tasks = createTaskRuntime({ stateDir, resolveWorkspace: id => workspaceService.describeWorkspace(id),
    resolvePostWriteVerification: request => workspaceService.resolvePostWriteVerification(request) });
  let task = tasks.create({ goal: 'Exercise only suite-owned current writes and fresh fixed tests', workspaceId: workspace.id,
    acceptanceCriteria: ['Independent Owner review remains required'] });
  task = tasks.start({ id: task.id, expectedRev: task.rev, provider, sessionId: 'verification-session' }).task;
  tasks.beginExecutionObservation({ id: task.id, provider, sessionId: 'verification-session', runId: 'verification-run', phase: 'user' });
  const actualRunner = createIsolatedTestRunner({ resolveWorkspace: id => workspaceService.describeWorkspace(id) });
  const runner = loseTestReceipt ? { async run(input) { await actualRunner.run(input);
    throw Object.assign(new Error('Owned fault after actual test process exit'), { code: 'R02_TEST_RECEIPT_LOST', effectStatus: 'unknown' }); } } : actualRunner;
  const capabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime: tasks, isolatedRunner: runnerAvailable ? runner : null });
  capabilities.grantTask(task.id, { capabilities: grants });
  if (loseWriteReceipt) {
    const execute = workspaceService.execute;
    workspaceService.execute = async request => { const result = await execute(request);
      if (request.method === 'workspace.write') throw Object.assign(new Error('Owned fault after actual write'), { code: 'R02_WRITE_RECEIPT_LOST', effectStatus: 'unknown' });
      return result; };
  }
  const requests = [], responses = [calls ?? [structuredCall('write-one', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(original), content: broken })]];
  const modelRuntime = { async chat(request) { requests.push({ messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
    const next = responses.shift(); if (next instanceof Error) throw next;
    return { text: 'Fixture report only', toolCalls: next ?? [] }; } };
  const coordinatorOptions = { stateDir, modelRuntime, capabilityBroker: capabilities.broker, maxCalls, finalSynthesisAtLimit: true,
    resolveImportedWriteReceipts: request => capabilities.importedWriteReceipts(request),
    actorResolver: ({ actorKind }) => actorKind === 'owner' ? owner : capabilities.principalForTask(task.id),
    resolvePostWriteVerification: ({ scope, signal }) => workspaceService.resolvePostWriteVerification({ workspaceId: scope.workspaceId, signal }) };
  const coordinator = createToolExecutionCoordinator(coordinatorOptions);
  const callbacks = { onCapabilityResult({ capability, result, input, eventId, scope }) {
    if (scope?.taskId !== task.id) return;
    tasks.recordToolOutcome({ id: task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'verification-run', phase: 'user',
      eventId, capability, status: result.status, filePath: capability === 'filesystem.write' ? input?.path : null,
      tool: capability === 'test.run' ? input?.tool : null, exitCode: result.result?.exitCode,
      hasChanges: capability === 'git.diff' && result.result?.hasChanges === true });
  } };
  const options = { actor: capabilities.principalForTask(task.id), sessionId: 'verification-session', turnId: 'verification-turn',
    runId: 'verification-run', phase: 'user', targetKind: 'agent', scope: { taskId: task.id, workspaceId: workspace.id },
    messages: [{ role: 'user', content: 'Perform only the owned fixture plan and report observed verification.' }],
    manifest: capabilities.broker.list().filter(row => row.inputSchema && row.description), ...callbacks };
  let lastResume;
  capabilities.setApprovalDecisionListener(async event => { if (provider !== 'cetamesh') return null; lastResume = await coordinator.resumeApproval({ ...event, ...callbacks });
    return { resumed: lastResume.status !== 'pending', pending: lastResume.status === 'pending', approvalId: lastResume.approvalId }; });
  const fixture = { root, project, stateDir, workspace, workspaceService, task, tasks, capabilities, coordinator, coordinatorOptions, options,
    requests, responses, source, callbacks, get lastResume() { return lastResume; },
    starts: () => fs.existsSync(path.join(root, 'starts.log')) ? fs.readFileSync(path.join(root, 'starts.log'), 'utf8').trim().split('\n').length : 0,
    decide: (pending, approve = true) => capabilities.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve } }),
    async writeThenPendingTest() {
      const write = await coordinator.run(options); assert.equal(capabilities.broker.approvals.get(write.approvalId).request.capability, 'filesystem.write');
      assert.equal(fixture.starts(), 0); await fixture.decide(write);
      assert.equal(lastResume.status, 'pending'); assert.equal(capabilities.broker.approvals.get(lastResume.approvalId).request.capability, 'test.run');
      assert.equal(fixture.starts(), 0); return lastResume;
    },
    async close() { coordinator.cancelSession('verification-session', 'owned-fixture-close'); await capabilities.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
  return fixture;
}

const verificationResults = messages => messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content))
  .filter(row => row.postWriteVerification);
const skippedFacts = messages => messages.filter(row => row.role === 'system' && row.content.startsWith('CetaMesh post-write verification feedback'))
  .map(row => JSON.parse(row.content.split('\n').slice(1).join('\n')));

async function cumulativeIgnoredPostimages() {
  for (const sameFileRepair of [false, true]) {
    const helperBefore = 'export const helper = 1;\n', helperAfter = 'export const helper = 2;\n';
    const firstMath = sameFileRepair ? broken : repaired;
    const f = await coreFixture({ grants: ['filesystem.read', 'filesystem.write', 'test.run', 'git.diff'], calls: [
      structuredCall('cumulative-readme', 'filesystem.write', { path: 'README.md', expectedHash: sha('before\n'), content: 'changed\n' }),
      structuredCall('cumulative-first', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(original), content: firstMath }),
      structuredCall('cumulative-second', 'filesystem.write', sameFileRepair
        ? { path: 'math.mjs', expectedHash: sha(firstMath), content: repaired }
        : { path: 'helper.mjs', expectedHash: sha(helperBefore), content: helperAfter }),
      structuredCall('cumulative-diff', 'git.diff', {})
    ] });
    try {
      fs.writeFileSync(path.join(f.project, 'README.md'), 'before\n');
      fs.writeFileSync(path.join(f.project, 'helper.mjs'), helperBefore);
      fs.writeFileSync(path.join(f.project, '.gitignore'), 'math.mjs\nhelper.mjs\n');
      for (const args of [['init', '-q', f.project], ['-C', f.project, 'config', 'core.autocrlf', 'false'], ['-C', f.project, 'add', '.'],
        ['-C', f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline']]) {
        execFileSync('git', args, { stdio: 'ignore' });
      }
      let pending = await f.coordinator.run(f.options); const approvals = [];
      while (pending.status === 'pending') {
        const request = f.capabilities.broker.approvals.get(pending.approvalId).request;
        approvals.push({ capability: request.capability, operationId: request.operationId });
        if (!sameFileRepair && request.capability === 'test.run' && approvals.filter(row => row.capability === 'test.run').length === 2) {
          const omitted = structuredClone(request);
          omitted.requestId = 'forged-cumulative-omission'; omitted.operationId = 'forged-cumulative-omission';
          omitted.origin.postWriteVerification.writes = omitted.origin.postWriteVerification.writes.filter(row => row.path !== 'math.mjs');
          omitted.origin.postWriteVerification.sourceWriteIds = omitted.origin.postWriteVerification.writes.map(row => row.eventId);
          await assert.rejects(f.capabilities.broker.execute(omitted), { code: 'POST_WRITE_RECEIPT_UNVERIFIED' },
            'correct current digests and the newest source cannot hide an earlier actual current-Run write from an approval target');
        }
        await f.decide(pending); pending = f.lastResume;
      }
      assert.deepEqual(approvals.map(row => row.capability), ['filesystem.write', 'filesystem.write', 'test.run', 'filesystem.write', 'test.run']);
      assert.equal(new Set(approvals.filter(row => row.capability === 'test.run').map(row => row.operationId)).size, 2);
      assert.equal(f.starts(), 2, 'two separate approvals start exactly two actual fixed Node tests');
      f.tasks.observeExecution({ id: f.task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'verification-run', phase: 'user', state: 'awaiting-review' });
      for (const criterion of f.tasks.get({ id: f.task.id }).task.acceptance) {
        const current = f.tasks.get({ id: f.task.id }).task;
        f.tasks.setAcceptance({ id: f.task.id, expectedRev: current.rev, acceptanceId: criterion.id, met: true });
      }
      const query = { id: f.task.id, kind: 'code', requireCurrentCodeEvidence: true };
      const loadRuntime = () => createTaskRuntime({ stateDir: f.stateDir,
        resolveWorkspace: id => f.workspaceService.describeWorkspace(id),
        resolvePostWriteVerification: input => f.workspaceService.resolvePostWriteVerification(input) });
      const reloaded = loadRuntime();
      const stored = createTaskStore({ stateDir: f.stateDir }).get(f.task.id);
      const tests = stored.executionEvidence.filter(row => row.source === 'core-test');
      assert.equal(tests.length, 2); assert.equal(tests[1].exitCode, 0);
      assert.equal(tests[0].exitCode === 0, !sameFileRepair);
      assert.equal((await f.tasks.verifyOutcome(query)).status, 'VERIFIED');
      assert.equal((await reloaded.verifyOutcome(query)).status, 'VERIFIED', 'current serialized evidence remains queryable after Task runtime reload');
      const beforeDigest = (await f.workspaceService.resolvePostWriteVerification({ workspaceId: f.workspace.id })).sourceDigest;
      fs.writeFileSync(path.join(f.project, 'math.mjs'), broken);
      const afterDigest = (await f.workspaceService.resolvePostWriteVerification({ workspaceId: f.workspace.id })).sourceDigest;
      assert.equal(afterDigest, beforeDigest, 'the real filtered source snapshot excludes both ignored written files');
      const stale = await f.tasks.verifyOutcome(query), staleReloaded = await reloaded.verifyOutcome(query);
      assert.equal(f.starts(), 2, 'read-only verification never replays a test to manufacture proof');
      const control = await createIsolatedTestRunner({ resolveWorkspace: id => f.workspaceService.describeWorkspace(id) })
        .run({ workspaceId: f.workspace.id, tool: 'npm', args: ['test'], timeoutMs: 30000 });
      assert.notEqual(control.exitCode, 0); assert.match(control.stdout + control.stderr, /R02_OWNED_FIXED_ASSERTION/);
      assert.deepEqual(stale.reasons, ['POST_WRITE_POSTIMAGE_CHANGED'],
        'changing an earlier ignored Core-written file after a later passing check must not remain VERIFIED: ' + JSON.stringify(stale));
      assert.deepEqual(staleReloaded.reasons, ['POST_WRITE_POSTIMAGE_CHANGED']);
      assert.deepEqual(tests[1].postWriteVerification.writes.map(row => row.path).sort(), sameFileRepair ? ['math.mjs'] : ['helper.mjs', 'math.mjs'],
        'new Core-test metadata contains cumulative latest postimages rather than only the newest trigger');
      assert.equal(tests[1].postWriteVerification.writes.find(row => row.path === 'math.mjs').sha256, sha(repaired));
      fs.writeFileSync(path.join(f.project, 'math.mjs'), repaired);
      assert.equal((await reloaded.verifyOutcome(query)).status, 'VERIFIED', 'a valid same-path repair replaces its obsolete earlier hash');
      assert.equal(f.starts(), 3, 'restoring exact postimages only reopens the retained proof; the third start was the independent control');
      // Persist the former non-cumulative shape using only the actual retained
      // source events/hashes. New readers must also protect this older encoding.
      const legacyStore = createTaskStore({ stateDir: f.stateDir });
      legacyStore.update(f.task.id, stored.rev, draft => {
        const legacyTests = draft.executionEvidence.filter(row => row.source === 'core-test');
        for (let index = 0; index < legacyTests.length; index++) {
          const receipt = legacyTests[index], path = index === 0 || sameFileRepair ? 'math.mjs' : 'helper.mjs';
          const write = receipt.postWriteVerification.writes.find(row => row.path === path);
          receipt.postWriteVerification.writes = [write]; receipt.postWriteVerification.sourceWriteIds = [write.eventId];
        }
        return draft;
      });
      const legacyReloaded = loadRuntime();
      assert.equal((await legacyReloaded.verifyOutcome(query)).status, 'VERIFIED', 'old per-check metadata remains valid for unchanged current files');
      fs.writeFileSync(path.join(f.project, 'math.mjs'), broken);
      assert.deepEqual((await legacyReloaded.verifyOutcome(query)).reasons, ['POST_WRITE_POSTIMAGE_CHANGED'],
        'legacy metadata must aggregate older current-Run checked paths after reload');
      fs.writeFileSync(path.join(f.project, 'math.mjs'), repaired);
      if (!sameFileRepair) {
        const previous = legacyStore.get(f.task.id);
        legacyStore.update(f.task.id, previous.rev, draft => {
          delete draft.executionEvidence.filter(row => row.source === 'core-test')[1].postWriteVerification;
          return draft;
        });
        assert.deepEqual((await loadRuntime().verifyOutcome(query)).reasons, ['POST_WRITE_RECEIPT_UNVERIFIED'],
          'an older bound receipt cannot hide a newer matching Core write whose exact checked hash is unavailable');
      }
      const scopeReader = loadRuntime();
      const current = scopeReader.get({ id: f.task.id }).task;
      scopeReader.beginExecutionObservation({ id: f.task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'different-current-run', phase: 'user' });
      scopeReader.observeExecution({ id: f.task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'different-current-run', phase: 'user', state: 'awaiting-review' });
      assert.notEqual((await scopeReader.verifyOutcome(query)).status, 'VERIFIED', 'retained old Run bindings cannot become current Run proof');
      const moved = scopeReader.get({ id: current.id }).task;
      scopeReader.attachAgent({ id: moved.id, expectedRev: moved.rev, provider: 'cetamesh', sessionId: 'different-assignment' });
      assert.notEqual((await scopeReader.verifyOutcome(query)).status, 'VERIFIED', 'another assignment cannot inherit current-code verification');
      assert.equal(f.starts(), 3); assert.equal(f.capabilities.broker.approvals.list().length, 0);
      console.log('PASS cumulative ignored postimages / ' + (sameFileRepair ? 'legitimate same-path repair' : 'two independently checked files')
        + ' preserve latest actual hashes, old/new reload queries, current identity and no replay');
    } finally { await f.close(); }
  }
}

async function sourceProofWithoutAcceptance() {
  const f = await coreFixture();
  try {
    const pending = await f.writeThenPendingTest(); await f.decide(pending);
    f.tasks.observeExecution({ id: f.task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'verification-run', phase: 'user', state: 'awaiting-review' });
    const task = f.tasks.get({ id: f.task.id }).task;
    const test = task.executionEvidence.find(row => row.source === 'core-test');
    assert.notEqual(test.exitCode, 0); assert.equal(test.status, 'completed');
    assert.ok(task.acceptance.every(row => row.met !== true));
    const postWriteVerification = await f.workspaceService.resolvePostWriteVerification({ workspaceId: f.workspace.id });
    const proof = verifyPostWriteCurrentSource(task, test, { workspaceRoot: f.project, postWriteVerification });
    assert.equal(proof.status, 'VERIFIED'); assert.equal(proof.kind, 'post-write-source');
    assert.deepEqual(proof.evidenceEventIds, [test.eventId], 'source provenance can be valid for an actual failing test without asserting test success');
    assert.deepEqual((await f.tasks.verifyOutcome({ id: f.task.id, kind: 'code', requireCurrentCodeEvidence: true })).reasons, ['ACCEPTANCE_UNVERIFIED']);
    assert.deepEqual(f.tasks.get({ id: f.task.id }).task.acceptance, task.acceptance, 'machine source proof never manufactures Owner semantic review');
    assert.equal(f.starts(), 1);
    console.log('PASS shared current-source proof validates a real failed Core receipt without semantic acceptance or test replay');
  } finally { await f.close(); }
}

async function boundedCoreChecks() {
  for (const [label, settings, code] of [
    ['missing', null, 'POST_WRITE_NOT_CONFIGURED'], ['disabled', { ...config, enabled: false }, 'POST_WRITE_DISABLED'],
    ['extension mismatch', { ...config, includeExtensions: ['.rs'] }, 'POST_WRITE_NO_MATCH'],
    ['zero runs', { ...config, maxRunsPerTurn: 0 }, 'VERIFICATION_BUDGET_EXHAUSTED']
  ]) {
    const f = await coreFixture({ settings });
    try {
      const write = await f.coordinator.run(f.options); await f.decide(write);
      assert.equal(f.lastResume.status, 'completed'); assert.equal(f.starts(), 0);
      assert.equal(f.capabilities.broker.approvals.list().length, 0);
      assert.equal(fs.readFileSync(path.join(f.project, 'math.mjs'), 'utf8'), broken, 'the approved write still succeeds');
      assert.equal(skippedFacts(f.requests[1].messages)[0].code, code);
      console.log('PASS post-write ' + label + ' settings preserve the write and provide explicit not-run feedback without launching');
    } finally { await f.close(); }
  }
  for (const [label, extra, code] of [
    ['absent Task test grant', { grants: ['filesystem.write'] }, 'PERMISSION_DENIED'],
    ['unavailable runner', { runnerAvailable: false }, 'TEST_SANDBOX_UNAVAILABLE'],
    ['exhausted total call budget', { maxCalls: 1 }, 'TOOL_CALL_LIMIT']
  ]) {
    const f = await coreFixture(extra);
    try {
      const write = await f.coordinator.run(f.options); await f.decide(write);
      assert.equal(f.lastResume.status, 'completed'); assert.equal(f.starts(), 0);
      const result = verificationResults(f.requests[1].messages)[0]?.postWriteVerification ?? skippedFacts(f.requests[1].messages)[0];
      assert.equal(result.state, 'not-run'); assert.equal(result.code, code);
      assert.equal(f.capabilities.broker.approvals.list().length, 0);
      console.log('PASS ' + label + ' cannot be bypassed by enabled Owner verification settings');
    } finally { await f.close(); }
  }
  {
    const f = await coreFixture();
    try {
      const write = await f.coordinator.run({ ...f.options, actor: owner, scope: { taskId: null, workspaceId: f.workspace.id },
        targetKind: 'chat', runId: null, phase: null });
      assert.equal(write.status, 'pending');
      await f.decide(write);
      assert.equal(f.lastResume.status, 'completed'); assert.equal(f.starts(), 0);
      assert.equal(skippedFacts(f.requests[1].messages)[0].code, 'POST_WRITE_TASK_REQUIRED');
      console.log('PASS ordinary Owner Chat receives explicit Task-required feedback and cannot invoke legacy unrestricted Owner testCommand automatically');
    } finally { await f.close(); }
  }
  for (const mode of ['config', 'verifier', 'package', 'postimage']) {
    const f = await coreFixture();
    try {
      const pending = await f.writeThenPendingTest();
      if (mode === 'config') await f.workspaceService.execute({ method: 'workspace.settings', params: { id: f.workspace.id, patch: { postWriteVerification: { ...config, timeoutMs: 31000 } } } });
      else fs.appendFileSync(path.join(f.project, mode === 'verifier' ? 'verify.mjs' : mode === 'package' ? 'package.json' : 'math.mjs'), '\n');
      const code = mode === 'config' ? 'POST_WRITE_CONFIG_CHANGED' : 'POST_WRITE_SOURCE_CHANGED';
      await assert.rejects(f.decide(pending), { code });
      assert.equal(f.starts(), 0, 'stale approved source/configuration cannot enter the runner');
      assert.equal(f.capabilities.broker.approvals.get(pending.approvalId).status, 'revoked');
      assert.equal(f.lastResume.status, 'completed', 'known unexecuted stale approval settles its existing continuation with denial feedback');
      const result = verificationResults(f.requests[1].messages)[0];
      assert.equal(result.postWriteVerification.state, 'not-run'); assert.equal(result.postWriteVerification.code, code);
      console.log('PASS stale pending ' + mode + ' refuses before execution and delivers explicit not-run feedback');
    } finally { await f.close(); }
  }
  {
    const f = await coreFixture();
    try {
      const snapshot = await f.workspaceService.resolvePostWriteVerification({ workspaceId: f.workspace.id });
      await assert.rejects(f.capabilities.broker.execute({ actor: f.options.actor, taskId: f.task.id, workspaceId: f.workspace.id,
        requestId: 'forged-origin', operationId: 'forged-operation', capability: 'test.run', input: { tool: 'npm', args: ['test'], timeoutMs: 30000 },
        origin: { sessionId: 'verification-session', runId: 'verification-run', phase: 'user', targetKind: 'agent',
          postWriteVerification: { configDigest: snapshot.configDigest, sourceDigest: snapshot.sourceDigest, sourceWriteIds: ['invented-write'],
            writes: [{ eventId: 'invented-write', requestId: 'invented-request', path: 'math.mjs', sha256: sha(original) }] } } }),
      { code: 'POST_WRITE_RECEIPT_UNVERIFIED' });
      assert.equal(f.starts(), 0); assert.equal(f.capabilities.broker.approvals.list().length, 0);
      console.log('PASS forged origin with correct config/source hashes cannot manufacture actual approved Core write provenance');
    } finally { await f.close(); }
  }
  {
    const calls = [structuredCall('write-a', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(original), content: broken }),
      structuredCall('write-b', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(broken), content: repaired }),
      structuredCall('write-c', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(repaired), content: broken })];
    const f = await coreFixture({ calls });
    try {
      let pending = await f.coordinator.run(f.options); const order = [];
      while (pending.status === 'pending') {
        const request = f.capabilities.broker.approvals.get(pending.approvalId).request; order.push(request.capability);
        if (request.capability === 'filesystem.write') assert.equal(f.starts(), order.filter(row => row === 'test.run').length,
          'the previous fresh verification completes before a subsequent model write is dispatched');
        await f.decide(pending); pending = f.lastResume;
      }
      assert.deepEqual(order, ['filesystem.write', 'test.run', 'filesystem.write', 'test.run', 'filesystem.write']);
      assert.equal(f.starts(), 2); assert.equal(f.requests.length, 2);
      const messages = f.requests[1].messages;
      const originalBatch = messages.findIndex(row => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'write-a');
      assert.deepEqual(messages.slice(originalBatch + 1, originalBatch + 4).map(row => row.tool_call_id), ['write-a', 'write-b', 'write-c']);
      assert.equal(messages[originalBatch + 4].role, 'assistant', 'server tool pair follows the fully settled original model batch');
      assert.deepEqual(verificationResults(messages).map(row => row.postWriteVerification.state), ['failed', 'passed']);
      assert.equal(skippedFacts(messages)[0].code, 'VERIFICATION_BUDGET_EXHAUSTED');
      assert.equal(f.lastResume.totalCalls, 5, 'two automatic verifiers consume the same total call budget as original calls');
      console.log('PASS serial verification barriers retain a valid original three-write batch, fresh IDs and shared two-check/call budgets');
    } finally { await f.close(); }
  }
  {
    const f = await coreFixture({ calls: [structuredCall('explicit-write', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(original), content: broken }),
      structuredCall('explicit-test', 'test.run', { timeoutMs: 30000, args: ['test'], tool: 'npm' })] });
    try {
      let pending = await f.coordinator.run(f.options); let approvals = 0;
      while (pending.status === 'pending') { approvals++; await f.decide(pending); pending = f.lastResume; }
      assert.equal(approvals, 2); assert.equal(f.starts(), 1); assert.equal(pending.totalCalls, 2);
      assert.deepEqual(f.requests[1].messages.filter(row => row.role === 'tool').map(row => row.tool_call_id), ['explicit-write', 'explicit-test']);
      assert.equal(verificationResults(f.requests[1].messages)[0].postWriteVerification.state, 'failed');
      console.log('PASS an adjacent exact model-requested current-postimage test retains its original pair and avoids duplicate verifier execution');
    } finally { await f.close(); }
  }
  {
    const f = await coreFixture({ verifierPrefix: "console.log('bounded-owned-output: ' + 'x'.repeat(30000));" });
    try {
      const pending = await f.writeThenPendingTest(); await f.decide(pending);
      const result = verificationResults(f.requests[1].messages)[0];
      assert.equal(result?.postWriteVerification.state, 'failed', 'bounded output still carries the separately bounded actual-check feedback');
      assert.equal(result.status, 'incomplete'); assert.equal(result.truncated, true);
      assert.ok(f.requests[1].messages.filter(row => row.role === 'tool').every(row => row.content.length <= 12000));
      console.log('PASS large actual verifier diagnostics remain incomplete while retaining bounded current-check feedback');
    } finally { await f.close(); }
  }
  {
    const f = await coreFixture({ grants: ['filesystem.read', 'filesystem.write', 'test.run', 'git.diff'], calls: [structuredCall('readme-write', 'filesystem.write', { path: 'README.md', expectedHash: sha('before\n'), content: 'changed\n' }),
      structuredCall('ignored-source-write', 'filesystem.write', { path: 'math.mjs', expectedHash: sha(original), content: repaired }),
      structuredCall('actual-diff', 'git.diff', {})] });
    try {
      fs.writeFileSync(path.join(f.project, 'README.md'), 'before\n');
      fs.writeFileSync(path.join(f.project, '.gitignore'), 'math.mjs\n');
      for (const args of [['init', '-q', f.project], ['-C', f.project, 'config', 'core.autocrlf', 'false'], ['-C', f.project, 'add', '.'],
        ['-C', f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline']]) {
        execFileSync('git', args, { stdio: 'ignore' });
      }
      let pending = await f.coordinator.run(f.options);
      while (pending.status === 'pending') { await f.decide(pending); pending = f.lastResume; }
      assert.equal(f.starts(), 1);
      f.tasks.observeExecution({ id: f.task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'verification-run', phase: 'user', state: 'awaiting-review' });
      for (const criterion of f.tasks.get({ id: f.task.id }).task.acceptance) {
        const current = f.tasks.get({ id: f.task.id }).task;
        f.tasks.setAcceptance({ id: f.task.id, expectedRev: current.rev, acceptanceId: criterion.id, met: true });
      }
      const verified = await f.tasks.verifyOutcome({ id: f.task.id, kind: 'code', requireCurrentCodeEvidence: true });
      assert.equal(verified.status, 'VERIFIED', JSON.stringify(verified));
      const coreTest = f.tasks.get({ id: f.task.id }).task.executionEvidence.find(row => row.source === 'core-test');
      fs.appendFileSync(path.join(f.project, 'math.mjs'), '// ignored external edit\n');
      assert.equal((await f.workspaceService.resolvePostWriteVerification({ workspaceId: f.workspace.id })).sourceDigest,
        coreTest.postWriteVerification.sourceDigest, 'the independently observed broad Git snapshot intentionally omits this ignored source');
      assert.deepEqual((await f.tasks.verifyOutcome({ id: f.task.id, kind: 'code', requireCurrentCodeEvidence: true })).reasons,
        ['POST_WRITE_POSTIMAGE_CHANGED'], 'strict verification separately reopens every exact written postimage, including ignored files');
      console.log('PASS strict current-code verification independently rechecks exact ignored write postimages beyond the broader Workspace source snapshot');
    } finally { await f.close(); }
  }
  {
    const f = await coreFixture();
    try {
      const pending = await f.writeThenPendingTest();
      const approval = f.capabilities.broker.approvals.get(pending.approvalId);
      f.responses.push(Object.assign(new Error('Owned first continuation transport fault'), { code: 'R02_MODEL_TRANSPORT_LOST' }), []);
      await assert.rejects(f.decide(pending), { code: 'R02_MODEL_TRANSPORT_LOST' });
      assert.equal(f.starts(), 1);
      const resumed = await f.coordinator.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint,
        decisionResult: { status: 'completed' }, ...f.callbacks });
      assert.equal(resumed.status, 'completed'); assert.equal(f.starts(), 1, 'model-only continuation retry never repeats the settled test');
      assert.equal(verificationResults(f.requests[2].messages).length, 1);
      await assert.rejects(f.coordinator.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint,
        decisionResult: { status: 'completed' }, ...f.callbacks }), { code: 'APPROVAL_CONTINUATION_NOT_FOUND' });
      console.log('PASS model-only retry retains the completed synthetic pair and duplicate approval ACK cannot repeat the actual test');
    } finally { await f.close(); }
  }
  for (const control of ['reject', 'cancel', 'restart', 'unknown-test', 'unknown-write']) {
    const f = await coreFixture({ loseTestReceipt: control === 'unknown-test', loseWriteReceipt: control === 'unknown-write' });
    try {
      if (control === 'unknown-write') {
        const write = await f.coordinator.run(f.options);
        await assert.rejects(f.decide(write), error => error.effectStatus === 'unknown');
        assert.equal(f.lastResume.code, 'OUTCOME_UNKNOWN'); assert.equal(f.starts(), 0); assert.equal(f.requests.length, 1);
      } else {
        const pending = await f.writeThenPendingTest();
        if (control === 'reject') {
          await f.decide(pending, false); assert.equal(f.lastResume.status, 'completed');
          assert.equal(verificationResults(f.requests[1].messages)[0].postWriteVerification.code, 'APPROVAL_REJECTED');
          assert.equal(f.starts(), 0);
        } else if (control === 'cancel') {
          assert.equal(f.coordinator.cancelSession('verification-session').cancelled, 1);
          assert.equal(f.capabilities.broker.approvals.get(pending.approvalId).status, 'cancelled');
          await assert.rejects(f.decide(pending), { code: 'APPROVAL_ALREADY_DECIDED' }); assert.equal(f.starts(), 0);
        } else if (control === 'restart') {
          const restored = createToolExecutionCoordinator(f.coordinatorOptions);
          assert.equal(f.capabilities.broker.approvals.get(pending.approvalId).status, 'revoked');
          assert.equal(restored.pendingTarget(pending.approvalId), null);
          await assert.rejects(restored.run({ ...f.options, turnId: 'after-restart' }), { code: 'REQUEST_RECOVERY_REQUIRED' }); assert.equal(f.starts(), 0);
        } else {
          await assert.rejects(f.decide(pending), error => error.effectStatus === 'unknown');
          assert.equal(f.lastResume.code, 'OUTCOME_UNKNOWN'); assert.equal(f.starts(), 1); assert.equal(f.requests.length, 1);
          assert.equal(f.tasks.get({ id: f.task.id }).task.executionEvidence.some(row => row.source === 'core-test'), false,
            'lost actual process receipt never creates a verified Core-test result');
          await assert.rejects(f.coordinator.run({ ...f.options, turnId: 'no-replay' }), { code: 'REQUEST_RECOVERY_REQUIRED' });
          assert.equal(f.starts(), 1);
        }
        if (control !== 'reject') assert.equal(f.requests.length, 1, 'cancel/restart/unknown cannot continue model execution');
      }
      console.log('PASS post-write ' + control + ' preserves original receipts and never launches or replays an unapproved/unknown verifier');
    } finally { await f.close(); }
  }
}

async function importedVerification() {
  const f = await coreFixture({ provider: 'fixture-native' });
  const binding = { taskId: f.task.id, workspaceId: f.workspace.id, provider: 'fixture-native',
    sessionId: 'verification-session', runId: 'verification-run', phase: 'user' };
  const change = (name, content) => ({ action: content === null ? 'delete' : 'write', path: name,
    expectedHash: fs.existsSync(path.join(f.project, name)) ? sha(fs.readFileSync(path.join(f.project, name))) : null,
    hash: content === null ? null : sha(content), ...(content === null ? {} : { content }) });
  try {
    fs.writeFileSync(path.join(f.project, 'obsolete.mjs'), '// remove me\n');
    const first = await f.capabilities.applyAgentWorkspaceChanges({ ...binding, requestId: 'fixture-import-one',
      changes: [change('math.mjs', broken), change('新增.mjs', '// UTF-8 保留\r\n'), change('obsolete.mjs', null)] });
    assert.equal(first.status, 'pending'); assert.equal(f.starts(), 0);
    const imported = await f.decide(first);
    assert.equal(imported.status, 'completed', 'a successful import is independent of test approval');
    assert.equal(fs.readFileSync(path.join(f.project, 'math.mjs'), 'utf8'), broken);
    const check = f.capabilities.broker.approvals.list().find(row => row.request.capability === 'test.run');
    assert.ok(check, 'settled native import must queue a distinct fresh test approval: '+JSON.stringify(f.tasks.get({id:f.task.id}).task.executionEvidence));
    assert.notEqual(check.id, first.approvalId); assert.equal(f.starts(), 0);
    f.tasks.observeExecution({ id: f.task.id, ...binding, state: 'awaiting-review' });
    await f.decide({ approvalId: check.id });
    assert.equal(f.starts(), 1);
    let tests = f.tasks.get({ id: f.task.id }).task.executionEvidence.filter(row => row.source === 'core-test');
    assert.equal(tests.length, 1); assert.notEqual(tests[0].exitCode, 0);
    assert.match(tests[0].diagnostics?.stderr ?? '', /R02_OWNED_FIXED_ASSERTION/);
    const context = buildTaskContext({task:f.tasks.get({id:f.task.id}).task,workspace:f.workspace});
    assert.match(JSON.stringify(context),/R02_OWNED_FIXED_ASSERTION/,'next authorized continuation receives retained failed-test diagnostics as Task reference data');
    const sensitiveTask=structuredClone(f.tasks.get({id:f.task.id}).task);
    sensitiveTask.executionEvidence.find(row=>row.source==='core-test').diagnostics.stderr+='\nAuthorization: Bearer fixture_secret_123456\n'+'.'.repeat(9000);
    const projected=buildProductContext({task:sensitiveTask,workspace:f.workspace});
    assert.doesNotMatch(projected,/fixture_secret_123456/);assert.match(projected,/untrusted-test-reference/);
    f.responses.splice(0,f.responses.length,[]);
    await f.coordinator.run({...f.options,turnId:'explicit-diagnostic-followup',messages:[{role:'system',content:projected},{role:'user',content:'Read this retained diagnostic; do not execute tools.'}]});
    assert.match(JSON.stringify(f.requests.at(-1).messages),/R02_OWNED_FIXED_ASSERTION/);
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages),/fixture_secret_123456/);
    assert.equal(f.starts(),1,'authorized read-only continuation cannot rerun a test from diagnostic text');
    assert.equal(tests[0].postWriteVerification.writes.length, 3, 'one import event binds all matching create/update/delete paths');
    assert.equal(verifyPostWriteCurrentSource(f.tasks.get({id:f.task.id}).task, tests[0], {workspaceRoot:f.project,
      postWriteVerification:await f.workspaceService.resolvePostWriteVerification({workspaceId:f.workspace.id})}).status, 'VERIFIED');
    f.tasks.observeExecution({ id: f.task.id, ...binding, state: 'running' });
    const repair = await f.capabilities.applyAgentWorkspaceChanges({ ...binding, requestId: 'fixture-import-repair',
      changes: [change('math.mjs', repaired), change('obsolete.mjs', '// recreated\n')] });
    await f.decide(repair);
    const next = f.capabilities.broker.approvals.list().find(row => row.request.capability === 'test.run');
    assert.ok(next); assert.notEqual(next.request.operationId, check.request.operationId);
    await f.decide({ approvalId: next.id }); assert.equal(f.starts(), 2);
    tests = f.tasks.get({ id: f.task.id }).task.executionEvidence.filter(row => row.source === 'core-test');
    assert.equal(tests.at(-1).exitCode, 0);
    assert.match(tests.at(-1).diagnostics.stdout, /R02_OWNED_PASS/);
    const ui=createDesktopUiService({services:{workspaceService:f.workspaceService,taskService:{runtime:f.tasks},capabilityService:f.capabilities}});
    const status=await ui.execute({method:'ui.workspace.verification.get',params:{id:f.workspace.id}});
    assert.deepEqual(status.checks.map(row=>row.state),['passed','failed'],'settled checks replace pending projections without duplicate or false pending rows');
    assert.notEqual(f.tasks.get({id:f.task.id}).task.status, 'completed');
    assert.deepEqual(createTaskStore({stateDir:f.stateDir}).get(f.task.id).executionEvidence.filter(row=>row.source==='core-test'), tests);
    const third=await f.capabilities.applyAgentWorkspaceChanges({...binding,requestId:'fixture-import-budget',changes:[change('math.mjs',repaired+'// third\n')]});
    await f.decide(third);assert.equal(f.starts(),2);
    assert.equal(f.tasks.get({id:f.task.id}).task.executionEvidence.at(-1).verificationStatus.code,'VERIFICATION_BUDGET_EXHAUSTED');
    console.log('PASS real native import create/update/delete -> distinct approved failing Node test -> separately approved repair -> fresh passing test');
  } finally { await f.close(); }
}

async function verificationOwnerSurface() {
  const f = await coreFixture({settings:null});
  try {
    const ui = createDesktopUiService({services:{workspaceService:f.workspaceService,taskService:{runtime:f.tasks},capabilityService:f.capabilities}});
    const read = () => ui.execute({method:'ui.workspace.verification.get',params:{id:f.workspace.id}});
    const initial = await read(); assert.equal(initial.config,null); assert.equal(initial.configDigest,null);
    const saved = await ui.execute({method:'ui.workspace.verification.update',params:{id:f.workspace.id,config,expectedConfigDigest:null}});
    assert.equal(saved.config.enabled,true); assert.equal(f.starts(),0);
    assert.deepEqual(createWorkspaceService({stateDir:f.stateDir}).readPostWriteVerificationConfig({workspaceId:f.workspace.id}),{...config,configDigest:saved.configDigest});
    await assert.rejects(ui.execute({method:'ui.workspace.verification.update',params:{id:f.workspace.id,config:{...config,enabled:false},expectedConfigDigest:null}}),{code:'POST_WRITE_CONFIG_CONFLICT'});
    assert.equal((await read()).config.enabled,true);
    console.log('PASS Owner Core verification settings persist without executing and stale saves fail closed');
  } finally {await f.close();}
}

async function importedNegatives() {
  const cases=[
    {name:'disabled',settings:{...config,enabled:false},code:'POST_WRITE_DISABLED'},
    {name:'zero-budget',settings:{...config,maxRunsPerTurn:0},code:'VERIFICATION_BUDGET_EXHAUSTED'},
    {name:'not-configured',settings:null,code:'POST_WRITE_NOT_CONFIGURED'},
    {name:'unmatched',settings:{...config,includeExtensions:['.rs']},code:'POST_WRITE_NO_MATCH'},
    {name:'missing-grant',grants:['filesystem.read','filesystem.write'],code:'POST_WRITE_TEST_GRANT_REQUIRED'},
    {name:'rejected-import',rejectImport:true},
    {name:'unknown-import',unknownImport:true},
    {name:'changed-config',alter:async f=>f.workspaceService.execute({method:'workspace.settings',params:{id:f.workspace.id,patch:{postWriteVerification:{...config,timeoutMs:31000}}}}),code:'POST_WRITE_CONFIG_CHANGED'},
    {name:'changed-source',alter:async f=>fs.appendFileSync(path.join(f.project,'verify.mjs'),'// changed verifier\n'),code:'POST_WRITE_SOURCE_CHANGED'},
    {name:'changed-byte',alter:async f=>fs.writeFileSync(path.join(f.project,'math.mjs'),original),code:'POST_WRITE_SOURCE_CHANGED'},
    {name:'cancelled-run',alter:async f=>f.tasks.observeExecution({id:f.task.id,provider:'fixture-native',sessionId:'verification-session',runId:'verification-run',phase:'user',state:'cancelled'}),code:'POST_WRITE_RUN_CHANGED'},
    {name:'new-run',alter:async f=>f.tasks.beginExecutionObservation({id:f.task.id,provider:'fixture-native',sessionId:'verification-session',runId:'replacement-run',phase:'user'}),code:'POST_WRITE_RUN_CHANGED'},
    {name:'forged-operation',forge:'operationId'},
    {name:'forged-postimage',forge:'sha256'},
    {name:'rejected-test',rejectTest:true},
    {name:'unknown-test',loseTestReceipt:true},
    {name:'oversize-scope',many:true,code:'POST_WRITE_SOURCE_UNAVAILABLE'}
  ];
  for(const options of cases) {
    const f=await coreFixture({...options,provider:'fixture-native'});
    try {
      if(options.unknownImport){const actual=f.workspaceService.applyChanges;f.workspaceService.applyChanges=async args=>{await actual(args);throw Object.assign(Error('Owned lost import receipt'),{code:'OWNED_IMPORT_UNKNOWN',effectStatus:'unknown'});};}
      const changes=options.many?Array.from({length:25},(_,i)=>({action:'write',path:'source-'+i+'.mjs',expectedHash:null,content:'// '+i,hash:sha('// '+i)}))
        :[{action:'write',path:'math.mjs',expectedHash:sha(original),content:broken,hash:sha(broken)}];
      const request={taskId:f.task.id,workspaceId:f.workspace.id,provider:'fixture-native',sessionId:'verification-session',runId:'verification-run',phase:'user',requestId:'import-'+options.name,changes};
      const imported=await f.capabilities.applyAgentWorkspaceChanges(request);assert.equal(f.starts(),0);
      if(options.unknownImport)await assert.rejects(f.decide(imported),{code:'OWNED_IMPORT_UNKNOWN'});
      else await f.decide(imported,!options.rejectImport);
      const test=f.capabilities.broker.approvals.list().find(row=>row.request.capability==='test.run');
      if(options.rejectImport||options.unknownImport||options.code&&!options.alter){
        assert.equal(test,undefined,options.name);assert.equal(f.starts(),0);
        if(options.code)assert.equal(f.tasks.get({id:f.task.id}).task.executionEvidence.at(-1).verificationStatus.code,options.code);
      } else {
        assert.ok(test,options.name);assert.equal(f.starts(),0);
        if(options.forge){const request=structuredClone(test.request);request.requestId='forged-'+options.forge;request.operationId='forged:'+sha(options.forge);
          request.origin.postWriteVerification.writes[0][options.forge]=options.forge==='sha256'?'0'.repeat(64):'import:'+ '0'.repeat(64);
          await assert.rejects(f.capabilities.broker.execute(request),{code:'POST_WRITE_RECEIPT_UNVERIFIED'});
          await f.decide({approvalId:test.id},false);assert.equal(f.starts(),0);}
        else if(options.alter){await options.alter(f);await assert.rejects(f.decide({approvalId:test.id}),{code:options.code});assert.equal(f.starts(),0);}
        else if(options.rejectTest){await f.decide({approvalId:test.id},false);assert.equal(f.starts(),0);}
        else if(options.loseTestReceipt){await assert.rejects(f.decide({approvalId:test.id}),{code:'R02_TEST_RECEIPT_LOST'});assert.equal(f.starts(),1);}
        assert.equal(fs.readFileSync(path.join(f.project,'math.mjs'),'utf8'),options.name==='changed-byte'?original:broken,'test refusal never rolls back a successful import');
        assert.equal(f.capabilities.broker.approvals.list().filter(row=>row.request.capability==='test.run').length,0);
      }
    } finally {await f.close();}
  }
  const f=await coreFixture({calls:[structuredCall('managed-import','workspace.apply',{changes:[{action:'write',path:'math.mjs',expectedHash:sha(original),content:repaired,hash:sha(repaired)}]})]});
  try {
    let pending=await f.coordinator.run(f.options),decisions=0;
    while(pending.status==='pending'){await f.decide(pending);decisions++;pending=f.lastResume;}
    assert.equal(decisions,2,'Managed import barrier uses exactly import approval and one independent test approval');assert.equal(f.starts(),1);
    assert.ok(f.tasks.get({id:f.task.id}).task.executionEvidence.some(row=>row.source==='core-test'&&row.postWriteVerification.writes[0].capability==='workspace.apply'));
  } finally {await f.close();}
  const restart=await coreFixture({provider:'fixture-native'});let cold;
  try {
    const request={taskId:restart.task.id,workspaceId:restart.workspace.id,provider:'fixture-native',sessionId:'verification-session',runId:'verification-run',phase:'user',requestId:'retained-import',
      changes:[{action:'write',path:'math.mjs',expectedHash:sha(original),content:repaired,hash:sha(repaired)}]};
    const imported=await restart.capabilities.applyAgentWorkspaceChanges(request);await restart.decide(imported);
    const pending=restart.capabilities.broker.approvals.list().find(row=>row.request.capability==='test.run');assert.ok(pending);
    await assert.rejects(restart.capabilities.applyAgentWorkspaceChanges(request));
    assert.equal(restart.capabilities.broker.approvals.list().filter(row=>row.request.capability==='test.run').length,1,'duplicate source cannot queue another verification');
    await restart.capabilities.close();
    const coldTasks=createTaskRuntime({stateDir:restart.stateDir,resolveWorkspace:id=>restart.workspaceService.describeWorkspace(id)});
    coldTasks.recoverInterrupted(); // Same startup command used by createTaskService.
    cold=createCapabilityService({stateDir:restart.stateDir,workspaceService:restart.workspaceService,taskRuntime:coldTasks,
      isolatedRunner:createIsolatedTestRunner({resolveWorkspace:id=>restart.workspaceService.describeWorkspace(id)})});
    assert.equal(cold.broker.approvals.list().filter(row=>row.request.capability==='test.run').length,1,'restart retains the exact approval without inventing a new request');
    await assert.rejects(cold.execute({method:'capability.approval.decide',params:{id:pending.id,approve:true}}),error=>['POST_WRITE_RUN_CHANGED','TASK_NOT_RUNNING','TASK_NOT_AUTHORIZED','AGENT_ASSIGNMENT_EXPIRED'].includes(error.code));
    assert.equal(restart.starts(),0,'cold interrupted Run cannot execute a retained test');
    assert.equal(fs.readFileSync(path.join(restart.project,'math.mjs'),'utf8'),repaired);
  } finally {await cold?.close();await restart.close();}
  console.log('PASS imported check opt-in/grant/limits, rejected and unknown imports/tests, source/config/run changes, and Managed single-check barrier');
}

async function mixedImportedVerification() {
  for(const reload of [false,true]) {
    const f=await coreFixture({provider:'fixture-native'});let restored;
    try {
      const binding={taskId:f.task.id,workspaceId:f.workspace.id,provider:'fixture-native',sessionId:'verification-session',runId:'verification-run',phase:'user'};
      const requestId='mixed-direct-write',content='export const independent = 1;\n';
      const direct=await f.capabilities.broker.execute({actor:f.options.actor,taskId:f.task.id,workspaceId:f.workspace.id,requestId,
        operationId:'tool:'+sha(requestId),capability:'filesystem.write',input:{path:'direct.mjs',content},
        origin:{targetKind:'agent',phase:'user',sessionId:binding.sessionId,runId:binding.runId}});
      await f.decide(direct);
      f.tasks.recordToolOutcome({id:f.task.id,...binding,eventId:'direct-event',capability:'filesystem.write',status:'completed',filePath:'direct.mjs'});
      // Storage reconstruction only; full cold-start recovery is independently tested above.
      const tasks=reload?createTaskRuntime({stateDir:f.stateDir,resolveWorkspace:id=>f.workspaceService.describeWorkspace(id)}):f.tasks;
      if(reload){
        await f.capabilities.close();
        // Older completed receipts predate the trusted execution projection.
        // Their consumed original approval must reconstruct the same identity.
        const journal=path.join(f.stateDir,'capability','dispatches.json');
        const retained=JSON.parse(fs.readFileSync(journal,'utf8'));
        for(const row of Object.values(retained))if(row.requestId===requestId&&row.operationProof)delete row.operationProof.execution;
        fs.writeFileSync(journal,JSON.stringify(retained));
        restored=createCapabilityService({stateDir:f.stateDir,workspaceService:f.workspaceService,taskRuntime:tasks,
          isolatedRunner:createIsolatedTestRunner({resolveWorkspace:id=>f.workspaceService.describeWorkspace(id)})});
      }
      const capabilities=restored??f.capabilities;
      const decide=approvalId=>capabilities.execute({method:'capability.approval.decide',params:{id:approvalId,approve:true}});
      const imported=await capabilities.applyAgentWorkspaceChanges({...binding,requestId:'mixed-import',changes:[{action:'write',path:'math.mjs',expectedHash:sha(original),content:repaired,hash:sha(repaired)}]});
      await decide(imported.approvalId);
      const checks=capabilities.broker.approvals.list().filter(row=>row.request.capability==='test.run');
      assert.equal(checks.length,1,'mixed direct/native import must reconstruct cumulative real Broker proof after reload='+reload);
      assert.deepEqual(checks[0].request.origin.postWriteVerification.writes.map(row=>row.path).sort(),['direct.mjs','math.mjs']);
      const directBinding=checks[0].request.origin.postWriteVerification.writes.find(row=>row.path==='direct.mjs');
      assert.equal(directBinding.requestId,requestId);assert.equal(directBinding.sha256,sha(content));
      await decide(checks[0].id);assert.equal(f.starts(),1);
      const evidence=tasks.get({id:f.task.id}).task.executionEvidence.findLast(row=>row.source==='core-test');assert.equal(evidence.exitCode,0);
    } finally {await restored?.close();await f.close();}
  }
  console.log('PASS mixed direct write/native import retains real completed cumulative Broker provenance across storage reload');
}

async function expiredImportedVerification() {
  const f=await coreFixture({provider:'fixture-native',settings:{...config,maxRunsPerTurn:1}}),realNow=Date.now;
  try {
    const binding={taskId:f.task.id,workspaceId:f.workspace.id,provider:'fixture-native',sessionId:'verification-session',runId:'verification-run',phase:'user'};
    const imported=await f.capabilities.applyAgentWorkspaceChanges({...binding,requestId:'expiry-import',changes:[{action:'write',path:'math.mjs',expectedHash:sha(original),content:repaired,hash:sha(repaired)}]});
    await f.decide(imported);
    const old=f.capabilities.broker.approvals.list().find(row=>row.request.capability==='test.run');assert.ok(old);
    Date.now=()=>old.expiresAt+1;
    const ui=createDesktopUiService({services:{workspaceService:f.workspaceService,taskService:{runtime:f.tasks},capabilityService:f.capabilities}});
    const read=()=>ui.execute({method:'ui.workspace.verification.get',params:{id:f.workspace.id}});
    const view=await read();assert.equal(f.capabilities.broker.approvals.list().length,0);
    assert.equal(view.checks[0].state,'not-run','expired Approval-owner row cannot remain actionable pending');
    assert.equal(view.checks[0].code,'APPROVAL_EXPIRED');assert.equal(view.checks[0].canRetry,true);assert.equal(f.starts(),0);
    const retry=()=>ui.execute({method:'ui.workspace.verification.retry',params:{id:f.workspace.id,taskId:f.task.id,approvalId:old.id}});
    const [first,duplicate]=await Promise.all([retry(),retry()]);
    assert.equal(first.status,'pending');assert.equal(duplicate.approvalId,first.approvalId);assert.notEqual(first.approvalId,old.id);
    assert.equal(f.capabilities.broker.approvals.get(old.id).fingerprint,old.fingerprint,'old expired row remains unchanged');
    assert.equal(f.capabilities.broker.approvals.list().length,1);assert.equal(f.starts(),0,'explicit renewal requests a fresh approval only');
    assert.equal((await read()).checks[0].approvalId,first.approvalId);
    await assert.rejects(f.decide({approvalId:old.id}),{code:'APPROVAL_EXPIRED'});
    await f.decide({approvalId:first.approvalId});assert.equal(f.starts(),1,'expired reservation did not consume the single allowed actual check');
    await assert.rejects(retry(),{code:'POST_WRITE_RETRY_NOT_AVAILABLE'});
    assert.equal((await read()).checks[0].state,'passed');
    console.log('PASS Approval-owner expiry, explicit fresh approval recovery, double-click dedup and single-run budget');
  } finally {Date.now=realNow;await f.close();}
}

async function importedRetryRefusals() {
  for(const scenario of ['live','rejected','config','source','grant','cancelled','unknown']) {
    const f=await coreFixture({provider:'fixture-native',loseTestReceipt:scenario==='unknown'}),realNow=Date.now;
    try {
      const binding={taskId:f.task.id,workspaceId:f.workspace.id,provider:'fixture-native',sessionId:'verification-session',runId:'verification-run',phase:'user'};
      const imported=await f.capabilities.applyAgentWorkspaceChanges({...binding,requestId:'retry-refusal-'+scenario,
        changes:[{action:'write',path:'math.mjs',expectedHash:sha(original),content:repaired,hash:sha(repaired)}]});
      await f.decide(imported);const approval=f.capabilities.broker.approvals.list().find(row=>row.request.capability==='test.run');assert.ok(approval);
      const ui=createDesktopUiService({services:{workspaceService:f.workspaceService,taskService:{runtime:f.tasks},capabilityService:f.capabilities}});
      if(scenario==='rejected')await f.decide({approvalId:approval.id},false);
      if(scenario==='unknown')await assert.rejects(f.decide({approvalId:approval.id}),{code:'R02_TEST_RECEIPT_LOST'});
      if(scenario!=='live')Date.now=()=>approval.expiresAt+1;
      if(scenario==='config')await f.workspaceService.execute({method:'workspace.settings',params:{id:f.workspace.id,patch:{postWriteVerification:{...config,timeoutMs:31000}}}});
      if(scenario==='source')fs.appendFileSync(path.join(f.project,'math.mjs'),'// changed after approval\n');
      if(scenario==='grant')f.capabilities.grantTask(f.task.id,{capabilities:['filesystem.read','filesystem.write']});
      if(scenario==='cancelled')f.tasks.observeExecution({id:f.task.id,...binding,state:'cancelled'});
      const codes={live:'POST_WRITE_RETRY_NOT_AVAILABLE',rejected:'POST_WRITE_RETRY_NOT_AVAILABLE',unknown:'POST_WRITE_RETRY_NOT_AVAILABLE',config:'POST_WRITE_CONFIG_CHANGED',source:'POST_WRITE_SOURCE_CHANGED',grant:'PERMISSION_DENIED',cancelled:'POST_WRITE_RUN_CHANGED'};
      await assert.rejects(ui.execute({method:'ui.workspace.verification.retry',params:{id:f.workspace.id,taskId:f.task.id,approvalId:approval.id}}),{code:codes[scenario]});
      assert.equal(f.starts(),scenario==='unknown'?1:0);
      assert.equal(f.capabilities.broker.approvals.get(approval.id).fingerprint,approval.fingerprint);
    } finally {Date.now=realNow;await f.close();}
  }
  console.log('PASS explicit imported-check retry refuses live, rejected, consumed unknown, changed config/source/grant/Run');
}

await expiredImportedVerification();
await importedRetryRefusals();
await mixedImportedVerification();
await verificationOwnerSurface();
await importedVerification();
await importedNegatives();
ownerConfiguration();
await cumulativeIgnoredPostimages();
await sourceProofWithoutAcceptance();
await automaticRepair();
await boundedCoreChecks();
console.log('NOT_RUN: native installed product, paid/remote models, account state and release packaging.');
