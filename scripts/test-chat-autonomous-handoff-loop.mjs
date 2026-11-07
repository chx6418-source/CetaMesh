import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

const fixtureWorker = fileURLToPath(new URL('./helpers/readonly-handoff-worker.mjs', import.meta.url));
const hash = content => crypto.createHash('sha256').update(content).digest('hex');
async function until(read, matches, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) { value = await read(); if (matches(value)) return value; await delay(10); }
  throw Error('Timed out: ' + label + ': ' + JSON.stringify(value));
}

// Only the model decision and external protocol peer are synthetic. The ordinary
// Chat entry, Core/Broker authorization, process, file reads, Follow and handoffs
// are real. This does not certify a native third-party runtime or an account.
async function scenario(control) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'cetamesh-chat-handoff-loop-'));
  const project = path.join(root, 'project');
  const fixtureContent = 'LOCAL_HANDOFF_PROOF_' + crypto.randomBytes(12).toString('hex');
  const providerId = 'local-readonly-worker', modelProvider = 'local-handoff-model', model = 'fixture';
  const processes = [], approvals = [], modelReads = [], notices = [];
  let services, taskId, candidateResult, modelCalls = 0, sourceCalls = 0, verificationCalls = 0, nativeReadResults = 0;
  try {
    fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'proof.txt'), fixtureContent);
    for (const args of [['init', '-q', project], ['-C', project, 'add', '.'],
      ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']])
      execFileSync('git', args, { stdio: 'ignore' });
    services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
      sourceRoot: root, resourceRoot: root, agentStagingRoot: path.join(root, 'staging'),
      log: text => { if (text.startsWith('Automatic delegation state: ')) notices.push(JSON.parse(text.slice(28))); } });
    services.agentBroker.ids = () => ['cetamesh', providerId];
    services.modelRegistry.register({ id: modelProvider, label: 'Local deterministic decision model', supportsTools: true,
      defaultModel: model, health: async () => ({ configured: true, available: true }), listModels: async () => [{ id: model }],
      chat: async () => { throw Error('Unexpected non-streaming model call'); },
      stream: async function* (request) {
        modelCalls++;
        const instruction = request.messages.filter(row => row.role === 'user').at(-1)?.content ?? '';
        const verifying = instruction.startsWith('Independently verify');
        const step = verifying ? verificationCalls++ : sourceCalls++;
        const results = request.messages.filter(row => row.role === 'tool');
        const call = (id, capabilityId, input) => ({ type: 'assistant/tool-calls', data: { toolCalls: [
          { id, capabilityId, arguments: JSON.stringify(input) }] } });
        if (step === 0) yield call(verifying ? 'independent-read' : 'source-read', 'filesystem.read', { path: 'proof.txt' });
        else if (verifying) {
          const read = JSON.parse(results.find(row => row.tool_call_id === 'independent-read').content);
          assert.equal(read.status, 'completed'); assert.ok(JSON.stringify(read.result).includes(fixtureContent));
          const context = JSON.parse(instruction.split('\n').slice(1).join('\n'));
          assert.equal(context.verificationPlan, null, 'a readonly report must not invent automatic machine acceptance');
          assert.ok(context.externalReport.includes(control === 'deny-tool' ? 'denied' : fixtureContent));
          modelReads.push({ phase: 'verification', sha256: hash(fixtureContent) });
          yield { type: 'assistant/message', data: { message: { content: [{ type: 'text',
            text: control === 'deny-tool' ? 'The external tool was refused; I independently read the file and retained the refusal.' : 'Independent Core read matches the external file evidence: ' + hash(fixtureContent) }] } } };
        } else if (step === 1) {
          const read = JSON.parse(results.find(row => row.tool_call_id === 'source-read').content);
          assert.equal(read.status, 'completed'); assert.ok(JSON.stringify(read.result).includes(fixtureContent));
          modelReads.push({ phase: 'source', sha256: hash(fixtureContent) });
          yield call('discover', 'agent.delegate.candidates', { taskKind: 'analysis', difficulty: 1, requiredTools: [] });
        } else if (step === 2) {
          const candidates = candidateResult = JSON.parse(results.find(row => row.tool_call_id === 'discover').content).result;
          assert.equal(candidates.canPropose, true, JSON.stringify(candidates));
          assert.equal(candidates.candidates.length, 1, 'the model proposes generic needs; Core chooses the executor');
          yield call('propose', 'agent.delegate.propose', { taskKind: 'analysis', difficulty: 1, requiredTools: [],
            instruction: 'Read only proof.txt using the fixed native tool and report its exact content and hash.' });
        } else yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The bounded worker proposal is recorded; awaiting actual handoff.' }] } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: modelProvider, apiKey: 'synthetic-local-only' });
    const worker = createAcpAgentProvider({ descriptor: { id: providerId, label: 'Local fixed-read ACP fixture', protocolVersion: 1, verifiedRuntime: true,
      security: { verified: true, mode: 'native-permissions', nativeSandboxSupported: false, strictIsolationVerified: false,
        nativeApprovalSupported: true, nativePermissionPolicyVerified: true, allToolsRequireApproval: true,
        nativeSandboxMode: 'none', nativeApprovalPolicy: 'every-tool', fixture: true } },
      stagingRoot: path.join(root, 'staging'), excludedRoots: [path.join(root, 'state'), path.join(root, 'data')],
      resolveTaskWorkspace: ({ taskId: id, workspaceId }) => ({ task: services.taskService.runtime.get({ id }).task,
        workspace: services.workspaceService.describeWorkspace(workspaceId) }),
      listWorkspaceRoots: async () => (await services.workspaceService.execute({ method: 'workspace.list' })).workspaces,
      applyChanges: request => services.capabilityService.applyAgentWorkspaceChanges(request),
      requestNativeApproval: (request, options) => services.capabilityService.requestAgentNativeApproval(request, options),
      launch: binding => {
        const child = spawn(process.execPath, [fixtureWorker], { cwd: binding.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
        const record = { pid: child.pid, cwd: binding.cwd, exited: false, frames: 0, userPrompts: 0 }; processes.push(record);
        let buffer = '';
        child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines.filter(Boolean)) { const frame = JSON.parse(line); record.frames++;
            if (frame.params?.update?.rawOutput?.path === 'proof.txt') { nativeReadResults++; assert.equal(frame.params.update.rawOutput.sha256, hash(fixtureContent)); } } });
        const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
          record.exited = true; record.exitCode = code; record.signal = signal; resolve({ code, signal }); }); });
        const handle = { readable: child.stdout, writable: child.stdin, done,
          async close() { child.stdin.end(); await done; } };
        binding.onHandle?.(handle); return handle;
      } });
    services.agentBroker.register({ ...worker,
      capabilities: () => ({ ...worker.capabilities(), assignment: { taskKinds: ['analysis'], tools: [], maxDifficulty: 1,
        estimatedCost: { amount: 0, currency: 'USD', source: 'local-fixture-no-model', agentProvider: providerId, modelProvider, model } } }),
      health: async () => ({ ...(await worker.health()), installed: true, compatible: true, authenticated: true,
        sessionCapable: true, toolsAvailable: true }) });
    const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Local handoff fixture' } })).workspace;
    const scope = services.agentBroker.describeExecutionSecurity(providerId, workspace.id);
    const pending = await services.capabilityService.broker.execute({ actor: OWNER_ACTOR, workspaceId: workspace.id,
      capability: 'agent.execution.authorize', input: { provider: providerId, fingerprint: scope.fingerprint }, reason: scope.disclosure.slice(0, 1000) });
    assert.equal(pending.status, 'pending'); assert.equal(processes.length, 0, 'native scope approval precedes process creation');
    await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
    approvals.push({ capability: 'agent.execution.authorize', approved: true });
    const chat = await services.chatService.execute({ method: 'chat.sessions.create', params: {} });
    await services.chatService.execute({ method: 'chat.config.set', params: { id: chat.id,
      config: { mode: 'chat', workspaceId: workspace.id, modelProvider, model } } });
    await services.chatService.execute({ method: 'chat.send', params: { id: chat.id, text: '先读取项目proof.txt，然后交给其它agent完成只读项目分析，再独立核对结果。' } });
    const current = await until(async () => {
      const rows = services.taskService.runtime.list().tasks; taskId = rows[0]?.id;
      for (const approval of services.capabilityService.broker.approvals.list()) {
        if (approval.request?.capability !== 'agent.native.approve') continue;
        const detail = JSON.parse(approval.request.input.nativeDetails);
        assert.equal(detail.action, 'read'); assert.deepEqual(detail.arguments, { path: 'proof.txt' });
        assert.equal(nativeReadResults, 0, 'the child cannot read before the exact native approval');
        const approve = control !== 'deny-tool'; approvals.push({ capability: approval.request.capability, approved: approve });
        await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: approval.id, approve } });
      }
      return taskId ? services.taskService.runtime.get({ id: taskId }).task : null;
    }, row => row && (row.status === 'blocked' || ['needs-review', 'verified', 'unknown', 'blocked'].includes(row.delegationProposal?.state)), 'Managed return and independent verification');
    assert.equal(current.delegationProposal?.state, 'needs-review', JSON.stringify({ candidateResult, proposal: current.delegationProposal, notices }));
    assert.deepEqual(current.agentHistory.map(row => row.provider), ['cetamesh', providerId, 'cetamesh']);
    assert.equal(current.delegationPolicy.allowUnknownCost, false); assert.equal(current.delegationPolicy.used, 1);
    assert.equal(services.continuityService.runtime.history({ taskId }).rollovers.length, 2);
    assert.equal(current.executionEvidence.filter(row => row.source === 'native-result').length, control === 'deny-tool' ? 0 : 1);
    assert.equal(nativeReadResults, control === 'deny-tool' ? 0 : 1);
    assert.deepEqual(modelReads.map(row => row.phase), ['source', 'verification']);
    assert.equal(current.executionEvidence.filter(row => row.capability === 'filesystem.read' && row.status === 'completed').length, 2);
    assert.equal(current.status, 'running', 'uncontracted analysis retains review rather than pretending a report completes the Task');
    assert.equal(services.capabilityService.completionBlocker(taskId), null);
    assert.equal(fs.readFileSync(path.join(project, 'proof.txt'), 'utf8'), fixtureContent);
    const status = await until(() => services.chatService.execute({ method: 'chat.status', params: { id: chat.id } }), value => value.turn === null, 'Chat return');
    assert.equal(status.lastErrorCode, null);
    const history = await until(() => services.chatService.execute({ method: 'chat.history', params: { id: chat.id } }),
      value => value.messages.some(row => row.role === 'assistant' && row.text?.includes(control === 'deny-tool'
        ? 'The external tool was refused' : 'Independent Core read matches')),
      'original Chat receives the actual independent Managed result, beyond the earlier proposal');
    assert.equal(history.messages.filter(row => row.role === 'user').length, 1, 'automatic turns never manufacture new Owner requests');
    assert.equal(history.messages.filter(row => row.role === 'assistant').length, 3, 'each actual source, worker and verification result appears once; bootstrap is not a user answer');
    const evidence = { fixture: true, realModelCalls: 0, paidApiCalls: 0, scenario: control, taskId,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), modelCalls,
      sourceReads: 1, externalReads: nativeReadResults, verificationReads: 1,
      history: current.agentHistory.map(row => ({ provider: row.provider, sessionId: row.sessionId })),
      delegationState: current.delegationProposal.state, taskStatus: current.status,
      approvalDecisions: approvals, externalProcesses: processes.map(({ pid, frames }) => ({ pid, frames })), notices };
    if (process.env.CETAMESH_HANDOFF_EVIDENCE_DIR) { fs.mkdirSync(process.env.CETAMESH_HANDOFF_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.CETAMESH_HANDOFF_EVIDENCE_DIR, 'chat-loop-' + control + '.json'), JSON.stringify(evidence, null, 2)); }
    console.log('PASS ordinary Chat -> actual ACP process -> ' + (control === 'deny-tool' ? 'exact native refusal, zero external reads' : 'approved fixed-file native read') + ' -> Managed independent Core read; Owner result review retained');
  } finally {
    if (services) for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
    assert.ok(processes.every(row => row.exited), 'all owned test processes must exit');
    assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('cetamesh-chat-handoff-loop-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
await scenario('approve');
await scenario('deny-tool');

async function followProjectionGuards() {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cetamesh-follow-projection-'));
  const queues = new Map(), followed = [], projectedEvents = [], task = { id: 'task', status: 'running', workspaceId: 'workspace',
    currentAgent: { provider: 'opencode', sessionId: 'worker-session' },
    executionObservation: { provider: 'opencode', sessionId: 'worker-session', runId: 'worker-run', state: 'running' },
    delegationProposal: { state: 'awaiting-result', selectedProvider: 'opencode', targetSessionId: 'worker-session' } };
  let service, sequence = 4, holdNextRead, releaseRead, readEntered, releaseRoute;
  const routeGate = new Promise(resolve => { releaseRoute = resolve; });
  const emit = (type, data, sessionId = 'worker-session') => {
    const events = queues.get(sessionId) ?? []; queues.set(sessionId, events);
    events.push({ type, seq: ++sequence, data });
  };
  const event = (type, text, extra = {}) => emit(type, { phase: 'user', runId: 'worker-run', turn: 'worker-turn',
    ...(text ? { message: { content: [{ type: 'text', text }] } } : {}), ...extra });
  try {
    fs.mkdirSync(path.join(root, 'desktop-chat'));
    fs.writeFileSync(path.join(root, 'desktop-chat', 'sessions.json'), JSON.stringify({ schemaVersion: 1, sessions: [
      { id: 'chat', title: 'Projection fixture', taskId: task.id, createdAt: 1, updatedAt: 1,
        config: { provider: 'dsh', model: '', modelProvider: null, reasoning: '', mode: 'chat', agentProvider: null, workspaceId: 'workspace' } }] }));
    service = createChatService({ stateDir: root, onEvent: event => projectedEvents.push(event),
      agentProviders: ['opencode', 'cetamesh'].map(id => ({ id, label: id, eventProtocol: 'agent-turn-events-v1' })),
      resolveTask: async () => { if (holdNextRead) { holdNextRead = false; readEntered(); await new Promise(resolve => { releaseRead = resolve; }); } return structuredClone(task); },
      platformRoute: async () => { await routeGate; task.executionObservation.runId = 'new-user-run';
        return { kind: 'agent', taskId: task.id, provider: 'opencode', sessionId: task.currentAgent.sessionId, accepted: true,
          requestId: 'new-native-request', turnId: 'new-native-turn' }; },
      agentExecute: async () => ({ cancelled: true }),
      agentFollow: async function* ({ sessionId, sinceSequence, signal }) {
        followed.push({ sessionId, sinceSequence }); let cursor = sinceSequence;
        while (!signal.aborted) { const next = (queues.get(sessionId) ?? []).find(row => row.seq > cursor);
          if (next) { cursor = next.seq; yield next; } else await delay(1); }
      } });
    const status = () => service.execute({ method: 'chat.status', params: { id: 'chat' } });
    const history = () => service.execute({ method: 'chat.history', params: { id: 'chat' } });
    await service.synchronizeTaskAssignment({ taskId: task.id, ...task.currentAgent, sinceSequence: 4 });
    event('turn/start', null, { phase: 'bootstrap', runId: 'bootstrap' });
    event('assistant/message', 'BOOTSTRAP_MUST_NOT_DISPLAY', { phase: 'bootstrap', runId: 'bootstrap' });
    event('turn/end', null, { phase: 'bootstrap', runId: 'bootstrap', reason: { kind: 'completed' } });
    event('turn/start', null, { runId: 'stale-run' }); event('assistant/message', 'STALE_MUST_NOT_DISPLAY', { runId: 'stale-run' });
    event('turn/end', null, { runId: 'stale-run', reason: { kind: 'completed' } });
    event('turn/start'); event('turn/start'); event('assistant/message', 'Actual worker result'); event('turn/end', null, { reason: { kind: 'completed' } });
    await until(history, value => value.messages.some(row => row.text === 'Actual worker result'), 'actual worker result');
    assert.equal(followed[0].sinceSequence, 4, 'bootstrap cursor comes from committed Continuity, not a guessed stream position');
    assert.equal((await history()).messages.length, 1, 'duplicate actual starts cannot create another Chat answer');

    // A Task lookup began before a new Owner turn. Its late event must not take
    // over that new pre-ACK route or contribute text to its eventual response.
    const held = new Promise(resolve => { readEntered = resolve; });
    task.executionObservation.runId = 'next-worker-run';
    task.currentAgent.sessionId = 'replacement-worker'; task.executionObservation.sessionId = 'replacement-worker';
    task.delegationProposal.targetSessionId = 'replacement-worker';
    await service.synchronizeTaskAssignment({ taskId: task.id, ...task.currentAgent, sinceSequence: sequence });
    holdNextRead = true;
    emit('turn/start', { phase: 'user', runId: 'next-worker-run', turn: 'next-worker-turn' }, 'replacement-worker');
    await held;
    const accepted = await service.execute({ method: 'chat.send', params: { id: 'chat', text: 'My newer Owner request' } });
    releaseRead();
    emit('assistant/message', { phase: 'user', runId: 'next-worker-run', turn: 'next-worker-turn',
      message: { content: [{ type: 'text', text: 'LATE_MUST_NOT_DISPLAY' }] } }, task.currentAgent.sessionId);
    await delay(20);
    assert.equal((await status()).turn.requestId, accepted.requestId);
    assert.equal((await status()).turn.displayText, '', 'late old events cannot overwrite the new user turn before its dispatch ACK');
    releaseRoute();
    await until(status, value => value.turn?.state === 'streaming', 'new Owner dispatch ACK');
    const nativeSession = task.currentAgent.sessionId;
    emit('turn/start', { phase: 'user', runId: 'new-user-run', requestId: 'new-native-request', turn: 'new-native-turn' }, nativeSession);
    emit('assistant/message', { phase: 'user', runId: 'new-user-run', requestId: 'new-native-request', turn: 'new-native-turn',
      message: { content: [{ type: 'text', text: 'New Owner answer' }] } }, nativeSession);
    emit('turn/end', { phase: 'user', runId: 'new-user-run', requestId: 'new-native-request', turn: 'new-native-turn', reason: { kind: 'completed' } }, nativeSession);
    const final = await until(history, value => value.messages.some(row => row.text === 'New Owner answer'), 'new Owner answer');
    assert.equal(JSON.stringify(final).includes('MUST_NOT_DISPLAY'), false);
    task.currentAgent.sessionId = 'last-worker'; task.executionObservation.sessionId = 'last-worker';
    task.executionObservation.runId = 'last-worker-run'; task.delegationProposal.targetSessionId = 'last-worker';
    await service.synchronizeTaskAssignment({ taskId: task.id, ...task.currentAgent, sinceSequence: sequence });
    emit('turn/start', { phase: 'user', runId: 'last-worker-run', turn: 'last-worker-turn' }, 'last-worker');
    await until(status, value => value.turn?.state === 'streaming', 'old Chat projection still active');
    task.currentAgent = { provider: 'cetamesh', sessionId: 'return-session' };
    task.executionObservation = { ...task.currentAgent, runId: 'return-run', state: 'running' };
    task.delegationProposal = { ...task.delegationProposal, state: 'verifying', returnSessionId: 'return-session' };
    await assert.rejects(service.synchronizeTaskAssignment({ taskId: task.id, ...task.currentAgent }), { code: 'TURN_BUSY' });
    emit('assistant/message', { phase: 'user', runId: 'last-worker-run', turn: 'last-worker-turn',
      message: { content: [{ type: 'text', text: 'Late worker terminal report' }] } }, 'last-worker');
    emit('turn/end', { phase: 'user', runId: 'last-worker-run', turn: 'last-worker-turn', reason: { kind: 'completed' } }, 'last-worker');
    await until(() => followed, rows => rows.some(row => row.sessionId === 'return-session'), 'actual old Chat terminal re-synchronizes the committed Task assignment', 1500);
    emit('turn/start', { phase: 'user', runId: 'return-run', requestId: 'return-request' }, 'return-session');
    emit('assistant/message', { phase: 'user', runId: 'return-run', requestId: 'return-request', sessionId: 'return-session',
      message: { content: [{ type: 'text', text: 'Returned Managed report after a delayed old terminal' }] } }, 'return-session');
    emit('turn/end', { phase: 'user', runId: 'return-run', requestId: 'return-request', sessionId: 'return-session', reason: { kind: 'completed' } }, 'return-session');
    await until(history, value => value.messages.some(row => row.text === 'Returned Managed report after a delayed old terminal'), 'delayed original Chat receives final Managed report');
    task.currentAgent.sessionId = 'closing-session'; task.executionObservation.sessionId = 'closing-session';
    task.executionObservation.runId = 'closing-run'; task.delegationProposal.returnSessionId = 'closing-session';
    await service.synchronizeTaskAssignment({ taskId: task.id, ...task.currentAgent, sinceSequence: sequence });
    const closingRead = new Promise(resolve => { readEntered = resolve; }); holdNextRead = true;
    emit('turn/start', { phase: 'user', runId: 'closing-run', requestId: 'closing-request' }, 'closing-session');
    await closingRead; await service.close(); const closedEvents = projectedEvents.length; releaseRead(); await delay(20);
    assert.equal(projectedEvents.length, closedEvents, 'a late readonly Task lookup cannot publish new Chat activity after the service closed');
    console.log('PASS automatic Chat Follow ignores bootstrap, stale and duplicate runs and preserves a newer Owner turn during asynchronous lookup');
  } finally { releaseRead?.(); releaseRoute(); await service?.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); }
}
await followProjectionGuards();
