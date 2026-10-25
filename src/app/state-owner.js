import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText, writeJsonAtomic } from '../storage/json-file.js';
import { isProcessIdentity, probeProcessIdentity } from './process-identity.js';

function busy(message) { return Object.assign(new Error(message), { code: 'STATE_DIR_BUSY' }); }
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function observe(probe, pid) {
  try {
    const result = probe(pid);
    if (result?.state === 'dead') return result;
    if (result?.state === 'alive' && isProcessIdentity(result.identity)) return result;
  } catch { return { state: 'unknown' }; /* Permission errors and unsupported probes cannot authorize recovery. */ }
  return { state: 'unknown' };
}
function lockPid(contents) {
  const match = /^([1-9]\d*):[a-f0-9]{32}$/.exec(contents);
  const pid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(pid)) throw busy('StateDir owner lock is invalid; manual recovery required');
  return pid;
}
function readLock(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { throw busy('StateDir owner lock cannot be read'); }
}
function readIdentity(file) {
  const limit = 4096;
  let fd;
  let data;
  try {
    fd = fs.openSync(file, 'r');
    // Read one sentinel byte beyond the limit. Checking after readFileSync
    // would still allocate/read the entire untrusted file before rejecting it.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw busy('StateDir owner identity is too large; manual recovery required');
    data = buffer.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return { fingerprint: null, record: null };
    if (error.code === 'STATE_DIR_BUSY') throw error;
    throw busy('StateDir owner identity cannot be read');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let record = null;
  try { record = parseJsonText(data.toString('utf8'), { file }); }
  catch { record = null; /* Invalid metadata never proves that an alive PID was reused. */ }
  return { fingerprint: digest(data), record };
}
function boundRecord(record, contents, pid) {
  return record?.version === 1 && record.pid === pid && record.lockHash === digest(contents);
}
function assertRecoverable(contents, metadata, probe) {
  const pid = lockPid(contents);
  const observed = observe(probe, pid);
  if (observed.state === 'dead') return;
  const recorded = metadata.record?.processIdentity;
  if (observed.state === 'alive' && boundRecord(metadata.record, contents, pid) && isProcessIdentity(recorded)
      && recorded.kind === observed.identity.kind && recorded.value !== observed.identity.value) return;
  throw busy('Another Core owns this StateDir, or its process identity is unknown');
}
function unlinkMatching(file, contents) {
  try { if (fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function recover(file, identityFile, contents, metadata, probe) {
  assertRecoverable(contents, metadata, probe);
  const reclaim = file + '.reclaim';
  const claim = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  let fd;
  try { fd = fs.openSync(reclaim, 'wx', 0o600); }
  catch { throw busy('StateDir lock recovery is already in progress'); }
  try {
    fs.writeFileSync(fd, claim);
    if (readLock(file) !== contents || readIdentity(identityFile).fingerprint !== metadata.fingerprint) {
      throw busy('StateDir owner changed during recovery');
    }
    // The first probe may have raced exit, PID reuse, publication or release.
    // Repeat it under the recovery guard, then re-read both bound files.
    assertRecoverable(contents, metadata, probe);
    if (readLock(file) !== contents || readIdentity(identityFile).fingerprint !== metadata.fingerprint) {
      throw busy('StateDir owner changed during recovery');
    }
    // Metadata goes first. A successor may create its lock immediately after
    // unlink, so this recovery must never touch metadata after that point.
    if (boundRecord(metadata.record, contents, lockPid(contents))) fs.unlinkSync(identityFile);
    fs.unlinkSync(file);
  } finally {
    fs.closeSync(fd);
    unlinkMatching(reclaim, claim);
  }
}

export function acquireStateOwner(stateDir, { probeProcess = probeProcessIdentity } = {}) {
  const dir = path.resolve(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.core-owner.lock');
  const identityFile = path.join(dir, '.core-owner.identity.json');
  // Keep these bytes compatible with older Core/Legacy clients.
  const contents = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = readLock(file);
      recover(file, identityFile, old, readIdentity(identityFile), probeProcess);
      continue;
    }
    const opened = fs.fstatSync(fd);
    let written = false;
    try {
      fs.writeFileSync(fd, contents);
      written = true;
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      const observed = observe(probeProcess, process.pid);
      const record = { version: 1, pid: process.pid, lockHash: digest(contents), processIdentity: observed.state === 'alive' ? observed.identity : null };
      if (readLock(file) !== contents) throw busy('StateDir owner changed during acquisition');
      // Our valid lock with our alive PID excludes both old and new clients
      // while the sidecar is published, including when the probe is unknown.
      writeJsonAtomic(identityFile, record);
      if (readLock(file) !== contents) throw busy('StateDir owner changed during acquisition');
      const published = readIdentity(identityFile).fingerprint;
      return {
        file,
        release() {
          try {
            if (fs.readFileSync(file, 'utf8') !== contents) return;
            const metadata = readIdentity(identityFile);
            if (metadata.fingerprint === published && boundRecord(metadata.record, contents, process.pid)) fs.unlinkSync(identityFile);
            // Delete only our lease, after deleting only our bound sidecar.
            unlinkMatching(file, contents);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      // A completed lock must still contain our nonce. For an interrupted write,
      // also require our opened file identity and an exact prefix of our bytes.
      try {
        if (written) unlinkMatching(file, contents);
        else {
          const current = fs.statSync(file);
          const partial = fs.readFileSync(file, 'utf8');
          if (current.dev === opened.dev && current.ino === opened.ino && contents.startsWith(partial)) fs.unlinkSync(file);
        }
      } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
      throw error;
    }
  }
  throw busy('StateDir ownership could not be acquired');
}
