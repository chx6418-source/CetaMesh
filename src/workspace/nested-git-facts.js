import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isInsideRoot, resolveInside } from './boundary.js';
import { assertObservationActive } from './observation-abort.js';

const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (left, right) => key(path.resolve(left)) === key(path.resolve(right));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (reasonCode = 'WORKSPACE_CONTENT_NESTED_REPOSITORY') => {
  throw Object.assign(new Error('Nested Git ownership could not be verified'), { code: 'WORKSPACE_UNVERIFIED', reasonCode });
};
const identity = (left, right) => left && right && ['ino', 'dev', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(field => left[field] === right[field]);

// Metadata only: never load configuration values, objects, hooks or credentials.
// An in-bound .git directory or a worktree's exact two-way link establishes the
// observation scope. It does not register a Workspace or authorize any writes.
export function observeNestedGit(root, directory, { excludedRoots = [], additionalWorkspaceRoots = [], signal } = {}) {
  const observed = [], facts = [];
  const checkPath = file => {
    assertObservationActive(signal);
    if (!isInsideRoot(root, file)) fail('WORKSPACE_CONTENT_GIT_OUTSIDE_SCOPE');
    if ([...excludedRoots, ...additionalWorkspaceRoots.filter(other => !same(other, root))]
      .some(other => isInsideRoot(other, file))) fail('WORKSPACE_CONTENT_GIT_OUTSIDE_SCOPE');
    const resolved = resolveInside(root, file);
    if (!same(resolved.absolute, resolved.real)) fail();
  };
  const inspect = (file, { optional = false, contents = false, directory: requireDirectory = false, limit = 16 * 1024 * 1024 } = {}) => {
    checkPath(file);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (optional && error.code === 'ENOENT') return { stat: null, bytes: null }; throw error; }
    if (stat.isSymbolicLink() || (requireDirectory ? !stat.isDirectory() : !stat.isFile())) fail();
    let bytes = null;
    if (contents) {
      if (stat.size > limit) fail('WORKSPACE_CONTENT_LIMIT_EXCEEDED');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        if (!identity(stat, fs.fstatSync(fd))) fail('WORKSPACE_CONTENT_CHANGED');
        bytes = fs.readFileSync(fd);
        if (bytes.length !== stat.size || !identity(stat, fs.fstatSync(fd))) fail('WORKSPACE_CONTENT_CHANGED');
      } finally { fs.closeSync(fd); }
    }
    return { stat, bytes };
  };
  const capture = (file, options = {}) => {
    const value = inspect(file, options);
    const contentHash = value.bytes === null ? null : digest(value.bytes);
    observed.push({ file, options, stat: value.stat, contentHash });
    if (options.contents) facts.push([path.relative(root, file), contentHash]);
    else if (!options.directory) facts.push([path.relative(root, file), value.stat
      ? ['ino', 'dev', 'mode', 'size', 'mtimeMs', 'ctimeMs'].map(field => value.stat[field]) : null]);
    return value;
  };
  const small = (file, options = {}) => capture(file, { contents: true, limit: 4096, ...options }).bytes?.toString('utf8').trim() ?? null;
  const canonicalDirectory = file => { capture(file, { directory: true }); return file; };
  const source = canonicalDirectory(directory), marker = path.join(source, '.git');
  checkPath(marker);
  const markerStat = fs.lstatSync(marker);
  if (markerStat.isSymbolicLink()) fail();
  let gitDir, common;
  if (markerStat.isDirectory()) {
    gitDir = common = canonicalDirectory(marker);
    if (capture(path.join(gitDir, 'commondir'), { optional: true, contents: true }).stat) fail();
  } else {
    const pointer = small(marker);
    if (!pointer || !/^gitdir: [^\r\n\0]+$/.test(pointer)) fail();
    gitDir = canonicalDirectory(path.resolve(source, pointer.slice(8)));
    const relativeCommon = small(path.join(gitDir, 'commondir'));
    if (!relativeCommon || /[\r\n\0]/.test(relativeCommon)) fail();
    common = canonicalDirectory(path.resolve(gitDir, relativeCommon));
    if (!same(path.dirname(gitDir), path.join(common, 'worktrees'))) fail();
    const backlink = small(path.join(gitDir, 'gitdir'));
    if (!backlink || /[\r\n\0]/.test(backlink) || !same(path.resolve(gitDir, backlink), marker)) fail();
  }
  canonicalDirectory(path.join(common, 'objects'));
  canonicalDirectory(path.join(common, 'refs'));
  const head = small(path.join(gitDir, 'HEAD'));
  if (!head || (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head) && !/^ref: refs\/heads\/[^\s\0]+$/.test(head))) fail();
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    // Git refs use '/' separators. Backslashes/ADS must not acquire Win32 path semantics.
    if (/[\\:]/.test(ref) || ref.split('/').some(part => !part || part === '.' || part === '..')) fail();
    const value = small(path.join(common, ref), { optional: true });
    if (value !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) fail();
  }
  capture(path.join(common, 'packed-refs'), { optional: true, contents: true });
  capture(path.join(gitDir, 'index'), { optional: true, contents: true });
  // Config identity is fenced without copying potentially credential-bearing values.
  capture(path.join(common, 'config'), { optional: true });
  capture(path.join(gitDir, 'config.worktree'), { optional: true });
  const assertUnchanged = () => {
    for (const before of observed) {
      const after = inspect(before.file, before.options);
      if ((!before.stat && !after.stat) || (identity(before.stat, after.stat)
        && (before.contentHash === null || before.contentHash === digest(after.bytes)))) continue;
      fail('WORKSPACE_CONTENT_CHANGED');
    }
  };
  assertUnchanged();
  return { gitDir, sha256: digest(JSON.stringify([path.relative(root, source), path.relative(root, gitDir),
    path.relative(root, common), observed[0].stat.dev, observed[0].stat.ino, facts])), assertUnchanged };
}
