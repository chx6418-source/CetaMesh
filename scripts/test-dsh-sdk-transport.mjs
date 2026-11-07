import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';
import { createCapabilityService } from '../src/capability/service.js';
import { isAgentCreationPreflightFailure } from '../src/agent/agent-provider.js';
import { permissionFingerprint } from '../src/agent/protocol/agent-permission-bridge.js';

// A DSH notification preceding a reverse request must already be authoritative
// when that request is handled, including frames delivered in one data chunk.
{
  const input = new PassThrough(), output = new PassThrough();
  let observed = 0, response;
  output.on('data', value => { response = JSON.parse(String(value)); });
  let rpc;
  assert.doesNotThrow(() => {
    rpc = createJsonRpcTransport({ readable: input, writable: output, framing: 'dsh-sdk-jsonl',
      onNotification: (_method, params) => { observed = params.value; },
      onRequest: async () => ({ observed }) });
  }, 'DSH uses explicit official JSON-RPC 2.0 framing');
  input.write('{"jsonrpc":"2.0","method":"session.event","params":{"value":42}}\n'
    + '{"jsonrpc":"2.0","id":"approval","method":"approval/request","params":{}}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.jsonrpc, '2.0');
  assert.deepEqual(response.result, { observed: 42 });
  await rpc.close(); input.destroy(); output.destroy();
}

const modulePath = fileURLToPath(new URL('../src/agent/dsh-sdk-transport.js', import.meta.url));
assert.equal(fs.existsSync(modulePath), true, 'the owned DSH SDK Task transport must be available');
const { createDshSdkTaskTransport } = await import('../src/agent/dsh-sdk-transport.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-dsh-sdk-transport-')));
const stateDir = path.join(root, 'state'), stage = path.join(root, 'stage');
fs.mkdirSync(stateDir); fs.mkdirSync(stage); fs.writeFileSync(path.join(root, 'dsh-bin.js'), '// fixture only\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('DSH fixture did not reach the expected state');
}

function setup({ version = '0.2.2-rc.1', approval, terminal = true, mismatch = null, stopKnown = true, failedResult = false,
  delayedTurn = false, toolName = 'read', toolInput = { file_path: 'note.txt' } } = {}) {
  const processes = [], reviews = [], settlements = [];
  const runtime = { version, nodePath: process.execPath, dshBin: path.join(root, 'dsh-bin.js'),
    baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-private-api-key', model: 'fixture-model',
    configuration: { revision: 1 }, validate() {} };
  function launch(options) {
    const readable = new PassThrough(), writable = new PassThrough(), done = deferred();
    const frames = [], pending = new Map(); let incoming = '', seq = 0, closed = false;
    const process = { options, frames, pending, readable, writable, done: done.promise,
      emit(type, data, extra = {}) {
        readable.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: {
          sessionId: options.sessionId, event: { type, seq: seq++, time: Date.now(), data, ...extra }
        } }) + '\n');
      },
      end() { if (closed) return; closed = true; process.ended = true; done.resolve(stopKnown === 'direct-only'
        ? { exitCode: 0, processExitObserved: true } : stopKnown
          ? { exitCode: 0, processExitObserved: true, processTreeExitConfirmed: true }
          : { terminationConfirmed: false, effectStatus: 'unknown' }); },
      close: async () => { process.end(); }
    };
    // Mirror official bootstrap files so later validation rejects an ambient
    // profile replacement instead of blindly trusting initialize.serverInfo.
    const profileDir = path.join(options.profile.homeDir, 'profiles', 'sdk-minimal');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ private: true,
      dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } } }));
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
    writable.on('data', bytes => {
      incoming += String(bytes);
      while (incoming.includes('\n')) {
        const at = incoming.indexOf('\n'), frame = JSON.parse(incoming.slice(0, at)); incoming = incoming.slice(at + 1);
        frames.push(frame);
        if (!frame.method) { pending.get(frame.id)?.(frame.result); pending.delete(frame.id); continue; }
        const result = frame.method === 'initialize'
          ? { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
          : frame.method === 'session/working-directory/get' ? { cwd: stage }
            : frame.method === 'session/prompt' ? { messageId: 'fixture-message' } : {};
        readable.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
        if (frame.method === 'shutdown') process.end();
        if (frame.method === 'session/prompt') {
          const beginTurn = () => {
          process.emit('turn/start', { turn: 1 });
          const raw = typeof toolInput === 'function' ? toolInput(options) : structuredClone(toolInput);
          const callSeq = seq;
          process.emit('tool/call', { turn: 1, step: 1, callId: 'call-1', name: toolName, arguments: JSON.stringify(raw) });
          const reason = JSON.stringify({ format: 'cetamesh-dsh-tool-v1', processNonce: options.processNonce,
            policyFingerprint: options.profile.policyFingerprint, sessionId: options.sessionId,
            callId: 'call-1', toolName, input: mismatch === 'input' ? { file_path: 'other.txt' } : raw });
          if (mismatch !== 'missing-audit') process.emit('approval/asked', { id: 'audit-1', toolName, callId: 'call-1', reason });
          pending.set('ask-1', answer => {
            process.lastAnswer = answer;
            process.emit('approval/decided', { id: 'audit-1', outcome: answer.outcome });
            if (terminal) {
              const forceSuccess = mismatch === 'success-after-rejection';
              const content = [{ type: 'text', text: answer.outcome === 'allowed-once' || forceSuccess ? 'observed fixture content' : 'Error: rejected' }];
              process.emit('tool/result', { turn: 1, step: 1, message: { id: 'result-1', role: 'tool',
                source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content,
                isError: failedResult || answer.outcome !== 'allowed-once' && !forceSuccess } }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
              process.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
              readable.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.status',
                params: { sessionId: options.sessionId, status: 'idle' } }) + '\n');
            }
          });
          readable.write(JSON.stringify({ jsonrpc: '2.0', id: 'ask-1', method: 'approval/request',
            params: { sessionId: options.sessionId, toolName, callId: 'call-1', reason } }) + '\n');
          };
          if (delayedTurn) setImmediate(beginTurn); else beginTurn();
        }
      }
    });
    processes.push(process); return process;
  }
  const provider = createDshSdkTaskTransport({ stateDir, runtimeResolver: async () => runtime, launch,
    requestNativeApproval: async (request, context) => {
      reviews.push({ request, signal: context.signal });
      return approval ? approval(request, context) : { outcome: 'approved', optionId: 'allow',
        nativeEffectId: 'effect-1', inputFingerprint: permissionFingerprint(request.target.rawInput) };
    },
    settleNativeEffect: async input => { settlements.push(input); return { status: input.outcome === 'failed' ? 'outcome-unknown' : input.outcome }; }
  });
  return { provider, processes, reviews, settlements, runtime };
}

let fileCase = 0;
const fileInput = (tool, file_path) => ({ file_path, ...(tool === 'write' ? { content: 'synthetic file content' }
  : tool === 'edit' ? { old_string: 'before', new_string: 'after' } : {}) });
async function startFileCall(h) {
  const id = ++fileCase;
  const session = await h.provider.createSession({ cwd: stage, taskId: `file-task-${id}`, workspaceId: 'file-workspace' });
  await h.provider.send({ sessionId: session.sessionId, content: 'Synthetic file boundary case', runId: `file-run-${id}`, phase: 'user' });
  return session;
}

try {
  {
    const h = setup({ stopKnown: 'direct-only' });
    assert.equal((await h.provider.health()).ready, false, 'direct child exit alone cannot qualify the process-tree boundary');
    await assert.rejects(h.provider.shutdown(), error => error.code === 'PROVIDER_CLOSE_UNKNOWN');
  }
  {
    const h = setup();
    const health = await Promise.all([h.provider.health(), h.provider.health()]);
    assert.equal(health.every(row => row.ready === true), true);
    assert.equal(h.processes.length, 1, 'parallel read-only health requests share one bounded policy probe');
    await h.provider.health();
    assert.equal(h.processes.length, 1, 'fresh verified health evidence is reused after current file verification');
    await h.provider.shutdown();
  }
  {
    const h = setup({ version: '0.1.5-rc.1' });
    assert.equal((await h.provider.health()).taskEligible, false, 'old HTTP runtime cannot acquire SDK tool qualification');
    assert.equal(h.processes.length, 0, 'unsupported runtime never launches');
    await h.provider.shutdown();
  }
  for (const selection of [{ modelProvider: 'anthropic' }, { model: 'another-model' }, { reasoningEffort: 'high' }]) {
    const h = setup();
    const invocation = { cwd: stage, taskId: 'task-unsupported-model-selection', workspaceId: 'workspace-1', ...selection };
    await assert.rejects(h.provider.createSession(invocation), error => error.code === 'AGENT_CONFIGURATION_UNSUPPORTED'
      && isAgentCreationPreflightFailure(error, invocation), 'unsupported Owner model selection must fail in the bound creation preflight');
    assert.equal(h.processes.length, 0, 'unsupported model configuration launches no owned runtime');
    await h.provider.shutdown();
  }
  for (const toolName of ['read', 'write', 'edit']) {
    for (const file of ['note.txt', path.join(stage, 'note.txt')]) {
      const h = setup({ toolName, toolInput: fileInput(toolName, file) });
      await startFileCall(h);
      await until(() => h.processes.at(-1).lastAnswer);
      assert.equal(h.processes.at(-1).lastAnswer.outcome, 'allowed-once', `${toolName} accepts relative and absolute paths inside staging`);
      assert.equal(h.reviews.length, 1);
      assert.deepEqual(h.reviews[0].request.target.rawInput, fileInput(toolName, file), 'scope verification never rewrites the approved native input');
      await until(() => h.settlements.some(row => row.outcome === 'completed'));
      await h.provider.shutdown();
    }
  }
  const outside = path.join(root, 'outside-files'); fs.mkdirSync(outside);
  for (const toolName of ['read', 'write', 'edit']) {
    for (const file of [path.join(outside, 'note.txt'), '../outside-files/note.txt', '\\\\server\\share\\note.txt',
      'note.txt:policy', options => options.profile.gatePath]) {
      const h = setup({ toolName, toolInput: options => fileInput(toolName, typeof file === 'function' ? file(options) : file) });
      await startFileCall(h);
      await until(() => h.processes.at(-1).lastAnswer);
      assert.equal(h.reviews.length, 0, `${toolName} outside/UNC/ADS/control-plane paths never reach Core approval`);
      assert.notEqual(h.processes.at(-1).lastAnswer.outcome, 'allowed-once');
      assert.equal(h.settlements.length, 0, 'pre-approval path refusal creates no native effect');
      await h.provider.shutdown();
    }
  }
  for (const toolInput of [{ path: 'note.txt' }, { file_path: null }, { file_path: 7 }]) {
    const h = setup({ toolInput }); await startFileCall(h);
    await until(() => h.processes.at(-1).lastAnswer);
    assert.equal(h.reviews.length, 0, 'the file scope requires the actual documented file_path string; it never guesses another argument');
    assert.equal(h.settlements.length, 0);
    await h.provider.shutdown();
  }
  const junction = path.join(stage, 'outside-link');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    for (const toolName of ['read', 'write', 'edit']) {
      const h = setup({ toolName, toolInput: fileInput(toolName, 'outside-link/note.txt') });
      await startFileCall(h); await until(() => h.processes.at(-1).lastAnswer);
      assert.equal(h.reviews.length, 0, `${toolName} cannot approve a junction escape`);
      assert.notEqual(h.processes.at(-1).lastAnswer.outcome, 'allowed-once');
      assert.equal(h.settlements.length, 0);
      await h.provider.shutdown();
    }
  } finally { fs.unlinkSync(junction); }
  const inside = path.join(stage, 'inside-target'); fs.mkdirSync(inside);
  for (const toolName of ['read', 'write', 'edit']) {
    const lateLink = path.join(stage, 'late-link');
    fs.symlinkSync(inside, lateLink, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const decision = deferred(), h = setup({ toolName, toolInput: fileInput(toolName, 'late-link/note.txt'), approval: () => decision.promise });
      const session = await startFileCall(h); await until(() => h.reviews.length);
      fs.unlinkSync(lateLink); fs.symlinkSync(outside, lateLink, process.platform === 'win32' ? 'junction' : 'dir');
      decision.resolve({ outcome: 'approved', optionId: 'allow', nativeEffectId: 'late-path-effect',
        inputFingerprint: permissionFingerprint(h.reviews[0].request.target.rawInput) });
      await until(() => h.processes.at(-1).lastAnswer);
      assert.notEqual(h.processes.at(-1).lastAnswer.outcome, 'allowed-once', `${toolName} rechecks the junction after Owner approval`);
      await until(() => h.settlements.some(row => row.nativeEffectId === 'late-path-effect' && row.outcome === 'unknown'));
      await until(() => h.provider.status({ sessionId: session.sessionId }).then(row => row.state === 'unknown'));
      assert.equal(h.settlements.some(row => row.outcome === 'completed'), false);
      await assert.rejects(h.provider.shutdown(), error => error.code === 'PROVIDER_CLOSE_UNKNOWN', 'late denied grants retain their unknown Core effect');
    } finally { fs.unlinkSync(lateLink); }
  }
  {
    const decision = deferred(), h = setup({ approval: () => decision.promise });
    const session = await startFileCall(h); await until(() => h.reviews.length);
    const heldStage = path.join(root, 'held-stage-root'); fs.renameSync(stage, heldStage); fs.mkdirSync(stage);
    try {
      decision.resolve({ outcome: 'approved', optionId: 'allow', nativeEffectId: 'late-root-effect',
        inputFingerprint: permissionFingerprint(h.reviews[0].request.target.rawInput) });
      await until(() => h.processes.at(-1).lastAnswer);
      assert.notEqual(h.processes.at(-1).lastAnswer.outcome, 'allowed-once', 'replacing the canonical staging root cannot inherit its approval');
      await until(() => h.settlements.some(row => row.nativeEffectId === 'late-root-effect' && row.outcome === 'unknown'));
      await until(() => h.provider.status({ sessionId: session.sessionId }).then(row => row.state === 'unknown'));
      await assert.rejects(h.provider.shutdown(), error => error.code === 'PROVIDER_CLOSE_UNKNOWN');
    } finally { fs.rmdirSync(stage); fs.renameSync(heldStage, stage); }
  }
  {
    const h = setup(); const health = await h.provider.health();
    assert.equal(health.ready, true); assert.equal(health.taskEligible, true);
    const securityBefore = h.provider.capabilities().security.policyFingerprint;
    assert.equal(h.provider.capabilities().security.fileScopePolicy, 'task-staging-file-tools-v1');
    assert.ok(h.provider.capabilities().security.securityLimitations.includes('task-staging-file-tools-v1'));
    assert.equal(h.provider.capabilities().taskTransport, 'sdk');
    assert.equal(h.processes.some(p => p.frames.some(f => f.method === 'session/prompt')), false, 'health sends no model input');
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-1', workspaceId: 'workspace-1',
      modelProvider: 'deepseek-official', model: 'fixture-model' });
    assert.equal(h.provider.capabilities().security.policyFingerprint, securityBefore,
      'session nonce and directory never change the Owner consent identity');
    const outcomes = [], turnSettlements = [];
    const task = { id: 'task-1', workspaceId: 'workspace-1', rev: 1, status: 'running',
      currentAgent: { provider: 'dsh', sessionId: session.sessionId },
      executionObservation: { provider: 'dsh', sessionId: session.sessionId, runId: 'core-run-1', phase: 'user', state: 'running' } };
    const consumer = createCapabilityService({ stateDir: path.join(root, 'consumer-state'),
      agentBroker: { capabilities: () => h.provider.capabilities(), follow: args => h.provider.follow(args) },
      taskRuntime: { get: () => ({ task }), update: input => { task.rev++; return task; },
        observeExecution: input => { task.executionObservation = { ...task.executionObservation, ...input }; },
        recordToolOutcome: input => { outcomes.push(input); }, addWork: () => {}, block: () => { task.status = 'blocked'; } },
      onAgentTurnSettled: value => { turnSettlements.push(value); }
    });
    consumer.trackTaskAgent({ taskId: task.id, provider: 'dsh', sessionId: session.sessionId });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'core-run-1', phase: 'user' });
    await until(() => h.settlements.length);
    await until(() => turnSettlements.length);
    assert.equal(outcomes.length, 1, 'real CapabilityService keeps the terminal native result after inserted approval activity');
    assert.equal(turnSettlements[0].outcome, 'completed');
    await consumer.close();
    assert.equal(h.reviews.length, 1);
    assert.deepEqual(h.reviews[0].request.target.rawInput, { file_path: 'note.txt' });
    assert.equal(h.reviews[0].request.taskId, 'task-1'); assert.equal(h.reviews[0].request.workspaceId, 'workspace-1');
    assert.equal(h.reviews[0].request.runId, 'core-run-1'); assert.equal(h.reviews[0].request.trackEffect, true);
    assert.equal(h.settlements[0].nativeEffectId, 'effect-1'); assert.equal(h.settlements[0].outcome, 'completed');
    assert.equal(h.settlements[0].evidence.source, 'native-result');
    assert.match(h.settlements[0].evidence.resultSha256, /^[a-f0-9]{64}$/);
    assert.equal(h.processes.at(-1).lastAnswer.outcome, 'allowed-once');
    const events = [], abort = new AbortController();
    for await (const event of h.provider.follow({ sessionId: session.sessionId, signal: abort.signal })) {
      events.push(event); if (event.event.type === 'turn/end') { abort.abort(); break; }
    }
    assert.equal(events.filter(e => e.event.type === 'tool/result').length, 1, 'only real terminal output emits a normalized tool result');
    assert.equal(events.find(e => e.event.type === 'turn/end').event.data.runId, 'core-run-1');
    assert.equal((await h.provider.status({ sessionId: session.sessionId })).running, false);
    assert.equal((await h.provider.closeSession({ sessionId: session.sessionId })).stopped, true);
    const receipt = await h.provider.verifyStoppedTask({ taskId: 'task-1', workspaceId: 'workspace-1', sessionId: session.sessionId });
    assert.equal(receipt.stopped, true); assert.equal(receipt.provider, 'dsh');
    assert.equal(receipt.transport, 'dsh-sdk'); assert.equal(receipt.runId, 'core-run-1');
    assert.equal((await h.provider.verifyStoppedTask({ taskId: 'other-task', workspaceId: 'workspace-1', sessionId: session.sessionId })).stopped, false);
    const restarted = setup();
    assert.equal((await restarted.provider.verifyStoppedTask({ taskId: 'task-1', workspaceId: 'workspace-1', sessionId: session.sessionId })).stopped, true,
      'Core restart reads the retained exact stop receipt without replaying the Session');
    await restarted.provider.shutdown();
    await assert.rejects(h.provider.resume({ sessionId: 'unowned' }), error => error.code === 'SESSION_NOT_FOUND');
    await h.provider.shutdown();
  }
  for (const mismatch of ['input', 'missing-audit']) {
    const h = setup({ mismatch });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-bad', workspaceId: 'workspace-bad' });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'bad-run', phase: 'user' });
    await until(() => h.processes.at(-1).lastAnswer);
    assert.equal(h.reviews.length, 0, mismatch + ' never reaches Core approval');
    assert.notEqual(h.processes.at(-1).lastAnswer.outcome, 'allowed-once');
    assert.equal(h.settlements.length, 0);
    await h.provider.shutdown();
  }
  {
    const h = setup({ approval: async () => ({ outcome: 'approved', optionId: 'allow',
      nativeEffectId: 'stale-input-effect', inputFingerprint: '0'.repeat(64) }) });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-stale', workspaceId: 'workspace-stale' });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'stale-run', phase: 'user' });
    await until(() => h.processes.at(-1).lastAnswer);
    assert.notEqual(h.processes.at(-1).lastAnswer.outcome, 'allowed-once', 'a Core receipt for different input never releases the runtime');
    await h.provider.shutdown();
  }
  {
    const h = setup({ failedResult: true });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-failed', workspaceId: 'workspace-failed' });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'failed-run', phase: 'user' });
    await until(() => h.settlements.length);
    assert.equal(h.settlements[0].outcome, 'failed');
    await until(() => h.provider.status({ sessionId: session.sessionId }).then(row => row.state === 'unknown'));
    await assert.rejects(h.provider.shutdown(), error => error.code === 'PROVIDER_CLOSE_UNKNOWN');
  }
  {
    const h = setup({ mismatch: 'success-after-rejection', approval: async () => ({ outcome: 'cancelled' }) });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-unapproved', workspaceId: 'workspace-unapproved' });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'unapproved-run', phase: 'user' });
    await until(() => h.processes.at(-1).ended);
    assert.equal(h.settlements.some(row => row.outcome === 'completed'), false,
      'a successful result after rejection cannot create native completion evidence');
    assert.equal((await h.provider.verifyStoppedTask({ taskId: 'task-unapproved', workspaceId: 'workspace-unapproved', sessionId: session.sessionId })).stopped, false,
      'contradictory unapproved success never leaves a recoverable stop receipt');
    const terminal = [];
    for await (const row of h.provider.follow({ sessionId: session.sessionId })) terminal.push(row);
    assert.equal(terminal.some(row => row.event.type === 'turn/end' && row.event.data.reason.kind === 'error'), true,
      'protocol loss ends the Core Follow interval with a bounded error');
    assert.equal(terminal.some(row => row.event.type === 'tool/result' && row.event.data.status === 'completed'), false);
    await assert.rejects(h.provider.shutdown(), error => error.code === 'PROVIDER_CLOSE_UNKNOWN');
  }
  {
    const h = setup({ delayedTurn: true });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-bootstrap', workspaceId: 'workspace-bootstrap' });
    const accepted = await h.provider.send({ sessionId: session.sessionId, content: 'Acknowledge bootstrap context', runId: 'bootstrap-run', phase: 'bootstrap' });
    assert.equal(accepted.turnId ?? null, null, 'the message ACK cannot invent an authoritative native turn id before turn/start');
    await until(() => h.processes.at(-1).lastAnswer);
    assert.equal(h.processes.at(-1).lastAnswer.outcome, 'cancelled');
    assert.equal(h.reviews.length, 0, 'bootstrap context cannot mint a Core tool request before Task assignment');
    assert.equal(h.settlements.length, 0);
    const completion = (async () => {
      for await (const item of h.provider.follow({ sessionId: session.sessionId, signal: AbortSignal.timeout(3000) })) {
        const event = item.event;
        if (event.type !== 'turn/end' || accepted.requestId && event.data.requestId && event.data.requestId !== accepted.requestId
          || accepted.turnId && event.data.turn !== accepted.turnId) continue;
        return event;
      }
    })();
    assert.equal((await completion).data.reason.kind, 'completed', 'Fresh Session bootstrap can observe the actual terminal after its early message ACK');
    await h.provider.shutdown();
  }
  {
    const decision = deferred(); const h = setup({ approval: () => decision.promise, terminal: false });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-cancel', workspaceId: 'workspace-cancel' });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'cancel-run', phase: 'user' });
    await until(() => h.reviews.length);
    const cancelled = h.provider.cancel({ sessionId: session.sessionId });
    assert.equal(h.reviews[0].signal.aborted, true, 'cancellation revokes authority synchronously before process waiting');
    decision.resolve({ outcome: 'approved', optionId: 'allow', nativeEffectId: 'late-effect', inputFingerprint: 'b'.repeat(64) });
    assert.equal((await cancelled).stopped, true);
    assert.notEqual(h.processes.at(-1).lastAnswer?.outcome, 'allowed-once');
    assert.equal(h.settlements.some(row => row.outcome === 'completed'), false);
    await h.provider.shutdown();
  }
  {
    const h = setup({ terminal: false });
    const session = await h.provider.createSession({ cwd: stage, taskId: 'task-unknown', workspaceId: 'workspace-unknown' });
    await h.provider.send({ sessionId: session.sessionId, content: 'Read note', runId: 'unknown-run', phase: 'user' });
    await until(() => h.processes.at(-1).lastAnswer);
    assert.equal(h.settlements.length, 0, 'native permit grant is not tool completion');
    await h.provider.cancel({ sessionId: session.sessionId });
    assert.equal(h.settlements[0].outcome, 'unknown', 'missing terminal output retains unknown effect');
    await assert.rejects(h.provider.shutdown(), error => error.code === 'PROVIDER_CLOSE_UNKNOWN', 'unknown effects retain staging after process stop');
  }
  console.log('DSH SDK transport: PASS (official envelopes, staging-only file scope, exact input/audit join, real result settlement and cancellation)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
