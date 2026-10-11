import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const stagingRoot = path.join(root, 'artifacts', '.staging');
const preexisting = path.join(stagingRoot, `preexisting-${process.pid}-${crypto.randomUUID()}`);
fs.mkdirSync(preexisting, { recursive: true });
const sentinel = path.join(preexisting, 'sentinel.txt');
fs.writeFileSync(sentinel, 'pre-existing user data');

try {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-release.mjs'), '--dev', '--build-dir', preexisting], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  });
  assert.notEqual(result.status, 0, 'build must reject an existing staging directory');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'pre-existing user data', 'rejected build must preserve the existing staging directory');
} finally {
  fs.rmSync(preexisting, { recursive: true, force: true });
}

console.log('PASS release staging protection preserves pre-existing files');
