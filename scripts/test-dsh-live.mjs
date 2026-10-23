// Opt-in real DSH acceptance. Only synthetic input and an isolated Workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readJsonFile } from '../src/storage/json-file.js';
import { createDshCoreConnector } from '../src/agent/dsh-core-connector.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';

const sandbox = createSuiteSandbox({ suiteId: 'dsh-live' });
let core;
let failed = true;
const createdSessions = new Set();
const archivedSessions = new Set();
try {
  const userData = process.env.WHALEBRIDGE_DSH_TEST_DATA_DIR || path.join(process.env.LOCALAPPDATA, 'WhaleBridge');
  const config = readJsonFile(path.join(userData, 'config.json'));
  const connector = createDshCoreConnector({ config, stateDir: path.join(userData, 'state'), dataRoot: userData });
  const callEndpoint = connector.api.callEndpoint.bind(connector.api);
  connector.api.callEndpoint = async (endpoint, args, ...options) => {
    const result = await callEndpoint(endpoint, args, ...options);
    if (endpoint === 'session/create' && result?.sessionId) createdSessions.add(result.sessionId);
    if (endpoint === 'workspace/archiveSession' && createdSessions.has(args?.request?.sessionId)) {
      archivedSessions.add(args.request.sessionId);
    }
    return result;
  };
  const workspaceRoot = path.join(sandbox.root, 'synthetic-workspace');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'readme.txt'), 'Synthetic DSH connectivity fixture.');
  core = createCetaMeshServices({ api: connector.api, config: { dsh: config.dsh ?? {} },
    stateDir: path.join(sandbox.root, 'state'), dataRoot: path.join(sandbox.root, 'data'),
    agentStagingRoot: path.join(sandbox.root, 'stages'), dshPresetConfig: connector.presetConfig });
  const { workspace } = await core.workspaceService.execute({ method: 'workspace.create', params: { root: workspaceRoot, name: 'DSH connectivity fixture' } });
  const chat = await core.chatService.execute({ method: 'chat.sessions.create', params: {} });
  await core.chatService.execute({ method: 'chat.config.set', params: { id: chat.id,
    config: { agentProvider: 'dsh', workspaceId: workspace.id } } });
  await core.chatService.execute({ method: 'chat.send', params: { id: chat.id,
    text: 'Connectivity test only. Reply exactly CetaMesh_DSH_OK. Do not use tools, read files, or modify files.' } });
  let answer;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const history = await core.chatService.execute({ method: 'chat.history', params: { id: chat.id } });
    const row = history.messages.at(-1);
    if (row?.role === 'assistant') { answer = row; break; }
    await delay(250);
  }
  assert.ok(answer, 'real DSH turn finished before the deadline');
  assert.equal(answer.errorCode, undefined, `real DSH error code: ${answer.errorCode ?? 'none'}`);
  assert.ok(answer.text.includes('CetaMesh_DSH_OK'), 'real DSH returned the requested connectivity marker');
  assert.equal(answer.toolActivity?.length ?? 0, 0, 'connectivity request used no tools');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'readme.txt'), 'utf8'), 'Synthetic DSH connectivity fixture.');
  console.log('PASS real Core Chat -> Task -> Broker -> staged DSH -> native Follow -> final response; synthetic Workspace only');
  failed = false;
} finally {
  try {
    if (core) {
      await core.chatService.close();
      await core.capabilityService.close();
      await core.agentService.close();
    }
    assert.deepEqual(archivedSessions, createdSessions, 'all owned native DSH fixture Sessions were archived');
  } finally {
    finalizeSuiteSandbox({ sandbox, failed });
  }
}
