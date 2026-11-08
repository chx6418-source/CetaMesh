import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTaskService } from '../src/task/service.js';
import { createTaskStore as createOldTaskStore } from './fixtures/task-store-v1-reader.mjs';

const legacySource = fs.readFileSync(new URL('./fixtures/task-store-v1-reader.mjs', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n').split('\n').slice(4).join('\n')
  .replace("from '../../src/storage/json-file.js'", "from '../storage/json-file.js'")
  .replace("from '../../src/task/types.js'", "from './types.js'");
assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(legacySource)}\0`).update(legacySource).digest('hex'),
  '8bab4e8ef0ae5cea9b66757314fc50bebcbdfafa', 'compatibility fixture executes the actual frozen old reader');

// Task-domain contract/real persistence evidence only. This fixture does not
// stand in for the separately required Core worktree/approval/concurrency loop.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-writer-contract-')));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = name => {
  const root = path.join(base, name); fs.mkdirSync(root);
  const stat = fs.statSync(root, {bigint: true});
  return {path: root, device: String(stat.dev), file: String(stat.ino)};
};
const sourceRootIdentity = identity('source'), gitCommonIdentity = identity('git-common');
const roots = {a: identity('a'), b: identity('b'), c: identity('c')};
const stateDir = path.join(base, 'state');
let stale = false;
const resolver = ({parentTask, workspaceId, provisionOperationId}) => ({
  version: 1, parentTaskId: parentTask.id, sourceWorkspaceId: parentTask.workspaceId,
  workspaceId, provisionOperationId, receiptSha256: (stale ? 'b' : 'a').repeat(64),
  baselineHead: 'a'.repeat(40), baselineSha256: 'c'.repeat(64), branch: `codex/${workspaceId}`,
  rootIdentity: roots[workspaceId], sourceRootIdentity, gitCommonIdentity
});
const contract = {mode: 'isolated-write', outputKind: 'changes', readScope: ['src'],
  writeScope: ['src'], expectedEvidence: ['filesystem.write']};
try {
  const service = createTaskService({stateDir, resolveIsolatedChildWorkspace: resolver});
  const call = (method, params) => service.execute({method, params});
  const parent = await call('task.create', {goal: 'Two isolated writers', workspaceId: 'source'});
  const file = path.join(stateDir, 'tasks', 'tasks.json');
  const original = fs.readFileSync(file);
  assert.equal(JSON.parse(original).schemaVersion, 1);
  const args = {parentTaskId: parent.id, expectedParentRev: parent.rev, requestId: 'writer-a',
    goal: 'Write A', workspaceId: 'a', provisionOperationId: 'provision-a', contract};
  const child = await call('task.child.create', args);
  assert.equal(child.workspaceId, 'a');
  assert.equal(child.childContract.mode, 'isolated-write');
  assert.equal(child.childContract.isolation.receiptSha256, 'a'.repeat(64));
  assert.equal(child.childContract.isolation.parentTaskId, parent.id);
  assert.equal((await call('task.child.create', args)).id, child.id);
  assert.equal(JSON.parse(fs.readFileSync(file)).schemaVersion, 2);
  const backups = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('tasks.pre-isolated-writer-v1.'));
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), backups[0])), original);
  await assert.rejects(call('task.child.create', {...args, requestId: 'duplicate-a'}), {code: 'TASK_CHILD_WORKSPACE_CLAIMED'});
  const second = await call('task.child.create', {...args, requestId: 'writer-b', workspaceId: 'b', provisionOperationId: 'provision-b'});
  assert.notEqual(second.workspaceId, child.workspaceId);
  await assert.rejects(call('task.child.create', {...args, requestId: 'writer-c', workspaceId: 'c', provisionOperationId: 'provision-c'}), {code: 'TASK_CHILD_LIMIT'});
  await assert.rejects(call('task.start', {id: parent.id, expectedRev: parent.rev}), {code: 'TASK_CHILD_ACTIVE'});
  await assert.rejects(call('task.update', {id: child.id, expectedRev: child.rev, workspaceId: 'source'}), {code: 'TASK_CHILD_LINKED'});
  await assert.rejects(call('task.child.create', {...args, requestId: 'spoof', contract: {...contract, isolation: resolver({parentTask: parent, workspaceId: 'a', provisionOperationId: 'provision-a'})}}), {code: 'INVALID_PARAMS'});
  await assert.rejects(call('task.child.create', {...args, requestId: 'escape', contract: {...contract, writeScope: ['../outside']}}), {code: 'TASK_CHILD_SCOPE_DENIED'});
  service.runtime.assertChildParentCurrent({id: child.id, workspaceId: 'a'});
  stale = true;
  assert.throws(() => service.runtime.assertChildParentCurrent({id: child.id, workspaceId: 'a'}), {code: 'TASK_CHILD_ISOLATION_CHANGED'});
  await assert.rejects(call('task.start', {id: child.id, expectedRev: child.rev}), {code: 'TASK_CHILD_ISOLATION_CHANGED'});
  stale = false;
  const beforeOldReader = fs.readFileSync(file);
  assert.throws(() => createOldTaskStore({stateDir}).listAll(), {code: 'STORE_CORRUPT'});
  assert.equal(hash(fs.readFileSync(file)), hash(beforeOldReader), 'old reader preserves original v2 bytes');
  const reopened = createTaskService({stateDir, resolveIsolatedChildWorkspace: resolver});
  assert.equal(reopened.runtime.countAll(), 3);
  assert.equal(reopened.runtime.get({id: child.id}).task.childContract.isolation.provisionOperationId, 'provision-a');
  const disabled = createTaskService({stateDir});
  assert.equal(disabled.runtime.countAll(), 3, 'disabled admission retains inspectable writer evidence');
  await assert.rejects(disabled.execute({method: 'task.start', params: {id: child.id, expectedRev: child.rev}}), {code: 'TASK_CHILD_ISOLATION_UNAVAILABLE'});
  const otherState = path.join(base, 'missing-callback');
  const missing = createTaskService({stateDir: otherState});
  const otherParent = await missing.execute({method: 'task.create', params: {goal: 'No callback', workspaceId: 'source'}});
  await assert.rejects(missing.execute({method: 'task.child.create', params: {...args, parentTaskId: otherParent.id, expectedParentRev: otherParent.rev}}), {code: 'TASK_CHILD_ISOLATION_UNAVAILABLE'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(otherState, 'tasks', 'tasks.json'))).schemaVersion, 1);
  const asyncService = createTaskService({stateDir: path.join(base, 'async-callback'), resolveIsolatedChildWorkspace: async value => resolver(value)});
  const asyncParent = await asyncService.execute({method: 'task.create', params: {goal: 'Async callback refused', workspaceId: 'source'}});
  await assert.rejects(asyncService.execute({method: 'task.child.create', params: {...args, parentTaskId: asyncParent.id, expectedParentRev: asyncParent.rev}}), {code: 'TASK_CHILD_ISOLATION_UNAVAILABLE'});
  // Separate Workspace IDs are insufficient if their physical roots alias.
  roots.alias = roots.a;
  const aliasParent = await call('task.create', {goal: 'Independent parent', workspaceId: 'source'});
  await assert.rejects(call('task.child.create', {...args, parentTaskId: aliasParent.id, expectedParentRev: aliasParent.rev,
    requestId: 'alias-claim', workspaceId: 'alias', provisionOperationId: 'provision-alias'}), {code: 'TASK_CHILD_WORKSPACE_CLAIMED'});
  const nativeChild = service.runtime.get({id: child.id}).task;
  await assert.rejects(call('task.start', {id: child.id, expectedRev: nativeChild.rev, provider: 'codex', sessionId: 'not-started'}), {code: 'TASK_CHILD_PROVIDER_UNVERIFIED'});
  assert.equal(service.runtime.get({id: child.id}).task.status, 'queued');
  for (const [label, mutate] of [
    ['writer-in-v1', raw => {raw.schemaVersion = 1; delete raw.features;}],
    ['missing-feature', raw => {delete raw.features;}],
    ['wrong-parent-binding', raw => {raw.tasks.find(row => row.id === child.id).childContract.isolation.parentTaskId = 'other';}],
  ]) {
    const damagedState = path.join(base, label), damagedDir = path.join(damagedState, 'tasks');
    fs.mkdirSync(damagedDir, {recursive: true});
    const raw = JSON.parse(fs.readFileSync(file)); mutate(raw);
    const damagedFile = path.join(damagedDir, 'tasks.json'), bytes = JSON.stringify(raw);
    fs.writeFileSync(damagedFile, bytes);
    assert.throws(() => createTaskService({stateDir: damagedState}), {code: 'STORE_CORRUPT'});
    assert.equal(fs.readFileSync(damagedFile, 'utf8'), bytes);
  }
  console.log('PASS isolated writer Task contract, v1/v2 persistence, actual old-reader refusal and default-disabled execution (no Core concurrency claim)');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
