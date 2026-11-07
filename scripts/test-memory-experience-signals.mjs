import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRuntime } from '../src/memory/runtime.js';
import { createTaskWorkingMemoryRecorder } from '../src/memory/task-working-memory.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createWorkspaceRegistry } from '../src/workspace/registry.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createIsolatedTestRunner } from '../src/workspace/isolated-runner.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';

const owner = { kind: 'user', id: 'desktop' };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-memory-signals-')));
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }

async function fixture(name, { enabled = true, configured = true, ignoredFirst = false, repeatFailure = false } = {}) {
  const dir = path.join(root, name), stateDir = path.join(dir, 'state'), project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'value.mjs'), 'export const value = 0;\n');
  fs.writeFileSync(path.join(project, 'verify.mjs'), "import assert from 'node:assert/strict'; import {value} from './value.mjs'; assert.equal(value, 2, 'R09_ACTUAL_CURRENT_ASSERTION'); console.log('R09_ACTUAL_CURRENT_PASS');\n");
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node verify.mjs' } }));
  if (ignoredFirst) { fs.mkdirSync(path.join(project, 'node_modules', 'owned-proof'), { recursive: true }); fs.writeFileSync(path.join(project, 'node_modules', 'owned-proof', 'ignored.mjs'), 'export const precondition = 0;\n'); }
  const registry = createWorkspaceRegistry({ file: path.join(stateDir, 'workspaces.json') });
  const workspace = registry.create({ root: project, name: 'Owned experience signal fixture' });
  const ws = createWorkspaceService({ stateDir });
  if (configured) await ws.execute({ method: 'workspace.settings', params: { id: workspace.id, patch: { postWriteVerification: {
    enabled: true, tool: 'npm', args: ['test'], includeExtensions: ['.mjs'], timeoutMs: 30000, maxRunsPerTurn: 2
  } } } });
  const tasks = createTaskRuntime({ stateDir, resolveWorkspace: id => ws.describeWorkspace(id), resolvePostWriteVerification: args => ws.resolvePostWriteVerification(args) });
  let task = tasks.create({ goal: 'Repair only the suite-owned value and retain independent test evidence', workspaceId: workspace.id, acceptanceCriteria: ['Owner reviews the overall result'] });
  task = tasks.start({ id: task.id, expectedRev: task.rev, provider: 'cetamesh', sessionId: 'signal-session' }).task;
  const memory = createMemoryRuntime({ stateDir });
  let memoryEnabled = enabled;
  const recorder = rt => createTaskWorkingMemoryRecorder({ memoryRuntime: rt, taskRuntime: tasks, enabled: () => memoryEnabled,
    resolveWorkspace: id => ws.describeWorkspace(id), resolveExperienceConditions: args => ws.resolvePostWriteVerification(args) });
  const f = { stateDir, project, ws, workspace, tasks, task, memory, recorder: recorder(memory), reopen: () => recorder(createMemoryRuntime({ stateDir })),
    setEnabled: value => { memoryEnabled = value; },
    async owner(text, n = 1) {
      const runId = 'owner-run-' + n, messageId = 'owner-message-' + n;
      tasks.beginExecutionObservation({ id: task.id, provider: 'cetamesh', sessionId: 'signal-session', runId, phase: 'user' });
      const current = tasks.get({ id: task.id }).task;
      tasks.recordOwnerContext({ id: task.id, expectedRev: current.rev, sessionId: 'signal-session', messages: [{ id: messageId, role: 'user', text }] });
      tasks.observeExecution({ id: task.id, provider: 'cetamesh', sessionId: 'signal-session', runId, phase: 'user', state: 'awaiting-review' });
      return { taskId: task.id, trigger: { provider: 'cetamesh', sessionId: 'signal-session', runId, turnId: runId, ownerMessageId: messageId } };
    },
    async repair(n = 1) {
      const runId = n === 1 ? 'repair-run' : 'repair-run-' + n, turnId = n === 1 ? 'repair-turn' : 'repair-turn-' + n;
      const initialHash = sha(fs.readFileSync(path.join(project, 'value.mjs')));
      tasks.beginExecutionObservation({ id: task.id, provider: 'cetamesh', sessionId: 'signal-session', runId, phase: 'user' });
      const caps = createCapabilityService({ stateDir, workspaceService: ws, taskRuntime: tasks,
        isolatedRunner: createIsolatedTestRunner({ resolveWorkspace: id => ws.describeWorkspace(id) }) });
      caps.grantTask(task.id, { capabilities: ['filesystem.read', 'filesystem.write', 'test.run', 'git.diff'] });
      let step = 0;
      const model = { async chat() { const calls = [
        [{ id: 'break', capabilityId: 'filesystem.write', arguments: ignoredFirst
          ? { path: 'node_modules/owned-proof/ignored.mjs', expectedHash: sha('export const precondition = 0;\n'), content: 'export const precondition = 1;\n' }
          : { path: 'value.mjs', expectedHash: initialHash, content: 'export const value = 1;\n' } }],
        [{ id: 'repair', capabilityId: 'filesystem.write', arguments: { path: 'value.mjs', expectedHash: ignoredFirst ? initialHash : sha('export const value = 1;\n'), content: repeatFailure ? 'export const value = 1;\n' : 'export const value = 2;\n' } }],
        []
      ]; return { text: 'Observed fixture facts only', toolCalls: calls[step++] ?? [] }; } };
      const coordinator = createToolExecutionCoordinator({ stateDir, modelRuntime: model, capabilityBroker: caps.broker,
        actorResolver: () => caps.principalForTask(task.id), resolvePostWriteVerification: ({ scope, signal }) => ws.resolvePostWriteVerification({ workspaceId: scope.workspaceId, signal }) });
      const callbacks = { onCapabilityResult({ capability, result, input, eventId }) {
        tasks.recordToolOutcome({ id: task.id, provider: 'cetamesh', sessionId: 'signal-session', runId, phase: 'user',
          eventId, capability, status: result.status, filePath: input?.path, tool: input?.tool, exitCode: result.result?.exitCode });
      } };
      let resumed;
      caps.setApprovalDecisionListener(async event => { resumed = await coordinator.resumeApproval({ ...event, ...callbacks }); return { resumed: resumed.status !== 'pending', pending: resumed.status === 'pending' }; });
      const approvals = [];
      try {
        let result = await coordinator.run({ actor: caps.principalForTask(task.id), sessionId: 'signal-session', turnId, runId, phase: 'user',
          targetKind: 'agent', scope: { taskId: task.id, workspaceId: workspace.id }, messages: [{ role: 'user', content: 'Perform only the fixture repair' }],
          manifest: caps.broker.list().filter(row => row.inputSchema && row.description), ...callbacks });
        while (result.status === 'pending') {
          const request = caps.broker.approvals.get(result.approvalId).request;
          approvals.push(request.capability);
          await caps.execute({ method: 'capability.approval.decide', params: { id: result.approvalId, approve: true } }); result = resumed;
        }
        assert.deepEqual(approvals, ['filesystem.write', 'test.run', 'filesystem.write', 'test.run']);
        const evidence = tasks.get({ id: task.id }).task.executionEvidence.filter(row => row.source === 'core-test' && row.runId === runId);
        assert.deepEqual(evidence.map(row => row.exitCode === 0), [false, !repeatFailure], 'actual controlled npm processes must match the fixed failure/recovery fixture');
        assert.notEqual(evidence[0].operationId, evidence[1].operationId, 'fresh test cannot replay the failed operation');
        // Existing file/postimage verification supplies the machine boundary;
        // no synthetic diff or semantic acceptance is introduced by the fixture.
        tasks.observeExecution({ id: task.id, provider: 'cetamesh', sessionId: 'signal-session', runId, phase: 'user', state: 'awaiting-review' });
        assert.equal((await tasks.verifyOutcome({ id: task.id, kind: 'code', requireCurrentCodeEvidence: true })).status, 'NEEDS_REVIEW');
        return { args: { taskId: task.id, trigger: { provider: 'cetamesh', sessionId: 'signal-session', runId, turnId } }, evidence };
      } finally { coordinator.cancelSession('signal-session', 'owned-fixture-cleanup'); await caps.close(); }
    }
  };
  return f;
}
async function record(recorder, args) {
  assert.equal(typeof recorder.recordExperienceCandidate, 'function', 'Task-owned recorder must offer finite experience candidate processing');
  return recorder.recordExperienceCandidate(args);
}

try {
  await check('real approved failure -> correction -> fresh current pass produces pending conditional experience while Task review remains pending', async () => {
    const f = await fixture('real-repair'), { args, evidence } = await f.repair();
    const result = await record(f.recorder, args);
    assert.equal(result.candidate?.status, 'pending', JSON.stringify(result)); assert.equal(result.candidate.type, 'skill');
    assert.equal(result.candidate.scope, 'workspace:' + f.workspace.id);
    assert.equal(result.candidate.experience.trigger.kind, 'failure-recovery');
    assert.deepEqual(result.candidate.experience.evidence.map(row => row.eventId), evidence.map(row => row.eventId));
    assert.equal(result.candidate.experience.trigger.runId, 'repair-run');
    assert.equal(result.candidate.experience.conditions.tool, 'npm');
    assert.match(result.candidate.content, /reference|参考/i);
    assert.equal(f.memory.retrieve({ principal: owner, scope: result.candidate.scope, query: '' }).memories.length, 0);
    assert.equal(f.tasks.get({ id: f.task.id }).task.status, 'running');
    assert.equal(f.tasks.get({ id: f.task.id }).task.acceptance[0].met, false);
    f.memory.confirmCandidate({ principal: owner, id: result.candidate.id, decision: 'reject' });
    const reopened = f.reopen(); const repeated = await record(reopened, args);
    assert.equal(repeated.duplicate, true); assert.equal(repeated.candidate.status, 'rejected');
    fs.appendFileSync(path.join(f.project, 'value.mjs'), '// changed since passing\n');
    const stale = await record(reopened, { ...args, trigger: { ...args.trigger, turnId: 'later-delivery' } });
    assert.equal(stale.skipped, true); assert.match(stale.code, /CHANGED|UNVERIFIED|STALE/);
  });
  await check('explicit corrections remain attributed Owner statements and durable turn/task budgets include rejected candidates', async () => {
    const f = await fixture('owner', { configured: false });
    const first = await f.owner('更正：这个项目默认使用简洁的中文说明，不要把我的纠正写成机器验证结论。', 1);
    const result = await record(f.recorder, first);
    assert.equal(result.candidate.experience.trigger.kind, 'owner-correction');
    assert.match(result.candidate.content, /Owner|用户/); assert.deepEqual(result.candidate.experience.evidence, []);
    const anotherSignal = f.memory.proposeExperienceCandidate({ type: 'skill', scope: result.candidate.scope,
      content: 'Owner statement: another explicit source in the same bounded turn.', experience: { ...result.candidate.experience,
        trigger: { ...result.candidate.experience.trigger, id: 'f'.repeat(64), ownerMessageId: 'another-owner-message' } } });
    assert.equal(anotherSignal.skipped, true); assert.equal(anotherSignal.code, 'EXPERIENCE_TURN_LIMIT');
    f.memory.confirmCandidate({ principal: owner, id: result.candidate.id, decision: 'reject' });
    assert.equal((await record(f.reopen(), first)).duplicate, true);
    const sameTurn = { ...first, trigger: { ...first.trigger, ownerMessageId: 'not-current-source' } };
    assert.equal((await record(f.recorder, sameTurn)).skipped, true);
    for (const n of [2, 3]) {
      const next = await record(f.recorder, await f.owner('更正：项目说明采用第 ' + n + ' 版条件，请按用户陈述保留。', n));
      assert.equal(next.candidate.status, 'pending'); f.memory.confirmCandidate({ principal: owner, id: next.candidate.id, decision: 'reject' });
    }
    const fourth = await record(f.reopen(), await f.owner('请记住：这个项目采用第四版说明条件。', 4));
    assert.equal(fourth.skipped, true); assert.equal(fourth.code, 'EXPERIENCE_TASK_LIMIT');
    assert.equal(createMemoryRuntime({ stateDir: f.stateDir }).listCandidates({ principal: owner }).candidates.length, 3);
  });
  await check('ordinary prose, secrets, disabled Memory and stale assignment cannot create suggestions', async () => {
    const f = await fixture('non-triggers', { configured: false });
    for (const [n, text] of [[1, '请先检查项目当前状态，然后说明下一步。'], [2, '请记住：API key = sk-private-example-forbidden。'], [3, '更正：我家的住址是敏感内容。']]) {
      assert.equal((await record(f.recorder, await f.owner(text, n))).skipped, true);
    }
    const args = await f.owner('请记住：这个项目所有说明应标出未经验证的条件。', 4);
    f.setEnabled(false); assert.equal((await record(f.recorder, args)).skipped, true);
    assert.equal(f.memory.listCandidates({ principal: owner }).candidates.length, 0);
    f.setEnabled(true);
    assert.equal((await record(f.recorder, { ...args, trigger: { ...args.trigger, runId: 'old-run' } })).skipped, true);
    assert.equal(f.memory.listCandidates({ principal: owner }).candidates.length, 0);
    assert.equal((await record(f.recorder, args)).candidate.status, 'pending', 'ordinary remember remains usable without verifier configuration');
  });
  await check('candidate write failure retains an available retry without creating phantom long-term Memory', async () => {
    const f = await fixture('write-failure', { configured: false }); const args = await f.owner('更正：这个项目的文档建议需要明确标记用户来源。');
    const dir = path.dirname(f.memory._candidatesFile); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(f.memory._candidatesFile);
    await assert.rejects(record(f.recorder, args));
    fs.rmdirSync(f.memory._candidatesFile);
    const result = await record(f.recorder, args); assert.equal(result.candidate.status, 'pending');
    assert.equal(f.memory.countAll(), 0);
  });
  await check('finite detector rejects lost/native/config-mismatched sources and requires distinct verified failure operations', async () => {
    const module = await import('../src/memory/experience-signals.js').catch(() => ({}));
    assert.equal(typeof module.detectExperienceSignals, 'function', 'local signal detector must exist');
    const base = { taskId: 'task', workspaceId: 'workspace', turnId: 'turn', conditions: { workspaceId: 'workspace', platform: process.platform, tool: 'npm', configDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64) },
      ownerTexts: [], priorRunEvidence: [] };
    const receipt = (n, extra = {}) => ({ eventId: 'core-test:' + n, provider: 'cetamesh', sessionId: 'session', runId: 'run', phase: 'user', capability: 'test.run',
      status: 'completed', source: 'core-test', tool: 'npm', operationId: 'test-op-' + n, exitCode: 1, resultSha256: 'c'.repeat(64), at: n,
      postWriteVerification: { configDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64) }, ...extra });
    assert.deepEqual(module.detectExperienceSignals({ ...base, currentRunEvidence: [] }), []);
    assert.deepEqual(module.detectExperienceSignals({ ...base, currentRunEvidence: [receipt(1)] }), []);
    for (const extra of [{ source: 'native-result' }, { status: 'outcome-unknown' }, { exitCode: null }, { postWriteVerification: { configDigest: 'd'.repeat(64), sourceDigest: 'b'.repeat(64) } }, { operationId: 'test-op-1' }]) {
      assert.deepEqual(module.detectExperienceSignals({ ...base, currentRunEvidence: [receipt(1), receipt(2, extra)] }), []);
    }
    const signals = module.detectExperienceSignals({ ...base, currentRunEvidence: [receipt(1), receipt(2)] });
    assert.equal(signals[0].kind, 'repeated-failure'); assert.deepEqual(signals[0].evidence.map(row => row.eventId), ['core-test:1', 'core-test:2']);
    const correction = module.detectExperienceSignals({ ...base, currentRunEvidence: [], ownerTexts: [{ id: 'direct-correction', text: 'Actually, this project uses the fixed verification profile.' }] });
    assert.equal(correction[0]?.kind, 'owner-correction', 'a direct English correction must retain the same attributed-reference semantics');
  });
  await check('later actual current verifier observations are Task-bound, idempotent and never promote a trial', async () => {
    const f = await fixture('later-observation');
    assert.equal(typeof f.recorder.recordExperienceOutcomes, 'function', 'later observations must be derived by the trusted Task recorder');
    const first = await f.repair(); const pending = (await record(f.recorder, first.args)).candidate;
    const row = f.memory.confirmCandidate({ principal: owner, id: pending.id, decision: 'accept' }).memory;
    const later = await f.repair(2);
    const args = { ...later.args, memoryIds: [row.id] };
    const observed = await f.recorder.recordExperienceOutcomes(args);
    assert.equal(observed.results[0].recorded, true);
    const saved = f.memory.get({ principal: owner, id: row.id }).memory;
    assert.equal(saved.experience.state, 'trial'); assert.equal(saved.experience.outcomes.length, 1);
    assert.equal(saved.experience.outcomes[0].eventId, later.evidence[1].eventId);
    await f.reopen().recordExperienceOutcomes(args);
    assert.equal(f.memory.get({ principal: owner, id: row.id }).memory.experience.outcomes.length, 1);
    fs.appendFileSync(path.join(f.project, 'value.mjs'), '// changed after check\n');
    assert.equal((await f.recorder.recordExperienceOutcomes(args)).skipped, true);
  });
  await check('an earlier ignored write remains part of current machine source proof after a later fresh check', async () => {
    const f = await fixture('cumulative-ignored-write', { ignoredFirst: true }); const { args } = await f.repair();
    // Retain the actual preceding per-check receipt format even after the
    // current coordinator starts emitting cumulative bindings. Both original
    // checks and write receipts still came from actual approved Core execution.
    const current = f.tasks.get({ id: f.task.id }).task;
    f.tasks._store.update(current.id, current.rev, draft => {
      const latest = draft.executionEvidence.findLast(row => row.source === 'core-test');
      latest.postWriteVerification.writes = latest.postWriteVerification.writes.filter(row => row.path === 'value.mjs');
      latest.postWriteVerification.sourceWriteIds = latest.postWriteVerification.writes.map(row => row.eventId);
      return draft;
    });
    const before = await f.ws.resolvePostWriteVerification({ workspaceId: f.workspace.id });
    fs.writeFileSync(path.join(f.project, 'node_modules', 'owned-proof', 'ignored.mjs'), 'export const precondition = 9;\n');
    const after = await f.ws.resolvePostWriteVerification({ workspaceId: f.workspace.id });
    assert.equal(after.sourceDigest, before.sourceDigest, 'general Workspace source snapshots deliberately omit generated dependency directories');
    const result = await record(f.recorder, args);
    assert.equal(result.skipped, true, 'experience source proof must recheck every retained current-Run postimage, not only the latest check binding');
    assert.equal(f.memory.listCandidates({ principal: owner }).candidates.length, 0);
  });
  await check('two real failed checks remain useful signals while stale ignored postimages cannot re-propose their experience', async () => {
    const f = await fixture('repeated-failure-source', { ignoredFirst: true, repeatFailure: true }); const { args } = await f.repair();
    const proposal = await record(f.recorder, args);
    assert.equal(proposal.candidate?.experience.trigger.kind, 'repeated-failure');
    assert.deepEqual(proposal.candidate.experience.evidence.map(row => row.status), ['fail', 'fail']);
    fs.writeFileSync(path.join(f.project, 'node_modules', 'owned-proof', 'ignored.mjs'), 'export const precondition = 8;\n');
    const stale = await record(f.recorder, args);
    assert.equal(stale.skipped, true, 'a repeated-failure observation needs the same current source qualification as a recovery');
  });
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
console.log(`Memory experience signals: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
