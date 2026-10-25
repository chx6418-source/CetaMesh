import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createIsolatedTestRunner } from '../src/workspace/isolated-runner.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-comm-runner-'));
function workspace(name, script) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  writeJsonAtomic(path.join(dir, 'package.json'), { private: true, scripts: { test: 'node test.cjs' } });
  fs.writeFileSync(path.join(dir, 'test.cjs'), script);
  return dir;
}
const finite = workspace('finite', "require('fs').writeFileSync('spawned', 'yes');setTimeout(()=>{}, 250);");
const tree = workspace('tree', `const fs = require('fs');
const {spawn} = require('child_process');
spawn(process.execPath, ['-e', "const fs=require('fs');setInterval(()=>fs.appendFileSync('ticks','x'),40);setTimeout(()=>process.exit(),7000)"], {stdio:'inherit'});
fs.writeFileSync('ready','yes');setTimeout(()=>process.exit(),7000);`);
const peer = workspace('peer', "setTimeout(()=>require('fs').writeFileSync('finished','yes'),1300);");
const loudTree = workspace('loud-tree', `const fs = require('fs');
const {spawn} = require('child_process');
spawn(process.execPath, ['-e', "const fs=require('fs');setInterval(()=>fs.appendFileSync('ticks','x'),40);setTimeout(()=>process.exit(),7000)"], {stdio:'ignore'});
const ready = setInterval(() => { if (fs.existsSync('ticks')) { clearInterval(ready); process.stdout.write('x'.repeat(4 * 1024 * 1024)); } }, 20);
setTimeout(()=>process.exit(),7000);`);
async function until(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `marker not created: ${file}`);
    await delay(30);
  }
}
try {
  const runner = createIsolatedTestRunner({ resolveWorkspace: async id => ({ root: id }) });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(runner.run({workspaceId:finite,tool:'npm',args:['test'],signal:pre.signal}), e => e.code === 'INVOKE_CANCELLED' && e.effectStatus === 'cancelled');
  assert.equal(fs.existsSync(path.join(finite,'spawned')), false);
  console.log('PASS preabort prevents spawn');
  const race = new AbortController();
  const resolving = createIsolatedTestRunner({resolveWorkspace: async id => { race.abort(); await delay(5); return {root:id}; }});
  await assert.rejects(resolving.run({workspaceId:finite,tool:'npm',args:['test'],signal:race.signal}), e => e.code === 'INVOKE_CANCELLED');
  assert.equal(fs.existsSync(path.join(finite,'spawned')), false);
  console.log('PASS abort during workspace resolution prevents spawn');
  const missing = new AbortController();
  const savedPath = process.env.PATH;
  try {
    // Force spawn failure without launching or stopping any external process.
    process.env.PATH = root;
    const failedSpawn = runner.run({workspaceId:finite,tool:'cargo',args:['test'],signal:missing.signal});
    queueMicrotask(() => missing.abort());
    await assert.rejects(failedSpawn, e => e.code === 'INVOKE_CANCEL_UNCONFIRMED' && e.effectStatus === 'unknown');
  } finally {
    process.env.PATH = savedPath;
  }
  console.log('PASS missing process identity cannot report confirmed cancellation');
  const cancel = new AbortController();
  const active = runner.run({workspaceId:tree,tool:'npm',args:['test'],signal:cancel.signal});
  const observed = active.then(value => ({value}), error => ({error}));
  const other = runner.run({workspaceId:peer,tool:'npm',args:['test']});
  await until(path.join(tree,'ticks')); cancel.abort();
  const result = await observed;
  assert.equal(result.error?.code, 'INVOKE_CANCELLED');
  assert.equal(result.error?.effectStatus, 'cancelled');
  const size = fs.statSync(path.join(tree,'ticks')).size;
  await delay(220);
  assert.equal(fs.statSync(path.join(tree,'ticks')).size, size, 'descendant must stop before cancellation resolves');
  assert.equal((await other).exitCode, 0);
  assert.equal(fs.existsSync(path.join(peer,'finished')), true);
  console.log('PASS cancellation stops owned descendants and preserves concurrent runner');
  const natural = new AbortController();
  assert.equal((await runner.run({workspaceId:finite,tool:'npm',args:['test'],signal:natural.signal})).exitCode, 0);
  natural.abort();
  console.log('PASS abort after natural completion does not alter result');
  const timeoutCancel = new AbortController();
  const lateAbort = setTimeout(() => timeoutCancel.abort(), 1100);
  const timeout = await runner.run({workspaceId:tree,tool:'npm',args:['test'],timeoutMs:1000,signal:timeoutCancel.signal});
  clearTimeout(lateAbort);
  assert.equal(timeout.timedOut, true);
  const afterTimeout = fs.statSync(path.join(tree,'ticks')).size;
  await delay(220);
  assert.equal(fs.statSync(path.join(tree,'ticks')).size, afterTimeout);
  console.log('PASS timeout also stops owned descendants');
  const loud = await runner.run({workspaceId:loudTree,tool:'npm',args:['test']});
  assert.equal(loud.truncated, true);
  assert.notEqual(loud.exitCode, 0, 'output limit is not successful completion');
  assert.ok(loud.stdout.length <= runner.limits.stdoutCapChars);
  const afterOverflow = fs.statSync(path.join(loudTree,'ticks')).size;
  await delay(220);
  assert.equal(fs.statSync(path.join(loudTree,'ticks')).size, afterOverflow, 'overflow must stop even a descendant with ignored stdio');
  console.log('PASS output overflow stops all owned descendants with bounded output');
  const uncertain = new AbortController();
  const uncertainWorkspace = workspace('uncertain', "require('fs').writeFileSync('ready','yes');setTimeout(()=>{},7000);");
  const realKill = process.kill;
  try {
    // Deliver the real stop signal, but make the later absence probe
    // indeterminate. A successful signal alone must never mean "cancelled".
    process.kill = function(pid, signal) {
      if (process.platform !== 'win32' && pid < 0 && signal === 0) {
        throw Object.assign(new Error('fixture probe denied'), {code:'EPERM'});
      }
      return realKill.call(process, pid, signal);
    };
    if (process.platform !== 'win32') {
      const uncertainRun = runner.run({workspaceId:uncertainWorkspace,tool:'npm',args:['test'],signal:uncertain.signal});
      const rejection = assert.rejects(uncertainRun, e => e.code === 'INVOKE_CANCEL_UNCONFIRMED' && e.effectStatus === 'unknown');
      await until(path.join(uncertainWorkspace,'ready')); uncertain.abort();
      await rejection;
      console.log('PASS successful signal with unavailable absence proof remains unknown');
    }
  } finally {
    process.kill = realKill;
  }
} finally {
  // Synthetic scripts self-expire, even if the pre-fix cancellation assertion fails.
  await delay(100);
  fs.rmSync(root, {recursive:true,force:true});
}
