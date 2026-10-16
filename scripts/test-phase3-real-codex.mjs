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
