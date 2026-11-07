// Actual installed DSH CLI + isolated Core; model decisions are synthetic loopback HTTP.
// This does not exercise a paid model, user account, global DSH home or native UI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {PassThrough} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createAgentRuntimeConfiguration} from '../src/agent/runtime-configuration.js';
import {inspectTaskSession} from '../src/agent/session-recovery.js';
import {CliAgentProcess, createMinimalAgentEnv} from '../src/agent/cli-agent-process.js';

const runtimePath = process.env.CETAMESH_TEST_DSH_RUNTIME;
const supervisor = process.env.CETAMESH_TEST_DSH_SUPERVISOR;
if (process.platform !== 'win32' || !runtimePath || !supervisor) {
  console.log('NOT_RUN_ENVIRONMENT: explicit installed DSH package and verified Build 1139 supervisor required');
  process.exit(77);
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
assert.ok(path.isAbsolute(runtimePath) && path.isAbsolute(supervisor));
assert.equal(sha256(fs.readFileSync(supervisor)), 'a8e391825a936cd848215930ed0a483c2aaeb24665cfc08f1795a3d963a537b8', 'only the explicitly reviewed Build 1139 supervisor may run');
const manifest = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh'); assert.equal(manifest.version, '0.2.2-rc.1');

const evidenceOutput = process.env.CETAMESH_TEST_DSH_EVIDENCE;
if (evidenceOutput) assert.ok(path.isAbsolute(evidenceOutput));
const fixtureBase = process.env.CETAMESH_TEST_DSH_ARTIFACT_ROOT
  || (evidenceOutput ? path.join(path.dirname(evidenceOutput), 'native-loop-fixtures') : fs.realpathSync(os.tmpdir()));
assert.ok(path.isAbsolute(fixtureBase)); fs.mkdirSync(fixtureBase, {recursive: true});
const root = fs.mkdtempSync(path.join(fs.realpathSync(fixtureBase), 'cm-dsh-native-loop-'));
const project = path.join(root, 'project'), stateDir = path.join(root, 'state'), dataRoot = path.join(root, 'data');
const staging = path.join(root, 'staging');
for (const directory of [project, stateDir, dataRoot, staging]) fs.mkdirSync(directory);
const sourceContent = 'Actual DSH native read marker ' + crypto.randomBytes(24).toString('hex') + '\n';
fs.writeFileSync(path.join(project, 'source.txt'), sourceContent);
const emptyHooks = path.join(root, 'empty-hooks'); fs.mkdirSync(emptyHooks);
const emptyConfig = path.join(root, 'empty-gitconfig'); fs.writeFileSync(emptyConfig, '');
const git = args => execFileSync('git', ['-c', 'core.hooksPath=' + emptyHooks, '-c', 'commit.gpgsign=false', ...args], {
  cwd: project, windowsHide: true, encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig}
});
git(['init', '--quiet', '--template=' + emptyHooks]); git(['add', '--', 'source.txt']);
git(['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Owned native DSH fixture']);

const secret = 'synthetic-loopback-dsh-only-key';
const secrets = new Map();
const providerSecrets = {
  list: () => [...secrets].map(([provider, value]) => ({provider, configured: true, hasKey: true, baseUrl: value.baseUrl})),
  set: value => secrets.set(value.provider, {...value}),
  raw: provider => secrets.get(provider) ?? {}
};
const evidence = {kind: 'real-DSH-0.2.2-Core-native-tools-synthetic-local-model', status: 'RUNNING',
  nativeWindowsUi: false, realRemoteModel: false, runtimeVersion: manifest.version,
  supervisorSha256: sha256(fs.readFileSync(supervisor)), root, http: [], requests: [], approvals: [], cases: [], closes: [], faults: [], snapshots: [],
  limitations: ['Actual installed CLI, actual Core and filesystem; local model decisions are synthetic.',
    'No live account, production data, global DSH home, installer, Release or native Windows UI acceptance.']};
let core, serverFailure, currentCase, workspace, taskId, sourceSession, expectedResumeInstruction = false, passed = false;
let fault, allowUnknownEffectsClose = false;
const ownedLaunches = new Map();
const cases = new Map();
const ui = (method, params) => core.desktopUiService.execute({method, params});
const cap = (method, params) => core.capabilityService.execute({method, params});
const task = () => core.taskService.runtime.get({id: taskId}).task;
async function until(read, predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs; let value;
  do {
    if (serverFailure) throw serverFailure;
    value = await read(); if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw Object.assign(new Error(label + ' timed out: ' + JSON.stringify(value)), {code: 'DSH_NATIVE_LOOP_TIMEOUT'});
}
const server = http.createServer(async (request, response) => {
  try {
    evidence.http.push({method: request.method, path: request.url});
    // Pinned DSH's DeepSeek provider uses Messages, not OpenAI Chat Completions.
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], secret);
    let bodyText = '';
    for await (const chunk of request) { bodyText += chunk; assert.ok(Buffer.byteLength(bodyText) <= 8 * 1024 * 1024); }
    const body = JSON.parse(bodyText), marker = [...bodyText.matchAll(/CM_DSH_NATIVE_([a-z0-9-]+)/g)].at(-1)?.[1];
    const scenario = cases.get(marker);
    assert.ok(scenario, 'actual request must contain its exact synthetic Task identity');
    if (expectedResumeInstruction) assert.equal(marker, 'resume', 'formal same-Task resume must deliver the NEW Owner instruction');
    assert.equal(body.model, 'cm-dsh-synthetic');
    const tools = (body.tools ?? []).map(tool => tool.name);
    const results = (body.messages ?? []).flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result' && block.tool_use_id === 'native_' + scenario.name) : []);
    const observed = {case: scenario.name, index: evidence.requests.length + 1, stream: body.stream === true,
      toolMessages: results.length, markerObserved: JSON.stringify(results).includes(sourceContent.trim())};
    evidence.requests.push(observed);
    if (observed.markerObserved) scenario.markerObserved = true;
    if (results.length) scenario.results.push(...results.map(result => ({toolCallId: result.tool_use_id,
      isError: result.is_error === true, contentSha256: sha256(JSON.stringify(result.content))})));
    const issueTool = !scenario.issued;
    let block, finishReason;
    if (issueTool) {
      assert.ok(tools.includes(scenario.tool), 'real DSH must advertise the requested native tool');
      scenario.issued = true;
      block = {type: 'tool_use', id: 'native_' + scenario.name, name: scenario.tool, input: scenario.input};
      finishReason = 'tool_use';
    } else { block = {type: 'text', text: 'Synthetic local DSH turn completed for ' + scenario.name + '.'}; finishReason = 'end_turn'; }
    const message = {id: 'msg-synthetic-' + evidence.requests.length, type: 'message', role: 'assistant', model: body.model,
      content: [block], stop_reason: finishReason, stop_sequence: null, usage: {input_tokens: 20, output_tokens: 10}};
    if (body.stream) {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const emit = (type, fields) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({type, ...fields}) + '\n\n');
      emit('message_start', {message: {...message, content: [], stop_reason: null, usage: {input_tokens: 20, output_tokens: 0}}});
      emit('content_block_start', {index: 0, content_block: issueTool ? {...block, input: {}} : {type: 'text', text: ''}});
      emit('content_block_delta', {index: 0, delta: issueTool ? {type: 'input_json_delta', partial_json: JSON.stringify(scenario.input)} : {type: 'text_delta', text: block.text}});
      emit('content_block_stop', {index: 0});
      emit('message_delta', {delta: {stop_reason: finishReason, stop_sequence: null}, usage: {output_tokens: 10}});
      emit('message_stop', {}); response.end();
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(message));
    }
  } catch (error) { serverFailure = error; if (!response.destroyed) { response.statusCode = 500; response.end('Synthetic model fixture failed'); } }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
// Same real CLI, environment and reviewed owned-tree supervisor as production.
// The only fault seam is Core's view of the actual stdout pipe; no native result is fabricated.
async function launchOwned({runtime, profile, sessionId, controlDir, environment}) {
  const owner = new CliAgentProcess({name: 'dsh-sdk', executable: runtime.nodePath,
    argsPrefix: [runtime.dshBin], envSource: createMinimalAgentEnv(),
    ownedTreeStateDir: path.join(stateDir, 'agent', 'dsh-sdk-processes'), ownedTreeSupervisor: supervisor});
  const handle = owner.startSession({sessionId, cwd: controlDir, args: ['--profile', profile.profile, '--patch', profile.patchPath],
    inputMode: 'open', timeoutMs: 30 * 60 * 1000, env: environment,
    authorizedEnvKeys: ['DSH_HOME', 'CETAMESH_DSH_TASK_API_KEY']});
  const outward = new PassThrough(), decoder = new StringDecoder('utf8');
  const launched = {sessionId, handle, owner, outward, cut: false}; ownedLaunches.set(sessionId, launched);
  let buffered = '';
  function line(bytes) {
    if (launched.cut) return;
    let frame;
    try { frame = JSON.parse(bytes.replace(/^\uFEFF/, '')); } catch { /* Forward unchanged for the real protocol decoder. */ }
    const actual = frame?.method === 'session.event' ? frame.params?.event : null;
    if (fault?.kind === 'drop-result' && fault.sessionId === sessionId && actual?.type === 'tool/result'
      && actual.data?.message?.toolCallId === fault.callId) {
      fault.dropped = {eventSeq: actual.seq, isError: actual.data.message.isError,
        actualResultSha256: sha256(JSON.stringify(actual.data.message.content))};
      launched.cut = true; outward.destroy(); return;
    }
    outward.write(bytes + '\n');
  }
  handle.child.stdout.on('data', chunk => {
    buffered += decoder.write(chunk);
    if (Buffer.byteLength(buffered) > 2 * 1024 * 1024) { launched.cut = true; outward.destroy(new Error('Owned test stdout frame exceeded its bound')); return; }
    let split;
    while ((split = buffered.indexOf('\n')) >= 0) { const bytes = buffered.slice(0, split); buffered = buffered.slice(split + 1); line(bytes); }
  });
  handle.child.stdout.on('end', () => { buffered += decoder.end(); if (buffered) line(buffered); if (!outward.destroyed) outward.end(); });
  handle.child.stdout.on('error', error => outward.destroy(error));
  handle.child.stdout.on('close', () => { if (!outward.destroyed) outward.destroy(); });
  return {readable: outward, writable: handle.child.stdin, done: handle.done,
    close: async () => { handle.shutdown(); await handle.done; await owner.shutdown(); }};
}
function disconnectOwned(sessionId) {
  const owned = ownedLaunches.get(sessionId); assert.ok(owned, 'only the exact fixture-owned Session pipe can be disconnected');
  owned.cut = true; owned.outward.destroy();
}
function makeCore() {
  const agentRuntimeConfiguration = createAgentRuntimeConfiguration({stateDir, providerSecrets, allowLoopbackHttpForTests: true});
  return createCetaMeshServices({stateDir, dataRoot, sourceRoot: root, resourceRoot: root,
    agentStagingRoot: staging, providerSecrets, agentRuntimeConfiguration, deferOptionalStart: true,
    agentDshSdkOptions: {allowLoopbackHttpForTests: true, ownedTreeSupervisor: supervisor, launch: launchOwned,
      requestNativeApproval: (input, options = {}) => {
        if (input.target.rawInput.file_path !== 'deadline.txt') return core.capabilityService.requestAgentNativeApproval(input, options);
        const deadline = new AbortController(), startedAt = Date.now();
        const timer = setTimeout(() => deadline.abort(), 1000);
        return core.capabilityService.requestAgentNativeApproval(input,
          {...options, signal: AbortSignal.any([options.signal, deadline.signal].filter(Boolean))})
          .finally(() => {clearTimeout(timer); evidence.faults.push({kind: 'owned-approval-abort-deadline',
            elapsedMs: Date.now() - startedAt, nativeTenMinuteTtl: false});});
      }}});
}
async function decide(row, approve) {
  const capability = row.request.capability;
  const result = await cap('capability.approval.decide', {id: row.id, approve});
  evidence.approvals.push({id: row.id, capability, approve, taskId: row.request.taskId ?? null,
    inputSha256: sha256(JSON.stringify(row.request.input))});
  return result;
}
async function pending(capability) {
  return until(() => core.capabilityService.broker.approvals.list().find(row => row.request.capability === capability
    && (capability === 'agent.execution.authorize' || row.request.taskId === taskId)), Boolean, 'pending ' + capability);
}
async function dispatchCase(name, tool, input) {
  const scenario = {name, tool, input, markerObserved: false, issued: false, results: []}; cases.set(name, scenario);
  const result = await cap('capability.execute', {capability: 'agent.run', taskId, workspaceId: workspace.id,
    requestId: 'dsh-native-' + name, input: {agentProvider: 'dsh', content: 'Use the native ' + tool
      + ' tool exactly once for this controlled fixture. CM_DSH_NATIVE_' + name}});
  assert.equal(result.status, 'completed'); assert.equal(result.result.accepted, true);
  assert.equal(result.result.sessionId, sourceSession, 'follow-up execution keeps its exact Task Session');
  scenario.runId = task().executionObservation.runId;
  return scenario;
}
async function exactToolApproval(scenario) {
  const row = await pending('agent.native.approve');
  assert.deepEqual(JSON.parse(row.request.input.nativeDetails).arguments, scenario.input);
  assert.equal(row.request.taskId, taskId); assert.equal(row.request.workspaceId, workspace.id);
  assert.equal(row.request.input.nativeBinding.runId, task().executionObservation.runId);
  assert.equal(scenario.results.length, 0, 'the current native tool cannot return a result before Owner decides');
  return row;
}
async function finishCase(label) {
  const current = await until(task, row => row.executionObservation?.state === 'awaiting-review'
    || ['blocked', 'failed'].includes(row.status), label);
  assert.equal(current.executionObservation?.state, 'awaiting-review', JSON.stringify(current));
  return current;
}
async function startCaseTask(name, tool, input) {
  const scenario = {name, tool, input, markerObserved: false, issued: false, results: []}; cases.set(name, scenario);
  const created = await core.taskService.execute({method: 'task.create', params: {goal: 'Use the native ' + tool
    + ' tool exactly once. CM_DSH_NATIVE_' + name, workspaceId: workspace.id, requestedAgentProvider: 'dsh'}});
  taskId = created.id;
  core.capabilityService.grantTask(taskId, {capabilities: ['filesystem.read', 'filesystem.search', 'filesystem.write']});
  const started = await ui('ui.task.start', {id: taskId, expectedRev: task().rev, agentProvider: 'dsh', requestId: 'dsh-native-' + name});
  sourceSession = started.task.currentAgent.sessionId; scenario.runId = task().executionObservation.runId;
  return scenario;
}
function snapshotCurrent(label) {
  const current = task();
  evidence.snapshots.push({label, taskId: current.id, status: current.status, goalSha256: sha256(current.goal),
    currentAgent: current.currentAgent, agentHistory: current.agentHistory, executionObservation: current.executionObservation,
    executionEvidence: current.executionEvidence});
}
async function closeCore() {
  const errors = [];
  if (core) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) {
    try { await core[name].close(); evidence.closes.push({name, status: 'closed'}); }
    catch (error) {
      const exactStop = allowUnknownEffectsClose && name === 'agentService'
        && ['PROVIDER_CLOSE_UNKNOWN', 'DSH_NATIVE_EFFECT_UNKNOWN'].includes(error.code)
        && (await inspectTaskSession(core.agentBroker, task(), {provider: 'dsh', sessionId: sourceSession})).stopped === true;
      if (exactStop) evidence.closes.push({name, status: 'owned-process-stopped-effects-retained', code: error.code});
      else { errors.push(error); evidence.closes.push({name, status: 'unconfirmed', code: error.code ?? 'CLOSE_FAILED'}); }
    }
  }
  core = null;
  if (errors.length) throw new AggregateError(errors, 'Owned Core cleanup was not confirmed');
}
try {
  core = makeCore();
  await ui('ui.agent.configure', {agentId: 'dsh', config: {taskTransport: 'sdk', runtimePath, nodePath: process.execPath,
    model: 'cm-dsh-synthetic', baseUrl, apiKey: secret}});
  const firstHealth = await ui('ui.agent.health', {provider: 'dsh'});
  assert.equal(firstHealth.taskEligible, true, JSON.stringify(firstHealth));
  assert.equal(evidence.requests.length, 0, 'real protocol readiness must not call the model');
  workspace = await ui('ui.workspace.create', {root: project, name: 'Actual DSH synthetic-model fixture'});
  const firstScope = await ui('ui.agent.security', {provider: 'dsh', workspaceId: workspace.id});
  await ui('ui.agent.health', {provider: 'dsh'});
  assert.equal((await ui('ui.agent.security', {provider: 'dsh', workspaceId: workspace.id})).fingerprint, firstScope.fingerprint,
    'repeated actual SDK health cannot change unchanged execution consent');
  assert.equal(firstScope.security.nativeSandboxSupported, false);
  const authorization = await ui('ui.agent.authorize', {provider: 'dsh', workspaceId: workspace.id, fingerprint: firstScope.fingerprint});
  assert.equal(authorization.status, 'pending');
  await decide(await pending('agent.execution.authorize'), true);
  currentCase = {name: 'read', tool: 'read', input: {file_path: 'source.txt'}, markerObserved: false, issued: false, results: []};
  cases.set(currentCase.name, currentCase);
  const created = await core.taskService.execute({method: 'task.create', params: {goal: 'Read source.txt exactly once. CM_DSH_NATIVE_read',
    workspaceId: workspace.id, requestedAgentProvider: 'dsh'}});
  taskId = created.id;
  core.capabilityService.grantTask(taskId, {capabilities: ['filesystem.read', 'filesystem.search', 'filesystem.write']});
  const started = await ui('ui.task.start', {id: taskId, expectedRev: task().rev, agentProvider: 'dsh', requestId: 'dsh-native-read'});
  sourceSession = started.task.currentAgent.sessionId;
  const readApproval = await pending('agent.native.approve');
  assert.deepEqual(JSON.parse(readApproval.request.input.nativeDetails).arguments, currentCase.input);
  assert.equal(readApproval.request.taskId, taskId); assert.equal(readApproval.request.workspaceId, workspace.id);
  assert.equal(currentCase.results.length, 0);
  assert.equal(task().executionEvidence.filter(row => row.source === 'native-result').length, 0, 'no actual tool result before Owner decision');
  assert.equal(fs.readFileSync(path.join(project, 'source.txt'), 'utf8'), sourceContent);
  await decide(readApproval, true);
  const finished = await until(task, row => row.executionObservation?.state === 'awaiting-review' || ['blocked', 'failed'].includes(row.status), 'actual DSH read completion');
  assert.equal(finished.executionObservation?.state, 'awaiting-review', JSON.stringify(finished));
  assert.equal(currentCase.markerObserved, true, 'actual native file output must reach the synthetic model');
  assert.ok(currentCase.results.length > 0);
  assert.ok(finished.executionEvidence.some(row => row.source === 'native-result' && row.status === 'completed'
    && /^[a-f0-9]{64}$/.test(row.resultSha256 ?? '')));
  assert.equal(core.capabilityService.completionBlocker(taskId), null);
  evidence.cases.push({name: 'read', status: 'PASS', modelRequests: evidence.requests.length, nativeResults: currentCase.results.length});
  console.log('PASS actual DSH read -> exact Core Owner approval -> actual file marker -> native result evidence');

  const priorSession = sourceSession, priorEvidence = structuredClone(task().executionEvidence), originalGoal = task().goal;
  const paused = await ui('ui.task.pause', {id: taskId, expectedRev: task().rev});
  assert.equal(paused.task.status, 'paused');
  const resumedRead = {name: 'resume', tool: 'read', input: {file_path: 'source.txt'}, markerObserved: false, issued: false, results: []};
  cases.set('resume', resumedRead); expectedResumeInstruction = true;
  const resumed = await ui('ui.task.resume', {id: taskId, expectedRev: task().rev, requestId: 'dsh-native-fresh-resume',
    nextInstruction: 'Read source.txt once again for this NEW Owner instruction. CM_DSH_NATIVE_resume'});
  assert.equal(resumed.task.id, taskId); sourceSession = resumed.task.currentAgent.sessionId;
  assert.notEqual(sourceSession, priorSession, 'verified stopped SDK execution resumes through a fresh Session');
  const resumeApproval = await exactToolApproval(resumedRead);
  await decide(resumeApproval, true); await finishCase('same Task fresh-session native read');
  expectedResumeInstruction = false;
  assert.equal(resumedRead.markerObserved, true); assert.equal(task().goal, originalGoal);
  assert.ok(priorEvidence.every(before => task().executionEvidence.some(after => after.eventId === before.eventId && after.resultSha256 === before.resultSha256)));
  assert.ok(task().agentHistory.some(row => row.sessionId === priorSession));
  evidence.cases.push({name: 'same Task pause and fresh-session resume with new instruction', status: 'PASS',
    previousSession: priorSession, currentSession: sourceSession});
  console.log('PASS same Task pause -> verified stop -> fresh Session -> NEW instruction -> new one-shot native read approval');

  const stage = (await core.agentBroker.status({provider: 'dsh', sessionId: sourceSession})).cwd;
  assert.ok(path.isAbsolute(stage) && !path.relative(staging, stage).startsWith('..') && stage !== project);
  const writeContent = 'Actual DSH native staged write ' + crypto.randomBytes(16).toString('hex') + '\n';
  const write = await dispatchCase('write', 'write', {file_path: 'approved.txt', content: writeContent});
  const writeApproval = await exactToolApproval(write);
  assert.equal(fs.existsSync(path.join(stage, 'approved.txt')), false);
  assert.equal(fs.existsSync(path.join(project, 'approved.txt')), false);
  await decide(writeApproval, true);
  const importApproval = await pending('workspace.apply');
  assert.equal(fs.readFileSync(path.join(stage, 'approved.txt'), 'utf8'), writeContent);
  assert.equal(fs.existsSync(path.join(project, 'approved.txt')), false, 'native approval never authorizes Source import');
  const changes = importApproval.request.input.changes;
  assert.equal(changes.length, 1); assert.equal(changes[0].action, 'write'); assert.equal(changes[0].path, 'approved.txt');
  assert.equal(changes[0].content, writeContent, 'Owner driver approves only the exact owned fixture import');
  await decide(importApproval, true);
  await finishCase('actual DSH staged write and independent import');
  assert.equal(fs.readFileSync(path.join(project, 'approved.txt'), 'utf8'), writeContent);
  assert.equal(fs.readFileSync(path.join(project, 'source.txt'), 'utf8'), sourceContent);
  assert.equal(core.capabilityService.completionBlocker(taskId), null);
  assert.ok(task().executionEvidence.some(row => row.runId === write.runId && row.source === 'core-import' && row.status === 'completed'));
  evidence.cases.push({name: 'native write and independent import', status: 'PASS',
    modelRequests: evidence.requests.filter(row => row.case === 'write').length, importedSha256: sha256(writeContent)});
  console.log('PASS actual DSH write -> native approval -> staging only -> separate workspace.apply approval -> Source import');

  const editedContent = writeContent.replace('staged write', 'staged edit');
  const edit = await dispatchCase('edit', 'edit', {file_path: 'approved.txt', old_string: writeContent, new_string: editedContent});
  const editApproval = await exactToolApproval(edit);
  assert.equal(fs.readFileSync(path.join(stage, 'approved.txt'), 'utf8'), writeContent);
  assert.equal(fs.readFileSync(path.join(project, 'approved.txt'), 'utf8'), writeContent);
  await decide(editApproval, true);
  const editImport = await pending('workspace.apply'), editChanges = editImport.request.input.changes;
  assert.equal(fs.readFileSync(path.join(stage, 'approved.txt'), 'utf8'), editedContent);
  assert.equal(fs.readFileSync(path.join(project, 'approved.txt'), 'utf8'), writeContent, 'native edit approval cannot change Source before its separate import');
  assert.equal(editChanges.length, 1); assert.equal(editChanges[0].path, 'approved.txt'); assert.equal(editChanges[0].action, 'write');
  assert.equal(editChanges[0].content, editedContent); assert.equal(editChanges[0].expectedHash, sha256(writeContent));
  await decide(editImport, true); await finishCase('actual DSH edit and independent import');
  const actualEditedHash = sha256(fs.readFileSync(path.join(project, 'approved.txt')));
  assert.equal(actualEditedHash, sha256(editedContent));
  assert.equal(core.capabilityService.verifyTaskImportReceipts(taskId, edit.runId), true, 'Core independently rechecks the imported native edit postimage');
  const editReceipt = task().executionEvidence.find(row => row.runId === edit.runId && row.source === 'core-import' && row.status === 'completed');
  assert.equal(editReceipt.changes[0].sha256, actualEditedHash); assert.equal(editReceipt.changes[0].previousSha256, sha256(writeContent));
  evidence.cases.push({name: 'native edit and independent import with verified preimage/postimage', status: 'PASS',
    modelRequests: evidence.requests.filter(row => row.case === 'edit').length,
    previousSha256: sha256(writeContent), importedSha256: actualEditedHash});
  console.log('PASS actual DSH edit(old_string/new_string) -> one-shot approval -> separate import -> independent Core postimage verification');

  const denied = await dispatchCase('deny', 'write', {file_path: 'denied.txt', content: 'This rejected write must never run.'});
  await decide(await exactToolApproval(denied), false);
  await finishCase('actual DSH native write rejection');
  assert.equal(fs.existsSync(path.join(stage, 'denied.txt')), false);
  assert.equal(fs.existsSync(path.join(project, 'denied.txt')), false);
  assert.ok(denied.results.some(row => row.isError), 'the real Host returns a refusal result to the synthetic model');
  assert.equal(core.capabilityService.broker.approvals.list().some(row => row.request.capability === 'workspace.apply'), false);
  evidence.cases.push({name: 'rejected write has no filesystem effect', status: 'PASS'});
  console.log('PASS actual DSH rejected write -> no staging or Source file and no import');

  const deadline = await dispatchCase('deadline', 'write', {file_path: 'deadline.txt', content: 'This timed-out approval must never execute.'});
  const deadlineApproval = await exactToolApproval(deadline);
  await until(() => core.capabilityService.broker.approvals.get(deadlineApproval.id), row => row.status !== 'pending', 'owned approval abort deadline');
  await assert.rejects(() => cap('capability.approval.decide', {id: deadlineApproval.id, approve: true}));
  await finishCase('actual native call after owned approval deadline');
  assert.equal(fs.existsSync(path.join(stage, 'deadline.txt')), false);
  assert.equal(fs.existsSync(path.join(project, 'deadline.txt')), false);
  evidence.cases.push({name: 'owned approval abort deadline prevents execution', status: 'PASS', nativeTenMinuteTtl: 'NOT_RUN'});
  console.log('PASS actual DSH approval wait -> owned abort deadline -> late grant refused -> no write (not ten-minute TTL)');

  const cancelled = await dispatchCase('cancel', 'write', {file_path: 'cancelled.txt', content: 'This cancelled write must never run.'});
  const staleApproval = await exactToolApproval(cancelled);
  const stoppedTask = await ui('ui.task.cancel', {id: taskId, expectedRev: task().rev});
  assert.equal(stoppedTask.task.status, 'cancelled');
  await assert.rejects(() => cap('capability.approval.decide', {id: staleApproval.id, approve: true}));
  assert.equal(fs.existsSync(path.join(stage, 'cancelled.txt')), false);
  assert.equal(fs.existsSync(path.join(project, 'cancelled.txt')), false);
  assert.equal(task().executionEvidence.some(row => row.runId === cancelled.runId && row.source === 'native-result' && row.status === 'completed'), false);
  evidence.cases.push({name: 'cancelled pending call refuses late approval', status: 'PASS'});
  console.log('PASS actual DSH pending write cancel -> owned process stop -> late approval refused -> no file');
  const persisted = core.taskService.runtime.get({id: taskId}).task;
  snapshotCurrent('settled read/write/edit/rejection/deadline/cancel Task before Core restart');
  await closeCore(); core = makeCore();
  const restored = core.taskService.runtime.get({id: taskId}).task;
  assert.deepEqual(restored.executionEvidence, persisted.executionEvidence);
  assert.deepEqual(restored.agentHistory, persisted.agentHistory);
  assert.equal((await inspectTaskSession(core.agentBroker, restored, {provider: 'dsh', sessionId: sourceSession})).stopped, true,
    'recreated Core must use the exact durable owned-process stop proof');
  evidence.cases.push({name: 'Core restart evidence and stop proof', status: 'PASS'});

  // Consent is process-local: explicitly review the same stable policy in this new Core.
  await ui('ui.agent.health', {provider: 'dsh'});
  const renewedScope = await ui('ui.agent.security', {provider: 'dsh', workspaceId: workspace.id});
  await ui('ui.agent.authorize', {provider: 'dsh', workspaceId: workspace.id, fingerprint: renewedScope.fingerprint});
  await decide(await pending('agent.execution.authorize'), true);

  const disconnected = await startCaseTask('disconnect', 'write', {file_path: 'disconnected.txt', content: 'A disconnected pending call must not execute.'});
  const disconnectedApproval = await exactToolApproval(disconnected);
  const disconnectedStage = (await core.agentBroker.status({provider: 'dsh', sessionId: sourceSession})).cwd;
  disconnectOwned(sourceSession);
  await until(() => core.capabilityService.broker.approvals.get(disconnectedApproval.id), row => row.status !== 'pending', 'disconnect invalidates Core approval');
  await until(task, row => row.status === 'blocked', 'actual SDK disconnect blocks its Task');
  await until(() => core.agentBroker.status({provider: 'dsh', sessionId: sourceSession}), row => row.stopped === true, 'owned SDK stop after pipe loss');
  await assert.rejects(() => cap('capability.approval.decide', {id: disconnectedApproval.id, approve: true}));
  assert.equal(fs.existsSync(path.join(disconnectedStage, 'disconnected.txt')), false);
  assert.equal(fs.existsSync(path.join(project, 'disconnected.txt')), false);
  assert.equal(core.capabilityService.broker.uncertainDispatchesForTask({taskId, workspaceId: workspace.id}).length, 0,
    'disconnect before permission release has no native effect intent');
  await ui('ui.task.cancel', {id: taskId, expectedRev: task().rev});
  evidence.cases.push({name: 'real pending SDK pipe disconnect denies execution and late grant', status: 'PASS'});
  snapshotCurrent('pending disconnect Task after confirmed stop');
  console.log('PASS actual pending DSH pipe loss -> approval invalidation -> owned stop -> no write');

  const lostContent = 'Actual native write whose result is intentionally lost ' + crypto.randomBytes(16).toString('hex');
  const lost = await startCaseTask('loss', 'write', {file_path: 'lost-result.txt', content: lostContent});
  const lostApproval = await exactToolApproval(lost);
  const lostStage = (await core.agentBroker.status({provider: 'dsh', sessionId: sourceSession})).cwd;
  fault = {kind: 'drop-result', sessionId: sourceSession, callId: lostApproval.request.input.nativeBinding.toolCallId};
  await decide(lostApproval, true);
  await until(() => fault.dropped, Boolean, 'drop the actual successful native result');
  assert.equal(fault.dropped.isError, false, 'fault injection drops an actual successful Host result, never a fabricated completion');
  assert.equal(fs.readFileSync(path.join(lostStage, 'lost-result.txt'), 'utf8'), lostContent);
  assert.equal(fs.existsSync(path.join(project, 'lost-result.txt')), false, 'lost native result cannot cause an import');
  await until(task, row => row.status === 'blocked', 'lost-result Task retains blocked execution');
  await until(() => core.agentBroker.status({provider: 'dsh', sessionId: sourceSession}), row => row.stopped === true, 'owned runtime stops after actual result loss');
  await until(() => core.capabilityService.broker.uncertainDispatchesForTask({taskId, workspaceId: workspace.id}),
    rows => rows.length === 1 && rows[0].status === 'outcome-unknown', 'native intent remains unknown after lost result');
  assert.equal(core.capabilityService.completionBlocker(taskId), 'TASK_EFFECT_UNCONFIRMED');
  assert.equal(task().executionEvidence.some(row => row.runId === lost.runId && row.source === 'native-result' && row.status === 'completed'), false);
  await assert.rejects(() => cap('capability.approval.decide', {id: lostApproval.id, approve: true}));
  const beforeRecovery = task(), requestsBeforeRecovery = evidence.requests.length;
  const review = await ui('ui.task.recovery.inspect', {id: taskId, automatic: true});
  assert.equal(review.canResume, false); assert.ok(review.blockers.some(row => row.code === 'TASK_EFFECT_UNCONFIRMED'));
  await assert.rejects(() => ui('ui.task.resume', {id: taskId, expectedRev: task().rev, requestId: 'do-not-replay-lost-effect',
    nextInstruction: 'Continue only after the missing effect is safely reconciled.'}));
  assert.equal(evidence.requests.length, requestsBeforeRecovery, 'refused recovery cannot replay any model/tool execution');
  assert.deepEqual(task().agentHistory, beforeRecovery.agentHistory); assert.deepEqual(task().executionEvidence, beforeRecovery.executionEvidence);
  evidence.faults.push({...fault, stageFileSha256: sha256(fs.readFileSync(path.join(lostStage, 'lost-result.txt'))), sourceFileExists: false});
  snapshotCurrent('lost real result retained before Core restart');
  const lostHistory = structuredClone(task().agentHistory), lostEvidence = structuredClone(task().executionEvidence), lostTaskId = taskId;
  allowUnknownEffectsClose = true;
  await closeCore(); allowUnknownEffectsClose = false; core = makeCore();
  assert.equal(task().id, lostTaskId); assert.deepEqual(task().agentHistory, lostHistory); assert.deepEqual(task().executionEvidence, lostEvidence);
  assert.equal(core.capabilityService.completionBlocker(taskId), 'TASK_EFFECT_UNCONFIRMED');
  assert.equal(core.capabilityService.recoveryForTask(taskId).state, 'needs-reconciliation');
  assert.throws(() => core.capabilityService.assertWorkspaceRecoveryAvailable({taskId: 'another-task', workspaceId: workspace.id}),
    {code: 'WORKSPACE_OPERATION_UNCONFIRMED'}, 'the retained effect also fences overlapping Workspace recovery');
  assert.equal(fs.readFileSync(path.join(lostStage, 'lost-result.txt'), 'utf8'), lostContent);
  assert.equal(fs.existsSync(path.join(project, 'lost-result.txt')), false);
  assert.equal((await inspectTaskSession(core.agentBroker, task(), {provider: 'dsh', sessionId: sourceSession})).stopped, true,
    'process stop proof and unknown effect remain independent after restart');
  const restartedReview = await ui('ui.task.recovery.inspect', {id: taskId, automatic: true});
  assert.equal(restartedReview.canResume, false); assert.ok(restartedReview.blockers.some(row => row.code === 'TASK_EFFECT_UNCONFIRMED'));
  assert.equal(evidence.requests.length, requestsBeforeRecovery);
  evidence.cases.push({name: 'actual approved write result loss retains stage, unknown effect and Task/Workspace fence across Core restart', status: 'PASS'});
  snapshotCurrent('lost real result retained after Core restart');
  console.log('PASS actual approved write + dropped real result -> unknown effect -> owned stop -> no replay/import -> restart retains Task/Workspace fence and stage');
  passed = true; evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.failure = {code: error.code ?? 'ASSERTION_FAILED', message: error.message};
  throw error;
} finally {
  try { await closeCore(); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const output = evidenceOutput || path.join(root, 'native-loop-evidence.json');
    assert.ok(path.isAbsolute(output)); fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log('PRIVATE_FIXTURE_ROOT=' + root);
    console.log('PRIVATE_EVIDENCE=' + output);
    if (passed) console.log('PASS actual installed DSH 0.2.2 + synthetic loopback model + real Core; native UI/live model NOT_RUN');
    // Retain owned state/staging on success and failure for independent evidence review.
  }
}
