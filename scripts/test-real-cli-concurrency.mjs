// Opt-in actual installed CLIs and production Core; the loopback model is synthetic.
// Separate Workspace roots preserve the current external-Agent writer boundary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createAcpProcessLauncher} from '../src/agent/acp-provider-descriptors.js';
import {findCliExecutable} from '../src/agent/cli-agent-process.js';

if (process.env.WHALEBRIDGE_TEST_REAL_CLI_CONCURRENCY !== '1') {
  console.log('NOT_RUN_ENVIRONMENT: explicit real CLI concurrency opt-in required');
  process.exit(77);
}
const runtimes = {
  opencode: process.env.WHALEBRIDGE_TEST_OPENCODE_CLI || findCliExecutable('opencode'),
  qwen: process.env.WHALEBRIDGE_TEST_QWEN_CLI
};
if (process.platform !== 'win32' || Object.values(runtimes).some(file =>
  !file || !path.isAbsolute(file) || !fs.existsSync(file))) {
  console.log('NOT_RUN_ENVIRONMENT: installed Windows OpenCode and pinned Qwen command paths required');
  process.exit(77);
}

const nodePath = process.env.WHALEBRIDGE_TEST_AGENT_NODE || process.execPath;
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cetamesh-real-cli-concurrency-'));
const profiles = path.join(root, 'profiles'), staging = path.join(root, 'staging');
for (const directory of [profiles, staging]) fs.mkdirSync(directory);
const secret = 'synthetic-loopback-concurrency-key';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const providers = ['opencode', 'qwen'];
const rows = new Map(), owned = [], barriers = new Map();
const inputByProvider = Object.fromEntries(providers.map(provider => [provider,
  'Controlled read-only input.\nmarker=' + crypto.randomBytes(24).toString('hex') + '\n']));
const evidence = {
  kind: 'actual-installed-CLI-production-Core-synthetic-loopback-model',
  status: 'RUNNING', nativeDesktop: false, realRemoteModel: false,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim()),
  sourceHashes: Object.fromEntries(['app/service-container.js', 'desktop/platform-runtime.js', 'capability/service.js', 'task/runtime.js',
    'agent/broker.js', 'agent/acp-agent-provider.js', 'agent/acp-provider-descriptors.js']
    .map(file => [file, hash(fs.readFileSync(new URL('../src/' + file, import.meta.url)))])),
  startedAt: stamp(), providers: {}, tasks: [], requests: [], dispatches: [], nativeResults: [], closes: [],
  approvals: [], boundaries: [], cases: [], cost: {amount: null, reason: 'synthetic-model-no-tariff'},
  limitations: [
    'Actual installed OpenCode/Qwen processes, native reads, approvals and production Core/UI APIs; model decisions are synthetic.',
    'The structural and cancellation cases use an explicit first-request barrier; this proves concurrent execution structure only.',
    'Serial and parallel benchmark cases have identical per-request delay and no barrier; one sample is not a model-performance claim.',
    'External root Tasks currently retain executionObservation and native result digests but no child Attempt rows.',
    'External read-only child admission remains refused; independent Workspaces do not prove shared-Workspace external Agent collaboration.',
    'No paid credentials, existing account profiles, native Desktop window, installed product update, release or OS crash is exercised.'
  ]
};
let services, serverFailure = null, passed = false;
const task = id => services.taskService.runtime.get({id}).task;
const ui = (method, params) => services.desktopUiService.execute({method, params});
const cap = (method, params) => services.capabilityService.execute({method, params});
const decide = (id, approve) => cap('capability.approval.decide', {id, approve});
const taskSnapshot = current => ({id: current.id, status: current.status,
  currentAgent: current.currentAgent, executionObservation: current.executionObservation,
  attemptCount: current.attempts.length,
  evidence: current.executionEvidence.map(item => ({eventId: item.eventId, provider: item.provider,
    sessionId: item.sessionId, runId: item.runId, phase: item.phase, capability: item.capability,
    status: item.status, source: item.source ?? null, resultSha256: item.resultSha256 ?? null}))});

async function waitFor(read, predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverFailure) throw serverFailure;
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw Object.assign(new Error(label + ' timed out'), {code: 'ACCEPTANCE_TIMEOUT'});
}
function sourceHashes(row) {
  return Object.fromEntries(fs.readdirSync(row.project).sort().map(name => {
    const file = path.join(row.project, name);
    assert.ok(fs.lstatSync(file).isFile(), 'synthetic source contains regular files only');
    return [name, hash(fs.readFileSync(file))];
  }));
}
function assertSource(row) { assert.deepEqual(sourceHashes(row), row.originalHashes); }
function intervalOverlap(left, right, start = 'startedAt', end = 'finishedAt') {
  const ms = value => typeof value === 'number' ? value : Date.parse(value);
  return Math.max(0, Math.min(ms(left[end]), ms(right[end])) - Math.max(ms(left[start]), ms(right[start])));
}
async function firstRequestBarrier(row) {
  if (!row.barrier) return;
  const barrier = barriers.get(row.barrier);
  barrier.arrived.add(row.key);
  if (barrier.arrived.size === 2) {
    barrier.releasedAt = stamp();
    barrier.release();
  }
  let timer;
  try {
    await Promise.race([barrier.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Synthetic concurrency barrier timed out'),
        {code: 'SYNTHETIC_BARRIER_TIMEOUT'})), 20000);
    })]);
  } finally { clearTimeout(timer); }
}
const server = http.createServer(async (request, response) => {
  let observed;
  try {
    const provider = request.url.split('/')[1];
    assert.ok(providers.includes(provider), 'only isolated provider routes exist');
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({object: 'list', data: [{id: 'fixture', object: 'model'}]}));
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer ' + secret);
    let source = '';
    for await (const chunk of request) {
      source += chunk;
      assert.ok(Buffer.byteLength(source) <= 8 * 1024 * 1024, 'bounded local model request');
    }
    const body = JSON.parse(source), key = /CM_CONCURRENCY_([a-f0-9]{24})/.exec(source)?.[1];
    const row = rows.get(key);
    assert.ok(row && row.provider === provider, 'actual request binds to its exact synthetic Task');
    observed = {index: evidence.requests.length + 1, taskId: row.taskId, provider,
      case: row.case, requestedModel: body.model, startedAt: stamp(), configuredDelayMs: row.modelDelayMs};
    evidence.requests.push(observed);
    const messages = body.messages ?? [], names = (body.tools ?? []).map(item => item.function.name);
    const sendTool = !row.toolIssued && names.length > 0;
    const toolName = provider === 'qwen' ? 'read_file' : 'read';
    let delta, finish;
    if (sendTool) {
      assert.ok(names.includes(toolName), 'installed CLI advertises the native read tool');
      assert.ok(row.stage && fs.existsSync(path.join(row.stage, 'input.txt')));
      row.toolIssued = true;
      observed.phase = 'request-native-read';
      await firstRequestBarrier(row);
      const input = provider === 'qwen' ? {file_path: path.join(row.stage, 'input.txt')}
        : {path: path.join(row.stage, 'input.txt')};
      delta = {tool_calls: [{index: 0, id: 'read_' + key, type: 'function',
        function: {name: toolName, arguments: JSON.stringify(input)}}]};
      finish = 'tool_calls';
    } else {
      observed.phase = messages.some(item => item.role === 'tool') ? 'after-native-read' : 'auxiliary-request';
      const output = messages.filter(item => item.role === 'tool').map(item =>
        typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
      observed.toolResultSha256 = hash(output);
      observed.unseenMarkerObserved = output.includes(row.marker);
      if (observed.unseenMarkerObserved) row.modelSawMarker = true;
      delta = {content: 'Synthetic local read turn finished.'};
      finish = 'stop';
    }
    await delay(row.modelDelayMs);
    if (response.destroyed) { observed.disconnected = true; return; }
    const chunk = content => ({id: 'chatcmpl-local-' + key, object: 'chat.completion.chunk',
      created: 1, model: 'fixture', choices: [{index: 0, delta: content, finish_reason: null}]});
    if (body.stream) {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify(chunk(delta)) + '\n\n');
      response.write('data: ' + JSON.stringify({...chunk({}), choices: [{index: 0, delta: {}, finish_reason: finish}]}) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({id: 'chatcmpl-local-' + key, object: 'chat.completion', created: 1,
        model: 'fixture', choices: [{index: 0, message: {role: 'assistant', ...delta}, finish_reason: finish}]}));
    }
  } catch (error) {
    serverFailure = error;
    if (!response.destroyed) { response.statusCode = 500; response.end('Synthetic fixture request failed'); }
  } finally { if (observed) observed.finishedAt = stamp(); }
});

async function prepare(caseName, provider, {modelDelayMs = 0, barrier = null} = {}) {
  const key = crypto.randomBytes(12).toString('hex'), project = path.join(root, caseName + '-' + provider);
  fs.mkdirSync(project);
  const content = inputByProvider[provider], marker = /marker=([a-f0-9]+)/.exec(content)[1];
  fs.writeFileSync(path.join(project, 'input.txt'), content);
  const workspace = (await services.workspaceService.execute({method: 'workspace.create', params: {
    root: project, name: 'Isolated CLI concurrency ' + caseName + ' ' + provider}})).workspace;
  const created = await services.taskService.execute({method: 'task.create', params: {
    goal: 'Read input.txt exactly once with the native read tool. Do not write, run commands, access network, or delegate. CM_CONCURRENCY_' + key,
    workspaceId: workspace.id, requestedAgentProvider: provider}});
  const row = {key, case: caseName, provider, project, taskId: created.id, workspaceId: workspace.id,
    marker, modelDelayMs, barrier, modelSawMarker: false, nativeSawMarker: false};
  row.originalHashes = sourceHashes(row);
  rows.set(key, row);
  services.capabilityService.grantTask(created.id, {capabilities: ['filesystem.read', 'filesystem.search']});
  const scope = await ui('ui.agent.security', {provider, workspaceId: workspace.id});
  assert.equal(scope.security.nativeSandboxSupported, false);
  const pending = await ui('ui.agent.authorize', {provider, workspaceId: workspace.id, fingerprint: scope.fingerprint});
  assert.equal(pending.status, 'pending');
  await decide(pending.approvalId, true);
  evidence.approvals.push({taskId: created.id, provider, capability: 'agent.execution.authorize',
    approvalId: pending.approvalId, decision: 'approved', at: stamp()});
  return row;
}
async function start(row) {
  row.startedAt = stamp();
  const result = await ui('ui.task.start', {id: row.taskId, expectedRev: task(row.taskId).rev,
    agentProvider: row.provider, requestId: 'cli-concurrency-' + row.key});
  row.acceptedAt = stamp();
  row.sessionId = result.task.currentAgent.sessionId;
  assert.equal(result.task.currentAgent.provider, row.provider);
  return result;
}
async function pendingRead(row) {
  return waitFor(() => services.capabilityService.broker.approvals.list().find(item =>
    item.request?.taskId === row.taskId && item.request?.capability === 'agent.native.approve'),
  Boolean, 'exact native read approval');
}
async function approveRead(row, approval) {
  assert.equal(approval.request.workspaceId, row.workspaceId);
  const details = JSON.parse(approval.request.input.nativeDetails);
  assert.deepEqual(details.arguments, row.provider === 'qwen'
    ? {file_path: path.join(row.stage, 'input.txt')} : {path: path.join(row.stage, 'input.txt')});
  assert.equal(details.action, 'read');
  assertSource(row);
  await decide(approval.id, true);
  evidence.approvals.push({taskId: row.taskId, provider: row.provider, capability: 'agent.native.approve',
    approvalId: approval.id, argumentSha256: hash(JSON.stringify(details.arguments)), decision: 'approved', at: stamp()});
}
async function finish(row) {
  await approveRead(row, await pendingRead(row));
  const current = await waitFor(() => task(row.taskId), value =>
    value.executionObservation?.state === 'awaiting-review' || ['blocked', 'failed', 'cancelled'].includes(value.status),
  'actual CLI turn completion');
  assert.equal(current.executionObservation?.state, 'awaiting-review', JSON.stringify(taskSnapshot(current)));
  const observed = current.executionObservation;
  assert.equal(observed.provider, row.provider);
  assert.equal(observed.sessionId, row.sessionId);
  assert.ok(observed.dispatchAcceptedAt && observed.firstToolObservedAt && observed.turnEndObservedAt);
  const actual = current.executionEvidence.filter(item => item.provider === row.provider
    && item.sessionId === row.sessionId && item.runId === observed.runId && item.phase === 'user'
    && item.source === 'native-result' && item.status === 'completed' && /^[a-f0-9]{64}$/.test(item.resultSha256));
  assert.ok(actual.length, 'current native result digest is required; activity alone is insufficient');
  assert.ok(row.nativeSawMarker || row.modelSawMarker, 'actual read output must contain the unseen synthetic marker');
  assert.equal(current.attempts.length, 0, 'root Task Attempt limitation stays explicit; this test fabricates no Attempt');
  assertSource(row);
  row.finishedAt = stamp();
  row.snapshot = taskSnapshot(current);
  const projected = (await ui('ui.task.get', {id: row.taskId})).task;
  assert.equal(projected.currentAgent.provider, row.provider);
  assert.equal(projected.execution.state, 'awaiting-review');
  assert.equal(projected.execution.hasEvidence, true);
  row.uiProjection = {provider: projected.currentAgent.provider, observation: projected.execution.state,
    hasEvidence: projected.execution.hasEvidence, attemptCount: projected.attemptCount};
  return row;
}
function recordRow(row) {
  evidence.tasks.push({case: row.case, provider: row.provider, taskId: row.taskId, workspaceId: row.workspaceId,
    sessionId: row.sessionId, startedAt: row.startedAt, acceptedAt: row.acceptedAt, finishedAt: row.finishedAt,
    inputSha256: row.originalHashes['input.txt'], unchangedSource: true,
    actualNativeMarkerObserved: row.nativeSawMarker, actualModelToolResultMarkerObserved: row.modelSawMarker,
    uiProjection: row.uiProjection ?? null, ...row.snapshot});
}
function proof(pair, caseName, barrierControlled) {
  const requests = pair.map(row => evidence.requests.find(item => item.taskId === row.taskId && item.phase === 'request-native-read'));
  const observations = pair.map(row => row.snapshot.executionObservation);
  const observed = {name: caseName, barrierControlled,
    requestOverlapMs: intervalOverlap(...requests), runOverlapMs: intervalOverlap(...observations, 'at', 'turnEndObservedAt'),
    taskWallOverlapMs: intervalOverlap(...pair), taskIds: pair.map(row => row.taskId)};
  evidence.cases.push(observed);
  return observed;
}
function createBarrier(name) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  barriers.set(name, {promise, release, arrived: new Set()});
}
async function closePair(pair) {
  for (const row of pair) if (row.sessionId && !evidence.closes.some(item =>
    item.provider === row.provider && item.sessionId === row.sessionId && item.closed === true))
    await services.agentBroker.closeSession({provider: row.provider, sessionId: row.sessionId});
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const configuration = {
    get: provider => ({provider, enabled: providers.includes(provider), runtimePath: runtimes[provider] || '',
      nodePath, model: 'fixture', baseUrl: origin + '/' + provider + '/v1', credentialConfigured: providers.includes(provider),
      executionMode: 'native-permissions', revision: 1}),
    identity: provider => 'synthetic-concurrency-' + provider,
    resolveCredential: provider => { assert.ok(providers.includes(provider)); return {apiKey: secret, baseUrl: origin + '/' + provider + '/v1'}; },
    configure() { throw new Error('Runtime configuration is immutable in this acceptance'); }
  };
  services = createCetaMeshServices({stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
    agentStagingRoot: staging, agentRuntimeConfiguration: configuration,
    providerSecrets: {list: () => [], raw() { throw new Error('Paid credentials forbidden in CLI concurrency acceptance'); }},
    deferOptionalStart: true, log: () => {},
    agentAcpOptions: {runtimeOptions: {profileParent: profiles, allowLoopbackHttpForTests: true},
      launchFactory: options => createAcpProcessLauncher({...options, spawnImpl: (...args) => {
        assert.equal(JSON.stringify(args[1]).includes(secret), false);
        let row;
        if (args[2].cwd.startsWith(staging + path.sep)) {
          const content = fs.readFileSync(path.join(args[2].cwd, 'input.txt'), 'utf8');
          const provider = args[2].env.QWEN_HOME ? 'qwen' : 'opencode';
          row = [...rows.values()].find(item => item.provider === provider && !item.stage && inputByProvider[provider] === content);
          assert.ok(row, 'each actual CLI launch belongs to one prepared Task');
          row.stage = args[2].cwd;
        }
        const child = spawn(...args);
        owned.push({child, taskId: row?.taskId ?? null, startedAt: stamp()});
        if (row) {
          row.pid = child.pid;
          let buffer = '';
          child.stdout.on('data', chunk => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              try {
                const update = JSON.parse(line)?.params?.update;
                const output = update?.rawOutput ?? update?.content;
                if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)
                  && ['completed', 'failed'].includes(update.status) && output !== undefined) {
                  const encoded = JSON.stringify(output);
                  const markerObserved = JSON.stringify({rawOutput: update.rawOutput, content: update.content}).includes(row.marker);
                  if (markerObserved) row.nativeSawMarker = true;
                  evidence.nativeResults.push({taskId: row.taskId, provider: row.provider, at: stamp(),
                    toolCallId: update.toolCallId, status: update.status, resultSha256: hash(encoded),
                    contentSha256: update.content === undefined ? null : hash(JSON.stringify(update.content)), unseenMarkerObserved: markerObserved});
                }
              } catch { /* Production JSON-RPC transport validates protocol data. */ }
            }
          });
        }
        return child;
      }})}
  });
  const originalSend = services.agentBroker.send.bind(services.agentBroker);
  services.agentBroker.send = async request => {
    const row = {provider: request.provider, sessionId: request.sessionId, startedAt: stamp()};
    evidence.dispatches.push(row);
    const result = await originalSend(request);
    Object.assign(row, {acceptedAt: stamp(), accepted: result.accepted === true,
      nativeRequestId: result.requestId ?? result.turnId ?? null});
    return result;
  };
  const originalClose = services.agentBroker.closeSession.bind(services.agentBroker);
  services.agentBroker.closeSession = async assignment => {
    const row = [...rows.values()].find(item => item.provider === assignment.provider && item.sessionId === assignment.sessionId);
    const snapshot = row ? task(row.taskId) : null;
    const observed = {provider: assignment.provider, sessionId: assignment.sessionId, taskId: row?.taskId ?? null,
      startedAt: stamp(), taskStatusBeforeClose: snapshot?.status ?? null,
      assignmentRetainedBeforeClose: snapshot?.currentAgent?.sessionId === assignment.sessionId,
      workspaceOwnerBeforeClose: row ? services.taskService.runtime.activeWorkspaceOwner({workspaceId: row.workspaceId})?.id ?? null : null};
    evidence.closes.push(observed);
    try {
      const result = await originalClose(assignment);
      observed.closed = result?.closed === true && result.sessionId === assignment.sessionId;
      const childProcess = owned.find(item => item.taskId === row?.taskId)?.child;
      observed.processCloseObserved = Boolean(childProcess && (childProcess.exitCode !== null || childProcess.signalCode !== null));
      return result;
    } catch (error) { observed.code = error.code; throw error; }
    finally { observed.finishedAt = stamp(); }
  };
  for (const provider of providers) {
    const health = await services.agentBroker.health(provider);
    assert.equal(health.taskEligible, true, 'verified installed CLI native policy required: ' + provider);
    assert.equal(health.authVerified, false, 'synthetic configured key is not authenticated account evidence');
    evidence.providers[provider] = {version: health.version, taskEligible: health.taskEligible,
      authVerified: health.authVerified, authentication: health.authentication,
      workspaceBoundary: services.agentBroker.capabilities(provider).workspaceBoundary};
  }

  // The shared-Workspace child fence remains authoritative before any dispatch.
  const boundaryProject = path.join(root, 'boundary'); fs.mkdirSync(boundaryProject);
  fs.writeFileSync(path.join(boundaryProject, 'input.txt'), 'boundary input');
  const boundaryWorkspace = (await services.workspaceService.execute({method: 'workspace.create',
    params: {root: boundaryProject, name: 'External child admission boundary'}})).workspace;
  const parent = services.taskService.runtime.create({goal: 'Read only child boundary', workspaceId: boundaryWorkspace.id});
  const child = services.taskService.runtime.createChild({parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'external-concurrency-boundary-child', goal: 'Read input.txt', workspaceId: boundaryWorkspace.id,
    contract: {mode: 'read-only', outputKind: 'analysis', readScope: ['input.txt'], expectedEvidence: ['filesystem.read']}});
  for (const provider of providers) {
    const before = evidence.dispatches.length;
    await assert.rejects(cap('capability.execute', {capability: 'agent.run', taskId: child.id,
      workspaceId: boundaryWorkspace.id, requestId: 'external-child-' + provider,
      input: {agentProvider: provider, content: 'Read input.txt'}}), {code: 'AGENT_READ_ONLY_BOUNDARY_UNVERIFIED'});
    assert.equal(evidence.dispatches.length, before);
    assert.equal(task(child.id).attempts.length, 0);
    evidence.boundaries.push({provider, code: 'AGENT_READ_ONLY_BOUNDARY_UNVERIFIED', dispatches: 0, attempts: 0});
  }

  createBarrier('structural');
  const structural = [];
  for (const provider of providers) structural.push(await prepare('structural', provider, {barrier: 'structural', modelDelayMs: 100}));
  await Promise.all(structural.map(start));
  await Promise.all(structural.map(finish));
  const overlap = proof(structural, 'actual CLI structural concurrency', true);
  assert.ok(overlap.requestOverlapMs > 0, 'actual CLI HTTP request intervals overlap');
  assert.ok(overlap.runOverlapMs > 0, 'production current-run intervals overlap');
  structural.forEach(recordRow);
  await closePair(structural);

  const benchmark = {sampleSizePerMode: 1, taskCountPerMode: 2, perRequestDelayMs: 600,
    barrier: false, approvalsPerMode: 2, cost: null, measuredScope: 'dispatch-to-observed-turn-end including native startup and exact approval'};
  for (const mode of ['serial', 'parallel']) {
    const pair = [];
    for (const provider of providers) pair.push(await prepare('benchmark-' + mode, provider, {modelDelayMs: benchmark.perRequestDelayMs}));
    const started = Date.now();
    if (mode === 'serial') for (const row of pair) { await start(row); await finish(row); }
    else { await Promise.all(pair.map(start)); await Promise.all(pair.map(finish)); }
    benchmark[mode] = {elapsedMs: Date.now() - started, successfulReadTurns: pair.length,
      modelRequests: evidence.requests.filter(row => row.case === 'benchmark-' + mode).length,
      inputHashes: pair.map(row => row.originalHashes['input.txt'])};
    proof(pair, 'benchmark-' + mode, false);
    pair.forEach(recordRow);
    await closePair(pair);
  }
  assert.deepEqual(benchmark.serial.inputHashes, benchmark.parallel.inputHashes);
  assert.equal(benchmark.serial.modelRequests, benchmark.parallel.modelRequests);
  benchmark.observedSpeedup = benchmark.serial.elapsedMs / benchmark.parallel.elapsedMs;
  evidence.benchmark = benchmark;

  createBarrier('cancellation');
  const cancelledPair = [];
  for (const provider of providers) cancelledPair.push(await prepare('cancellation', provider, {barrier: 'cancellation', modelDelayMs: 100}));
  await Promise.all(cancelledPair.map(start));
  const [cancelled, survivor] = cancelledPair;
  const stale = await pendingRead(cancelled);
  await pendingRead(survivor);
  const beforeCancel = taskSnapshot(task(cancelled.taskId));
  const cancellation = await ui('ui.task.cancel', {id: cancelled.taskId, expectedRev: task(cancelled.taskId).rev,
    reason: 'Isolated acceptance cancels only this exact native Task'});
  assert.equal(cancellation.task.status, 'cancelled');
  const closeProof = evidence.closes.find(item => item.provider === cancelled.provider && item.sessionId === cancelled.sessionId);
  assert.equal(closeProof?.closed, true, 'Task cancellation requires the actual native close receipt');
  assert.equal(closeProof.processCloseObserved, true, 'owned runtime process must exit before Task cancellation completes');
  assert.equal(closeProof.assignmentRetainedBeforeClose, true);
  assert.equal(closeProof.workspaceOwnerBeforeClose, cancelled.taskId, 'Task retains Workspace ownership until native close');
  await assert.rejects(services.agentBroker.status({provider: cancelled.provider, sessionId: cancelled.sessionId}),
    {code: 'SESSION_NOT_FOUND'}, 'missing Session is observed only after the exact native close receipt');
  let staleCode;
  await assert.rejects(decide(stale.id, true), error => { staleCode = error.code; return Boolean(error.code); });
  const survivorStatus = await services.agentBroker.status({provider: survivor.provider, sessionId: survivor.sessionId});
  assert.equal(survivorStatus.running, true, 'sibling native Session continues after the other cancellation');
  await finish(survivor);
  assert.equal(cancelled.nativeSawMarker, false, 'cancelled pending read did not execute');
  assertSource(cancelled);
  cancelled.finishedAt = stamp(); cancelled.snapshot = taskSnapshot(task(cancelled.taskId));
  const beforeReplay = evidence.dispatches.length;
  let replayCode;
  await assert.rejects(services.agentBroker.send({provider: cancelled.provider, sessionId: cancelled.sessionId,
    content: 'Do not replay the cancelled native turn'}), error => { replayCode = error.code; return error.code === 'TASK_NOT_AUTHORIZED'; });
  assert.equal(evidence.dispatches.length, beforeReplay + 1, 'passive observer saw the refused call');
  assert.equal(evidence.dispatches.at(-1).accepted, undefined, 'cancelled Task cannot authorize another native turn');
  evidence.failureRecovery = {kind: 'explicit Owner cancellation of a pending native read',
    cancelledTaskId: cancelled.taskId, survivorTaskId: survivor.taskId, beforeCancel,
    cancelled: cancelled.snapshot, survivor: survivor.snapshot, staleApprovalCode: staleCode, replayCode,
    closeProof,
    survivorCompleted: true, cancelledReadExecuted: false, sourceUnchanged: true,
    recoveryStatus: 'actual owned native process close observed before Task cancellation; cancelled Task rejects new dispatch'};
  cancelledPair.forEach(recordRow);
  await closePair(cancelledPair);
  assert.equal(serverFailure, null);
  passed = true; evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL';
  evidence.failure = {code: String(error.code || error.name).slice(0, 160), message: String(error.message).slice(0, 2500)};
  if (services) evidence.currentTasks = [...rows.values()].map(row => taskSnapshot(task(row.taskId)));
  process.exitCode = 1;
} finally {
  for (const barrier of barriers.values()) barrier.release();
  if (services) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent',
    'capabilityService', 'pluginCenterService', 'extensionService', 'channelService', 'bionicService', 'simulationService', 'meshService']) {
    try { await services[name]?.close?.(); }
    catch (error) { (evidence.cleanupErrors ??= []).push({service: name, code: error.code || error.name}); }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  evidence.processes = owned.map(({child, taskId, startedAt}) => ({taskId, pid: child.pid, startedAt,
    exitObserved: child.exitCode !== null || child.signalCode !== null, exitCode: child.exitCode, signal: child.signalCode}));
  try {
    for (const {child} of owned) {
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'each owned runtime close was observed');
      assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
    }
    assert.deepEqual(fs.readdirSync(profiles), [], 'owned profiles cleaned only after observed process close');
    assert.deepEqual(fs.readdirSync(staging), [], 'owned staging cleaned only after observed process close');
  } catch (error) { (evidence.cleanupErrors ??= []).push({service: 'owned-process-proof', code: error.code || error.name}); }
  if (evidence.cleanupErrors?.length) { passed = false; evidence.status = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = stamp();
  evidence.elapsedMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
  if (process.env.CETAMESH_TEST_EVIDENCE_FILE)
    fs.writeFileSync(process.env.CETAMESH_TEST_EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({realCliConcurrencyEvidence: evidence}));
  if (passed) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cetamesh-real-cli-concurrency-'));
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  } else console.log('Retained isolated concurrency state for review: ' + root);
}
