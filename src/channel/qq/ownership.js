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
  const contents = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw busy(kind);
    throw error;
  }
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  fs.closeSync(fd);
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
