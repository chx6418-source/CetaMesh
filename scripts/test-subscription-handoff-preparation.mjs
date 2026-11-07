// Real Core preparation regression, with only a local synthetic Managed model leaf.
// No external candidate discovery, Codex session/send, native acceptance budget or approved project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { acceptanceHash, assertProtectedFiles, assertExactHandoffEffect,
  prepareSubscriptionOwnerContract } from './helpers/autonomous-handoff-acceptance.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-subscription-preparation-'));
const project = path.join(root, 'project'), provider = 'local-preparation-coordinator', model = 'synthetic';
const testInput = { tool: 'npm', args: ['test'], timeoutMs: 30000 }, operationId = 'independent-verification';
const evidence = { syntheticCoordinator: true, realCore: true, nativeDispatches: 0, dispatches: [], revisions: [], toolResults: [], approvals: [] };
let services, taskId, chatId, workspaceId, protectedHashes, sourceStep = 0, verificationStep = 0, approved = false;
const resultFor = (request, id) => {
  const row = request.messages.filter(message => message.role === 'tool').findLast(message => message.tool_call_id === id);
  assert.ok(row, 'The actual Core tool response must exist: ' + id);
  const result = JSON.parse(row.content);
  evidence.toolResults.push({ id, status: result.status, code: result.error?.code || null,
    ...(id === 'prepared-test' ? { exitCode: result.result?.exitCode ?? null } : {}) });
  assert.equal(result.status, 'completed', JSON.stringify(result)); return result;
};
const tool = (id, capabilityId, input) => ({ type: 'assistant/tool-calls', data: {
  toolCalls: [{ id, capabilityId, arguments: JSON.stringify(input) }] } });
const final = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
async function waitForReport(marker) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (taskId && !approved) for (const pending of services.capabilityService.broker.approvals.list()) {
      if (pending.status !== 'pending' || pending.request?.taskId !== taskId) continue;
      assert.equal(pending.request.capability, 'test.run', 'This dry run has no native or import approval');
      assertExactHandoffEffect(pending.request, { taskId, workspaceId, project, protectedHashes, allowedPaths: ['sum.js'], testInput, operationId });
      approved = true; evidence.approvals.push({ id: pending.id, capability: pending.request.capability });
      const decision = await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: pending.id, approve: true } });
      assert.equal(decision.status, 'completed'); assert.equal(decision.result.exitCode, 0);
    }
    const history = await services.chatService.execute({ method: 'chat.history', params: { id: chatId } });
    if (history.messages.some(row => row.role === 'assistant' && row.text?.includes(marker))) return history;
    const status = await services.chatService.execute({ method: 'chat.status', params: { id: chatId } });
    assert.equal(status.lastErrorCode ?? null, null, JSON.stringify(status.lastError));
    await delay(50);
  }
  throw Error('Actual Managed dry-run report did not arrive: ' + marker);
}

try {
  fs.mkdirSync(project);
  const files = { 'sum.js': 'exports.sum = (a, b) => a + b;\n',
    'verify.cjs': "const assert=require('node:assert/strict');const {sum}=require('./sum.js');assert.equal(sum(3,4),7);assert.equal(sum(-2,5),3);console.log('PREPARATION_CORE_NODE_VERIFIED');\n",
    'package.json': JSON.stringify({ private: true, scripts: { test: 'node verify.cjs' } }) + '\n' };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(project, file), content);
  protectedHashes = Object.fromEntries(['verify.cjs', 'package.json'].map(file => [file, acceptanceHash(files[file])]));
  const hooks = path.join(root, 'empty-hooks'); fs.mkdirSync(hooks);
  for (const args of [['init', '-q', project], ['-C', project, 'add', '.'], ['-C', project, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=' + hooks, 'commit', '-qm', 'synthetic preparation baseline']])
    execFileSync('git', args, { stdio: 'ignore', windowsHide: true });
  // A trusted fixture-only diff provides real bounded git.diff data. No Agent/import is claimed.
  fs.appendFileSync(path.join(project, 'sum.js'), '// controlled preparation diff\n');
  const secrets = createProviderSecrets({ root: path.join(root, 'data') });
  secrets.set({ provider, apiKey: 'synthetic-local-only' });
  services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
    sourceRoot: root, resourceRoot: root, agentStagingRoot: path.join(root, 'staging'), providerSecrets: secrets });
  const send = services.agentBroker.send.bind(services.agentBroker);
  services.agentBroker.send = async (request, ...rest) => {
    assert.equal(request.provider, 'cetamesh', 'This preparation test must never reach a Codex/external send');
    evidence.dispatches.push({ provider: request.provider, phase: request.phase || 'user' }); return send(request, ...rest);
  };
  const stream = services.modelRuntime.stream.bind(services.modelRuntime);
  services.modelRuntime.stream = request => { assert.equal(request.providerId, provider); return stream(request); };
  services.modelRegistry.register({ id: provider, label: 'Local preparation model', defaultModel: model, supportsTools: true,
    health: async () => ({ configured: true, available: true, synthetic: true }), listModels: async () => [{ id: model }],
    chat: async () => { throw Error('Only synthetic stream is used'); },
    stream: async function* (request) {
      const instruction = request.messages.filter(row => row.role === 'user').at(-1)?.content || '';
      if (instruction.startsWith('DRYRUN_VERIFY_20261107')) {
        const step = verificationStep++;
        if (step === 0) { assert.ok(request.tools.some(row => row.id === 'operation.continue'), 'The fresh turn must expose the Owner-granted continuation');
          yield tool('scoped-diff', 'git.diff', { path: 'sum.js' }); }
        else if (step === 1) { const diff = resultFor(request, 'scoped-diff');
          assert.equal(diff.result.hasChanges, true); assert.match(diff.result.output, /sum\.js/);
          yield tool('prepared-test', 'operation.continue', { operationRef: operationId }); }
        else { const test = resultFor(request, 'prepared-test'); assert.equal(test.result.exitCode, 0);
          yield final('DRYRUN_VERIFY_READY_20261107'); }
      } else {
        const step = sourceStep++;
        if (step === 0) {
          const tasks = services.taskService.runtime.list().tasks; assert.equal(tasks.length, 1); taskId = tasks[0].id;
          evidence.initialContinuationAdvertised = request.tools.some(row => row.id === 'operation.continue');
          const prepared = await prepareSubscriptionOwnerContract({ services, taskId, workspaceId, project, protectedHashes,
            operationId, testInput, allowedPaths: ['sum.js'] }); evidence.revisions = prepared.revisions;
          yield tool('first-read-after-policy', 'filesystem.read', { path: 'sum.js' });
        } else { const read = resultFor(request, 'first-read-after-policy');
          assert.match(read.result.content, /a \+ b/); yield final('DRYRUN_SOURCE_READY_20261107'); }
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Synthetic preparation dry run' } })).workspace;
  workspaceId = workspace.id;
  const chat = await services.chatService.execute({ method: 'chat.sessions.create', params: { title: 'Preparation-only synthetic Managed' } }); chatId = chat.id;
  await services.chatService.execute({ method: 'chat.config.set', params: { id: chatId, config: { mode: 'chat', workspaceId,
    agentProvider: 'cetamesh', modelProvider: provider, model } } });
  await services.chatService.execute({ method: 'chat.send', params: { id: chatId,
    text: '先读取项目sum.js和verify.cjs，安排其它agent协作分析；本轮只核对准备条件。' } });
  await waitForReport('DRYRUN_SOURCE_READY_20261107');
  assert.equal(evidence.initialContinuationAdvertised, false, 'This starts with the same read-only collaboration manifest as the real script');
  const task = services.taskService.runtime.get({ id: taskId }).task;
  assert.equal(task.delegationPolicy.allowSubscriptionOnly, true); assert.equal(task.delegationPolicy.allowUnknownCost, false);
  assert.equal(task.delegationPolicy.used, 0, 'No external proposal or native dispatch is attempted');
  const afterAcceptance = evidence.revisions.find(row => row.phase === 'after-acceptance').revision;
  assert.equal(evidence.revisions.find(row => row.phase === 'after-grant').revision, afterAcceptance);
  assert.equal(evidence.revisions.find(row => row.phase === 'after-operation-prepare').revision, afterAcceptance);
  const prepared = services.capabilityService.broker.operationRecordForTask({ taskId, workspaceId, operationId });
  assert.equal(prepared.status, 'prepared'); assert.deepEqual(prepared.continuationInput, testInput);
  await services.chatService.execute({ method: 'chat.send', params: { id: chatId,
    text: 'DRYRUN_VERIFY_20261107 核对sum.js的有界差异，并继续Owner预备的独立验证操作。' } });
  const history = await waitForReport('DRYRUN_VERIFY_READY_20261107');
  assert.equal(approved, true);
  const verifiedTask = services.taskService.runtime.get({ id: taskId }).task;
  const test = verifiedTask.executionEvidence.findLast(row => row.capability === 'test.run');
  assert.equal(test.source, 'core-test'); assert.equal(test.operationId, operationId); assert.equal(test.exitCode, 0);
  assert.ok(verifiedTask.agentHistory.every(row => row.provider === 'cetamesh'));
  assert.equal(history.messages.filter(row => row.role === 'user').length, 2);
  assertProtectedFiles(project, protectedHashes);
  evidence.passed = true;
  console.log('PASS real isolated Core: Owner preparation revisions, fresh first-read principal, scoped git.diff schema and prepared npm-to-Node result.exitCode=0; no external/Codex send');
} finally {
  if (services) {
    if (taskId) { try { const task = services.taskService.runtime.get({ id: taskId }).task;
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: taskId, expectedRev: task.rev } });
    } catch (error) { evidence.cancelCode = error.code || error.name; } }
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService',
      'extensionService', 'pluginCenterService', 'channelService', 'bionicService']) await services[key]?.close();
  }
  if (process.env.CETAMESH_SUBSCRIPTION_PREPARATION_EVIDENCE_DIR) {
    const folder = path.resolve(process.env.CETAMESH_SUBSCRIPTION_PREPARATION_EVIDENCE_DIR); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'preparation-core-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify({ preparationEvidence: evidence }));
  // All fixtures belong to this separate test Temp root, never the approved real project.
  assert.ok(path.basename(root).startsWith('cm-subscription-preparation-')); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
