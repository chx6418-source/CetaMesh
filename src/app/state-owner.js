import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function busy(message) { return Object.assign(new Error(message), { code: 'STATE_DIR_BUSY' }); }

export function acquireStateOwner(stateDir) {
  const dir = path.resolve(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.core-owner.lock');
  const contents = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old;
      try { old = fs.readFileSync(file, 'utf8'); }
      catch { throw busy('StateDir owner lock cannot be read'); }
      const match = /^(\d+):[a-f0-9]{32}$/.exec(old);
      if (!match) throw busy('StateDir owner lock is invalid; manual recovery required');
      try { process.kill(Number(match[1]), 0); throw busy('Another Core owns this StateDir'); }
      catch (probeError) {
        if (probeError.code !== 'ESRCH') throw probeError;
      }
      const reclaim = file + '.reclaim';
      let reclaimFd;
      try { reclaimFd = fs.openSync(reclaim, 'wx', 0o600); }
      catch { throw busy('StateDir lock recovery is already in progress'); }
      try {
        if (fs.readFileSync(file, 'utf8') !== old) throw busy('StateDir owner changed during recovery');
        fs.unlinkSync(file);
      } finally {
        fs.closeSync(reclaimFd);
        fs.unlinkSync(reclaim);
      }
      continue;
    }
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
    catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
    fs.closeSync(fd);
    return {
      file,
      release() {
        try { if (fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    };
  }
  throw busy('StateDir ownership could not be acquired');
}
