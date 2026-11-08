import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createGitBranchActions} from '../src/workspace/git-branch-actions.js';
import {workspaceJournalDir} from '../src/workspace/transaction.js';
const env = {...process.env}; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
  {cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trimEnd();
const utf16 = text => Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
const parent = fs.realpathSync.native(os.tmpdir()), base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cm-git-conversion-'))), identity = fs.lstatSync(base, {bigint: true});
try {
  for (const profile of ['plain', 'autocrlf', 'utf16-info', 'target-attributes']) {
    const root = path.join(base, profile); fs.mkdirSync(root);
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Conversion fixture'); git(root, 'config', 'user.email', 'conversion@example.invalid'); git(root, 'config', 'core.autocrlf', profile === 'autocrlf' ? 'true' : 'false');
    if (profile === 'utf16-info') fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), 'a.txt working-tree-encoding=UTF-16\n');
    const old = profile === 'utf16-info' ? utf16('old\n') : Buffer.from(profile === 'autocrlf' ? 'old\r\n' : 'old\n');
    fs.writeFileSync(path.join(root, 'a.txt'), old); fs.writeFileSync(path.join(root, 'keep.bin'), Buffer.from([0, 255, 17, 10, 13]));
    git(root, 'add', '--', '.'); git(root, 'commit', '-m', 'original'); const original = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-c', 'target');
    fs.writeFileSync(path.join(root, 'a.txt'), profile === 'utf16-info' ? utf16('target\n') : Buffer.from(profile === 'autocrlf' ? 'target\r\n' : 'target\n'));
    if (profile === 'target-attributes') fs.writeFileSync(path.join(root, '.gitattributes'), 'a.txt text eol=crlf\n');
    git(root, 'add', '--', '.'); git(root, 'commit', '-m', 'target'); const target = git(root, 'rev-parse', 'HEAD'), targetBlob = git(root, 'rev-parse', 'HEAD:a.txt');
    git(root, 'switch', 'main'); fs.writeFileSync(path.join(root, 'a.txt'), old);
    const entry = {id: 'conversion-' + profile, root}, keep = fs.readFileSync(path.join(root, 'keep.bin'));
    const product = createGitBranchActions({nativeExecutable: process.env.CETAMESH_TEST_WORKSPACE_NATIVE}), review = await product.reviewSwitch(entry, {targetBranch: 'refs/heads/target'});
    assert.equal(review.canSwitch, true, review.blocker?.message); const outcome = await product.switchBranch(entry, review);
    const be = Buffer.from('target\n', 'utf16le'); be.swap16();
    const expected = profile === 'utf16-info' ? Buffer.concat([Buffer.from([254, 255]), be]) : Buffer.from(['autocrlf', 'target-attributes'].includes(profile) ? 'target\r\n' : 'target\n');
    assert.equal(outcome.switched, true); assert.deepEqual(fs.readFileSync(path.join(root, 'a.txt')), expected);
    assert.equal(git(root, 'hash-object', '--path', 'a.txt', '--', 'a.txt'), targetBlob); assert.deepEqual(fs.readFileSync(path.join(root, 'keep.bin')), keep);
    assert.equal(git(root, 'rev-parse', 'HEAD'), target); assert.equal(git(root, 'rev-parse', 'refs/heads/main'), original); assert.equal(git(root, 'status', '--porcelain'), '');
    assert.deepEqual(fs.readdirSync(workspaceJournalDir(root)), []); console.log('PASS protected native Git conversion: ' + profile);
  }
} finally {
  const current = fs.lstatSync(base, {bigint: true}); assert.equal(path.dirname(base), parent); assert.ok(path.basename(base).startsWith('cm-git-conversion-'));
  assert.equal(fs.realpathSync.native(base), base); assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino); fs.rmSync(base, {recursive: true, force: true});
}
