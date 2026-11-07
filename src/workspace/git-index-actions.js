import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInside } from './boundary.js';
import { gitRun, gitStatus } from './tools.js';

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const samePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
const sameNode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const sensitive = value => value.split('/').some(part => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part));
const run = (source, args, options = {}) => gitRun(source.root, args, { ...options, literalPaths: true, repository: source.repository });
const zero = '0'.repeat(40);

function pathsOf(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) fail('GIT_PATHS_REQUIRED', 'Select 1-100 exact Workspace-relative files');
  const seen = new Set();
  return paths.map(rel => {
    if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)
      || rel.split('/').some(part => !part || part === '.' || part === '..')) fail('GIT_PATH_INVALID', 'Git index actions require normalized relative file paths');
    if (sensitive(rel)) fail('SENSITIVE_RESOURCE', 'This resource is excluded from Git index actions');
    const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
    if (seen.has(key)) fail('GIT_PATH_INVALID', 'Duplicate selected Git file');
    seen.add(key); return rel;
  });
}

function requireRequest(request, staged) {
  const paths = pathsOf(request.paths);
  if (!Object.hasOwn(request, 'expectedHead') || request.expectedHead !== null && !oid(request.expectedHead)) fail('GIT_HEAD_REQUIRED', 'Supply the reviewed HEAD or explicit null for an unborn repository');
  if (!Object.hasOwn(request, 'expectedHeadRef') || request.expectedHeadRef !== null && (typeof request.expectedHeadRef !== 'string' || !/^refs\/heads\/[^\s\x00-\x1f\x7f]+$/.test(request.expectedHeadRef))) fail('GIT_HEAD_REQUIRED', 'Supply the reviewed full local HEAD reference or explicit null for detached HEAD');
  if (!Object.hasOwn(request, 'indexIdentity') || request.indexIdentity !== null && !sha256(request.indexIdentity)) fail('GIT_INDEX_REQUIRED', 'Supply the reviewed complete index identity or explicit null');
  if (!sha256(request.expectedRepositoryIdentity)) fail('GIT_REPOSITORY_REQUIRED', 'Supply the reviewed Git metadata ownership identity');
  if (!request.expectedHashes || typeof request.expectedHashes !== 'object' || Array.isArray(request.expectedHashes)
    || Object.keys(request.expectedHashes).length !== paths.length || paths.some(rel => !Object.hasOwn(request.expectedHashes, rel) || request.expectedHashes[rel] !== null && !sha256(request.expectedHashes[rel]))) fail('GIT_HASHES_REQUIRED', 'Every selected file requires its reviewed SHA256 or a null absence marker');
  let expectedIndexEntries;
  if (staged) {
    if (!Array.isArray(request.expectedIndexEntries) || request.expectedIndexEntries.length !== paths.length) fail('GIT_INDEX_REQUIRED', 'Every selected file requires its reviewed index mode and object identity');
    const seen = new Set();
    expectedIndexEntries = request.expectedIndexEntries.map(entry => {
      if (entry && typeof entry === 'object' && entry.mode !== null && typeof entry.mode === 'string' && !['100644', '100755'].includes(entry.mode)) fail('GIT_PATH_INVALID', 'Only exact staged regular-file entries can be committed');
      if (!entry || typeof entry !== 'object' || !paths.includes(entry.path) || seen.has(entry.path)
        || entry.mode !== null && !['100644', '100755'].includes(entry.mode) || entry.mode === null && entry.oid !== null || entry.mode !== null && !oid(entry.oid)) fail('GIT_INDEX_REQUIRED', 'Reviewed index entries must exactly identify selected regular files or their absence');
      seen.add(entry.path); return { path: entry.path, mode: entry.mode, oid: entry.oid };
    });
  }
  let message;
  if (staged) {
    if (typeof request.message !== 'string' || !request.message.trim() || request.message.includes('\0')) fail('COMMIT_MESSAGE_REQUIRED', 'A staged commit requires a message');
    message = request.message.trim(); if (message.length > 2000) fail('COMMIT_MESSAGE_TOO_LONG', 'Commit message exceeds 2000 characters');
  }
  return { paths, expectedHead: request.expectedHead, expectedHeadRef: request.expectedHeadRef, indexIdentity: request.indexIdentity, expectedRepositoryIdentity: request.expectedRepositoryIdentity,
    expectedHashes: Object.fromEntries(paths.map(rel => [rel, request.expectedHashes[rel]])), ...(staged ? { expectedIndexEntries, message } : {}) };
}

// Repository ownership is separate from HEAD/index contents. Native linked
// worktrees may use external metadata only with their exact two-way Git link.
function repositoryFacts(entry) {
  const facts = [], captured = [];
  const signature = stat => stat ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String) : null;
  const inspect = (location, directory, optional = false, limit = 4096n) => {
    let stat;
    try { stat = fs.lstatSync(location, { bigint: true }); }
    catch (error) { if (optional && error.code === 'ENOENT') return { stat: null, bytes: null }; throw error; }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid Git metadata node');
    if (directory) {
      if (!samePath(fs.realpathSync.native(location), location)) throw new Error('Aliased Git metadata');
      return { stat, bytes: null };
    }
    if (stat.size > limit) throw new Error('Unbounded Git metadata file');
    const handle = fs.openSync(location, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(handle, { bigint: true }), bytes = fs.readFileSync(handle), after = fs.fstatSync(handle, { bigint: true });
      if (JSON.stringify(signature(stat)) !== JSON.stringify(signature(before)) || JSON.stringify(signature(before)) !== JSON.stringify(signature(after))
        || JSON.stringify(signature(after)) !== JSON.stringify(signature(fs.lstatSync(location, { bigint: true })))) throw new Error('Changed Git marker');
      return { stat: after, bytes };
    } finally { fs.closeSync(handle); }
  };
  const capture = (location, directory = false, optional = false, limit = 4096n) => {
    const observed = inspect(location, directory, optional, limit), identity = directory ? [observed.stat.dev, observed.stat.ino, observed.stat.mode].map(String) : signature(observed.stat);
    const content = observed.bytes === null ? null : digest(observed.bytes);
    facts.push([path.resolve(location), identity, content]); captured.push({ location, directory, optional, identity, content, limit });
    return observed;
  };
  const directory = location => { const absolute = path.resolve(location); capture(absolute, true); return absolute; };
  const marker = (location, optional = false) => {
    const observed = capture(location, false, optional); if (!observed.stat) return null;
    const text = observed.bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(observed.bytes) || !/^([^\x00\r\n]+)\r?\n?$/.test(text)) throw new Error('Invalid Git path marker');
    return text.replace(/\r?\n$/, '');
  };
  try {
    const root = fs.realpathSync.native(entry.root);
    if (!samePath(root, entry.root)) fail('GIT_ROOT_REQUIRED', 'The registered canonical repository root changed; review its registration before an index action');
    directory(root);
    const source = path.join(root, '.git');
    let sourceStat;
    try { sourceStat = fs.lstatSync(source); }
    catch (error) { if (error.code === 'ENOENT') fail('GIT_ROOT_REQUIRED', 'Git index actions require a registered repository root with its own Git marker'); throw error; }
    if (sourceStat.isSymbolicLink()) throw new Error('Linked Git source marker');
    let gitDir, commonDir;
    if (sourceStat.isDirectory()) {
      gitDir = commonDir = directory(source);
      if (marker(path.join(gitDir, 'commondir'), true) !== null) throw new Error('A main repository cannot borrow another common directory');
    } else {
      const pointer = marker(source), match = /^gitdir: ([^\x00\r\n]+)$/.exec(pointer ?? '');
      if (!match) throw new Error('Invalid linked Git source');
      gitDir = directory(path.resolve(root, match[1]));
      const common = marker(path.join(gitDir, 'commondir'));
      commonDir = directory(path.resolve(gitDir, common));
      const metadataBase = directory(path.join(commonDir, 'worktrees'));
      if (!samePath(path.dirname(gitDir), metadataBase)) throw new Error('Linked Git metadata is outside its common worktree registry');
      const backlink = marker(path.join(gitDir, 'gitdir'));
      if (!samePath(path.resolve(gitDir, backlink), source)) throw new Error('Linked Git metadata belongs to another working directory');
    }
    // Repository format can redirect the native ref backend independently of
    // commondir. Hash its bounded regular source without copying configuration
    // values or credentials into another file or a public projection.
    capture(path.join(commonDir, 'config'), false, true, 1024n * 1024n);
    directory(path.join(commonDir, 'objects')); directory(path.join(commonDir, 'refs'));
    const assertUnchanged = () => {
      try {
        for (const before of captured) {
          const after = inspect(before.location, before.directory, before.optional, before.limit);
          const identity = before.directory ? [after.stat.dev, after.stat.ino, after.stat.mode].map(String) : signature(after.stat);
          if (JSON.stringify(identity) !== JSON.stringify(before.identity) || (after.bytes === null ? null : digest(after.bytes)) !== before.content) throw new Error('Changed Git ownership');
        }
      } catch { fail('GIT_REPOSITORY_CHANGED', 'Git metadata ownership changed; refresh the Workspace Git review'); }
    };
    assertUnchanged();
    return { root, gitDir, commonDir, repository: { gitDir, commonDir, workTree: root }, repositoryIdentity: digest(JSON.stringify([entry.id, facts])), assertRepositoryUnchanged: assertUnchanged };
  } catch (error) {
    if (['GIT_ROOT_REQUIRED', 'GIT_REPOSITORY_CHANGED'].includes(error.code)) throw error;
    fail('GIT_REPOSITORY_UNVERIFIED', 'Git metadata ownership is not a verified repository or native linked-worktree relation');
  }
}

function indexBytes(indexPath) {
  let stat;
  try { stat = fs.lstatSync(indexPath); } catch (error) { if (error.code === 'ENOENT') return { bytes: null, identity: null }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) fail('GIT_INDEX_UNAVAILABLE', 'Git index must be a bounded regular file');
  const handle = fs.openSync(indexPath, 'r');
  try {
    const before = fs.fstatSync(handle), bytes = fs.readFileSync(handle), after = fs.fstatSync(handle);
    if (!sameFile(stat, before) || !sameFile(before, after) || !sameFile(after, fs.lstatSync(indexPath))) fail('GIT_INDEX_CHANGED', 'Git index changed while it was read; refresh the review');
    return { bytes, identity: digest(bytes) };
  } finally { fs.closeSync(handle); }
}

function observeFiles(root, paths) {
  let total = 0;
  const files = new Map();
  for (const rel of paths) {
    try {
      const target = resolveInside(root, rel, { forWrite: true }).absolute;
      const parents = [];
      let parent = root;
      for (const segment of rel.split('/').slice(0, -1)) {
        parent = path.join(parent, segment);
        let stat; try { stat = fs.lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.existsSync(path.join(parent, '.git'))) fail('GIT_PATH_INVALID', 'Selected files cannot traverse links or nested Git repositories');
        parents.push({ path: parent, stat });
      }
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; files.set(rel, { hash: null, stat: null, parents }); continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) fail('GIT_PATH_INVALID', 'Select a regular file, not a directory, link or Git submodule');
      if (stat.size > 10 * 1024 * 1024 || total + stat.size > 64 * 1024 * 1024) fail('GIT_REVIEW_LIMIT', 'Selected files exceed the bounded content review');
      const handle = fs.openSync(target, 'r');
      try {
        const before = fs.fstatSync(handle), bytes = fs.readFileSync(handle), after = fs.fstatSync(handle);
        if (!sameFile(stat, before) || !sameFile(before, after) || !sameFile(after, fs.lstatSync(target))) fail('WORKSPACE_CONFLICT', 'Selected file changed while it was read');
        total += bytes.length; files.set(rel, { hash: digest(bytes), stat: after, parents });
      } finally { fs.closeSync(handle); }
      for (const item of parents) {
        const current = fs.lstatSync(item.path);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(item.stat, current)) fail('WORKSPACE_CONFLICT', 'Selected file ancestors changed during review');
      }
    } catch (error) {
      if (['BOUNDARY_ESCAPE', 'PATH_INVALID', 'PATH_RESERVED', 'PATH_UNC', 'ENOTDIR', 'ELOOP'].includes(error.code)) fail('GIT_PATH_INVALID', 'Selected file is outside the regular-file Git boundary');
      throw error;
    }
  }
  return { files, total };
}

function parseIndex(output) {
  const entries = new Map();
  for (const row of output.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match) fail('GIT_INDEX_UNAVAILABLE', 'Git returned an invalid index entry');
    if (match[3] !== '0' || entries.has(match[4])) fail('GIT_OPERATION_IN_PROGRESS', 'Resolve the current Git index conflicts before this action');
    entries.set(match[4], { path: match[4], mode: match[1], oid: match[2] });
  }
  return entries;
}
const selectedEntries = (paths, entries) => paths.map(rel => entries.get(rel) ?? { path: rel, mode: null, oid: null });
function assertSelectedEntries(paths, entries) {
  for (const rel of paths) for (const entry of entries.values()) {
    if (entry.path === rel && !['100644', '100755'].includes(entry.mode) || entry.path.startsWith(rel + '/') || rel.startsWith(entry.path + '/') && !['100644', '100755'].includes(entry.mode)) fail('GIT_PATH_INVALID', 'Select exact regular index files, without directory, link or Git submodule expansion');
  }
}

async function observe(entry, paths) {
  const source = repositoryFacts(entry), { root, gitDir } = source, rootStat = fs.lstatSync(root);
  if (!samePath(root, entry.root) || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('GIT_ROOT_REQUIRED', 'The registered canonical repository root changed; review its registration before an index action');
  let refFormat = 'files';
  try { refFormat = (await run(source, ['config', '--file', path.join(source.commonDir, 'config'), '--get', 'extensions.refStorage'])).stdout.trim(); }
  catch (error) { if (error.exitCode !== 1) throw error; }
  if (!['files', 'reftable'].includes(refFormat)) fail('GIT_REPOSITORY_UNVERIFIED', 'Custom Git reference storage needs a proven metadata owner before G1 actions');
  source.refFormat = refFormat;
  source.repositoryIdentity = digest(JSON.stringify([source.repositoryIdentity, refFormat]));
  const status = await gitStatus(root, { completeFiles: true, repository: source.repository });
  if (!status.isRepo) fail('GIT_NOT_REPOSITORY', 'Git index actions require an existing repository');
  if (!samePath(status.repoRoot, root)) fail('GIT_ROOT_REQUIRED', 'Git index actions require the registered repository root');
  if (status.entries.some(row => conflictCodes.has(row.x + row.y))) fail('GIT_OPERATION_IN_PROGRESS', 'Resolve the current Git conflicts before this action');
  const gitDirValue = (await run(source, ['rev-parse', '--absolute-git-dir'])).stdout.trim(), gitDirStat = fs.lstatSync(gitDir);
  if (!samePath(gitDir, gitDirValue) || !gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) fail('GIT_INDEX_UNAVAILABLE', 'Git metadata must retain its canonical directory identity');
  const indexPath = path.resolve(root, (await run(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim());
  if (!samePath(path.dirname(indexPath), gitDir) || path.basename(indexPath) !== 'index') fail('GIT_INDEX_UNAVAILABLE', 'Git index is outside the verified repository metadata');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (fs.existsSync(path.join(gitDir, marker))) fail('GIT_OPERATION_IN_PROGRESS', 'Finish or review the current Git integration before changing its index');
  }
  let headRef = null;
  try { headRef = (await run(source, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim(); }
  catch (error) { if (error.exitCode !== 1 || !status.headSha) throw error; }
  if (headRef !== null && !/^refs\/heads\/[^\s\x00-\x1f\x7f]+$/.test(headRef)) fail('GIT_HEAD_REQUIRED', 'Git HEAD must identify a literal local branch or a detached commit');
  const index = indexBytes(indexPath), entries = parseIndex((await run(source, ['ls-files', '--stage', '-z'])).stdout);
  assertSelectedEntries(paths, entries);
  const content = observeFiles(root, paths);
  if (!samePath(fs.realpathSync.native(entry.root), root) || !sameNode(rootStat, fs.lstatSync(root)) || !sameNode(gitDirStat, fs.lstatSync(gitDir)) || indexBytes(indexPath).identity !== index.identity) fail('GIT_INDEX_CHANGED', 'Git repository changed during review');
  source.assertRepositoryUnchanged();
  return { ...source, rootStat, gitDirStat, indexPath, index, entries, headSha: status.headSha, headRef, ...content };
}

function assertExpected(meta, request, original) {
  if (meta.repositoryIdentity !== request.expectedRepositoryIdentity) fail('GIT_REPOSITORY_CHANGED', 'Git metadata ownership differs from the approved repository; refresh and review again');
  if (meta.headSha !== request.expectedHead || meta.headRef !== request.expectedHeadRef) fail('GIT_HEAD_CHANGED', 'Repository HEAD or branch changed; refresh and review again');
  if (meta.index.identity !== request.indexIdentity) fail('GIT_INDEX_CHANGED', 'Git index changed; refresh and review again');
  for (const rel of request.paths) {
    const file = meta.files.get(rel);
    if (file.hash !== request.expectedHashes[rel]) fail('WORKSPACE_CONFLICT', 'Selected working content changed; refresh and review again');
    if (original) {
      const before = original.files.get(rel);
      if (!!before.stat !== !!file.stat || before.stat && !sameFile(before.stat, file.stat)
        || before.parents.length !== file.parents.length || before.parents.some((parent, index) => !sameNode(parent.stat, file.parents[index].stat))) fail('WORKSPACE_CONFLICT', 'Selected file identity changed during dispatch');
    }
  }
  if (request.expectedIndexEntries) {
    const current = selectedEntries(request.paths, meta.entries);
    for (const expected of request.expectedIndexEntries) {
      const actual = current.find(item => item.path === expected.path);
      if (actual.mode !== expected.mode || actual.oid !== expected.oid) fail('GIT_INDEX_CHANGED', 'Selected staged content differs from the reviewed mode and object identity');
    }
  }
  if (original && (!samePath(original.root, meta.root) || !samePath(original.gitDir, meta.gitDir) || !sameNode(original.rootStat, meta.rootStat) || !sameNode(original.gitDirStat, meta.gitDirStat))) fail('GIT_INDEX_CHANGED', 'Repository ownership changed during dispatch');
}

function acquireIndexLock(meta) {
  const location = meta.indexPath + '.lock';
  let handle;
  try { handle = fs.openSync(location, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('GIT_INDEX_BUSY', 'Another Git operation owns the normal index lock; wait and refresh'); throw error; }
  const identity = fs.fstatSync(handle, { bigint: true });
  const owned = () => { try { const current = fs.lstatSync(location, { bigint: true }); return current.isFile() && !current.isSymbolicLink() && sameNode(identity, current); } catch { return false; } };
  return { location, ownershipIdentity: digest(JSON.stringify([location, String(identity.dev), String(identity.ino)])), assertOwned() { if (!owned()) fail('GIT_INDEX_BUSY', 'Index lock ownership changed; the external lock was retained'); },
    replace(bytes) {
      this.assertOwned(); fs.ftruncateSync(handle, 0); fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); this.assertOwned();
      fs.closeSync(handle); handle = null; this.assertOwned(); fs.renameSync(location, meta.indexPath);
    },
    release() { if (handle !== null) { fs.closeSync(handle); handle = null; } if (owned()) fs.unlinkSync(location); }
  };
}

async function writeEntries(source, indexFile, entries) {
  for (const entry of entries) {
    if (entry.mode === null) await run(source, ['update-index', '--force-remove', '--', entry.path], { indexFile });
    else await run(source, ['update-index', '--add', '--cacheinfo', entry.mode, entry.oid, entry.path], { indexFile });
  }
}

async function headEntries(meta, paths) {
  if (!meta.headSha) return paths.map(rel => ({ path: rel, mode: null, oid: null }));
  const entries = new Map();
  for (const row of (await run(meta, ['ls-tree', '-r', '-z', '--full-tree', meta.headSha, '--', ...paths])).stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!match) fail('GIT_INDEX_UNAVAILABLE', 'Git returned an invalid baseline tree entry');
    entries.set(match[3], { path: match[3], mode: match[1], oid: match[2] });
  }
  assertSelectedEntries(paths, entries); return selectedEntries(paths, entries);
}

/** Trusted executors behind the existing Capability Broker. No RPC approval
 * flag, repository store, shell, remote operation or working-file write. */
export function createGitIndexActions({ record = () => {} } = {}) {
  async function reviewStaged(entry, { paths } = {}) {
    const selected = pathsOf(paths), meta = await observe(entry, selected);
    const request = { paths: selected, expectedHead: meta.headSha, expectedHeadRef: meta.headRef, indexIdentity: meta.index.identity, expectedRepositoryIdentity: meta.repositoryIdentity,
      expectedHashes: Object.fromEntries(selected.map(rel => [rel, meta.files.get(rel).hash])), expectedIndexEntries: selectedEntries(selected, meta.entries) };
    assertExpected(await observe(entry, selected), request, meta);
    return { workspaceId: entry.id, ...request, headSha: meta.headSha, reviewedBytes: meta.total };
  }

  async function execute(entry, input, actor, action) {
    const staged = action === 'commit', request = requireRequest(input, staged), before = await observe(entry, request.paths);
    assertExpected(before, request);
    if (staged && before.headRef === null) fail('GIT_DETACHED_COMMIT_UNSUPPORTED', 'Create or switch to a reviewed local branch before committing staged content');
    if (staged) {
      const version = /^git version (\d+)\.(\d+)\.(\d+)(?:[.\-+ ].*)?$/.exec((await run(before, ['version'])).stdout.trim());
      if (!version || Number(version[1]) !== 2 || Number(version[2]) < 55) fail('GIT_REFERENCE_BACKEND_UNSUPPORTED', 'Pinned Git reference effects require a supported Git 2.x release at version 2.55 or later');
    }
    const lock = acquireIndexLock(before);
    let temporary, temporaryIdentity, result, outcomeError, effect = false, sha;
    const recheck = async () => { lock.assertOwned(); assertExpected(await observe(entry, request.paths), request, before); lock.assertOwned(); };
    try {
      await recheck();
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-approved-index-'));
      temporary = fs.realpathSync.native(temporary);
      temporaryIdentity = fs.lstatSync(temporary, { bigint: true });
      const indexFile = path.join(temporary, 'index');
      if (!staged && before.index.bytes) fs.writeFileSync(indexFile, before.index.bytes, { mode: 0o600 });
      else await run(before, before.headSha && staged ? ['read-tree', before.headSha] : ['read-tree', '--empty'], { indexFile });
      if (action === 'stage') {
        const present = request.paths.filter(rel => before.files.get(rel).stat);
        if (present.length) {
          await run(before, ['add', '--', ...present], { indexFile });
          const added = parseIndex((await run(before, ['ls-files', '--stage', '-z'], { indexFile })).stdout);
          assertSelectedEntries(request.paths, added);
          // A copied index has a newer timestamp than its original stat cache.
          // Do not let matching size/mtime suppress hashing approved bytes.
          // hash-object uses Git's path conversion rules and the same pinned,
          // disabled-filter executor, without trusting cached index metadata.
          for (const rel of present) {
            const current = added.get(rel);
            if (!current) fail('GIT_INDEX_CHANGED', 'Selected regular file was not added to the private index');
            const object = (await run(before, ['hash-object', '-w', '--path', rel, '--', rel])).stdout.trim();
            if (!oid(object)) fail('GIT_INDEX_UNAVAILABLE', 'Git did not identify the reviewed file content');
            await writeEntries(before, indexFile, [{ ...current, oid: object }]);
          }
        }
        await writeEntries(before, indexFile, request.paths.filter(rel => !before.files.get(rel).stat).map(rel => ({ path: rel, mode: null, oid: null })));
      } else await writeEntries(before, indexFile, staged ? request.expectedIndexEntries : await headEntries(before, request.paths));
      const candidate = parseIndex((await run(before, ['ls-files', '--stage', '-z'], { indexFile })).stdout);
      assertSelectedEntries(request.paths, candidate);
      // Git may refresh index bookkeeping, but an exact-path operation must
      // preserve every unselected staged mode and OID.
      if (!staged) {
        for (const [rel, current] of before.entries) if (!request.paths.includes(rel)) {
          const next = candidate.get(rel); if (!next || next.mode !== current.mode || next.oid !== current.oid) fail('GIT_INDEX_CHANGED', 'Unselected staged content cannot be changed by this action');
        }
        for (const rel of candidate.keys()) if (!request.paths.includes(rel) && !before.entries.has(rel)) fail('GIT_INDEX_CHANGED', 'Unselected index paths cannot be added by this action');
      }
      await recheck();
      if (staged) {
        const tree = (await run(before, ['write-tree'], { indexFile })).stdout.trim();
        if (!oid(tree)) fail('GIT_COMMIT_INVALID', 'Git did not return a valid reviewed tree');
        if (before.headSha && tree === (await run(before, ['rev-parse', before.headSha + '^{tree}'])).stdout.trim()
          || !before.headSha && candidate.size === 0) return result = { committed: false, reason: 'nothing-to-commit', paths: request.paths };
        sha = (await run(before, ['commit-tree', tree, ...(before.headSha ? ['-p', before.headSha] : []), '-m', request.message], { indexFile })).stdout.trim();
        if (!oid(sha)) fail('GIT_COMMIT_INVALID', 'Git did not return a valid commit identity');
        await recheck();
        // Pin the approved ref itself. Native Git rejects a symref-verify HEAD
        // plus referent update as duplicate HEAD updates. This is a single-ref
        // CAS, not an atomic transaction over HEAD, index and working files.
        // no-deref prevents a concurrently substituted symbolic branch ref
        // from redirecting this write to an unapproved branch.
        const transaction = `start\noption no-deref\nupdate ${before.headRef} ${sha} ${before.headSha ?? zero}\nprepare\ncommit\n`;
        // GIT_COMMON_DIR is a repository projection, not a ref-backend pin:
        // Git 2.55 resolves commondir again inside refs. The validated native
        // backend URI overrides both that marker and config payload at launch.
        try { await run(before, ['update-ref', '-m', 'CetaMesh approved staged commit', '--stdin'], { input: transaction, referenceBackend: { format: before.refFormat, root: before.commonDir } }); }
        catch (error) {
          if (!Number.isInteger(error.exitCode) || error.killed) {
            try { record(entry, actor ?? 'capability-broker', 'git.commit.staged.unknown', `sha=${sha};ref=${before.headRef}`); } catch {}
            fail('GIT_COMMIT_REVIEW_REQUIRED', 'Commit reference outcome is unconfirmed; retain this operation and inspect Git history before another action', { effectStatus: 'unknown', sha, ref: before.headRef });
          }
          fail('GIT_REF_CHANGED', 'The reviewed HEAD reference is locked or changed; existing refs and index were retained');
        }
        effect = true;
        try { record(entry, actor ?? 'capability-broker', 'git.commit.staged', `sha=${sha};ref=${before.headRef};base=${before.headSha ?? 'unborn'}`); }
        catch { fail('GIT_AUDIT_REVIEW_REQUIRED', 'Commit exists but its Workspace receipt could not be saved; retain the operation for review', { effectStatus: 'unknown', sha, ref: before.headRef }); }
        // Exact staged entries already equal the new commit. Keeping the normal
        // index byte-for-byte preserves unrelated stage and partial work.
        lock.assertOwned(); assertExpected(await observe(entry, request.paths), { ...request, expectedHead: sha }, before); lock.assertOwned();
        result = { committed: true, sha, ref: before.headRef, parent: before.headSha, paths: request.paths, indexUpdated: true, indexChanged: false };
      } else {
        const bytes = indexBytes(indexFile).bytes;
        // All asynchronous work precedes this last exact file/root check and
        // the synchronous replacement through our owned normal Git lock.
        const files = observeFiles(before.root, request.paths);
        assertExpected({ ...before, ...files, index: indexBytes(before.indexPath) }, request, before);
        before.assertRepositoryUnchanged(); lock.replace(bytes); effect = true;
        result = { [action === 'stage' ? 'staged' : 'unstaged']: true, paths: request.paths, indexIdentity: digest(bytes), headSha: before.headSha };
      }
      try { if (!staged) record(entry, actor ?? 'capability-broker', 'git.' + action, request.paths.join(', ').replace(/[\x00-\x1f\x7f]/g, ' ')); }
      catch { fail('GIT_AUDIT_REVIEW_REQUIRED', 'Git changed but its audit record could not be saved; inspect the retained operation before retrying', { effectStatus: 'unknown', ...(sha ? { sha } : {}) }); }
      return result;
    } catch (error) {
      outcomeError = effect && error.effectStatus !== 'unknown'
        ? Object.assign(new Error('Git changed but completion could not be confirmed; retain and inspect the operation before retrying'), { code: 'GIT_OPERATION_REVIEW_REQUIRED', effectStatus: 'unknown', ...(sha ? { sha, ref: before.headRef } : {}) })
        : typeof error.code === 'string' ? error : Object.assign(new Error('Git index action could not complete; existing files and history were retained'), { code: 'GIT_FAILED' });
      throw outcomeError;
    } finally {
      const pending = [];
      try { lock.release(); }
      catch { pending.push({ kind: 'git-index-lock', id: 'index.lock', identity: lock.ownershipIdentity, repositoryIdentity: before.repositoryIdentity }); }
      if (temporary) {
        const identity = temporaryIdentity ? digest(JSON.stringify([path.resolve(temporary), String(temporaryIdentity.dev), String(temporaryIdentity.ino)])) : null;
        try {
          if (!temporaryIdentity) throw new Error('Temporary ownership could not be captured');
          const current = fs.lstatSync(temporary, { bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, temporaryIdentity) || !samePath(fs.realpathSync.native(temporary), temporary)) throw new Error('Temporary ownership changed');
          fs.rmSync(temporary, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== 'ENOENT') pending.push({ kind: 'temporary-git-index', id: path.basename(temporary), identity });
        }
      }
      if (pending.length) {
        // Cleanup is maintenance evidence, not a new effect verdict. In
        // particular it cannot replace a confirmed commit or mask an existing
        // unknown outcome and its actual sha/ref. Future cleanup must verify
        // the retained resource identity, never remove another writer's lock.
        Object.assign(outcomeError ?? result ?? {}, { cleanupPending: true, cleanupResources: pending });
        try { record(entry, actor ?? 'capability-broker', 'git.cleanup.pending', JSON.stringify({ resources: pending, ...(sha ? { sha, ref: before.headRef } : {}) })); } catch {}
      }
    }
  }
  return { reviewStaged, stage: (entry, request, actor) => execute(entry, request, actor, 'stage'),
    unstage: (entry, request, actor) => execute(entry, request, actor, 'unstage'), commitStaged: (entry, request, actor) => execute(entry, request, actor, 'commit') };
}
