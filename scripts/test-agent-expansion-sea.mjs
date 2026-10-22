// Explicit future SEA gate: never discovers dist/core or an older RC automatically.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyAgentExpansionArtifact, isExpectedAbsentSdkError } from '../src/agent/expansion-provenance.js';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';

const directory = process.env.WHALEBRIDGE_AGENT_EXPANSION_SEA_DIR?.trim();
assert.ok(directory, 'WHALEBRIDGE_AGENT_EXPANSION_SEA_DIR required; unified runner must classify absent opt-in as NOT_RUN_ENVIRONMENT');
assert.equal(process.platform, 'win32', 'Supplied Windows SEA requires Windows');
const proof = verifyAgentExpansionArtifact(path.resolve(directory), path.resolve(import.meta.dirname, '..'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sea-'));
const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
  TEMP: scratch, TMP: scratch, WHALEBRIDGE_DATA_DIR: scratch };
let child, rpc, sdkLoaded = false;
async function launch(args, action) {
  child = spawn(proof.executable, args, { cwd: scratch, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const current = child;
  // Observe close from launch, including early exit; no terminal is accepted without observed process exit.
  const closed = new Promise((resolve, reject) => { current.once('error', reject); current.once('close', (code, signal) => resolve({ code, signal })); });
  let stderr = '';
  current.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  const timer = setTimeout(() => current.kill(), 15000);
  try {
    await action(current);
    current.stdin.end();
    const result = await closed;
    assert.equal(result.code, 0, `SEA private/help mode failed (code=${result.code}, signal=${result.signal}, stderrBytes=${Buffer.byteLength(stderr)})`);
  } finally {
    clearTimeout(timer); rpc?.close(); rpc = null;
    if (current.exitCode === null && current.signalCode === null) { current.kill(); await closed; }
    child = null;
  }
}
try {
  await launch(['--help'], async current => {
    let help = ''; current.stdout.on('data', data => { help = (help + data).slice(-16384); });
    await once(current.stdout, 'end');
    assert.match(help, /WhaleBridge Core/);
  });
  await launch(['--agent-sdk-runner', 'claude'], async current => {
    rpc = createJsonRpcTransport({ readable: current.stdout, writable: current.stdin, framing: 'acp-v1-jsonl' });
    // Bootstrap only: fake credential and nonexistent binary; no session/new or prompt/query call.
    try {
      const result = await rpc.request('initialize', { credential: 'fixture-not-a-real-credential', cwd: scratch,
        runtimePath: path.join(scratch, 'absent-claude.exe'), tools: [] });
      assert.equal(result.initialized, true);
      assert.equal(proof.sdkBundled, true, 'SDK initialized without pinned optional resource metadata');
      sdkLoaded = true;
    } catch (error) {
      assert.ok(isExpectedAbsentSdkError(error, proof.sdkBundled), 'Unexpected private runner initialization failure; bundled pinned SDK must initialize');
    }
    await rpc.request('shutdown', {});
  });
  console.log(JSON.stringify({ status: 'PASS', scope: 'SEA help/private runner bootstrap with no system Node PATH; no query, worker or Owner IPC', sdkLoaded, ...proof }));
} finally {
  rpc?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}
