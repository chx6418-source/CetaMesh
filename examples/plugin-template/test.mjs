import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const module = { exports: {} };
const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
new vm.Script(source).runInNewContext({ module, exports: module.exports, console: { log() {}, warn() {}, error() {} } });
assert.deepEqual(await module.exports.handlers.hello({ name: 'CetaMesh' }), { greeting: 'Hello, CetaMesh!' });
assert.deepEqual(await module.exports.handlers.hello({ name: 900 }), { greeting: 'Hello, CetaMesh!' });
process.stdout.write('PASS Hello Tool fixture\n');
