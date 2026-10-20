#!/usr/bin/env node
// Opt-in real-provider acceptance. No fixture replaces the Codex CLI in this suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-phase3-real-codex-'));
let services;
let taskId;
let unavailableReason = null;
try {
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'sample.ts'), 'export const answer = 4217;\n');
  services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'),
    agentStagingRoot: path.join(root, 'staging') });
  const health = await services.agentBroker.health('codex');
  assert.equal(health.available, true, `Codex Provider unavailable: ${health.reason ?? health.status}`);
  assert.equal(health.authenticated, true, 'Codex Provider is not authenticated');
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: {
    name: 'Phase 3 real Codex acceptance', root: projectRoot
  } })).workspace;
  const nativeScope = await services.desktopUiService.execute({ method: 'ui.agent.security', params: { provider: 'codex', workspaceId: workspace.id } });
  assert.equal(nativeScope.security.mode, 'native');
  assert.equal(nativeScope.security.strictIsolationVerified, false);
  assert.equal(nativeScope.authorized, false);
  const confirmation = await services.desktopUiService.execute({ method: 'ui.agent.authorize', params: {
    provider: 'codex', workspaceId: workspace.id, fingerprint: nativeScope.fingerprint
  } });
  assert.equal(confirmation.status, 'pending');
  // Owner explicitly authorized this real synthetic-workspace acceptance in this task.
  await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: confirmation.approvalId, approve: true } });
  const started = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
    goal: 'Read sample.ts in this Workspace. Reply with the exported answer and PHASE3_REAL_CODEX_OK_4217. Do not modify files.',
    workspaceId: workspace.id, agentProvider: 'codex'
  } });
  taskId = started.task.id;
  assert.equal(started.task.currentAgent?.provider, 'codex');
  const deadline = Date.now() + 120_000;
  let task;
  do {
    task = services.taskService.runtime.get({ id: taskId }).task;
    if (task.checkpoint?.summary?.includes('PHASE3_REAL_CODEX_OK_4217')) break;
    if (['blocked', 'failed', 'cancelled'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (task.status === 'blocked' && task.progress?.note === 'CODEX_SANDBOX_UNAVAILABLE') {
    assert.equal((await services.agentBroker.health('codex')).sandboxCapable, false,
      'a real Windows sandbox refusal must be visible to the Smart Router health check');
    unavailableReason = 'Windows Codex CLI sandbox refused the isolated Task execution';
  } else {
    assert.match(task.checkpoint?.summary ?? '', /PHASE3_REAL_CODEX_OK_4217/,
      `Real Codex Task did not produce a checkpoint: ${JSON.stringify({ status: task.status,
        failure: task.failure?.reason, progress: task.progress?.note })}`);
    assert.equal(fs.readFileSync(path.join(projectRoot, 'sample.ts'), 'utf8'), 'export const answer = 4217;\n');
    assert.equal(task.agentHistory.at(-1)?.provider, 'codex');
    process.stdout.write('PASS real Codex CLI Task execution, Task Follow checkpoint, and unchanged authoritative Workspace\n');
    const native = services.agentBroker.require('codex');
    const assignment = services.taskService.runtime.get({ id: taskId }).task.currentAgent;
    async function waitStatus(predicate, label) {
      const until = Date.now() + 120000;
      let value;
      do { value = await services.agentBroker.status(assignment); if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < until);
      assert.fail(label + ': ' + JSON.stringify(value));
    }
    await waitStatus(value => !value.running, 'first native turn completion');
    async function realRound(prompt, expected) {
      const since = native._sessions.get(assignment.sessionId).nextSequence;
      const abort = new AbortController(); const events = [];
      const reader = (async () => { for await (const event of services.agentBroker.follow({ ...assignment, sinceSequence: since, signal: abort.signal })) {
        events.push(event); if (event.type === 'turn/end') return;
      } })();
      const deadline = setTimeout(() => abort.abort(), 120000);
      try {
        await services.agentBroker.send({ ...assignment, content: prompt });
        await reader;
        assert.equal(events.at(-1)?.data?.reason?.kind, 'completed', JSON.stringify(events.at(-1)));
        assert.ok(events.some(event => event.type === 'assistant/chunk'), 'Native JSONL response must pass the streaming event contract');
        assert.match(events.filter(event => event.type === 'assistant/message').at(-1)?.data?.message?.content?.[0]?.text ?? '', expected);
        assert.equal(fs.readFileSync(path.join(projectRoot, 'sample.ts'), 'utf8'), 'export const answer = 4217;\n');
        return events;
      } finally { clearTimeout(deadline); abort.abort(); }
    }
    const second = await realRound('Second turn: use a native command to read sample.ts; add one to its exported number and reply NATIVE_ROUND2_4218. Do not change files.', /NATIVE_ROUND2_4218/);
    assert.ok(second.some(event => event.type === 'tool/activity' && event.data.activity.capability === 'codex.native.command'));
    const third = await realRound('Third turn: test command error recovery. Execute a harmless native command that exits with code 7, then read sample.ts and reply NATIVE_ROUND3_RECOVERED_4217. No writes or other paths.', /NATIVE_ROUND3_RECOVERED_4217/);
    assert.ok(third.some(event => event.type === 'tool/activity' && event.data.activity.status === 'failed'), 'actual native tool failure must be observed');
    process.stdout.write('PASS real Native Session three turns, JSONL streaming, native tool activity and failed-command recovery\n');

    await services.agentBroker.send({ ...assignment, content: 'Only in this staging working directory, create native-output.txt with text NATIVE_IMPORT_OK. Do not write to other paths. Reply NATIVE_WRITE_STAGED.' });
    const awaiting = await waitStatus(value => value.waitingForApproval === true, 'native write must await Core import approval');
    assert.equal(fs.existsSync(path.join(projectRoot, 'native-output.txt')), false, 'authoritative Workspace unchanged before import approval');
    const importApproval = services.capabilityService.broker.approvals.get(awaiting.approvalId);
    assert.equal(importApproval.request.capability, 'workspace.apply');
    await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: awaiting.approvalId, approve: true } });
    await waitStatus(value => !value.running && value.lastRunStatus === 'completed', 'approved import completion');
    assert.equal(fs.readFileSync(path.join(projectRoot, 'native-output.txt'), 'utf8').replace(/^\uFEFF/, '').trim(), 'NATIVE_IMPORT_OK');
    process.stdout.write('PASS real native staging write held for existing Capability Broker Owner import approval\n');

    await services.agentBroker.send({ ...assignment, content: 'Run a harmless 20-second sleep command in this staging directory. Do not write any files. Then reply NATIVE_CANCEL_TARGET.' });
    let current = services.taskService.runtime.get({ id: taskId }).task;
    const paused = await services.desktopUiService.execute({ method: 'ui.task.pause', params: { id: taskId, expectedRev: current.rev } });
    assert.equal(paused.task.status, 'paused');
    await waitStatus(value => !value.running, 'paused native execution must actually stop');
    current = services.taskService.runtime.get({ id: taskId }).task;
    try { await services.desktopUiService.execute({ method: 'ui.task.resume', params: { id: taskId, expectedRev: current.rev } }); }
    catch (error) {
      assert.equal(error.code, 'TASK_RECOVERY_REVIEW_REQUIRED');
      assert.equal(fs.readFileSync(path.join(projectRoot, 'sample.ts'), 'utf8'), 'export const answer = 4217;\n');
      assert.equal(fs.readFileSync(path.join(projectRoot, 'native-output.txt'), 'utf8').replace(/^\uFEFF/, '').trim(), 'NATIVE_IMPORT_OK');
      current = services.taskService.runtime.get({ id: taskId }).task;
      await services.desktopUiService.execute({ method: 'ui.task.reconcile', params: { id: taskId, expectedRev: current.rev, reviewed: true,
        reviewSummary: 'Owner verified this synthetic fixture: only approved native-output.txt exists; cancelled sleep stopped; no unknown effects.',
        nextInstruction: 'Read sample.ts and reply NATIVE_RESUMED_4217. Do not write.', requestId: 'native-real-resume-reviewed' } });
    }
    await waitStatus(value => !value.running, 'resumed native turn must finish');
    current = services.taskService.runtime.get({ id: taskId }).task;
    await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: taskId, expectedRev: current.rev } });
    assert.equal(services.taskService.runtime.get({ id: taskId }).task.status, 'cancelled');
    assert.equal(services.taskService.runtime.activeWorkspaceOwner({ workspaceId: workspace.id }), null);
    process.stdout.write('PASS real Native Task pause, actual cancellation, reviewed resume and released execution authority\n');
    fs.writeFileSync(path.join(projectRoot, 'runtime-status.txt'), 'before');
    const readOnlyStarted = await services.desktopUiService.execute({ method: 'ui.task.create', params: {
      goal: 'Reply READONLY_HELLO_OK. Do not use tools or modify any files.', workspaceId: workspace.id, agentProvider: 'codex'
    } });
    taskId = readOnlyStarted.task.id;
    fs.writeFileSync(path.join(projectRoot, 'runtime-status.txt'), 'external runtime update');
    async function readOnlyCheckpoint(expected) {
      const until = Date.now() + 120000;
      let value;
      do {
        value = services.taskService.runtime.get({ id: taskId }).task;
        if (value.checkpoint?.summary?.includes(expected)) return value;
        if (['blocked', 'failed', 'cancelled'].includes(value.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < until);
      assert.fail('read-only turn must complete after source drift: ' + JSON.stringify({ status: value.status, code: value.progress?.note }));
    }
    const readOnly = await readOnlyCheckpoint('READONLY_HELLO_OK');
    const readOnlyNative = services.agentBroker.require('codex');
    const sinceReadOnly = readOnlyNative._sessions.get(readOnly.currentAgent.sessionId).nextSequence;
    const nextEvents = []; const nextAbort = new AbortController();
    const nextTimer = setTimeout(() => nextAbort.abort(), 120000);
    try {
      const reader = (async () => {
        for await (const event of services.agentBroker.follow({ ...readOnly.currentAgent, sinceSequence: sinceReadOnly, signal: nextAbort.signal })) {
          nextEvents.push(event); if (event.type === 'turn/end') return;
        }
      })();
      await services.agentBroker.send({ ...readOnly.currentAgent, content: 'Read sample.ts and reply READONLY_NEXT_4217. Do not modify files.' });
      await reader;
      assert.equal(nextEvents.at(-1)?.data?.reason?.kind, 'completed');
      assert.match(nextEvents.filter(event => event.type === 'assistant/message').at(-1)?.data?.message?.content?.[0]?.text ?? '', /READONLY_NEXT_4217/);
    } finally { clearTimeout(nextTimer); nextAbort.abort(); }
    const nextReadOnly = services.taskService.runtime.get({ id: taskId }).task;
    assert.equal(nextReadOnly.status, 'running', 'completed read-only turns do not block the Task');
    assert.equal(fs.readFileSync(path.join(projectRoot, 'runtime-status.txt'), 'utf8'), 'external runtime update');
    await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: taskId, expectedRev: nextReadOnly.rev } });
    process.stdout.write('PASS real read-only hello and next analysis turn survive external runtime-file updates without Task recovery\n');


  }
} finally {
  if (services && taskId) {
    try {
      const task = services.taskService.runtime.get({ id: taskId }).task;
      if (!['completed', 'cancelled', 'failed'].includes(task.status)) {
        await services.desktopUiService.execute({ method: 'ui.task.cancel', params: { id: taskId, expectedRev: task.rev } });
      }
    } catch (error) { process.stderr.write(`Real Codex fixture cleanup warning: ${error?.code ?? error?.message}\n`); }
  }
  if (services) await services.capabilityService.close();
  fs.rmSync(root, { recursive: true, force: true });
}
if (unavailableReason) {
  process.stdout.write(`NOT_RUN_ENVIRONMENT: ${unavailableReason}\n`);
  process.exitCode = 77;
}
