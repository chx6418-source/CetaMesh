// Opt-in fault-injection acceptance using real configured Providers and production
// Core/UI Task APIs. Owner rejection/session close are explicit test actions.
// No native Desktop window, mock model, policy override or global process action.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {redactText} from '../src/logging/redact.js';
import {assertRecoveryAccount} from './real-recovery-account-guard.mjs';

const codexRestartOnly=process.env.CETAMESH_TEST_RECOVERY_CODEX_RESTART_ONLY==='1';
if ((!codexRestartOnly&&process.env.WHALEBRIDGE_TEST_REAL_MANAGED !== '1') || process.env.WHALEBRIDGE_TEST_REAL_CODEX !== '1') {
  console.log('NOT_RUN_ENVIRONMENT: explicit real Managed and Codex opt-ins required');
  process.exit(77);
}
const provider = 'deepseek-official', model = 'deepseek-flash';
const artifactRoot=process.env.CETAMESH_TEST_RECOVERY_ARTIFACT_ROOT;
if(artifactRoot)fs.mkdirSync(path.resolve(artifactRoot),{recursive:true});
const root = fs.mkdtempSync(path.join(artifactRoot?path.resolve(artifactRoot):os.tmpdir(), 'cetamesh-real-recovery-'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const existing = createProviderSecrets({root: path.join(process.env.LOCALAPPDATA || os.homedir(), 'WhaleBridge')});
const providerSecrets = Object.freeze({
  list: () => codexRestartOnly?[]:existing.list().filter(row => row.provider === provider),
  raw: id => { assert.equal(codexRestartOnly,false,'Paid API credentials are unavailable in Codex-only acceptance');assert.equal(id, provider); return existing.raw(id); }
});
const evidence = {
  kind: 'real-Provider-production-Core-API-explicit-fault-injection', nativeDesktop: false,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim()),
  runtimeSourceHashes: Object.fromEntries(['capability/broker.js','capability/service.js','task/store.js','task/runtime.js','agent/codex-agent-provider.js','agent/managed-agent-provider.js', 'model/tool-execution.js',
    'desktop/chat-service.js'].map(file => [file, hash(fs.readFileSync(new URL('../src/' + file, import.meta.url)))])),
  startedAt: new Date().toISOString(), provider:codexRestartOnly?'codex':provider, model:codexRestartOnly?null:model, managedRequestLimit: codexRestartOnly?0:10, codexUserTurnLimit: codexRestartOnly?2:3,
  isolatedRoot:root,
  acceptanceMode:codexRestartOnly?'existing-ChatGPT-account-Core-restart':'Managed-and-Codex-session-loss',
  status: 'RUNNING', modelRequests: [], dispatches: [], agentCalls: [], approvals: [],
  managedRejection: {status: 'NOT_RUN'}, codexSessionLoss: {status: 'NOT_RUN'},
  limitations: [
    codexRestartOnly?'Actual Codex account reads with a controlled Core service restart after confirmed idle Session close; no OS crash is claimed.':'Actual Provider IO is separate from the explicit Owner rejection and owned-session close injected by this suite.',
    'Core/UI API acceptance; no native Desktop UI or operating-system crash acceptance.',
    'Codex root Tasks retain run observations/history but do not have child Attempt records; no Attempt is fabricated.',
    'Owner block/detach after a confirmed Codex close is explicit reconciliation, not automatic session-loss detection.',
    'Only isolated synthetic projects are used. No user process, account configuration or global runtime is terminated.'
  ]
};
let services, currentCase = null, passed = false;
const taskIds = [];
const ui = (method, params) => services.desktopUiService.execute({method, params});
const taskApi = (method, params) => services.taskService.execute({method, params});
const cap = (method, params) => services.capabilityService.execute({method, params});
const task = id => services.taskService.runtime.get({id}).task;
const core = (capability, taskId, workspaceId, input, extra = {}) =>
  cap('capability.execute', {capability, taskId, workspaceId, input, ...extra});
const safeError = error => ({code: String(error.code || error.name).slice(0, 160),
  message: redactText(String(error.message)).slice(0, 1600)});
function envBlocked(code, message) { return Object.assign(new Error(message), {code, environmentBlocked: true}); }
function fileHashes(project) {
  return Object.fromEntries(fs.readdirSync(project).filter(file => file !== '.git').sort().map(file => {
    assert.ok(fs.lstatSync(path.join(project, file)).isFile(), 'project contains only original regular files');
    return [file, hash(fs.readFileSync(path.join(project, file)))];
  }));
}
function diagnostic(value) {
  return {id: value.id, rev: value.rev, status: value.status, note: value.progress?.note,
    observation: value.executionObservation, currentAgent: value.currentAgent,
    attemptCount: value.attempts.length,
    evidence: value.executionEvidence.map(row => ({capability: row.capability, status: row.status,
      source: row.source ?? null, runId: row.runId, exitCode: row.exitCode ?? null}))};
}
async function waitFor(read, predicate, label, timeout = 180000, onTick = async () => {}) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    await onTick(); value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw Object.assign(new Error(label + ' timed out'), {code: 'ACCEPTANCE_TIMEOUT'});
}
function originalProof(project, expected, except = []) {
  const actual = fileHashes(project);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const [file, digest] of Object.entries(expected)) if (!except.includes(file))
    assert.equal(actual[file], digest, 'original input unchanged: ' + file);
  return actual;
}
async function closeServices() {
  if (!services) return;
  for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService',
    'pluginCenterService', 'extensionService', 'channelService', 'bionicService', 'simulationService', 'meshService']) {
    try { await services[name]?.close?.(); }
    catch (error) { (evidence.cleanupErrors ??= []).push({service: name, code: error.code || error.name}); }
  }
}
function observeProduction() {
  if(codexRestartOnly){
    services.modelRuntime.chat=async()=>{throw envBlocked('PAID_API_FORBIDDEN','Paid Model Runtime calls are disabled in this acceptance');};
  }
  const stream = services.modelRuntime.stream.bind(services.modelRuntime);
  services.modelRuntime.stream = async function* (request) {
    assert.ok(evidence.modelRequests.length < evidence.managedRequestLimit, 'real Managed request budget exceeded');
    assert.equal(request.providerId, provider); assert.equal(request.model, model);
    const row = {index: evidence.modelRequests.length + 1, case: currentCase,
      requestedModel: request.model, provider: request.providerId, startedAt: new Date().toISOString()};
    evidence.modelRequests.push(row);
    try { for await (const event of stream(request)) {
      const resolved = event?.data?.resolvedModel ?? event?.data?.message?.model;
      if (typeof resolved === 'string') row.resolvedModel = resolved;
      if (event?.type === 'turn/end') row.terminal = event.data?.reason?.kind ?? null;
      yield event;
    } } finally { row.finishedAt = new Date().toISOString(); }
  };
  const send = services.agentBroker.send.bind(services.agentBroker);
  services.agentBroker.send = async request => {
    if (request.provider === 'codex' && request.phase !== 'bootstrap') {
      assert.ok(evidence.dispatches.filter(row => row.provider === 'codex' && row.phase !== 'bootstrap').length
        < evidence.codexUserTurnLimit, 'Codex user-turn budget exceeded');
    }
    const row = {provider: request.provider, sessionId: request.sessionId, runId: request.runId ?? null,
      phase: request.phase ?? 'user', case: currentCase, at: new Date().toISOString()};
    evidence.dispatches.push(row);
    const result = await send(request);
    row.accepted = result.accepted === true; row.nativeRequestId = result.requestId ?? result.turnId ?? null;
    return result;
  };
  const execute = services.capabilityService.broker.execute.bind(services.capabilityService.broker);
  services.capabilityService.broker.execute = async (request, options) => {
    const row = request.actor?.kind === 'agent' ? {taskId: request.taskId, capability: request.capability,
      path: request.input?.path ?? null, operationRef: request.input?.operationRef ?? null,
      case: currentCase, at: new Date().toISOString()} : null;
    if (row) evidence.agentCalls.push(row);
    try { const result = await execute(request, options); if (row) row.status = result.status; return result; }
    catch (error) { if (row) row.error = error.code || error.name; throw error; }
  };
}

async function managedRejection() {
  currentCase = 'managed-rejection';
  const row = evidence.managedRejection; row.status = 'RUNNING';
  const project = path.join(root, 'managed-project'); fs.mkdirSync(project);
  const original = 'export const add = (a, b) => a - b;\n';
  const corrected = 'export const add = (a, b) => a + b;\n';
  fs.writeFileSync(path.join(project, 'math.mjs'), original);
  fs.writeFileSync(path.join(project, 'verify.mjs'),
    "import assert from 'node:assert/strict';import {add} from './math.mjs';assert.equal(add(3,4),7);assert.equal(add(-2,5),3);console.log('REAL_RECOVERY_TEST_OK');\n");
  fs.writeFileSync(path.join(project, 'package.json'),
    JSON.stringify({private: true, type: 'module', scripts: {test: 'node verify.mjs'}}) + '\n');
  for (const args of [['init', '-q', project], ['-C', project, 'add', '.'],
    ['-C', project, '-c', 'user.name=Recovery', '-c', 'user.email=recovery@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic recovery baseline']])
    execFileSync('git', args, {stdio: 'ignore'});
  const baseline = fileHashes(project); row.originalHashes = baseline;
  const workspace = (await services.workspaceService.execute({method: 'workspace.create',
    params: {name: 'Managed rejection recovery acceptance', root: project}})).workspace;
  row.workspaceId = workspace.id;
  const created = await taskApi('task.create', {goal: 'Fix only math.mjs, preserve verifier/package and pass existing npm test',
    workspaceId: workspace.id}); taskIds.push(created.id); row.taskId = created.id;
  const writeInput = {path: 'math.mjs', content: corrected, expectedHash: hash(original)};
  const operationId = 'recovery-approved-math-write';
  await cap('capability.operation.prepare', {taskId: created.id, workspaceId: workspace.id,
    operationId, capability: 'filesystem.write', input: writeInput});
  const exactContinuation = {operationRef: operationId, input: writeInput};
  const initialInstruction = 'Read math.mjs, verify.mjs and package.json, then request only the Owner-prepared operation.continue with exact input '
    + JSON.stringify(exactContinuation) + '. Do not use direct writes, other operations, commands, network or delegation. '
    + 'If Owner rejects the write, stop tools and report OWNER_WRITE_REJECTED with the rejection reason; do not retry or request alternatives. Do not run tests in this first turn.';
  const started = await core('agent.run', created.id, workspace.id,
    {agentProvider: 'cetamesh', modelProvider: provider, model, content: initialInstruction,
      grants: {capabilities: ['filesystem.read', 'filesystem.write', 'filesystem.search',
        'operation.read', 'operation.continue', 'test.run']}},
    {requestId: 'real-recovery-managed-rejected'});
  assert.equal(started.result.accepted, true);
  row.originalSessionId = task(created.id).currentAgent.sessionId;
  const pending = await waitFor(() => services.capabilityService.broker.approvals.list().find(item =>
    item.status === 'pending' && item.request?.taskId === created.id), Boolean, 'actual Managed write approval');
  assert.equal(pending.request.capability, 'filesystem.write');
  assert.deepEqual(pending.request.input, writeInput); assert.equal(pending.request.operationId, operationId);
  originalProof(project, baseline);
  row.rejectedApprovalId = pending.id;
  const beforeRejectCalls = evidence.agentCalls.length;
  const rejected = await cap('capability.approval.decide', {id: pending.id, approve: false});
  assert.equal(rejected.status, 'rejected');
  evidence.approvals.push({case: currentCase, id: pending.id, capability: 'filesystem.write', decision: 'rejected'});
  await waitFor(async () => ({task: task(created.id), status: await services.agentBroker.status(task(created.id).currentAgent)}),
    value => value.status.running === false && value.task.executionObservation?.state === 'awaiting-review',
    'real rejection report and quiescence');
  originalProof(project, baseline);
  assert.equal(services.capabilityService.broker.approvals.list().filter(item =>
    item.status === 'pending' && item.request?.taskId === created.id).length, 0, 'no alternative approval after rejection');
  assert.ok(evidence.agentCalls.slice(beforeRejectCalls).every(call =>
    !['filesystem.write', 'workspace.apply', 'test.run', 'operation.continue'].includes(call.capability)),
  'model must not bypass or replay the rejected effect');
  const firstRun = task(created.id).executionObservation;
  const rejectedReports = task(created.id).agentReports.filter(item => item.runId === firstRun.runId);
  assert.ok(rejectedReports.some(item => item.text.includes('OWNER_WRITE_REJECTED')), 'real model must report the observed rejection');
  row.rejectedReportEventIds = rejectedReports.map(item => item.eventId);
  row.rejectedEvidenceEventIds = task(created.id).executionEvidence.filter(item => item.runId === firstRun.runId && item.status === 'rejected').map(item => item.eventId);
  assert.ok(row.rejectedEvidenceEventIds.length, 'actual rejected tool outcome must be retained');
  const deniedIntent = services.capabilityService.broker.operationRecordForTask({
    taskId: created.id, workspaceId: workspace.id, operationId});
  assert.equal(deniedIntent.authorizationDenied, true);
  await assert.rejects(core('operation.continue', created.id, workspace.id, exactContinuation,
    {requestId: 'real-recovery-owner-negative-replay'}), {code: 'OPERATION_PERMISSION_REVIEW_REQUIRED'});
  originalProof(project, baseline);
  Object.assign(row, {rejectionNoEffect: true, automaticBypassCalls: 0,
    replayBlock: 'OPERATION_PERMISSION_REVIEW_REQUIRED', rejectedRunId: firstRun.runId});
  const reviewed = await cap('capability.operation.review', {taskId: created.id, workspaceId: workspace.id, operationId});
  assert.equal(reviewed.authorizationGranted, false, 'review must not grant source execution approval');
  row.operationReview = reviewed;
  await taskApi('task.block', {id: created.id, expectedRev: task(created.id).rev,
    reason: 'needs-reconciliation: Test Owner rejected the exact prepared write; original file hashes independently checked unchanged'});
  const recovery = await ui('ui.task.reconcile', {id: created.id, expectedRev: task(created.id).rev,
    provider: 'cetamesh', reviewed: true,
    reviewSummary: 'Owner checked unchanged original files and rejected operation, explicitly reviewed that known-unexecuted operation; each fresh write/test still needs approval.',
    nextInstruction: 'Owner now explicitly requests a fresh permitted attempt. Call operation.continue with exact input '
      + JSON.stringify(exactContinuation) + ', wait for its separate approval, then run existing npm test through test.run '
      + 'with tool npm, args ["test"], timeoutMs 30000 and wait for its separate approval. Preserve verify.mjs/package.json, '
      + 'use no alternative writes, delegation, installation, commits or network. Report actual results.',
    requestId: 'real-recovery-managed-permitted'});
  assert.equal(recovery.task.id, created.id);
  const approved = new Set();
  async function approveKnownEffects() {
    for (const approval of services.capabilityService.broker.approvals.list()) {
      if (approval.status !== 'pending' || approval.request?.taskId !== created.id || approved.has(approval.id)) continue;
      originalProof(project, baseline, ['math.mjs']);
      if (approval.request.capability === 'filesystem.write') {
        assert.deepEqual(approval.request.input, writeInput); assert.equal(approval.request.operationId, operationId);
      } else if (approval.request.capability === 'test.run') {
        assert.equal(approval.request.input.tool, 'npm'); assert.deepEqual(approval.request.input.args, ['test']);
      } else throw Error('Unexpected recovery approval: ' + approval.request.capability);
      approved.add(approval.id);
      evidence.approvals.push({case: currentCase, id: approval.id, capability: approval.request.capability, decision: 'approved-once'});
      await cap('capability.approval.decide', {id: approval.id, approve: true});
    }
  }
  const recovered = await waitFor(() => task(created.id), value => value.executionObservation?.state === 'awaiting-review'
    || ['failed', 'blocked', 'cancelled'].includes(value.status), 'fresh real Managed attempt',
    180000, approveKnownEffects);
  assert.equal(recovered.executionObservation?.state, 'awaiting-review', JSON.stringify(diagnostic(recovered)));
  const observed = recovered.executionObservation;
  assert.notEqual(observed.runId, firstRun.runId);
  const tests = recovered.executionEvidence.filter(item => item.source === 'core-test' && item.capability === 'test.run'
    && item.status === 'completed' && item.runId === observed.runId && item.sessionId === recovered.currentAgent.sessionId);
  assert.ok(tests.length, 'current-run actual Core test evidence required'); assert.equal(tests.at(-1).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(project, 'math.mjs'), 'utf8'), corrected);
  originalProof(project, baseline, ['math.mjs']);
  assert.deepEqual(execFileSync('git', ['-C', project, 'diff', '--name-only'], {encoding: 'utf8'}).trim().split(/\r?\n/), ['math.mjs']);
  assert.match(execFileSync(process.execPath, ['verify.mjs'], {cwd: project, encoding: 'utf8', timeout: 30000}), /REAL_RECOVERY_TEST_OK/);
  assert.equal(approved.size, 2, 'one new write approval and one Core test approval required');
  const completed = await ui('ui.task.complete', {id: created.id, expectedRev: task(created.id).rev, reviewed: true,
    summary: 'Owner verified rejected write had no effect; reviewed recovery changed only math.mjs, preserved original verifier and passed actual current-run Core npm test.'});
  assert.equal(completed.task.status, 'completed');
  Object.assign(row, {status: 'PASS', taskStatus: 'completed', recoveredRunId: observed.runId,
    recoveredSessionId: recovered.currentAgent.sessionId, coreTestExitCode: 0, originalVerifierExitCode: 0,
    coreTestEvidenceIds: tests.map(item => item.eventId), freshEffectApprovals: approved.size, finalHashes: fileHashes(project)});
  await services.agentBroker.closeSession(recovered.currentAgent);
}

// Match a real current-run receipt to the unseen post-fault file output. The
// production exec adapter hashes JSON({exitCode, output}); this never fabricates
// a result or upgrades a model report into native tool evidence.
function requireFreshCodexRead(recovered, freshMarker, expectedOutputDigests) {
  const observed = recovered.executionObservation;
  const sameRun = item => item.provider === 'codex' && item.sessionId === recovered.currentAgent.sessionId
    && item.runId === observed.runId && item.phase === 'user' && item.taskRev >= observed.startedRev;
  const reports = recovered.agentReports.filter(item => sameRun(item)
    && item.text.includes(freshMarker) && item.text.includes('source.txt'));
  assert.ok(reports.length, 'fresh current-run report must include the unseen post-fault marker and file name');
  const reads = recovered.executionEvidence.filter(item => sameRun(item)
    && item.source === 'native-result' && item.capability === 'codex.native.command'
    && item.status === 'completed' && item.exitCode === 0 && expectedOutputDigests.has(item.resultSha256));
  assert.ok(reads.length, 'real current native-result digest must match the post-fault source.txt output');
  return {readEvidence: reads.map(item => ({eventId: item.eventId, resultSha256: item.resultSha256})),
    reportEvidence: reports.map(item => ({eventId: item.eventId, sha256: item.sha256}))};
}

async function codexSessionLoss() {
  currentCase = 'codex-owned-session-loss';
  const row = evidence.codexSessionLoss; row.status = 'RUNNING';
  const project = path.join(root, 'codex-project'); fs.mkdirSync(project);
  const marker = 'REAL_RECOVERY_CODEX_' + crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(project, 'source.txt'), 'Synthetic read-only native recovery fixture.\nmarker=' + marker + '\n');
  const baseline = fileHashes(project); row.originalHashes = baseline;
  const workspace = (await services.workspaceService.execute({method: 'workspace.create',
    params: {name: 'Owned Codex session loss acceptance', root: project}})).workspace;
  row.workspaceId = workspace.id;
  const health = await services.agentBroker.health('codex');
  row.health = {available: health.available, authenticated: health.authenticated, sandboxCapable: health.sandboxCapable ?? null};
  if (health.available !== true || health.authenticated !== true)
    throw envBlocked('CODEX_UNAVAILABLE', 'Installed Codex is unavailable or unauthenticated; no account action is attempted.');
  const scope = await ui('ui.agent.security', {provider: 'codex', workspaceId: workspace.id});
  row.security = {mode: scope.security?.mode, strictIsolationVerified: scope.security?.strictIsolationVerified === true};
  if (!scope.authorized) {
    const consent = await ui('ui.agent.authorize', {provider: 'codex', workspaceId: workspace.id, fingerprint: scope.fingerprint});
    assert.equal(consent.status, 'pending');
    await cap('capability.approval.decide', {id: consent.approvalId, approve: true});
    evidence.approvals.push({case: currentCase, id: consent.approvalId, capability: 'agent execution consent', decision: 'approved-scoped-workspace'});
  }
  const instruction = 'Read only source.txt using a native read command in this staging Workspace, then report its exact marker and source.txt. '
    + 'Do not change any files, run project code, access other paths, install, use network tools or delegate.';
  const created = await ui('ui.task.create', {workspaceId: workspace.id, agentProvider: 'codex', goal: instruction,
    requestId: 'real-recovery-codex-initial'});
  taskIds.push(created.task.id); row.taskId = created.task.id;
  async function noUnexpectedApproval() {
    const pending = services.capabilityService.broker.approvals.list().find(item =>
      item.status === 'pending' && item.request?.taskId === created.task.id);
    if (pending) throw envBlocked('NATIVE_REVIEW_REQUIRED',
      'A native per-tool approval needs additional review; this narrow read-only acceptance does not grant unknown native tool inputs.');
  }
  const initial = await waitFor(() => task(created.task.id), value => value.executionObservation?.state === 'awaiting-review'
    || ['blocked', 'failed', 'cancelled'].includes(value.status), 'real initial Codex read', 180000, noUnexpectedApproval);
  if (initial.progress?.note === 'CODEX_SANDBOX_UNAVAILABLE') throw envBlocked('CODEX_SANDBOX_UNAVAILABLE', 'Selected native Codex sandbox refused execution.');
  assert.equal(initial.executionObservation?.state, 'awaiting-review', JSON.stringify(diagnostic(initial)));
  const initialRun = initial.executionObservation;
  assert.ok(initial.agentReports.some(item => item.runId === initialRun.runId && item.text.includes(marker)));
  assert.ok(initial.executionEvidence.some(item => item.runId === initialRun.runId && item.source === 'native-result'
    && item.status === 'completed'), 'actual native tool result required before fault injection');
  originalProof(project, baseline);
  const originalAssignment = initial.currentAgent;
  row.initialRunId = initialRun.runId; row.initialSessionId = originalAssignment.sessionId;
  row.originalAttempts = initial.attempts; row.initialNativeReadObserved = true;
  row.initialReportEventIds = initial.agentReports.filter(item => item.runId === initialRun.runId).map(item => item.eventId);
  row.initialNativeReadEvidence = initial.executionEvidence.filter(item => item.runId === initialRun.runId
    && item.source === 'native-result' && item.status === 'completed')
    .map(item => ({eventId: item.eventId, resultSha256: item.resultSha256}));
  const interruptedRunId = codexRestartOnly?null:'real-recovery-codex-interrupted-read';
  if(!codexRestartOnly){
   const accepted = await services.agentBroker.send({...originalAssignment, runId: interruptedRunId,
    content: instruction + ' This is a separate fresh read-only instruction; read the file again.'});
  assert.equal(accepted.accepted, true);
  const active = await services.agentBroker.status(originalAssignment);
  if (active.running !== true) throw envBlocked('CANCEL_WINDOW_MISSED', 'Read turn settled before owned-session fault injection; no replay is attempted.');
  row.interruptedRunId = interruptedRunId;
  }
  const closed = await services.agentBroker.closeSession(originalAssignment);
  if (closed.closed !== true) throw envBlocked('CODEX_CLOSE_UNCONFIRMED', 'Owned Codex close was not confirmed; state retained and recovery not attempted.');
  row.faultInjection = {action: 'agentBroker.closeSession', sessionId: originalAssignment.sessionId, closeConfirmed: true};
  if(codexRestartOnly)row.faultInjection.boundary='Confirmed idle native Session close, then controlled Core service restart; no operating-system crash claimed';
  try { await services.agentBroker.status(originalAssignment); assert.fail('closed native Session must not remain usable'); }
  catch (error) {
    if (!['SESSION_NOT_FOUND', 'SESSION_TRANSPORT_UNKNOWN'].includes(error.code)) throw error;
    row.observedLossCode = error.code;
  }
  originalProof(project, baseline);
  // Only after confirmed closure, the test Owner changes this synthetic fixture.
  // The value is absent from all previous prompts/checkpoints and the new prompt.
  const freshMarker = 'REAL_RECOVERY_CODEX_FRESH_' + crypto.randomBytes(16).toString('hex');
  assert.notEqual(freshMarker, marker);
  assert.ok(!instruction.includes(freshMarker));
  assert.ok(!task(initial.id).agentReports.some(item => item.text.includes(freshMarker)));
  assert.ok(!(task(initial.id).checkpoint?.summary ?? '').includes(freshMarker));
  const freshContent = 'Synthetic read-only native recovery fixture.\nmarker=' + freshMarker + '\n';
  fs.writeFileSync(path.join(project, 'source.txt'), freshContent);
  const ownerReviewedHashes = fileHashes(project);
  assert.notEqual(ownerReviewedHashes['source.txt'], baseline['source.txt']);
  row.ownerFixtureUpdate = {actor: 'test Owner', afterConfirmedClose: true, path: 'source.txt',
    previousMarker: marker, freshMarker, previousSha256: baseline['source.txt'],
    freshSha256: ownerReviewedHashes['source.txt'], at: new Date().toISOString()};
  row.ownerReviewedHashes = ownerReviewedHashes;
  // Permit only stdout newline encodings/trailing line breaks of the exact file.
  // Each candidate contains the fresh marker; unrelated successful output fails.
  const expectedOutputDigests = new Set();
  for (const eol of ['\n', '\r\n']) {
    const body = freshContent.replace(/\r?\n/g, eol).replace(/(?:\r?\n)+$/, '');
    for (const suffix of ['', '\n', '\r\n', '\n\n', '\n\r\n', '\r\n\n', '\r\n\r\n'])
      expectedOutputDigests.add(hash(JSON.stringify({exitCode: 0, output: body + suffix})));
  }
  // Explicit Owner reconciliation records a known close and detaches only the
  // confirmed-stopped assignment. It does not manufacture a native failure event.
  if(codexRestartOnly){
    await closeServices();
    services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),
      agentStagingRoot:path.join(root,'staging'),providerSecrets,deferOptionalStart:true,log:()=>{}});
    observeProduction();
    const restored=task(initial.id);
    assert.equal(restored.status,'blocked');
    assert.equal(restored.executionObservation?.state,'unknown');
    assert.deepEqual(restored.attempts,row.originalAttempts);
    const beforeResume=evidence.dispatches.length;
    await assert.rejects(ui('ui.task.resume',{id:restored.id,expectedRev:restored.rev,requestId:'must-not-auto-resume'}),{code:'TASK_RECOVERY_REVIEW_REQUIRED'});
    assert.equal(evidence.dispatches.length,beforeResume,'restart does not silently send another Agent instruction');
    row.coreRestart={status:'PASS',restoredStatus:restored.status,restoredObservation:restored.executionObservation.state,automaticSends:0};
    const freshScope=await ui('ui.agent.security',{provider:'codex',workspaceId:workspace.id});
    if(!freshScope.authorized){
      const consent=await ui('ui.agent.authorize',{provider:'codex',workspaceId:workspace.id,fingerprint:freshScope.fingerprint});
      assert.equal(consent.status,'pending');
      await cap('capability.approval.decide',{id:consent.approvalId,approve:true});
      evidence.approvals.push({case:currentCase,id:consent.approvalId,capability:'agent execution consent',decision:'approved-fresh-Core-same-workspace'});
    }
    await taskApi('task.agent.detach',{id:restored.id,expectedRev:task(restored.id).rev,
      note:'Test Owner holds the exact earlier confirmed Session-close receipt; preserve history before fresh recovery'});
  }else{
   await taskApi('task.block', {id: initial.id, expectedRev: task(initial.id).rev,
    reason: 'needs-reconciliation: Test Owner confirmed close of this owned read-only Codex session; verify synthetic files before a fresh instruction'});
  await taskApi('task.agent.detach', {id: initial.id, expectedRev: task(initial.id).rev,
    note: 'Owner confirmed old owned Session closed; retain Task and native run history for scoped recovery'});
  }
  const sendsBeforeReview = evidence.dispatches.length;
  assert.deepEqual(task(initial.id).attempts, row.originalAttempts);
  const recoveryInstruction = instruction + ' In this fresh Session run exactly this read-only command once: '
    + 'Get-Content -Raw -LiteralPath source.txt. Report the exact marker from that actual command output, '
    + 'not a value remembered from checkpoints. Give a fresh observed report after this explicit Owner recovery.';
  assert.ok(!recoveryInstruction.includes(freshMarker), 'fresh value is never supplied in recovery instructions');
  await ui('ui.task.reconcile', {id: initial.id, expectedRev: task(initial.id).rev, provider: 'codex',
    reviewed: true, reviewSummary: 'Owner verified confirmed session close and unchanged original pre-fault files, then deliberately replaced only the synthetic source marker; authorize a fresh read of the reviewed Owner postimage. No Agent write or import is approved.',
    nextInstruction: recoveryInstruction,
    requestId: 'real-recovery-codex-permitted'});
  assert.equal(evidence.dispatches.length, sendsBeforeReview + 1);
  const recovered = await waitFor(() => task(initial.id), value => value.executionObservation?.state === 'awaiting-review'
    || ['blocked', 'failed', 'cancelled'].includes(value.status), 'fresh authorized Codex Session', 180000, noUnexpectedApproval);
  assert.equal(recovered.id, initial.id);
  assert.equal(recovered.executionObservation?.state, 'awaiting-review', JSON.stringify(diagnostic(recovered)));
  assert.notEqual(recovered.currentAgent.sessionId, originalAssignment.sessionId);
  assert.notEqual(recovered.executionObservation.runId, initialRun.runId);
  assert.notEqual(recovered.executionObservation.runId, interruptedRunId);
  const freshReadEvidence = requireFreshCodexRead(recovered, freshMarker, expectedOutputDigests);
  assert.deepEqual(recovered.attempts, row.originalAttempts, 'do not invent child Attempt records for a native root Task');
  assert.ok(recovered.agentHistory.some(item => item.sessionId === originalAssignment.sessionId && item.detachedAt !== null));
  originalProof(project, ownerReviewedHashes);
  const completed = await ui('ui.task.complete', {id: recovered.id, expectedRev: recovered.rev, reviewed: true,
    summary: 'Owner checked old-session loss, deliberate post-fault fixture replacement, actual current native output digest and fresh marker report; Agent preserved the reviewed Owner postimage under the same Task ID.'});
  assert.equal(completed.task.status, 'completed');
  Object.assign(row, {status: 'PASS', taskStatus: 'completed', recoveredSessionId: recovered.currentAgent.sessionId,
    recoveredRunId: recovered.executionObservation.runId, taskIdentityPreserved: true, attemptsPreserved: true,
    freshMarkerReported: true, freshReadEvidence, nativeReceiptFormat: 'sha256(JSON.stringify({exitCode:0,output}))',
    allowedOutputDigestCount: expectedOutputDigests.size, agentChangedOwnerPostimage: false,
    rootTaskAttemptCount: recovered.attempts.length, agentHistorySessions: recovered.agentHistory.map(item => item.sessionId),
    finalHashes: fileHashes(project)});
  await services.agentBroker.closeSession(recovered.currentAgent);
}

try {
  if(codexRestartOnly){
    const codexHome=process.env.CODEX_HOME||path.join(process.env.USERPROFILE||os.homedir(),'.codex');
    const auth=JSON.parse(fs.readFileSync(path.join(codexHome,'auth.json'),'utf8'));
    const config=fs.readFileSync(path.join(codexHome,'config.toml'),'utf8');
    try{assertRecoveryAccount({auth,config,environment:process.env});}
    catch(error){throw envBlocked(error.code,'Only the unambiguous existing ChatGPT subscription account is authorized; custom/provider-profile/API-key routes are denied');}
    evidence.accountMode='chatgpt';
    evidence.managedRejection={status:'NOT_RUN',reason:'Paid model calls forbidden in Codex-only acceptance'};
  }
  if (!codexRestartOnly&&!providerSecrets.list().some(row => row.configured === true))
    throw envBlocked('MANAGED_NOT_CONFIGURED', 'Authorized existing Managed Provider is not configured.');
  services = createCetaMeshServices({stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
    agentStagingRoot: path.join(root, 'staging'), providerSecrets, deferOptionalStart: true, log: () => {}});
  if(!codexRestartOnly)await services.settingsService.execute({method: 'settings.update', params: {section: 'models', values: {provider, defaultModel: model}}});
  observeProduction();
  if(!codexRestartOnly)await managedRejection();
  await codexSessionLoss();
  evidence.status = 'PASS'; passed = true;
} catch (error) {
  const row = currentCase === 'codex-owned-session-loss' ? evidence.codexSessionLoss : evidence.managedRejection;
  row.status = error.environmentBlocked ? 'BLOCKED_ENV' : 'FAIL'; row.failure = safeError(error);
  evidence.status = row.status;
  evidence.taskDiagnostics = taskIds.map(id => diagnostic(task(id)));
  process.exitCode = error.environmentBlocked ? 77 : 1;
  if (error.environmentBlocked) console.log('NOT_RUN_ENVIRONMENT: ' + row.failure.code + ': ' + row.failure.message);
} finally {
  for (const id of [...taskIds].reverse()) {
    if(!passed&&artifactRoot)continue; // Retain failed acceptance Tasks for explicit review.
    const current = task(id);
    if (['completed', 'cancelled', 'failed'].includes(current.status)) continue;
    try { await ui('ui.task.cancel', {id, expectedRev: current.rev}); }
    catch (error) { (evidence.cleanupErrors ??= []).push({taskId: id, code: error.code || error.name}); }
  }
  await closeServices();
  if (evidence.cleanupErrors?.length) { evidence.status = 'INCONCLUSIVE'; passed = false; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  evidence.elapsedMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
  if (process.env.CETAMESH_TEST_EVIDENCE_FILE)
    fs.writeFileSync(process.env.CETAMESH_TEST_EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({realAgentRecoveryEvidence: evidence}));
  if (passed&&!artifactRoot) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cetamesh-real-recovery-'));
    assert.ok(!fs.lstatSync(resolved).isSymbolicLink());
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  } else console.log('Retained isolated synthetic recovery state for review: ' + root);
}
