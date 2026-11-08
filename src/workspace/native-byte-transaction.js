import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {isSea} from 'node:sea';

export const WORKSPACE_BYTE_REQUEST = 'CETAMESH_WORKSPACE_BYTE_TRANSACTION_V1';
export const WORKSPACE_BYTE_RECEIPT = 'CETAMESH_WORKSPACE_BYTE_TRANSACTION_RECEIPT_V1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const node = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && ['device', 'file'].every(key => typeof value[key] === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value[key]));
const sameNode = (a, b) => a === null && b === null || node(a) && node(b) && a.device === b.device && a.file === b.file;
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), {code, ...extra}); };

/** Trusted composition/test input only; never a tool or renderer parameter. */
export function resolveWorkspaceByteExecutable(override) {
  if (process.platform !== 'win32') fail('WORKSPACE_NATIVE_TRANSACTION_UNAVAILABLE', 'This raw-byte operation needs the verified Windows file primitive');
  const executable = override ?? (isSea() ? path.join(path.dirname(process.execPath), 'WhaleBridge.exe') : null);
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) fail('WORKSPACE_NATIVE_TRANSACTION_UNAVAILABLE', 'The current Desktop host does not provide protected byte operations');
  try {
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw Error('Invalid native host');
    const bytes = fs.readFileSync(executable);
    if (![WORKSPACE_BYTE_REQUEST, WORKSPACE_BYTE_RECEIPT].every(profile => bytes.includes(Buffer.from(profile)))) throw Error('Missing byte profile');
  } catch { fail('WORKSPACE_NATIVE_TRANSACTION_UNAVAILABLE', 'The current Desktop host does not provide protected byte operations'); }
  return executable;
}

export function readWorkspaceByteReceipt(directory, request, requestSha256) {
  const location = path.join(directory, 'receipt.json'), stat = fs.lstatSync(location);
  // Same 256 KiB terminal receipt bound as the native producer.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw Error('Invalid receipt file');
  const bytes = fs.readFileSync(location), value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== WORKSPACE_BYTE_RECEIPT || value.nonce !== request.nonce || value.binding !== request.binding
    || value.requestSha256 !== requestSha256 || !['completed', 'refused', 'rolled-back', 'unknown'].includes(value.status)
    || !['known', 'none', 'unknown'].includes(value.effects) || typeof value.rollbackVerified !== 'boolean'
    || typeof value.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(value.code)
    || !Array.isArray(value.rows) || value.rows.length > request.rows.length
    || !Array.isArray(value.createdDirectories) || value.createdDirectories.length > 1000) throw Error('Unbound native receipt');
  const seen = new Set();
  for (const row of value.rows) {
    const source = request.rows.find(item => item.path === row?.path);
    if (!source || seen.has(row.path) || row.action !== source.action || row.stagedHash !== source.stagedHash
      || ![row.originalHash, row.finalHash].every(item => item === null || hash(item))
      || ![row.originalNode, row.finalNode].every(item => item === null || node(item))) throw Error('Invalid native row');
    seen.add(row.path);
    if (value.status === 'completed' && (row.originalHash !== source.originalHash || !sameNode(row.originalNode, source.originalNode)
      || row.finalHash !== source.stagedHash || (source.action === 'write' ? !node(row.finalNode) : row.finalNode !== null))) throw Error('Unverified native completion');
    if (value.status === 'rolled-back' && (row.finalHash !== row.originalHash || !sameNode(row.finalNode, row.originalNode))) throw Error('Unverified native rollback');
  }
  if (value.status === 'completed' && (value.rows.length !== request.rows.length || value.effects !== 'known')
    || value.status === 'refused' && value.effects !== 'none'
    || value.status === 'rolled-back' && (value.effects !== 'none' || !value.rollbackVerified)
    || value.status === 'unknown' && value.effects !== 'unknown') throw Error('Inconsistent native result');
  for (const row of value.createdDirectories) if (!row || typeof row.path !== 'string' || row.path.length > 1024
    || path.isAbsolute(row.path) || row.path.includes('\\') || row.path.split('/').some(part => !part || part === '.' || part === '..')
    || !node(row.node)) throw Error('Unbound created directory');
  return {receipt: value, receiptSha256: digest(bytes)};
}

/** One fixed child, fully drained before returning any physical outcome. */
export async function runWorkspaceByteTransaction(directory, request, {executable, signal, timeoutMs = 30_000} = {}) {
  if (signal?.aborted) fail('INVOKE_CANCELLED', 'Byte publication was cancelled before native launch', {effectStatus: 'none'});
  if (['native.claimed', 'receipt.json'].some(name => fs.existsSync(path.join(directory, name)))) fail('REQUEST_RECOVERY_REQUIRED', 'This physical byte attempt is already consumed; inspect its retained evidence', {effectStatus: 'unknown'});
  const file = path.join(directory, 'request.json'), bytes = fs.readFileSync(file);
  if (bytes.length > 262144 || request.schema !== WORKSPACE_BYTE_REQUEST || !bytes.equals(Buffer.from(JSON.stringify(request)))) fail('WORKSPACE_NATIVE_REQUEST_INVALID', 'Native byte request changed before launch', {effectStatus: 'none'});
  const requestSha256 = digest(bytes);
  const exit = await new Promise(resolve => {
    let failure = null, spawned = false;
    const child = execFile(executable, ['--workspace-byte-transaction=' + file, '--workspace-byte-sha256=' + requestSha256],
      {cwd: directory, windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 16 * 1024, signal}, error => { if (error) failure = error; });
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => { failure = error; });
    child.once('close', (code, closeSignal) => resolve({code, signal: closeSignal, spawned, failure}));
  });
  let result;
  try {
    if (!fs.readFileSync(file).equals(bytes)) throw Error('Changed native request');
    result = readWorkspaceByteReceipt(directory, request, requestSha256);
  } catch {
    fail('WORKSPACE_NATIVE_OUTCOME_UNKNOWN', 'The exact native file outcome is unavailable; retain original bytes and journal',
      {effectStatus: exit.spawned ? 'unknown' : 'none', causeCode: exit.failure?.code ?? 'NATIVE_RECEIPT_INVALID'});
  }
  if (result.receipt.status !== 'completed') fail('WORKSPACE_NATIVE_' + result.receipt.code, 'Protected file publication did not complete',
    {effectStatus: result.receipt.effects, ...result});
  return {...result, cancelled: signal?.aborted === true, exitCode: exit.code};
}
