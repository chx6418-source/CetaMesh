import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-core-isolation-'));
const stateDir = path.join(root, 'state');
const workspaceRoot = path.join(root, 'workspace');
const originalFetch = globalThis.fetch;
let application;
let networkAttempts = 0;

try {
  fs.mkdirSync(path.join(stateDir, 'integrations'), { recursive: true });
  fs.mkdirSync(workspaceRoot);
  const corruptBionicState = path.join(stateDir, 'social-v2.json');
  const corruptPluginState = path.join(stateDir, 'integrations', 'plugins.json');
  fs.writeFileSync(corruptBionicState, '{broken social state');
  fs.writeFileSync(corruptPluginState, '{broken plugin state');
  const originalSocial = fs.readFileSync(corruptBionicState);
  const originalPlugin = fs.readFileSync(corruptPluginState);
  const corruptChannel = path.join(stateDir, 'channel', 'delivery.json');
  fs.mkdirSync(path.dirname(corruptChannel), { recursive: true });
  fs.writeFileSync(corruptChannel, '{broken channel journal');
  globalThis.fetch = async () => { networkAttempts += 1; throw new Error('unexpected network request'); };

  const { bootstrapCetaMesh } = await import('../src/app/bootstrap.js');
  application = bootstrapCetaMesh({
    config: { allow: { private: [], groups: [] } }, dataRoot: root, stateDir,
    sourceRoot: path.resolve(import.meta.dirname, '..'),
    resourceRoot: path.resolve(import.meta.dirname, '..'),
    socialV2File: corruptBionicState
  });
  const { services } = application;
  assert.equal((await services.agentService.execute({ method: 'agent.health', params: { provider: 'dsh' } })).available, false);
  const { workspace } = await services.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Isolated Core', root: workspaceRoot }
  });
  const task = services.taskService.runtime.create({ goal: 'Core remains usable', workspaceId: workspace.id });
  assert.equal(services.taskService.runtime.get({ id: task.id }).task.id, task.id);
  const memory = services.memoryService.runtime.create({
    principal: { kind: 'user', id: 'desktop' }, type: 'knowledge', scope: 'global', content: 'Isolated Core memory'
  });
  assert.equal(services.memoryService.runtime.get({ principal: { kind: 'user', id: 'desktop' }, id: memory.id }).memory.id, memory.id);
  await assert.rejects(services.integrationService.execute({ method: 'plugins.overview' }),
    { code: 'INTEGRATION_STORE_CORRUPT' });
  assert.equal(networkAttempts, 0);
  await assert.rejects(services.channelService.execute({ method: 'channel.delivery.status' }), { code: 'CHANNEL_JOURNAL_UNAVAILABLE' });
  assert.equal(fs.readFileSync(corruptChannel, 'utf8'), '{broken channel journal');
  assert.deepEqual(fs.readFileSync(corruptBionicState), originalSocial);
  assert.deepEqual(fs.readFileSync(corruptPluginState), originalPlugin);
  console.log('PASS isolated Core Task/Memory/Workspace survive absent DSH and corrupt optional social/plugin state');
} finally {
  application?.lifecycle.stop();
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
