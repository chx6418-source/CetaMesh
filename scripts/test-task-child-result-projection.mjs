import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createTaskService } from '../src/task/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { buildTaskContext } from '../src/context/task-context.js';

// Real Task/Workspace/Capability read receipts; Agent prose is deliberately
// synthetic and never substitutes for a process or independently observed fact.
async function fixture(finishOrder = ['b', 'a']) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-child-facts-')));
  const project = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(project);
  const workspaceService = createWorkspaceService({ stateDir });
  const { workspace } = await workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Owned child source fixture' } });
  const service = createTaskService({ stateDir, resolveWorkspace: id => workspaceService.describeWorkspace(id) });
  const rt = service.runtime, capabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime: rt });
  const parent = rt.create({ goal: 'Inspect two independent sources', requirements: ['Report actual read evidence'], workspaceId: workspace.id });
  const children = {};
  for (const key of ['a', 'b']) {
    fs.writeFileSync(path.join(project, key + '.txt'), 'OWNED_SOURCE_' + key.toUpperCase());
    let child = rt.createChild({ parentTaskId: parent.id, expectedParentRev: parent.rev, requestId: 'create-' + key,
      goal: 'Inspect source ' + key, workspaceId: workspace.id,
      contract: { mode: 'read-only', outputKind: 'tool', readScope: [key + '.txt'], expectedEvidence: ['filesystem.read'] } });
    child = rt.start({ id: child.id, expectedRev: child.rev, provider: 'cetamesh', sessionId: 'child-session-' + key }).task;
    child = rt.recordAttempt({ id: child.id, expectedRev: child.rev, requestId: 'child-run-' + key,
      provider: 'cetamesh', sessionId: 'child-session-' + key, state: 'started' });
    rt.beginExecutionObservation({ id: child.id, provider: 'cetamesh', sessionId: 'child-session-' + key, runId: 'child-run-' + key, phase: 'user' });
    capabilities.grantTask(child.id);
    children[key] = child;
  }
  for (const key of finishOrder) {
    const child = children[key], actor = capabilities.principalForTask(child.id);
    const read = await capabilities.broker.execute({ requestId: 'actual-read-' + key, actor, taskId: child.id, workspaceId: workspace.id,
      capability: 'filesystem.read', input: { path: key + '.txt' } });
    assert.equal(read.status, 'completed'); assert.equal(read.result.content, 'OWNED_SOURCE_' + key.toUpperCase());
    rt.recordToolOutcome({ id: child.id, provider: 'cetamesh', sessionId: 'child-session-' + key, runId: 'child-run-' + key,
      phase: 'user', eventId: 'read-event-' + key, capability: 'filesystem.read', status: read.status });
    let current = rt.get({ id: child.id }).task;
    current = rt.recordAgentReport({ id: child.id, expectedRev: current.rev, provider: 'cetamesh', sessionId: 'child-session-' + key,
      runId: 'child-run-' + key, phase: 'user', eventId: 'report-event-' + key,
      text: JSON.stringify({ summary: 'Synthetic report ' + key, verified: true, findings: [{ text: 'Reported OWNED_SOURCE_' + key.toUpperCase(), evidenceEventIds: ['read-event-' + key] },
        { text: 'A further synthetic claim', evidenceEventIds: ['invented-source'], verified: true }],
        filesChanged: ['claimed-output.txt'], commands: ['claimed npm test success'], remaining: ['Claimed next step'] }) });
    rt.observeExecution({ id: child.id, provider: 'cetamesh', sessionId: 'child-session-' + key, runId: 'child-run-' + key,
      phase: 'user', state: 'awaiting-review' });
    current = rt.get({ id: child.id }).task;
    rt.settleAttempt({ id: child.id, expectedRev: current.rev, requestId: 'child-run-' + key, state: 'completed' });
    current = rt.get({ id: child.id }).task;
    current = rt.complete({ id: child.id, expectedRev: current.rev, summary: 'Fixture completed ' + key }).task;
    assert.equal((await rt.verifyChild({ id: child.id, expectedRev: current.rev })).status, 'VERIFIED');
    children[key] = rt.get({ id: child.id }).task;
  }
  return { root, project, stateDir, parent, children, service, rt, capabilities, workspace,
    list: () => rt.listChildren({ parentTaskId: parent.id }).children,
    async close() { await capabilities.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

for (const order of [['b', 'a'], ['a', 'b']]) {
  const f = await fixture(order);
  try {
    const before = JSON.stringify(f.list());
    const parent = { ...f.parent, children: f.list() };
    const context = buildTaskContext({ task: parent });
    assert.equal(context.task.childResults?.length, 2, 'linked parent context receives both structured child results in either actual completion order');
    const { projectChildResultFacts } = await import('../src/task/child-result-projection.js');
    for (const key of ['a', 'b']) {
      const child = f.children[key], row = projectChildResultFacts(child, { parent });
      assert.equal(row.childId, child.id); assert.equal(row.taskRev, child.rev); assert.equal(row.status, 'completed');
      assert.equal(row.attempt.runId, 'child-run-' + key); assert.equal(row.report.eventId, 'report-event-' + key);
      assert.equal(row.report.source, 'agent-report'); assert.equal(row.report.verified, false);
      assert.equal(row.findings[0].kind, 'agent-claim'); assert.match(row.findings[0].text, /OWNED_SOURCE_/);
      assert.deepEqual(row.findings[1].evidenceEventIds, []); assert.deepEqual(row.findings[1].missingEvidenceIds, ['invented-source']);
      assert.equal(row.verification.status, 'VERIFIED'); assert.equal(row.verification.current, true);
      assert.deepEqual(row.verification.evidenceEventIds, ['read-event-' + key]);
      assert.deepEqual(row.hostFacts.reads.map(item => item.eventId), ['read-event-' + key]);
      assert.equal(row.hostFacts.reads[0].path, null, 'existing Task receipts do not retain read input paths');
      assert.equal(row.hostFacts.reads[0].pathCoverage, 'not-retained');
      assert.deepEqual(row.hostFacts.commands, []); assert.deepEqual(row.hostFacts.writes, []);
      assert.deepEqual(row.hostFacts.artifacts, [], 'claimed output files cannot become host artifacts');
      assert.deepEqual(row.report.claimedFilesChanged, ['claimed-output.txt']);
      assert.deepEqual(row.report.claimedCommands, ['claimed npm test success']);
      assert.equal(row.hostFacts.readOnly, true); assert.equal(row.hostFacts.coverage, 'partial');
      assert.equal(projectChildResultFacts(child, { parent: { ...parent, id: 'unrelated-parent' } }), null);
      assert.equal(projectChildResultFacts(child, { parent: { ...parent, workspaceId: 'other-workspace' } }), null);
    }
    if (order[0] === 'b') {
      const child = f.children.a;
      const failed = structuredClone(child); failed.executionObservation.state = 'failed';
      const failedFacts = projectChildResultFacts(failed, { parent });
      assert.equal(failedFacts.verification.current, false, 'a failed current execution cannot inherit the stored VERIFIED display');
      assert.ok(failedFacts.remaining.blockers.includes('CURRENT_EXECUTION_NOT_SETTLED'));
      const changedRun = structuredClone(child); changedRun.executionObservation.runId = 'different-run';
      const stale = projectChildResultFacts(changedRun, { parent });
      assert.equal(stale.verification.current, false); assert.equal(stale.report, null); assert.deepEqual(stale.hostFacts.reads, []);
      assert.ok(stale.remaining.blockers.includes('CURRENT_RUN_CHANGED'));
      const missing = structuredClone(child); missing.result.evidenceEventIds = ['missing-proof'];
      assert.equal(projectChildResultFacts(missing, { parent }).verification.current, false);
      const changedParent = { ...parent, rev: parent.rev + 1, goal: 'A different objective' };
      assert.ok(projectChildResultFacts(child, { parent: changedParent }).remaining.blockers.includes('TASK_CHILD_PARENT_CHANGED'));
      assert.equal(projectChildResultFacts(child, { parent: { ...parent, rev: parent.rev + 1 } }).verification.current, true,
        'a revision-only observation cannot invent an objective change');
      const newAttempt = structuredClone(child); newAttempt.rev++;
      newAttempt.attempts.push({ ...child.attempts[0], id: 'different-attempt', requestId: 'new-attempt', state: 'failed', taskRev: newAttempt.rev });
      const attemptFacts = projectChildResultFacts(newAttempt, { parent });
      assert.equal(attemptFacts.verification.current, false); assert.equal(attemptFacts.report, null); assert.deepEqual(attemptFacts.hostFacts.reads, []);
      const native = structuredClone(child);
      native.attempts[0].provider = 'codex'; native.executionObservation.provider = 'codex';
      for (const row of [...native.executionEvidence, ...native.agentReports]) row.provider = 'codex';
      native.executionEvidence[0].source = 'native-result';
      const nativeFacts = projectChildResultFacts(native, { parent });
      assert.equal(nativeFacts.verification.current, false); assert.equal(nativeFacts.hostFacts.reads[0].verified, false);
      assert.equal(nativeFacts.hostFacts.reads[0].provenance, 'native-observation');
      assert.ok(nativeFacts.remaining.blockers.includes('NATIVE_OBSERVATION_UNVERIFIED'));
      const unknown = structuredClone(child); unknown.executionEvidence[0].status = 'outcome-unknown';
      const unknownFacts = projectChildResultFacts(unknown, { parent });
      assert.equal(unknownFacts.verification.current, false); assert.deepEqual(unknownFacts.remaining.nextSteps, ['REVIEW_ORIGINAL_ATTEMPT_WITHOUT_REPLAY']);
      const outside = structuredClone(child); outside.executionEvidence.push({ ...child.executionEvidence[0], eventId: 'claimed-test', capability: 'test.run',
        source: 'core-test', tool: 'npm', exitCode: 0 });
      const readonly = projectChildResultFacts(outside, { parent });
      assert.deepEqual(readonly.hostFacts.commands, []); assert.deepEqual(readonly.hostFacts.writes, []);
      assert.ok(readonly.remaining.blockers.includes('READ_ONLY_EFFECT_OBSERVATION'));
      const malformed = structuredClone(child); malformed.agentReports[0].text = '{ invalid report JSON';
      malformed.agentReports[0].sha256 = crypto.createHash('sha256').update(malformed.agentReports[0].text).digest('hex');
      const plain = projectChildResultFacts(malformed, { parent });
      assert.equal(plain.report.text, '{ invalid report JSON'); assert.deepEqual(plain.findings, []);
      const changedReport = structuredClone(child); changedReport.agentReports[0].text = 'A changed report without its original source hash';
      const changedClaim = projectChildResultFacts(changedReport, { parent });
      assert.equal(changedClaim.report, null); assert.deepEqual(changedClaim.findings, []);
      const large = structuredClone(child);
      large.agentReports[0].text = JSON.stringify({ summary: 'Bounded synthetic report', findings: Array.from({ length: 35 }, (_, index) => ({ text: 'Finding ' + index + ' ' + 'x'.repeat(110), evidenceEventIds: ['read-event-a', 'invented-source'] })),
        commands: Array.from({ length: 20 }, () => 'claimed command ' + 'y'.repeat(90)), filesChanged: ['C:\\private\\do-not-expose.txt'] });
      large.agentReports[0].sha256 = crypto.createHash('sha256').update(large.agentReports[0].text).digest('hex');
      large.result.verificationReasons = Array.from({ length: 20 }, (_, index) => 'Untrusted-reason-' + index + '-'.repeat(95));
      const bounded = projectChildResultFacts(large, { parent, limit: 20, maxChars: 2400 });
      assert.ok(JSON.stringify(bounded).length <= 2400, 'output, including omission facts, respects its presentation budget');
      assert.ok(Object.values(bounded.omitted).some(count => count > 0));
      assert.doesNotMatch(JSON.stringify(bounded), /do-not-expose/);
      const foreign = { ...child, parentTaskId: 'another-parent', goal: 'UNRELATED_CHILD_HISTORY' };
      assert.doesNotMatch(JSON.stringify(buildTaskContext({ task: { ...parent, children: [...parent.children, foreign] } })), /UNRELATED_CHILD_HISTORY/);
      console.log('PASS failed/stale Attempt/Run/parent/missing-source and native observations remain unverified; claims and truncation do not grant authority');
    }
    assert.equal(JSON.stringify(f.list()), before, 'derived projection never mutates Task, Attempt, verification or report history');
    if (order[0] === 'b') {
      const rootParent = f.rt.create({ goal: 'Continue after a confirmed failed attempt', workspaceId: f.workspace.id });
      let old = f.rt.createChild({ parentTaskId: rootParent.id, expectedParentRev: rootParent.rev, workspaceId: f.workspace.id,
        requestId: 'failed-child', goal: 'Inspect the original source', contract: { mode: 'read-only', outputKind: 'tool', readScope: ['a.txt'], expectedEvidence: ['filesystem.read'] } });
      old = f.rt.start({ id: old.id, expectedRev: old.rev, provider: 'cetamesh', sessionId: 'confirmed-failure-session' }).task;
      old = f.rt.recordAttempt({ id: old.id, expectedRev: old.rev, requestId: 'confirmed-failure-run', provider: 'cetamesh', sessionId: 'confirmed-failure-session', state: 'started' });
      old = f.rt.settleAttempt({ id: old.id, expectedRev: old.rev, requestId: 'confirmed-failure-run', state: 'failed', reason: 'Fixture confirmed no dispatch result' });
      old = f.rt.fail({ id: old.id, expectedRev: old.rev, reason: 'Fixture failed before source result' }).task;
      const replacement = f.rt.createChild({ parentTaskId: rootParent.id, expectedParentRev: rootParent.rev, workspaceId: f.workspace.id,
        requestId: 'fresh-child', supersedesChildId: old.id, goal: 'Inspect the original source again',
        contract: { mode: 'read-only', outputKind: 'tool', readScope: ['a.txt'], expectedEvidence: ['filesystem.read'] } });
      const linkedParent = { ...rootParent, children: f.rt.listChildren({ parentTaskId: rootParent.id }).children };
      const oldFacts = projectChildResultFacts(old, { parent: linkedParent });
      const freshFacts = projectChildResultFacts(replacement, { parent: linkedParent });
      assert.equal(oldFacts.supersededBy, replacement.id); assert.ok(oldFacts.remaining.blockers.includes('CHILD_SUPERSEDED'));
      assert.equal(freshFacts.supersedesChildId, old.id); assert.equal(freshFacts.verification.current, false);
      assert.equal(freshFacts.report, null); assert.deepEqual(freshFacts.hostFacts.reads, []);
      assert.equal(f.rt.get({ id: old.id }).task.attempts[0].state, 'failed', 'fresh follow-up preserves the original confirmed Attempt');
      assert.equal(buildTaskContext({ task: linkedParent }).task.childResults[0].childId, replacement.id, 'current leaf precedes bounded historical results');
      console.log('PASS existing terminal-child supersession retains original Attempt and exposes a fresh unverified child');
    }
    console.log('PASS actual scoped reads -> retained child receipts -> existing verification -> bounded parent facts, completion order ' + order.join('/'));
  } finally { await f.close(); }
}

const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui');
assert.ok(fs.existsSync(path.join(uiRoot, 'src/app/ChildTaskResults.tsx')), 'the readonly structured child view renders the projected host/claim distinction');
const require = createRequire(path.join(uiRoot, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { ChildTaskResults } = await vite.ssrLoadModule('/src/app/ChildTaskResults.tsx');
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const { projectChildResultFacts } = await import('../src/task/child-result-projection.js');
  const f = await fixture();
  try {
    const parent = { ...f.parent, children: f.list() }, result = projectChildResultFacts(f.children.a, { parent });
    const html = renderToStaticMarkup(React.createElement(ChildTaskResults, { results: [result] }));
    assert.match(html, /子任务结构化结果|执行者报告/); assert.match(html, /当前合同证据已核验/);
    assert.match(html, /自述命令|执行者自述/); assert.match(html, /claimed npm test success/);
    assert.match(html, /读取路径未留存/); assert.match(html, /read-event-a/);
    assert.match(html, /自述引用未找到当前来源证据/);
    const changed = projectChildResultFacts({ ...f.children.a, rev: f.children.a.rev + 1 }, { parent });
    const staleHtml = renderToStaticMarkup(React.createElement(ChildTaskResults, { results: [changed] }));
    assert.doesNotMatch(staleHtml, /当前合同证据已核验/); assert.match(staleHtml, /待核验|来源已变化/);
    assert.doesNotMatch(html, /确认分析证据|运行测试|创建子任务|onerror=/, 'the standalone component does not duplicate lifecycle/permission controls');
    console.log('PASS actual React child-fact rendering preserves claims, host path gaps and current-verification distinction without IPC');
  } finally { await f.close(); }
} finally { await vite.close(); }

console.log('NOT_RUN: paid/external model concurrency, native UI, installed application and release acceptance.');
