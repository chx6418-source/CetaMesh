import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmExtensionHost } from '../src/extension/host.js';
import { validatePluginDirectory } from '../src/plugin-center/validator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'examples', 'plugin-template');

const result = validatePluginDirectory(TEMPLATE, { currentVersion: '1.0.0-rc.2' });
assert.equal(result.ok, true, JSON.stringify(result.issues));
assert.equal(result.manifest.id, 'cetamesh.plugin-template');
assert.equal(result.packageBytes <= result.maxPackageBytes, true);

const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'extension.json'), 'utf8'));
const source = fs.readFileSync(path.join(TEMPLATE, manifest.entry), 'utf8');
const host = createVmExtensionHost({ manifest: result.manifest, source, storage: null });
assert.equal(host.available(), true, JSON.stringify(host.loadError()));
const invoked = await host.invoke('hello', { name: 'CetaMesh' });
assert.deepEqual(JSON.parse(JSON.stringify(invoked.result)), { greeting: 'Hello, CetaMesh!' });

const capability = manifest.capabilities.find(item => item.id === 'hello');
assert.equal(capability.inputSchema.type, 'object');
assert.ok(!manifest.permissions.includes('shell'));
assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'plugin-development', 'README.md')));
const sectionFiles = fs.readdirSync(path.join(ROOT, 'docs', 'plugin-development'));
for (let index = 1; index <= 15; index += 1) {
  const prefix = `${String(index).padStart(2, '0')}-`;
  assert.ok(sectionFiles.some(file => file.startsWith(prefix) && file.endsWith('.md')), `missing SDK section ${index}`);
}

process.stdout.write('PASS plugin SDK template, validator, and Hello Tool\n');
