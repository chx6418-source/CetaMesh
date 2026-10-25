import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-child-recovery-'));
const config = { stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') };
let first;
let restarted;
try {
  first = createCetaMeshServices(config);
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'source.txt'), 'fixture');
  const { workspace } = await first.workspaceService.execute({ method: 'workspace.create',
    params: { name: 'Recovery fixture', root: workspaceRoot } });
  const rt = first.taskService.runtime;
  const parent = rt.create({ goal: 'Recover child read', workspaceId: workspace.id });
  const child = rt.createChild({ parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'recovery-child', goal: 'Read source', workspaceId: workspace.id,
    contract: { mode: 'read-only', outputKind: 'analysis', readScope: ['source.txt'], expectedEvidence: ['source'] } });
  const running = rt.start({ id: child.id, expectedRev: child.rev,
    provider: 'cetamesh', sessionId: 'pre-restart-session' }).task;
  const started = rt.recordAttempt({ id: child.id, expectedRev: running.rev,
    provider: 'cetamesh', sessionId: 'pre-restart-session', requestId: 'pre-restart-run', state: 'started' });
  rt.settleAttempt({ id: child.id, expectedRev: started.rev,
    requestId: 'pre-restart-run', state: 'accepted', nativeRequestId: 'native-before-restart' });
  first.chatService.close();
  await first.capabilityService.close();
  first = null;

  restarted = createCetaMeshServices(config);
  const blocked = restarted.taskService.runtime.get({ id: child.id }).task;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.attempts[0].state, 'unknown');
  let sends = 0;
  restarted.agentBroker.send = async () => ({ accepted: true, requestId: `fixture-recovery-${++sends}` });
  const result = await restarted.desktopUiService.execute({ method: 'ui.task.reconcile', params: {
    id: child.id, expectedRev: blocked.rev, reviewed: true,
    reviewSummary: 'Owner checked the non-Git Workspace and prior read effect',
    nextInstruction: 'Read source.txt again and report observed evidence',
    requestId: 'owner-recovery-run', provider: 'cetamesh'
  } });
  assert.equal(result.task.id, child.id);
  assert.equal(result.task.status, 'running');
  assert.equal(restarted.taskService.runtime.get({ id: child.id }).task.attempts[0].state, 'reviewed');
  assert.equal(sends, 1, 'Owner review starts one fresh native instruction');
  console.log('PASS child Core restart -> unknown Attempt -> Owner Workspace review -> one fresh instruction');
} finally {
  if (restarted) { restarted.chatService.close(); await restarted.capabilityService.close(); }
  if (first) { first.chatService.close(); await first.capabilityService.close(); }
  fs.rmSync(root, { recursive: true, force: true });
}
