import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-service-container-'));
const originalDataDir = process.env.WHALEBRIDGE_DATA_DIR;
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
let onExit = null;

try {
  process.env.WHALEBRIDGE_DATA_DIR = root;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error('service construction must not fetch');
  };

  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const config = { allow: { private: [], groups: ['7'] } };
  const services = createCetaMeshServices({ config });

  const validateChannelSend = id => services.capabilityService.broker.registry.require('channel.send').validate({
    input: { kind: 'group', id: String(id), text: 'message' }
  });
  assert.doesNotThrow(() => validateChannelSend('7'), 'initial allowlist entry is accepted');
  assert.throws(() => validateChannelSend('8'), { code: 'TARGET_NOT_ALLOWED' });
  config.allow = { private: [], groups: ['8'] };
  assert.throws(() => validateChannelSend('7'), { code: 'TARGET_NOT_ALLOWED' }, 'replaced allowlist removes the old entry');
  assert.doesNotThrow(() => validateChannelSend('8'), 'replaced allowlist adds the new entry');

  for (const name of [
    'modelRuntime',
    'chatService',
    'routerService',
    'taskService',
    'memoryService',
    'agentService',
    'workspaceService',
    'capabilityService',
    'continuityService',
    'extensionService',
    'workshopService',
    'meshService',
    'channelService',
    'settingsService'
  ]) {
    assert.ok(services[name], name + ' should be constructed');
  }
  const providers = services.agentService.listProviders().map((provider) => provider.id);
  assert.ok(providers.includes('cetamesh'), 'local CetaMesh Agent Provider remains available');
  assert.ok(providers.includes('dsh'), 'DSH provider remains registered without a transport');
  assert.ok(providers.includes('codex'), 'Codex provider remains registered when unavailable');
  assert.ok(providers.includes('zcode'), 'ZCode provider remains registered when unavailable');
  const dshHealth = await services.agentService.execute({ method: 'agent.health', params: { provider: 'dsh' } });
  assert.equal(dshHealth.available, false);
  assert.equal(dshHealth.reason, 'not_connected');
  assert.equal(networkAttempts, 0, 'constructing Core services does not make network requests');

  const { createApplicationLifecycle } = await import('../src/app/lifecycle.js');
  const lifecycle = createApplicationLifecycle({
    processRef: {
      once(event, handler) {
        assert.equal(event, 'exit');
        onExit = handler;
      }
    },
    log: () => {}
  });
  const closed = [];
  lifecycle.register(() => closed.push('first'));
  lifecycle.register(() => closed.push('second'));
  lifecycle.bind();
  onExit();
  assert.deepEqual(closed, ['second', 'first'], 'application services close in reverse registration order');
  onExit();
  assert.deepEqual(closed, ['second', 'first'], 'exit cleanup is idempotent');

  console.log('PASS Core container registers all Agent Providers without DSH or QQ network requests');
} finally {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
}
