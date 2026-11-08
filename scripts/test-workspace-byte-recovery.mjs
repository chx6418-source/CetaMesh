import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as transactions from '../src/workspace/transaction.js';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parent = fs.realpathSync.native(os.tmpdir()), base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cm-byte-recovery-'))), node = fs.lstatSync(base, {bigint: true});
let sequence = 0;
async function fixture() {
  const directory = path.join(base, String(++sequence)), root = path.join(directory, 'project'), journalDir = path.join(directory, 'journal'); fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'file.bin'), Buffer.from([0, 255, 4]));
  const options = {journalDir, nativeExecutable: process.env.CETAMESH_TEST_WORKSPACE_NATIVE, owner: {kind: 'fixture', id: 'owner-' + sequence}};
  const applied = await transactions.applyWorkspaceByteTransaction(root, [{path: 'file.bin', action: 'write', expectedHash: sha(Buffer.from([0, 255, 4])), bytes: Buffer.from([7, 128, 9])}], options);
  return {root, options, applied, batch: path.join(journalDir, applied.evidence.name)};
}
try {
  assert.equal(typeof transactions.inspectWorkspaceByteTransaction, 'function', 'Existing Workspace transaction owner must support cold receipt adoption');
  const f = await fixture(), manifestFile = path.join(f.batch, 'manifest.json'), value = JSON.parse(fs.readFileSync(manifestFile));
  value.status = 'unknown'; value.receiptSha256 = null; fs.writeFileSync(manifestFile, JSON.stringify(value));
  const cold = await import('../src/workspace/transaction.js?cold=' + crypto.randomUUID());
  const before = fs.statSync(path.join(f.root, 'file.bin'), {bigint: true});
  const observed = cold.inspectWorkspaceByteTransaction(f.root, f.options);
  assert.deepEqual(observed.owner, f.options.owner); observed.assertApplied();
  const adopted = cold.inspectWorkspaceByteTransaction(f.root, {...f.options, expectedEvidence: observed.evidence});
  assert.equal(fs.statSync(path.join(f.root, 'file.bin'), {bigint: true}).mtimeNs, before.mtimeNs, 'Cold adoption never replays source writes');
  assert.equal(adopted.settle().cleanupPending, false); assert.deepEqual(fs.readdirSync(f.options.journalDir), []);
  console.log('PASS cold native-completed/unknown checkpoint adoption is read-only and settles without replay');

  for (const fault of ['receipt', 'preimage', 'request', 'source', 'stale-evidence', 'preimage-link', 'request-link', 'manifest-link']) {
    const g = await fixture(), expected = g.applied.evidence;
    if (fault === 'receipt') fs.writeFileSync(path.join(g.batch, 'receipt.json'), '{}');
    if (fault === 'preimage') fs.writeFileSync(path.join(g.batch, '0.preimage'), 'untrusted');
    if (fault === 'request') fs.appendFileSync(path.join(g.batch, 'request.json'), ' ');
    if (fault.endsWith('-link')) fs.linkSync(path.join(g.batch, fault === 'preimage-link' ? '0.preimage' : fault.slice(0, -5) + '.json'), path.join(path.dirname(g.options.journalDir), 'foreign-artifact-link'));
    if (fault === 'source') fs.writeFileSync(path.join(g.root, 'file.bin'), 'later user edit');
    if (fault === 'stale-evidence') { const m = JSON.parse(fs.readFileSync(path.join(g.batch, 'manifest.json'))); m.owner.id = 'other'; fs.writeFileSync(path.join(g.batch, 'manifest.json'), JSON.stringify(m)); }
    const source = fs.readFileSync(path.join(g.root, 'file.bin'));
    assert.throws(() => cold.inspectWorkspaceByteTransaction(g.root, {...g.options, expectedEvidence: expected}));
    assert.deepEqual(fs.readFileSync(path.join(g.root, 'file.bin')), source); assert.ok(fs.existsSync(g.batch));
  }
  console.log('PASS corrupt receipt/preimage/request, ordinary-artifact hardlinks, later edit and stale evidence refuse without touching user bytes or backups');

  const changed = await fixture(), handle = cold.inspectWorkspaceByteTransaction(changed.root, changed.options), mfile = path.join(changed.batch, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mfile)); m.owner.id = 'replaced'; fs.writeFileSync(mfile, JSON.stringify(m));
  assert.throws(() => handle.assertApplied()); assert.equal(handle.settle().cleanupPending, true); assert.ok(fs.existsSync(path.join(changed.batch, '0.preimage')));
  console.log('PASS retained handle cannot settle another manifest generation');

  const cleanup = await fixture(), unlink = fs.unlinkSync; let injected = false;
  try {
    fs.unlinkSync = function(file, ...args) {
      if (!injected && path.dirname(file) === path.join(cleanup.options.journalDir, 'cleanup-' + cleanup.applied.evidence.name.slice(6))) { injected = true; throw Object.assign(Error('Owned cleanup interruption'), {code: 'EACCES'}); }
      return unlink.call(this, file, ...args);
    };
    assert.equal(cleanup.applied.settle().cleanupPending, true); assert.equal(injected, true);
  } finally { fs.unlinkSync = unlink; }
  fs.writeFileSync(path.join(cleanup.root, 'file.bin'), 'new work after known completion');
  assert.equal(cold.recoverWorkspaceImports(cleanup.root, {journalDir: cleanup.options.journalDir}).length, 1);
  assert.equal(fs.readFileSync(path.join(cleanup.root, 'file.bin'), 'utf8'), 'new work after known completion'); assert.deepEqual(fs.readdirSync(cleanup.options.journalDir), []);
  console.log('PASS interrupted completed cleanup resumes after restart without rolling back later user work');

  const final = await fixture(), rmdir = fs.rmdirSync;
  const retired = path.join(final.options.journalDir, 'cleanup-' + final.applied.evidence.name.slice(6));
  try {
    fs.rmdirSync = function(directory, ...args) {
      if (directory === retired) throw Object.assign(Error('Owned final directory interruption'), {code: 'EACCES'});
      return rmdir.call(this, directory, ...args);
    };
    assert.equal(final.applied.settle().cleanupPending, true);
  } finally { fs.rmdirSync = rmdir; }
  assert.deepEqual(fs.readdirSync(retired), [], 'Regression reaches the final directory boundary');
  fs.writeFileSync(path.join(final.root, 'file.bin'), 'later user work survives retired cleanup');
  assert.equal(cold.workspaceImportEvidence(final.root, final.options).length, 1);
  assert.equal(cold.recoverWorkspaceImports(final.root, final.options).length, 1);
  assert.equal(fs.readFileSync(path.join(final.root, 'file.bin'), 'utf8'), 'later user work survives retired cleanup');
  assert.deepEqual(fs.readdirSync(final.options.journalDir), []);
  console.log('PASS final-rmdir interruption retains cold cleanup evidence and preserves later user work');

  async function interruptedRetirement(boundary) {
    const item = await fixture(), nonce = item.applied.evidence.name.slice(6);
    item.retired = path.join(item.options.journalDir, 'cleanup-' + nonce);
    item.proof = path.join(item.options.journalDir, 'retirement-' + nonce + '.json');
    const method = boundary === 'directory' ? 'rmdirSync' : 'unlinkSync', original = fs[method];
    try {
      fs[method] = function(file, ...args) {
        if (file === (boundary === 'directory' ? item.retired : item.proof)) throw Object.assign(Error('Owned retirement boundary interruption'), {code: 'EACCES'});
        return original.call(this, file, ...args);
      };
      assert.equal(item.applied.settle().cleanupPending, true);
    } finally { fs[method] = original; }
    return item;
  }

  const last = await interruptedRetirement('proof');
  assert.equal(fs.existsSync(last.retired), false); assert.ok(fs.existsSync(last.proof));
  assert.throws(() => cold.inspectWorkspaceByteTransaction(last.root, last.options), {code: 'WORKSPACE_RECOVERY_REQUIRED'}, 'Cleanup proof never supplies Git adoption authority');
  const pending = cold.workspaceImportEvidence(last.root, last.options);
  assert.equal(pending.length, 1);
  const recoveredEvents = [];
  assert.equal(cold.recoverWorkspaceImports(last.root, {...last.options, expectedBatches: pending, onRecovered: evidence => recoveredEvents.push(evidence)}).length, 1);
  assert.equal(recoveredEvents.length, 1); assert.deepEqual(fs.readdirSync(last.options.journalDir), []);
  console.log('PASS final retirement unlink retries with no directory, one evidence row and one settlement callback');

  for (const boundary of ['partial-write', 'empty-created', 'fsync', 'publication-failure', 'contradictory-proof', 'publication-collision']) {
    const item = await fixture(), nonce = item.applied.evidence.name.slice(6);
    const retired = path.join(item.options.journalDir, 'cleanup-' + nonce), proof = path.join(item.options.journalDir, 'retirement-' + nonce + '.json');
    const original = {openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, linkSync: fs.linkSync};
    let proofFd, injected = false;
    const interrupt = () => { injected = true; throw Object.assign(Error('Owned retirement publication interruption'), {code: 'ENOSPC'}); };
    try {
      fs.openSync = function(file, ...args) {
        const fd = original.openSync.call(this, file, ...args);
        if (typeof file === 'string' && file.startsWith(item.options.journalDir + path.sep) && path.basename(file).startsWith('retirement-')) proofFd = fd;
        return fd;
      };
      fs.writeFileSync = function(file, bytes, ...args) {
        if (file === proofFd && ['partial-write', 'empty-created'].includes(boundary)) {
          if (boundary === 'partial-write') original.writeFileSync.call(this, file, '{');
          interrupt();
        }
        return original.writeFileSync.call(this, file, bytes, ...args);
      };
      fs.fsyncSync = function(fd) {
        if (fd === proofFd && boundary === 'fsync') interrupt();
        const result = original.fsyncSync.call(this, fd);
        if (fd === proofFd && boundary === 'contradictory-proof') { original.writeFileSync.call(this, proof, '{}'); injected = true; }
        return result;
      };
      for (const method of ['renameSync', 'linkSync']) fs[method] = function(from, to) {
        if (to === proof && boundary === 'publication-failure') interrupt();
        if (to === proof && boundary === 'publication-collision') { original.writeFileSync.call(this, proof, '{}', {flag: 'wx'}); injected = true; }
        return original[method].call(this, from, to);
      };
      assert.equal(item.applied.settle().cleanupPending, true);
    } finally { Object.assign(fs, original); }
    assert.equal(injected, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(retired, 'manifest.json'))).status, 'completed');
    assert.deepEqual(fs.readFileSync(path.join(retired, '0.preimage')), Buffer.from([0, 255, 4]));
    assert.deepEqual(fs.readFileSync(path.join(item.root, 'file.bin')), Buffer.from([7, 128, 9]));
    const restarted = await import('../src/workspace/transaction.js?publication=' + crypto.randomUUID());
    if (['contradictory-proof', 'publication-collision'].includes(boundary)) {
      assert.equal(fs.readFileSync(proof, 'utf8'), '{}', 'Publication cannot overwrite contradictory existing proof');
      assert.throws(() => restarted.workspaceImportEvidence(item.root, item.options));
      assert.throws(() => restarted.recoverWorkspaceImports(item.root, item.options));
      assert.deepEqual(fs.readFileSync(path.join(retired, '0.preimage')), Buffer.from([0, 255, 4]));
      continue;
    }
    assert.equal(fs.existsSync(proof), false, 'Incomplete preparation cannot occupy the published proof name');
    assert.ok(fs.existsSync(path.join(retired, 'retirement-pending.json')), 'Crash-equivalent pending artifact stays under terminal manifest ownership');
    assert.equal(restarted.workspaceImportEvidence(item.root, item.options).length, 1);
    fs.writeFileSync(path.join(item.root, 'file.bin'), 'later work after publication failure');
    assert.equal(restarted.recoverWorkspaceImports(item.root, item.options).length, 1);
    assert.equal(fs.readFileSync(path.join(item.root, 'file.bin'), 'utf8'), 'later work after publication failure');
    assert.deepEqual(fs.readdirSync(item.options.journalDir), []);
  }
  console.log('PASS partial/empty/fsync/publication interruptions cold-clean without replay; actual publication collision preserves contradictory proof');

  for (const fault of ['after-link', 'pending-unlink', 'extra-link', 'wrong-peer', 'changed-directory', 'unknown-proof']) {
    const item = await fixture(), nonce = item.applied.evidence.name.slice(6);
    const retired = path.join(item.options.journalDir, 'cleanup-' + nonce), pending = path.join(retired, 'retirement-pending.json');
    const proof = path.join(item.options.journalDir, 'retirement-' + nonce + '.json');
    const link = fs.linkSync, unlink = fs.unlinkSync; let injected = false;
    try {
      fs.linkSync = function(from, to, ...args) {
        const result = link.call(this, from, to, ...args);
        if (to === proof && fault !== 'pending-unlink') { injected = true; throw Object.assign(Error('Owned interruption after real link publication'), {code: 'EACCES'}); }
        return result;
      };
      fs.unlinkSync = function(file, ...args) {
        if (file === pending && fault === 'pending-unlink') { injected = true; throw Object.assign(Error('Owned pending unlink failure'), {code: 'EACCES'}); }
        return unlink.call(this, file, ...args);
      };
      assert.equal(item.applied.settle().cleanupPending, true);
    } finally { fs.linkSync = link; fs.unlinkSync = unlink; }
    assert.equal(injected, true);
    const proofStat = fs.lstatSync(proof, {bigint: true}), pendingStat = fs.lstatSync(pending, {bigint: true});
    assert.equal(proofStat.nlink, 2n); assert.equal(proofStat.ino, pendingStat.ino); assert.equal(proofStat.dev, pendingStat.dev);
    const foreign = path.join(path.dirname(item.options.journalDir), 'foreign-proof');
    if (fault === 'extra-link') fs.linkSync(proof, foreign);
    if (fault === 'wrong-peer') { fs.unlinkSync(pending); fs.writeFileSync(pending, '{}'); fs.linkSync(proof, foreign); }
    if (fault === 'changed-directory') { fs.renameSync(retired, path.join(path.dirname(item.options.journalDir), 'original-retired')); fs.mkdirSync(retired); fs.renameSync(path.join(path.dirname(item.options.journalDir), 'original-retired', 'retirement-pending.json'), pending); }
    if (fault === 'unknown-proof') { const value = JSON.parse(fs.readFileSync(proof)); value.status = 'unknown'; fs.writeFileSync(proof, JSON.stringify(value)); }
    fs.writeFileSync(path.join(item.root, 'file.bin'), 'later work after linked publication');
    const restarted = await import('../src/workspace/transaction.js?linked=' + crypto.randomUUID());
    if (['after-link', 'pending-unlink'].includes(fault)) {
      assert.equal(restarted.workspaceImportEvidence(item.root, item.options).length, 1);
      assert.equal(restarted.recoverWorkspaceImports(item.root, item.options).length, 1);
      assert.deepEqual(fs.readdirSync(item.options.journalDir), []);
    } else {
      assert.throws(() => restarted.recoverWorkspaceImports(item.root, item.options));
      assert.ok(fs.existsSync(proof)); assert.ok(fs.existsSync(pending));
      if (['extra-link', 'wrong-peer'].includes(fault)) assert.ok(fs.existsSync(foreign));
    }
    assert.equal(fs.readFileSync(path.join(item.root, 'file.bin'), 'utf8'), 'later work after linked publication');
  }
  console.log('PASS exact interrupted two-link publication cold-recovers; extra links, wrong peer, stale directory and unknown proof remain refused');

  for (const fault of ['missing', 'corrupt', 'request', 'root', 'unknown', 'directory-node', 'manifest-mismatch', 'foreign-artifact']) {
    const item = await interruptedRetirement('directory');
    const saved = fs.readFileSync(item.proof);
    if (fault === 'missing') fs.unlinkSync(item.proof);
    if (fault === 'corrupt') fs.writeFileSync(item.proof, '{}');
    if (['request', 'root', 'unknown'].includes(fault)) {
      const proof = JSON.parse(saved);
      if (fault === 'request') proof.requestSha256 = '0'.repeat(64);
      if (fault === 'root') proof.root = base;
      if (fault === 'unknown') proof.status = 'unknown';
      fs.writeFileSync(item.proof, JSON.stringify(proof));
    }
    if (fault === 'directory-node') { fs.renameSync(item.retired, path.join(path.dirname(item.options.journalDir), 'original-retired')); fs.mkdirSync(item.retired); }
    if (fault === 'manifest-mismatch') { const replaced = JSON.parse(saved); replaced.receiptSha256 = '0'.repeat(64); fs.writeFileSync(path.join(item.retired, 'manifest.json'), JSON.stringify(replaced)); }
    if (fault === 'foreign-artifact') fs.writeFileSync(path.join(item.retired, 'unowned.txt'), 'preserve');
    fs.writeFileSync(path.join(item.root, 'file.bin'), 'user edit after completed effect');
    assert.throws(() => cold.recoverWorkspaceImports(item.root, item.options));
    assert.equal(fs.readFileSync(path.join(item.root, 'file.bin'), 'utf8'), 'user edit after completed effect');
    assert.ok(fs.existsSync(item.retired));
    if (fault !== 'missing') assert.ok(fs.existsSync(item.proof));
    if (fault === 'foreign-artifact') assert.equal(fs.readFileSync(path.join(item.retired, 'unowned.txt'), 'utf8'), 'preserve');
  }
  console.log('PASS missing/corrupt/request/root/unknown/stale-node/manifest-mismatch/foreign-artifact retirement proof refuses and preserves data');

  const noEffectDir = path.join(base, String(++sequence)), noEffectRoot = path.join(noEffectDir, 'project'), noEffectJournal = path.join(noEffectDir, 'journal');
  fs.mkdirSync(noEffectRoot, {recursive: true}); fs.writeFileSync(path.join(noEffectRoot, 'file.bin'), 'unchanged');
  try {
    fs.rmdirSync = function(directory, ...args) {
      if (path.dirname(directory) === noEffectJournal) throw Object.assign(Error('Owned no-effect cleanup interruption'), {code: 'EACCES'});
      return rmdir.call(this, directory, ...args);
    };
    await assert.rejects(transactions.applyWorkspaceByteTransaction(noEffectRoot, [{path: 'file.bin', action: 'write', expectedHash: sha('unchanged'), bytes: Buffer.from('never applied')}],
      {journalDir: noEffectJournal, nativeExecutable: process.env.CETAMESH_TEST_WORKSPACE_NATIVE, beforeCommit() { throw Object.assign(Error('Known prelaunch refusal'), {code: 'FIXTURE_REFUSED'}); }}),
    error => error.code === 'FIXTURE_REFUSED' && error.effectStatus === 'none' && error.cleanupPending === true);
  } finally { fs.rmdirSync = rmdir; }
  assert.equal(cold.recoverWorkspaceImports(noEffectRoot, {journalDir: noEffectJournal}).length, 1);
  assert.equal(fs.readFileSync(path.join(noEffectRoot, 'file.bin'), 'utf8'), 'unchanged'); assert.deepEqual(fs.readdirSync(noEffectJournal), []);
  console.log('PASS known prelaunch no-effect retirement survives final directory failure without executing writes');
} finally {
  const current = fs.lstatSync(base, {bigint: true});
  assert.equal(path.dirname(base), parent); assert.ok(path.basename(base).startsWith('cm-byte-recovery-')); assert.equal(fs.realpathSync.native(base), base);
  assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === node.dev && current.ino === node.ino); fs.rmSync(base, {recursive: true, force: true});
}
