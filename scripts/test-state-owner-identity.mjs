import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireStateOwner } from '../src/app/state-owner.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-owner-identity-'));
const oldIdentity = { kind: 'windows-start-time-utc', value: '638900000000000001' };
const newIdentity = { kind: 'windows-start-time-utc', value: '638900000000000002' };
let failures = 0;
let passed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
function fixture(name, { pid = process.pid, identity = oldIdentity, metadata = true } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const file = path.join(dir, '.core-owner.lock');
  const identityFile = path.join(dir, '.core-owner.identity.json');
  const contents = `${pid}:${'a'.repeat(32)}`;
  const record = { version: 1, pid, lockHash: crypto.createHash('sha256').update(contents).digest('hex'), processIdentity: identity };
  fs.writeFileSync(file, contents);
  if (metadata) fs.writeFileSync(identityFile, JSON.stringify(record));
  return { dir, file, identityFile, contents, record };
}
function alive(identity = newIdentity) { return { state: 'alive', identity }; }
function assertBusy(run) { assert.throws(run, { code: 'STATE_DIR_BUSY' }); }
function assertUnchanged(row) { assert.equal(fs.readFileSync(row.file, 'utf8'), row.contents); }

try {
  await test('PID reused by a different process birth can recover the old bound lease', () => {
    const row = fixture('reused');
    const owner = acquireStateOwner(row.dir, { probeProcess: () => alive() });
    try {
      assert.notEqual(fs.readFileSync(row.file, 'utf8'), row.contents);
      assert.equal(JSON.parse(fs.readFileSync(row.identityFile, 'utf8')).processIdentity.value, newIdentity.value);
    } finally { owner.release(); }
    assert.equal(fs.existsSync(row.file), false);
    assert.equal(fs.existsSync(row.identityFile), false);
  });
  await test('fresh ownership preserves the legacy PID nonce format and binds persisted identity', () => {
    const dir = path.join(root, 'fresh');
    const owner = acquireStateOwner(dir, { probeProcess: () => alive() });
    try {
      const text = fs.readFileSync(owner.file, 'utf8');
      assert.match(text, new RegExp(`^${process.pid}:[a-f0-9]{32}$`));
      const record = JSON.parse(fs.readFileSync(path.join(dir, '.core-owner.identity.json'), 'utf8'));
      assert.equal(record.version, 1);
      assert.equal(record.pid, process.pid);
      assert.equal(record.lockHash, crypto.createHash('sha256').update(text).digest('hex'));
      assert.deepEqual(record.processIdentity, newIdentity);
      assert.equal(fs.existsSync(owner.file + '.reclaim'), false);
    } finally { owner.release(); owner.release(); }
  });
  await test('the same live birth identity cannot be stolen', () => {
    const row = fixture('alive');
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive(oldIdentity) }));
    assertUnchanged(row);
  });
  await test('legacy alive locks without a sidecar remain busy', () => {
    const row = fixture('legacy', { metadata: false });
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive() }));
    assertUnchanged(row);
  });
  for (const [name, mutation] of [
    ['wrong hash', record => ({ ...record, lockHash: 'b'.repeat(64) })],
    ['wrong PID', record => ({ ...record, pid: record.pid + 1 })],
    ['unknown version', record => ({ ...record, version: 2 })],
    ['unknown identity', record => ({ ...record, processIdentity: null })],
    ['malformed identity', record => ({ ...record, processIdentity: { kind: 'windows-start-time-utc', value: 'not-ticks' } })],
    ['different identity kind', record => ({ ...record, processIdentity: { kind: 'other', value: '638900000000000001' } })]
  ]) {
    await test(`alive locks with ${name} metadata remain busy`, () => {
      const row = fixture(name.replaceAll(' ', '-'));
      fs.writeFileSync(row.identityFile, JSON.stringify(mutation(row.record)));
      assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive() }));
      assertUnchanged(row);
    });
  }
  await test('malformed sidecar JSON cannot prove a live PID was reused', () => {
    const row = fixture('corrupt');
    fs.writeFileSync(row.identityFile, '{');
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive() }));
    assertUnchanged(row);
  });
  await test('oversized identity metadata stays busy after reading at most the limit plus one byte', () => {
    const row = fixture('oversized');
    fs.writeFileSync(row.identityFile, 'x'.repeat(1024 * 1024));
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    const originalReadFile = fs.readFileSync;
    const originalClose = fs.closeSync;
    const metadataFds = new Set();
    let bytesRead = 0;
    // Measure actual reads while preserving real filesystem effects. A source
    // length check after readFileSync must fail this bounded-I/O regression.
    fs.openSync = function (file, ...args) {
      const fd = originalOpen(file, ...args);
      if (file === row.identityFile) metadataFds.add(fd);
      return fd;
    };
    fs.readSync = function (fd, ...args) {
      const count = originalRead(fd, ...args);
      if (metadataFds.has(fd)) bytesRead += count;
      return count;
    };
    fs.readFileSync = function (file, ...args) {
      const data = originalReadFile(file, ...args);
      if (file === row.identityFile) bytesRead += Buffer.byteLength(data);
      return data;
    };
    fs.closeSync = function (fd) {
      try { return originalClose(fd); }
      finally { metadataFds.delete(fd); }
    };
    try {
      assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive() }));
      assert.ok(bytesRead <= 4097, `identity read consumed ${bytesRead} bytes`);
      assertUnchanged(row);
      assert.equal(fs.statSync(row.identityFile).size, 1024 * 1024);
    } finally {
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
      fs.readFileSync = originalReadFile;
      fs.closeSync = originalClose;
    }
  });
  for (const [name, probeProcess] of [
    ['unknown', () => ({ state: 'unknown' })],
    ['permission denied', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }],
    ['timeout', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }]
  ]) {
    await test(`an ${name} process observation retains the lease`, () => {
      const row = fixture(name.replaceAll(' ', '-'));
      assertBusy(() => acquireStateOwner(row.dir, { probeProcess }));
      assertUnchanged(row);
    });
  }
  await test('a confirmed dead legacy PID can still recover without identity metadata', () => {
    const row = fixture('dead', { pid: 2147483646, metadata: false });
    const owner = acquireStateOwner(row.dir, { probeProcess: pid => pid === process.pid ? alive() : { state: 'dead' } });
    owner.release();
    assert.equal(fs.existsSync(row.file), false);
  });
  await test('invalid PID zero never becomes a process-group death proof', () => {
    const row = fixture('zero', { pid: 0 });
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => ({ state: 'dead' }) }));
    assertUnchanged(row);
  });
  await test('a process identity changing to the recorded owner during recovery stays busy', () => {
    const row = fixture('recovery-live');
    let probes = 0;
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive(++probes === 1 ? newIdentity : oldIdentity) }));
    assertUnchanged(row);
    assert.equal(fs.existsSync(row.file + '.reclaim'), false);
  });
  await test('lock replacement during the second process probe is preserved', () => {
    const row = fixture('recovery-lock-race');
    const replacement = `${process.pid}:${'c'.repeat(32)}`;
    let probes = 0;
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => {
      if (++probes === 2) fs.writeFileSync(row.file, replacement);
      return alive();
    } }));
    assert.equal(fs.readFileSync(row.file, 'utf8'), replacement);
    assert.equal(fs.existsSync(row.file + '.reclaim'), false);
  });
  await test('sidecar replacement during recovery is preserved', () => {
    const row = fixture('recovery-metadata-race');
    const changed = { ...row.record, processIdentity: newIdentity };
    let probes = 0;
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => {
      if (++probes === 2) fs.writeFileSync(row.identityFile, JSON.stringify(changed));
      return alive();
    } }));
    assertUnchanged(row);
    assert.deepEqual(JSON.parse(fs.readFileSync(row.identityFile, 'utf8')), changed);
  });
  await test('an existing recovery guard prevents another recovery attempt', () => {
    const row = fixture('recovery-guard');
    fs.writeFileSync(row.file + '.reclaim', 'another recovery');
    assertBusy(() => acquireStateOwner(row.dir, { probeProcess: () => alive() }));
    assertUnchanged(row);
    assert.equal(fs.readFileSync(row.file + '.reclaim', 'utf8'), 'another recovery');
  });
  await test('an acquisition failure preserves a lock replaced in place during its own identity probe', () => {
    const dir = path.join(root, 'acquire-replaced');
    const file = path.join(dir, '.core-owner.lock');
    const replacement = `${process.pid}:${'e'.repeat(32)}`;
    assertBusy(() => acquireStateOwner(dir, { probeProcess: () => {
      fs.writeFileSync(file, replacement);
      return alive();
    } }));
    assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  });
  await test('metadata publication failure removes the startup lease but preserves the failed target', () => {
    const dir = path.join(root, 'publish-failure');
    fs.mkdirSync(dir);
    const identityFile = path.join(dir, '.core-owner.identity.json');
    fs.mkdirSync(identityFile);
    assert.throws(() => acquireStateOwner(dir, { probeProcess: () => alive() }));
    assert.equal(fs.existsSync(path.join(dir, '.core-owner.lock')), false);
    assert.equal(fs.statSync(identityFile).isDirectory(), true);
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  });
  await test('unknown self identity can own a fresh lease but cannot authorize live recovery', () => {
    const dir = path.join(root, 'unsupported');
    const owner = acquireStateOwner(dir, { probeProcess: () => ({ state: 'unknown' }) });
    try {
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.core-owner.identity.json'), 'utf8')).processIdentity, null);
      assertBusy(() => acquireStateOwner(dir, { probeProcess: () => alive() }));
    } finally { owner.release(); }
  });
  await test('release cannot remove a replacement lock or its sidecar', () => {
    const dir = path.join(root, 'release-replaced');
    const owner = acquireStateOwner(dir, { probeProcess: () => alive() });
    const replacement = `${process.pid}:${'d'.repeat(32)}`;
    const identityFile = path.join(dir, '.core-owner.identity.json');
    fs.writeFileSync(owner.file, replacement);
    fs.writeFileSync(identityFile, '{"replacement":true}');
    owner.release();
    assert.equal(fs.readFileSync(owner.file, 'utf8'), replacement);
    assert.equal(fs.readFileSync(identityFile, 'utf8'), '{"replacement":true}');
  });
  await test('release preserves foreign metadata even when releasing its own lock', () => {
    const dir = path.join(root, 'release-foreign-metadata');
    const owner = acquireStateOwner(dir, { probeProcess: () => alive() });
    const identityFile = path.join(dir, '.core-owner.identity.json');
    fs.writeFileSync(identityFile, '{"replacement":true}');
    owner.release();
    assert.equal(fs.existsSync(owner.file), false);
    assert.equal(fs.readFileSync(identityFile, 'utf8'), '{"replacement":true}');
  });
  await test('the real OS probe reports stable exact self birth and rejects unsafe PIDs', async () => {
    const { probeProcessIdentity } = await import('../src/app/process-identity.js');
    const first = probeProcessIdentity(process.pid);
    const second = probeProcessIdentity(process.pid);
    if (process.platform === 'win32' || process.platform === 'linux') {
      assert.equal(first.state, 'alive');
      assert.deepEqual(second, first);
      assert.ok(first.identity);
      if (process.platform === 'win32') {
        assert.equal(first.identity.kind, 'windows-start-time-utc');
        assert.match(first.identity.value, /^[1-9][0-9]{17,18}$/);
      }
    } else assert.equal(first.state, 'unknown');
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1;exit']) {
      assert.deepEqual(probeProcessIdentity(pid), { state: 'unknown' });
    }
  });
  await test('a real separate process cannot acquire an actively owned StateDir', () => {
    const dir = path.join(root, 'real-duplicate');
    const owner = acquireStateOwner(dir);
    try {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { acquireStateOwner } from ${JSON.stringify(new URL('../src/app/state-owner.js', import.meta.url).href)};
         try { const owner = acquireStateOwner(process.argv[1]); owner.release(); process.exit(24); }
         catch (error) { process.exit(error.code === 'STATE_DIR_BUSY' ? 23 : 25); }`, dir],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 23, child.stderr);
      assert.equal(fs.existsSync(owner.file), true);
    } finally { owner.release(); }
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`State owner identity: ${passed} PASS / ${failures} FAIL`);
if (failures) process.exitCode = 1;
