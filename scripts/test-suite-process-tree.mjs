import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { classifySuiteOutcome } from '../src/testing/suite-result.js';

assert.deepEqual(classifySuiteOutcome({ code: 77, signal: null, output: 'NOT_RUN_ENVIRONMENT: isolated registry access denied' }), {
  status: 'NOT_RUN_ENVIRONMENT', failed: false
}, 'only an explicit environment marker with exit 77 is an environment skip');
assert.deepEqual(classifySuiteOutcome({ code: 77, signal: null, output: 'registry test failed' }), {
  status: 'FAIL', failed: true
}, 'an unmarked exit 77 remains a failure');
assert.deepEqual(classifySuiteOutcome({ code: 77, signal: null, timedOut: true, output: 'NOT_RUN_ENVIRONMENT: timeout' }), {
  status: 'FAIL', failed: true
}, 'timeouts cannot be disguised as environment skips');

let terminateSuiteProcessTree;
try {
  ({ terminateSuiteProcessTree } = await import('../src/testing/suite-process.js'));
} catch (error) {
  assert.fail(`suite process-tree termination helper is unavailable: ${error.message}`);
}
assert.equal(typeof terminateSuiteProcessTree, 'function', 'suite process-tree termination helper is exported');

const { listOwnedWindowsProcesses } = await import('../src/testing/suite-process.js');
assert.equal(typeof listOwnedWindowsProcesses, 'function', 'native suites must inspect their own processes, not every process with the same name');
const processRows = [
  { ProcessId: 101, ExecutablePath: 'C:\\tests\\case\\uninstall.exe' },
  { ProcessId: 102, ExecutablePath: 'c:/TESTS/case/ProgramFiles/WhaleBridge.exe' },
  { ProcessId: 103, ExecutablePath: 'C:\\tests\\case-other\\WhaleBridge.exe' },
  { ProcessId: 104, ExecutablePath: 'C:\\Program Files\\CetaMesh\\WhaleBridge.exe' },
  { ProcessId: 105, ExecutablePath: null },
  { ProcessId: 106, ExecutablePath: 'C:\\repo\\whalebridge-desktop.exe' }
];
const queryFixture = (error, text) => (file, args, options, done) => {
  assert.equal(file, 'powershell.exe');
  assert.equal(options.windowsHide, true);
  queueMicrotask(() => done(error, text, error ? 'fixture query denied' : ''));
};
const owned = await listOwnedWindowsProcesses({ rootDir: 'C:\\tests\\case', pids: [106] },
  { execFileImpl: queryFixture(null, JSON.stringify(processRows)) });
assert.deepEqual(owned.map(row => row.ProcessId), [101, 102, 106], 'separate suites, sibling paths and user applications are not residuals of this suite');
assert.deepEqual(await listOwnedWindowsProcesses({ rootDir: 'C:\\tests\\case', pids: [105] },
  { execFileImpl: queryFixture(null, JSON.stringify(processRows[4])) }), [processRows[4]], 'an owned PID with an unreadable path remains live, not silently ignored');
await assert.rejects(listOwnedWindowsProcesses({ rootDir: 'C:\\tests\\case' },
  { execFileImpl: queryFixture(Error('access denied'), '') }), /query denied/, 'an inaccessible process inventory cannot mean no leftovers');
await assert.rejects(listOwnedWindowsProcesses({ rootDir: 'C:\\tests\\case' },
  { execFileImpl: queryFixture(null, 'not JSON') }), /JSON/, 'malformed process evidence cannot mean no leftovers');
for (const output of ['', ' \r\n', '[]']) {
  await assert.rejects(listOwnedWindowsProcesses({ rootDir: 'C:\\tests\\case' },
    { execFileImpl: queryFixture(null, output) }), /empty process inventory/,
  'a successful full-system inventory includes its querying process; missing evidence cannot establish absence');
}
console.log('PASS native suite process evidence is scoped to exact owned PIDs and directories');

// Windows may finish closing a descendant between taskkill's enumeration and
// termination. Mock only taskkill; fake PIDs are never sent to the operating system.
const rootPid=7200,childPid=2952;
const rootSuccess='SUCCESS: The process with PID 7200 (child process of PID 9999) has been terminated.\r\n';
const goneChild='ERROR: The process with PID 2952 (child process of PID 7200) could not be terminated.\r\nReason: There is no running instance of the task.\r\n';
async function taskkillFixture(stdout,stderr,probe,ownedPids=[rootPid,childPid]){
 const original=childProcess.execFile;
 childProcess.execFile=(file,args,options,done)=>{assert.equal(file,'taskkill.exe');assert.deepEqual(args,['/PID',String(rootPid),'/T','/F']);assert.equal(options.windowsHide,true);queueMicrotask(()=>done(Object.assign(Error('fixture taskkill aggregate error'),{code:128}),stdout,stderr));};
 syncBuiltinESMExports();
 try{return await terminateSuiteProcessTree({pid:rootPid},{platform:'win32',killWaitMs:0,signalProcess:(pid,signal)=>{assert.ok(ownedPids.includes(pid),'only reported owned tree members may be probed');assert.equal(signal,0,'confirmation never kills a PID parsed from output');return probe(pid);}});}
 finally{childProcess.execFile=original;syncBuiltinESMExports();}
}
const absent=()=>{throw Object.assign(Error('already exited'),{code:'ESRCH'});};
const childSuccess='SUCCESS: The process with PID 2952 (child process of PID 7200) has been terminated.\r\n';
const goneRoot='ERROR: The process with PID 7200 (child process of PID 9999) could not be terminated.\r\nReason: There is no running instance of the task.\r\n';
await assert.doesNotReject(taskkillFixture(childSuccess,goneRoot,absent),'a root that exits after a positively terminated descendant is confirmed only when all reported tree members are absent');
await assert.rejects(taskkillFixture(childSuccess,goneRoot,pid=>pid===rootPid?undefined:absent()),/could not confirm/,'a root still alive cannot be accepted from an already-gone diagnostic');
await assert.rejects(taskkillFixture(childSuccess,goneRoot,pid=>pid===childPid?undefined:absent()),/could not confirm/,'a reported successful descendant still alive remains unconfirmed');
await assert.rejects(taskkillFixture('',goneRoot,absent),/could not confirm/,'a missing root alone gives no affirmative tree termination evidence');
await assert.rejects(taskkillFixture(childSuccess.replace('PID 7200)','PID 9999)'),goneRoot,absent),/could not confirm/,'a terminated process with no ancestry to the owned root cannot prove this tree cleanup');
await assert.rejects(taskkillFixture(childSuccess.replace('PID 7200)','PID 2952)'),goneRoot,absent),/could not confirm/,'a cyclic reported parent link cannot prove owned tree membership');
await assert.rejects(taskkillFixture(childSuccess+childSuccess,goneRoot,absent),/could not confirm/,'duplicate process records are ambiguous');
await assert.rejects(taskkillFixture(childSuccess,goneRoot+'unknown diagnostic\r\n',absent),/could not confirm/,'unrecognized diagnostics keep the tree unconfirmed');
await assert.rejects(taskkillFixture(childSuccess,goneRoot.replace('PID 9999)','PID 2952)'),absent),/could not confirm/,'the root cannot name a reported descendant as its parent');
await assert.rejects(taskkillFixture(childSuccess,goneRoot.replace('PID 9999)','PID 7200)'),absent),/could not confirm/,'the root cannot name itself as its parent');
await assert.rejects(taskkillFixture(childSuccess.replace(' (child process of PID 7200)',''),goneRoot,absent),/could not confirm/,'non-root records require explicit parent evidence');
await assert.rejects(taskkillFixture(childSuccess+rootSuccess,'',absent),/could not confirm/,'an unexplained nonzero exit cannot be accepted from success output alone');
const grandchildPid=6181,probed=[];
const goneGrandchild='ERROR: The process with PID 6181 (child process of PID 2952) could not be terminated.\r\nReason: There is no running instance of the task.\r\n';
await assert.doesNotReject(taskkillFixture(childSuccess,goneRoot+goneGrandchild,pid=>{probed.push(pid);return absent();},[rootPid,childPid,grandchildPid]),'complete multilevel parent evidence is accepted only after every reported member exits');
assert.deepEqual(probed.slice().sort(),[rootPid,childPid,grandchildPid].sort(),'every reported member is probed, but the root external parent is excluded');
await assert.doesNotReject(taskkillFixture(rootSuccess,goneChild,absent),'a confirmed root termination and already exited child are a successful tree cleanup');
await assert.rejects(taskkillFixture(rootSuccess,goneChild,pid=>pid===childPid?undefined:absent()),/could not confirm/,'a live descendant keeps cleanup unconfirmed');
await assert.rejects(taskkillFixture(rootSuccess,goneChild,()=>{throw Object.assign(Error('probe denied'),{code:'EPERM'});}),/could not confirm/,'an inaccessible process is not assumed exited');
await assert.rejects(taskkillFixture('',goneChild,absent),/could not confirm/,'root disappearance alone cannot prove that its descendants exited');
await assert.rejects(taskkillFixture(rootSuccess,goneChild.replace('There is no running instance of the task.','Access is denied.'),absent),/could not confirm/,'permission failures remain failures even if the root disappeared');
const unsupportedPid=9051;
const unsupportedChild=goneChild.replace('PID 2952','PID '+unsupportedPid).replace('There is no running instance of the task.','The operation attempted is not supported.');
const mixedSuccess=rootSuccess+childSuccess,mixedErrors=goneGrandchild+unsupportedChild;
const mixedMembers=[rootPid,childPid,grandchildPid,unsupportedPid],mixedProbes=[];
await assert.doesNotReject(taskkillFixture(mixedSuccess,mixedErrors,pid=>{mixedProbes.push(pid);return absent();},mixedMembers),
 'mixed taskkill missing/unsupported diagnostics require independent absence proof for the complete reported tree');
assert.deepEqual(mixedProbes.slice().sort(),mixedMembers.slice().sort(),'every reported member, including SUCCESS and unsupported records, is probed');
for(const livePid of [rootPid,childPid,unsupportedPid])await assert.rejects(taskkillFixture(mixedSuccess,mixedErrors,pid=>pid===livePid?undefined:absent(),mixedMembers),/could not confirm/,'any reported live member keeps the tree unconfirmed');
await assert.rejects(taskkillFixture(mixedSuccess,mixedErrors,pid=>{if(pid===unsupportedPid)throw Object.assign(Error('probe denied'),{code:'EPERM'});return absent();},mixedMembers),/could not confirm/,'unsupported is not proof of exit when its PID is inaccessible');
await assert.rejects(taskkillFixture(mixedSuccess,mixedErrors,pid=>{if(pid===unsupportedPid)throw Error('probe failed');return absent();},mixedMembers),/probe failed/,'unexpected native probe failures remain failures');
await assert.doesNotReject(taskkillFixture(rootSuccess,unsupportedChild,absent,[rootPid,unsupportedPid]),'unsupported alone requires positive root termination and independent absence of both reported members');
await assert.rejects(taskkillFixture('',unsupportedChild,absent,[rootPid,unsupportedPid]),/could not confirm/,'unsupported alone is not affirmative tree termination evidence');
await assert.rejects(taskkillFixture(mixedSuccess,mixedErrors+'unknown diagnostic\r\n',absent,mixedMembers),/could not confirm/,'additional diagnostics cannot be hidden by unsupported records');
await assert.rejects(taskkillFixture(mixedSuccess,mixedErrors.replace('There is no running instance of the task.','Access is denied.'),absent,mixedMembers),/could not confirm/,'permission errors mixed with unsupported remain unconfirmed');
await assert.rejects(taskkillFixture(rootSuccess,unsupportedChild.replace('child process of PID 7200','child process of PID 9999'),absent,[rootPid,unsupportedPid]),/could not confirm/,'unsupported records still require owned rooted parent evidence');
console.log('PASS taskkill close race requires affirmative tree termination, rooted parent evidence, exact diagnostics and every reported PID independently confirmed absent');

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
