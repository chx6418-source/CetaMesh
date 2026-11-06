import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gitRun, gitStatus } from './tools.js';
import { resolveInside } from './boundary.js';
import { collectStagingSourceSnapshot } from './staging.js';
import { observeNestedGit } from './nested-git-facts.js';
import { assertObservationActive } from './observation-abort.js';

const MAX_FILES = 25000;
// Read-only aggregate limit matches staging input; import/write limits are unchanged.
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const protectedPath = value => value.split(/[\\/]/).some(part =>
  /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part));
const fail = reasonCode => { throw Object.assign(new Error('Workspace content proof is unavailable'), {code:'WORKSPACE_UNVERIFIED',
  ...(reasonCode ? {reasonCode} : {})}); };

function hashObservedFile(root, name, before, signal) {
  assertObservationActive(signal);
  const resolved = resolveInside(root, name);
  if (path.relative(resolved.absolute, resolved.real)) fail('WORKSPACE_CONTENT_PATH_UNVERIFIED');
  const same = after => after && ['ino', 'dev', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);
  const handle = fs.openSync(resolved.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(fs.fstatSync(handle))) fail('WORKSPACE_CONTENT_CHANGED');
    const buffer = Buffer.allocUnsafe(64 * 1024), hash = crypto.createHash('sha256');
    let bytes = 0;
    for (;;) {
      assertObservationActive(signal);
      const count = fs.readSync(handle, buffer, 0, Math.min(buffer.length, before.size - bytes + 1), null);
      if (!count) break;
      bytes += count;
      if (bytes > before.size) fail('WORKSPACE_CONTENT_CHANGED');
      hash.update(buffer.subarray(0, count));
    }
    assertObservationActive(signal);
    if (bytes !== before.size || !same(fs.fstatSync(handle)) || !same(fs.lstatSync(resolved.real))) fail('WORKSPACE_CONTENT_CHANGED');
    return hash.digest('hex');
  } finally { fs.closeSync(handle); }
}

// Core-only observation. The packet receives one digest, with no file contents or per-file hashes.
export async function workspaceContentProof(root, {relevantFiles = [], additionalWorkspaceRoots, excludedRoots,
  trustedSourceRoot = null, maxFiles = MAX_FILES, maxBytes = MAX_BYTES, signal} = {}) {
  assertObservationActive(signal);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) fail();
  const checks = [], seenRepositories = new Set();
  let fileCount = 0, totalBytes = 0;
  const consume = (files, bytes) => {
    fileCount += files; totalBytes += bytes;
    if (fileCount > maxFiles || totalBytes > maxBytes) fail('WORKSPACE_CONTENT_LIMIT_EXCEEDED');
  };
  const nestedProof = async (directory, files, depth) => {
    assertObservationActive(signal);
    if (depth > 8 || seenRepositories.size >= 32 || seenRepositories.has(directory)) fail('WORKSPACE_CONTENT_LIMIT_EXCEEDED');
    seenRepositories.add(directory);
    let metadata;
    try { metadata = observeNestedGit(root, directory, { additionalWorkspaceRoots, excludedRoots, signal }); }
    catch (error) { assertObservationActive(signal); fail(error?.reasonCode ?? 'WORKSPACE_CONTENT_NESTED_REPOSITORY'); }
    checks.push(metadata.assertUnchanged);
    const proof = await collect(directory, files, depth, metadata);
    return crypto.createHash('sha256').update(JSON.stringify(['nested-git-v1', metadata.sha256, proof.sha256])).digest('hex');
  };
  async function collect(directory, relevantFiles, depth = 0, metadata = null) {
  assertObservationActive(signal);
  let status;
  // Nested observations use only ls-files with fixed metadata/worktree paths.
  // They never run status/diff recursively or inherit a configured core.worktree.
  const run = args => gitRun(directory, [...(metadata ? ['--git-dir=' + metadata.gitDir, '--work-tree=' + directory] : []), ...args], { signal });
  try { status = metadata ? { isRepo: true, entries: [] } : await gitStatus(directory, {completeFiles:true, signal}); }
  catch { assertObservationActive(signal); fail(); }
  const relevant = relevantFiles.map(file => String(file));
  if (relevant.some(protectedPath) || status.entries.some(row =>
    protectedPath(row.path) || (row.origPath && protectedPath(row.origPath)))) fail();
  if (!status.isRepo) {
    try {
      const nested = [];
      const snapshot = collectStagingSourceSnapshot({ sourceRoot: directory, additionalWorkspaceRoots, excludedRoots,
        trustedSourceRoot, maxFiles: Math.max(1, maxFiles - fileCount), maxBytes: Math.max(1, maxBytes - totalBytes),
        observeNestedRepository: source => nested.push(source), signal });
      consume(snapshot.files.size, snapshot.totalBytes);
      checks.push(snapshot.assertUnchanged);
      // A declared relevant path cannot borrow evidence from an excluded subtree.
      for (const name of relevant) {
        assertObservationActive(signal);
        const resolved = resolveInside(directory, name);
        const relative = path.relative(directory, resolved.absolute).split(path.sep).join('/');
        const insideNested = nested.some(source => resolved.real.startsWith(source + path.sep));
        if (!snapshot.files.has(relative) && !insideNested && fs.existsSync(resolved.real)) fail();
      }
      const scopeSha256 = crypto.createHash('sha256').update(JSON.stringify(snapshot.scope)).digest('hex');
      const hash = crypto.createHash('sha256').update(JSON.stringify(['filtered-workspace-v1', scopeSha256]));
      for (const [name, row] of [...snapshot.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        assertObservationActive(signal);
        hash.update(JSON.stringify([name, row.size, row.mode, row.hash]));
      }
      for (const source of nested.sort()) {
        const name = path.relative(directory, source).split(path.sep).join('/');
        const selected = relevant.filter(file => file.startsWith(name + '/')).map(file => file.slice(name.length + 1));
        hash.update(JSON.stringify([name, await nestedProof(source, selected, depth + 1)]));
      }
      if (JSON.stringify(status) !== JSON.stringify(await gitStatus(directory, { completeFiles: true, signal }))) fail();
      return { kind: 'filtered-workspace-v1', sha256: hash.digest('hex'), scopeSha256,
        fileCount, totalBytes };
    } catch (error) {
      assertObservationActive(signal);
      fail(error?.reasonCode ?? (error?.code === 'WORKSPACE_CONTENT_NESTED_REPOSITORY' ? error.code : undefined));
    }
  }
  const readIndex = async () => status.isRepo
    ? (await run(['ls-files','--stage','-z','--','.'])).stdout : '';
  const readUntracked = async () => status.isRepo
    ? (await run(['ls-files','--others','--exclude-standard','-z','--','.'])).stdout : '';
  const index = await readIndex(), untracked = await readUntracked();
  const names = new Set([...untracked.split('\0').filter(Boolean), ...relevant]);
  for (const entry of index.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== '0' || !['100644','100755'].includes(match[1])) fail();
    names.add(match[4]);
  }
  consume(names.size, 0);
  const hash = crypto.createHash('sha256').update(index);
  const observed = [];
  let untilYield = 64;
  for (const name of [...names].sort()) {
    assertObservationActive(signal);
    if (signal && --untilYield === 0) { await new Promise(resolve => setImmediate(resolve)); untilYield = 64; assertObservationActive(signal); }
    if (protectedPath(name)) { hash.update(JSON.stringify([name,'protected-index-entry'])); continue; }
    const resolved = resolveInside(directory,name);
    // Reparse points can change scope during a snapshot. Require a regular canonical path.
    if (path.relative(resolved.absolute,resolved.real)) fail('WORKSPACE_CONTENT_PATH_UNVERIFIED');
    let stat;
    try { stat = fs.lstatSync(resolved.real); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update(JSON.stringify([name,'missing']));
      observed.push([resolved.real,null]);
      continue;
    }
    if (stat.isDirectory() && fs.existsSync(path.join(resolved.real, '.git'))) {
      const prefix = name.replace(/\/$/, '') + '/';
      const selected = relevant.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length));
      hash.update(JSON.stringify([name, 'nested-git-v1', await nestedProof(resolved.real, selected, depth + 1)]));
      observed.push([resolved.real, stat]);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('WORKSPACE_CONTENT_PATH_UNVERIFIED');
    if (stat.size > MAX_FILE_BYTES) fail('WORKSPACE_CONTENT_LIMIT_EXCEEDED');
    consume(0, stat.size);
    const sha256 = hashObservedFile(directory, name, stat, signal);
    observed.push([resolved.real,stat]);
    hash.update(JSON.stringify([name,stat.mode,sha256]));
  }
  // Recheck the index, file set and identities after the last asynchronous Git read.
  if (index !== await readIndex() || untracked !== await readUntracked()) fail('WORKSPACE_CONTENT_CHANGED');
  if (!metadata && JSON.stringify(status) !== JSON.stringify(await gitStatus(directory,{completeFiles:true,signal}))) fail('WORKSPACE_CONTENT_CHANGED');
  checks.push(() => { for (const [file, before] of observed) {
    assertObservationActive(signal);
    let after;
    try { after = fs.lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!before && !after) continue;
    if (!before || !after || before.isFile() !== after.isFile() || after.isSymbolicLink() ||
      ['ino','dev','mode','size','mtimeMs','ctimeMs'].some(key => before[key] !== after[key])) fail('WORKSPACE_CONTENT_CHANGED');
    const resolved = resolveInside(directory, file);
    if (path.relative(resolved.absolute, resolved.real)) fail('WORKSPACE_CONTENT_PATH_UNVERIFIED');
  } });
  return {kind:status.isRepo?'git-workspace-v1':'relevant-files-v1',sha256:hash.digest('hex')};
  }
  let proof;
  try { proof = await collect(root, relevantFiles); }
  catch (error) { assertObservationActive(signal); fail(error?.reasonCode ?? (['BOUNDARY_ESCAPE', 'PATH_INVALID'].includes(error?.code) ? 'WORKSPACE_CONTENT_PATH_UNVERIFIED' : undefined)); }
  // No await after these checks: later siblings and the final native Git probe
  // must not certify an earlier repository whose metadata or files changed.
  for (const check of checks) {
    try { assertObservationActive(signal); check(); }
    catch (error) { assertObservationActive(signal); fail(error?.reasonCode ?? 'WORKSPACE_CONTENT_CHANGED'); }
  }
  assertObservationActive(signal);
  return proof;
}
