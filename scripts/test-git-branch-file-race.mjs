import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createGitBranchActions } from '../src/workspace/git-branch-actions.js';
import {workspaceJournalDir} from '../src/workspace/transaction.js';

const env = { ...process.env }; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]; env.GIT_OPTIONAL_LOCKS = '0';
const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
async function holdReadableIndex(location, cwd) {
  const script = `$ownedStream=[System.IO.File]::Open('${location.replaceAll("'", "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $ownedStream.Dispose()`;
  const child = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Owned index lock helper did not become ready')), 10000); child.once('error', reject); child.stdout.on('data', bytes => { output += bytes; if (output.includes('ready')) { clearTimeout(timer); resolve(); } }); });
  return async () => { child.stdin.end('\n'); await closed; };
}
const cases = [
  { name: 'clean ordinary baseline', edit: false, stamp: 1000000000 },
  { name: 'new-mtime concurrent edit', edit: true, preserveMtime: false, stamp: 1000000000 },
  { name: 'preserved-mtime same-size concurrent edit', edit: true, preserveMtime: true, stamp: 1000000000 },
  { name: 'clean empty file', edit: false, empty: true, stamp: 1000000000 },
  { name: 'concurrent edit of empty file', edit: true, empty: true, preserveMtime: true, stamp: 1000000000 },
  { name: 'epoch-zero nonempty file switches by raw hash', edit: false, stamp: 0 },
  { name: 'out-of-index-range nonempty file switches by raw hash', edit: false, stamp: 4294967296 },
  { name: 'clean racy timestamp', edit: false, stamp: Math.floor(Date.now() / 1000) },
  { name: 'preserved racy timestamp concurrent edit', edit: true, preserveMtime: true, stamp: Math.floor(Date.now() / 1000) },
];
if (process.platform === 'win32') cases.push({ name: 'normal-index replacement failure resumes the same raw file set after cold review without rewriting or manual restaging', edit: false, stamp: 1000000000, indexLock: true });
let failures = 0;
for (const scenario of cases) {
  const { preserveMtime, empty, stamp, edit, unsupported, name } = scenario;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-branch-file-race-'))), original = childProcess.execFile; let releaseIndex;
  try {
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Concurrent file fixture'); git(root, 'config', 'user.email', 'concurrent@example.invalid'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'config', 'core.trustctime', 'false');
    const file = path.join(root, 'a.txt'), baseline = empty ? '' : 'base\n'; fs.writeFileSync(file, baseline); git(root, 'add', '--', 'a.txt'); git(root, 'commit', '-m', 'base'); const oldHead = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-c', 'target'); fs.writeFileSync(file, 'next\n'); git(root, 'add', '--', 'a.txt'); git(root, 'commit', '-m', 'target'); const targetHead = git(root, 'rev-parse', 'HEAD'); git(root, 'switch', 'main');
    fs.utimesSync(file, stamp, stamp); git(root, 'add', '--', 'a.txt'); assert.equal(git(root, 'status', '--porcelain'), ''); const initialTime = fs.statSync(file, { bigint: true }).mtimeNs, initialIndex = fs.readFileSync(path.join(root, '.git', 'index'));
    const actions = createGitBranchActions({nativeExecutable: process.env.CETAMESH_TEST_WORKSPACE_NATIVE}), entry = { id: path.basename(root), root }, request = await actions.reviewSwitch(entry, { targetBranch: 'refs/heads/target' });
    if (unsupported) { assert.equal(request.canSwitch, false); assert.equal(request.blocker.code, 'GIT_SWITCH_TIME_UNSUPPORTED'); assert.equal(request.blocker.recoveryAction, 'create-worktree'); } else assert.equal(request.canSwitch, true);
    if (scenario.indexLock) releaseIndex = await holdReadableIndex(path.join(root, '.git', 'index'), root);
    let triggered = false;
    childProcess.execFile = function(command, args, ...rest) { if (args.some(arg => arg.startsWith('--workspace-byte-transaction=')) && !triggered) { triggered = true; if (edit) { fs.writeFileSync(file, 'user\n'); if (preserveMtime) fs.utimesSync(file, stamp, stamp); } } return original.call(this, command, args, ...rest); }; syncBuiltinESMExports();
    let outcome, error; try { outcome = await actions.switchBranch(entry, request); } catch (caught) { error = caught; }
    if (unsupported) {
      assert.equal(triggered, false); assert.equal(error?.code, 'GIT_SWITCH_TIME_UNSUPPORTED'); assert.equal(error?.effectStatus, undefined); assert.equal(error.recoveryAction, 'create-worktree'); assert.equal(fs.readFileSync(file, 'utf8'), baseline); assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, initialTime); assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), initialIndex);
    } else if (scenario.indexLock) {
      assert.equal(triggered, true); assert.equal(error?.effectStatus, 'unknown'); assert.equal(error.phase, 'index-pending'); assert.equal(error.targetHead, targetHead); assert.equal(fs.readFileSync(file, 'utf8'), 'next\n'); assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), initialIndex); assert.equal(git(root, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
      await releaseIndex(); releaseIndex = undefined;
      // A fresh application/approval review may complete only the missing Git
      // phases; its native file receipt is adopted, not replayed or restaged.
      const cold = (await import('../src/workspace/git-branch-actions.js?cold=' + Date.now())).createGitBranchActions({nativeExecutable: process.env.CETAMESH_TEST_WORKSPACE_NATIVE});
      const fresh = await cold.reviewSwitch(entry, { targetBranch: 'refs/heads/target', mode: 'finish-prepared' }); assert.equal(fresh.canSwitch, true, fresh.blocker?.message);
      const fileTime = fs.statSync(file, {bigint: true}).mtimeNs;
      triggered = false; assert.equal((await cold.switchBranch(entry, fresh)).switched, true); assert.equal(triggered, false, 'Recovery must not launch the file primitive twice');
      assert.equal(fs.statSync(file, {bigint: true}).mtimeNs, fileTime); assert.deepEqual(fs.readdirSync(workspaceJournalDir(root)), []);
    } else if (edit) {
      assert.equal(triggered, true); assert.equal(fs.readFileSync(file, 'utf8'), 'user\n', 'Native launch must preserve the unreviewed file edit; returned=' + JSON.stringify(outcome ?? { code: error?.code, effectStatus: error?.effectStatus })); assert.equal(error?.effectStatus, 'none'); assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), initialIndex);
    } else { assert.equal(triggered, true); assert.equal(error, undefined, error?.message); assert.equal(outcome.switched, true); assert.equal(fs.readFileSync(file, 'utf8'), 'next\n'); }
    assert.equal(git(root, 'symbolic-ref', 'HEAD'), !unsupported && !edit ? 'refs/heads/target' : 'refs/heads/main'); assert.equal(git(root, 'rev-parse', 'refs/heads/main'), oldHead); assert.equal(git(root, 'rev-parse', 'refs/heads/target'), targetHead);
    console.log('PASS ' + name);
  } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); }
  finally { childProcess.execFile = original; syncBuiltinESMExports(); await releaseIndex?.(); assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir())); assert.ok(path.basename(root).startsWith('cm-git-branch-file-race-')); fs.rmSync(root, { recursive: true, force: true }); }
}
console.log(`Git branch final-file race: ${cases.length - failures} PASS, ${failures} FAIL`); if (failures) process.exitCode = 1;
