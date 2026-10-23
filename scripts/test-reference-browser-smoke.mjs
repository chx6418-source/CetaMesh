import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
const sandbox = createSuiteSandbox({ suiteId: 'reference-browser-live' });
const root = sandbox.root;
try {
  const report = path.join(root, 'result.txt');
  const binary = path.resolve('desktop-shell/target/debug/whalebridge-desktop.exe');
  const run = spawnSync(binary, [`--reference-browser-smoke=${report}`], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
  const result = fs.readFileSync(report, 'utf8');
  assert.match(result, /^PASS /);
  console.log(result);
} finally {
  // WebView2 exits its separate browser process asynchronously after the host.
  // Observe release of our owned profile; do not kill any browser processes.
  for (let attempt = 0; ; attempt++) {
    try { finalizeSuiteSandbox({ sandbox, failed: false }); break; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code) || attempt >= 12) throw error;
      await delay(250);
    }
  }
  assert.equal(fs.existsSync(root), false, 'owned native profile is fully removed after browser release');
  console.log('PASS WebView2 profile released and owned sandbox removed without terminating user processes');
}
