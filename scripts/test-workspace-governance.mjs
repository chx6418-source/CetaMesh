import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createWorkspaceService } from '../src/workspace/service.js';
import { workspaceJournalDir } from '../src/workspace/transaction.js';
import { createWorkspaceReconciler } from '../src/continuity/reconcile.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-workspace-governance-')));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const journals = new Set();
let failed = 0;
async function check(name, fn) {
  const at = performance.now();
  try { await fn(); console.log(`PASS ${name} (${Math.round(performance.now() - at)}ms)`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}
function fixture(name) {
  const base = path.join(root, name), stateDir = path.join(base, 'state'), project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { base, stateDir, project, service: createWorkspaceService({ stateDir }) };
}
const call = (service, method, params) => service.execute({ method, params });
async function register(f, name = 'project', directory = f.project) {
  return (await call(f.service, 'workspace.create', { name, root: directory })).workspace;
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function pendingFixture(name) {
  const f = fixture(name);
  git(f.project, 'init', '-b', 'main');
  git(f.project, 'config', 'user.name', 'CetaMesh fixture');
  git(f.project, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(f.project, 'a.txt'), 'before\n');
  git(f.project, 'add', 'a.txt'); git(f.project, 'commit', '-m', 'baseline');
  f.workspace = await register(f); f.head = git(f.project, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.project, 'a.txt'), 'after\n');
  f.pending = await call(f.service, 'workspace.git.commit', { id: f.workspace.id, message: 'reviewed change', paths: ['a.txt'], expectedHead: f.head, expectedHashes: { 'a.txt': hash('after\n') } });
  return f;
}

try {
  await check('batch import preserves every audit event with one registry write', async () => {
    const f = fixture('batch'), ws = await register(f), audit = [];
    // Reopen through the real persistent registry, with its normal atomic writer.
    f.service = createWorkspaceService({ stateDir: f.stateDir, audit: event => audit.push(event) });
    const rename = fs.renameSync;
    let registryWrites = 0;
    fs.renameSync = function (from, to) { if (path.resolve(String(to)) === path.join(f.stateDir, 'workspaces.json')) registryWrites++; return rename.apply(this, arguments); };
    try {
      const changes = Array.from({ length: 20 }, (_, i) => ({ action: 'write', path: `file-${i}.txt`, content: `body-${i}`, expectedHash: null }));
      f.service.applyChanges({ id: ws.id, changes });
      assert.equal(registryWrites, 1, 'do not rewrite the entire project registry twice per file');
      assert.equal(audit.length, 20, 'batching metadata must retain per-file external audit');
      const disk = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'workspaces.json')));
      assert.equal(disk.workspaces[0].recentFiles.length, 20);
      assert.equal(disk.activity.filter(row => row.action === 'write').length, 20);
      assert.equal(fs.readFileSync(path.join(f.project, 'file-19.txt'), 'utf8'), 'body-19');
    } finally { fs.renameSync = rename; }
  });

  await check('pre-manifest crash blocks only its project and preserves raw journal', async () => {
    const f = fixture('crash'), broken = await register(f, 'broken');
    const healthyRoot = path.join(f.base, 'healthy'); fs.mkdirSync(healthyRoot);
    const healthy = await register(f, 'healthy', healthyRoot);
    fs.writeFileSync(path.join(f.project, 'keep.txt'), 'user edit');
    const transactionModule = new URL('../src/workspace/transaction.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import {applyWorkspaceTransaction} from ${JSON.stringify(transactionModule)};
      const open = fs.openSync, sync = fs.fsyncSync; let preimage;
      fs.openSync = function(file,...args){const fd=open.call(this,file,...args);if(String(file).endsWith('0.preimage'))preimage=fd;return fd;};
      fs.fsyncSync=function(fd){sync.call(this,fd);if(fd===preimage)process.exit(73);};
      applyWorkspaceTransaction(${JSON.stringify(f.project)},[{action:'write',path:'keep.txt',content:'candidate'}],{writeFile(){throw new Error('must not reach side effect');}});
    `], { windowsHide: true, encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    const journal = workspaceJournalDir(f.project); journals.add(journal);
    const before = fs.readdirSync(journal);
    assert.equal(before.length, 1);
    assert.ok(fs.existsSync(path.join(journal, before[0], '0.preimage')));
    const restarted = createWorkspaceService({ stateDir: f.stateDir });
    const listed = await call(restarted, 'workspace.list');
    assert.equal(listed.workspaces.find(row => row.id === broken.id).recovery.status, 'blocked');
    assert.equal(listed.workspaces.find(row => row.id === healthy.id).recovery.status, 'ready');
    assert.equal(restarted.describeWorkspace(broken.id), null, 'do not give an Agent a blocked execution root');
    await assert.rejects(call(restarted, 'workspace.write', { id: broken.id, path: 'keep.txt', content: 'forbidden' }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await call(restarted, 'workspace.write', { id: healthy.id, path: 'ok.txt', content: 'healthy' });
    assert.equal(fs.readFileSync(path.join(f.project, 'keep.txt'), 'utf8'), 'user edit');
    assert.deepEqual(fs.readdirSync(journal), before, 'do not guess that an incomplete unknown journal is disposable');
    const nestedRoot = path.join(f.project, 'sub'); fs.mkdirSync(nestedRoot);
    const nested = await call(restarted, 'workspace.create', { name: 'nested view', root: nestedRoot });
    await assert.rejects(call(restarted, 'workspace.write', { id: nested.workspace.id, path: 'new.txt', content: 'forbidden' }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(restarted.describeWorkspace(nested.workspace.id), null, 'overlapping roots cannot borrow another execution identity');
    const ancestor = await call(restarted, 'workspace.create', { name: 'ancestor view', root: f.base });
    await assert.rejects(call(restarted, 'workspace.write', { id: ancestor.workspace.id, path: 'project/keep.txt', content: 'forbidden' }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await assert.rejects(call(restarted, 'workspace.remove', { id: broken.id }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal((await call(restarted, 'workspace.list')).workspaces.some(row => row.id === broken.id), true);
  });

  await check('legacy commit approval rechecks current deny policy', async () => {
    const f = await pendingFixture('deny');
    await call(f.service, 'workspace.settings', { id: f.workspace.id, patch: { policies: { gitCommit: 'deny' } } });
    await assert.rejects(call(f.service, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true }), { code: 'GIT_COMMIT_DENIED' });
    assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.head);
    assert.equal((await call(f.service, 'workspace.pending.list')).pending.length, 1);
  });

  await check('known pre-execution index failure retains an explicitly retryable approval', async () => {
    const f = await pendingFixture('busy'), lock = path.join(f.project, '.git', 'index.lock');
    fs.writeFileSync(lock, 'fixture-owned');
    try { await assert.rejects(call(f.service, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true }), { code: 'GIT_INDEX_BUSY' }); }
    finally { fs.unlinkSync(lock); }
    assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.head);
    const restarted = createWorkspaceService({ stateDir: f.stateDir });
    const rows = (await call(restarted, 'workspace.pending.list')).pending;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'failed-no-effect');
    const result = await call(restarted, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true });
    assert.equal(result.committed, true);
    assert.notEqual(git(f.project, 'rev-parse', 'HEAD'), f.head);
  });

  await check('interrupted approval is not replayed after restart or erased by rejection', async () => {
    const f = await pendingFixture('unknown');
    const registryFile = path.join(f.stateDir, 'workspaces.json'), data = JSON.parse(fs.readFileSync(registryFile));
    data.pending[0].status = 'executing'; fs.writeFileSync(registryFile, JSON.stringify(data));
    const restarted = createWorkspaceService({ stateDir: f.stateDir });
    for (const approve of [true, false]) await assert.rejects(call(restarted, 'workspace.pending.decide', { requestId: f.pending.requestId, approve }), { code: 'PENDING_RECONCILIATION_REQUIRED' });
    assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.head);
    assert.equal((await call(restarted, 'workspace.pending.list')).pending.length, 1);
  });

  await check('concurrent decisions dispatch a logical commit once', async () => {
    const f = await pendingFixture('concurrent');
    const first = call(f.service, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true });
    const removal = await call(f.service, 'workspace.remove', { id: f.workspace.id }).then(() => null, error => error);
    const results = await Promise.allSettled([first, call(f.service, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true })]);
    assert.equal(removal?.code, 'WORKSPACE_RECOVERY_REQUIRED');
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.filter(row => row.status === 'rejected').length, 1);
    assert.equal(Number(git(f.project, 'rev-list', '--count', 'HEAD')), 2);
  });

  await check('post-commit registry failure retains unknown intent across later saves', async () => {
    const f = await pendingFixture('post-commit-save'), rename = fs.renameSync;
    let writes = 0, observed;
    fs.renameSync = function (from, to) {
      if (path.resolve(String(to)) === path.join(f.stateDir, 'workspaces.json') && ++writes === 3) {
        throw Object.assign(new Error('fixture registry replacement failed'), { code: 'EIO' });
      }
      return rename.apply(this, arguments);
    };
    try { await call(f.service, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true }); }
    catch (error) { observed = error; }
    finally { fs.renameSync = rename; }
    assert.notEqual(git(f.project, 'rev-parse', 'HEAD'), f.head, 'fault is after real update-ref');
    assert.equal(observed?.effectStatus, 'unknown');
    assert.equal(f.service.describeWorkspace(f.workspace.id), null);
    await assert.rejects(call(f.service, 'workspace.write', { id: f.workspace.id, path: 'a.txt', content: 'erase evidence' }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await assert.rejects(call(f.service, 'workspace.remove', { id: f.workspace.id }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await call(f.service, 'workspace.rename', { id: f.workspace.id, name: 'unrelated metadata save' });
    const restarted = createWorkspaceService({ stateDir: f.stateDir });
    assert.equal((await call(restarted, 'workspace.pending.list')).pending[0]?.status, 'outcome-unknown');
    await assert.rejects(call(restarted, 'workspace.pending.decide', { requestId: f.pending.requestId, approve: true }), { code: 'PENDING_RECONCILIATION_REQUIRED' });
    assert.equal(Number(git(f.project, 'rev-list', '--count', 'HEAD')), 2);
  });

  await check('failed observations cannot certify unchanged Workspace facts', async () => {
    for (const unavailable of ['head', 'status', 'diff', 'file']) {
      const observation = name => { if (name === unavailable) throw Object.assign(new Error(`${name} unavailable`), { code: 'EACCES' }); };
      const r = createWorkspaceReconciler({ resolveWorkspace: async id => ({ id, root: '/synthetic' }),
        gitStatus: async () => { observation('status'); return { isRepo: true, branch: 'main', dirty: false }; },
        gitHead: async () => { observation('head'); return { isRepo: true, headSha: 'a'.repeat(40) }; },
        gitDiffSummary: async () => { observation('diff'); return null; },
        fileExists: () => { observation('file'); return true; } });
      const facts = await r.collectFacts({ workspaceId: 'ws', relevantFiles: ['a.txt'] });
      assert.equal(r.reconcile({ packet: { workspaceFacts: facts }, facts }).consistent, null, unavailable);
    }
  });
} finally {
  for (const journal of journals) {
    assert.ok(journal.startsWith(path.join(os.tmpdir(), 'CetaMesh', 'workspace-import-journal') + path.sep));
    fs.rmSync(journal, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
