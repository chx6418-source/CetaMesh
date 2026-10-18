// A clean Windows Sandbox cannot load an installer that assumes a developer VC runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadReleaseVersion, releaseArtifactDirectory } from '../src/release/version.js';
const rootDir = path.resolve(import.meta.dirname, '..');
const release = process.env.WHALEBRIDGE_RC_DIR ?? releaseArtifactDirectory({ rootDir, ...loadReleaseVersion({ rootDir }) });
function imports(file) {
  const b = fs.readFileSync(file), pe = b.readUInt32LE(0x3c), optional = pe + 24;
  assert.equal(b.toString('ascii', pe, pe + 4), 'PE\0\0');
  const sectionOffset = optional + b.readUInt16LE(pe + 20), sections = [];
  for (let i = 0; i < b.readUInt16LE(pe + 6); i++) {
    const s = sectionOffset + i * 40;
    sections.push({ va: b.readUInt32LE(s + 12), size: Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw: b.readUInt32LE(s + 20) });
  }
  const offset = rva => {
    const s = sections.find(s => rva >= s.va && rva < s.va + s.size);
    assert(s, 'valid PE import RVA'); return s.raw + rva - s.va;
  };
  const directory = optional + (b.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const names = [];
  for (let p = offset(b.readUInt32LE(directory + 8)); b.readUInt32LE(p + 12); p += 20) {
    const start = offset(b.readUInt32LE(p + 12)); names.push(b.toString('ascii', start, b.indexOf(0, start)));
  }
  return names;
}
for (const name of ['WhaleBridge.exe', 'payload/WhaleBridgeCore.exe']) {
  const dependencies = imports(path.join(release, name));
  assert.deepEqual(dependencies.filter(dll => /^(vcruntime|msvcp|msvcr)\d.*\.dll$/i.test(dll)), [],
    `${name} must not require an unbundled developer Visual C++ redistributable`);
  console.log(`PASS clean Windows runtime dependencies: ${name}`);
}
