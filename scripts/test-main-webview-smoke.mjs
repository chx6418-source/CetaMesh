import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';

const sandbox = createSuiteSandbox({ suiteId: 'main-webview-live' });
let failed = true;
try {
  const binary = path.resolve(process.env.CARGO_TARGET_DIR || 'desktop-shell/target', 'debug/whalebridge-desktop.exe');
  for (const flag of ['main-webview-smoke', 'chat-caption-smoke', 'caption-wallpaper-smoke']) {
  const report = path.join(sandbox.root, `${flag}.txt`);
  const run = spawnSync(binary, [`--${flag}=${report}`], { encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, CETAMESH_TEST_CAPTION_BACKDROP: flag === 'caption-wallpaper-smoke' ? '1' : '0' } });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
  const result = fs.readFileSync(report, 'utf8');
  console.log(result);
  if (process.env.WHALEBRIDGE_NATIVE_CAPTURE_DIR) {
    fs.mkdirSync(process.env.WHALEBRIDGE_NATIVE_CAPTURE_DIR, { recursive: true });
    fs.copyFileSync(report, path.join(process.env.WHALEBRIDGE_NATIVE_CAPTURE_DIR, `${flag}.txt`));
  }
  assert.match(result, /^PASS /);
  }
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
