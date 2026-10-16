import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { resolveInside } from './boundary.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

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

export function recoverWorkspaceImports(rootReal, { journalDir = workspaceJournalDir(rootReal), writeFile } = {}) {
  if (!fs.existsSync(journalDir)) return [];
  const journalStat = fs.lstatSync(journalDir);
  if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import journal directory is invalid');
  const recovered = [];
  for (const name of fs.readdirSync(journalDir)) {
    const dir = path.join(journalDir, name);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import batch directory is invalid');
    const manifestFile = path.join(dir, 'manifest.json');
    const manifestStat = fs.lstatSync(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import manifest is invalid');
    const manifest = readJsonFile(manifestFile);
    if (manifest?.schemaVersion !== 1 || manifest.root !== rootReal || !Array.isArray(manifest.rows)
      || !['prepared', 'committing', 'completed'].includes(manifest.status)
      || manifest.rows.some((row, index) => !row || !['write', 'delete'].includes(row.action)
        || typeof row.path !== 'string' || !/^[a-f0-9]{64}$/.test(row.stagedHash ?? '') && row.stagedHash !== null
        || !/^[a-f0-9]{64}$/.test(row.originalHash ?? '') && row.originalHash !== null
        || row.backup !== (row.originalHash === null ? null : `${index}.preimage`))) {
      throw failure('IMPORT_JOURNAL_INVALID', 'Workspace import journal is invalid');
    }
    if (manifest.status !== 'completed') {
      for (const row of [...manifest.rows].reverse()) restoreOne(rootReal, dir, row);
    }
    removeJournal(dir, journalDir);
    recovered.push(name);
  }
  return recovered;
}

export function applyWorkspaceTransaction(rootReal, changes, { journalDir = workspaceJournalDir(rootReal), writeFile, beforeCommit } = {}) {
  recoverWorkspaceImports(rootReal, { journalDir, writeFile });
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
    try { recoverWorkspaceImports(rootReal, { journalDir, writeFile }); }
    catch (recoveryError) { throw failure('WORKSPACE_RECOVERY_REQUIRED', `${error.message}; recovery: ${recoveryError.message}`); }
    throw error;
  }
}
