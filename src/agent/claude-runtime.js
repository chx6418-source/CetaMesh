import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { APP_PATHS } from '../app-paths.js';
import { createMinimalAgentEnv } from './cli-agent-process.js';
import { CLAUDE_SDK_RESOURCE_FILE, CLAUDE_SDK_RESOURCE_SHA256, verifyClaudeSdkBytes } from './claude-sdk-resource.js';

export const CLAUDE_NATIVE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
const fault = code => Object.assign(new Error(code), { code });
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const HELP_FLAGS = ['--print', '--input-format', '--output-format', '--permission-mode',
  '--setting-sources', '--strict-mcp-config', '--tools', '--settings'];

/** A newly owned profile prevents the SDK and native CLI from loading account state. */
export function createClaudeOwnedProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-claude-profile-'));
  for (const part of ['home', 'roaming', 'local', 'temp', 'config']) fs.mkdirSync(path.join(root, part));
  const realRoot = fs.realpathSync(root);
  let cleaned = false;
  return Object.freeze({ root, environment: claudeProfileEnvironment(root), cleanup() {
    if (cleaned) return;
    // This closure can remove only the directory it created, after the caller observes exit.
    if (fs.realpathSync(root) !== realRoot || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw fault('CLAUDE_PROFILE_CHANGED');
    fs.rmSync(root, { recursive: true }); cleaned = true;
  } });
}

export function claudeProfileEnvironment(root, source = process.env) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.dirname(root) === root) throw fault('CLAUDE_INVALID_PROFILE');
  const home = path.join(root, 'home');
  const env = createMinimalAgentEnv(source, { HOME: home, USERPROFILE: home, APPDATA: path.join(root, 'roaming'),
    LOCALAPPDATA: path.join(root, 'local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp') });
  delete env.CODEX_HOME;
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/, '');
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
  } else { delete env.HOMEDRIVE; delete env.HOMEPATH; }
  // Only this adapter's private bootstrap adds Claude configuration and authentication keys.
  env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
  return env;
}

function binaryIdentity(selected) {
  const expectedName = process.platform === 'win32' ? /^claude(?:-[0-9.]+)?\.exe$/i : /^claude(?:-[0-9.]+)?$/;
  if (!path.isAbsolute(selected) || !expectedName.test(path.basename(selected)) || /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(selected)) throw fault('claude_code_path_unsupported');
  let fd;
  try {
    const resolved = fs.realpathSync(selected);
    if (/(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(resolved) || /claude-desktop/i.test(resolved)) throw fault('claude_code_path_unsupported');
    fd = fs.openSync(resolved, 'r');
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 64 || before.size > MAX_BINARY_BYTES) throw fault('claude_code_binary_invalid');
    const header = Buffer.alloc(64); fs.readSync(fd, header, 0, header.length, 0);
    if (process.platform === 'win32') {
      const pe = header.readUInt32LE(60), signature = Buffer.alloc(94);
      if (header.toString('ascii', 0, 2) !== 'MZ' || pe < 64 || pe > Math.min(before.size - signature.length, 1048576)) throw fault('claude_code_binary_invalid');
      fs.readSync(fd, signature, 0, signature.length, pe);
      if (signature.readUInt32LE(0) !== 0x4550 || ![0x8664, 0xaa64].includes(signature.readUInt16LE(4))
        || signature.readUInt16LE(24) !== 0x20b || signature.readUInt16LE(92) !== 3) throw fault('claude_code_binary_invalid');
    } else if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && ![0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(header.readUInt32BE(0))) throw fault('claude_code_binary_invalid');
    const hash = crypto.createHash('sha256'), block = Buffer.alloc(65536);
    let offset = 0, size;
    while ((size = fs.readSync(fd, block, 0, block.length, offset)) > 0) { hash.update(block.subarray(0, size)); offset += size; }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || offset !== before.size
      || fs.realpathSync(selected) !== resolved) throw fault('claude_code_binary_changed');
    return { runtimePath: resolved, binaryHash: hash.digest('hex') };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fault('claude_code_not_found');
    if (String(error?.code).startsWith('claude_')) throw error;
    throw fault('claude_code_unreadable');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** --version and --help only; no credentials, prompts, GUI, shell or account queries. */
async function probe(executable, argument) {
  const profile = createClaudeOwnedProfile();
  let child;
  try {
    child = childProcess.spawn(executable, [argument], { cwd: profile.root, env: profile.environment, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { profile.cleanup(); throw fault('claude_code_probe_failed'); }
  let output = Buffer.alloc(0), timedOut = false, overflow = false;
  child.stdout?.on('data', chunk => {
    if (output.length + chunk.length > 65536) { overflow = true; child.kill(); return; }
    output = Buffer.concat([output, chunk]);
  });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  child.once('error', () => { /* Only close proves this profile is no longer in use. */ });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
  let watchdog;
  try {
    const code = await Promise.race([closed, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(fault('claude_code_exit_unconfirmed')), 6000);
    })]);
    profile.cleanup();
    if (timedOut || overflow || code !== 0) throw fault('claude_code_probe_failed');
    return output.toString('utf8').replace(/^\uFEFF/, '').trim();
  } finally { clearTimeout(timer); clearTimeout(watchdog); }
}

/** Exact SDK bytes are checked without evaluating a vendor module or creating a session. */
export function createClaudeRuntimeVerifier({ resourceRoot = APP_PATHS.resourceRoot, envSource = process.env } = {}) {
  const proofs = new Map();
  return Object.freeze({ async inspect(runtimePath = '') {
    const selected = runtimePath || path.join(envSource.USERPROFILE || envSource.HOME || os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    let identity;
    try { identity = binaryIdentity(selected); }
    catch (error) { return { installed: error.code === 'claude_code_unreadable' ? null : false, compatible: false,
      binaryVerified: false, sdkResourcesVerified: false, reason: error.code }; }
    let proof = proofs.get(identity.binaryHash);
    if (!proof) {
      try {
        const versionOutput = await probe(identity.runtimePath, '--version');
        const version = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(versionOutput)?.[1];
        if (!version) throw fault('claude_code_identity_unverified');
        const help = await probe(identity.runtimePath, '--help');
        if (!HELP_FLAGS.every(flag => help.includes(flag)) || !/Claude Code/i.test(help)) throw fault('claude_code_protocol_unverified');
        if (binaryIdentity(selected).binaryHash !== identity.binaryHash) throw fault('claude_code_binary_changed');
        proof = { version }; proofs.set(identity.binaryHash, proof);
        if (proofs.size > 4) proofs.delete(proofs.keys().next().value);
      } catch (error) { return { ...identity, installed: true, compatible: false, binaryVerified: false, sdkResourcesVerified: false, reason: error.code }; }
    }
    const evidence = { ...identity, ...proof, installed: true, compatible: true, binaryVerified: true, sdkResourcesVerified: false };
    try {
      const filename = path.resolve(resourceRoot, CLAUDE_SDK_RESOURCE_FILE);
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size !== 1286220) throw fault('claude_sdk_resource_unverified');
      verifyClaudeSdkBytes(fs.readFileSync(filename));
      return { ...evidence, sdkResourcesVerified: true, sdkHash: CLAUDE_SDK_RESOURCE_SHA256, reason: null };
    } catch { return { ...evidence, reason: 'claude_sdk_resource_unverified' }; /* Optional resource failure affects only Claude. */ }
  } });
}
