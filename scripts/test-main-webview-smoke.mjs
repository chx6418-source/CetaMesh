import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';

const sandbox = createSuiteSandbox({ suiteId: 'main-webview-live' });
let failed = true;
try {
  const report = path.join(sandbox.root, 'result.txt');
  const binary = path.resolve('desktop-shell/target/debug/whalebridge-desktop.exe');
  const run = spawnSync(binary, [`--main-webview-smoke=${report}`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
  const result = fs.readFileSync(report, 'utf8');
  console.log(result);
  assert.match(result, /^PASS /);
  failed = false;
} finally {
  // Only clean this suite's owned profiles, after asynchronous WebView2 shutdown.
  for (let attempt = 0; ; attempt++) {
    try { finalizeSuiteSandbox({ sandbox, failed }); break; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code) || attempt >= 20) throw error;
      await delay(250);
    }
  }
  if (!failed) assert.equal(fs.existsSync(sandbox.root), false, 'owned native profiles released');
}
