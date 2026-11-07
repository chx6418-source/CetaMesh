import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCetaMeshServices} from '../src/app/service-container.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dsh-sdk-composition-'));
let services;
try {
  services = createCetaMeshServices({stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'), deferOptionalStart: true});
  const response = await services.desktopUiService.execute({method: 'ui.agent.configure', params: {
    agentId: 'dsh', config: {taskTransport: 'sdk', runtimePath: path.join(root, 'not-installed', 'package.json'),
      model: 'explicit-task-model', baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-composition-key'}
  }});
  assert.equal(response.supported, true, 'formal DSH task configuration must reach the existing Agent settings service');
  assert.equal(response.applied, true);
  assert.equal(response.configuration.provider, 'dsh');
  assert.equal(response.configuration.model, 'explicit-task-model');
  assert.equal(response.configuration.credentialConfigured, true);
  const health = await services.desktopUiService.execute({method: 'ui.agent.health', params: {provider: 'dsh'}});
  assert.equal(health.taskEligible, false, 'configuration save cannot fabricate CLI or tool bridge readiness');
  assert.equal(health.dshExecution.bridgeState, 'unavailable');
  assert.equal(health.dshExecution.legacyConnection.available, false);
  assert.equal(health.runtimeConfiguration.model, 'explicit-task-model');
  assert.equal(JSON.stringify(health).includes('synthetic-composition-key'), false);
  assert.equal(JSON.stringify(response).includes('synthetic-composition-key'), false);
  assert.equal(services.agentService.listProviders().filter(row => row.id === 'dsh').length, 1, 'SDK transport uses the one existing DSH provider');
  const same = await services.desktopUiService.execute({method: 'ui.agent.configure', params: {agentId: 'dsh', config: {taskTransport: 'sdk', enabled: false}}});
  assert.equal(same.configuration.enabled, false);
  console.log('PASS formal DSH settings, honest bridge eligibility, credential redaction and one provider registration');
} finally {
  if (services) for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  fs.rmSync(root, {recursive: true, force: true});
}
