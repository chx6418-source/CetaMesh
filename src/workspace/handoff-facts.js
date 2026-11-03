import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gitRun, gitStatus, readFile } from './tools.js';
import { resolveInside } from './boundary.js';

const MAX_FILES = 25000;
const MAX_BYTES = 64 * 1024 * 1024;
const protectedPath = value => value.split(/[\\/]/).some(part =>
  /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part));
const fail = () => { throw Object.assign(new Error('Workspace content proof is unavailable'), {code:'WORKSPACE_UNVERIFIED'}); };

// Core-only observation. The packet receives one digest, with no file contents or per-file hashes.
export async function workspaceContentProof(root, {relevantFiles = []} = {}) {
  const status = await gitStatus(root, {completeFiles:true});
  const relevant = relevantFiles.map(file => String(file));
  if (relevant.some(protectedPath) || status.entries.some(row =>
    protectedPath(row.path) || (row.origPath && protectedPath(row.origPath)))) fail();
  const readIndex = async () => status.isRepo
    ? (await gitRun(root, ['ls-files','--stage','-z','--','.'])).stdout : '';
  const readUntracked = async () => status.isRepo
    ? (await gitRun(root, ['ls-files','--others','--exclude-standard','-z','--','.'])).stdout : '';
  const index = await readIndex(), untracked = await readUntracked();
  const names = new Set([...untracked.split('\0').filter(Boolean), ...relevant]);
  for (const entry of index.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== '0' || !['100644','100755'].includes(match[1])) fail();
    names.add(match[4]);
  }
  if (names.size > MAX_FILES) fail();
  const hash = crypto.createHash('sha256').update(index);
  const observed = [];
  let bytes = 0;
  for (const name of [...names].sort()) {
    if (protectedPath(name)) { hash.update(JSON.stringify([name,'protected-index-entry'])); continue; }
    const resolved = resolveInside(root,name);
    // Reparse points can change scope during a snapshot. Require a regular canonical path.
    if (path.relative(resolved.absolute,resolved.real)) fail();
    let stat;
    try { stat = fs.lstatSync(resolved.real); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update(JSON.stringify([name,'missing']));
      observed.push([resolved.real,null]);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024 || (bytes += stat.size) > MAX_BYTES) fail();
    const file = readFile(root,name,{maxBytes:Math.max(stat.size,1)});
    if (!file.expectedHash || file.truncated) fail();
    observed.push([resolved.real,stat]);
    hash.update(JSON.stringify([name,stat.mode,file.expectedHash]));
  }
  // Recheck the index, file set and identities after the last asynchronous Git read.
  if (index !== await readIndex() || untracked !== await readUntracked()) fail();
  if (JSON.stringify(status) !== JSON.stringify(await gitStatus(root,{completeFiles:true}))) fail();
  for (const [file, before] of observed) {
    let after;
    try { after = fs.lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!before && !after) continue;
    if (!before || !after || !after.isFile() || after.isSymbolicLink() ||
      ['ino','dev','size','mtimeMs','ctimeMs'].some(key => before[key] !== after[key])) fail();
  }
  return {kind:status.isRepo?'git-workspace-v1':'relevant-files-v1',sha256:hash.digest('hex')};
}
