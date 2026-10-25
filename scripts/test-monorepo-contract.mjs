import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const mobile = JSON.parse(read('apps/mobile/package.json'));
assert.equal(mobile.name, 'CetaMeshMobile');
assert.equal(JSON.parse(read('package.json')).name, 'whalebridge');
assert.equal(mobile.type ?? 'commonjs', 'commonjs');
for (const file of fs.readdirSync(path.join(root, 'fixtures/pairing'))) {
  assert.equal(read(`fixtures/pairing/${file}`), read(`apps/mobile/src/test/fixtures/pairing/${file}`), `pairing fixture drift: ${file}`);
}
assert.equal(read('docs/protocol/UNIFIED_PAIRING_V1_1.md'), read('apps/mobile/docs/protocol/UNIFIED_PAIRING_V1_1.md'));
const desktop = YAML.parse(read('.github/workflows/ci.yml'));
const android = YAML.parse(read('.github/workflows/android-ci.yml'));
assert.equal(android.defaults.run['working-directory'], 'apps/mobile');
assert.equal(android.jobs.android.steps.find(s => s.uses?.startsWith('actions/setup-node')).with['cache-dependency-path'], 'apps/mobile/package-lock.json');
assert.ok(android.on.push.paths.includes('packages/**'));
assert.ok(android.on.push.branches.includes('**'));
assert.ok(desktop.on.push['paths-ignore'].includes('apps/mobile/**'));
assert.equal(desktop.permissions.contents, 'read');
const rustCheck = desktop.jobs.test.steps.find(s => s.run?.includes('--suite cargo:test'));
assert.equal(rustCheck?.env.WHALEBRIDGE_TEST_CARGO, '1');
for (const step of android.jobs.android.steps) {
  if (step['working-directory']) assert.equal(step['working-directory'], 'apps/mobile/android');
  if (step.uses?.startsWith('actions/upload-artifact')) {
    for (const line of step.with.path.trim().split('\n')) assert.ok(line.startsWith('apps/mobile/'));
  }
}
assert.match(read('apps/mobile/.gitignore'), /^\/artifacts\/$/m);
assert.match(read('apps/mobile/package.json'), /"test:verification"/);
console.log('PASS monorepo platform isolation, CI paths, and pairing contract parity');
