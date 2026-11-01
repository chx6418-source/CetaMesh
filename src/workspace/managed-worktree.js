import fs from 'node:fs';
import path from 'node:path';

const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);

function directory(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Untrusted directory');
  const real = fs.realpathSync.native(target);
  if (!samePath(real, target)) throw new Error('Directory alias outside trusted identity');
  return real;
}

function smallFile(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Untrusted Git marker');
  return fs.readFileSync(target, 'utf8');
}

function pathFile(target) {
  const match = /^([^\0\r\n]+)\r?\n?$/.exec(smallFile(target));
  if (!match) throw new Error('Invalid Git path marker');
  return path.resolve(path.dirname(target), match[1]);
}

function gitDirectory(root, { linked = false } = {}) {
  const marker = path.join(root, '.git');
  const stat = fs.lstatSync(marker);
  if (stat.isSymbolicLink()) throw new Error('Linked Git marker is not trusted');
  if (stat.isDirectory() && !linked) return directory(marker);
  const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(smallFile(marker));
  if (!match) throw new Error('Invalid linked Worktree marker');
  return directory(path.resolve(root, match[1]));
}

function commonDirectory(gitDir) {
  const marker = path.join(gitDir, 'commondir');
  const common = fs.existsSync(marker) ? directory(pathFile(marker)) : gitDir;
  directory(path.join(common, 'objects'));
  smallFile(path.join(common, 'HEAD'));
  return common;
}

/** Read-only provenance check. This grants no Task, Agent, or Git capability. */
export function isManagedWorktree(entry, { stateDir, resolveWorkspace } = {}) {
  try {
    const relation = entry?.gitWorktree;
    if (!relation || typeof relation.parentWorkspaceId !== 'string' || !relation.parentWorkspaceId
      || relation.parentWorkspaceId === entry.id || typeof resolveWorkspace !== 'function'
      || typeof stateDir !== 'string' || !path.isAbsolute(stateDir)
      || typeof entry.root !== 'string' || !path.isAbsolute(entry.root)) return false;
    const parent = resolveWorkspace(relation.parentWorkspaceId);
    if (!parent || parent.id !== relation.parentWorkspaceId || typeof parent.root !== 'string' || !path.isAbsolute(parent.root)) return false;

    // StateDir aliases are supported, but neither the managed base nor its source may be a link.
    const state = fs.realpathSync.native(stateDir);
    const base = directory(path.join(state, 'agent-worktrees'));
    const root = directory(entry.root);
    if (!samePath(path.dirname(root), base)) return false;
    const parentRoot = fs.realpathSync.native(parent.root);
    if (samePath(root, parentRoot)) return false;

    const parentCommon = commonDirectory(gitDirectory(parentRoot));
    const metadataBase = directory(path.join(parentCommon, 'worktrees'));
    const metadata = gitDirectory(root, { linked: true });
    if (!samePath(path.dirname(metadata), metadataBase)) return false;
    if (!samePath(commonDirectory(metadata), parentCommon)) return false;
    // Both sides of Git's link must agree; a copied marker cannot borrow a sibling's provenance.
    if (!samePath(pathFile(path.join(metadata, 'gitdir')), path.join(root, '.git'))) return false;
    smallFile(path.join(metadata, 'HEAD'));
    return true;
  } catch {
    return false;
  }
}
