import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskService } from '../src/task/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';

// Stop the synthetic Agent at the same await that separates an Owner review from the journal writes.
async function main() {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'cetamesh-owner-recovery-'));

  async function bounded(promise, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
    });
    try { return await Promise.race([promise, timeout]); }
    finally { clearTimeout(timer); }
  }

  async function fixture(name, gateStop, lateSuccess = false) {
    const base = path.join(root, name), stateDir = path.join(base, 'state');
    const workspaces = createWorkspaceService({ stateDir });
    const state = { taskId: null, sends: 0, sessionCreates: 0, preview: null, commitStatusChecks: 0,
      taskService: null, capabilities: null, ui: null };
    const stopEntered = Promise.withResolvers(), releaseStop = Promise.withResolvers();
    const effectEntered = Promise.withResolvers(), releaseEffect = Promise.withResolvers();
    let stopGated = false;
    let committingReview = false;

    const binding = { provider: 'cetamesh', sessionId: 'fixture-session' };
    const agentBroker = {
      ids: () => ['cetamesh'],
      capabilities: () => ({ workspaceBoundary: 'capability-broker' }),
      health: async () => ({ available: true, authenticated: true, sessionCapable: true }),
      cancel: async () => ({ cancelled: true }),
      async status() {
        if (committingReview) state.commitStatusChecks++;
        if (gateStop && committingReview && state.commitStatusChecks === 2 && !stopGated) {
          stopGated = true;
          stopEntered.resolve();
          await bounded(releaseStop.promise, 'fixture stop-status release');
        }
        return { running: false, queued: 0, lastRunStatus: 'completed' };
      },
      async createSession(provider, request) {
        assert.equal(provider, binding.provider);
        assert.equal(request.taskId, state.taskId);
        assert.equal(request.workspaceId, state.taskService.runtime.get({ id: state.taskId }).task.workspaceId);
        return { sessionId: `fixture-fresh-${++state.sessionCreates}` };
      },
      setTaskExecutionObserver() { /* The fixture's send records an identified synthetic run. */ },
      async *follow({ signal }) {
        if (!signal.aborted) await new Promise(done => signal.addEventListener('abort', done, { once: true }));
      },
      async send({ provider, sessionId }) {
        const rt = state.taskService.runtime;
        const runId = `local-run-${++state.sends}`;
        assert.notEqual(sessionId, binding.sessionId, 'Owner recovery must retire the old Session before a fresh instruction');
        const ref = { id: state.taskId, provider, sessionId, phase: 'user', runId };
        const started = rt.beginExecutionObservation(ref);
        rt.recordAgentReport({ ...ref, expectedRev: started.rev, eventId: `report-${runId}`,
          text: 'Independent synthetic report for the reviewed fresh run.' });
        rt.observeExecution({ ...ref, state: 'awaiting-review' });
        return { accepted: true, requestId: `accepted-${runId}` };
      }
    };

    function open() {
      state.taskService = createTaskService({ stateDir });
      state.capabilities = createCapabilityService({ stateDir, workspaceService: workspaces,
        taskRuntime: state.taskService.runtime, agentBroker });
      state.ui = createDesktopUiService({ services: { taskService: state.taskService,
        workspaceService: workspaces, capabilityService: state.capabilities, agentBroker } });
      state.capabilities.broker.register({ id: 'fixture.owner-recovery-effect', permission: 'publish',
        risk: 'high', effect: 'non-idempotent', async execute(request) {
          if (lateSuccess) {
            effectEntered.resolve();
            await bounded(releaseEffect.promise, 'late successful effect release');
          }
          const workspace = workspaces.describeWorkspace(request.workspaceId);
          fs.appendFileSync(path.join(workspace.root, 'marker.bin'), Buffer.from([0x78]));
          if (lateSuccess) return { bytesWritten: 1 };
          throw Object.assign(new Error('Synthetic response loss after the real local append'), { code: 'FIXTURE_RESULT_LOST' });
        } });
    }
    open();

    async function workspace(label) {
      const directory = path.join(base, label);
      fs.mkdirSync(directory, { recursive: true });
      return (await workspaces.execute({ method: 'workspace.create', params: { name: label, root: directory } })).workspace;
    }
    const first = await workspace('first');
    const rt = state.taskService.runtime;
    const task = rt.create({ goal: 'Review original Workspace and original effect', workspaceId: first.id });
    state.taskId = task.id;
    rt.start({ id: task.id, expectedRev: task.rev, ...binding });
    state.capabilities.grantTask(task.id, { capabilities: ['filesystem.read'], workspaceIds: [first.id] });

    const read = () => state.taskService.runtime.get({ id: state.taskId }).task;
    const call = (method, params) => state.ui.execute({ method, params });
    const effect = (ws, requestId, approved = false) => state.capabilities.execute({
      method: 'capability.execute', params: { requestId, taskId: state.taskId, workspaceId: ws.id,
        capability: 'fixture.owner-recovery-effect', input: {}, approved } });
    const review = async () => {
      const preview = await call('ui.task.recovery.inspect', { id: state.taskId });
      assert.equal(preview.canResume, true, JSON.stringify(preview.blockers));
      assert.ok(preview.reviewToken, 'the race must begin after a real evidence-bound preview');
      state.preview = preview;
      committingReview = true;
      return call('ui.task.reconcile', { id: state.taskId, expectedRev: preview.taskRev, reviewed: true,
        action: 'resume', reviewToken: preview.reviewToken, reviewedOperationIds: preview.reviewOperationIds,
        provider: 'cetamesh', reviewSummary: 'Inspected the original one-byte effect in the original Workspace.',
        nextInstruction: 'Produce a fresh independent report.', requestId: 'owner-fresh-instruction' });
    };
    const status = id => state.capabilities.broker.dispatchStatus(id)?.status;
    const bytes = ws => fs.statSync(path.join(ws.root, 'marker.bin')).size;
    async function waitUnknown(id) {
      const until = Date.now() + 5000;
      do {
        if ((await call('ui.approvals.operation', { id })).status === 'unknown') return;
        await delay(5);
      } while (Date.now() < until);
      throw new Error('Deferred approval never reported the unknown result');
    }
    async function close() {
      releaseStop.resolve();
      releaseEffect.resolve();
      await bounded(state.capabilities.close(), 'local capability service close');
    }
    return { state, first, workspace, open, close, read, call, effect, review, bytes, status,
      waitUnknown, stopEntered, releaseStop, effectEntered, releaseEffect };
  }

  async function approvalAcrossRestart() {
    const f = await fixture('deferred-approval-restart', false);
    try {
      const pending = await f.effect(f.first, 'ordinary-approval-request');
      assert.equal(pending.status, 'pending');
      const decision = { id: pending.approvalId, approve: true };
      const accepted = await f.call('ui.approvals.decide', decision);
      assert.equal(accepted.status, 'accepted');
      await f.waitUnknown(accepted.operationId);
      assert.equal(f.bytes(f.first), 1);
      assert.equal(f.status('ordinary-approval-request'), 'outcome-unknown');
      await f.close();
      f.open();
      assert.equal(f.read().status, 'blocked');
      assert.equal(f.state.capabilities.recoveryForTask(f.state.taskId)?.state, 'needs-reconciliation');
      const reviewed = await bounded(f.review(), 'public Owner recovery and fresh send');
      assert.equal(reviewed.task.status, 'running');
      const current = f.read(), report = current.agentReports.at(-1);
      assert.equal(current.id, f.state.taskId);
      assert.equal(f.state.sessionCreates, 1);
      assert.notEqual(current.currentAgent.sessionId, 'fixture-session');
      assert.ok(current.agentHistory.some(row => row.sessionId === 'fixture-session'));
      assert.equal(current.executionObservation.state, 'awaiting-review');
      assert.equal(report.runId, current.executionObservation.runId);
      assert.equal(f.state.sends, 1);
      const repeated = await f.call('ui.approvals.decide', decision);
      assert.equal(repeated.operationId, accepted.operationId);
      assert.equal(f.bytes(f.first), 1);
      assert.equal(f.status('ordinary-approval-request'), 'reconciled');
      assert.equal(f.state.capabilities.recoveryForTask(f.state.taskId), null);
      const result = await f.call('ui.task.complete', { id: current.id, expectedRev: current.rev,
        reviewed: true, reviewKind: 'report-only', reportEventId: report.eventId,
        reportSha256: report.sha256, summary: 'Owner accepted the exact fresh report.' });

      assert.equal(result.task.status, 'completed');
      assert.equal(f.bytes(f.first), 1);
    } finally { await f.close(); }
  }

  async function cancellationThenLateSuccess() {
    const f = await fixture('cancelled-wrapper-late-success', false, true);
    try {
      const pending = await f.effect(f.first, 'late-success-original');
      assert.equal(pending.status, 'pending');
      const decision = { id: pending.approvalId, approve: true };
      const accepted = await f.call('ui.approvals.decide', decision);
      await bounded(f.effectEntered.promise, 'original executor entry');
      assert.equal((await f.call('ui.approvals.cancel', { id: accepted.operationId })).cancelRequested, true);
      await f.waitUnknown(accepted.operationId);
      assert.equal(f.status('late-success-original'), 'started');
      assert.equal(fs.existsSync(path.join(f.first.root, 'marker.bin')), false);
      f.releaseEffect.resolve();
      const settledDeadline = Date.now() + 5000;
      while (f.status('late-success-original') !== 'completed' && Date.now() < settledDeadline) await delay(5);
      assert.equal(f.status('late-success-original'), 'completed', 'original dispatch settles within the fixture budget');
      assert.equal(f.bytes(f.first), 1);
      assert.equal((await f.call('ui.approvals.operation', { id: accepted.operationId })).status, 'unknown');
      await f.close();
      f.open();
      assert.equal(f.state.capabilities.recoveryForTask(f.state.taskId)?.state, 'needs-reconciliation');
      const result = await bounded(f.review(), 'explicit review of cancelled wrapper with late success');
      assert.equal(result.task.status, 'running');
      assert.equal(f.state.sends, 1);
      assert.equal(f.state.sessionCreates, 1);
      assert.equal(f.status('late-success-original'), 'completed', 'Owner review preserves the real successful dispatch status');
      const repeat = await f.call('ui.approvals.decide', decision);
      assert.equal(repeat.operationId, accepted.operationId);
      assert.equal(repeat.status, 'unknown', 'historical wrapper outcome remains uncertain after explicit review');
      assert.equal(f.bytes(f.first), 1, 'review and duplicate approval never repeat the original effect');
      // ee5ec1f reports needs-reconciliation/TASK_EFFECT_UNCONFIRMED indefinitely here.
      assert.equal(f.state.capabilities.recoveryForTask(f.state.taskId), null);
      assert.equal(f.state.capabilities.completionBlocker(f.state.taskId), null);
      const current = f.read(), report = current.agentReports.at(-1);
      const completed = await f.call('ui.task.complete', { id: current.id, expectedRev: current.rev,
        reviewed: true, reviewKind: 'report-only', reportEventId: report.eventId,
        reportSha256: report.sha256, summary: 'Owner accepted the fresh report after reviewing the late original result.' });
      assert.equal(completed.task.status, 'completed');
      assert.equal(f.bytes(f.first), 1);
    } finally { await f.close(); }
  }

  async function staleOwnerReview(rebindWorkspace) {
    const f = await fixture(rebindWorkspace ? 'stale-workspace' : 'new-effect-same-workspace', true);
    let pendingReview;
    try {
      const later = rebindWorkspace ? await f.workspace('later') : f.first;
      const original = f.read();
      const blocked = f.state.taskService.runtime.block({ id: original.id, expectedRev: original.rev,
        reason: 'needs-reconciliation: original synthetic operation lost its response' }).task;
      const lost = error => error.code === 'FIXTURE_RESULT_LOST' && error.effectStatus === 'unknown';
      await assert.rejects(f.effect(f.first, 'old-effect', true), lost);
      pendingReview = f.review().then(value => ({ value }), error => ({ error }));
      await bounded(f.stopEntered.promise, 'last awaited Agent stop-status check');
      assert.ok(f.state.preview.reviewToken, 'mutation occurs only after the actual preview');
      assert.equal(f.state.commitStatusChecks, 2, 'mutation occurs at commit final stop verification');
      if (rebindWorkspace) {
        await f.state.taskService.execute({ method: 'task.update', params: { id: blocked.id,
          expectedRev: blocked.rev, workspaceId: later.id } });
      }
      await assert.rejects(f.effect(later, 'new-effect', true), lost);
      if (!rebindWorkspace) assert.equal(f.read().rev, blocked.rev, 'dispatch alone does not bump Task.rev');
      assert.deepEqual([f.status('old-effect'), f.status('new-effect')], ['outcome-unknown', 'outcome-unknown']);
      f.releaseStop.resolve();
      const reply = await bounded(pendingReview, 'stale Owner review reply');
      const snapshot = {
        code: reply.error?.code ?? null, returnedStatus: reply.value?.task?.status ?? null,
        old: f.status('old-effect'), added: f.status('new-effect'),
        decisions: f.read().decisions.length, sends: f.state.sends, bytes: f.bytes(later)
      };


      assert.ok(snapshot.code && !snapshot.returnedStatus, JSON.stringify(snapshot));
      assert.deepEqual([snapshot.old, snapshot.added], ['outcome-unknown', 'outcome-unknown'], JSON.stringify(snapshot));
      assert.equal(snapshot.decisions, 0);
      assert.equal(snapshot.sends, 0);
      assert.equal(f.state.sessionCreates, 0);
      assert.equal(snapshot.bytes, rebindWorkspace ? 1 : 2);
      if (rebindWorkspace) assert.equal(f.bytes(f.first), 1);
    } finally {
      f.releaseStop.resolve();
      if (pendingReview) await bounded(pendingReview, 'final stale Owner review settlement');
      await f.close();
    }
  }

  const failures = [];
  try {
    const cases = [['settled approval recovered after restart', approvalAcrossRestart],
      ['cancelled approval wrapper with late successful dispatch', cancellationThenLateSuccess],
      ['stale review after Workspace rebind', () => staleOwnerReview(true)],
      ['new effect during unchanged-Task review', () => staleOwnerReview(false)]];
    for (const [name, run] of cases) {
      try { await run(); }
      catch (error) { failures.push(new Error(`${name}: ${error.code ?? error.name} ${error.message}`, { cause: error })); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
  } finally {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('cetamesh-owner-recovery-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}

await main();
