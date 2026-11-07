// Explicit opt-in: real production Codex subscription; local synthetic Managed coordinator.
// This is source-Core service acceptance, not a native-window or installed-release test.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { acceptanceHash, assertProtectedFiles, assertExactHandoffEffect, createHandoffBudgetJournal,
  assertCodexSubscriptionRoute, assertOwnerVerifiedHandoff, prepareSubscriptionOwnerContract } from './helpers/autonomous-handoff-acceptance.mjs';

if (process.env.WHALEBRIDGE_TEST_REAL_CODEX !== '1' || process.env.CETAMESH_TEST_SUBSCRIPTION_HANDOFF !== '1') {
  console.log('NOT_RUN_ENVIRONMENT: explicit Codex subscription handoff opt-in required'); process.exit(77);
}
if (process.platform !== 'win32') { console.log('NOT_RUN_ENVIRONMENT: the approved Windows environment is required'); process.exit(77); }

// The root runner replaces TEMP per suite. Bind the separately approved directory
// to the Windows account's actual LocalAppData Temp, outside runner cleanup.
assert.ok(process.env.LOCALAPPDATA, 'The approved Windows account must expose LocalAppData');
const project = path.resolve(process.env.LOCALAPPDATA, 'Temp', 'cm-auto-handoff-20261107');
assert.equal(path.resolve(process.env.CETAMESH_TEST_APPROVED_PROJECT || ''), project,
  'The separately authorized exact Temp project must be supplied; arbitrary paths are refused');
assert.ok(process.env.CETAMESH_TEST_NATIVE_EVIDENCE_ROOT, 'A private evidence directory is required');
const evidenceRoot = path.resolve(process.env.CETAMESH_TEST_NATIVE_EVIDENCE_ROOT);
const runRoot = path.join(evidenceRoot, 'subscription-handoff-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID());
fs.mkdirSync(runRoot, { recursive: true });
const budget = createHandoffBudgetJournal(path.join(runRoot, 'dispatch-budget.jsonl'));
const modelProvider = 'local-subscription-coordinator', model = 'synthetic-no-network';
const operationId = 'independent-verification', testInput = { tool: 'npm', args: ['test'], timeoutMs: 30000 };
const allowedPaths = ['sum.js'];
const sourceRoot = path.resolve(import.meta.dirname, '..');
const sourceFiles = ['src/agent/codex-agent-provider.js', 'src/agent/cli-agent-process.js', 'src/agent/broker.js',
  'src/desktop/chat-service.js', 'src/continuity/autonomous-handoff.js', 'src/task/runtime.js',
  'src/router/agent-assignment.js', 'src/capability/service.js', 'src/desktop/platform-runtime.js',
  'src/desktop/task-launch.js', 'scripts/test-real-subscription-handoff.mjs', 'scripts/helpers/autonomous-handoff-acceptance.mjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, acceptanceHash(fs.readFileSync(path.join(sourceRoot, file)))]));
let services, taskId, chatId, workspaceId, protectedHashes, initialSumHash, projectCreated = false;
let sourceStep = 0, verificationStep = 0, ownerPrepared = false, importApprovals = 0, testApprovals = 0;
const evidence = { acceptanceKind: 'real-codex-subscription-with-synthetic-managed',
  entrance: 'ordinary production Chat -> Core Task', realCodex: true, syntheticCoordinator: true,
  paidModelApiAllowed: false, modelApiCredentialsSource: 'new isolated ProviderSecrets only',
  project, runRoot, limits: budget.snapshot(), approvals: [], modelDecisions: [], diagnostics: [], verified: false };
const persist = () => { evidence.limits = budget.snapshot();
  fs.writeFileSync(path.join(runRoot, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); };

// Trusted test-harness Owner setup after Chat creates its Task. These are real Owner service
// calls, not model tools or authority inferred from synthetic model output.
async function prepareOwnerContract() {
  if (ownerPrepared) return;
  const rows = services.taskService.runtime.list().tasks;
  assert.equal(rows.length, 1, 'Only the ordinary Chat may create the acceptance Task');
  taskId = rows[0].id;
  const prepared = await prepareSubscriptionOwnerContract({ services, taskId, workspaceId, project, protectedHashes,
    operationId, testInput, allowedPaths });
  evidence.ownerPreparationRevisions = prepared.revisions;
  ownerPrepared = true;
  budget.append({ kind: 'owner-contract-prepared', taskId, workspaceId, operationId, allowedPaths, protectedHashes });
}

function toolResult(request, id) {
  const message = request.messages.filter(row => row.role === 'tool').findLast(row => row.tool_call_id === id);
  assert.ok(message, 'A real Core tool result must precede the next synthetic decision: ' + id);
  return JSON.parse(message.content);
}
const call = (id, capabilityId, input) => ({ type: 'assistant/tool-calls', data: {
  toolCalls: [{ id, capabilityId, arguments: JSON.stringify(input) }] } });
const final = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });

async function approveExactPendingEffects() {
  if (!taskId) return;
  for (const approval of services.capabilityService.broker.approvals.list()) {
    if (approval.status !== 'pending' || approval.request?.taskId !== taskId) continue;
    const request = approval.request;
    assertExactHandoffEffect(request, { taskId, workspaceId, project, allowedPaths, protectedHashes, testInput, operationId });
    if (request.capability === 'workspace.apply') {
      assert.equal(importApprovals, 0, 'No second import or unrequested edit is authorized');
      assert.equal(acceptanceHash(fs.readFileSync(path.join(project, 'sum.js'))), initialSumHash,
        'The exact original source must still be present before Core imports the staged change');
      importApprovals++;
    } else { assert.equal(testApprovals, 0, 'Only the one prepared independent test is authorized'); testApprovals++; }
    budget.append({ kind: 'owner-effect-approval', approvalId: approval.id, capability: request.capability,
      taskId, workspaceId, ...(request.capability === 'workspace.apply' ? { paths: allowedPaths } : { operationId, testInput }) });
    evidence.approvals.push({ id: approval.id, capability: request.capability }); persist();
    await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: approval.id, approve: true } });
    assertProtectedFiles(project, protectedHashes);
  }
}

try {
  evidence.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
  evidence.sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim());
  evidence.sourceHashes = sourceHashes(); persist();
  // A prior run is evidence, never permission to overwrite or retry. This includes broken links.
  let alreadyExists = false;
  try { fs.lstatSync(project); alreadyExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (alreadyExists) throw Object.assign(Error('Approved project already exists; retain it for review'), { code: 'APPROVED_PROJECT_ALREADY_EXISTS' });
  const tempParent = fs.realpathSync(path.dirname(project));
  fs.mkdirSync(project); projectCreated = true;
  assert.equal(path.dirname(fs.realpathSync(project)), tempParent, 'The approved project must be a direct real Temp child');
  const files = { 'sum.js': 'exports.sum = (a, b) => a - b;\n',
    'verify.cjs': "const assert = require('node:assert/strict'); const {sum} = require('./sum.js'); assert.equal(sum(3, 4), 7); assert.equal(sum(-2, 5), 3); assert.equal(sum(0, 0), 0); console.log('CM_SUBSCRIPTION_HANDOFF_VERIFIED_20261107');\n",
    'package.json': JSON.stringify({ name: 'cetamesh-subscription-handoff-acceptance', private: true, scripts: { test: 'node verify.cjs' } }) + '\n' };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(project, file), content, { flag: 'wx' });
  initialSumHash = acceptanceHash(files['sum.js']);
  protectedHashes = Object.fromEntries(['verify.cjs', 'package.json'].map(file => [file, acceptanceHash(files[file])]));
  evidence.protectedHashes = protectedHashes; evidence.initialSumHash = initialSumHash;
  const baseline = spawnSync(process.execPath, ['verify.cjs'], { cwd: project, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(baseline.status, 1, 'The fixed Node verifier must detect the initial arithmetic defect'); evidence.baselineExitCode = baseline.status;
  const emptyHooks = path.join(runRoot, 'empty-hooks'); fs.mkdirSync(emptyHooks);
  for (const args of [['init', '-q', project], ['-C', project, 'add', '.'], ['-C', project, '-c', 'user.name=Acceptance',
    '-c', 'user.email=acceptance@example.invalid', '-c', 'core.hooksPath=' + emptyHooks, 'commit', '-qm', 'synthetic baseline']])
    execFileSync('git', args, { stdio: 'ignore', windowsHide: true });
  const localSecrets = createProviderSecrets({ root: path.join(runRoot, 'core-data') });
  localSecrets.set({ provider: modelProvider, apiKey: 'synthetic-local-only-no-account' });
  services = createCetaMeshServices({ dataRoot: path.join(runRoot, 'core-data'), stateDir: path.join(runRoot, 'core-state'),
    agentStagingRoot: path.join(runRoot, 'agent-staging'), providerSecrets: localSecrets,
    log: value => { if (value.startsWith('Automatic delegation state: ')) evidence.diagnostics.push(value.slice(28)); } });

  // Accounting wraps every real Broker send, including all bootstrap and synthetic Managed turns.
  // It does not replace an adapter, eligibility, IDs, readiness, price or security observation.
  const send = services.agentBroker.send.bind(services.agentBroker);
  services.agentBroker.send = async (request, ...rest) => {
    const dispatch = budget.reserveDispatch(request);
    if (request.provider === 'codex') {
      const health = await services.agentBroker.health('codex');
      assertCodexSubscriptionRoute(health, services.agentBroker.capabilities('codex'));
      assert.equal(health.authenticated, true, 'No real send without actual adapter authentication');
    }
    persist();
    try { const result = await send(request, ...rest); budget.append({ kind: 'dispatch-reply', dispatch, accepted: result?.accepted === true }); return result; }
    catch (error) { budget.append({ kind: 'dispatch-failed', dispatch, code: error.code || error.name || 'FAILED' }); throw error; }
  };
  const stream = services.modelRuntime.stream.bind(services.modelRuntime);
  services.modelRuntime.stream = request => { assert.equal(request.providerId, modelProvider, 'External Managed model use is forbidden'); return stream(request); };
  services.modelRuntime.chat = async () => { throw Object.assign(Error('Only the local synthetic streaming coordinator is authorized'), { code: 'EXTERNAL_MODEL_FORBIDDEN' }); };
  services.modelRegistry.register({ id: modelProvider, label: 'Local synthetic subscription coordinator', defaultModel: model, supportsTools: true,
    listModels: async () => [{ id: model }], health: async () => ({ configured: true, available: true, synthetic: true }),
    chat: async () => { throw Error('Synthetic coordinator requires the normal streaming tool loop'); },
    stream: async function* (request) {
      const instruction = request.messages.filter(row => row.role === 'user').at(-1)?.content || '';
      if (instruction.startsWith('Independently verify the original Task')) {
        const context = JSON.parse(instruction.split('\n').slice(1).join('\n'));
        assert.equal(context.verificationPlan?.operationRef, operationId);
        const step = verificationStep++; evidence.modelDecisions.push({ phase: 'verification', step });
        if (step === 0) yield call('independent-diff', 'git.diff', { path: 'sum.js' });
        else if (step === 1) {
          const diff = toolResult(request, 'independent-diff'); assert.equal(diff.status, 'completed');
          assert.equal(diff.result.hasChanges, true); assert.match(diff.result.output, /sum\.js/);
          yield call('independent-test', 'operation.continue', { operationRef: operationId });
        } else {
          const test = toolResult(request, 'independent-test'); assert.equal(test.status, 'completed');
          assert.equal(test.result.exitCode, 0);
          yield final('CM_SUBSCRIPTION_HANDOFF_FINAL: Core imported only sum.js; I independently reviewed its diff and ran the Owner-prepared Node verifier successfully.');
        }
      } else if (sourceStep < 4) {
        await prepareOwnerContract();
        const step = sourceStep++; evidence.modelDecisions.push({ phase: 'source', step });
        if (step === 0) {
          yield { type: 'assistant/tool-calls', data: { toolCalls: [
            { id: 'source-read', capabilityId: 'filesystem.read', arguments: JSON.stringify({ path: 'sum.js' }) },
            { id: 'verifier-read', capabilityId: 'filesystem.read', arguments: JSON.stringify({ path: 'verify.cjs' }) }
          ] } };
        } else if (step === 1) {
          for (const id of ['source-read', 'verifier-read']) assert.equal(toolResult(request, id).status, 'completed');
          assert.match(JSON.stringify(toolResult(request, 'source-read').result), /a - b/);
          yield call('discover', 'agent.delegate.candidates', { taskKind: 'code', difficulty: 1, requiredTools: [] });
        } else if (step === 2) {
          const candidates = toolResult(request, 'discover'); assert.equal(candidates.status, 'completed'); assert.equal(candidates.result.canPropose, true);
          yield call('propose', 'agent.delegate.propose', { taskKind: 'code', difficulty: 1, requiredTools: [],
            instruction: 'Read sum.js and verify.cjs. Fix only sum.js so exports.sum performs addition and the unchanged Node verifier passes. Do not modify package.json, verify.cjs, any other file or anything outside the staged Workspace. Do not install, commit, use the network, or run tests; Core will independently run the prepared verifier after the exact sum.js import.' });
        } else { assert.equal(toolResult(request, 'propose').status, 'completed'); yield final('The bounded development proposal is recorded; waiting for Core and actual executor evidence.'); }
      } else {
        evidence.modelDecisions.push({ phase: 'bootstrap', step: 0 });
        yield final('The existing Task context is received; waiting for the separate Core verification instruction.');
      }
      persist(); yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  assert.deepEqual(localSecrets.list().map(row => row.provider), [modelProvider], 'No production paid-key store is loaded');
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Codex subscription handoff acceptance' } })).workspace;
  workspaceId = workspace.id;
  const health = await services.agentBroker.health('codex');
  assert.equal(health.available, true); assert.equal(health.authenticated, true);
  evidence.subscriptionFingerprint = assertCodexSubscriptionRoute(health, services.agentBroker.capabilities('codex')); persist();
  const security = await services.desktopUiService.execute({ method: 'ui.agent.security', params: { provider: 'codex', workspaceId } });
  const consent = await services.desktopUiService.execute({ method: 'ui.agent.authorize', params: { provider: 'codex', workspaceId, fingerprint: security.fingerprint } });
  assert.equal(consent.status, 'pending');
  const scope = services.capabilityService.broker.approvals.get(consent.approvalId).request;
  assert.equal(scope.capability, 'agent.execution.authorize'); assert.equal(scope.workspaceId, workspaceId);
  assert.equal(scope.input.provider, 'codex'); assert.equal(scope.input.fingerprint, security.fingerprint);
  budget.append({ kind: 'owner-native-scope-approval', approvalId: consent.approvalId, workspaceId, fingerprint: security.fingerprint });
  await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: consent.approvalId, approve: true } });
  evidence.approvals.push({ id: consent.approvalId, capability: 'agent.execution.authorize' });
  const chat = await services.chatService.execute({ method: 'chat.sessions.create', params: { title: 'Subscription-only bounded handoff' } }); chatId = chat.id;
  await services.chatService.execute({ method: 'chat.config.set', params: { id: chatId, config: { mode: 'chat', workspaceId, agentProvider: null, modelProvider, model } } });
  budget.reserveUserTurn();
  await services.chatService.execute({ method: 'chat.send', params: { id: chatId,
    text: '先读取本项目sum.js和verify.cjs，安排其它agent协作修复sum.js的加法错误，再独立核对差异、运行已有npm test并交付结果。只允许修改sum.js；package.json和verify.cjs必须保持原样。不要自己修改源码，不安装、不提交、不联网，不修改工作区外文件。' } });
  const deadline = Date.now() + 600000; let task;
  while (Date.now() < deadline) {
    await approveExactPendingEffects();
    task = taskId ? services.taskService.runtime.get({ id: taskId }).task : null;
    if (task?.status === 'completed') break;
    if (task && (['failed', 'blocked', 'cancelled'].includes(task.status) || ['blocked', 'unknown', 'needs-review'].includes(task.delegationProposal?.state)))
      throw Object.assign(Error('Real acceptance stopped; preserve evidence without retry'), { code: task.delegationProposal?.code || task.progress?.note || 'ACCEPTANCE_BLOCKED' });
    await delay(100);
  }
  assert.ok(task, 'The ordinary Chat must create the Task');
  evidence.verification = assertOwnerVerifiedHandoff(task, { operationId, allowedPaths, project, protectedHashes });
  assert.equal(importApprovals, 1); assert.equal(testApprovals, 1);
  assert.deepEqual(execFileSync('git', ['-C', project, 'diff', '--name-only'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/), ['sum.js']);
  assert.deepEqual(execFileSync('git', ['-C', project, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true }).trim(), '');
  let history;
  for (let i = 0; i < 100; i++) { history = await services.chatService.execute({ method: 'chat.history', params: { id: chatId } });
    if (history.messages.some(row => row.role === 'assistant' && row.text?.includes('CM_SUBSCRIPTION_HANDOFF_FINAL'))) break; await delay(100); }
  assert.ok(history.messages.some(row => row.role === 'assistant' && row.text?.includes('CM_SUBSCRIPTION_HANDOFF_FINAL')),
    'The original Chat must receive the actual independent verification report');
  assert.equal(history.messages.filter(row => row.role === 'user').length, 1);
  evidence.taskId = taskId; evidence.chatId = chatId; evidence.taskStatus = task.status;
  evidence.agentHistory = task.agentHistory.map(row => row.provider); evidence.finalSumHash = acceptanceHash(fs.readFileSync(path.join(project, 'sum.js')));
  evidence.verified = true; console.log('PASS real Codex subscription handoff with a local synthetic coordinator and exact Core Owner verification');
} catch (error) {
  evidence.failure = { code: String(error.code || error.name || 'ACCEPTANCE_FAILED').slice(0, 120) }; process.exitCode = 1;
} finally {
  // No automatic continuation, model retry, directory cleanup or budget reset. Core owns only its own children.
  if (services) {
    if (taskId) { try { const task = services.taskService.runtime.get({ id: taskId }).task;
      evidence.finalTaskSnapshot = { status: task.status, revision: task.rev, delegationState: task.delegationProposal?.state || null,
        delegationCode: task.delegationProposal?.code || null, observedExecutionState: task.executionObservation?.state || null };
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: taskId, expectedRev: task.rev } });
        evidence.cleanupCancellation = 'requested-through-own-core';
      }
    } catch (error) { evidence.cleanupCancellation = error.code || 'unconfirmed'; } }
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService',
      'extensionService', 'pluginCenterService', 'channelService', 'bionicService']) {
      try { await services[key]?.close(); } catch (error) { (evidence.closeFailures ||= []).push({ service: key, code: error.code || error.name }); process.exitCode = 1; }
    }
  }
  if (projectCreated && protectedHashes) { try { assertProtectedFiles(project, protectedHashes); evidence.verifiersRetained = true; }
    catch { evidence.verifiersRetained = false; process.exitCode = 1; } }
  if (evidence.sourceHashes) { try {
    evidence.sourceHashesAfter = sourceHashes();
    evidence.changedSourceFilesDuringRun = sourceFiles.filter(file => evidence.sourceHashesAfter[file] !== evidence.sourceHashes[file]);
    if (evidence.changedSourceFilesDuringRun.length) { evidence.verified = false; process.exitCode = 1; }
  } catch { evidence.sourceIntegrity = 'unconfirmed'; evidence.verified = false; process.exitCode = 1; } }
  evidence.limits = budget.snapshot(); evidence.artifactsRetained = true; persist(); budget.close();
  console.log(JSON.stringify({ acceptanceEvidenceFile: path.join(runRoot, 'acceptance-evidence.json'), limits: evidence.limits,
    verified: evidence.verified, failureCode: evidence.failure?.code || null, artifactsRetained: true }));
}
