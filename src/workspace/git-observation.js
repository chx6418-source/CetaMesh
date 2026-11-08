import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { gitRun, gitStatus, readFileAsync } from './tools.js';
import { resolveInside } from './boundary.js';
import { assertObservationActive } from './observation-abort.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const text = (value, cap = 4000) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, cap);
const sensitive = value => value.split('/').some(part => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part));
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0')
    || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('GIT_PATH_INVALID', 'Git observations require a normalized Workspace-relative file');
  }
  if (sensitive(value)) fail('SENSITIVE_RESOURCE', 'This resource is excluded from Git content previews');
  return value;
}
function limitOf(value, fallback, cap) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > cap) fail('GIT_PAGE_INVALID', 'Git page size is outside its bound');
  return value;
}
function decodeCursor(value, entry, kind) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('GIT_CURSOR_INVALID', 'Invalid Git cursor');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('GIT_CURSOR_INVALID', 'Invalid Git cursor'); }
  if (!cursor || cursor.v !== 1 || cursor.kind !== kind || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 1000000) fail('GIT_CURSOR_INVALID', 'Invalid Git cursor');
  if (cursor.workspaceId !== entry.id) fail('GIT_CURSOR_MISMATCH', 'Git cursor belongs to another Workspace');
  return cursor;
}
const encodeCursor = value => Buffer.from(JSON.stringify({ v: 1, ...value })).toString('base64url');
const observation = (started, outputBytes, kind) => ({ kind, elapsedMs: Math.max(0, performance.now() - started), outputBytes, measured: true });

async function metadata(entry, signal) {
  assertObservationActive(signal);
  const root = await fs.realpath(entry.root);
  const status = await gitStatus(root, { completeFiles: true, signal });
  if (!status.isRepo) fail('GIT_NOT_REPOSITORY', 'Git observation requires a registered repository root');
  if (!samePath(root, status.repoRoot)) fail('GIT_ROOT_REQUIRED', 'Git observation requires the registered repository root');
  const [common, index] = await Promise.all([
    gitRun(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { signal, timeoutMs: 10000 }),
    gitRun(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { signal, timeoutMs: 10000 })
  ]);
  assertObservationActive(signal);
  const commonDir = await fs.realpath(common.stdout.trim());
  const indexPath = path.resolve(root, index.stdout.trim());
  let indexIdentity = null;
  try {
    const before = await fs.lstat(indexPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32 * 1024 * 1024) fail('GIT_INDEX_UNAVAILABLE', 'Git index is not a bounded regular file');
    const bytes = await fs.readFile(indexPath, { signal });
    const after = await fs.lstat(indexPath);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) fail('GIT_SNAPSHOT_CHANGED', 'Git index changed during observation');
    indexIdentity = digest(bytes);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!samePath(await fs.realpath(entry.root), root)) fail('GIT_SNAPSHOT_CHANGED', 'Registered root changed during observation');
  assertObservationActive(signal);
  return { root, status, indexIdentity, repositoryId: digest(JSON.stringify([entry.id, root, commonDir])) };
}
function assertCursorSource(cursor, meta) {
  if (cursor && cursor.repositoryId !== meta.repositoryId) fail('GIT_CURSOR_MISMATCH', 'Git repository identity changed');
}
async function requireReachable(root, sha, head, signal) {
  if (!oid(sha)) fail('GIT_COMMIT_INVALID', 'A full literal commit SHA is required');
  if (!oid(head)) fail('GIT_COMMIT_INVALID', 'This repository has no current commit');
  try { await gitRun(root, ['merge-base', '--is-ancestor', sha, head], { signal, timeoutMs: 10000 }); }
  catch { assertObservationActive(signal); fail('GIT_HISTORY_CHANGED', 'The requested history is no longer reachable from this branch'); }
}

/** Internal read projections for the existing Workspace Git product. No new
 * repository registration, execution service, cache or mutation authority. */
export function createGitObservations() {
  async function status(entry, { limit, cursor: encoded, signal } = {}) {
    const started = performance.now(), count = limitOf(limit, 100, 500), cursor = decodeCursor(encoded, entry, 'status');
    const meta = await metadata(entry, signal); assertCursorSource(cursor, meta);
    const rows = meta.status.entries;
    // This identifies a status listing, not the contents of already-dirty files.
    // Mutation review hashes the selected actual files independently.
    const snapshotId = digest(JSON.stringify([meta.repositoryId, meta.status.headSha, meta.status.branch, meta.indexIdentity, rows]));
    if (cursor && cursor.snapshotId !== snapshotId) fail('GIT_SNAPSHOT_CHANGED', 'Git status listing changed; refresh before paging');
    const offset = cursor?.offset ?? 0;
    if (offset > rows.length) fail('GIT_CURSOR_INVALID', 'Git page starts past the current listing');
    let upstream = null, ahead = null, behind = null;
    try {
      const ref = await gitRun(meta.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { signal, timeoutMs: 10000 });
      upstream = ref.stdout.trim();
      const counts = await gitRun(meta.root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--'], { signal, timeoutMs: 10000 });
      const values = /^(\d+)\s+(\d+)\s*$/.exec(counts.stdout);
      if (!values) fail('GIT_OUTPUT_INVALID', 'Git returned invalid upstream counts');
      ahead = Number(values[1]); behind = Number(values[2]);
    } catch (error) { assertObservationActive(signal); if (error.code === 'GIT_OUTPUT_INVALID') throw error; }
    const entries = await Promise.all(rows.slice(offset, offset + count).map(async row => {
      const conflict = ['DD','AU','UD','UA','DU','AA','UU'].includes(row.x + row.y);
      const result = { ...row, conflict, commitEligible: false };
      if (conflict) return { ...result, blockedReason: 'GIT_CONFLICT' };
      if (sensitive(row.path)) return { ...result, blockedReason: 'SENSITIVE_RESOURCE' };
      try {
        const target = resolveInside(meta.root, relativeFile(row.path), { forWrite: true }).absolute;
        let stat;
        try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return { ...result, commitEligible: true }; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) return { ...result, blockedReason: 'REGULAR_FILE_REQUIRED' };
        return stat.size > 10 * 1024 * 1024 ? { ...result, blockedReason: 'HASH_LIMIT' } : { ...result, commitEligible: true };
      } catch { return { ...result, blockedReason: 'PATH_UNAVAILABLE' }; }
    }));
    assertObservationActive(signal);
    return { workspaceId: entry.id, repositoryId: meta.repositoryId, headSha: meta.status.headSha, branch: meta.status.branch,
      conflictCount: rows.filter(row => ['DD','AU','UD','UA','DU','AA','UU'].includes(row.x + row.y)).length,
      indexIdentity: meta.indexIdentity, snapshotId, upstream, ahead, behind, entries, totalKnown: rows.length,
      nextCursor: offset + entries.length < rows.length ? encodeCursor({ kind: 'status', workspaceId: entry.id, repositoryId: meta.repositoryId, snapshotId, offset: offset + entries.length }) : null,
      truncated: offset + entries.length < rows.length, observation: observation(started, Buffer.byteLength(JSON.stringify(rows)), 'status-list') };
  }
  async function history(entry, { limit, cursor: encoded, signal } = {}) {
    const started = performance.now(), count = limitOf(limit, 50, 200), cursor = decodeCursor(encoded, entry, 'history');
    const meta = await metadata(entry, signal); assertCursorSource(cursor, meta);
    const anchorHead = cursor?.anchorHead ?? meta.status.headSha, offset = cursor?.offset ?? 0;
    if (cursor && cursor.branch !== meta.status.branch) fail('GIT_SNAPSHOT_CHANGED', 'Git branch changed; refresh history');
    if (!anchorHead) return { workspaceId: entry.id, anchorHead: null, entries: [], nextCursor: null, truncated: false, observation: observation(started, 0, 'anchored-history') };
    await requireReachable(meta.root, anchorHead, meta.status.headSha, signal);
    const out = await gitRun(meta.root, ['log', '-z', `--max-count=${count + 1}`, `--skip=${offset}`, '--format=%H%x00%P%x00%ct%x00%s', anchorHead, '--'], { signal, timeoutMs: 10000 });
    const parts = out.stdout.split('\0'); if (parts.at(-1) === '') parts.pop();
    if (parts.length % 4) fail('GIT_OUTPUT_INVALID', 'Git returned an incomplete history record');
    const rows = [];
    for (let i = 0; i < parts.length; i += 4) {
      if (!oid(parts[i]) || parts[i + 1] && !parts[i + 1].split(' ').every(oid) || !/^-?\d+$/.test(parts[i + 2])) fail('GIT_OUTPUT_INVALID', 'Git returned invalid history metadata');
      rows.push({ sha: parts[i], parents: parts[i + 1] ? parts[i + 1].split(' ') : [], committedAt: Number(parts[i + 2]) * 1000, subject: text(parts[i + 3], 1000) });
    }
    assertObservationActive(signal);
    return { workspaceId: entry.id, anchorHead, entries: rows.slice(0, count),
      nextCursor: rows.length > count ? encodeCursor({ kind: 'history', workspaceId: entry.id, repositoryId: meta.repositoryId, branch: meta.status.branch, anchorHead, offset: offset + count }) : null,
      truncated: rows.length > count, observation: observation(started, Buffer.byteLength(out.stdout), 'anchored-history') };
  }
  async function commitDetail(entry, { sha, signal, maxPatchBytes } = {}) {
    const started = performance.now(), cap = limitOf(maxPatchBytes, 128 * 1024, 512 * 1024), meta = await metadata(entry, signal);
    await requireReachable(meta.root, sha, meta.status.headSha, signal);
    const [header, files, patch] = await Promise.all([
      gitRun(meta.root, ['show', '-s', '--format=%H%x00%P%x00%ct%x00%s%x00%b', sha, '--'], { signal, timeoutMs: 10000 }),
      gitRun(meta.root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', sha, '--'], { signal, timeoutMs: 10000 }),
      gitRun(meta.root, ['show', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', sha, '--', '.',
        ...['**/.env', '**/.env.*', '**/.git/**', '**/.ssh/**', '**/.aws/**', '**/credentials*', '**/secret*', '**/id_rsa', '**/id_ed25519'].map(pattern => `:(exclude,icase,glob)${pattern}`)], { signal, timeoutMs: 10000 })
    ]);
    const fields = header.stdout.split('\0');
    if (fields.length !== 5 || fields[0] !== sha || fields[1] && !fields[1].split(' ').every(oid)) fail('GIT_OUTPUT_INVALID', 'Invalid commit detail');
    const names = files.stdout.split('\0'); if (names.at(-1) === '') names.pop();
    if (names.length % 2) fail('GIT_OUTPUT_INVALID', 'Invalid commit file list');
    const rows = []; let omittedPaths = 0;
    for (let i = 0; i < names.length; i += 2) {
      if (names[i + 1].length > 1024) { omittedPaths++; continue; }
      // Preserve path identity; React/IPC escaping owns display safety. A clipped
      // or rewritten filename must never become an operation target.
      rows.push({ status: text(names[i], 4), path: names[i + 1] });
    }
    const patchBytes = Buffer.from(patch.stdout), bounded = patchBytes.subarray(0, cap).toString('utf8');
    assertObservationActive(signal);
    return { workspaceId: entry.id, sha, parents: fields[1] ? fields[1].split(' ') : [], committedAt: Number(fields[2]) * 1000,
      subject: text(fields[3], 1000), body: text(fields[4], 8000), files: rows.slice(0, 500), filesOmitted: omittedPaths + Math.max(0, rows.length - 500),
      patch: bounded, truncated: patchBytes.length > cap, observation: observation(started, Buffer.byteLength(header.stdout + files.stdout + patch.stdout), 'commit-detail') };
  }
  async function preview(entry, { path: relPath, maxBytes, offset = 0, signal } = {}) {
    const meta = await metadata(entry, signal), rel = relativeFile(relPath);
    const target = resolveInside(meta.root, rel, { forWrite: true }).absolute;
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('GIT_PATH_INVALID', 'Git previews require a regular file');
    const result = await readFileAsync(meta.root, rel, { maxBytes: limitOf(maxBytes, 8000, 64000), offset, signal, restricted: true });
    assertObservationActive(signal);
    return { workspaceId: entry.id, ...result };
  }
  async function reviewPaths(entry, { paths, signal } = {}) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) fail('GIT_PATHS_REQUIRED', 'Select 1-100 exact paths to review');
    const seen = new Set(), selected = paths.map(value => {
      const rel = relativeFile(value), key = process.platform === 'win32' ? rel.toLowerCase() : rel;
      if (seen.has(key)) fail('GIT_PATH_INVALID', 'Duplicate Git review path'); seen.add(key); return rel;
    });
    const meta = await metadata(entry, signal), expectedHashes = Object.create(null);
    let bytes = 0;
    for (const rel of selected) {
      const target = resolveInside(meta.root, rel, { forWrite: true }).absolute;
      let stat;
      try { stat = await fs.lstat(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; expectedHashes[rel] = null; continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024 || bytes + stat.size > 64 * 1024 * 1024) fail('GIT_REVIEW_LIMIT', 'Selected files exceed the regular-file review bound');
      let result;
      try { result = await readFileAsync(meta.root, rel, { maxBytes: 10 * 1024 * 1024, signal, restricted: true }); }
      catch (error) { assertObservationActive(signal); fail('GIT_SNAPSHOT_CHANGED', 'Selected content could not be read consistently; refresh the review'); }
      if (!result.expectedHash) fail('GIT_SNAPSHOT_CHANGED', 'Selected file changed during review');
      expectedHashes[rel] = result.expectedHash; bytes += stat.size;
    }
    const after = await metadata(entry, signal);
    if (after.repositoryId !== meta.repositoryId || after.status.headSha !== meta.status.headSha || after.indexIdentity !== meta.indexIdentity) fail('GIT_SNAPSHOT_CHANGED', 'Git changed while selected files were reviewed');
    return { workspaceId: entry.id, headSha: meta.status.headSha, indexIdentity: meta.indexIdentity, paths: selected, expectedHashes, reviewedBytes: bytes };
  }
  async function branches(entry, { limit, cursor: encoded, signal } = {}) {
    const started = performance.now(), count = limitOf(limit, 100, 500), cursor = decodeCursor(encoded, entry, 'branches');
    const meta = await metadata(entry, signal); assertCursorSource(cursor, meta);
    const out = await gitRun(meta.root, ['for-each-ref', '--sort=refname', '--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)', 'refs/heads/'], { signal, timeoutMs: 10000 });
    const snapshotId = digest(JSON.stringify([meta.repositoryId, out.stdout]));
    if (cursor && cursor.snapshotId !== snapshotId) fail('GIT_SNAPSHOT_CHANGED', 'Git branches changed; refresh before paging');
    const rows = out.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const fields = line.split('\0');
      if (fields.length !== 4 || !fields[0] || !oid(fields[1])) fail('GIT_OUTPUT_INVALID', 'Git returned invalid branch metadata');
      const relation=(entry.gitBranches??[]).find(row=>row.branch===fields[0]);
      return { name: fields[0], headSha: fields[1], current: fields[2] === '*', upstream: fields[3] || null,
        taskId:relation?.taskId??null,baselineHead:relation?.baselineHead??null };
    });
    const offset = cursor?.offset ?? 0;
    if (offset > rows.length) fail('GIT_CURSOR_INVALID', 'Git page starts past the current branches');
    const entries = rows.slice(offset, offset + count);
    assertObservationActive(signal);
    return { workspaceId: entry.id, snapshotId, entries, totalKnown: rows.length,
      nextCursor: offset + entries.length < rows.length ? encodeCursor({ kind: 'branches', workspaceId: entry.id, repositoryId: meta.repositoryId, snapshotId, offset: offset + entries.length }) : null,
      truncated: offset + entries.length < rows.length, observation: observation(started, Buffer.byteLength(out.stdout), 'branches') };
  }
  return { status, history, branches, commitDetail, preview, reviewPaths };
}
