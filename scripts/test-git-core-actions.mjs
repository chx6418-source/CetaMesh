import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createTaskService} from '../src/task/service.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {workspaceJournalDir} from '../src/workspace/transaction.js';
const parent = fs.realpathSync.native(os.tmpdir()), base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cm-git-core-actions-'))), node = fs.lstatSync(base, {bigint: true});
const env = {...process.env}; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (...args) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + path.join(base, 'no-hooks'), ...args],
  {cwd: path.join(base, 'project'), env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trimEnd();
const reviewedInput = review => Object.fromEntries(['paths', 'expectedHead', 'expectedHeadRef', 'indexIdentity', 'expectedRepositoryIdentity', 'expectedHashes', 'expectedIndexEntries'].map(key => [key, review[key]]));
const executions = new Set(), children = new Set(), originalExecFile = childProcess.execFile;
childProcess.execFile = function(command, args, ...rest) {
  const child = originalExecFile.call(this, command, args, ...rest);
  const closed = new Promise(resolve => child.once('close', resolve));
  children.add(closed); closed.then(() => children.delete(closed)); return child;
};
syncBuiltinESMExports();
async function removeOwned(target, verify) {
  for (let attempt = 0; ; attempt++) {
    verify();
    try { await fs.promises.rm(target, {recursive: true}); return; }
    catch (error) {
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay(50);
    }
  }
}
let capabilities, ownedJournal, primaryError;
try {
  const root = path.join(base, 'project'), stateDir = path.join(base, 'state'); fs.mkdirSync(root);
  git('init', '-b', 'main'); git('config', 'user.name', 'Core fixture'); git('config', 'user.email', 'core@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(root, 'user.txt'), 'user base\n'); git('add', '--', '.'); git('commit', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD'); let tasks;
  const workspace = createWorkspaceService({stateDir, getTask: id => tasks.runtime.get({id}).task, listTasks: query => tasks.runtime.list(query).tasks});
  const executeGit = workspace.executeApprovedGit;
  workspace.executeApprovedGit = function(...args) {
    const execution = executeGit.apply(this, args); executions.add(execution);
    execution.then(() => executions.delete(execution), () => executions.delete(execution)); return execution;
  };
  tasks = createTaskService({stateDir, resolveWorkspace: id => workspace.describeWorkspace(id)});
  const {workspace: entry} = await workspace.execute({method: 'workspace.create', params: {root, name: 'Core Git fixture'}});
  capabilities = createCapabilityService({stateDir, workspaceService: workspace, taskRuntime: tasks.runtime});
  const ui = createDesktopUiService({services: {workspaceService: workspace, taskService: tasks, capabilityService: capabilities}});
  const call = (method, params = {}) => ui.execute({method, params});
  const review = async paths => reviewedInput(await call('ui.workspace.git.index.review', {id: entry.id, paths}));
  const request = (action, input) => call('ui.workspace.git.' + action, {id: entry.id, ...input});
  async function decide(pending, approve = true) {
    const id = pending.approvalId ?? pending.approval?.id; assert.ok(id, JSON.stringify(pending));
    const started = performance.now(), deadline = started + 15000;
    let result = await call('ui.approvals.decide', {id, approve});
    while (['accepted', 'running', 'waiting'].includes(result.status)) {
      if (performance.now() >= deadline) throw Object.assign(new Error('Core approval did not reach a terminal result: ' + JSON.stringify({elapsedMs: performance.now() - started, ...result})), {code: 'TEST_APPROVAL_TIMEOUT'});
      await delay(10); result = await call('ui.approvals.operation', {id: result.operationId});
    }
    assert.ok(['completed', 'failed', 'cancelled', 'unknown'].includes(result.status), JSON.stringify(result));
    return result;
  }
  fs.writeFileSync(path.join(root, 'a.txt'), 'selected stage\n'); fs.writeFileSync(path.join(root, 'user.txt'), 'user staged\n'); git('add', '--', 'user.txt');
  const unrelatedStaged = git('show', ':user.txt'), index = path.join(root, '.git', 'index'), before = fs.readFileSync(index);
  const scope = await review(['a.txt']);
  await assert.rejects(workspace.execute({method: 'workspace.git.stage', params: {id: entry.id, ...scope, approved: true}}), {code: 'GIT_APPROVAL_REQUIRED'});
  const rejected = await request('stage', scope); assert.deepEqual(fs.readFileSync(index), before); await decide(rejected, false);
  assert.deepEqual(fs.readFileSync(index), before); assert.equal(git('rev-parse', 'HEAD'), baseline);
  const staged = await request('stage', await review(['a.txt'])); assert.deepEqual(fs.readFileSync(index), before);
  assert.equal((await decide(staged)).status, 'completed'); assert.equal(git('show', ':a.txt'), 'selected stage'); assert.equal(git('show', ':user.txt'), unrelatedStaged);
  console.log('PASS actual Core exact stage requires Owner decision; reject/forged flags preserve index, HEAD and unrelated staged entry');

  const unstaged = await request('unstage', await review(['a.txt'])); assert.equal((await decide(unstaged)).status, 'completed'); assert.equal(git('show', ':a.txt'), 'base'); assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'selected stage\n'); assert.equal(git('show', ':user.txt'), unrelatedStaged);
  assert.equal((await decide(await request('stage', await review(['a.txt'])))).status, 'completed');
  fs.writeFileSync(path.join(root, 'a.txt'), 'selected stage\npartial unstaged edit\n'); const working = fs.readFileSync(path.join(root, 'a.txt')), stagedIndex = fs.readFileSync(index);
  const commit = await request('commit.staged', {...await review(['a.txt']), message: 'exact partial staged commit'}); assert.equal(git('rev-parse', 'HEAD'), baseline);
  assert.equal((await decide(commit)).status, 'completed'); assert.equal(git('show', 'HEAD:a.txt'), 'selected stage'); assert.deepEqual(fs.readFileSync(path.join(root, 'a.txt')), working);
  assert.deepEqual(fs.readFileSync(index), stagedIndex); assert.equal(git('show', ':user.txt'), unrelatedStaged); assert.equal(git('show', 'HEAD:user.txt'), 'user base');
  console.log('PASS Core unstage and partial staged commit preserve all working bytes and unrelated index content');

  fs.writeFileSync(path.join(root, 'a.txt'), 'reviewed later\n'); const stale = await request('stage', await review(['a.txt'])), retainedIndex = fs.readFileSync(index);
  fs.writeFileSync(path.join(root, 'a.txt'), 'newer user edit\n'); const failed = await decide(stale);
  assert.notEqual(failed.status, 'completed'); assert.deepEqual(fs.readFileSync(index), retainedIndex); assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'newer user edit\n');
  console.log('PASS approval after source change refuses exact stale scope without replacing bytes or index');

  // A previously interrupted import can appear after an otherwise valid Git
  // review. Git admission must inspect it without running its rollback before
  // the Owner has approved this new action.
  const imported = Buffer.from('interrupted import bytes\n'), original = Buffer.from('retained original bytes\n');
  fs.writeFileSync(path.join(root, 'a.txt'), imported);
  const beforeImportReview = await review(['a.txt']), beforeImportIndex = fs.readFileSync(index), beforeImportHead = git('rev-parse', 'HEAD');
  const journal = workspaceJournalDir(root);
  assert.equal(fs.existsSync(journal), false, 'fixture must exclusively own this journal partition');
  fs.mkdirSync(journal, {recursive: true});
  ownedJournal = {path: fs.realpathSync.native(journal), node: fs.lstatSync(journal, {bigint: true})};
  const batch = path.join(journal, 'batch-git-admission'); fs.mkdirSync(batch);
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = Buffer.from(JSON.stringify({schemaVersion: 1, root, status: 'committing', rows: [
    {action: 'write', path: 'a.txt', originalHash: sha(original), stagedHash: sha(imported), backup: '0.preimage'}
  ]}));
  fs.writeFileSync(path.join(batch, 'manifest.json'), manifest); fs.writeFileSync(path.join(batch, '0.preimage'), original);
  const approvalsBeforeImport = capabilities.broker.approvals.list().length;
  let importError; try { await request('stage', beforeImportReview); } catch (error) { importError = error; }
  assert.deepEqual(fs.readFileSync(path.join(root, 'a.txt')), imported, 'Git preapproval validation must not restore an older import');
  assert.equal(importError?.code, 'WORKSPACE_RECOVERY_REQUIRED');
  assert.deepEqual(fs.readFileSync(index), beforeImportIndex); assert.equal(git('rev-parse', 'HEAD'), beforeImportHead);
  assert.deepEqual(fs.readFileSync(path.join(batch, 'manifest.json')), manifest); assert.deepEqual(fs.readFileSync(path.join(batch, '0.preimage')), original);
  assert.equal(capabilities.broker.approvals.list().length, approvalsBeforeImport);
  console.log('PASS Git preapproval admission only reads interrupted import evidence; no rollback, approval or Git mutation');
  await workspace.collectRecoveryProof(entry.id);
  assert.deepEqual(fs.readFileSync(path.join(root, 'a.txt')), original); assert.deepEqual(fs.readdirSync(journal), []);
  assert.equal((await decide(await request('stage', await review(['a.txt'])))).status, 'completed');
  assert.equal(git('show', ':a.txt'), original.toString().trimEnd());
  console.log('PASS explicit existing Workspace recovery settles the retained import; same-Core fresh Git review and approval succeed');
} catch (error) {
  primaryError = error; throw error;
} finally {
  const cleanupErrors = [];
  try { await capabilities?.close?.(); } catch (error) { cleanupErrors.push(error); }
  // Closing the approval operation may abort its waiter before the actual Git
  // executor returns. Drain that executor and its real children before removal.
  while (executions.size) await Promise.allSettled([...executions]);
  while (children.size) await Promise.all([...children]);
  childProcess.execFile = originalExecFile; syncBuiltinESMExports();
  try { if (ownedJournal && fs.existsSync(ownedJournal.path)) await removeOwned(ownedJournal.path, () => {
    const current = fs.lstatSync(ownedJournal.path, {bigint: true});
    assert.equal(path.dirname(ownedJournal.path), fs.realpathSync.native(path.join(parent, 'CetaMesh', 'workspace-import-journal')));
    assert.match(path.basename(ownedJournal.path), /^[a-f0-9]{32}$/);
    assert.equal(fs.realpathSync.native(ownedJournal.path), ownedJournal.path);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === ownedJournal.node.dev && current.ino === ownedJournal.node.ino);
  }); } catch (error) { cleanupErrors.push(error); }
  try { await removeOwned(base, () => {
    const current = fs.lstatSync(base, {bigint: true}); assert.equal(path.dirname(base), parent); assert.ok(path.basename(base).startsWith('cm-git-core-actions-'));
    assert.equal(fs.realpathSync.native(base), base); assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === node.dev && current.ino === node.ino);
  }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'Core Git fixture cleanup failed', {cause: primaryError});
}
