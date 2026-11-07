// Ordinary Workspace, Task, Capability, Extension content and Skill services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';
import { createSettingsService } from '../src/settings/service.js';
import { createSkillContentService } from '../src/context/skills.js';
import { createSkillSourceAuthorizer } from '../src/context/skill-source-authorization.js';
import { createExtensionStore } from '../src/extension/store.js';
import { createExtensionRuntime } from '../src/extension/runtime.js';

const sandbox = createSuiteSandbox({ suiteId: 'skill-source-authorization' });
let failed = true, extensionRuntime;
const owner = Object.freeze({ kind: 'owner', id: 'desktop' });
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const document = name => `---\nname: ${name}\ndescription: Owned ${name} reference\n---\nUse reference text only. allowed-tools: filesystem.write`;
try {
  const stateDir = path.join(sandbox.root, 'state'), project = path.join(sandbox.root, 'project'), library = path.join(sandbox.root, 'library');
  write(path.join(project, '.cetamesh/skills/project-ref/SKILL.md'), document('project-ref'));
  write(path.join(library, 'user-ref/SKILL.md'), document('user-ref'));
  const workspaceService = createWorkspaceService({ stateDir }), taskRuntime = createTaskRuntime({ stateDir });
  const workspace = (await workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Owned Skill project' } })).workspace;
  const capabilityService = createCapabilityService({ stateDir, workspaceService, taskRuntime });
  const task = taskRuntime.create({ goal: 'Read owned Skill references', workspaceId: workspace.id });
  capabilityService.grantTask(task.id, { capabilities: ['filesystem.read'] });
  const settings = createSettingsService({ stateDir });
  await settings.execute({ method: 'settings.skillSources.register', actor: owner,
    params: { sourceId: 'owned-library', root: library, enabled: true, expectedRev: 0 } });
  const packageRoot = path.join(sandbox.root, 'package');
  write(path.join(packageRoot, 'extension.json'), JSON.stringify({ manifestVersion: 1, id: 'owned-reference', name: 'Owned reference', version: '1.0.0',
    type: 'workflow', contentProfile: 'skill-reference-v1', entry: 'SKILL.md', minCetaMeshVersion: '1.0.0-rc.2', permissions: ['skill.read'],
    capabilities: [{ id: 'reference', kind: 'skill-reference', requires: ['skill.read'] }] }));
  write(path.join(packageRoot, 'SKILL.md'), document('installed-ref'));
  extensionRuntime = createExtensionRuntime({ store: createExtensionStore({ stateDir }), monitorIntervalMs: 0,
    hostFactory() { throw Error('Skill reference must not execute'); } });
  extensionRuntime.install({ sourceDir: packageRoot, approval: { approved: true, token: extensionRuntime.review({ sourceDir: packageRoot }).review.token } });
  extensionRuntime.enable({ id: 'owned-reference' });
  const userSources = () => settings.store.get().settings.extensions.skillSources;
  const authorization = createSkillSourceAuthorizer({ capabilityService, taskRuntime, workspaceService, userSources, extensionRuntime });
  const skills = createSkillContentService({ workspaceService, extensionRuntime, userSources, authorizeSource: authorization.authorizeSource });
  const principal = authorization.principalForTask(task.id);
  const request = { principal, taskId: task.id, workspaceId: workspace.id };
  const beforeTask = taskRuntime.get({ id: task.id }).task;
  const beforeActor = capabilityService.principalForTask(task.id);
  const index = await skills.list(request);
  assert.deepEqual(index.entries.map(row => row.sourceKind), ['project', 'user', 'installed']);
  for (const entry of index.entries) {
    const page = await skills.read({ ...request, skillId: entry.skillId, sourceRevision: entry.sourceRevision });
    assert.match(page.content, /Use reference text only/);
  }
  const context = await skills.buildContext({ ...request, selectedRefs: index.entries.map(({ skillId, sourceRevision }) => ({ skillId, sourceRevision })) });
  assert.equal(context.selected.length, 3); assert.match(context.text, /untrusted Skill reference/);
  assert.deepEqual(taskRuntime.get({ id: task.id }).task, beforeTask);
  assert.deepEqual(capabilityService.principalForTask(task.id), beforeActor);
  assert.deepEqual(capabilityService.broker.approvals.list(), []);
  assert.equal(fs.existsSync(path.join(stateDir, 'capability/dispatches.json')), false, 'authorization queries do not dispatch or write effects');
  const forged = await skills.list({ ...request, principal: structuredClone(principal) });
  assert.deepEqual(forged.entries, [], 'copied principal data is not trusted issuance');
  await assert.rejects(capabilityService.broker.assertReadAuthorization({ actor: beforeActor, capability: 'filesystem.write', taskId: task.id, workspaceId: workspace.id, input: { path: '.cetamesh/skills' } }), { code: 'READ_AUTHORIZATION_ONLY' });
  await assert.rejects(capabilityService.broker.assertReadAuthorization({ actor: beforeActor, capability: 'filesystem.read', taskId: task.id, workspaceId: workspace.id, input: { path: '../outside' } }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  // Same identity, changed registration: old selected ref must remain stale.
  const user = index.entries.find(row => row.sourceKind === 'user');
  let state = settings.store.get();
  await settings.execute({ method: 'settings.skillSources.setEnabled', actor: owner, params: { sourceId: 'owned-library', enabled: false, expectedRev: state.revision } });
  await assert.rejects(skills.read({ ...request, skillId: user.skillId, sourceRevision: user.sourceRevision }), { code: 'SKILL_SOURCE_UNAVAILABLE' });
  state = settings.store.get();
  await settings.execute({ method: 'settings.skillSources.setEnabled', actor: owner, params: { sourceId: 'owned-library', enabled: true, expectedRev: state.revision } });
  await assert.rejects(skills.read({ ...request, skillId: user.skillId, sourceRevision: user.sourceRevision }), { code: 'SKILL_SOURCE_STALE' });
  // The same exact child contract applies to discovery and body reads.
  const scopedChild = taskRuntime.createChild({ parentTaskId: task.id, expectedParentRev: taskRuntime.get({ id: task.id }).task.rev,
    requestId: 'skill-child-allowed', goal: 'Read project reference', workspaceId: workspace.id,
    contract: { mode: 'read-only', outputKind: 'analysis', readScope: ['.cetamesh/skills'], expectedEvidence: ['Project reference analysis'] } });
  capabilityService.grantTask(scopedChild.id, { capabilities: ['filesystem.read'] });
  const scopedRequest = { taskId: scopedChild.id, workspaceId: workspace.id, principal: authorization.principalForTask(scopedChild.id) };
  assert.deepEqual((await skills.list(scopedRequest)).entries.map(row => row.sourceKind), ['project']);
  const outsideChild = taskRuntime.createChild({ parentTaskId: task.id, expectedParentRev: taskRuntime.get({ id: task.id }).task.rev,
    requestId: 'skill-child-denied', goal: 'Read other directory', workspaceId: workspace.id,
    contract: { mode: 'read-only', outputKind: 'analysis', readScope: ['docs'], expectedEvidence: ['Scoped analysis'] } });
  fs.mkdirSync(path.join(project, 'docs'));
  capabilityService.grantTask(outsideChild.id, { capabilities: ['filesystem.read'] });
  assert.deepEqual((await skills.list({ taskId: outsideChild.id, workspaceId: workspace.id, principal: authorization.principalForTask(outsideChild.id) })).entries, []);
  // Live grant revocation invalidates even an already-issued principal for every source.
  capabilityService.grantTask(task.id, { capabilities: [] });
  assert.deepEqual((await skills.list(request)).entries, []);
  assert.deepEqual((await skills.list({ ...request, principal: authorization.principalForTask(task.id) })).entries.map(row => row.sourceKind), ['user', 'installed'],
    'explicit reference libraries require current Task authority but do not require broad filesystem tool grants');
  taskRuntime.block({ id: task.id, expectedRev: taskRuntime.get({ id: task.id }).task.rev, reason: 'Owned blocked Task fixture' });
  assert.deepEqual((await skills.list({ ...request, principal: authorization.principalForTask(task.id) })).entries, []);
  assert.deepEqual((await skills.list({ ...request, principal: authorization.ownerPrincipal({ taskId: task.id }) })).entries.map(row => row.sourceKind), ['project', 'user', 'installed'],
    'Owner can inspect exact blocked Task/Workspace references while Agent execution remains denied');
  // High-risk/approval-required descriptors cannot be queried into a read approval.
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy({ resolveWorkspace: id => id === workspace.id ? workspace : null }) }); let executed = false;
  broker.register({ id: 'filesystem.read', permission: 'filesystem.read', provider: 'workspace', workspace: true, readOnly: true,
    effect: 'read-only', risk: 'high', execute() { executed = true; } });
  await assert.rejects(broker.assertReadAuthorization({ actor: owner, capability: 'filesystem.read', input: { path: 'a' } }), { code: 'WORKSPACE_REQUIRED' });
  await assert.rejects(broker.assertReadAuthorization({ actor: owner, workspaceId: workspace.id, capability: 'filesystem.read', input: { path: 'a' } }), { code: 'READ_AUTHORIZATION_APPROVAL_REQUIRED' });
  await assert.rejects(broker.assertReadAuthorization({ actor: owner, approved: true, workspaceId: workspace.id, capability: 'filesystem.read', input: { path: 'a' } }), { code: 'READ_AUTHORIZATION_ONLY' });
  assert.equal(executed, false); assert.deepEqual(broker.approvals.list(), []);
  console.log('PASS Skill authorization: real Core project/user/reviewed installed reads, unchanged grants/Task, denied forged/stale/revoked/outside refs, zero dispatch');
  failed = false;
} finally { await extensionRuntime?.close?.(); finalizeSuiteSandbox({ sandbox, failed }); }
