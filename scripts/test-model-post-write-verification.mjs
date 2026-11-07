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
  maxCalls = 24, loseTestReceipt = false, runnerAvailable = true, loseWriteReceipt = false, verifierPrefix = '' } = {}) {
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
  task = tasks.start({ id: task.id, expectedRev: task.rev, provider: 'cetamesh', sessionId: 'verification-session' }).task;
  tasks.beginExecutionObservation({ id: task.id, provider: 'cetamesh', sessionId: 'verification-session', runId: 'verification-run', phase: 'user' });
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
  capabilities.setApprovalDecisionListener(async event => { lastResume = await coordinator.resumeApproval({ ...event, ...callbacks });
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

ownerConfiguration();
await cumulativeIgnoredPostimages();
await sourceProofWithoutAcceptance();
await automaticRepair();
await boundedCoreChecks();
console.log('NOT_RUN: native installed product, paid/remote models, account state and release packaging.');
