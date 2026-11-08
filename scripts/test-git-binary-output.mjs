import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {gitRun} from '../src/workspace/tools.js';
const parent = fs.realpathSync.native(os.tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cm-git-binary-'))), stat = fs.lstatSync(root, {bigint: true});
const env = {...process.env}; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (...args) => execFileSync('git', args, {cwd: root, env, encoding: 'utf8', windowsHide: true});
try {
  git('init', '-b', 'main'); const payload = Buffer.from([0, 255, 254, 128, 13, 10, 0, 97]);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, env, input: payload, encoding: 'utf8', windowsHide: true}).trim();
  const output = await gitRun(root, ['cat-file', 'blob', oid], {binaryOutput: true, maxOutputBytes: 1024});
  assert.ok(Buffer.isBuffer(output.stdout), 'Core target preparation needs exact bytes, never UTF-8 replacement characters'); assert.deepEqual(output.stdout, payload);
  assert.equal(typeof (await gitRun(root, ['version'])).stdout, 'string', 'the existing textual Git contract remains unchanged');
  const large = Buffer.alloc(65536, 255), bigOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, env, input: large, encoding: 'utf8', windowsHide: true}).trim();
  await assert.rejects(gitRun(root, ['cat-file', 'blob', bigOid], {binaryOutput: true, maxOutputBytes: 1024}), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
  await assert.rejects(gitRun(root, ['version'], {binaryOutput: 'yes'}), {code: 'GIT_OUTPUT_INVALID'});
  assert.deepEqual((await gitRun(root, ['cat-file', 'blob', oid], {binaryOutput: true, maxOutputBytes: 1024})).stdout, payload);
  const aboveTextBudget = Buffer.alloc(9 * 1024 * 1024, 128), boundedOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, env, input: aboveTextBudget, encoding: 'utf8', windowsHide: true}).trim();
  assert.deepEqual((await gitRun(root, ['cat-file', 'blob', boundedOid], {binaryOutput: true, maxOutputBytes: 10 * 1024 * 1024})).stdout, aboveTextBudget, 'the explicit binary bound covers the existing 10MiB file contract without widening default textual output');
  console.log('PASS actual native binary Git output, unchanged textual API, bounded overflow and continued read without source mutation');
  const controller = new AbortController(), realExecFile = childProcess.execFile;
  let closed = false, childClosed;
  childProcess.execFile = function (file, args, options, callback) {
    const child = realExecFile.call(this, file, args, options, callback);
    if (file === 'git' && args.includes('hash-object') && args.includes('--stdin') && options.signal === controller.signal) {
      childClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
      child.once('spawn', () => controller.abort());
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(gitRun(root, ['hash-object', '--stdin'], {signal: controller.signal}), error => {
      assert.equal(closed, true, 'an Abort callback is not child-close evidence; Git must drain before returning');
      assert.equal(error.code, 'ABORT_ERR'); return true;
    });
    assert.ok(childClosed, 'the actual controlled native Git process must have launched');
  } finally { childProcess.execFile = realExecFile; syncBuiltinESMExports(); await childClosed; }
  console.log('PASS actual native Git cancellation waits for owned child close before reporting its result');
} finally {
  const current = fs.lstatSync(root, {bigint: true}); assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('cm-git-binary-'));
  assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino); assert.equal(fs.realpathSync.native(root), root); fs.rmSync(root, {recursive: true, force: true});
}
