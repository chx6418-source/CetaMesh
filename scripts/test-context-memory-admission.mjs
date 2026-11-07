import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { createCetaMeshServices } from '../src/app/service-container.js';

// Actual Core owners with controlled pauses around their real async readers.
// No model request, Agent execution or account credentials are used here.
const sandbox = createSuiteSandbox({ suiteId: 'context-memory-admission' });
let services, failed = true;
try {
  const project = path.join(sandbox.root, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), 'Owned admission fixture.\n');
  services = createCetaMeshServices({ stateDir: path.join(sandbox.root, 'state'), dataRoot: path.join(sandbox.root, 'data'), deferOptionalStart: true });
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Current Memory admission' } })).workspace;
  const rt = services.taskService.runtime;
  let task = rt.create({ workspaceId: workspace.id, goal: 'Inspect the current project conventions' });
  services.capabilityService.grantTask(task.id);
  task = rt.start({ id: task.id, expectedRev: task.rev, provider: 'cetamesh', sessionId: 'admission-owned-session' }).task;
  const bodyMarker = 'ONLY_MEMORY_BODY_NOT_TASK_OR_SKILL';
  const memory = services.memoryService.runtime.create({ principal: { kind: 'user', id: 'desktop' }, type: 'workspace',
    scope: 'workspace:' + workspace.id, content: task.goal + ': ' + bodyMarker + '.' });
  await services.taskService.execute({ method: 'task.memory.link', params: { id: task.id, expectedRev: task.rev, memoryId: memory.id, note: 'Owner selected reference' } });
  const settings = () => services.settingsService.store.get();
  const enable = value => services.settingsService.execute({ method: 'settings.update', params: {
    section: 'memory', values: { enabled: value }, expectedRev: settings().revision } });
  const build = kind => kind === 'agent'
    ? services.productContextService.buildForAgentTurn({ sessionId: 'admission-owned-session', toolCalling: 'unsupported',
      principal: { taskId: task.id, workspaceId: workspace.id, expectedWorkspaceId: workspace.id, actor: services.capabilityService.principalForTask(task.id) } })
    : services.productContextService.buildForChatTurn({ toolCalling: 'unsupported', record: { id: 'admission-owner-chat', taskId: task.id,
      config: { workspaceId: workspace.id, mode: 'chat' } }, memoryQuery: bodyMarker });
  for (const kind of ['agent', 'chat']) for (const boundary of ['workspace', 'skill']) {
    await enable(true);
    assert.ok(JSON.parse((await build(kind)).context).memoryReferences.some(row => row.memoryId === memory.id), 'reference is genuinely available before the interleaving');
    const owner = boundary === 'workspace' ? services.workspaceService : services.skillContentService;
    const method = boundary === 'workspace' ? 'resolvePostWriteVerification' : 'buildContext';
    const original = owner[method]; let entered, release, armed = true;
    const arrival = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    owner[method] = async function (...args) { const result = await original.apply(this, args); if (armed) { armed = false; entered(); await gate; } return result; };
    let pending;
    try {
      pending = build(kind); await arrival;
      await enable(false); assert.equal(settings().settings.memory.enabled, false);
      release(); const result = await pending, context = JSON.parse(result.context);
      assert.deepEqual(context.memoryReferences, [], kind + ' must re-read current Memory enablement after the real ' + boundary + ' reader awaits');
      assert.ok(!result.context.includes(bodyMarker), 'revoked Memory body is absent from the final serialized model input');
      assert.deepEqual(result.experienceMemoryIds, []);
      assert.equal(context.task.id, task.id, 'disabling optional reference recall preserves the current Task');
    } finally { release(); owner[method] = original; await pending?.catch(() => {}); }
    await enable(true);
    assert.ok(JSON.parse((await build(kind)).context).memoryReferences.some(row => row.memoryId === memory.id), 'Owner re-enablement restores ordinary recall without rewriting Memory or Task history');
    console.log('PASS current ' + kind + ' Memory admission across real ' + boundary + ' reader: enabled -> disabled -> enabled');
  }
  assert.equal(services.memoryService.runtime.get({ principal: { kind: 'user', id: 'desktop' }, id: memory.id }).memory.content, memory.content);
  failed = false;
} finally {
  if (services) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[name]?.close?.();
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
