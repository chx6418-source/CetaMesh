import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gitRun } from './tools.js';
import { observeGitMutation, assertGitMutationExpected, acquireGitMutationIndexLock, readGitMutationIndex } from './git-index-actions.js';
import { applyWorkspaceByteTransaction, inspectWorkspaceByteTransaction } from './transaction.js';

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const dirtyIdentity = meta => digest(JSON.stringify(meta.status.entries));
const modes = meta => Object.fromEntries([...meta.files].map(([rel, file]) => [rel, file.stat ? file.stat.mode & 0o7777 : null]));
const hashes = meta => Object.fromEntries([...meta.files].map(([rel, file]) => [rel, file.hash]));
const sensitive = value => value.split('/').some(part => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part));
const active = signal => { if (signal?.aborted) fail('INVOKE_CANCELLED', 'Git branch action was cancelled before its next phase'); };
const run = (meta, args, options = {}) => gitRun(meta.root, args, { ...options, literalPaths: true, repository: meta.repository, referenceBackend: { format: meta.refFormat, root: meta.commonDir } });

function pathsOf(paths) {
  if (!Array.isArray(paths) || paths.length > 100) fail('GIT_REVIEW_LIMIT', 'A clean switch requires at most 100 exact changed files');
  const seen = new Set();
  for (const rel of paths) {
    if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)
      || rel.split('/').some(part => !part || part === '.' || part === '..')) fail('GIT_PATH_INVALID', 'Switch scope must contain exact normalized relative files');
    if (sensitive(rel)) fail('SENSITIVE_RESOURCE', 'The branch changes a resource excluded from Workspace Git mutations');
    const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
    if (seen.has(key) || [...seen].some(previous => key.startsWith(previous + '/') || previous.startsWith(key + '/'))) fail('GIT_PATH_INVALID', 'Directory transitions or aliased paths require a separate Git review');
    seen.add(key);
  }
  return [...paths];
}
function branchOf(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^refs\/heads\/[^\s\x00-\x1f\x7f]+$/.test(value)) fail('GIT_BRANCH_INVALID', 'Select one existing full local branch reference');
  return value;
}
function requireRequest(input) {
  if (!input || typeof input !== 'object') fail('GIT_SWITCH_REVIEW_REQUIRED', 'Review the exact branch switch first');
  const paths = pathsOf(input.paths), targetBranch = branchOf(input.targetBranch), mode = input.mode;
  const byteTransaction = input.byteTransaction;
  if (byteTransaction !== undefined && (!byteTransaction || typeof byteTransaction !== 'object' || Object.keys(byteTransaction).length !== 4
    || !/^batch-[a-f0-9]{64}$/.test(byteTransaction.name ?? '') || !hash(byteTransaction.sha256) || !hash(byteTransaction.requestSha256)
    || !['dispatching', 'applied', 'unknown'].includes(byteTransaction.status))) fail('GIT_SWITCH_REVIEW_REQUIRED', 'Supply the exact retained file-phase evidence');
  if (!['clean', 'finish-prepared'].includes(mode)) fail('GIT_SWITCH_REVIEW_REQUIRED', 'Select a clean switch or a fresh reviewed prepared-state completion');
  if (!oid(input.expectedHead) || !Object.hasOwn(input, 'expectedHeadRef') || input.expectedHeadRef !== null && !/^refs\/heads\/[^\s\x00-\x1f\x7f]+$/.test(input.expectedHeadRef)) fail('GIT_HEAD_REQUIRED', 'Supply the reviewed commit and actual local HEAD reference or explicit detached null');
  if (!oid(input.expectedTargetHead) || !hash(input.expectedRepositoryIdentity) || !Object.hasOwn(input, 'indexIdentity') || input.indexIdentity !== null && !hash(input.indexIdentity) || !hash(input.expectedDirtyIdentity)) fail('GIT_SWITCH_REVIEW_REQUIRED', 'Supply the exact reviewed repository, index, dirty-state and target identities');
  for (const [field, validate] of [['expectedHashes', value => value === null || hash(value)], ['expectedWorkingModes', value => value === null || Number.isInteger(value) && value >= 0 && value <= 0o7777]]) {
    if (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field]) || Object.keys(input[field]).length !== paths.length
      || paths.some(rel => !Object.hasOwn(input[field], rel) || !validate(input[field][rel]))) fail('GIT_SWITCH_REVIEW_REQUIRED', 'Every affected path needs its reviewed bytes and mode');
  }
  return { paths, targetBranch, mode, expectedTargetHead: input.expectedTargetHead, expectedHead: input.expectedHead, expectedHeadRef: input.expectedHeadRef,
    expectedRepositoryIdentity: input.expectedRepositoryIdentity, indexIdentity: input.indexIdentity, expectedDirtyIdentity: input.expectedDirtyIdentity,
    expectedHashes: Object.fromEntries(paths.map(rel => [rel, input.expectedHashes[rel]])), expectedWorkingModes: Object.fromEntries(paths.map(rel => [rel, input.expectedWorkingModes[rel]])),
    ...(byteTransaction ? {byteTransaction: structuredClone(byteTransaction)} : {}) };
}
function binding(meta) {
  return { expectedHead: meta.headSha, expectedHeadRef: meta.headRef, expectedRepositoryIdentity: meta.repositoryIdentity, indexIdentity: meta.index.identity,
    expectedHashes: hashes(meta), expectedWorkingModes: modes(meta), expectedDirtyIdentity: dirtyIdentity(meta) };
}
function assertBinding(meta, request, before) {
  assertGitMutationExpected(meta, request, before);
  if (dirtyIdentity(meta) !== request.expectedDirtyIdentity) fail('GIT_WORKTREE_CHANGED', 'The reviewed dirty-state set changed; refresh the branch review');
  const actual = modes(meta);
  if (request.paths.some(rel => actual[rel] !== request.expectedWorkingModes[rel])) fail('WORKSPACE_CONFLICT', 'Affected working-file permissions changed; refresh the branch review');
}
async function protocol(meta, signal) {
  const version = /^git version (\d+)\.(\d+)\.(\d+)(?:[.\-+ ].*)?$/.exec((await run(meta, ['version'], { signal })).stdout.trim());
  if (!version || Number(version[1]) !== 2 || Number(version[2]) < 55) fail('GIT_REFERENCE_BACKEND_UNSUPPORTED', 'Clean switching requires supported native Git 2.x at version 2.55 or later');
  const flags = (await run(meta, ['ls-files', '-v', '-z'], { signal })).stdout.split('\0').filter(Boolean);
  if (flags.some(row => row[0] !== 'H')) fail('GIT_SWITCH_LAYOUT_UNSUPPORTED', 'Review sparse or assumed-unchanged index entries with their existing Git owner before switching');
  try { if ((await run(meta, ['config', '--bool', '--get', 'core.sparseCheckout'], { signal })).stdout.trim() === 'true') fail('GIT_SWITCH_LAYOUT_UNSUPPORTED', 'Sparse checkout needs a separate reviewed write-scope protocol'); }
  catch (error) { if (error.exitCode !== 1) throw error; }
}
function slotOf(meta) {
  if (samePath(meta.gitDir, meta.commonDir)) return 'main-worktree/HEAD';
  const id = path.basename(meta.gitDir);
  if (!samePath(path.dirname(meta.gitDir), path.join(meta.commonDir, 'worktrees')) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) fail('GIT_SWITCH_LAYOUT_UNSUPPORTED', 'The native linked-worktree identifier is not supported by the branch switch protocol');
  return 'worktrees/' + id + '/HEAD';
}
async function assertSourceHead(meta, signal) {
  const slot = slotOf(meta); let ref = null;
  try { ref = (await run(meta, ['symbolic-ref', '--no-recurse', '-q', slot], { signal })).stdout.trim(); } catch (error) { if (error.exitCode !== 1) throw error; }
  const sha = (await run(meta, ['rev-parse', '--verify', '--end-of-options', slot + '^{commit}'], { signal })).stdout.trim();
  if (sha !== meta.headSha || ref !== meta.headRef) fail('GIT_HEAD_CHANGED', 'The actual source worktree HEAD differs from the reviewed repository context');
}
async function targetHead(meta, branch, signal) {
  await run(meta, ['check-ref-format', branch], { signal });
  try { await run(meta, ['symbolic-ref', '--no-recurse', '-q', branch], { signal }); fail('GIT_BRANCH_INVALID', 'Select a direct local branch rather than a symbolic alias'); } catch (error) { if (error.exitCode !== 1) throw error; }
  let sha;
  try { sha = (await run(meta, ['show-ref', '--verify', '--hash', branch], { signal })).stdout.trim(); }
  catch (error) { if (Number.isInteger(error.exitCode)) fail('GIT_BRANCH_CHANGED', 'The reviewed local branch no longer exists; refresh Git branches'); throw error; }
  if (!oid(sha) || (await run(meta, ['cat-file', '-t', sha], { signal })).stdout.trim() !== 'commit') fail('GIT_BRANCH_INVALID', 'The selected local branch must directly identify a commit');
  return sha;
}
async function changedPaths(meta, target, signal) {
  return pathsOf((await run(meta, ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', meta.headSha, target, '--'], { signal })).stdout.split('\0').filter(Boolean));
}
async function treeEntries(meta, sha, paths, signal) {
  const entries = new Map(); if (!paths.length) return entries;
  for (const row of (await run(meta, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...paths], { signal })).stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!match || !paths.includes(match[4]) || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') fail('GIT_PATH_INVALID', 'A clean switch can change only the exact reviewed regular files');
    entries.set(match[4], { mode: match[1], oid: match[3] });
  }
  return entries;
}
async function indexMatches(meta, sha, signal, options = {}) {
  try { await run(meta, ['diff-index', '--cached', '--quiet', sha, '--'], { ...options, signal }); return true; }
  catch (error) { if (error.exitCode === 1) return false; throw error; }
}
async function workingMatches(meta, entries, paths, signal) {
  for (const rel of paths) {
    const tree = entries.get(rel), file = meta.files.get(rel);
    if (!tree) { if (file.stat) return false; continue; }
    if (!file.stat) return false;
    const actual = (await run(meta, ['hash-object', '--path', rel, '--', rel], { signal })).stdout.trim();
    if (actual !== tree.oid) return false;
  }
  return true;
}
async function occupied(meta, branch, signal) {
  const output = (await run(meta, ['worktree', 'list', '--porcelain', '-z'], { signal })).stdout;
  for (const record of output.split('\0\0').filter(Boolean)) {
    const fields = record.split('\0'), location = fields.find(row => row.startsWith('worktree '))?.slice(9), attached = fields.find(row => row.startsWith('branch '))?.slice(7);
    if (!location || !path.isAbsolute(location)) fail('GIT_WORKTREE_UNVERIFIED', 'Native Git returned an unverifiable worktree owner');
    if (attached === branch && !samePath(location, meta.root)) return true;
  }
  return false;
}
function assertNoLocks(meta, ownedIndexLock) {
  for (const [location, code] of [[meta.indexPath + '.lock', 'GIT_INDEX_BUSY'], [path.join(meta.gitDir, 'HEAD.lock'), 'GIT_HEAD_BUSY']]) {
    if (code === 'GIT_INDEX_BUSY' && ownedIndexLock) { ownedIndexLock.assertOwned(); continue; }
    try { fs.lstatSync(location); fail(code, 'An existing Git lock owns this repository phase; wait for its owner and refresh'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function readiness(meta, target, paths, mode, signal, recovery) {
  const oldTree = await treeEntries(meta, meta.headSha, paths, signal), newTree = await treeEntries(meta, target.sha, paths, signal);
  let targetBytes = 0;
  for (const tree of newTree.values()) { const size = Number((await run(meta, ['cat-file', '-s', tree.oid], { signal })).stdout.trim()); if (!Number.isSafeInteger(size) || size > 10 * 1024 * 1024 || (targetBytes += size) > 64 * 1024 * 1024) fail('GIT_REVIEW_LIMIT', 'The target files exceed the bounded branch review'); }
  const blocker = (code, message) => ({ code, message });
  if (await occupied(meta, target.branch, signal)) return blocker('GIT_BRANCH_IN_USE', 'Another native worktree owns this branch; move that owner explicitly before switching');
  if (recovery) {
    recovery.assertApplied();
    if (mode !== 'finish-prepared' && (meta.headSha !== target.sha || meta.headRef !== target.branch)) return {...blocker('WORKSPACE_RECOVERY_REQUIRED', 'The prior file phase completed; review its missing index and HEAD phases without replaying writes'), recoveryAction: 'finish-prepared'};
    if (meta.status.entries.some(row => !paths.includes(row.path) || row.origPath && !paths.includes(row.origPath))) return blocker('GIT_WORKTREE_DIRTY', 'Unrelated working or staged changes must be preserved before completing this switch');
    if (!await indexMatches(meta, target.sha, signal) && meta.index.identity !== recovery.owner.initialIndexIdentity) return blocker('GIT_INDEX_CHANGED', 'The normal index matches neither the completed target nor its exact original identity');
    if (!await workingMatches(meta, newTree, paths, signal)) return blocker('GIT_WORKTREE_DIRTY', 'The retained file receipt no longer matches the native target tree');
    return null;
  }
  if (mode === 'clean' && paths.some(rel => !oldTree.has(rel) && meta.files.get(rel).stat)) return blocker('GIT_CHECKOUT_COLLISION', 'A reviewed target path would replace an existing untracked or ignored file; preserve it before switching');
  if (mode === 'clean' && meta.status.entries.length || mode === 'finish-prepared' && meta.status.entries.some(row => row.y !== ' ' || row.x === '?' || row.y === '?')) return blocker('GIT_WORKTREE_DIRTY', 'Working changes require an explicit save and byte-preserving recovery flow before this branch action');
  if (!await indexMatches(meta, mode === 'clean' ? meta.headSha : target.sha, signal) || !await workingMatches(meta, mode === 'clean' ? oldTree : newTree, paths, signal)) return blocker('GIT_WORKTREE_DIRTY', 'The actual index or affected working bytes do not match the required clean tree; inspect and preserve them before switching');
  return null;
}

// The index is an owned computation artifact, never a second repository or
// authoritative store. Native Git encodes it; the existing G1 lock replaces the
// sole normal index only after the full native working-tree phase succeeds.
function temporaryIndex() {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-branch-index-'))), stat = fs.lstatSync(directory, { bigint: true }); fs.chmodSync(directory, 0o700);
  const assertOwned = () => { const current = fs.lstatSync(directory, { bigint: true }); if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, stat) || !samePath(fs.realpathSync.native(directory), directory)) throw new Error('Temporary Git index ownership changed'); };
  return { directory, indexFile: path.join(directory, 'index'), id: path.basename(directory), identity: digest(JSON.stringify([directory, String(stat.dev), String(stat.ino)])), assertOwned,
    release() { try { fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; } assertOwned(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

export async function prepareTargetBytes(meta, target, paths, context, signal) {
  context.assertOwned();
  const output = path.join(context.directory, 'output'); fs.mkdirSync(output, {mode: 0o700});
  const repository = {...meta.repository, workTree: output};
  const native = (args, options = {}) => gitRun(output, ['-c', 'core.splitIndex=false', ...args],
    {...options, signal, literalPaths: true, indexFile: context.indexFile, repository,
      referenceBackend: {format: meta.refFormat, root: meta.commonDir}});
  await native(['read-tree', target]);
  const entries = await treeEntries(meta, target, paths, signal), candidates = new Set(['.gitattributes']);
  let candidateChars = 0;
  for (const rel of paths) {
    let parent = '';
    for (const part of rel.split('/').slice(0, -1)) {
      parent = parent ? parent + '/' + part : part; const attr = parent + '/.gitattributes';
      if (!candidates.has(attr)) { candidates.add(attr); candidateChars += attr.length; }
      if (candidates.size > 256 || candidateChars > 20_000) fail('GIT_REVIEW_LIMIT', 'Target attribute ancestry exceeds the bounded native preparation');
    }
  }
  const attributeFiles = [];
  for (const row of (await native(['ls-files', '--stage', '-z', '--', ...candidates])).stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(row);
    if (!match || !['100644', '100755'].includes(match[1]) || !candidates.has(match[3])) fail('GIT_PATH_INVALID', 'Target conversion attributes must be exact regular files');
    const bytes = await native(['cat-file', 'blob', match[2]], {binaryOutput: true, maxOutputBytes: 64 * 1024});
    if (!Buffer.isBuffer(bytes.stdout)) fail('GIT_OUTPUT_INVALID', 'Native Git did not return exact target attribute bytes');
    // Raw target attributes are reference data for the existing Git conversion,
    // not executable configuration; the shared executor still disables drivers.
    const file = path.join(output, ...match[3].split('/')); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes.stdout, {flag: 'wx', mode: 0o600});
    attributeFiles.push(match[3]);
  }
  let total = 0;
  const changes = [];
  for (const rel of paths) {
    active(signal); context.assertOwned(); const targetEntry = entries.get(rel);
    if (!targetEntry) { changes.push({path: rel, action: 'delete', expectedHash: meta.files.get(rel).hash}); continue; }
    const converted = await native(['cat-file', '--filters', '--path=' + rel, targetEntry.oid], {binaryOutput: true, maxOutputBytes: 10 * 1024 * 1024});
    if (!Buffer.isBuffer(converted.stdout) || (total += converted.stdout.length) > 64 * 1024 * 1024) fail('GIT_REVIEW_LIMIT', 'Converted target files exceed the bounded raw publication');
    const file = path.join(output, ...rel.split('/')); fs.mkdirSync(path.dirname(file), {recursive: true});
    if (!attributeFiles.includes(rel)) fs.writeFileSync(file, converted.stdout, {flag: 'wx', mode: 0o600});
    else if (!fs.readFileSync(file).equals(converted.stdout)) fail('GIT_PATH_INVALID', 'A target attribute file requires unsupported self-conversion');
    if ((await native(['hash-object', '--path', rel, '--', rel])).stdout.trim() !== targetEntry.oid) fail('GIT_WORKTREE_CHANGED', 'Converted target bytes do not roundtrip to the reviewed object');
    changes.push({path: rel, action: 'write', expectedHash: meta.files.get(rel).hash, bytes: converted.stdout});
  }
  context.assertOwned(); meta.assertRepositoryUnchanged(); return changes;
}

// Shared internal computation artifact for checkpoint head preparation. No tool
// parameter can select its location or bypass its directory ownership checks.
export {temporaryIndex as temporaryGitIndex};

// This temporary directory holds only immutable call-layout facts. Git's
// payload backend still writes the sole approved source ref store. Qualified
// HEAD names are used for observations; Git rejects their symbolic writes.
function routingAnchor(meta) {
  const slot = slotOf(meta), linked = slot !== 'main-worktree/HEAD';
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-head-routing-'))), baseStat = fs.lstatSync(base, { bigint: true });
  const directory = path.join(base, linked ? path.basename(meta.gitDir) : 'main');
  let directoryStat; const files = [];
  const assertOwned = (cleanup = false) => {
    const current = fs.lstatSync(base, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, baseStat) || !samePath(fs.realpathSync.native(base), base)) throw new Error('Git routing anchor ownership changed');
    if (!directoryStat) { if (fs.readdirSync(base).length) throw new Error('Unverified routing anchor material'); return; }
    const nested = fs.lstatSync(directory, { bigint: true });
    if (!nested.isDirectory() || nested.isSymbolicLink() || !sameNode(nested, directoryStat) || fs.readdirSync(base).some(name => name !== path.basename(directory))) throw new Error('Git routing layout ownership changed');
    const present = fs.readdirSync(directory);
    if (present.some(name => !files.some(file => path.basename(file.location) === name))) throw new Error('Unowned routing material retained');
    for (const file of files) {
      let stat; try { stat = fs.lstatSync(file.location, { bigint: true }); } catch (error) { if (cleanup && error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || !sameNode(stat, file.stat) || digest(fs.readFileSync(file.location)) !== file.hash) throw new Error('Routing anchor facts changed');
    }
  };
  const anchor = { id: path.basename(base), identity: digest(JSON.stringify([base, String(baseStat.dev), String(baseStat.ino)])), repository: { ...meta.repository, gitDir: directory }, assertOwned,
    release() { try { fs.lstatSync(base); } catch (error) { if (error.code === 'ENOENT') return; throw error; } assertOwned(true); fs.rmSync(base, { recursive: true, force: true }); } };
  try {
    fs.chmodSync(base, 0o700); fs.mkdirSync(directory, { mode: 0o700 }); directoryStat = fs.lstatSync(directory, { bigint: true });
    for (const [name, content] of [['HEAD', meta.headRef ? 'ref: ' + meta.headRef + '\n' : meta.headSha + '\n'], ...(linked ? [['commondir', meta.commonDir.split(path.sep).join('/') + '\n']] : [])]) {
      const location = path.join(directory, name); fs.writeFileSync(location, content, { flag: 'wx', mode: 0o400 }); files.push({ location, hash: digest(Buffer.from(content)), stat: fs.lstatSync(location, { bigint: true }) });
    }
    assertOwned(); return anchor;
  } catch (error) { try { anchor.release(); } catch { error.cleanupResource = { kind: 'git-head-routing-anchor', id: anchor.id, identity: anchor.identity }; } throw error; }
}

/** In-process executors behind the existing Workspace/Capability approval path.
 * A two-phase tree/HEAD change cannot be atomic with arbitrary working files. */
export function createGitBranchActions({ record = () => {}, nativeExecutable } = {}) {
  const knownNoEffect = new WeakSet();
  function noEffect(error) {
    if (error?.effectStatus === 'unknown') return error;
    const failure = Object.assign(new Error(error?.message ?? 'Git switch preparation failed'), error, {effectStatus: 'none'});
    knownNoEffect.add(failure); return failure;
  }
  async function retainedPhase(entry, meta, branch, target, signal) {
    const retained = inspectWorkspaceByteTransaction(meta.root); if (!retained) return null;
    const owner = retained.owner;
    if (!owner || owner.kind !== 'git-branch-switch' || owner.workspaceId !== entry.id || owner.recoveryIdentity !== meta.recoveryIdentity
      || owner.targetBranch !== branch || owner.targetHead !== target || !oid(owner.oldHead) || !Object.hasOwn(owner, 'initialIndexIdentity')
      || owner.initialIndexIdentity !== null && !hash(owner.initialIndexIdentity)
      || JSON.stringify(pathsOf(owner.paths)) !== JSON.stringify(owner.paths)
      || !((meta.headSha === owner.oldHead) || meta.headSha === target && meta.headRef === branch)) fail('WORKSPACE_RECOVERY_REQUIRED', 'The retained file phase belongs to a different Workspace, repository or branch operation');
    if (owner.oldRef && await targetHead(meta, owner.oldRef, signal) !== owner.oldHead) fail('GIT_HEAD_CHANGED', 'The original source branch changed after its file phase; preserve both branches for review');
    return retained;
  }
  async function assertMetadataRecovery(meta, original, branch, signal) {
    if (!original || original.paths?.length !== 0 || original.targetBranch !== branch
      || meta.repositoryIdentity !== original.expectedRepositoryIdentity || meta.index.identity !== original.indexIdentity
      || !(meta.headSha===original.expectedHead&&meta.headRef===original.expectedHeadRef
        || meta.headSha===original.expectedTargetHead&&meta.headRef===original.targetBranch)
      || (await changedPaths(meta, original.expectedTargetHead, signal)).length
      || await targetHead(meta,original.targetBranch,signal)!==original.expectedTargetHead
      || original.expectedHeadRef&&await targetHead(meta,original.expectedHeadRef,signal)!==original.expectedHead)
      fail('GIT_METADATA_RECOVERY_CHANGED','Original zero-file Git scope, repository, index or physical HEAD changed');
  }
  async function reviewSwitch(entry, { targetBranch, mode = 'clean' } = {}, { signal, metadataRecovery } = {}) {
    if (!['clean', 'finish-prepared'].includes(mode)) fail('GIT_SWITCH_REVIEW_REQUIRED', 'Select a clean switch or a fresh reviewed prepared-state completion');
    active(signal); const branch = branchOf(targetBranch), source = await observeGitMutation(entry, []); active(signal);
    if(metadataRecovery)await assertMetadataRecovery(source,metadataRecovery,branch,signal);
    if (!source.headSha) fail('GIT_UNBORN_SWITCH_UNSUPPORTED', 'Create the first reviewed commit before using the clean-switch flow');
    await protocol(source, signal); await assertSourceHead(source, signal);
    const target = await targetHead(source, branch, signal), retained = await retainedPhase(entry, source, branch, target, signal);
    const paths = retained?.owner.paths ?? await changedPaths(source, target, signal), meta = await observeGitMutation(entry, paths);
    if (source.repositoryIdentity !== meta.repositoryIdentity || source.headSha !== meta.headSha || source.headRef !== meta.headRef) fail('GIT_HEAD_CHANGED', 'Repository context changed during branch review');
    const blocker = await readiness(meta, { sha: target, branch }, paths, mode, signal, retained);
    if (await targetHead(meta, branch, signal) !== target) fail('GIT_BRANCH_CHANGED', 'Target branch changed during review');
    meta.assertRepositoryUnchanged(); active(signal);
    return { workspaceId: entry.id, paths, ...binding(meta), targetBranch: branch, expectedTargetHead: target, mode, canSwitch: blocker === null, blocker,
      dirtyEntries: meta.status.entries.slice(0, 100), dirtyEntriesTruncated: meta.status.entries.length > 100, ...(retained ? {byteTransaction: retained.evidence} : {}) };
  }
  async function prepareSwitch(entry, input, signal, metadataRecovery) {
    const request = requireRequest(input); active(signal);
    const before = await observeGitMutation(entry, request.paths); assertBinding(before, request); await protocol(before, signal); await assertSourceHead(before, signal);
    if(metadataRecovery)await assertMetadataRecovery(before,metadataRecovery,request.targetBranch,signal);
    if (await targetHead(before, request.targetBranch, signal) !== request.expectedTargetHead) fail('GIT_BRANCH_CHANGED', 'The reviewed target branch moved; review its new contents before switching');
    const retained = await retainedPhase(entry, before, request.targetBranch, request.expectedTargetHead, signal);
    if (JSON.stringify(retained?.evidence) !== JSON.stringify(request.byteTransaction)) fail('WORKSPACE_RECOVERY_REQUIRED', 'The retained file phase changed since approval review');
    if (JSON.stringify(retained?.owner.paths ?? await changedPaths(before, request.expectedTargetHead, signal)) !== JSON.stringify(request.paths)) fail('GIT_SWITCH_REVIEW_REQUIRED', 'Approved paths do not equal the exact source-to-target tree delta');
    const blocker = await readiness(before, { sha: request.expectedTargetHead, branch: request.targetBranch }, request.paths, request.mode, signal, retained);
    if (blocker) { const { code, message, ...details } = blocker; fail(code, message, details); }
    assertNoLocks(before); active(signal);
    return {request, before, retained};
  }
  async function switchBranch(entry, input, actor, { signal, application } = {}) {
    let prepared;
    try { prepared = await prepareSwitch(entry, input, signal, application?.metadataRecovery); }
    catch (error) { throw noEffect(error); }
    const {request, before, retained} = prepared;
    try { application?.assertAvailable?.(); } catch (error) { throw noEffect(error); }
    if (application && retained) { retained.beginGitInvocation(application.dispatchBinding); application.retainTransaction(retained); }
    const evidence = { oldHead: before.headSha, oldRef: before.headRef, targetHead: request.expectedTargetHead, targetBranch: request.targetBranch, paths: request.paths,
      ...(application ? {repositoryIdentity: before.repositoryIdentity, recoveryIdentity: before.recoveryIdentity} : {}) };
    let phase = 'reviewed', attempted = false, anchor, indexContext, indexLock, result, outcomeError, byteTransaction = retained;
    const complete = value => {
      if (!application || !byteTransaction) { const {transition: _transition, ...settled} = byteTransaction?.settle() ?? {}; return {...value, ...settled}; }
      value = {...value, nativeReceiptSha256: byteTransaction.receiptSha256};
      byteTransaction.recordGitCompletion({schema: 1, requestSha256: byteTransaction.evidence.requestSha256,
        dispatchBinding: byteTransaction.owner.dispatchBinding, invocationBinding: application.dispatchBinding, result: value});
      const completed = {...value, byteTransaction: byteTransaction.evidence, cleanupPending: true};
      application.deferSettlement(completed, byteTransaction);
      return completed;
    };
    if (byteTransaction) evidence.byteTransaction = byteTransaction.evidence;
    try {
      if (before.headRef === request.targetBranch && before.headSha === request.expectedTargetHead) {
        byteTransaction?.assertApplied(); active(signal);
        return result = complete({ ...evidence, switched: false, reason: 'already-current', phase: 'completed', indexIdentity: before.index.identity });
      }
      if (request.mode === 'clean' && request.paths.length || retained && !await indexMatches(before, request.expectedTargetHead, signal)) {
        indexLock = acquireGitMutationIndexLock(before); indexContext = temporaryIndex();
        const changes = await prepareTargetBytes(before, request.expectedTargetHead, request.paths, indexContext, signal);
        const final = await observeGitMutation(entry, request.paths); assertBinding(final, request, before); assertNoLocks(final, indexLock); indexContext.assertOwned(); active(signal);
        if (!retained && changes.length) {
          phase = 'tree-pending'; attempted = true;
          byteTransaction = await applyWorkspaceByteTransaction(before.root, changes, {nativeExecutable, signal, beforeCommit: application?.assertAvailable,
            owner: {kind: 'git-branch-switch', workspaceId: entry.id, repositoryIdentity: before.repositoryIdentity, recoveryIdentity: before.recoveryIdentity, initialIndexIdentity: before.index.identity, ...evidence,
              ...(application ? {dispatchBinding: application.dispatchBinding} : {})}});
          evidence.byteTransaction = byteTransaction.evidence;
          application?.retainTransaction(byteTransaction);
          byteTransaction.assertApplied(); active(signal);
        }
        phase = 'index-pending';
        if (!await indexMatches(before, request.expectedTargetHead, signal, { indexFile: indexContext.indexFile })) fail('GIT_INDEX_CHANGED', 'The native prepared index does not equal the reviewed target tree');
        const filesWritten = await observeGitMutation(entry, request.paths), targetEntries = await treeEntries(before, request.expectedTargetHead, request.paths, signal);
        if (filesWritten.headSha !== before.headSha || filesWritten.headRef !== before.headRef || filesWritten.repositoryIdentity !== before.repositoryIdentity || filesWritten.index.identity !== before.index.identity) fail('GIT_HEAD_CHANGED', 'Source context or the normal index changed before target-index replacement');
        if (!await workingMatches(filesWritten, targetEntries, request.paths, signal)) fail('GIT_WORKTREE_CHANGED', 'Prepared working files differ from the reviewed target; the original normal index is retained');
        const candidate = readGitMutationIndex(indexContext.indexFile), last = await observeGitMutation(entry, request.paths);
        assertBinding(last, { paths: request.paths, ...binding(filesWritten) }, filesWritten); indexContext.assertOwned(); indexLock.assertOwned(); before.assertRepositoryUnchanged();
        if (readGitMutationIndex(indexContext.indexFile).identity !== candidate.identity) fail('GIT_INDEX_CHANGED', 'The prepared private index changed before normal-index replacement');
        byteTransaction?.assertApplied(); active(signal); application?.assertAvailable?.(); attempted = true; indexLock.replace(candidate.bytes);
      }
      phase = 'tree-written';
      const prepared = await observeGitMutation(entry, request.paths);
      if (prepared.repositoryIdentity !== before.repositoryIdentity || prepared.headSha !== before.headSha || prepared.headRef !== before.headRef) fail('GIT_HEAD_CHANGED', 'Source context changed after preparing the target tree');
      const pending = await readiness(prepared, { sha: request.expectedTargetHead, branch: request.targetBranch }, request.paths, 'finish-prepared', signal, byteTransaction); if (pending) fail(pending.code, pending.message);
      if (await targetHead(prepared, request.targetBranch, signal) !== request.expectedTargetHead) fail('GIT_BRANCH_CHANGED', 'Target branch changed after tree preparation');
      record(entry, actor ?? 'capability-broker', 'git.branch.switch.prepared', JSON.stringify({ ...evidence, phase, indexIdentity: prepared.index.identity }));
      anchor = routingAnchor(before);
      const final = await observeGitMutation(entry, request.paths); assertBinding(final, { paths: request.paths, ...binding(prepared) }, prepared); assertNoLocks(final); anchor.assertOwned(); active(signal);
      const transaction = `start\noption no-deref\nverify ${request.targetBranch} ${request.expectedTargetHead}\noption no-deref\nsymref-update HEAD ${request.targetBranch} ${before.headRef ? 'ref ' + before.headRef : 'oid ' + before.headSha}\nprepare\ncommit\n`;
      application?.assertAvailable?.(); phase = 'head-pending'; attempted = true;
      await gitRun(before.root, ['update-ref', '-m', 'CetaMesh approved branch switch', '--stdin'], { signal, input: transaction, repository: anchor.repository, referenceBackend: { format: before.refFormat, root: before.commonDir } });
      phase = 'head-written'; record(entry, actor ?? 'capability-broker', 'git.branch.switch', JSON.stringify({ ...evidence, phase }));
      const after = await observeGitMutation(entry, request.paths);
      assertGitMutationExpected(after, { paths: request.paths, ...binding(prepared), expectedHead: request.expectedTargetHead, expectedHeadRef: request.targetBranch }, prepared);
      if (after.status.entries.length || await targetHead(after, request.targetBranch, signal) !== request.expectedTargetHead || await occupied(after, request.targetBranch, signal)) fail('GIT_WORKTREE_CHANGED', 'Branch state changed while completion was being confirmed');
      if (before.headRef && await targetHead(after, before.headRef, signal) !== before.headSha) fail('GIT_HEAD_CHANGED', 'The previous source branch changed during the switch');
      byteTransaction?.assertApplied(); active(signal); phase = 'completed';
      return result = complete({ ...evidence, switched: true, phase, indexIdentity: after.index.identity });
    } catch (error) {
      if ((attempted || byteTransaction) && !(phase === 'tree-pending' && !byteTransaction && error.effectStatus === 'none')) {
        let observed; try { const meta = await observeGitMutation(entry, request.paths); observed = { head: meta.headSha, headRef: meta.headRef, indexIdentity: meta.index.identity, repositoryIdentity: meta.repositoryIdentity, hashes: hashes(meta) }; } catch (failure) { observed = { errorCode: typeof failure.code === 'string' ? failure.code : 'GIT_OBSERVATION_FAILED' }; }
        outcomeError = Object.assign(new Error('Branch switching started but completion is unconfirmed; retain the operation and inspect the actual tree and HEAD before a fresh review'), { code: 'GIT_BRANCH_SWITCH_REVIEW_REQUIRED', effectStatus: 'unknown', ...evidence, phase, observed, causeCode: typeof error.code === 'string' ? error.code : 'GIT_FAILED' });
        try { record(entry, actor ?? 'capability-broker', 'git.branch.switch.unknown', JSON.stringify({ ...evidence, phase, observed })); }
        catch { /* The returned unknown-effect error and retained transaction still block replay if the audit write fails. */ }
      } else outcomeError = noEffect(error);
      if (byteTransaction) outcomeError.byteTransaction = byteTransaction.evidence;
      if (error.cleanupResource) Object.assign(outcomeError, { cleanupPending: true, cleanupResources: [error.cleanupResource] });
      throw outcomeError;
    } finally {
      const pending = [];
      if (indexLock) try { indexLock.release(); } catch { pending.push({ kind: 'git-index-lock', id: 'index.lock', identity: indexLock.ownershipIdentity, repositoryIdentity: before.repositoryIdentity }); }
      for (const [resource, kind] of [[indexContext, 'temporary-git-index'], [anchor, 'git-head-routing-anchor']]) if (resource) try { resource.release(); } catch { pending.push({ kind, id: resource.id, identity: resource.identity, repositoryIdentity: before.repositoryIdentity }); }
      if (pending.length) {
        const current = outcomeError ?? result ?? {}, cleanupResources = [...(current.cleanupResources ?? []), ...pending];
        Object.assign(current, { cleanupPending: true, cleanupResources });
        try { record(entry, actor ?? 'capability-broker', 'git.cleanup.pending', JSON.stringify({ ...evidence, phase, resources: cleanupResources })); }
        catch { /* Cleanup ownership is already retained on the result or error; audit failure cannot clear it. */ }
      }
    }
  }
  return { reviewSwitch, switchBranch, isKnownBranchNoEffectError: error => knownNoEffect.has(error), async validateSwitch(entry, input, {signal,metadataRecovery} = {}) { await prepareSwitch(entry, input, signal,metadataRecovery); return {valid: true}; } };
}
