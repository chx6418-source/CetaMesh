#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsService } from '../src/settings/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createChatService } from '../src/desktop/chat-service.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-stage6-settings-'));
try {
  const settingsService = createSettingsService({ stateDir: dir });
  let sent = 0;
  const ui = createDesktopUiService({
    services: { settingsService, chatService: { execute: async () => { sent += 1; return { accepted: true }; } } },
    system: { settings: settingsService }
  });
  const describe = await ui.execute({ method: 'ui.settings.describe' });
  const fields = Object.fromEntries(describe.fields.map(row => [row.section, row.fields.map(field => field.key)]));
  for (const [section, keys] of Object.entries({
    agents: ['defaultAgentPreset', 'allowBackgroundTurns'],
    memory: ['defaultScope'], workspace: ['defaultWorkspaceId', 'boundaryEnforcement'],
    extensions: ['allowLocalImport', 'maxInstalled'],
    security: ['auditRetention'], updates: ['autoCheck'],
    advanced: ['showEngineeringPages', 'logLevel', 'diagnosticsVerbosity']
  })) for (const key of keys) assert.equal(fields[section].includes(key), false, `${section}.${key} must not be editable without a runtime consumer`);
  assert.ok(fields.devices.includes('presenceTtlMs'), 'Mesh TTL is runtime-backed and must remain editable');
  assert.ok(fields.models.includes('reasoningEffort'), 'new-session reasoning setting remains editable');
  await assert.rejects(ui.execute({ method: 'ui.settings.update', params: { section: 'agents', values: { allowBackgroundTurns: false } } }),
    error => error.code === 'SETTING_NOT_IMPLEMENTED');
  await assert.rejects(ui.execute({ method: 'ui.chat.send', params: { id: 'session-1', text: 'inspect', attachments: [
    { name: 'picture.png', mimeType: 'image/png', content: 'fake image' }
  ] } }), error => error.code === 'UNSUPPORTED_ATTACHMENT');
  assert.equal(sent, 0, 'image payload never reaches Chat');
  const chat = createChatService({ stateDir: path.join(dir, 'chat'),
    defaultModelConfig: () => settingsService.store.get().settings.models });
  try {
    await settingsService.execute({ method: 'settings.update', params: { section: 'models', values: { reasoningEffort: 'high' } } });
    const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
    assert.equal(session.config.reasoning, 'high', 'new sessions consume saved reasoning effort');
    await assert.rejects(chat.execute({ method: 'chat.send', params: { id: session.id, text: 'inspect', attachments: [
      { name: 'picture.png', mimeType: 'text/plain', content: 'fake image' }
    ] } }), error => error.code === 'UNSUPPORTED_ATTACHMENT', 'Core also rejects a disguised image');
    const history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
    assert.equal(history.messages.length, 0, 'rejected image is not persisted as a sent user message');
  } finally { chat.close(); }
  console.log('PASS Stage 6 settings visibility and image attachment boundary');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
