import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createAttachmentStore } from '../src/desktop/attachment-store.js';
import { importAttachmentArchive } from '../src/desktop/attachment-archive.js';
import { visionFixturePng } from './test-support/image-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-attachment-security-'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function upload(store, sessionId, name, bytes, mimeType = 'application/octet-stream') {
  const result = store.begin(sessionId, { name, size: bytes.length, mimeType });
  for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
    store.chunk(sessionId, { ref: result.ref, offset, data: bytes.subarray(offset, offset + 128 * 1024).toString('base64') });
  }
  return store.finish(sessionId, { ref: result.ref });
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Deliberately small, hand-constructed ZIP fixtures retain control of the
// declared size/CRC/mode, exercising the real parser and inflate stream.
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.bytes ?? 'fixture');
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const size = entry.declaredSize ?? bytes.length, crc = entry.crc ?? crc32(bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

try {
  // A junction in an ancestor must be rejected before any store-owned writes.
  const linkedState = path.join(root, 'linked-state'), outside = path.join(root, 'outside');
  fs.mkdirSync(linkedState); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(linkedState, 'desktop-chat'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createAttachmentStore({ stateDir: linkedState }), { code: 'ATTACHMENT_PATH_DENIED' });
  assert.deepEqual(fs.readdirSync(outside), [], 'rejected ancestor links leave the external directory unchanged');

  // A caller's StateDir may use an ancestor alias (for example Windows TEMP).
  // Keep that spelling different from the store's canonical metadata paths.
  const stateParent = path.join(root, 'state-parent'), stateAlias = path.join(root, 'state-alias');
  fs.mkdirSync(stateParent);
  fs.symlinkSync(stateParent, stateAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const stateDir = path.join(stateAlias, 'state'), store = createAttachmentStore({ stateDir });
  const sessionId = 'session-a';
  const sessionRoot = path.join(stateDir, 'desktop-chat', 'attachment-files', digest(sessionId));
  const file = upload(store, sessionId, 'source.ts', Buffer.from('ORIGINAL'), 'text/plain');
  assert.throws(() => store.read('session-b', { ref: file.ref }), { code: 'ATTACHMENT_NOT_FOUND' });
  fs.writeFileSync(path.join(sessionRoot, file.ref + '.bin'), 'MUTATED!');
  assert.throws(() => store.read(sessionId, { ref: file.ref }), { code: 'ATTACHMENT_STORE_CORRUPT' });
  assert.throws(() => store.modelParts(sessionId, [file.ref]), { code: 'ATTACHMENT_STORE_CORRUPT' });
  assert.equal(store.describe(sessionId, file.ref).sha256, file.sha256, 'failed reads do not rewrite accepted integrity metadata');

  // Detect changes outside the requested bytes but inside an authenticated chunk.
  const large = upload(store, sessionId, 'large.txt', Buffer.alloc(128 * 1024 + 32, 65), 'text/plain');
  const largeFile = path.join(sessionRoot, large.ref + '.bin'), fd = fs.openSync(largeFile, 'r+');
  try { fs.writeSync(fd, Buffer.from('B'), 0, 1, 90000); } finally { fs.closeSync(fd); }
  assert.throws(() => store.read(sessionId, { ref: large.ref, maxBytes: 16 }), { code: 'ATTACHMENT_STORE_CORRUPT' });
  assert.equal(Buffer.from(store.read(sessionId, { ref: large.ref, offset: 128 * 1024, maxBytes: 32 }).data, 'base64').toString(), 'A'.repeat(32),
    'an independently verified unaffected chunk remains readable');

  const png = visionFixturePng();
  const original = upload(store, sessionId, 'original.png', png, 'image/png');
  const model = upload(store, sessionId, 'model.png', png, 'image/png');
  const originalMeta = fs.realpathSync.native(path.join(sessionRoot, original.ref + '.json')), originalRename = fs.renameSync;
  const writeDenied = Object.assign(new Error('fixture second metadata write denied'), { code: 'EACCES' });
  fs.renameSync = (from, to) => {
    if (to === originalMeta) throw writeDenied;
    return originalRename(from, to);
  };
  try { assert.throws(() => store.derive(sessionId, { ref: original.ref, modelRef: model.ref }), { code: 'WRITE_FAILED', file: originalMeta, cause: writeDenied }); }
  finally { fs.renameSync = originalRename; }
  assert.equal(store.describe(sessionId, original.ref).modelRef, undefined);
  assert.equal(store.describe(sessionId, model.ref).originalRef, original.ref);
  store.derive(sessionId, { ref: original.ref, modelRef: model.ref });
  const reopened = createAttachmentStore({ stateDir });
  assert.equal(reopened.describe(sessionId, original.ref).modelRef, model.ref, 'retry repairs the partial association across persistent metadata');
  assert.equal(reopened.modelParts(sessionId, [original.ref])[0].type, 'image_url');
  const another = upload(store, sessionId, 'another.png', png, 'image/png');
  assert.throws(() => store.derive(sessionId, { ref: another.ref, modelRef: model.ref }), { code: 'INVALID_PARAMS' },
    'idempotent recovery cannot transfer a model image to another original');
  console.log('PASS attachment ancestor-link refusal, cross-session isolation, chunk integrity and interrupted derive recovery');

  const imports = path.join(stateDir, 'workspace-imports');
  const stages = () => fs.existsSync(imports) ? fs.readdirSync(imports).sort() : [];
  let counter = 0;
  const archive = entries => upload(store, sessionId, `fixture-${counter++}.zip`, zip(entries));
  const run = (file, signal) => importAttachmentArchive({ store, sessionId, ref: file.ref, stateDir, signal });
  const expectRejected = async (entries, code) => {
    const before = stages(), item = archive(entries);
    await assert.rejects(run(item), { code });
    assert.deepEqual(stages(), before, 'failed ZIP import leaves no partial owned stage');
    store.remove(sessionId, item.ref); // Also proves the import closed its source handle on Windows.
  };
  const good = archive([{ name: 'src/main.ts', bytes: 'export const value = 1;\n', method: 8 }]);
  const imported = await run(good);
  assert.equal(imported.files, 1);
  assert.equal(fs.readFileSync(path.join(imported.root, 'src', 'main.ts'), 'utf8'), 'export const value = 1;\n');
  await expectRejected([{ name: '../escape.txt' }], 'ARCHIVE_PATH_DENIED');
  await expectRejected([{ name: '/absolute.txt' }], 'ARCHIVE_PATH_DENIED');
  await expectRejected([{ name: 'C:/drive.txt' }], 'ARCHIVE_PATH_DENIED');
  await expectRejected([{ name: '.git/config' }], 'ARCHIVE_PATH_DENIED');
  await expectRejected([{ name: 'case.txt' }, { name: 'CASE.txt' }], 'ARCHIVE_PATH_DENIED');
  await expectRejected([{ name: 'link', mode: 0o120777 }], 'ARCHIVE_LIMIT');
  await expectRejected([{ name: 'bomb.txt', bytes: Buffer.alloc(1024 * 1024, 65), method: 8 }], 'ARCHIVE_LIMIT');
  await expectRejected([{ name: 'lying-size.txt', bytes: crypto.randomBytes(1024), method: 8, declaredSize: 1 }], 'ARCHIVE_LIMIT');
  await expectRejected([{ name: 'bad-crc.txt', bytes: 'crc fixture', crc: 0 }], 'ARCHIVE_INVALID');
  await expectRejected(Array.from({ length: 5001 }, (_, index) => ({ name: `entry-${index}.txt`, bytes: 'x' })), 'ARCHIVE_LIMIT');

  const cancelled = archive([{ name: 'cancelled.txt', bytes: crypto.randomBytes(256 * 1024) }]);
  const pre = new AbortController(); pre.abort();
  const beforeCancel = stages();
  await assert.rejects(run(cancelled, pre.signal), error => error.name === 'AbortError');
  assert.deepEqual(stages(), beforeCancel);
  const hashing = new AbortController();
  setImmediate(() => hashing.abort());
  await assert.rejects(run(cancelled, hashing.signal), error => error.name === 'AbortError');
  assert.deepEqual(stages(), beforeCancel, 'hash-phase cancellation leaves no owned stage');

  const extracting = new AbortController(), createWriteStream = fs.createWriteStream;
  fs.createWriteStream = (...args) => {
    const stream = createWriteStream(...args);
    stream.once('open', () => extracting.abort());
    return stream;
  };
  try { await assert.rejects(run(cancelled, extracting.signal), error => error.name === 'AbortError'); }
  finally { fs.createWriteStream = createWriteStream; }
  assert.deepEqual(stages(), beforeCancel, 'extraction-phase cancellation removes the incomplete stage and preserves prior imports');
  assert.equal(fs.readFileSync(path.join(imported.root, 'src', 'main.ts'), 'utf8'), 'export const value = 1;\n');
  store.remove(sessionId, cancelled.ref);
  console.log('PASS ZIP traversal/link/duplicate fences, count/ratio/output bounds, CRC checks and cancellation cleanup');
} finally {
  // This root is the unique mkdtemp directory above; no user workspace is removed.
  fs.rmSync(root, { recursive: true, force: true });
}
