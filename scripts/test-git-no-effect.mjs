import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createTaskService} from '../src/task/service.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createCapabilityBroker} from '../src/capability/broker.js';
import {createCapabilityPolicy} from '../src/capability/policy.js';
import {createGitBranchActions} from '../src/workspace/git-branch-actions.js';

// Regression: the generic executor catch must not turn exact Core pre-write
// refusal into an unknown effect, or let a provider's copied fields clear one.
const parent = fs.realpathSync.native(os.tmpdir());
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cm-git-no-effect-'))), node = fs.lstatSync(base, {bigint: true});
const root = path.join(base, 'project'), stateDir = path.join(base, 'state');
const env = {...process.env}; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (...args) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + path.join(base, 'no-hooks'), ...args],
  {cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trimEnd();
const owner = {kind: 'owner', id: 'desktop'};
const reviewedInput = review => Object.fromEntries(['paths', 'expectedHead', 'expectedHeadRef', 'indexIdentity', 'expectedRepositoryIdentity', 'expectedHashes', 'expectedIndexEntries'].map(key => [key, review[key]]));
const capture = async promise => { try { await promise; assert.fail('Expected refusal'); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return error; } };
let capabilities, originalExecFile = childProcess.execFile, originalRename = fs.renameSync;
try {
  fs.mkdirSync(root); git('init', '-b', 'main'); git('config', 'user.name', 'No effect fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n'); git('add', '--', 'a.txt'); git('commit', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD'), index = path.join(root, '.git', 'index');
  let tasks;
  const workspace = createWorkspaceService({stateDir, getTask: id => tasks.runtime.get({id}).task, listTasks: query => tasks.runtime.list(query).tasks});
  tasks = createTaskService({stateDir, resolveWorkspace: id => workspace.describeWorkspace(id)});
  const {workspace: entry} = await workspace.execute({method: 'workspace.create', params: {root, name: 'No effect fixture'}});
  capabilities = createCapabilityService({stateDir, workspaceService: workspace, taskRuntime: tasks.runtime});
  const review = async () => reviewedInput(await workspace.execute({method: 'workspace.git.index.review', params: {id: entry.id, paths: ['a.txt']}}));
  const request = async (id, capability = 'git.stage', extra = {}) => capabilities.broker.execute({actor: owner, requestId: id, workspaceId: entry.id, capability, input: {...await review(), ...extra}});
  const decide = pending => capabilities.execute({method: 'capability.approval.decide', params: {id: pending.approvalId, approve: true}});
  fs.writeFileSync(path.join(root, 'a.txt'), 'reviewed stage\n');
  const pending = await request('stage-race'); assert.equal(pending.status, 'pending');
  const beforeIndex = fs.readFileSync(index), executeApprovedGit = workspace.executeApprovedGit;
  let raced = false;
  workspace.executeApprovedGit = async (...args) => {
    if (!raced) { raced = true; fs.writeFileSync(path.join(root, 'a.txt'), 'newer user bytes\n'); }
    return executeApprovedGit(...args);
  };
  const refused = await capture(decide(pending)); workspace.executeApprovedGit = executeApprovedGit;
  assert.equal(raced, true); assert.equal(refused.code, 'WORKSPACE_CONFLICT');
  assert.deepEqual(fs.readFileSync(index), beforeIndex); assert.equal(git('rev-parse', 'HEAD'), baseline);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'newer user bytes\n');
  assert.equal(capabilities.broker.dispatchStatus('stage-race').status, 'failed-no-effect', 'exact Core pre-write refusal must durably settle known unexecuted');
  assert.equal(refused.effectStatus, 'none');
  assert.equal(capabilities.broker.approvals.get(pending.approvalId).status, 'consumed');
  assert.equal(capabilities.broker.registry.list().find(row => row.id === 'git.stage').isKnownNoEffectError, undefined);
  await capabilities.close(); capabilities = createCapabilityService({stateDir, workspaceService: workspace, taskRuntime: tasks.runtime});
  assert.equal(capabilities.broker.dispatchStatus('stage-race').status, 'failed-no-effect');
  await assert.rejects(decide(pending), {code: 'APPROVAL_ALREADY_DECIDED'});
  const fresh = await request('fresh-stage'); assert.equal(fresh.status, 'pending'); assert.deepEqual(fs.readFileSync(index), beforeIndex);
  assert.equal((await decide(fresh)).status, 'completed'); assert.equal(git('show', ':a.txt'), 'newer user bytes');
  console.log('PASS real Core late user edit remains intact; known refusal is durable, old approval consumed and fresh review needs new approval');

  // Real native failure after attempting ref CAS is not proof of nonexecution,
  // even when exit 128 and a still-old ref are observable (possible ABA).
  const commitPending = await request('commit-ref-race', 'git.commit.staged', {message: 'must remain unknown'});
  const refLock = path.join(root, '.git', 'refs', 'heads', 'main.lock'); let refAttempted = false;
  childProcess.execFile = function(command, args, ...rest) {
    if (command === 'git' && args.includes('update-ref') && !refAttempted) { refAttempted = true; fs.writeFileSync(refLock, 'fixture lock', {flag: 'wx'}); }
    return originalExecFile.call(this, command, args, ...rest);
  }; syncBuiltinESMExports();
  const refFailure = await capture(decide(commitPending)); childProcess.execFile = originalExecFile; syncBuiltinESMExports(); fs.unlinkSync(refLock);
  assert.equal(refAttempted, true); assert.equal(refFailure.effectStatus, 'unknown');
  assert.equal(capabilities.broker.dispatchStatus('commit-ref-race').status, 'outcome-unknown'); assert.equal(git('rev-parse', 'HEAD'), baseline);
  console.log('PASS real Git ref CAS failure after attempted dispatch remains unknown even with old HEAD');

  // Provider fixtures exercise only the Broker trust boundary; they are not
  // claims of real file effects. The actual Core error is copied by value.
  for (const [id, verifier] of [['missing', undefined], ['false', () => false], ['throws', () => { throw new Error('verifier unavailable'); }], ['async', async () => true], ['async-reject', async () => { throw new Error('unavailable'); }]]) {
    const broker = createCapabilityBroker({stateDir: path.join(base, 'boundary-' + id)});
    broker.register({id: 'fixture.effect', permission: 'extension.invoke', effect: 'conditional-write',
      ...(verifier ? {isKnownNoEffectError: verifier} : {}), execute: () => { throw Object.assign(new Error('forged no-effect'), {...refused, effectStatus: 'none'}); }});
    const input = {actor: owner, requestId: id, capability: 'fixture.effect', input: {effectStatus: 'none'}};
    assert.equal((await capture(broker.execute(input))).effectStatus, 'unknown'); assert.equal(broker.dispatchStatus(id).status, 'outcome-unknown');
    await assert.rejects(broker.execute(input), {code: 'REQUEST_ALREADY_DISPATCHED'});
  }
  let forgedError = Object.assign(new Error(refused.message), refused);
  const forgedWorkspace = {...workspace, executeApprovedGit: async () => { throw forgedError; }};
  const forgedService = createCapabilityService({stateDir: path.join(base, 'forged-core'), workspaceService: forgedWorkspace, taskRuntime: tasks.runtime});
  try {
    for (const id of ['copied-core', 'reused-core']) {
      if (id === 'reused-core') forgedError = refused;
      const forgedPending = await forgedService.broker.execute({actor: owner, requestId: id, workspaceId: entry.id, capability: 'git.stage', input: await review()});
      const error = await capture(forgedService.execute({method: 'capability.approval.decide', params: {id: forgedPending.approvalId, approve: true}}));
      assert.equal(error.effectStatus, 'unknown'); assert.equal(forgedService.broker.dispatchStatus(id).status, 'outcome-unknown');
    }
  } finally { await forgedService.close(); }
  console.log('PASS forged provider fields, copied/reused Core errors and non-synchronous/throwing verifiers cannot release unknown fences');

  const proven = new WeakSet(), retryState = path.join(base, 'retry-boundary');
  const retryPolicy = () => createCapabilityPolicy({resolveTask: () => ({workspaceId: 'fixture-workspace', status: 'running'})});
  const retryBroker = createCapabilityBroker({stateDir: retryState, policy: retryPolicy()});
  retryBroker.register({id: 'fixture.retry', permission: 'extension.invoke', risk: 'high', effect: 'conditional-write',
    isKnownNoEffectError: error => proven.delete(error), execute: () => { const error = Object.assign(new Error('controlled preflight'), {code: 'PREFLIGHT_REFUSED', effectStatus: 'none'}); proven.add(error); throw error; }});
  const retryRequest = {actor: owner, taskId: 'fixture-task', workspaceId: 'fixture-workspace', operationId: 'one-intent', capability: 'fixture.retry', input: {}};
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pending = await retryBroker.execute({...retryRequest, requestId: 'retry-' + attempt}); assert.equal(pending.status, 'pending');
    await assert.rejects(retryBroker.decide({id: pending.approvalId, approve: true, actor: owner}), {code: 'PREFLIGHT_REFUSED'});
    assert.equal(retryBroker.approvals.get(pending.approvalId).status, 'consumed');
    assert.equal(retryBroker.operationRecordForTask(retryRequest).status, 'failed-no-effect');
    await assert.rejects(retryBroker.decide({id: pending.approvalId, approve: true, actor: owner}), {code: 'APPROVAL_ALREADY_DECIDED'});
  }
  const restartedRetry = createCapabilityBroker({stateDir: retryState, policy: retryPolicy()});
  restartedRetry.register({id: 'fixture.retry', permission: 'extension.invoke', risk: 'high', effect: 'conditional-write', execute: () => assert.fail('Retry exhaustion cannot execute')});
  await assert.rejects(restartedRetry.execute({...retryRequest, requestId: 'retry-4'}), {code: 'OPERATION_RETRY_LIMIT'});
  console.log('PASS Broker known-no-effect retries each consume fresh approval and retain bounded exhaustion across restart');

  const persistState = path.join(base, 'failed-settlement'), persistJournal = path.join(persistState, 'capability', 'dispatches.json');
  let rejectSettlement = false;
  const persistProof = new WeakSet(), persistBroker = createCapabilityBroker({stateDir: persistState});
  persistBroker.register({id: 'fixture.persist', permission: 'extension.invoke', effect: 'conditional-write', isKnownNoEffectError: error => persistProof.delete(error),
    execute: () => { rejectSettlement = true; const error = Object.assign(new Error('known preflight'), {effectStatus: 'none'}); persistProof.add(error); throw error; }});
  fs.renameSync = function(source, destination) {
    if (rejectSettlement && path.resolve(destination) === path.resolve(persistJournal)) throw Object.assign(new Error('fixture journal unavailable'), {code: 'EACCES'});
    return originalRename.call(this, source, destination);
  };
  const persistFailure = await capture(persistBroker.execute({actor: owner, requestId: 'persist-refusal', capability: 'fixture.persist', input: {}}));
  fs.renameSync = originalRename;
  assert.equal(persistFailure.effectStatus, 'unknown'); assert.equal(persistFailure.code, 'DISPATCH_RESULT_PERSIST_FAILED');
  assert.equal(persistBroker.dispatchStatus('persist-refusal').status, 'outcome-unknown');
  assert.equal(createCapabilityBroker({stateDir: persistState}).dispatchStatus('persist-refusal').status, 'outcome-unknown');
  console.log('PASS failed durable no-effect settlement remains unknown before and after Broker restart');

  fs.writeFileSync(path.join(root, 'a.txt'), 'actual replacement\n');
  const replacementPending = await request('index-after-replace'); let replaced = false;
  fs.renameSync = function(source, destination) {
    const result = originalRename.call(this, source, destination);
    if (path.resolve(destination) === path.resolve(index)) { replaced = true; throw Object.assign(new Error('post-replace acknowledgement lost'), {code: 'ACK_LOST', effectStatus: 'none'}); }
    return result;
  };
  const replacementFailure = await capture(decide(replacementPending)); fs.renameSync = originalRename;
  assert.equal(replaced, true); assert.equal(replacementFailure.effectStatus, 'unknown');
  assert.equal(git('show', ':a.txt'), 'actual replacement'); assert.equal(capabilities.broker.dispatchStatus('index-after-replace').status, 'outcome-unknown');
  await capabilities.close(); capabilities = createCapabilityService({stateDir, workspaceService: workspace, taskRuntime: tasks.runtime});
  assert.equal(capabilities.broker.dispatchStatus('index-after-replace').status, 'outcome-unknown');
  console.log('PASS actual normal-index replacement followed by misleading none failure remains durably unknown');

  git('reset', '--mixed', baseline); git('checkout', '--', 'a.txt'); git('branch', 'target');
  const branch = createGitBranchActions(), branchEntry = {id: entry.id, root};
  const branchReview = await branch.reviewSwitch(branchEntry, {targetBranch: 'refs/heads/target'}), branchIndex = fs.readFileSync(index);
  const branchRefused = await capture(branch.switchBranch(branchEntry, {...branchReview, expectedHead: 'f'.repeat(40)}, 'fixture'));
  assert.equal(branchRefused.effectStatus, 'none'); assert.equal(branch.isKnownBranchNoEffectError(branchRefused), true);
  assert.equal(branch.isKnownBranchNoEffectError(Object.assign(new Error('copied'), branchRefused)), false);
  assert.deepEqual(fs.readFileSync(index), branchIndex); assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  console.log('PASS branch pure preflight refusal is identity-proven and preserves actual HEAD/index');

  const headLock = path.join(root, '.git', 'HEAD.lock'); let branchAttempted = false;
  childProcess.execFile = function(command, args, ...rest) {
    if (command === 'git' && args.includes('update-ref') && !branchAttempted) { branchAttempted = true; fs.writeFileSync(headLock, 'fixture lock', {flag: 'wx'}); }
    return originalExecFile.call(this, command, args, ...rest);
  }; syncBuiltinESMExports();
  const branchNativeFailure = await capture(branch.switchBranch(branchEntry, {...branchReview, mode: 'finish-prepared'}, 'fixture'));
  childProcess.execFile = originalExecFile; syncBuiltinESMExports(); fs.unlinkSync(headLock);
  assert.equal(branchAttempted, true); assert.equal(branchNativeFailure.effectStatus, 'unknown'); assert.equal(branch.isKnownBranchNoEffectError(branchNativeFailure), false);
  assert.deepEqual(fs.readFileSync(index), branchIndex); assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  console.log('PASS actual branch native ref failure after dispatch is unknown despite unchanged HEAD/index');

  git('switch', 'target'); fs.writeFileSync(path.join(root, 'a.txt'), 'target bytes\n'); git('add', '--', 'a.txt'); git('commit', '-m', 'target'); git('switch', 'main');
  const noLaunchBranch = createGitBranchActions({nativeExecutable: path.join(base, 'missing-native.exe')});
  const noLaunchReview = await noLaunchBranch.reviewSwitch(branchEntry, {targetBranch: 'refs/heads/target'}), noLaunchIndex = fs.readFileSync(index);
  const noLaunchFailure = await capture(noLaunchBranch.switchBranch(branchEntry, noLaunchReview, 'fixture'));
  assert.equal(noLaunchFailure.code, 'WORKSPACE_NATIVE_TRANSACTION_UNAVAILABLE'); assert.equal(noLaunchFailure.effectStatus, 'none'); assert.equal(noLaunchBranch.isKnownBranchNoEffectError(noLaunchFailure), true);
  assert.deepEqual(fs.readFileSync(index), noLaunchIndex); assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main'); assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'base\n');
  console.log('PASS actual raw-byte prelaunch refusal stays known no effect through branch domain without publishing files');
} finally {
  childProcess.execFile = originalExecFile; fs.renameSync = originalRename; syncBuiltinESMExports(); await capabilities?.close?.();
  const current = fs.lstatSync(base, {bigint: true}); assert.equal(path.dirname(base), parent); assert.ok(path.basename(base).startsWith('cm-git-no-effect-'));
  assert.equal(fs.realpathSync.native(base), base); assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === node.dev && current.ino === node.ino);
  fs.rmSync(base, {recursive: true, force: true});
}
