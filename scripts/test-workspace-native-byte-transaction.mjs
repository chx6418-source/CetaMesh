import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {applyWorkspaceByteTransaction, recoverWorkspaceImports} from '../src/workspace/transaction.js';
const nativeExecutable = process.env.CETAMESH_TEST_WORKSPACE_NATIVE;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parent = fs.realpathSync.native(os.tmpdir()), base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cm-byte-core-'))), identity = fs.lstatSync(base, {bigint: true});
let checks = 0;
function fixture() { const dir = path.join(base, String(++checks)), root = path.join(dir, 'project'), journalDir = path.join(dir, 'journal'); fs.mkdirSync(root, {recursive: true}); return {root, journalDir, nativeExecutable}; }
function journals(options) { return fs.existsSync(options.journalDir) ? fs.readdirSync(options.journalDir) : []; }
try {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'old.txt'), 'original'); fs.writeFileSync(path.join(f.root, 'remove.txt'), 'remove');
  const target = Buffer.from([0, 255, 128, 3]);
  const applied = await applyWorkspaceByteTransaction(f.root, [
    {path: 'new/nested.txt', action: 'write', expectedHash: null, bytes: Buffer.from('new file')},
    {path: 'old.txt', action: 'write', expectedHash: sha('original'), bytes: target},
    {path: 'remove.txt', action: 'delete', expectedHash: sha('remove')}
  ], f);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'old.txt')), target); assert.equal(fs.readFileSync(path.join(f.root, 'new', 'nested.txt'), 'utf8'), 'new file'); assert.equal(fs.existsSync(path.join(f.root, 'remove.txt')), false);
  const batch = path.join(f.journalDir, applied.evidence.name), manifest = JSON.parse(fs.readFileSync(path.join(batch, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.status, 'applied'); assert.equal(fs.readFileSync(path.join(batch, '1.preimage'), 'utf8'), 'original');
  // Use actual HEAD old reader, not a handwritten imitation or new validator.
  const oldSource = execFileSync('git', ['show', '76ca679:src/workspace/transaction.js'], {encoding: 'utf8', windowsHide: true});
  const resolve = relative => pathToFileURL(path.resolve('src/workspace', relative)).href;
  const oldModule = await import('data:text/javascript;base64,' + Buffer.from(oldSource.replaceAll("'../storage/json-file.js'", JSON.stringify(resolve('../storage/json-file.js'))).replaceAll("'./boundary.js'", JSON.stringify(resolve('./boundary.js')))).toString('base64'));
  assert.throws(() => oldModule.recoverWorkspaceImports(f.root, {journalDir: f.journalDir}), {code: 'IMPORT_JOURNAL_INVALID'});
  assert.equal(fs.readFileSync(path.join(batch, '1.preimage'), 'utf8'), 'original', 'old completed cleanup never removes v2 preimages');
  applied.assertApplied(); assert.equal(applied.settle().cleanupPending, false); assert.deepEqual(journals(f), []);
  console.log('PASS actual native binary/nested/add/delete through existing owner, exact v2 evidence, old reader refusal, normal settlement');

  const large = fixture(), prefix = Array.from({length: 4}, (_, i) => String(i) + 'a'.repeat(199)).join('/');
  fs.mkdirSync(path.join(large.root, prefix), {recursive: true});
  const changes = Array.from({length: 100}, (_, i) => {
    const relative = prefix + '/' + String(i).padStart(3, '0') + 'b'.repeat(175);
    fs.writeFileSync(path.join(large.root, relative), 'before');
    return {path: relative, action: 'write', expectedHash: sha('before'), bytes: Buffer.from('after')};
  });
  const largeApplied = await applyWorkspaceByteTransaction(large.root, changes, large);
  const largeBatch = path.join(large.journalDir, largeApplied.evidence.name);
  assert.ok(fs.statSync(path.join(largeBatch, 'receipt.json')).size > 128 * 1024);
  for (const change of changes) assert.equal(fs.readFileSync(path.join(large.root, change.path), 'utf8'), 'after');
  const largeManifest = JSON.parse(fs.readFileSync(path.join(largeBatch, 'manifest.json')));
  largeManifest.status = 'unknown'; largeManifest.receiptSha256 = null;
  fs.writeFileSync(path.join(largeBatch, 'manifest.json'), JSON.stringify(largeManifest));
  const cold = await import('../src/workspace/transaction.js?large=' + crypto.randomUUID());
  const adoptedLarge = cold.inspectWorkspaceByteTransaction(large.root, large);
  adoptedLarge.assertApplied(); assert.equal(adoptedLarge.settle().cleanupPending, false); assert.deepEqual(journals(large), []);
  console.log('PASS actual 100 long-path native receipt over 128 KiB completes, cold-adopts and settles');

  const changed = fixture(); fs.writeFileSync(path.join(changed.root, 'file.txt'), 'owner edit');
  await assert.rejects(applyWorkspaceByteTransaction(changed.root, [{path: 'file.txt', action: 'write', expectedHash: sha('previous'), bytes: Buffer.from('target')}], changed), error => error.effectStatus === 'none');
  assert.equal(fs.readFileSync(path.join(changed.root, 'file.txt'), 'utf8'), 'owner edit'); assert.deepEqual(journals(changed), []);
  console.log('PASS actual exclusive-handle raw preimage refusal preserves the user bytes and leaves no pending batch');

  const cancelled = fixture(); fs.writeFileSync(path.join(cancelled.root, 'file.txt'), 'before'); const controller = new AbortController(); controller.abort();
  await assert.rejects(applyWorkspaceByteTransaction(cancelled.root, [{path: 'file.txt', action: 'write', expectedHash: sha('before'), bytes: Buffer.from('after')}], {...cancelled, signal: controller.signal}), {code: 'INVOKE_CANCELLED'});
  assert.equal(fs.readFileSync(path.join(cancelled.root, 'file.txt'), 'utf8'), 'before'); assert.deepEqual(journals(cancelled), []);
  console.log('PASS cancellation before admission has no source or journal effect');

  const unavailable = fixture(); fs.writeFileSync(path.join(unavailable.root, 'file.txt'), 'before');
  await assert.rejects(applyWorkspaceByteTransaction(unavailable.root, [{path: 'file.txt', action: 'write', expectedHash: sha('before'), bytes: Buffer.from('after')}],
    {...unavailable, nativeExecutable: path.join(unavailable.root, 'missing-native.exe')}), error => error.code === 'WORKSPACE_NATIVE_TRANSACTION_UNAVAILABLE' && error.effectStatus === 'none');
  assert.equal(fs.readFileSync(path.join(unavailable.root, 'file.txt'), 'utf8'), 'before'); assert.deepEqual(journals(unavailable), []);
  const preflight = fixture(); fs.writeFileSync(path.join(preflight.root, 'file.txt'), 'before');
  await assert.rejects(applyWorkspaceByteTransaction(preflight.root, [{path: 'file.txt', action: 'write', expectedHash: null, bytes: Buffer.from('after')}], preflight), error => error.effectStatus === 'none');
  assert.equal(fs.readFileSync(path.join(preflight.root, 'file.txt'), 'utf8'), 'before'); assert.deepEqual(journals(preflight), []);
  console.log('PASS unavailable native host and changed pre-admission identity are known refusals, not unknown execution');

  const retained = fixture(); fs.writeFileSync(path.join(retained.root, 'file.txt'), 'old');
  const owned = await applyWorkspaceByteTransaction(retained.root, [{path: 'file.txt', action: 'write', expectedHash: sha('old'), bytes: Buffer.from('target')}], retained);
  fs.writeFileSync(path.join(retained.root, 'file.txt'), 'later user edit');
  assert.throws(() => owned.assertApplied(), {code: 'WORKSPACE_CONFLICT'}); assert.equal(owned.settle().cleanupPending, true); assert.equal(journals(retained).length, 1);
  assert.equal(fs.readFileSync(path.join(retained.journalDir, owned.evidence.name, '0.preimage'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(retained.root, 'file.txt'), 'utf8'), 'later user edit');
  console.log('PASS later edits preserve both actual user bytes and original journal instead of false cleanup');

  const legacy = fixture(); fs.writeFileSync(path.join(legacy.root, 'file.txt'), 'new'); const dir = path.join(legacy.journalDir, 'batch-legacy'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, '0.preimage'), 'old'); fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({schemaVersion: 1, root: legacy.root, status: 'committing', rows: [{action: 'write', path: 'file.txt', originalHash: sha('old'), stagedHash: sha('new'), backup: '0.preimage'}]}));
  assert.deepEqual(recoverWorkspaceImports(legacy.root, {journalDir: legacy.journalDir}), ['batch-legacy']); assert.equal(fs.readFileSync(path.join(legacy.root, 'file.txt'), 'utf8'), 'old');
  console.log('PASS current owner retains existing v1 recovery; no production migration');
} finally {
  const now = fs.lstatSync(base, {bigint: true}); assert.equal(path.dirname(base), parent); assert.ok(path.basename(base).startsWith('cm-byte-core-'));
  assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === identity.dev && now.ino === identity.ino); assert.equal(fs.realpathSync.native(base), base); fs.rmSync(base, {recursive: true, force: true});
}
