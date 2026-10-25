import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CliAgentProcess, terminateCliProcessTree } from '../src/agent/cli-agent-process.js';

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 1234, exitCode: null, killed: false,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { throw new Error('Root-only kill is not tree confirmation'); };
  return child;
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('public outcome remained pending')), 250);
  })]); } finally { clearTimeout(timer); }
}
// Kernel signal acceptance is not process-group disappearance. This seam
// issues no real OS signals; root close is deliberately earlier than group exit.
{
  const child = fakeChild();
  let signalCount = 0;
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath, spawnImpl: () => child,
    terminationTimeoutMs: 40,
    terminateImpl: () => terminateCliProcessTree(child, { platform: 'linux', confirmationTimeoutMs: 10,
      signalProcess: (_pid, signal) => {
        signalCount++;
        if (signal === 'SIGKILL') queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0, null); });
        return true; // surviving group, including after root close
      } }) });
  const run = cli.startSession({ cwd: process.cwd() });
  try {
    run.cancel();
    const result = await bounded(run.done);
    assert.equal(result.terminationConfirmed, false);
    assert.ok(signalCount > 1, 'must probe the group after signal acceptance');
    assert.equal(cli.sessions.size, 1);
    await assert.rejects(cli.shutdown(), e => e.code === 'PROVIDER_CLOSE_UNKNOWN');
  } finally { child.exitCode = 0; child.emit('close', 0, null); }
}
{
  const child = fakeChild();
  let received = '';
  child.stdin.on('data', data => { received += data; });
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath, spawnImpl: () => child,
    terminateImpl: () => false, terminationTimeoutMs: 20 });
  const run = cli.startSession({ sessionId: 'runtime-error', cwd: process.cwd(), inputMode: 'open' });
  const observed = run.done.catch(error => ({ error }));
  try {
    child.emit('error', Object.assign(new Error('IPC runtime failure'), { code: 'EPIPE' }));
    const result = await bounded(observed);
    assert.equal(result.terminationConfirmed, false, 'post-spawn error is not proof of exit');
    assert.equal(cli.sessions.has(run.sessionId), true);
    assert.throws(() => cli.send(run.sessionId, 'must-not-write'), e => e.code === 'SESSION_STOPPING');
    assert.equal(received, '');
    await assert.rejects(cli.shutdown(), e => e.code === 'PROVIDER_CLOSE_UNKNOWN');
  } finally { child.exitCode = 1; child.emit('close', 1, null); }
}
{
  const child = fakeChild();
  let groupAlive = true;
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath, spawnImpl: () => child,
    inspectNaturalExitImpl: () => !groupAlive });
  const run = cli.startSession({ cwd: process.cwd() });
  child.exitCode = 0; child.emit('close', 0, null);
  const result = await bounded(run.done);
  assert.equal(result.effectStatus, 'unknown', 'root close with surviving group is not safe completion');
  assert.equal(cli.sessions.size, 1);
  await assert.rejects(cli.shutdown(), e => e.code === 'PROVIDER_CLOSE_UNKNOWN');
  groupAlive = false;
  await cli.shutdown();
  assert.equal(cli.sessions.size, 0, 'explicit shutdown rechecks natural group exit without signalling');
  assert.equal((await run.done).effectStatus, 'unknown', 'original public unknown result is immutable');
}
for (const termination of ['ESRCH', 'EPERM', 'no-close']) {
  const child = fakeChild();
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath,
    spawnImpl: () => child, terminationTimeoutMs: 20,
    terminateImpl: () => {
      if (termination !== 'no-close') throw Object.assign(new Error(termination), { code: termination });
      return true;
    } });
  const run = cli.startSession({ sessionId: termination, cwd: process.cwd(), timeoutMs: 1000 });
  try {
    const cancellation = run.cancel();
    assert.equal(cancellation.cancelled, false, 'request acceptance must not claim termination');
    assert.equal(cancellation.requested, true);
    const result = await bounded(run.done);
    assert.equal(result.terminationConfirmed, false);
    assert.equal(result.effectStatus, 'unknown');
    assert.equal(result.cancelled, false);
    assert.equal(result.code, 'INVOKE_CANCEL_UNCONFIRMED');
    assert.equal(cli.sessions.has(termination), true, 'unknown process ownership retained');
    await assert.rejects(bounded(cli.shutdown()), error => error.code === 'PROVIDER_CLOSE_UNKNOWN');
    assert.equal(cli.sessions.has(termination), true);
  } finally {
    child.exitCode = 0;
    child.emit('close', 0, null);
  }
}

// Path-discovery platform simulation must not change the real host's process
// ownership semantics (e.g. Windows npm shim fixture running on Linux).
{
  const child = fakeChild();
  let options;
  let kills = 0;
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath, platform: 'win32',
    spawnImpl: (_file, _args, value) => { options = value; return child; },
    terminationTimeoutMs: 20, terminateImpl: () => { kills++; return true; } });
  const run = cli.startSession({ cwd: process.cwd() });
  try {
    assert.equal(options.detached, process.platform !== 'win32');
    run.cancel();
    const unknown = await bounded(run.done);
    assert.equal(unknown.terminationConfirmed, false);
    child.exitCode = 0; child.emit('close', 0, null);
    assert.equal(run.terminationConfirmed(), true);
    assert.equal(cli.sessions.size, 0);
    await cli.shutdown();
    assert.equal(kills, 1, 'shutdown does not re-signal uncertain or completed attempts');
  } finally { child.exitCode = 0; child.emit('close', 0, null); }
}
{
  const child = fakeChild();
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath, spawnImpl: () => child,
    terminateImpl: () => { queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1, 'SIGKILL'); }); return true; } });
  const run = cli.startSession({ cwd: process.cwd() });
  run.cancel();
  const result = await bounded(run.done);
  assert.equal(result.cancelled, true);
  assert.equal(result.terminationConfirmed, true);
  assert.equal(cli.sessions.size, 0);
  await cli.shutdown();
}
{
  const child = fakeChild();
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath,
    spawnImpl: () => child, inspectNaturalExitImpl: () => true });
  const run = cli.startSession({ cwd: process.cwd() });
  child.exitCode = 0; child.emit('close', 0, null);
  const result = await bounded(run.done);
  assert.equal(result.exitCode, 0);
  assert.equal(result.processExitObserved, true);
  assert.equal(Object.hasOwn(result, 'terminationConfirmed'), false, 'natural root close does not invent tree proof');
  assert.equal(cli.sessions.size, 0);
  await cli.shutdown();
}
{
  const child = fakeChild(); child.pid = undefined;
  const cli = new CliAgentProcess({ name: 'fixture', executable: process.execPath, spawnImpl: () => child });
  const run = cli.startSession({ cwd: process.cwd() });
  child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
  await assert.rejects(run.done, e => e.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(cli.sessions.size, 0, 'failed spawn without a PID owns no process');
}
console.log('PASS CLI unknown cancellation is bounded and cannot release ownership');

const { default: fs } = await import('node:fs');
const { default: os } = await import('node:os');
const { default: path } = await import('node:path');
const { createCodexAgentProvider } = await import('../src/agent/codex-agent-provider.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-unknown-'));
const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'original.txt'), 'unchanged');
let imports = 0;
let physicallyStopped = false;
const adapterCli = {
  executable: () => process.execPath,
  probe(args) {
    if (args[0] === '--version') return { available: true, stdout: 'codex-cli 9.9.9-fixture', stderr: '' };
    if (args[0] === 'login') return { available: true, stdout: 'Logged in', stderr: '' };
    return { available: true, stdout: '--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check exec resume [SESSION_ID]', stderr: '' };
  },
  startSession() { return {
    done: Promise.resolve({ exitCode: null, terminationConfirmed: false, effectStatus: 'unknown', code: 'INVOKE_CANCEL_UNCONFIRMED' }),
    terminationConfirmed: () => physicallyStopped,
    cancel: () => ({ cancelled: false, requested: true })
  }; },
  async shutdown() { if (!physicallyStopped) throw Object.assign(new Error('unknown'), { code: 'PROVIDER_CLOSE_UNKNOWN' }); }
};
const provider = createCodexAgentProvider({ cliProcess: adapterCli, codexHome: path.join(root, 'home'),
  stagingRoot: path.join(root, 'staging'),
  resolveTaskWorkspace: () => ({ task: { id: 'task', workspaceId: 'ws', goal: 'fixture' }, workspace: { id: 'ws', root: workspace } }),
  applyChanges: async () => { imports++; }
});
try {
  const created = await provider.createSession({ taskId: 'task', workspaceId: 'ws' });
  await provider.send({ sessionId: created.sessionId, content: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await provider.status({ sessionId: created.sessionId })).lastRunStatus, 'unknown');
  await assert.rejects(provider.send({ sessionId: created.sessionId, content: 'must not run' }), e => e.code === 'TURN_BUSY');
  await assert.rejects(provider.closeSession({ sessionId: created.sessionId }), e => e.code === 'PROVIDER_CLOSE_UNKNOWN');
  assert.equal(fs.existsSync(created.cwd), true, 'uncertain close retains staging');
  assert.equal(provider._sessions.has(created.sessionId), true, 'uncertain close retains ownership');
  await assert.rejects(provider.shutdown(), e => e.code === 'PROVIDER_CLOSE_UNKNOWN');
  assert.equal(fs.existsSync(created.cwd), true, 'uncertain shutdown retains staging');
  assert.equal(imports, 0);
  physicallyStopped = true;
  assert.equal((await provider.closeSession({ sessionId: created.sessionId })).closed, true);
  assert.equal(fs.existsSync(created.cwd), false, 'later independently confirmed stop permits cleanup');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('PASS Codex unknown outcome retains run, staging and ownership without import; confirmed exit permits cleanup');
