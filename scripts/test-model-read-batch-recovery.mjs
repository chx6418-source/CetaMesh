import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, call, observeReads, toolId } from './test-model-read-concurrency.mjs';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';

// Inject only the policy decision needed to exercise a genuinely unexpected
// approval. Registry, Broker approval consumption and Workspace IO stay real.
function approvalBroker(paths) {
  return ({ capabilities, workspaceEntry, stateDir }) => {
    const base = createCapabilityPolicy({ resolveWorkspace: id => id === workspaceEntry.id ? workspaceEntry : null });
    return createCapabilityBroker({ stateDir, registry: capabilities.broker.registry, approval: capabilities.broker.approvals,
      policy: { async authorize(request, entry) {
        const decision = await base.authorize(request, entry);
        return { ...decision, approvalRequired: decision.approvalRequired || entry.id === 'filesystem.read' && paths.includes(request.input.path)
          || entry.id === 'filesystem.search' && paths.includes('search:' + request.input.path) };
      } } });
  };
}

let passed = 0, failed = 0;
async function check(name, action) { try { await action(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } }
await check('callback failure occurs after both real read receipts have durably settled', async () => {
  const f = await fixture({ calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
  try {
    const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run({ ...f.options,
      onCapabilityResult() { throw Object.assign(new Error('owned observer failure'), { code: 'OWNED_OBSERVER_FAILURE' }); } }), { code: 'OWNED_OBSERVER_FAILURE' }));
    assert.equal(observed.peak, 2);
    assert.equal(observed.opened, observed.closed);
    const rows = Object.values(f.journal());
    assert.equal(rows.length, 2);
    assert(rows.every(row => row.status === 'completed' && row.settledAt >= row.startedAt));
    const restarted = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.capabilities.broker });
    await assert.rejects(restarted.run(f.options), { code: 'REQUEST_RECOVERY_REQUIRED' });
    assert.equal(f.requests.length, 1, 'lost callback acknowledgement cannot repeat source IO or another model turn');
  } finally { await f.close(); }
});
await check('cancellation waits for actual two-read handle cleanup and blocks following writes/model', async () => {
  const controller = new AbortController();
  const f = await fixture({ calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' }),
    call('write', 'filesystem.write', { path: 'out.txt', content: 'must not write', expectedHash: null })] });
  try {
    const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run({ ...f.options, signal: controller.signal }), { code: 'INVOKE_CANCELLED' }), {
      beforeRead(_row, { rows }) { if (rows.length === 2) controller.abort(); }
    });
    assert.equal(observed.peak, 2);
    assert.equal(observed.opened, observed.closed);
    assert.equal(f.requests.length, 1);
    assert.equal(f.capabilities.broker.approvals.list().length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'out.txt')), false);
    assert.equal(f.journal()[toolId('read-session', 'read-turn', 0, 0)].status, 'failed');
    assert.equal(f.journal()[toolId('read-session', 'read-turn', 0, 1)].status, 'failed');
  } finally { await f.close(); }
});
for (const pendingPath of ['a.txt', 'b.txt']) for (const approve of [true, false]) {
  await check(`unexpected ${pendingPath} approval retains its sibling across restart and ${approve ? 'approval' : 'rejection'}`, async () => {
    const f = await fixture({ createBroker: approvalBroker([pendingPath]), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' }), call('c', 'filesystem.read', { path: 'c.txt' })] });
    try {
      const initial = await observeReads(f.root, () => f.coordinator.run(f.options));
      assert.equal(initial.result.status, 'pending');
      const completedPath = pendingPath === 'a.txt' ? 'b.txt' : 'a.txt';
      assert.deepEqual(initial.rows.map(row => row.path), [completedPath]);
      const restored = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.broker, evidenceStore: f.evidenceStore });
      const approval = f.broker.approvals.get(initial.result.approvalId);
      const resumed = await observeReads(f.root, async () => {
        const decisionResult = await f.broker.decide({ id: approval.id, approve, actor: f.options.actor });
        return restored.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult });
      });
      assert.equal(resumed.result.status, 'completed');
      assert(!resumed.rows.some(row => row.path === completedPath), 'a completed sibling is delivered exactly once and never re-read');
      assert.equal(resumed.rows.filter(row => row.path === pendingPath).length, approve ? 1 : 0);
      assert.equal(resumed.rows.filter(row => row.path === 'c.txt').length, 1);
      const tools = f.requests[1].messages.filter(row => row.role === 'tool');
      assert.deepEqual(tools.map(row => row.tool_call_id), ['a', 'b', 'c']);
      assert.equal(JSON.parse(tools.find(row => row.tool_call_id === completedPath[0]).content).result.content, completedPath === 'a.txt' ? 'alpha' : 'beta');
      await assert.rejects(restored.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult: { status: 'completed' } }), { code: 'APPROVAL_CONTINUATION_NOT_FOUND' });
    } finally { await f.close(); }
  });
}
await check('two unexpected pending siblings cancel the later approval explicitly and never dispatch it on resume', async () => {
  const f = await fixture({ createBroker: approvalBroker(['a.txt', 'b.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
  try {
    const pending = await f.coordinator.run(f.options);
    assert.equal(pending.status, 'pending');
    assert.equal(f.broker.approvals.list().length, 1);
    const second = f.journal()[toolId('read-session', 'read-turn', 0, 1)];
    assert.equal(second.status, 'failed');
    assert.equal(second.code, 'PARALLEL_APPROVAL_CANCELLED');
    const approval = f.broker.approvals.get(pending.approvalId);
    const observed = await observeReads(f.root, async () => {
      const decisionResult = await f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor });
      return f.coordinator.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult });
    });
    assert.equal(observed.result.status, 'completed');
    assert.deepEqual(observed.rows.map(row => row.path), ['a.txt']);
    const tools = f.requests[1].messages.filter(row => row.role === 'tool');
    assert.deepEqual(tools.map(row => row.tool_call_id), ['a', 'b']);
    assert(JSON.stringify(tools[1]).includes('PARALLEL_APPROVAL_CANCELLED'));
  } finally { await f.close(); }
});
await check('a dependent batch resumes its exact pending source and retained sibling before transforms', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { path: 'logs', glob: '*.jsonl' } },
    { id: 'reads', op: 'readEach', from: 'files', pathField: 'path' }, { id: 'rows', op: 'lines', from: 'reads', format: 'jsonl' },
    { id: 'counts', op: 'aggregate', from: 'rows', groupBy: 'code', measures: ['count'] }], output: { from: 'counts' } };
  const f = await fixture({ files: { 'logs/a.jsonl': '{"code":"E1"}\n', 'logs/b.jsonl': '{"code":"E1"}\n{"code":"E2"}\n' },
    createBroker: approvalBroker(['logs/a.jsonl']), calls: [call('batch', 'context.batch', program)] });
  try {
    const initial = await observeReads(f.root, () => f.coordinator.run(f.options));
    assert.equal(initial.result.status, 'pending');
    assert.deepEqual(initial.rows.map(row => row.path).sort(), ['logs/a.jsonl', 'logs/b.jsonl', 'logs/b.jsonl'], 'search performs its own audited content observations before the dependent readEach');
    const approval = f.broker.approvals.get(initial.result.approvalId);
    const restored = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.broker, evidenceStore: f.evidenceStore });
    const observed = await observeReads(f.root, async () => {
      const decisionResult = await f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor });
      return restored.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult });
    });
    assert.equal(observed.result.status, 'completed');
    assert.deepEqual(observed.rows.map(row => row.path), ['logs/a.jsonl']);
    const tool = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
    assert.deepEqual(tool.result.output, [{ code: 'E1', count: 2 }, { code: 'E2', count: 1 }]);
    assert.equal(tool.result.sources.length, 3);
    assert(Object.values(f.journal()).every(row => row.status === 'completed'));
  } finally { await f.close(); }
});
await check('a failed source-evidence write drains and preserves its sibling, then stops before the next model/write', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { query: '.txt' } },
    { id: 'reads', op: 'readEach', from: 'files', pathField: 'path' }], output: { from: 'reads', fields: ['path'] } };
  const f = await fixture({ files: { 'a.txt': 'alpha', 'b.txt': 'beta' }, calls: [call('batch', 'context.batch', program),
    call('write', 'filesystem.write', { path: 'out.txt', content: 'must not run', expectedHash: null })] });
  const put = f.evidenceStore.put;
  f.evidenceStore.put = request => {
    if (request.sourceCapability === 'filesystem.read' && request.sourceInput.path === 'a.txt') throw Object.assign(new Error('owned evidence persistence fault'), { code: 'TOOL_EVIDENCE_PERSIST_FAILED' });
    return put(request);
  };
  try {
    const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run(f.options), { code: 'TOOL_EVIDENCE_PERSIST_FAILED' }));
    assert.equal(observed.opened, observed.closed);
    assert.equal(f.requests.length, 1);
    assert.equal(f.broker.approvals.list().length, 0);
    const rows = Object.values(f.journal()).filter(row => row.parentRequestId && row.capability === 'filesystem.read');
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.itemIndex === 1).status, 'completed');
    assert.equal(f.coordinator.recoveryForSession('read-session').state, 'needs-reconciliation');
  } finally { await f.close(); }
});
await check('revoking live Task grants during accepted reads suppresses their bytes and later writer authority', async () => {
  const f = await fixture({ agent: true, calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' }),
    call('write', 'filesystem.write', { path: 'out.txt', content: 'must not run', expectedHash: null })] });
  let revoked = false;
  try {
    const observed = await observeReads(f.root, () => f.coordinator.run(f.options), { afterRead() {
      if (!revoked) { revoked = true; f.capabilities.grantTask(f.task.id, { capabilities: [] }); }
    } });
    assert.equal(observed.result.status, 'completed');
    assert.equal(observed.opened, observed.closed);
    const tools = f.requests[1].messages.filter(row => row.role === 'tool');
    assert.equal(tools.length, 3);
    assert(tools.every(row => JSON.parse(row.content).code === 'PERMISSION_DENIED'));
    assert(!JSON.stringify(tools).includes('alpha') && !JSON.stringify(tools).includes('beta'));
    assert.equal(f.broker.approvals.list().length, 0);
  } finally { await f.close(); }
});
await check('a bounded retry timeout retains actual drained late settlement and blocks model/writer replay', async () => {
  const f = await fixture({ calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' }),
    call('write', 'filesystem.write', { path: 'out.txt', content: 'must not run', expectedHash: null })] });
  let attempt = 0;
  try {
    const observed = await observeReads(f.root, () => f.coordinator.run(f.options), { holdMs: 170, beforeRead(row) {
      if (row.path === 'a.txt' && attempt++ === 0) throw Object.assign(new Error('owned transient IO fault'), { code: 'EBUSY' });
    } });
    assert.equal(observed.result.code, 'OUTCOME_UNKNOWN');
    assert.equal(observed.opened, observed.closed);
    assert.equal(f.requests.length, 1);
    assert.equal(f.broker.approvals.list().length, 0);
    const receipt = f.journal()[toolId('read-session', 'read-turn', 0, 0) + ':r1'];
    assert.equal(receipt.status, 'outcome-unknown');
    assert.equal(receipt.drainedSettlement.status, 'failed');
    assert.equal(receipt.drainedSettlement.code, 'INVOKE_CANCELLED');
    assert.equal(f.journal()[toolId('read-session', 'read-turn', 0, 1)].status, 'completed');
    assert.equal(f.coordinator.recoveryForSession('read-session').state, 'needs-reconciliation');
  } finally { await f.close(); }
});
await check('readEach gives a later real unknown retry priority over a known failed sibling before writer/model admission', async () => {
  const program = { version: 1, steps: [{ id: 'index', op: 'read', input: { path: 'paths.jsonl' } },
    { id: 'rows', op: 'lines', from: 'index', format: 'jsonl' }, { id: 'files', op: 'readEach', from: 'rows', pathField: 'path' }],
  output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'paths.jsonl': '{"path":"missing.txt"}\n{"path":"a.txt"}\n', 'a.txt': 'alpha' },
    calls: [call('batch', 'context.batch', program), call('writer', 'filesystem.write', { path: 'out.txt', content: 'must not dispatch', expectedHash: null })] });
  let attempts = 0;
  try {
    const delivered = [];
    const observed = await observeReads(f.root, () => f.coordinator.run({ ...f.options, onCapabilityResult(event) {
      if (event.capability === 'filesystem.read') delivered.push([event.input.path, event.result.status]);
    } }), { holdMs: 170, beforeRead(row) {
      if (row.path === 'a.txt' && attempts++ === 0) throw Object.assign(new Error('owned transient IO fault'), { code: 'EBUSY' });
    } });
    assert.equal(observed.result.status, 'partial');
    assert.equal(observed.result.code, 'OUTCOME_UNKNOWN');
    assert.equal(observed.opened, observed.closed);
    assert.deepEqual(delivered, [['paths.jsonl', 'completed'], ['missing.txt', 'denied'], ['a.txt', 'outcome-unknown']]);
    const journal = Object.values(f.journal());
    const missing = journal.find(row => row.batchStepId === 'files' && row.itemIndex === 0);
    const unknown = journal.find(row => row.batchStepId === 'files' && row.itemIndex === 1 && row.status === 'outcome-unknown');
    assert.equal(missing.status, 'failed');
    assert.equal(typeof missing.evidence.id, 'string');
    assert.equal(unknown.code, 'TOOL_RETRY_TIMEOUT');
    assert.deepEqual([unknown.drainedSettlement.status, unknown.drainedSettlement.code], ['failed', 'INVOKE_CANCELLED']);
    assert.equal(typeof unknown.evidence.id, 'string');
    assert.equal(journal.find(row => row.capability === 'context.batch').status, 'outcome-unknown');
    assert(!journal.some(row => row.capability === 'filesystem.write'));
    assert.equal(f.broker.approvals.list().length, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(fs.existsSync(path.join(f.root, 'out.txt')), false);
    assert.equal(f.coordinator.recoveryForSession('read-session').state, 'needs-reconciliation');
  } finally { await f.close(); }
});
await check('a consumed approval cannot replay remaining source calls after a later HTTP failure loses its acknowledgement', async () => {
  const f = await fixture({ createBroker: approvalBroker(['a.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' }), call('c', 'filesystem.read', { path: 'c.txt' })] });
  f.responses.push({ status: 503, body: { error: { message: 'owned local transport failure' } } });
  try {
    const pending = await f.coordinator.run(f.options);
    const approval = f.broker.approvals.get(pending.approvalId);
    const decisionResult = await f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor });
    const first = await observeReads(f.root, () => assert.rejects(f.coordinator.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult })));
    assert.deepEqual(first.rows.map(row => row.path), ['c.txt']);
    const second = await observeReads(f.root, () => assert.rejects(f.coordinator.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult }), { code: 'REQUEST_RECOVERY_REQUIRED' }));
    assert.equal(second.opened, 0);
    assert.equal(f.requests.length, 2);
    assert.equal(f.coordinator.recoveryForSession('read-session').state, 'needs-reconciliation');
  } finally { await f.close(); }
});
await check('a pure Model retry after approval preserves one source delivery and performs no source replay', async () => {
  const f = await fixture({ createBroker: approvalBroker(['a.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' })] });
  f.responses.push({ status: 503, body: { error: { message: 'owned first Model continuation failure' } } });
  try {
    const pending = await f.coordinator.run(f.options);
    const approval = f.broker.approvals.get(pending.approvalId);
    const decisionResult = await f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor });
    const delivered = [];
    const options = { approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult,
      onCapabilityResult: event => { if (event.capability === 'filesystem.read') delivered.push(event.input.path); } };
    await assert.rejects(f.coordinator.resumeApproval(options));
    assert.deepEqual(f.coordinator.pendingTarget(approval.id), { kind: 'chat', sessionId: 'read-session', turnId: 'read-turn' });
    const observed = await observeReads(f.root, () => f.coordinator.resumeApproval(options));
    assert.equal(observed.result.status, 'completed');
    assert.equal(observed.opened, 0);
    assert.deepEqual(delivered, ['a.txt'], 'the retried model does not repeat settled source observers');
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.requests[2].messages.filter(row => row.role === 'tool').map(row => row.tool_call_id), ['a']);
  } finally { await f.close(); }
});
await check('an approval changed during sibling cancellation remains unknown instead of falsely cancelled', async () => {
  const f = await fixture({ createBroker: approvalBroker(['a.txt', 'b.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
  const cancel = f.broker.approvals.cancel;
  f.broker.approvals.cancel = (id, reason) => {
    if (reason === 'parallel-sibling-approval') f.broker.approvals.decide(id, true, f.options.actor);
    return cancel(id, reason);
  };
  try {
    const result = await f.coordinator.run(f.options);
    assert.equal(result.code, 'OUTCOME_UNKNOWN');
    assert.equal(f.requests.length, 1);
    assert.equal(f.coordinator.recoveryForSession('read-session').state, 'needs-reconciliation');
    assert.equal(f.broker.approvals.list().length, 0);
    assert.equal(f.journal()[toolId('read-session', 'read-turn', 0, 1)].status, 'outcome-unknown');
  } finally { await f.close(); }
});
await check('Core restart preserves completed read receipts and uncertain started siblings', async () => {
  for (const statuses of [['started', 'started'], ['completed', 'started']]) {
    const f = await fixture({ calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
    try {
      await f.coordinator.run(f.options);
      const journal = f.journal();
      const keys = [toolId('read-session', 'read-turn', 0, 0), toolId('read-session', 'read-turn', 0, 1)];
      keys.forEach((key, index) => { journal[key].status = statuses[index]; });
      fs.writeFileSync(path.join(f.stateDir, 'model', 'tool-executions.json'), JSON.stringify(journal));
      const restored = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.broker, evidenceStore: f.evidenceStore });
      assert.equal(restored.recoveryForSession('read-session').state, 'needs-reconciliation');
      await assert.rejects(restored.run({ ...f.options, turnId: 'new-turn' }), { code: 'REQUEST_RECOVERY_REQUIRED' });
      assert.equal(f.requests.length, 2);
      assert.equal(JSON.parse(f.journal()[keys[0]].content).result.content, 'alpha');
    } finally { await f.close(); }
  }
});
await check('cancellation after an unexpected pending read cancels its exact approval after sibling drain', async () => {
  const controller = new AbortController();
  const f = await fixture({ createBroker: approvalBroker(['a.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
  try {
    const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run({ ...f.options, signal: controller.signal }), { code: 'INVOKE_CANCELLED' }), {
      beforeRead() { controller.abort(); }
    });
    assert.equal(observed.opened, observed.closed);
    assert.equal(f.broker.approvals.list().length, 0);
    assert(Object.values(f.journal()).every(row => row.status === 'failed'));
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
await check('failed continuation persistence preserves its completed sibling and cancels the unexecuted approval', async () => {
  const f = await fixture({ createBroker: approvalBroker(['a.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.basename(String(target)) === 'tool-continuations.json') throw Object.assign(new Error('owned continuation persistence fault'), { code: 'EPERM' });
    return rename(source, target);
  };
  try {
    const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run(f.options), { code: 'TOOL_CONTINUATION_PERSIST_FAILED' }));
    assert.equal(observed.opened, observed.closed);
    assert.equal(f.broker.approvals.list().length, 0);
    const journal = f.journal();
    assert.equal(journal[toolId('read-session', 'read-turn', 0, 0)].status, 'failed');
    assert.equal(journal[toolId('read-session', 'read-turn', 0, 1)].status, 'completed');
    assert.equal(JSON.parse(journal[toolId('read-session', 'read-turn', 0, 1)].content).result.content, 'beta');
    assert.equal(f.requests.length, 1);
  } finally { fs.renameSync = rename; await f.close(); }
});
await check('a pending search restores the same consumed byte counter through real Broker decide after restart', async () => {
  const program = { version: 1, steps: [{ id: 'warm', op: 'read', input: { path: 'warm.txt', maxBytes: 50000 } },
    { id: 'files', op: 'search', input: { path: 'logs', query: '.jsonl' } },
    { id: 'reads', op: 'readEach', from: 'files', pathField: 'path', maxBytes: 50000 }], output: { from: 'reads', fields: ['path'] } };
  const f = await fixture({ files: { 'warm.txt': 'w'.repeat(50000), 'logs/a.jsonl': 'x'.repeat(100000) },
    createBroker: approvalBroker(['search:logs']), calls: [call('batch', 'context.batch', program)] });
  try {
    const configurations = [];
    const pending = await f.coordinator.run({ ...f.options, onConfiguration: value => configurations.push(value) });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.configurationObservation.stage, 'response');
    const initialObservation = pending.configurationObservation.requestId;
    const approval = f.broker.approvals.get(pending.approvalId);
    const restored = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.broker, evidenceStore: f.evidenceStore });
    const decisionResult = await f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor });
    const resumed = await restored.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult,
      onConfiguration: value => configurations.push(value) });
    assert.equal(resumed.status, 'completed');
    assert.notEqual(resumed.configurationObservation.requestId, initialObservation);
    assert.deepEqual(resumed.configurationObservation, configurations.at(-1));
    const outer = Object.values(f.journal()).find(row => row.capability === 'context.batch');
    assert.equal(outer.batchReadBytes, 200000, 'warm read + approved search content + dependent read share the retained counter');
  } finally { await f.close(); }
});
await check('a pending search cannot reset an earlier source charge and exceed the total byte budget', async () => {
  const program = { version: 1, steps: [{ id: 'warm', op: 'read', input: { path: 'warm.txt', maxBytes: 50000 } },
    { id: 'files', op: 'search', input: { path: 'logs', query: '.jsonl' } }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'warm.txt': 'w'.repeat(30000), 'logs/a.jsonl': 'x'.repeat(500000) },
    createBroker: approvalBroker(['search:logs']), calls: [call('batch', 'context.batch', program)] });
  try {
    const pending = await f.coordinator.run(f.options);
    const approval = f.broker.approvals.get(pending.approvalId);
    const restored = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.broker, evidenceStore: f.evidenceStore });
    await assert.rejects(f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor }), { code: 'BATCH_BYTE_LIMIT' });
    assert.equal(restored.recoveryForSession('read-session').state, 'needs-reconciliation');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
await check('Broker decide without the bound coordinator explicitly refuses a pending batch source before IO', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { path: 'logs', query: '.jsonl' } }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'logs/a.jsonl': 'owned bytes' }, createBroker: approvalBroker(['search:logs']), calls: [call('batch', 'context.batch', program)] });
  try {
    const pending = await f.coordinator.run(f.options);
    const unbound = createCapabilityBroker({ registry: f.broker.registry, approval: f.broker.approvals,
      policy: createCapabilityPolicy({ resolveWorkspace: () => f.workspaceEntry }) });
    const observed = await observeReads(f.root, () => assert.rejects(unbound.decide({ id: pending.approvalId, approve: true, actor: f.options.actor }), { code: 'BATCH_CONTEXT_UNAVAILABLE' }));
    assert.equal(observed.opened, 0);
    assert.equal(f.broker.approvals.get(pending.approvalId).status, 'pending');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
await check('restart with an interrupted quota admission refuses the old source rather than resetting its counter', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { path: 'logs', query: '.jsonl' } }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'logs/a.jsonl': 'owned bytes' }, createBroker: approvalBroker(['search:logs']), calls: [call('batch', 'context.batch', program)] });
  try {
    const pending = await f.coordinator.run(f.options);
    const file = path.join(f.stateDir, 'model', 'tool-continuations.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const batch = stored[pending.approvalId].state.pendingBatch;
    batch.readBytes = 12345;
    batch.quotaInFlight = { requestId: batch.current.pending.requestId, at: Date.now() };
    fs.writeFileSync(file, JSON.stringify(stored));
    const restored = createToolExecutionCoordinator({ stateDir: f.stateDir, modelRuntime: f.modelRuntime, capabilityBroker: f.broker, evidenceStore: f.evidenceStore });
    assert.equal(restored.recoveryForSession('read-session').state, 'needs-reconciliation');
    const observed = await observeReads(f.root, () => assert.rejects(f.broker.decide({ id: pending.approvalId, approve: true, actor: f.options.actor }), { code: 'BATCH_CONTEXT_UNAVAILABLE' }));
    assert.equal(observed.opened, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[pending.approvalId].state.pendingBatch.readBytes, 12345);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
for (const changedCancellation of [false, true]) {
  await check(`completed sibling observer failure settles its pending approval${changedCancellation ? ' with an unknown cancellation fence' : ''}`, async () => {
    const f = await fixture({ createBroker: approvalBroker(['b.txt']), calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })] });
    if (changedCancellation) {
      const cancel = f.broker.approvals.cancel;
      f.broker.approvals.cancel = (id, reason) => { f.broker.approvals.decide(id, true, f.options.actor); return cancel(id, reason); };
    }
    try {
      const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run({ ...f.options,
        onCapabilityResult(event) { if (event.input?.path === 'a.txt') throw Object.assign(new Error('owned observer failure'), { code: 'OWNED_OBSERVER_FAILURE' }); }
      }), { code: 'OWNED_OBSERVER_FAILURE' }));
      assert.equal(observed.opened, observed.closed);
      assert.equal(f.broker.approvals.list().length, 0, 'an exceptional finalizer cannot strand an actionable sibling approval');
      const pendingRow = f.journal()[toolId('read-session', 'read-turn', 0, 1)];
      assert.equal(f.coordinator.pendingTarget(pendingRow.approvalId), null);
      assert.equal(pendingRow.status, changedCancellation ? 'outcome-unknown' : 'failed');
      assert.equal(f.coordinator.recoveryForSession('read-session')?.state ?? null, changedCancellation ? 'needs-reconciliation' : null);
      assert.equal(f.journal()[toolId('read-session', 'read-turn', 0, 0)].status, 'completed');
      assert.equal(f.requests.length, 1);
    } finally { await f.close(); }
  });
}
await check('a nested source activity failure with uncertain sibling cancellation stops before another model or writer', async () => {
  const program = { version: 1, steps: [{ id: 'index', op: 'read', input: { path: 'paths.jsonl' } },
    { id: 'rows', op: 'lines', from: 'index', format: 'jsonl' }, { id: 'files', op: 'readEach', from: 'rows', pathField: 'path' }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'paths.jsonl': '{"path":"a.txt"}\n{"path":"b.txt"}\n', 'a.txt': 'alpha', 'b.txt': 'beta' },
    createBroker: approvalBroker(['b.txt']), calls: [call('batch', 'context.batch', program), call('write', 'filesystem.write', { path: 'out.txt', content: 'must not run', expectedHash: null })] });
  const cancel = f.broker.approvals.cancel;
  f.broker.approvals.cancel = (id, reason) => { f.broker.approvals.decide(id, true, f.options.actor); return cancel(id, reason); };
  let reads = 0;
  try {
    const observed = await observeReads(f.root, () => assert.rejects(f.coordinator.run({ ...f.options, onActivity(event) {
      if (event.capability === 'filesystem.read' && event.status === 'running' && ++reads === 2) {
        throw Object.assign(new Error('owned source activity failure'), { code: 'OWNED_SOURCE_ACTIVITY_FAILURE' });
      }
    } }), { code: 'OWNED_SOURCE_ACTIVITY_FAILURE' }));
    assert.equal(observed.opened, observed.closed);
    assert.equal(f.requests.length, 1);
    assert.equal(f.coordinator.recoveryForSession('read-session').state, 'needs-reconciliation');
    assert(!Object.values(f.journal()).some(row => row.capability === 'filesystem.write'));
  } finally { await f.close(); }
});
await check('readEach failure cancels a later pending sibling and delivers both source receipts before stopping', async () => {
  const program = { version: 1, steps: [{ id: 'index', op: 'read', input: { path: 'paths.jsonl' } },
    { id: 'rows', op: 'lines', from: 'index', format: 'jsonl' }, { id: 'files', op: 'readEach', from: 'rows', pathField: 'path' }], output: { from: 'files', fields: ['path'] } };
  const f = await fixture({ files: { 'paths.jsonl': '{"path":"missing.txt"}\n{"path":"b.txt"}\n', 'b.txt': 'beta' },
    createBroker: approvalBroker(['b.txt']), calls: [call('batch', 'context.batch', program)] });
  try {
    const sources = [];
    const observed = await observeReads(f.root, () => f.coordinator.run({ ...f.options, onCapabilityResult(event) {
      if (event.capability === 'filesystem.read') sources.push([event.input.path, event.result.status]);
    } }));
    assert.equal(observed.result.status, 'completed');
    assert.equal(f.broker.approvals.list().length, 0);
    const pending = Object.values(f.journal()).find(row => row.batchStepId === 'files' && row.itemIndex === 1);
    assert.equal(pending.status, 'failed');
    assert.equal(f.coordinator.pendingTarget(pending.approvalId), null);
    assert.equal(f.coordinator.recoveryForSession('read-session'), null);
    assert.deepEqual(sources, [['paths.jsonl', 'completed'], ['missing.txt', 'denied'], ['b.txt', 'cancelled']]);
    assert.equal(observed.rows.some(row => row.path === 'b.txt'), false);
  } finally { await f.close(); }
});
await check('rejecting a batch pending source delivers its held completed sibling once before stopping transforms', async () => {
  const program = { version: 1, steps: [{ id: 'files', op: 'search', input: { path: 'logs', glob: '*.jsonl' } },
    { id: 'reads', op: 'readEach', from: 'files', pathField: 'path' }, { id: 'rows', op: 'lines', from: 'reads', format: 'jsonl' },
    { id: 'counts', op: 'aggregate', from: 'rows', measures: ['count'] }], output: { from: 'counts' } };
  const f = await fixture({ files: { 'logs/a.jsonl': '{"code":"A"}\n', 'logs/b.jsonl': '{"code":"B"}\n' },
    createBroker: approvalBroker(['logs/a.jsonl']), calls: [call('batch', 'context.batch', program)] });
  try {
    const pending = await f.coordinator.run(f.options);
    const approval = f.broker.approvals.get(pending.approvalId);
    const decisionResult = await f.broker.decide({ id: approval.id, approve: false, actor: f.options.actor });
    const delivered = [];
    const observed = await observeReads(f.root, () => f.coordinator.resumeApproval({ approvalId: approval.id,
      requestFingerprint: approval.fingerprint, decisionResult, onCapabilityResult(event) {
        if (event.capability === 'filesystem.read') delivered.push([event.input.path, event.result.status]);
      } }));
    assert.equal(observed.result.status, 'completed');
    assert.equal(observed.opened, 0, 'retained sibling delivery does not re-read either source');
    assert.deepEqual(delivered, [['logs/a.jsonl', 'denied'], ['logs/b.jsonl', 'completed']]);
    const outer = Object.values(f.journal()).find(row => row.capability === 'context.batch');
    assert(!outer.batchTransforms, 'rejection stops before dependent lines/aggregate');
    assert.equal(f.coordinator.recoveryForSession('read-session'), null);
  } finally { await f.close(); }
});
for (const batch of [false, true]) {
  await check(`approved ${batch ? 'batch' : 'ordinary'} read joins the same width-two gate and drains its actual handle`, async () => {
    const program = { version: 1, steps: [{ id: 'file', op: 'read', input: { path: 'a.txt' } }], output: { from: 'file', fields: ['path'] } };
    const f = await fixture({ createBroker: approvalBroker(['a.txt']), calls: [batch ? call('batch', 'context.batch', program) : call('a', 'filesystem.read', { path: 'a.txt' })] });
    let releaseOthers, releaseApproved, bothStarted, approvedStarted;
    const othersGate = new Promise(resolve => { releaseOthers = resolve; });
    const approvedGate = new Promise(resolve => { releaseApproved = resolve; });
    const started = new Promise(resolve => { bothStarted = resolve; });
    const thirdStarted = new Promise(resolve => { approvedStarted = resolve; });
    let count = 0, thirdEntered = false, decided = false;
    try {
      const pending = await f.coordinator.run(f.options);
      const approval = f.broker.approvals.get(pending.approvalId);
      f.responses.push([call('b', 'filesystem.read', { path: 'b.txt' }), call('c', 'filesystem.read', { path: 'c.txt' })]);
      const observed = await observeReads(f.root, async () => {
        let otherTurn, decision;
        try {
          otherTurn = f.coordinator.run({ ...f.options, sessionId: 'other-session', turnId: 'other-turn' });
          await started;
          decision = f.broker.decide({ id: approval.id, approve: true, actor: f.options.actor });
          decision.then(() => { decided = true; }, () => { decided = true; });
          await Promise.race([thirdStarted, new Promise(resolve => setTimeout(resolve, 50))]);
          assert.equal(thirdEntered, false, 'the approved source waits while two actual read promises remain unsettled');
          assert.equal(decided, false);
          releaseOthers();
          await thirdStarted;
          assert.equal(decided, false, 'approval completion must await the actual accepted read');
          releaseApproved();
          const result = await decision;
          await otherTurn;
          return result;
        } finally {
          releaseOthers(); releaseApproved();
          await Promise.allSettled([otherTurn, decision].filter(Boolean));
        }
      }, { holdMs: 0, afterRead(row) {
        if (row.path === 'a.txt') { thirdEntered = true; approvedStarted(); return approvedGate; }
        if (++count === 2) bothStarted();
        return othersGate;
      } });
      assert.equal(observed.result.status, 'completed');
      assert.equal(observed.peak, 2);
      assert.equal(observed.opened, observed.closed);
      const resumed = await f.coordinator.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult: observed.result });
      assert.equal(resumed.status, 'completed');
    } finally { releaseOthers?.(); releaseApproved?.(); await f.close(); }
  });
}
console.log(JSON.stringify({ passed, failed }));
if (failed) process.exitCode = 1;
