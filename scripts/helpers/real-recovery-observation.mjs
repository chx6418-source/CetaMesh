import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CliAgentProcess } from '../../src/agent/cli-agent-process.js';
import { acceptanceHash as hash } from './autonomous-handoff-acceptance.mjs';

let activeProcessObserver = false;
export function createOwnedCodexProcessObserver({ stagingRoot }) {
  assert.equal(activeProcessObserver, false, 'Only one owned test process observer may be active');
  const root = path.resolve(stagingRoot), registrations = new Map();
  const original = CliAgentProcess.prototype.startSession;
  function observedStart(...args) {
    const options = args[0];
    const registration = this.name === 'codex' && typeof options?.sessionId === 'string'
      ? [...registrations.values()].find(row => options.sessionId.startsWith(row.sessionId + ':')) : null;
    let within = false;
    if (registration && typeof options.cwd === 'string') {
      const relative = path.relative(fs.realpathSync(root), fs.realpathSync(options.cwd));
      within = relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    }
    if (!within) return Reflect.apply(original, this, args);
    assert.equal(registration.handle, null, 'The registered dispatch may own only one CLI process');
    const callback = options.onStdout;
    const observer = registration.observer;
    const wrapped = function (...callbackArgs) {
      observer.accept(callbackArgs[0]);
      if (registration.phase === 'resume-read' && observer.facts.wait) observer.facts.unexpected = true;
      if (callback) return Reflect.apply(callback, this, callbackArgs);
    };
    registration.handle = Reflect.apply(original, this, [{ ...options, onStdout: wrapped }, ...args.slice(1)]);
    return registration.handle;
  }
  CliAgentProcess.prototype.startSession = observedStart; activeProcessObserver = true;
  return { beforeSend(request, phase) {
      if (request.provider !== 'codex' || request.phase === 'bootstrap') return;
      registrations.set(request.sessionId, { sessionId: request.sessionId, phase, handle: null, observer: createReadonlyWaitObserver() });
    },
    capture(request) {
      const row = registrations.get(request.sessionId);
      assert.ok(row?.handle?.child?.stdout, 'The owned current runtime stream must be observable through the routed Core');
      return { observer: row.observer, handle: row.handle };
    }, restore() {
      assert.equal(CliAgentProcess.prototype.startSession, observedStart, 'Another observer must not replace the owned fixture hook');
      CliAgentProcess.prototype.startSession = original; activeProcessObserver = false;
    } };
}

export function recoveryFileHashes(project) {
  return Object.fromEntries(fs.readdirSync(project).filter(file => file !== '.git').sort().map(file => {
    const entry = path.join(project, file), stat = fs.lstatSync(entry);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Only existing regular fixture files are allowed');
    return [file, hash(fs.readFileSync(entry))];
  }));
}
export function nativeOutputDigests(content) {
  const result = new Set();
  for (const eol of ['\n', '\r\n']) {
    const body = content.replace(/\r?\n/g, eol).replace(/(?:\r?\n)+$/, '');
    for (const suffix of ['', '\n', '\r\n', '\n\n', '\n\r\n', '\r\n\n', '\r\n\r\n'])
      result.add(hash(JSON.stringify({ exitCode: 0, output: body + suffix })));
  }
  return result;
}
export function requireCurrentNativeRead(task, digests) {
  const observed = task.executionObservation;
  const rows = task.executionEvidence.filter(row => row.runId === observed?.runId
    && row.sessionId === observed.sessionId && row.provider === 'codex' && row.source === 'native-result'
    && row.capability === 'codex.native.command' && row.status === 'completed' && row.exitCode === 0 && digests.has(row.resultSha256));
  assert.ok(rows.length, 'Actual current-run native read output must match the unchanged sum.js bytes');
  return rows.map(row => ({ eventId: row.eventId, runId: row.runId, resultSha256: row.resultSha256 }));
}

export function requireRecoveryCheckpoint(task, previousCheckpoint) {
  if (previousCheckpoint?.summary) {
    assert.deepEqual(task.checkpoint, previousCheckpoint, 'An established historical checkpoint must remain unchanged');
    return { kind: 'retained-historical-checkpoint', sha256: hash(JSON.stringify(task.checkpoint)) };
  }
  const observed = task.executionObservation;
  const report = task.agentReports.filter(row => row.provider === observed?.provider && row.sessionId === observed.sessionId
    && row.runId === observed.runId && row.phase === 'user' && row.taskRev >= observed.startedRev).at(-1);
  assert.ok(report, 'A newly generated checkpoint must refer to the actual current-run Agent report');
  assert.equal(report.verified, false, 'Agent-generated context remains explicitly unverified');
  assert.equal(report.sha256, hash(report.text));
  assert.equal(task.checkpoint?.summary, '[Unverified Agent report]\n' + report.text.slice(0, 7900));
  assert.equal(task.checkpoint.nextAction, previousCheckpoint?.nextAction ?? '');
  assert.ok(task.checkpoint.at >= report.at && task.checkpoint.at <= observed.turnEndObservedAt);
  return { kind: 'new-unverified-agent-report', previousCheckpoint: previousCheckpoint ?? null,
    reportEventId: report.eventId, reportSha256: report.sha256, sha256: hash(JSON.stringify(task.checkpoint)) };
}

export async function pauseRecoveryTaskUi(services, taskId, reason) {
  const current = services.taskService.runtime.get({ id: taskId }).task;
  return services.desktopUiService.execute({ method: 'ui.task.pause', params: { id: taskId, expectedRev: current.rev, reason } });
}
export async function resumeRecoveryTaskUi(services, taskId, provider, nextInstruction, requestId) {
  const current = services.taskService.runtime.get({ id: taskId }).task;
  return services.desktopUiService.execute({ method: 'ui.task.reconcile', params: { id: taskId, expectedRev: current.rev,
    provider, automatic: true, action: 'resume', nextInstruction, requestId } });
}

export async function rebindRecoveryExecutionConsentUi(services, { provider, workspaceId, previousApprovalId, beforeApprove = async () => {} }) {
  const prior = services.capabilityService.broker.approvals.get(previousApprovalId), priorHash = hash(JSON.stringify(prior));
  const scope = await services.desktopUiService.execute({ method: 'ui.agent.security', params: { provider, workspaceId } });
  const exact = request => request?.capability === 'agent.execution.authorize' && request.workspaceId === workspaceId
    && request.actor?.kind === 'owner' && request.actor.id === 'desktop' && !request.taskId
    && JSON.stringify(Object.keys(request.input ?? {}).sort()) === JSON.stringify(['fingerprint', 'provider'])
    && request.input.provider === provider && request.input.fingerprint === scope.fingerprint
    && request.reason === scope.disclosure.slice(0, 1000);
  if (prior.status !== 'consumed' || scope.required !== true || scope.security?.mode !== 'native'
    || scope.security.nativeSandboxSupported !== true || !exact(prior.request)) {
    throw Object.assign(Error('The original Owner execution scope must match the current Core exactly'), { code: 'AGENT_SECURITY_POLICY_CHANGED' });
  }
  assert.equal(services.capabilityService.broker.approvals.list().length, 0, 'Existing pending approvals must be retained for Core review');
  const pending = await services.desktopUiService.execute({ method: 'ui.agent.authorize', params: { provider, workspaceId, fingerprint: scope.fingerprint } });
  assert.equal(pending.status, 'pending'); assert.notEqual(pending.approvalId, previousApprovalId);
  const next = services.capabilityService.broker.approvals.get(pending.approvalId);
  assert.equal(next.status, 'pending'); assert.ok(exact(next.request), 'Only the exact previously approved scope may be rebound');
  await beforeApprove({ approvalId: pending.approvalId, previousApprovalId, capability: 'agent.execution.authorize', provider, workspaceId, fingerprint: scope.fingerprint });
  await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  assert.equal(hash(JSON.stringify(services.capabilityService.broker.approvals.get(previousApprovalId))), priorHash, 'The original approval evidence remains unchanged');
  const current = services.agentBroker.assertExecutionConsent(provider, { workspaceId });
  assert.equal(current.authorized, true); assert.equal(current.fingerprint, scope.fingerprint);
  return { approvalId: pending.approvalId, previousApprovalId, fingerprint: scope.fingerprint, reboundCurrentCoreOnly: true };
}

export async function releaseExistingRecoveryTaskUi(services, taskId, assignment, check = () => {}, verifyExactStop = async () => {}, expectedReviewOperationIds = []) {
  const current = services.taskService.runtime.get({ id: taskId }).task;
  assert.equal(current.currentAgent?.provider, assignment.provider);
  assert.equal(current.currentAgent?.sessionId, assignment.sessionId);
  assert.equal(current.executionObservation?.runId, assignment.runId);
  const preview = await services.desktopUiService.execute({ method: 'ui.task.recovery.inspect', params: { id: taskId, automatic: true } });
  if (preview.blockers.length || preview.canRelease !== true || preview.session.stopped !== true) {
    throw Object.assign(Error('Core retained the original recovery refusal; no dispatch is permitted'), {
      code: preview.blockers[0]?.code || 'TASK_RECOVERY_REVIEW_REQUIRED', recoveryPreview: preview
    });
  }
  assert.equal(preview.session.provider, assignment.provider); assert.equal(preview.session.sessionId, assignment.sessionId);
  assert.ok(expectedReviewOperationIds.length <= 1 && expectedReviewOperationIds.every(id => typeof id === 'string' && id.startsWith('request:')));
  if (JSON.stringify(preview.reviewOperationIds) !== JSON.stringify(expectedReviewOperationIds)) {
    throw Object.assign(Error('Only the exact Core-verified failed provisioning request may be retired'), {
      code: 'RECOVERY_OPERATION_SCOPE_CHANGED', recoveryPreview: preview });
  }
  try { check(); await verifyExactStop(preview); check(); }
  catch (error) { error.recoveryPreview = preview; throw error; }
  const latest = services.taskService.runtime.get({ id: taskId }).task;
  let released;
  try { released = await services.desktopUiService.execute({ method: 'ui.task.reconcile', params: {
    id: taskId, expectedRev: latest.rev, automatic: true, action: 'release' } }); }
  catch (error) { error.recoveryPreview = preview; throw error; }
  check(); assert.equal(released.task.id, taskId); assert.equal(released.task.status, 'paused');
  assert.equal(services.taskService.runtime.get({ id: taskId }).task.currentAgent, null);
  return { preview, task: released.task };
}

// This is a passive test observer, never a tool permission or adapter replacement.
// Preserve only classifications/hashes of the approved fixture commands, not raw CLI output.
export function createReadonlyWaitObserver() {
  const facts = { commands: [], wait: null, unexpected: false }; let pending = '';
  const classify = value => {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (/^(?:Get-Content -Raw -LiteralPath sum\.js|(?:"?[A-Za-z]:[^"\r\n;&|><]*\\(?:powershell|pwsh)\.exe"?|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+)*-Command\s+["']Get-Content -Raw -LiteralPath sum\.js["'])$/i.test(text)) return 'read-sum';
    if (/^(?:Start-Sleep -Seconds 30|(?:"?[A-Za-z]:[^"\r\n;&|><]*\\(?:powershell|pwsh)\.exe"?|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+)*-Command\s+["']Start-Sleep -Seconds 30["'])$/i.test(text)) return 'wait-30s';
    return null;
  };
  return { facts,
    accept(chunk) { pending += String(chunk); const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) { let event; try { event = JSON.parse(line); } catch { continue; }
        if (!['item.started', 'item.updated', 'item.completed'].includes(event.type) || event.item?.type !== 'command_execution') continue;
        const item = event.item, classification = classify(item.command), id = String(item.id || '');
        if (event.type === 'item.started') {
          facts.commands.push({ id, classification, commandSha256: hash(String(item.command || '')) });
          if (!classification) facts.unexpected = true;
          if (classification === 'wait-30s') facts.wait = { id, startedAt: Date.now(), completed: false };
        }
        if (event.type === 'item.completed' && facts.wait?.id === id) facts.wait.completed = true;
      }
    }
  };
}
