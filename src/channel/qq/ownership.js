import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function busy(kind) {
  return Object.assign(new Error(`QQ ${kind} is already owned or its previous owner has not been confirmed stopped`), { code: 'QQ_ACCOUNT_BUSY' });
}

export function acquireQqOwnership(kind, identity, directory = path.join(os.tmpdir(), 'cetamesh-qq-ownership')) {
  const key = crypto.createHash('sha256').update(`${kind}:${identity}`).digest('hex');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${kind}-${key}.lock`);
  const recoveryFile = `${file}.recovering`;
  const contents = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  // A recovery owner is replacing a proven-dead holder. Nobody may claim the
  // account in the gap between archiving that lock and creating its successor.
  if (fs.existsSync(recoveryFile)) throw busy(kind);
  let fd;
  let recoveryContents = null;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    recoveryContents = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
    let recoveryFd;
    try { recoveryFd = fs.openSync(recoveryFile, 'wx', 0o600); }
    catch { throw busy(kind); /* Another recovery owner is in progress or the guard cannot be trusted. */ }
    try {
      fs.writeFileSync(recoveryFd, recoveryContents);
      fs.fsyncSync(recoveryFd);
    } finally { fs.closeSync(recoveryFd); }
    try {
      const previous = fs.readFileSync(file, 'utf8');
      const match = /^([1-9]\d*):([a-f0-9]{32})$/.exec(previous);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw busy(kind);
      try { process.kill(Number(match[1]), 0); }
      catch (probeError) {
        if (probeError?.code !== 'ESRCH') throw busy(kind);
        const evidenceFile = `${file}.dead-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        if (fs.readFileSync(file, 'utf8') !== previous) throw busy(kind);
        fs.renameSync(file, evidenceFile);
        fd = fs.openSync(file, 'wx', 0o600);
      }
      if (fd === undefined) throw busy(kind);
    } catch (recoveryError) {
      try { if (fs.readFileSync(recoveryFile, 'utf8') === recoveryContents) fs.unlinkSync(recoveryFile); }
      catch (guardError) { void guardError; /* Preserve an uncertain guard and fail closed. */ }
      if (recoveryError?.code === 'QQ_ACCOUNT_BUSY') throw recoveryError;
      throw busy(kind);
    }
  }
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    if (recoveryContents !== null) {
      try { if (fs.readFileSync(recoveryFile, 'utf8') === recoveryContents) fs.unlinkSync(recoveryFile); }
      catch (cleanupError) { void cleanupError; /* Preserve uncertain recovery evidence. */ }
    }
    throw error;
  }
  fs.closeSync(fd);
  if (recoveryContents !== null) {
    try {
      if (fs.readFileSync(recoveryFile, 'utf8') !== recoveryContents) throw busy(kind);
      fs.unlinkSync(recoveryFile);
    } catch (guardError) {
      try { if (fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file); }
      catch (cleanupError) { void cleanupError; /* Keep uncertain ownership evidence intact. */ }
      throw busy(kind); // Missing or altered guard prevents claiming the lease.
    }
  }
  let released = false;
  const lease = {
    release() {
      if (released) return;
      released = true;
      process.off('exit', lease.release);
      try { if (fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  };
  process.once('exit', lease.release);
  return lease;
}
