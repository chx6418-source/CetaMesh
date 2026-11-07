import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyTaskOutcome } from '../src/task/outcome-verification.js';
import { createTaskService } from '../src/task/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-outcome-'));
try {
  const task = {
    status: 'running', workspaceId: 'ws-one',
    acceptance: [{ id: 'acc-one', text: 'Deliver and verify', met: true }],
    executionEvidence: [], artifacts: [],
    agentReports: [{ text: 'Everything is done', verified: false }]
  };
  const review = verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root });
  assert.equal(review.status, 'NEEDS_REVIEW', 'model claims cannot prove code completion');

  task.executionEvidence = [
    { eventId: 'diff-1', capability: 'git.diff', status: 'completed', hasChanges: false },
    { eventId: 'test-1', capability: 'test.run', status: 'completed', exitCode: 0 }
  ];
  assert.equal(verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW', 'an empty diff is not proof of a code change');
  task.executionEvidence[0].hasChanges = true;
  assert.deepEqual(verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root }), {
    status: 'VERIFIED', kind: 'code', evidenceEventIds: ['diff-1', 'test-1'], reasons: []
  });
  task.executionEvidence.push({eventId:'diff-read-after-test',capability:'git.diff',status:'completed',hasChanges:true});
  assert.equal(verifyTaskOutcome(task,{kind:'code'},{workspaceRoot:root}).status,'VERIFIED','read-only diff inspection after a successful test does not invalidate the result');
  task.executionEvidence.push({eventId:'new-import',capability:'workspace.apply',status:'completed'});
  task.executionEvidence.push({eventId:'fresh-diff-after-import',capability:'git.diff',status:'completed',hasChanges:true});
  assert.equal(verifyTaskOutcome(task,{kind:'code'},{workspaceRoot:root}).status,'NEEDS_REVIEW','a new import still requires testing the changed code');
  task.executionEvidence.splice(2);
  task.executionEvidence.push({ eventId: 'test-failed', capability: 'test.run', status: 'completed', exitCode: 1 });
  assert.equal(verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW',
    'a later failed test invalidates earlier passing evidence');
  task.executionEvidence.pop();
  task.executionEvidence.push({ eventId: 'write-later', capability: 'filesystem.write', status: 'completed', filePath: 'later.js' });
  assert.equal(verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW',
    'a later code change needs a fresh diff and test');
  task.executionEvidence.pop();
  task.executionEvidence.push({ eventId: 'diff-empty', capability: 'git.diff', status: 'completed', hasChanges: false });
  assert.equal(verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW',
    'a later empty diff cannot reuse earlier changed-diff proof');
  task.executionEvidence.pop();
  task.executionEvidence.push({ eventId: 'unknown-1', capability: 'filesystem.write', status: 'outcome-unknown' });
  assert.equal(verifyTaskOutcome(task, { kind: 'code' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW', 'an unresolved side effect blocks automatic verification');
  task.executionEvidence.pop();

  const currentCodeTask = {
    ...task, currentAgent: { provider: 'cetamesh', sessionId: 'current-session' },
    executionObservation: { provider: 'cetamesh', sessionId: 'current-session', runId: 'current-run', state: 'awaiting-review' },
    executionEvidence: [
      { eventId: 'current-diff', capability: 'git.diff', status: 'completed', hasChanges: true,
        provider: 'cetamesh', sessionId: 'current-session', runId: 'current-run', phase: 'user' },
      { eventId: 'current-test', capability: 'test.run', status: 'completed', exitCode: 0,
        provider: 'cetamesh', sessionId: 'current-session', runId: 'current-run', phase: 'user',
        source: 'core-test', resultSha256: 'a'.repeat(64) }
    ]
  };
  const strict = value => verifyTaskOutcome(value, { kind: 'code', requireCurrentCodeEvidence: true }, { workspaceRoot: root });
  assert.equal(strict(currentCodeTask).status, 'VERIFIED');
  const projectedTest = { ...currentCodeTask.executionEvidence[1], eventId: 'tool-result', source: undefined, resultSha256: undefined };
  assert.equal(strict({ ...currentCodeTask, executionEvidence: [...currentCodeTask.executionEvidence, projectedTest] }).status,
    'VERIFIED', 'the current successful Core receipt survives its matching presentation result');
  for (const patch of [{ exitCode: 1 }, { status: 'failed' }, { runId: 'other-run' }, { sessionId: 'other-session' }]) {
    assert.equal(strict({ ...currentCodeTask, executionEvidence: [...currentCodeTask.executionEvidence, { ...projectedTest, ...patch }] }).status,
      'NEEDS_REVIEW', 'a later conflicting test result cannot be ignored');
  }
  for (const patch of [{ runId: 'historical-run' }, { sessionId: 'other-session' }, { provider: 'other-provider' },
    { phase: 'bootstrap' }, { source: 'native-result' }, { source: undefined }, { resultSha256: undefined }]) {
    const stale = { ...currentCodeTask, executionEvidence: [currentCodeTask.executionEvidence[0], { ...currentCodeTask.executionEvidence[1], ...patch }] };
    assert.equal(strict(stale).status, 'NEEDS_REVIEW', 'automatic current-code acceptance rejects ' + JSON.stringify(patch));
    assert.equal(verifyTaskOutcome(stale, { kind: 'code' }, { workspaceRoot: root }).status, 'VERIFIED',
      'explicit legacy/history inspection keeps its existing meaning');
  }
  assert.equal(strict({ ...currentCodeTask, executionObservation: null }).status, 'NEEDS_REVIEW');
  assert.equal(strict({ ...currentCodeTask, currentAgent: { provider: 'cetamesh', sessionId: 'replacement-session' } }).status, 'NEEDS_REVIEW');
  assert.equal(strict({ ...currentCodeTask, executionObservation: { ...currentCodeTask.executionObservation, state: 'unknown' } }).status, 'NEEDS_REVIEW');
  assert.equal(strict({ ...currentCodeTask, executionEvidence: [{ ...currentCodeTask.executionEvidence[0], runId: 'old-run' }, currentCodeTask.executionEvidence[1]] }).status, 'NEEDS_REVIEW',
    'historical diff proof cannot supply the current code change');
  for (const flag of ['true', 1, null]) assert.equal(verifyTaskOutcome(currentCodeTask,
    { kind: 'code', requireCurrentCodeEvidence: flag }, { workspaceRoot: root }).status, 'NEEDS_REVIEW',
  'the optional current-code boundary requires a real boolean');

  fs.writeFileSync(path.join(root, 'result.md'), 'verified content');
  const digest = crypto.createHash('sha256').update('verified content').digest('hex');
  task.executionEvidence = [{ eventId: 'write-1', capability: 'filesystem.write', status: 'completed', filePath: 'result.md' }];
  task.artifacts = [{ id: 'art-one', ref: 'result.md' }];
  assert.equal(verifyTaskOutcome(task, { kind: 'file', expectedFile: 'result.md', expectedSha256: digest }, { workspaceRoot: root }).status, 'VERIFIED');
  assert.equal(verifyTaskOutcome(task, { kind: 'file', expectedFile: 'result.md' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW', 'content needs an independent expected hash');
  assert.equal(verifyTaskOutcome(task, { kind: 'file', expectedFile: '../outside.md', expectedSha256: digest }, { workspaceRoot: root }).status, 'NEEDS_REVIEW', 'outside paths cannot count as proof');

  task.executionEvidence = [{ eventId: 'tool-1', capability: 'test.run', status: 'completed', exitCode: 0 }];
  assert.equal(verifyTaskOutcome(task, { kind: 'tool', expectedCapability: 'test.run' }, { workspaceRoot: root }).status, 'VERIFIED');
  task.executionEvidence.push({ eventId: 'tool-later-failed', capability: 'test.run', status: 'failed', exitCode: 1 });
  assert.equal(verifyTaskOutcome(task, { kind: 'tool', expectedCapability: 'test.run' }, { workspaceRoot: root }).status,
    'NEEDS_REVIEW', 'a later failed execution supersedes earlier success');
  task.executionEvidence.pop();
  task.executionEvidence[0].exitCode = 7;
  assert.equal(verifyTaskOutcome(task, { kind: 'tool', expectedCapability: 'test.run' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW', 'a failed process is not a completed tool task');

  task.executionEvidence = [];
  assert.equal(verifyTaskOutcome(task, { kind: 'analysis' }, { workspaceRoot: root }).status, 'NEEDS_REVIEW', 'semantic evidence requires review');

  const service = createTaskService({ stateDir: path.join(root, 'state'), resolveWorkspace: id => ({ id, root }) });
  const runtime = service.runtime;
  const created = runtime.create({ goal: 'Fix code', workspaceId: 'ws-one', acceptanceCriteria: ['Pass tests'] });
  const started = runtime.start({ id: created.id, expectedRev: created.rev, provider: 'cetamesh', sessionId: 'session-one' }).task;
  runtime.setAcceptance({ id: created.id, expectedRev: started.rev, acceptanceId: started.acceptance[0].id, met: true });
  runtime.recordToolOutcome({ id: created.id, provider: 'cetamesh', sessionId: 'session-one', eventId: 'diff-real',
    capability: 'git.diff', status: 'completed', hasChanges: true });
  runtime.recordToolOutcome({ id: created.id, provider: 'cetamesh', sessionId: 'session-one', eventId: 'test-real',
    capability: 'test.run', status: 'completed', exitCode: 0, retryCount: 1 });
  assert.equal(runtime.get({ id: created.id }).task.executionEvidence.find(row => row.eventId === 'test-real').retryCount,
    1, 'bounded retries must remain visible in Task evidence');
  assert.equal((await runtime.verifyOutcome({ id: created.id, kind: 'code' })).status, 'VERIFIED',
    'real Task evidence must feed the read-only verifier');
  assert.equal((await service.execute({ method: 'task.outcome.verify', params: { id: created.id, kind: 'code' } })).status,
    'VERIFIED', 'Owner Task service must expose the read-only result');
  assert.equal((await service.execute({ method: 'task.outcome.verify', params: { id: created.id, kind: 'code', requireCurrentCodeEvidence: true } })).status,
    'NEEDS_REVIEW', 'the formal Core method must forward the strict option instead of stripping it');
  let replaceRun = false;
  const concurrent = createTaskService({ stateDir: path.join(root, 'concurrent-state'), resolveWorkspace: async id => {
    if (replaceRun) concurrent.runtime.beginExecutionObservation({ id: concurrentId, provider: 'cetamesh', sessionId: 'concurrent-session', runId: 'replacement-run', phase: 'user' });
    return { id, root };
  } });
  let concurrentTask = concurrent.runtime.create({ goal: 'Current run only', workspaceId: 'ws-one', acceptanceCriteria: ['Fixed tests pass'] });
  const concurrentId = concurrentTask.id;
  concurrentTask = concurrent.runtime.start({ id: concurrentId, expectedRev: concurrentTask.rev, provider: 'cetamesh', sessionId: 'concurrent-session' }).task;
  concurrent.runtime.setAcceptance({ id: concurrentId, expectedRev: concurrentTask.rev, acceptanceId: concurrentTask.acceptance[0].id, met: true });
  concurrent.runtime.beginExecutionObservation({ id: concurrentId, provider: 'cetamesh', sessionId: 'concurrent-session', runId: 'verified-run', phase: 'user' });
  for (const row of currentCodeTask.executionEvidence) concurrent.runtime.recordToolOutcome({ ...row, id: concurrentId,
    provider: 'cetamesh', sessionId: 'concurrent-session', runId: 'verified-run', phase: 'user' });
  concurrent.runtime.observeExecution({ id: concurrentId, provider: 'cetamesh', sessionId: 'concurrent-session', runId: 'verified-run', phase: 'user', state: 'awaiting-review' });
  const currentRequest = { method: 'task.outcome.verify', params: { id: concurrentId, kind: 'code', requireCurrentCodeEvidence: true } };
  assert.equal((await concurrent.execute(currentRequest)).status, 'VERIFIED');
  replaceRun = true;
  assert.equal((await concurrent.execute(currentRequest)).status, 'NEEDS_REVIEW',
    'a Run replaced while Workspace resolution awaits cannot return stale current-code success');
  console.log('task outcome verification: objective evidence and review boundary passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
