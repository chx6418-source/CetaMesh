import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

let terminateSuiteProcessTree;
try {
  ({ terminateSuiteProcessTree } = await import('../src/testing/suite-process.js'));
} catch (error) {
  assert.fail(`suite process-tree termination helper is unavailable: ${error.message}`);
}
assert.equal(typeof terminateSuiteProcessTree, 'function', 'suite process-tree termination helper is exported');

const tempRoot = path.resolve(process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir());
const fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'suite-process-tree-'));
const parentPath = path.join(fixtureRoot, 'parent.mjs');
const readyPath = path.join(fixtureRoot, 'ready.txt');
const lateWritePath = path.join(fixtureRoot, 'late-write.txt');
const descendantCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(lateWritePath)}, 'survived'), 1200); setInterval(() => {}, 1000);`;
fs.writeFileSync(parentPath, [
  "import { spawn } from 'node:child_process';",
  "import fs from 'node:fs';",
  `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'inherit' });`,
  `fs.writeFileSync(${JSON.stringify(readyPath)}, String(grandchild.pid));`,
  'setInterval(() => {}, 1000);'
].join('\n'));

let child;
try {
  child = spawn(process.execPath, [parentPath], {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore'
  });
  const closed = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  const readyDeadline = Date.now() + 5000;
  while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) await delay(20);
  assert.equal(fs.existsSync(readyPath), true, 'fixture parent started its grandchild');
  await terminateSuiteProcessTree(child, { graceMs: 100, killWaitMs: 3000 });
  await Promise.race([
    closed,
    delay(3000).then(() => { throw new Error('parent process did not close after tree termination'); })
  ]);
  await delay(1300);
  assert.equal(fs.existsSync(lateWritePath), false, 'grandchild cannot write into a finalized suite sandbox');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await terminateSuiteProcessTree(child, { graceMs: 100, killWaitMs: 3000 });
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('PASS suite timeout terminates descendants before sandbox cleanup');
