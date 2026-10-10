import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_FILES = 25_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 48;
const EXCLUDED_NAMES = new Set([
  '.git', '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.cetamesh',
  'credentials', 'secrets', 'secret', 'private_keys'
]);
const SECRET_FILE_EXTENSIONS = new Set(['.pem', '.p12', '.pfx', '.key', '.keystore']);

export class StagingWorkspaceError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'StagingWorkspaceError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message, cause) {
  throw new StagingWorkspaceError(code, message, { cause });
}

function pathContains(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function pathsOverlap(a, b) {
  return pathContains(a, b) || pathContains(b, a);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sensitiveName(name) {
  const value = String(name ?? '').toLowerCase();
  if (EXCLUDED_NAMES.has(value) || value === '.env' || value.startsWith('.env.')) return true;
  if (SECRET_FILE_EXTENSIONS.has(path.extname(value))) return true;
  if (/^(?:id_rsa|id_ed25519|id_ecdsa|known_hosts|authorized_keys)(?:\..*)?$/.test(value)) return true;
  return /(?:^|[._-])(?:secret|credential|token|private[-_]?key)(?:[._-]|$)/.test(value);
}

function normalizeRoots(roots) {
  return [...new Set((Array.isArray(roots) ? roots : []).filter((root) => typeof root === 'string' && root.trim())
    .map((root) => path.resolve(root)))];
}

function assertStageOutsideWorkspaces(stagingRoot, workspaceRoots) {
  const root = path.resolve(stagingRoot);
  for (const workspace of workspaceRoots) {
    if (pathsOverlap(root, workspace)) {
      fail('STAGING_ROOT_OVERLAPS_WORKSPACE', 'Agent staging directory overlaps a registered Workspace');
    }
  }
}

function walkFiles(root, { maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES, excludedRoots = [] } = {}) {
  const files = new Map();
  let totalBytes = 0;
  const excluded = normalizeRoots(excludedRoots);
  const visit = (dir, relative, depth) => {
    if (depth > MAX_DEPTH) fail('STAGING_TOO_DEEP', 'Workspace snapshot exceeds staging depth limit');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { fail('STAGING_READ_FAILED', 'Unable to enumerate the Task Workspace snapshot', error); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (sensitiveName(entry.name)) continue;
      const source = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded.some((excludedRoot) => pathContains(excludedRoot, source))) continue;
      let stat;
      try { stat = fs.lstatSync(source); } catch { /* The entry disappeared during the bounded snapshot walk. */ continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(source, rel, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (files.size >= maxFiles) fail('STAGING_TOO_MANY_FILES', 'Workspace snapshot exceeds staging file limit');
      totalBytes += stat.size;
      if (totalBytes > maxBytes) fail('STAGING_TOO_LARGE', 'Workspace snapshot exceeds staging size limit');
      let hash;
      try { hash = hashFile(source); } catch (error) { fail('STAGING_READ_FAILED', 'Unable to read a Task Workspace file', error); }
      files.set(rel, { hash, size: stat.size });
    }
  };
  visit(root, '', 0);
  return { files, totalBytes };
}

/** Make a bounded, credential-filtered snapshot for one Task, outside all Workspace roots. */
export async function createStagingWorkspace({ taskId, workspaceId, sourceRoot, stagingRoot,
  additionalWorkspaceRoots = [], excludedRoots = [], maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!String(taskId ?? '').trim()) fail('TASK_REQUIRED', 'A Task is required for staging');
  if (!String(workspaceId ?? '').trim()) fail('WORKSPACE_REQUIRED', 'A Workspace is required for staging');
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) fail('WORKSPACE_REQUIRED', 'Workspace source root must be an absolute registered root');
  const source = fs.realpathSync.native(sourceRoot);
  const stageBase = path.resolve(stagingRoot || path.join(os.tmpdir(), 'CetaMesh', 'agent-staging'));
  const roots = normalizeRoots([source, ...additionalWorkspaceRoots]);
  assertStageOutsideWorkspaces(stageBase, roots);
  fs.mkdirSync(stageBase, { recursive: true, mode: 0o700 });
  const stage = path.join(stageBase, crypto.randomUUID());
  fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
  const nestedWorkspaceRoots = normalizeRoots(additionalWorkspaceRoots)
    .filter((workspaceRoot) => workspaceRoot !== source && pathContains(source, workspaceRoot));
  const excluded = normalizeRoots([...excludedRoots, ...nestedWorkspaceRoots]);
  try {
    const snapshot = walkFiles(source, { maxFiles, maxBytes, excludedRoots: excluded });
    for (const rel of snapshot.files.keys()) {
      const sourcePath = path.join(source, ...rel.split('/'));
      const targetPath = path.join(stage, ...rel.split('/'));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      // Recheck leaf type immediately before copying. Symlinks and special files stay out.
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
    return {
      taskId: String(taskId),
      workspaceId: String(workspaceId),
      sourceRoot: source,
      stagingRoot: stageBase,
      root: stage,
      baseline: snapshot.files,
      bytes: snapshot.totalBytes,
      maxFiles,
      maxBytes,
      excludedRoots: excluded,
      closed: false
    };
  } catch (error) {
    try { fs.rmSync(stage, { recursive: true, force: true }); }
    catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

/** Compare staging output with its source snapshot and reject concurrent Workspace changes. */
export function collectStagedChanges(stage) {
  if (!stage || stage.closed || !pathContains(stage.stagingRoot, stage.root) || stage.root === stage.stagingRoot) {
    fail('STAGING_SESSION_INVALID', 'Invalid or closed staging Workspace');
  }
  const stageSnapshot = walkFiles(stage.root, { maxFiles: stage.maxFiles, maxBytes: stage.maxBytes });
  const sourceSnapshot = walkFiles(stage.sourceRoot, {
    maxFiles: stage.maxFiles, maxBytes: stage.maxBytes, excludedRoots: stage.excludedRoots
  });
  const allPaths = new Set([...stage.baseline.keys(), ...stageSnapshot.files.keys()]);
  const changes = [];
  for (const rel of allPaths) {
    const original = stage.baseline.get(rel) ?? null;
    const live = sourceSnapshot.files.get(rel) ?? null;
    if ((original?.hash ?? null) !== (live?.hash ?? null)) {
      fail('WORKSPACE_RECONCILIATION_REQUIRED', `Task Workspace changed after this staging snapshot: ${rel}`);
    }
    const staged = stageSnapshot.files.get(rel) ?? null;
    if ((original?.hash ?? null) === (staged?.hash ?? null)) continue;
    if (staged) {
      const absolute = path.join(stage.root, ...rel.split('/'));
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const content = fs.readFileSync(absolute, 'utf8');
      changes.push({ action: 'write', path: rel, content, expectedHash: original?.hash ?? null, hash: hashContent(content) });
    } else if (original) {
      changes.push({ action: 'delete', path: rel, expectedHash: original.hash, hash: null });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return {
    changes,
    summary: {
      added: changes.filter((change) => change.action === 'write' && change.expectedHash === null).length,
      modified: changes.filter((change) => change.action === 'write' && change.expectedHash !== null).length,
      deleted: changes.filter((change) => change.action === 'delete').length,
      paths: changes.map(({ action, path: filePath }) => ({ action, path: filePath }))
    }
  };
}

/** Refresh the source baseline only after the Capability Broker reports a completed import. */
export function refreshStagingBaseline(stage) {
  if (!stage || stage.closed) fail('STAGING_SESSION_INVALID', 'Invalid or closed staging Workspace');
  const stageSnapshot = walkFiles(stage.root, { maxFiles: stage.maxFiles, maxBytes: stage.maxBytes });
  const sourceSnapshot = walkFiles(stage.sourceRoot, {
    maxFiles: stage.maxFiles, maxBytes: stage.maxBytes, excludedRoots: stage.excludedRoots
  });
  if (stageSnapshot.files.size !== sourceSnapshot.files.size) {
    fail('WORKSPACE_RECONCILIATION_REQUIRED', 'Task Workspace and imported staging output differ');
  }
  for (const [rel, staged] of stageSnapshot.files) {
    if (sourceSnapshot.files.get(rel)?.hash !== staged.hash) {
      fail('WORKSPACE_RECONCILIATION_REQUIRED', `Task Workspace and imported staging output differ: ${rel}`);
    }
  }
  stage.baseline = sourceSnapshot.files;
  stage.bytes = sourceSnapshot.totalBytes;
  return { files: sourceSnapshot.files.size, bytes: sourceSnapshot.totalBytes };
}

export function cleanupStagingWorkspace(stage) {
  if (!stage || stage.closed) return { removed: false };
  if (!pathContains(stage.stagingRoot, stage.root) || stage.root === stage.stagingRoot) {
    fail('STAGING_PATH_INVALID', 'Refusing to remove a path outside the private staging root');
  }
  fs.rmSync(stage.root, { recursive: true, force: true });
  stage.closed = true;
  return { removed: true };
}
