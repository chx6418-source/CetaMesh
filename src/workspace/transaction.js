import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { resolveInside } from './boundary.js';
import { WORKSPACE_BYTE_REQUEST, resolveWorkspaceByteExecutable, runWorkspaceByteTransaction, readWorkspaceByteReceipt } from './native-byte-transaction.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
// Opaque, same-Core receipts minted only after final rollback verification.
// They survive a cleanup error, not a Core restart, and never prove execution exit.
const verifiedRollbacks = new WeakMap();

export function workspaceJournalDir(rootReal) {
  return path.join(os.tmpdir(), 'CetaMesh', 'workspace-import-journal', digest(Buffer.from(rootReal)).slice(0, 32));
}

function targetFor(rootReal, rel) {
  const resolved = resolveInside(rootReal, rel, { forWrite: true });
  const target = resolved.absolute;
  let stat = null;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw failure('IMPORT_TARGET_INVALID', 'Import target must be a regular file');
  return { target, bytes: stat ? fs.readFileSync(target) : null };
}

function saveManifest(dir, manifest) { writeJsonAtomic(path.join(dir, 'manifest.json'), manifest); }

function removeJournal(dir, parent) {
  if (path.dirname(path.resolve(dir)) !== path.resolve(parent)) throw failure('IMPORT_JOURNAL_INVALID', 'Journal path escaped its parent');
  fs.rmSync(dir, { recursive: true, force: true });
}

function restoreOne(rootReal, dir, row) {
  const { target, bytes } = targetFor(rootReal, row.path);
  const liveHash = bytes === null ? null : digest(bytes);
  if (liveHash === row.originalHash) return;
  if (liveHash !== row.stagedHash) throw failure('WORKSPACE_RECOVERY_REQUIRED', `Workspace file changed during import recovery: ${row.path}`);
  if (row.originalHash === null) {
    fs.unlinkSync(target);
  } else {
    const backupFile = path.join(dir, row.backup);
    const backupStat = fs.lstatSync(backupFile);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Preimage backup is invalid');
    const original = fs.readFileSync(backupFile);
    if (digest(original) !== row.originalHash) throw failure('IMPORT_JOURNAL_INVALID', 'Preimage backup hash mismatch');
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.recovery`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, original); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const current = targetFor(rootReal, row.path).bytes;
      if ((current === null ? null : digest(current)) !== liveHash) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Target changed during recovery');
      fs.renameSync(temp, target);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function readImportBatch(rootReal, journalDir, name, receipt) {
    if (/^retirement-[a-f0-9]{64}\.json$/.test(name)) return readByteBatch(rootReal, journalDir, name);
    const dir = path.join(journalDir, name);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import batch directory is invalid');
    const manifestFile = path.join(dir, 'manifest.json');
    let manifestStat;
    try { manifestStat = fs.lstatSync(manifestFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw failure('IMPORT_JOURNAL_INCOMPLETE', 'Import intent is incomplete; preserve this project and its journal for review');
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import manifest is invalid');
    const manifest = readJsonFile(manifestFile);
    if (manifest?.schemaVersion === 2) {
      const batch = readByteBatch(rootReal, journalDir, name);
      if (!['completed', 'completed-no-effect'].includes(batch.manifest.status)) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'A protected file set needs its original Git recovery flow; file effects are never replayed');
      return batch;
    }
    if (manifest?.schemaVersion !== 1 || manifest.root !== rootReal || !Array.isArray(manifest.rows)
      || manifest.rows.length < 1 || manifest.rows.length > 500
      || !['prepared', 'committing', 'completed'].includes(manifest.status)
      || manifest.rows.some((row, index) => !row || !['write', 'delete'].includes(row.action)
        || typeof row.path !== 'string' || !/^[a-f0-9]{64}$/.test(row.stagedHash ?? '') && row.stagedHash !== null
        || !/^[a-f0-9]{64}$/.test(row.originalHash ?? '') && row.originalHash !== null
        || row.backup !== (row.originalHash === null ? null : `${index}.preimage`))) {
      throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import journal is invalid');
    }
    const sha256 = digest(JSON.stringify(manifest));
    const verified = receipt && typeof receipt === 'object' ? verifiedRollbacks.get(receipt) : null;
    const rollbackVerified = verified?.root === rootReal && verified.name === name && verified.sha256 === sha256;
    const seen = new Set();
    for (const row of manifest.rows) {
      const key = resolveInside(rootReal, row.path, { forWrite: true }).absolute;
      const identity = process.platform === 'win32' ? key.toLowerCase() : key;
      if (seen.has(identity)) throw failure('IMPORT_JOURNAL_INVALID', 'Duplicate import target');
      seen.add(identity);
      // A durably completed import only needs cleanup, never rollback. Its
      // preimages may already have been removed by interrupted cleanup.
      if (rollbackVerified) {
        const { bytes } = targetFor(rootReal, row.path);
        if ((bytes === null ? null : digest(bytes)) !== row.originalHash) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Verified rollback content changed before cleanup');
      } else if (manifest.status !== 'completed' && row.backup !== null) {
        const file = path.join(dir, row.backup), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || digest(fs.readFileSync(file)) !== row.originalHash) {
          throw failure('IMPORT_JOURNAL_INVALID', 'Original import preimage cannot be verified');
        }
      }
    }
    // Manifest binds root, ordered paths, original/staged hashes and backup names.
    // Pending imports also require every original preimage; completed imports
    // authorize cleanup only and never supply a rollback content proof.
    return { dir, manifest, evidence: { name, sha256, ...(rollbackVerified ? { receipt } : {}) } };
}

function importBatchNames(journalDir) {
  if (!fs.existsSync(journalDir)) return [];
  const stat = fs.lstatSync(journalDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import journal directory is invalid');
  const names = fs.readdirSync(journalDir).sort();
  // A retirement proof and its directory are one cleanup obligation. The
  // reader still validates both identities before granting cleanup authority.
  return names.filter(name => !/^cleanup-[a-f0-9]{64}$/.test(name)
    || !names.includes('retirement-' + name.slice(8) + '.json'));
}

// Read-only, content-bound evidence for the existing Owner recovery coordinator.
export function workspaceImportEvidence(rootReal, { journalDir = workspaceJournalDir(rootReal), verifiedBatches = [] } = {}) {
  return importBatchNames(journalDir).map(name => readImportBatch(rootReal, journalDir, name,
    verifiedBatches.find(row => row.name === name)?.receipt).evidence);
}

export function recoverWorkspaceImports(rootReal, { journalDir = workspaceJournalDir(rootReal), expectedBatches, onVerified, onRecovered } = {}) {
  const evidence = workspaceImportEvidence(rootReal, { journalDir, verifiedBatches: expectedBatches });
  const identities = rows => rows.map(({ name, sha256 }) => ({ name, sha256 }));
  if (expectedBatches !== undefined && (!expectedBatches.length
    || JSON.stringify(identities(evidence)) !== JSON.stringify(identities(expectedBatches)))) {
    throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Original import batch evidence is missing or changed');
  }
  const recovered = [];
  for (const expected of evidence) {
    const { dir, manifest, evidence: current } = readImportBatch(rootReal, journalDir, expected.name, expected.receipt);
    if (current.sha256 !== expected.sha256) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Import evidence changed before recovery');
    if (manifest.schemaVersion === 2) {
      removeByteBatch(dir, fs.realpathSync.native(journalDir), manifest);
      recovered.push(expected.name); onRecovered?.(expected); continue;
    }
    if (manifest.status !== 'completed') {
      for (const row of [...manifest.rows].reverse()) restoreOne(rootReal, dir, row);
      for (const row of manifest.rows) {
        const { bytes } = targetFor(rootReal, row.path);
        if ((bytes === null ? null : digest(bytes)) !== row.originalHash) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Recovered target changed before settlement');
      }
    }
    if (readImportBatch(rootReal, journalDir, expected.name, expected.receipt).evidence.sha256 !== expected.sha256) {
      throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Import evidence changed during recovery');
    }
    if (manifest.status !== 'completed') {
      const receipt = {};
      verifiedRollbacks.set(receipt, { root: rootReal, name: expected.name, sha256: expected.sha256 });
      onVerified?.({ ...expected, receipt });
    }
    removeJournal(dir, journalDir);
    recovered.push(expected.name);
    onRecovered?.(expected);
  }
  if (importBatchNames(journalDir).length) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Another import appeared during recovery');
  return recovered;
}

export function applyWorkspaceTransaction(rootReal, changes, { journalDir = workspaceJournalDir(rootReal), writeFile, beforeCommit, onRecoveryVerified, onRecoverySettled } = {}) {
  recoverWorkspaceImports(rootReal, { journalDir, onVerified: onRecoveryVerified, onRecovered: onRecoverySettled });
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 500) throw failure('INVALID_CHANGES', 'Workspace import needs 1-500 changes');
  const seen = new Set();
  const rows = changes.map((change, index) => {
    if (!change || !['write', 'delete'].includes(change.action) || typeof change.path !== 'string') throw failure('INVALID_CHANGES', 'Invalid Workspace change');
    const rel = change.path.replaceAll('\\', '/');
    const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
    if (seen.has(key)) throw failure('INVALID_CHANGES', 'Duplicate Workspace import path');
    seen.add(key);
    const { bytes } = targetFor(rootReal, rel);
    const originalHash = bytes === null ? null : digest(bytes);
    if (change.expectedHash !== undefined && change.expectedHash !== originalHash) throw failure('WORKSPACE_CONFLICT', `Workspace file changed since staging: ${rel}`);
    if (change.action === 'delete' && bytes === null) throw failure('FILE_NOT_FOUND', `Delete target does not exist: ${rel}`);
    if (change.action === 'write' && typeof change.content !== 'string') throw failure('INVALID_CHANGES', 'Import write content must be text');
    const stagedHash = change.action === 'write' ? digest(Buffer.from(change.content, 'utf8')) : null;
    if (change.action === 'write' && change.hash !== undefined && change.hash !== stagedHash) throw failure('IMPORT_HASH_MISMATCH', 'Staged content hash mismatch');
    return { action: change.action, path: rel, originalHash, stagedHash, backup: bytes === null ? null : `${index}.preimage` };
  });
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(journalDir, 'batch-'));
  const manifest = { schemaVersion: 1, root: rootReal, status: 'prepared', rows };
  try {
    rows.forEach((row, index) => {
      if (row.backup) {
        const { bytes } = targetFor(rootReal, row.path);
        if (digest(bytes) !== row.originalHash) throw failure('WORKSPACE_CONFLICT', 'Workspace file changed during preparation');
        const fd = fs.openSync(path.join(dir, row.backup), 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    });
    saveManifest(dir, manifest);
    manifest.status = 'committing';
    saveManifest(dir, manifest);
    const results = [];
    for (let index = 0; index < changes.length; index++) {
      beforeCommit?.(index);
      const row = rows[index], change = changes[index];
      if (row.action === 'write') {
        results.push({ action: 'write', ...writeFile(rootReal, row.path, change.content, { expectedHash: row.originalHash }) });
      } else {
        const { target, bytes } = targetFor(rootReal, row.path);
        if (digest(bytes) !== row.originalHash) throw failure('WORKSPACE_CONFLICT', 'Delete target changed during import');
        fs.unlinkSync(target);
        results.push({ action: 'delete', path: row.path });
      }
    }
    manifest.status = 'completed';
    saveManifest(dir, manifest);
    let cleanupPending = false;
    try { removeJournal(dir, journalDir); }
    catch (cleanupError) { cleanupPending = true; }
    return { changes: results, ...(cleanupPending ? { cleanupPending: true } : {}) };
  } catch (error) {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      removeJournal(dir, journalDir);
      throw error;
    }
    try { recoverWorkspaceImports(rootReal, { journalDir, onVerified: onRecoveryVerified, onRecovered: onRecoverySettled }); }
    catch (recoveryError) { throw failure('WORKSPACE_RECOVERY_REQUIRED', `${error.message}; recovery: ${recoveryError.message}`); }
    throw error;
  }
}

// Raw Git output shares this Workspace journal owner. It has a distinct format:
// v1 readers refuse it instead of applying legacy path-based recovery/cleanup.
const BYTE_KIND = 'protected-raw-byte-set-v1';
const byteHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const byteNode = stat => ({device: String(stat.dev), file: String(stat.ino)});
const equalByteNode = (stat, node) => node && String(stat.dev) === node.device && String(stat.ino) === node.file;
function byteFailure(code, message, extra = {}) { return Object.assign(failure(code, message), extra); }
function byteRelative(root, rel, syntaxOnly = false) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.length > 1024
    || path.isAbsolute(rel) || rel.split('/').some(part => !part || part === '.' || part === '..'
      || /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part))) throw byteFailure('INVALID_CHANGES', 'Raw publication requires exact ordinary relative files');
  return syntaxOnly ? null : resolveInside(root, rel, {forWrite: true}).absolute;
}
function persistByteManifest(dir, value) {
  saveManifest(dir, value);
  const fd = fs.openSync(path.join(dir, 'manifest.json'), 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeByteArtifact(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function assertByteRoot(root, expected) {
  const stat = fs.lstatSync(root, {bigint: true});
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root || !equalByteNode(stat, expected)) throw byteFailure('WORKSPACE_CONFLICT', 'The admitted raw-byte Workspace root changed');
}
function currentByteFile(root, row) {
  const target = byteRelative(root, row.path);
  let stat; try { stat = fs.lstatSync(target, {bigint: true}); } catch (error) { if (error.code === 'ENOENT') return {hash: null, node: null}; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10n * 1024n * 1024n) throw byteFailure('WORKSPACE_CONFLICT', 'A raw-byte target changed type or size');
  const fd = fs.openSync(target, 'r');
  try {
    const before = fs.fstatSync(fd, {bigint: true}), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, {bigint: true}), named = fs.lstatSync(target, {bigint: true});
    if (![before, after, named].every(item => item.isFile() && equalByteNode(item, byteNode(stat)) && item.size === stat.size
      && item.mtimeNs === stat.mtimeNs && item.ctimeNs === stat.ctimeNs)) throw byteFailure('WORKSPACE_CONFLICT', 'Raw bytes changed while observing the native result');
    return {hash: digest(bytes), node: byteNode(after)};
  } finally { fs.closeSync(fd); }
}
function removeByteBatch(dir, parent, manifest) {
  const {nonce} = manifest.request, expectedNode = manifest.journalNode;
  if (!['completed', 'completed-no-effect'].includes(manifest.status)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Only a terminal batch can retire');
  assertByteRoot(manifest.root, manifest.request.rootNode);
  const proofName = 'retirement-' + nonce + '.json', proof = path.join(parent, proofName);
  const retired = path.join(parent, 'cleanup-' + nonce);
  if (fs.existsSync(proof)) {
    const recorded = readByteBatch(manifest.root, parent, proofName);
    if (JSON.stringify(recorded.manifest) !== JSON.stringify(manifest)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Raw-byte retirement proof changed');
    dir = retired;
  }
  let stat;
  try { stat = fs.lstatSync(dir, {bigint: true}); } catch (error) {
    if (error.code !== 'ENOENT' || !fs.existsSync(proof)) throw error;
    // Last unlink may itself have failed after the owned directory was removed.
    fs.unlinkSync(proof); return;
  }
  if (path.dirname(path.resolve(dir)) !== fs.realpathSync.native(parent) || !['batch-' + nonce, 'cleanup-' + nonce].includes(path.basename(dir))
    || !stat.isDirectory() || stat.isSymbolicLink() || !equalByteNode(stat, expectedNode) || fs.realpathSync.native(dir) !== dir) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Raw-byte journal ownership changed');
  const names = fs.readdirSync(dir);
  for (const name of names) {
    const item = fs.lstatSync(path.join(dir, name), {bigint: true});
    if (!item.isFile() || item.isSymbolicLink() || !/^(?:(?:manifest|request|receipt|retirement-pending)\.json|native\.claimed|receipt\.tmp|\d+\.(?:staged|preimage))$/.test(name)
      || name === 'retirement-pending.json' && (item.nlink !== 1n && !exactRetirementLink(item, proof)
        || item.size > 512n * 1024n)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Unrecognized material remains in the raw-byte journal');
  }
  // Retire the directory before touching artifacts. A still-running native
  // holder denies this rename, leaving its complete proof intact for retry.
  if (dir !== retired) {
    if (fs.existsSync(retired)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'A prior raw-byte cleanup still owns its evidence');
    fs.renameSync(dir, retired);
  }
  // Keep the exact terminal root/request/node binding outside the directory
  // until its last removal succeeds. This is cleanup authority, never a file
  // completion receipt or permission to replay an unknown native attempt.
  const pending = path.join(retired, 'retirement-pending.json');
  if (!fs.existsSync(proof)) {
    const terminal = readByteBatch(manifest.root, parent, path.basename(retired));
    if (JSON.stringify(terminal.manifest) !== JSON.stringify(manifest)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Raw-byte terminal manifest changed before retirement');
  }
  // Interrupted preparation stays inside the node-validated directory, where
  // the intact terminal manifest remains authoritative. Pending bytes never
  // authorize cleanup; only the complete fsynced atomic publication does.
  if (names.includes('retirement-pending.json')) fs.unlinkSync(pending);
  if (!fs.existsSync(proof)) {
    writeByteArtifact(pending, Buffer.from(JSON.stringify(manifest)));
    // link is an atomic create-new destination on this volume. Unlike rename,
    // it cannot replace evidence that appears at the final publication step.
    fs.linkSync(pending, proof);
    fs.unlinkSync(pending);
  }
  const recorded = readByteBatch(manifest.root, parent, proofName);
  if (JSON.stringify(recorded.manifest) !== JSON.stringify(manifest)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Raw-byte retirement proof changed');
  for (const name of names.filter(name => !['manifest.json', 'retirement-pending.json'].includes(name))) fs.unlinkSync(path.join(retired, name));
  if (names.includes('manifest.json')) fs.unlinkSync(path.join(retired, 'manifest.json'));
  fs.rmdirSync(retired);
  fs.unlinkSync(proof);
}

function exactRetirementLink(stat, peer) {
  if (stat.nlink !== 2n || !peer) return false;
  try {
    const other = fs.lstatSync(peer, {bigint: true});
    return other.isFile() && !other.isSymbolicLink() && other.nlink === 2n && equalByteNode(other, byteNode(stat));
  } catch { return false; }
}
function readByteArtifact(dir, name, limit, retirementPeer) {
  const file = path.join(dir, name), stat = fs.lstatSync(file, {bigint: true});
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n && !exactRetirementLink(stat, retirementPeer)
    || stat.size > BigInt(limit)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Invalid bounded raw-byte artifact');
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, {bigint: true}), named = fs.lstatSync(file, {bigint: true});
    if (bytes.length > limit || ![after, named].every(item => item.isFile() && !item.isSymbolicLink() && equalByteNode(item, byteNode(stat))
      && item.nlink === stat.nlink && item.size === stat.size && item.mtimeNs === stat.mtimeNs && item.ctimeNs === stat.ctimeNs)
      || stat.nlink === 2n && !exactRetirementLink(stat, retirementPeer)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Raw-byte evidence changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readByteBatch(root, journalDir, name) {
  const retirement = /^retirement-[a-f0-9]{64}\.json$/.test(name);
  if (!retirement && !/^(?:batch|cleanup)-[a-f0-9]{64}$/.test(name)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Invalid raw-byte batch identity');
  const nonce = retirement ? name.slice(11, -5) : name.split('-').at(-1);
  const parent = fs.realpathSync.native(journalDir), dir = path.join(parent, retirement ? 'cleanup-' + nonce : name);
  let stat;
  try { stat = fs.lstatSync(dir, {bigint: true}); } catch (error) { if (!retirement || error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Invalid raw-byte batch directory');
  // Only this exact publication pair may temporarily have two links. Parsing
  // still grants nothing until the terminal root/request/directory binding and
  // retained manifest below have all been verified.
  const manifest = JSON.parse(readByteArtifact(retirement ? parent : dir, retirement ? name : 'manifest.json', 512 * 1024,
    retirement ? path.join(dir, 'retirement-pending.json') : undefined).toString('utf8')), request = manifest?.request;
  const nodeValid = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2
    && ['device', 'file'].every(key => typeof value[key] === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value[key]));
  if (manifest.schemaVersion !== 2 || manifest.kind !== BYTE_KIND || manifest.root !== root || !nodeValid(manifest.journalNode)
    || stat && !equalByteNode(stat, manifest.journalNode) || !['prepared', 'dispatching', 'applied', 'unknown', 'completed', 'completed-no-effect'].includes(manifest.status)
    || !request || request.schema !== WORKSPACE_BYTE_REQUEST || request.root !== root || !nodeValid(request.rootNode)
    || !byteHash(request.nonce) || nonce !== request.nonce || !byteHash(request.binding)
    || !Array.isArray(request.rows) || request.rows.length < 1 || request.rows.length > 100
    || !byteHash(manifest.requestSha256) || digest(JSON.stringify(request)) !== manifest.requestSha256
    || manifest.receiptSha256 !== null && !byteHash(manifest.receiptSha256)
    || JSON.stringify(manifest.owner) === undefined || Buffer.byteLength(JSON.stringify(manifest.owner)) > 16384
    || request.binding !== digest(JSON.stringify({root, rootNode: request.rootNode, nonce: request.nonce, rows: request.rows, owner: manifest.owner}))) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Invalid raw-byte transaction binding');
  const seen = new Set();
  for (const [index, row] of request.rows.entries()) {
    if (!row || !['write', 'delete'].includes(row.action) || !(row.originalHash === null || byteHash(row.originalHash))
      || (row.originalHash === null ? row.originalNode !== null : !nodeValid(row.originalNode))
      || (row.action === 'write' ? !byteHash(row.stagedHash) || row.stagedFile !== index + '.staged' : row.stagedHash !== null || row.stagedFile !== null || row.originalHash === null)) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Invalid raw-byte request row');
    byteRelative(root, row.path, retirement || ['completed', 'completed-no-effect'].includes(manifest.status)); const key = process.platform === 'win32' ? row.path.toLowerCase() : row.path;
    if (seen.has(key) || [...seen].some(previous => key.startsWith(previous + '/') || previous.startsWith(key + '/'))) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Overlapping raw-byte request rows');
    seen.add(key);
  }
  if (retirement) {
    if (!['completed', 'completed-no-effect'].includes(manifest.status) || fs.existsSync(path.join(parent, 'batch-' + nonce))) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Invalid raw-byte retirement state');
    assertByteRoot(root, request.rootNode);
    if (stat && fs.existsSync(path.join(dir, 'manifest.json'))
      && digest(JSON.stringify(JSON.parse(readByteArtifact(dir, 'manifest.json', 512 * 1024).toString('utf8')))) !== digest(JSON.stringify(manifest))) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Retained manifest disagrees with retirement proof');
  }
  return {dir, parent, manifest, evidence: {...byteEvidence(dir, manifest), name}};
}
const byteEvidence = (dir, manifest) => ({name: path.basename(dir), sha256: digest(JSON.stringify(manifest)), status: manifest.status, requestSha256: manifest.requestSha256});
function byteSettlement(root, batch, result) {
  const {dir, parent, manifest} = batch, originalIdentity = digest(JSON.stringify(manifest)); let settled = false;
  const assertApplied = () => {
    if (digest(JSON.stringify(JSON.parse(readByteArtifact(dir, 'manifest.json', 512 * 1024).toString('utf8')))) !== originalIdentity) throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'The original raw-byte journal generation changed');
    assertByteRoot(root, manifest.request.rootNode);
    const current = readWorkspaceByteReceipt(dir, manifest.request, manifest.requestSha256);
    if (current.receiptSha256 !== result.receiptSha256 || current.receipt.status !== 'completed') throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'The terminal raw-byte receipt changed');
    for (const row of current.receipt.rows) {
      const actual = currentByteFile(root, row);
      if (actual.hash !== row.finalHash || JSON.stringify(actual.node) !== JSON.stringify(row.finalNode)) throw byteFailure('WORKSPACE_CONFLICT', 'Raw output changed after the native lease ended');
    }
  };
  assertApplied();
  return {owner: structuredClone(manifest.owner), evidence: batch.evidence, assertApplied,
    settle() {
      if (settled) return {cleanupPending: false};
      try {
        assertApplied(); manifest.status = 'completed'; persistByteManifest(dir, manifest);
        removeByteBatch(dir, parent, manifest); settled = true; return {cleanupPending: false};
      } catch { return {cleanupPending: true, cleanupResources: [{kind: 'workspace-byte-journal', id: path.basename(dir), identity: manifest.requestSha256}]}; }
    }};
}

/** Read-only adoption of an exact terminal receipt. The Git application owner
 * must separately approve/verify its index and HEAD phases before settle(). */
export function inspectWorkspaceByteTransaction(root, {journalDir = workspaceJournalDir(root), expectedEvidence} = {}) {
  const names = importBatchNames(journalDir);
  if (!names.length && expectedEvidence === undefined) return null;
  if (names.length !== 1) throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'The original protected file set is missing or ambiguous');
  const batch = readByteBatch(root, journalDir, names[0]), {manifest, dir} = batch;
  if (expectedEvidence !== undefined && JSON.stringify(batch.evidence) !== JSON.stringify(expectedEvidence)) throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'Reviewed raw-byte recovery evidence changed');
  if (!['dispatching', 'applied', 'unknown'].includes(manifest.status)) throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'This raw file phase cannot be adopted for Git continuation');
  assertByteRoot(root, manifest.request.rootNode);
  if (digest(readByteArtifact(dir, 'request.json', 262144)) !== manifest.requestSha256
    || readByteArtifact(dir, 'native.claimed', 64).toString('utf8') !== manifest.requestSha256) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Original native request or claim changed');
  const result = readWorkspaceByteReceipt(dir, manifest.request, manifest.requestSha256);
  if (result.receipt.status !== 'completed' || manifest.receiptSha256 !== null && result.receiptSha256 !== manifest.receiptSha256) throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'Native file completion remains unconfirmed');
  for (const [index, row] of manifest.request.rows.entries()) if (row.originalHash !== null
    && digest(readByteArtifact(dir, index + '.preimage', 10 * 1024 * 1024)) !== row.originalHash) throw byteFailure('IMPORT_JOURNAL_INVALID', 'Original raw preimage cannot be verified');
  return byteSettlement(root, batch, result);
}

/** Internal physical file set. Caller retains the journal until its surrounding
 * index/HEAD operation is settled; it never returns this object through IPC. */
export async function applyWorkspaceByteTransaction(rootReal, changes, {journalDir = workspaceJournalDir(rootReal), nativeExecutable,
  signal, owner = null, beforeCommit} = {}) {
  let launched = false, manifest, dir, parent, nonce, journalNode;
  const evidence = () => manifest ? {name: path.basename(dir), sha256: digest(JSON.stringify(manifest)), status: manifest.status, requestSha256: manifest.requestSha256} : null;
  try {
  const executable = resolveWorkspaceByteExecutable(nativeExecutable);
  if (signal?.aborted) throw byteFailure('INVOKE_CANCELLED', 'Raw-byte publication cancelled before admission', {effectStatus: 'none'});
  const rootStat = fs.lstatSync(rootReal, {bigint: true}), rootNode = byteNode(rootStat);
  assertByteRoot(rootReal, rootNode);
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) throw byteFailure('INVALID_CHANGES', 'A raw file set needs 1-100 exact changes');
  const seen = new Set(); let originalBytes = 0n, stagedBytes = 0;
  const payloads = [], rows = changes.map((change, index) => {
    if (!change || !['write', 'delete'].includes(change.action) || !Object.hasOwn(change, 'expectedHash')
      || change.expectedHash !== null && !byteHash(change.expectedHash)) throw byteFailure('INVALID_CHANGES', 'Every raw change requires its actual reviewed preimage');
    const target = byteRelative(rootReal, change.path), key = process.platform === 'win32' ? change.path.toLowerCase() : change.path;
    if (seen.has(key) || [...seen].some(previous => key.startsWith(previous + '/') || previous.startsWith(key + '/'))) throw byteFailure('INVALID_CHANGES', 'Raw file-set paths overlap');
    seen.add(key);
    let stat; try { stat = fs.lstatSync(target, {bigint: true}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 10n * 1024n * 1024n)) throw byteFailure('WORKSPACE_CONFLICT', 'Raw publication requires a bounded non-linked regular file');
    originalBytes += stat?.size ?? 0n;
    if (originalBytes > 64n * 1024n * 1024n || !!stat !== (change.expectedHash !== null)) throw byteFailure('WORKSPACE_CONFLICT', 'The admitted raw preimage or size changed');
    let bytes = null;
    if (change.action === 'write') {
      if (!Buffer.isBuffer(change.bytes) || change.bytes.length > 10 * 1024 * 1024) throw byteFailure('INVALID_CHANGES', 'Raw target payload must be bounded bytes');
      bytes = Buffer.from(change.bytes); stagedBytes += bytes.length;
      if (stagedBytes > 64 * 1024 * 1024) throw byteFailure('INVALID_CHANGES', 'Raw target file set exceeds 64MiB');
    } else if (!stat || change.bytes != null) throw byteFailure('INVALID_CHANGES', 'Raw deletion needs an existing exact original');
    payloads.push(bytes);
    return {path: change.path, action: change.action, originalHash: change.expectedHash, originalNode: stat ? byteNode(stat) : null,
      stagedHash: bytes === null ? null : digest(bytes), stagedFile: bytes === null ? null : index + '.staged'};
  });
  const ownerBytes = JSON.stringify(owner);
  if (ownerBytes === undefined || Buffer.byteLength(ownerBytes) > 16384) throw byteFailure('INVALID_CHANGES', 'Raw transaction owner facts exceed their bound');
  if (importBatchNames(journalDir).length) throw byteFailure('WORKSPACE_RECOVERY_REQUIRED', 'Settle the original Workspace transaction before another raw write');
  fs.mkdirSync(journalDir, {recursive: true, mode: 0o700});
  parent = fs.realpathSync.native(journalDir); nonce = crypto.randomBytes(32).toString('hex'); dir = path.join(parent, 'batch-' + nonce);
  fs.mkdirSync(dir, {mode: 0o700}); journalNode = byteNode(fs.lstatSync(dir, {bigint: true}));
  const binding = digest(JSON.stringify({root: rootReal, rootNode, nonce, rows, owner}));
  const request = {schema: WORKSPACE_BYTE_REQUEST, nonce, binding, root: rootReal, rootNode, rows};
  const requestBytes = Buffer.from(JSON.stringify(request));
  manifest = {schemaVersion: 2, kind: BYTE_KIND, root: rootReal, status: 'prepared', request, requestSha256: digest(requestBytes), owner,
    journalNode, receiptSha256: null};
    persistByteManifest(dir, manifest);
    payloads.forEach((bytes, index) => { if (bytes) writeByteArtifact(path.join(dir, index + '.staged'), bytes); });
    writeByteArtifact(path.join(dir, 'request.json'), requestBytes);
    await beforeCommit?.(); assertByteRoot(rootReal, rootNode);
    if (signal?.aborted) throw byteFailure('INVOKE_CANCELLED', 'Raw publication cancelled before native dispatch', {effectStatus: 'none'});
    manifest.status = 'dispatching'; persistByteManifest(dir, manifest); launched = true;
    const result = await runWorkspaceByteTransaction(dir, request, {executable, signal});
    manifest.status = 'applied'; manifest.receiptSha256 = result.receiptSha256; persistByteManifest(dir, manifest);
    const settlement = byteSettlement(rootReal, {dir, parent, manifest, evidence: evidence()}, result);
    return {changes: rows.map(row => ({path: row.path, action: row.action, originalHash: row.originalHash, hash: row.stagedHash})),
      ...settlement, cancelled: result.cancelled};
  } catch (error) {
    const none = !launched || error.effectStatus === 'none';
    if (manifest) {
      manifest.status = none ? 'completed-no-effect' : 'unknown';
      if (error.receiptSha256) manifest.receiptSha256 = error.receiptSha256;
      try { persistByteManifest(dir, manifest); } catch {}
    }
    if (none && dir && journalNode) try { removeByteBatch(dir, parent, manifest); } catch { error.cleanupPending = true; }
    throw byteFailure(none ? error.code ?? 'WORKSPACE_BYTE_FAILED' : 'WORKSPACE_RECOVERY_REQUIRED',
      none ? error.message : 'Raw-byte publication is unconfirmed; original journal and backups are retained',
      {effectStatus: none ? 'none' : 'unknown', causeCode: error.code, ...(manifest ? {byteTransaction: evidence()} : {}), ...(error.cleanupPending ? {cleanupPending: true} : {})});
  }
}
